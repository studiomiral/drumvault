"""Serum presets that need sample files from another computer (named by a path, not embedded) are
found, so the pools can leave them out; JUCE's base64 for plugin states round-trips."""

import struct
from pathlib import Path

import cbor2
import zstandard

from drumvault_engine.serum import list_presets, missing_samples, write_xfer


def preset(path: Path, samples: list[str]) -> Path:
    """A minimal .SerumPreset (XferJson header, zstd'd CBOR patch) naming `samples`."""
    patch = {"component": {}, "Oscillator0": {"sample": samples[0] if samples else ""},
             "Sampler": {"zones": [{"file": s} for s in samples[1:]]}}
    raw = cbor2.dumps(patch)
    z = zstandard.ZstdCompressor(level=3).compress(raw)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(write_xfer({"presetName": path.stem, "tags": []}, struct.pack("<II", len(raw), 2) + z))
    return path


def test_finds_samples_from_another_computer(tmp_path: Path):
    here = tmp_path / "Samples" / "piano.wav"
    here.parent.mkdir()
    here.write_bytes(b"RIFF")
    p = preset(tmp_path / "Keys" / "Piano.SerumPreset", [
        "C:\\Users\\Simon\\Desktop\\Piano g3.wav",                  # a Windows drive
        "/Users/nobody-here/Dropbox/Pro1/sus_A0.wav",             # another Mac's home folder
        "/Analog/Basic Mini.wav",                                 # Serum's own wavetable
        str(here),                                                # on this Mac
        "// SFZ\n<region> sample=Oud Samples/x.flac\n",           # an embedded map, not a path
    ])
    assert missing_samples(p) == ["/Users/nobody-here/Dropbox/Pro1/sus_A0.wav", "C:\\Users\\Simon\\Desktop\\Piano g3.wav"]
    ok = preset(tmp_path / "Keys" / "Organ.SerumPreset", ["/Analog/Basic Shapes.wav", str(here)])
    assert missing_samples(ok) == []
    # Embedded in the preset (Serum's "embed in preset"): the path it came from doesn't matter.
    raw = cbor2.dumps({"component": {}, "Oscillator0": {"SampleOsc0": {
        "samplePath": "C:\\Users\\Simon\\Desktop\\Piano c3.wav", "embedded_audio": {"data": [[0.0, 0.1], [0.0, 0.1]], "sampleRate": 44100.0}}}})
    emb = tmp_path / "Keys" / "Embedded.SerumPreset"
    emb.write_bytes(write_xfer({"presetName": "Embedded", "tags": []}, struct.pack("<II", len(raw), 2) + zstandard.ZstdCompressor().compress(raw)))
    assert missing_samples(emb) == []
    listed = {x["name"]: x["missing"] for x in list_presets(tmp_path, ["Keys"])}
    assert listed == {"Embedded": 0, "Organ": 0, "Piano": 2}


def test_juce_base64_round_trips():
    import os
    from drumvault_engine.serum import juce_b64_decode, juce_b64_encode
    for n in (0, 1, 2, 3, 5, 6, 7, 100, 4097):
        b = os.urandom(n)
        assert juce_b64_decode(juce_b64_encode(b)) == b
    assert juce_b64_encode(b"\x01") == "1.A."  # least significant bit first: 1 → "A" (".": 0), then the rest of the byte


def test_parts_render_side_by_side_from_rpc_threads():
    """As the engine gets them: several renders at once, each on its own thread, patches taking turns."""
    import glob
    import threading

    import pytest

    from drumvault_engine import serum
    from drumvault_engine.config import Settings
    from drumvault_engine.midi import Note
    s = Settings()
    root = "/Library/Audio/Presets/Xfer Records/Serum 2 Presets/Presets/"
    presets = sorted(glob.glob(root + "Factory/Pad/*.SerumPreset"))[:2]
    if not Path(s.serum_plugin).exists() or len(presets) < 2:
        pytest.skip("Serum 2 or its factory presets are not installed")
    out: dict[int, float | str] = {}

    def go(i: int) -> None:
        try:
            y = serum.host(s.serum_plugin, s.serum_plugin_name).render_loop(presets[i % 2], [Note(0, 2, 57, 100)], 124.0, 1, 44100)
            out[i] = float(abs(y).max())
        except Exception as e:  # noqa: BLE001 - reported below
            out[i] = repr(e)

    threads = [threading.Thread(target=go, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert all(isinstance(v, float) and v > 0.01 for v in out.values()), out
