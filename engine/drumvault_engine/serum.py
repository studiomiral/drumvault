"""Serum 2 hosted in the engine (SCOPE.md §6.7): load .SerumPreset files and render MIDI.

Serum's plugin state is JUCE's "VC2!" binary XML whose <IComponent> holds, in JUCE's own
base64, an "XferJson" container: a JSON header (with an MD5 of the payload) and a
zstd-compressed CBOR patch. A .SerumPreset file is the same container around the same CBOR,
except that untouched sections say "default" and the processor's "component" entry is
missing. So a preset becomes a plugin state by filling those in, re-compressing and
re-hashing — no clicking through Serum's browser.

Pedalboard (Spotify) hosts the VST3 offline. Loading Serum takes several seconds, so one
instance lives as long as the engine and renders one request at a time.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import struct
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .midi import Note

log = logging.getLogger(__name__)

PRESET_EXT = ".SerumPreset"
_B64 = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+"
_B64_INDEX = {c: i for i, c in enumerate(_B64)}


class SerumError(RuntimeError):
    pass


# ---- containers ------------------------------------------------------------------------------

def juce_b64_decode(s: str) -> bytes:
    """JUCE MemoryBlock::fromBase64Encoding: "<size>.<6-bit chars, least significant bit first>"."""
    size_s, data = s.split(".", 1)
    size = int(size_s)
    out = bytearray(size)
    bit = 0
    for ch in data:
        v = _B64_INDEX[ch]
        for i in range(6):
            if v >> i & 1:
                byte, b = divmod(bit + i, 8)
                if byte < size:
                    out[byte] |= 1 << b
        bit += 6
    return bytes(out)


def juce_b64_encode(b: bytes) -> str:
    bits = len(b) * 8
    out = []
    for pos in range(0, bits, 6):
        v = 0
        for i in range(6):
            p = pos + i
            if p < bits and b[p >> 3] >> (p & 7) & 1:
                v |= 1 << i
        out.append(_B64[v])
    return f"{len(b)}." + "".join(out)


def read_xfer(blob: bytes) -> tuple[dict, bytes]:
    """XferJson container → (JSON header, payload = u32 size, u32 kind, zstd stream)."""
    if blob[:9] != b"XferJson\x00":
        raise SerumError("Not a Serum 2 file")
    n = struct.unpack("<Q", blob[9:17])[0]
    return json.loads(blob[17:17 + n]), blob[17 + n:]


def write_xfer(meta: dict, payload: bytes) -> bytes:
    j = json.dumps(meta, separators=(",", ":")).encode()
    return b"XferJson\x00" + struct.pack("<Q", len(j)) + j + payload


def preset_header(path: Path | str) -> dict:
    """The JSON header of a preset (name, author, tags) without decompressing the patch."""
    with open(path, "rb") as f:
        head = f.read(4096)
    n = struct.unpack("<Q", head[9:17])[0]
    if n > len(head) - 17:
        with open(path, "rb") as f:
            head = f.read(17 + n)
    return json.loads(head[17:17 + n])


def _defaults_to_empty(x):
    if isinstance(x, dict):
        return {k: ({} if (k == "plainParams" and v == "default") else _defaults_to_empty(v)) for k, v in x.items()}
    if isinstance(x, list):
        return [_defaults_to_empty(v) for v in x]
    return x


# ---- the host --------------------------------------------------------------------------------

@dataclass
class _Base:
    prefix: bytes          # "VC2!" magic
    xml: str               # the plugin state XML with Serum's own <IComponent>
    init: bytes            # the fresh instance's whole state (Serum's init patch)
    meta: dict             # the processor's XferJson header
    component: object      # the processor's "component" entry


class SerumHost:
    """One Serum 2 instance for the engine's lifetime; render() calls are serialised."""

    def __init__(self, plugin_path: str, plugin_name: str):
        self.plugin_path = plugin_path
        self.plugin_name = plugin_name
        self._plugin = None
        self._base: _Base | None = None
        self._lock = threading.Lock()

    def _load(self):
        if self._plugin is not None:
            return self._plugin
        if not Path(self.plugin_path).exists():
            raise SerumError(f"Serum 2 not found at {self.plugin_path}")
        from pedalboard import load_plugin
        log.info("loading %s", self.plugin_path)
        p = load_plugin(self.plugin_path, plugin_name=self.plugin_name)
        if not p.is_instrument:
            raise SerumError(f"{self.plugin_name} is not an instrument")
        state = p.raw_state
        xml = state[8:].rstrip(b"\0").decode("utf-8")
        m = re.search(r"<IComponent>(.*?)</IComponent>", xml, re.S)
        if not m:
            raise SerumError("Unexpected Serum state (no IComponent)")
        meta, payload = read_xfer(juce_b64_decode(m.group(1)))
        self._base = _Base(prefix=state[:4], xml=xml, init=state, meta=meta, component=self._decode(payload)["component"])
        self._plugin = p
        return p

    @staticmethod
    def _decode(payload: bytes) -> dict:
        import cbor2
        import zstandard
        size = struct.unpack("<I", payload[:4])[0]
        return cbor2.loads(zstandard.ZstdDecompressor().decompress(payload[8:], max_output_size=max(size, 1) * 4 + 1024))

    def state_for_preset(self, preset: Path | str) -> bytes:
        """Plugin state that makes Serum load this preset."""
        import cbor2
        import zstandard
        self._load()
        base = self._base
        assert base is not None
        _, payload = read_xfer(Path(preset).read_bytes())
        patch = _defaults_to_empty(self._decode(payload))
        patch["component"] = base.component
        raw = cbor2.dumps(patch)
        z = zstandard.ZstdCompressor(level=3).compress(raw)
        blob = write_xfer(dict(base.meta, hash=hashlib.md5(z).hexdigest()), struct.pack("<II", len(raw), 2) + z)
        xml = re.sub(r"<IComponent>.*?</IComponent>", lambda _m: f"<IComponent>{juce_b64_encode(blob)}</IComponent>",
                     base.xml, count=1, flags=re.S).encode()
        return base.prefix + struct.pack("<I", len(xml) + 1) + xml + b"\0"

    def render_loop(self, preset: Path | str, notes: list[Note], bpm: float, bars: int, sr: int,
                    sequencers: bool = True) -> np.ndarray:
        """`bars` of the notes as a seamless loop, (n, 2) float32.

        Two cycles are rendered and the second is kept: it starts with the tails and
        modulation of the cycle before it, exactly as when the loop repeats. Without
        `sequencers`, the preset's arpeggiator and clip player are off: it plays the notes
        as they are (they'd play their own notes on their own grid, at a tempo Serum guesses).
        """
        from mido import Message
        beat = 60.0 / bpm
        cycle = bars * 4 * beat
        n = int(round(cycle * sr))
        # Renders run on RPC threads, where Pedalboard can't reset the plugin (reset=True needs
        # the main thread). All-notes-off / all-sound-off clears what the last render left
        # ringing; anything else only reaches the first cycle, which is thrown away.
        msgs = [Message("control_change", control=c, value=0, channel=ch, time=0.0)
                for ch in range(16) for c in (123, 120)]
        for k in range(2):
            for note in notes:
                on = k * cycle + note.start * beat
                off = min(on + max(note.length, 1 / 64) * beat, 2 * cycle - 1e-4)
                msgs.append(Message("note_on", note=note.pitch, velocity=max(1, min(127, note.velocity)), time=on))
                msgs.append(Message("note_off", note=note.pitch, velocity=0, time=off))
        msgs.sort(key=lambda m: (m.time, m.type == "note_on"))  # stable: the resets stay first
        with self._lock:
            p = self._load()
            # A preset only lists what differs from Serum's defaults; the rest keeps whatever the
            # last preset set. Back to the init patch first, so a preset sounds the same every time.
            assert self._base is not None
            p.raw_state = self._base.init
            p.raw_state = self.state_for_preset(preset)
            if not sequencers:
                p.arp_enable = False
                p.clip_player_enable = False
            audio = p(msgs, duration=2 * n / sr, sample_rate=sr, num_channels=2, reset=False)
        audio = np.asarray(audio, dtype=np.float32)
        if audio.shape[0] == 2 and audio.shape[1] != 2:
            audio = audio.T
        out = audio[n:2 * n]
        if out.shape[0] < n:
            out = np.pad(out, ((0, n - out.shape[0]), (0, 0)))
        return np.ascontiguousarray(out)


