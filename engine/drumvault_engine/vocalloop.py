"""Splice vocal loops and phrases (SCOPE.md §6.11a): a vocal from the Splice folder made into a take
Generate can sing, like an ElevenLabs one (<Library>/Vocals/<id>/: vocal.wav, phrases/,
analysis.json, meta.json), so it is placed, rendered, chopped and marked used the same way.

A **loop** has a tempo (Splice's own record of it, else the name's): it is its own phrase loop, its
whole bars (1, 2, 4 or 8; of a longer loop the 8 bars on a 4-bar line it sings most in) stretched to the library tempo, as an
ElevenLabs phrase is cut. A **phrase** without a tempo is laid on the fewest bars that hold it
(1, 2, 4 or 8 at the library tempo), not stretched, silence after it. (No chops: they are out.) Its **key**: the name's, else Splice's (its root and scale; a root alone takes the
scale sung on it), else the one sung.

Splice's metadata comes from the desktop app's own database (`sounds.db`, read only): the pack, its
label, tempo, key and whether it is a loop. Its **link** on splice.com is the pack's page,
`https://splice.com/sounds/packs/<label>/<pack>/samples`: Splice keeps the pack's part but not the
label's, so the label's is tried from its name ("Toolroom" → toolroom, toolroom-records, …) against
splice.com and remembered per label (<Library>/.drumvault/splice_labels.json); none answering: no
link (it can be set on the Vocal Loops page).
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import normalize, stretch, vocal as vocalmod, zipio
from .audioutil import load, resample, write_wav
from .config import Settings
from .samples import name_key
from .splice import name_bpm

LINK = "https://splice.com/sounds/packs/{label}/{pack}/samples"
# The label's part of a pack link, tried in this order after its name as it is.
_LABEL_SUFFIXES = ("", "-records", "-samples", "-audio", "-sounds", "-music", "-recordings")
_BARS = (1, 2, 4, 8)


class VocalLoopError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# ---- Splice's own record of a file -------------------------------------------------------------

def splice_dbs(settings: Settings) -> list[Path]:
    """Splice's databases: `splice_db` when set, else every user's under the desktop app's folder."""
    if settings.splice_db:
        return [Path(settings.splice_db).expanduser()]
    root = Path.home() / "Library" / "Application Support" / "com.splice.Splice" / "users"
    return sorted(root.glob("*/*/sounds.db")) if root.is_dir() else []


def splice_info(settings: Settings, path: Path) -> dict | None:
    """What Splice knows of a file (by its path, else its name): pack, label, pack permalink,
    tempo, key, loop or one-shot, tags. None when it isn't Splice's."""
    for db in splice_dbs(settings):
        if not db.exists():
            continue
        try:
            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
            conn.row_factory = sqlite3.Row
            q = ("SELECT s.*, p.name AS pack_name, p.permalink AS pack_permalink, p.provider_name AS label "
                 "FROM samples s LEFT JOIN packs p ON p.uuid = s.pack_uuid WHERE s.{} = ? LIMIT 1")
            r = conn.execute(q.format("local_path"), (str(path),)).fetchone() or conn.execute(q.format("filename"), (path.name,)).fetchone()
            conn.close()
        except sqlite3.Error:
            continue
        if r is not None:
            key = None
            if r["audio_key"]:
                root = r["audio_key"].strip()
                root = root[:1].upper() + root[1:].replace("♯", "#").replace("♭", "b")
                key = root + ("m" if (r["chord_type"] or "") == "minor" else "" if (r["chord_type"] or "") == "major" else "?")
            return {"pack": r["pack_name"], "label": r["label"], "permalink": r["pack_permalink"],
                    "bpm": int(r["bpm"]) if r["bpm"] else None, "key": key,
                    "loop": (r["sample_type"] or "") == "loop", "tags": [t for t in (r["tags"] or "").split(",") if t]}
    return None


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def _answers(url: str, timeout: float) -> bool:
    """Whether splice.com has that page (200)."""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status == 200
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return False


