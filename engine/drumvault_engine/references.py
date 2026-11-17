"""Reference tracks (SCOPE.md §5.17): finished tracks the user drops into `<Library>/References/`,
each measured as a whole mix (mixprofile.py) and remembered in the library (`reference_tracks`).

A track's tempo and beats are found from the mix itself (tempo.py, as a zip's full mix is), its key
the same way, and its drops from where it is loud with the low end in. Nothing is cut from a
reference and nothing of it is played: only its numbers are kept. A file is measured once, and
again when it changes; a file taken out of the folder is forgotten.

`summary` is what an export is held against (preflight.py): per measure the references' median
and their range. Fewer than `reference_min_tracks` and there is none.
"""

from __future__ import annotations

import dataclasses
import json
import logging
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from . import key as keymod, mixprofile, tempo
from .config import Settings, Thresholds
from .db import LibraryDB

log = logging.getLogger(__name__)

FOLDER = "References"
EXTENSIONS = {".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg"}
# The measures a render is compared in (each a number in the profile), and its regions.
MEASURES = ("lufs", "plr_db", "lift_lu", "lift_low_db", "break_depth_lu", "width_db", "low_side_db", "seconds", "bpm")


def folder(settings: Settings) -> Path:
    return Path(settings.library_path) / FOLDER


def files(settings: Settings) -> list[Path]:
    """The audio files in the folder (any depth), by name."""
    root = folder(settings)
    if not root.is_dir():
        return []
    return sorted((p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in EXTENSIONS
                   and not any(part.startswith(".") for part in p.relative_to(root).parts)),
                  key=lambda p: str(p).lower())


def analyze_file(path: Path, settings: Settings) -> dict:
    """{"bpm", "key_label", "grid_confidence", "profile"} of one track."""
    th = settings.thresholds
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    if data.shape[0] < sr * 30:
        raise ValueError("Shorter than 30 seconds: not a track")
    mono = data.mean(axis=1)
    wide = dataclasses.replace(settings, bpm_min=th.reference_bpm_min, bpm_max=th.reference_bpm_max, integer_bpm=True)
    t = tempo.detect_tempo(mono, sr, wide, source_stem=path.name, source_category="full_mix", names_for_bpm=[path.name])
    if t.confidence <= 0:
        raise ValueError("No beat found")
    bar_one_s = t.phase_samples / t.sample_rate
    profile = mixprofile.measure(data, sr, t.bpm, bar_one_s, th)
    try:
        k = keymod.detect_key_audio(mono, sr, th, source="full_mix")
        key_label = k.label
    except Exception as e:  # the key is a label here, not a measure
        log.warning("no key for %s: %s", path.name, e)
        key_label = None
    return {"bpm": t.bpm, "key_label": key_label, "grid_confidence": round(t.confidence, 3), "profile": profile}


def _row(r) -> dict:
    return {"rel_path": r["rel_path"], "name": Path(r["rel_path"]).stem, "bpm": r["bpm"], "key_label": r["key_label"],
            "grid_confidence": r["grid_confidence"], "error": r["error"], "analyzed_at": r["analyzed_at"],
            "profile": json.loads(r["profile"]) if r["profile"] else None}


def _fresh(r, p: Path) -> bool:
    st = p.stat()
    return r is not None and r["size"] == st.st_size and abs((r["mtime"] or 0) - st.st_mtime) < 1e-3


def _current(r) -> bool:
    """Measured with today's profile (it has what the generator reads a structure from); one from
    before still counts for the pre-flight, and is measured again with the next new ones."""
    return r is None or r["profile"] is None or '"bar_kick"' in r["profile"]


def summary(profiles: list[dict], th: Thresholds) -> dict | None:
    """Per measure {"median", "min", "max", "n"} over the references that have it, and "regions"
    the same per region; None with fewer than `reference_min_tracks`."""
    profiles = [p for p in profiles if p]
    if len(profiles) < th.reference_min_tracks:
        return None

    def stat(vals: list[float]) -> dict | None:
        vals = [float(v) for v in vals if v is not None]
        if len(vals) < th.reference_min_tracks:
            return None
        return {"median": round(float(np.median(vals)), 2), "min": round(min(vals), 2), "max": round(max(vals), 2), "n": len(vals)}

    out: dict = {"tracks": len(profiles)}
    for m in MEASURES:
        out[m] = stat([p.get(m) for p in profiles])
    regions = [p["regions"] for p in profiles if p.get("regions")]
    out["regions"] = [stat([r[i] for r in regions]) for i in range(len(th.profile_region_edges_hz) - 1)] \
        if len(regions) >= th.reference_min_tracks else None
    return out


def scan(settings: Settings, analyze: bool = False, progress: Callable[[str, float], None] | None = None) -> dict:
    """The references as the library knows them: {"folder", "tracks": [...], "pending": files not
    measured yet (or measured before the profile kept what the generator reads), "summary"}.
    With `analyze`, new and changed files are measured first (a track takes some seconds) and the
    rows of files that are gone are dropped."""
    root = folder(settings)
    root.mkdir(parents=True, exist_ok=True)
    found = {str(p.relative_to(root)): p for p in files(settings)}
    with LibraryDB(settings.library_path) as db:
        rows = {r["rel_path"]: r for r in db.list_references()}
        if analyze:
            for rel in set(rows) - set(found):
                db.delete_reference(rel)
            todo = [rel for rel, p in found.items() if not _fresh(rows.get(rel), p) or not _current(rows.get(rel))]
            for i, rel in enumerate(todo):
                p = found[rel]
                if progress:
                    progress(rel, i / len(todo))
                st = p.stat()
                try:
                    a = analyze_file(p, settings)
                    db.set_reference(rel, size=st.st_size, mtime=st.st_mtime, bpm=a["bpm"], key_label=a["key_label"],
                                     grid_confidence=a["grid_confidence"], profile=json.dumps(a["profile"]))
                    log.info("reference %s: %.0f BPM, %s, %s LUFS", rel, a["bpm"], a["key_label"], a["profile"]["lufs"])
                except Exception as e:
                    log.warning("reference %s not measured: %s", rel, e)
                    db.set_reference(rel, size=st.st_size, mtime=st.st_mtime, error=f"{type(e).__name__}: {e}")
            rows = {r["rel_path"]: r for r in db.list_references()}
    tracks = [_row(rows[rel]) for rel in found if rel in rows and _fresh(rows[rel], found[rel])]
    stale = sum(1 for t in tracks if not _current(rows[t["rel_path"]]))
    return {"folder": str(root), "tracks": tracks, "pending": len(found) - len(tracks) + stale,
            "summary": summary([t["profile"] for t in tracks], settings.thresholds)}