_host: SerumHost | None = None
_host_lock = threading.Lock()


def host(plugin_path: str, plugin_name: str) -> SerumHost:
    global _host
    with _host_lock:
        if _host is None or _host.plugin_path != plugin_path or _host.plugin_name != plugin_name:
            _host = SerumHost(plugin_path, plugin_name)
        return _host


# The key a preset's MIDI clip is written for: a clip plays as written from it, moved with the key pressed.
CLIP_REFERENCE_NOTE = 60


def clip_chord(preset: Path | str) -> list[int] | None:
    """The first chord of a preset's clip player clip (the clip it plays), as semitones from C4
    (the key it's written for), when the clip player is on and the clip has notes; else None."""
    _, payload = read_xfer(Path(preset).read_bytes())
    d = SerumHost._decode(payload)
    obj = lambda x: x if isinstance(x, dict) else {}  # noqa: E731 - presets keep some sections as other types
    if not obj(obj(d.get("ClipPlayer0")).get("plainParams")).get("kParamEnabled"):
        return None
    clips = [k for k in d if re.fullmatch(r"MidiClip\d+", k) and isinstance(obj(obj(d[k]).get("clip")).get("notes"), list)
             and obj(obj(d[k]).get("clip"))["notes"]]
    if not clips:
        return None
    sel = f"MidiClip{int(obj(d.get('ClipPlayer')).get('kUIParamSelectedClip') or 0)}"
    notes = d[sel if sel in clips else sorted(clips, key=lambda k: int(k[8:]))[0]]["clip"]["notes"]
    first = min(n["timeStamp"] for n in notes)
    return sorted({int(n["noteNum"]) - CLIP_REFERENCE_NOTE for n in notes if abs(n["timeStamp"] - first) < 1e-6})