def pack_link(settings: Settings, label: str | None, permalink: str | None) -> str | None:
    """The pack's page on splice.com: its label's part found once and remembered."""
    if not label or not permalink:
        return None
    cache = Path(settings.library_path) / ".drumvault" / "splice_labels.json"
    try:
        known = json.loads(cache.read_text()) if cache.exists() else {}
    except (OSError, ValueError):
        known = {}
    if known.get(label):
        return LINK.format(label=known[label], pack=permalink)
    base = _slug(label)
    for cand in dict.fromkeys(base + suf for suf in _LABEL_SUFFIXES):
        if _answers(LINK.format(label=cand, pack=permalink), settings.thresholds.splice_link_timeout_s):
            known[label] = cand
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(known, indent=2, sort_keys=True))
            return LINK.format(label=cand, pack=permalink)
    return None


# ---- a take from a file ------------------------------------------------------------------------

def _taken(lib: Path) -> dict[str, str]:
    """The Splice takes there are: their files' SHA-1 → take id."""
    out = {}
    for m in (lib / "Vocals").glob("*/meta.json"):
        try:
            meta = json.loads(m.read_text())
        except (OSError, ValueError):
            continue
        sha = (meta.get("splice") or {}).get("sha1")
        if sha:
            out[sha] = meta.get("id", m.parent.name)
    return out


def _key(name: str, info: dict | None, sung: str | None) -> tuple[str | None, str]:
    """(key, where it's from): the name's, Splice's (a bare root takes the sung scale), the sung one."""
    named = name_key(name)
    if named:
        return named[0], "name"
    k = (info or {}).get("key")
    if k:
        if k.endswith("?"):
            root = k[:-1]
            minor = bool(sung and sung.endswith("m") and vocalmod.PITCHES.index(_sharp(sung[:-1])) == vocalmod.PITCHES.index(_sharp(root)))
            return root + ("m" if minor else ""), "splice"
        return k, "splice"
    return sung, "sung" if sung else "none"


def _sharp(root: str) -> str:
    flats = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}
    return flats.get(root, root)