def list_presets(root: Path | str, folders: list[str] | None) -> list[dict]:
    """Presets under `root` (only in `folders`, relative to root, when given): path, name, folder, tags."""
    root = Path(root)
    if not root.is_dir():
        return []
    bases = [root / f for f in folders] if folders else [root]
    out = []
    for base in bases:
        for p in sorted(base.rglob(f"*{PRESET_EXT}")):
            try:
                h = preset_header(p)
            except Exception:  # noqa: BLE001 - a damaged preset is skipped, not fatal
                continue
            out.append({"path": str(p), "name": h.get("presetName") or p.stem,
                        "folder": str(p.parent.relative_to(root)), "tags": h.get("tags") or []})
    return out


def preset_folders(root: Path | str) -> list[dict]:
    """Folders under `root` that hold presets (two levels deep), with counts, for choosing a pool."""
    root = Path(root)
    if not root.is_dir():
        return []
    counts: dict[str, int] = {}
    for p in root.rglob(f"*{PRESET_EXT}"):
        parts = p.parent.relative_to(root).parts
        for depth in (1, 2):
            if len(parts) >= depth:
                key = "/".join(parts[:depth])
                counts[key] = counts.get(key, 0) + 1
    return [{"folder": k, "count": v} for k, v in sorted(counts.items(), key=lambda kv: kv[0].lower())]