def import_one(settings: Settings, path: Path, taken: dict[str, str]) -> dict:
    """One file made into a Splice take. {"id", "name", "status": "imported" | "skipped", …}."""
    lib = Path(settings.library_path)
    th = settings.thresholds
    data = path.read_bytes()
    sha = hashlib.sha1(data).hexdigest()
    if sha in taken:
        return {"id": taken[sha], "name": path.name, "status": "skipped"}
    a = load(path)
    sr = settings.output_sample_rate
    x = resample(a.data if a.data.shape[1] == 2 else np.repeat(a.data[:, :1], 2, axis=1), a.sr, sr).astype(np.float32)
    seconds = x.shape[0] / sr
    if not th.vocal_loop_min_s <= seconds <= th.vocal_loop_max_s:
        raise VocalLoopError("length", f"{path.name}: {seconds:.1f} s (a vocal loop or phrase is {th.vocal_loop_min_s:g}–{th.vocal_loop_max_s:g} s)")
    if float(np.max(np.abs(x))) <= 1e-5:
        raise VocalLoopError("silent", f"{path.name}: silent")
    info = splice_info(settings, path)
    tempo = (info or {}).get("bpm") or name_bpm(path.name, th.splice_bpm_min, th.splice_bpm_max)
    looped = bool(tempo) and ((info or {}).get("loop", True) or "loop" in path.name.lower())
    tid = f"splice-{sha[:12]}"
    folder = f"Vocals/{tid}"
    d = lib / folder
    d.mkdir(parents=True, exist_ok=True)
    write_wav(d / "vocal.wav", x, sr, "pcm24")
    notes, level = vocalmod.sung_pitch(x.mean(axis=1), sr, th)
    sung = vocalmod.sung_key(notes, level)
    key, key_source = _key(path.name, info, sung)
    bpm = settings.library_bpm
    phrases = []
    # The phrase loop: the loop's whole bars at the library tempo, or the phrase on the bars that hold it.
    if looped:
        own = seconds * tempo / 240.0
        bars = max([b for b in _BARS if b <= own + 0.1] or [0])
        bar = 240.0 / tempo * sr
        # A longer one (a pack's whole hook, verse after verse): the 8 bars on a 4-bar line it sings most in.
        starts = range(0, max(1, int(own + 0.1) - bars + 1), 4) if bars else []
        energy = lambda k: float(np.mean(np.square(x[int(round(k * bar)):int(round((k + bars) * bar))])))  # noqa: E731
        first = max(starts, key=energy) if bars else 0
        seg = x[int(round(first * bar)):int(round((first + bars) * bar))] if bars else None
    else:
        need = seconds * bpm / 240.0
        bars = next((b for b in _BARS if b >= need - 0.02), 0)
        seg = x if bars else None
    if seg is not None and len(seg):
        target = int(round(bars * 240.0 / bpm * sr))
        y = stretch.stretch_by(seg, sr, target / len(seg), settings) if looped and abs(target - len(seg)) > 1 else seg
        y = y[:target] if len(y) >= target else np.pad(y, ((0, target - len(y)), (0, 0)))
        f = int(th.vocal_fade_ms * sr / 1000)
        y[:f] *= np.linspace(0, 1, f, dtype=np.float32)[:, None]
        y[-f:] *= np.linspace(1, 0, f, dtype=np.float32)[:, None]
        y, _, _ = normalize.loudness_normalize(y, sr, th.bass_lufs_target, th.bass_peak_dbfs)
        rel = f"{folder}/phrases/phrase-{bars}bars.wav"
        write_wav(lib / rel, y, sr, "pcm24")
        phrases.append({"path": rel, "bars": bars, "period_s": round(len(seg) / sr, 3),
                        "stretch": round(target / len(seg), 3) if looped else 1.0})  # (a phrase is padded, not stretched)
    analysis = {"key": key, "phrases": phrases, "chops": [], "bpm": bpm}  # (no chops: they are out)
    (d / "analysis.json").write_text(json.dumps(analysis, indent=2))
    link = pack_link(settings, (info or {}).get("label"), (info or {}).get("permalink"))
    meta = {
        "id": tid, "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source": "splice", "model": "", "format": "wav", "headers": {}, "credits": None,
        "lines": [], "bpm": tempo or bpm, "key": key, "seconds": round(seconds, 3),
        "take": f"{folder}/vocal.wav", "vocal": f"{folder}/vocal.wav", "stems": [], "durationS": round(seconds, 3),
        "keyHeard": sung, "usedIn": [], "analysis": analysis, "genre": settings.genre,
        "splice": {"file": path.name, "original": str(path), "sha1": sha, "pack": (info or {}).get("pack"),
                   "label": (info or {}).get("label"), "url": link, "bpm": tempo, "loop": looped,
                   "key_source": key_source, "tags": (info or {}).get("tags", [])},
    }
    (d / "meta.json").write_text(json.dumps(meta, indent=2))
    taken[sha] = tid
    return {"id": tid, "name": path.name, "status": "imported", "key": key, "bpm": tempo, "bars": phrases[0]["bars"] if phrases else None,
            "url": link}


def import_loops(settings: Settings, paths: list[str]) -> dict:
    """Splice vocal loops and phrases from files and folders (zips not: Splice keeps loose files)."""
    if not settings.library_path:
        raise VocalLoopError("no_library", "No library folder configured")
    lib = Path(settings.library_path)
    files: list[Path] = []
    for p in map(Path, paths):
        if p.is_dir():
            files += sorted(q for q in p.rglob("*") if q.is_file() and q.suffix.lower() in zipio.AUDIO_EXTS
                            and not zipio.is_junk(q.relative_to(p).as_posix()))
        elif p.is_file() and p.suffix.lower() in zipio.AUDIO_EXTS:
            files.append(p)
    if not files:
        raise VocalLoopError("no_audio", "No audio files (.wav, .aif, .flac) in what was added")
    taken = _taken(lib)
    imported, skipped, failed = [], 0, []
    for f in files:
        try:
            r = import_one(settings, f, taken)
        except (VocalLoopError, stretch.StretchError, OSError, RuntimeError, ValueError) as e:
            failed.append(str(e) if isinstance(e, VocalLoopError) else f"{f.name}: {e}")
            continue
        if r["status"] == "skipped":
            skipped += 1
        else:
            imported.append(r)
    return {"imported": imported, "skipped": skipped, "failed": failed}


def taken_sha1s(settings: Settings) -> set[str]:
    """For the Splice scan: the files already made into takes, by their bytes."""
    return set(_taken(Path(settings.library_path))) if settings.library_path else set()


__all__ = ["import_loops", "import_one", "pack_link", "splice_info", "splice_dbs", "taken_sha1s", "VocalLoopError"]
