"""Disco hits (SCOPE.md §6.8): one-shot stabs, brass hits and the like for Generate.

Each file dropped on the Disco Hits page is one hit: trimmed from its attack to the end of its
tail, peak-normalised and written to <Library>/Disco Hits/. Its key comes from its name ("Brass
Stab Cm", "Disco_Hit_F#_maj", a bare "…_A_…"), else from its sound. Generate moves a hit into the
track key (to the relative key across major and minor) plus its `pitch_fix`, the correction set
in Generate when the key was read wrong.
"""

from __future__ import annotations

import hashlib
import re
import tempfile
import zipfile
from pathlib import Path

import numpy as np

from . import key as keymod, naming, normalize, oneshots as osmod, zipio
from .audioutil import db_to_amp, load, resample, write_wav
from .config import Settings
from .db import LibraryDB, now_iso
from .samples import name_key

FOLDER = "Disco Hits"
# A bare note name between separators ("Brass_A_Hit"): the root, its scale from the sound.
_KEY_BARE = re.compile(r"(?:^|[\s_-])([A-G][#b]?)(?=[\s_.-]|$)")


class HitError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def find_files(paths: list[str]) -> tuple[list[tuple[str, bytes, str]], list[str]]:
    """Audio in what was dropped (files, folders, zips): [(name, bytes, original path)], warnings."""
    out: list[tuple[str, bytes, str]] = []
    warnings: list[str] = []

    def one(name: str, read, origin: str) -> None:
        ext = Path(name).suffix.lower()
        if ext in zipio.UNSUPPORTED_AUDIO_EXTS:
            warnings.append(f"Skipped unsupported audio format ({ext}): {Path(name).name}")
        elif ext in zipio.AUDIO_EXTS:
            out.append((Path(name).name, read(), origin))

    def from_zip(z: Path) -> None:
        with zipfile.ZipFile(z) as zf:
            for n in zf.namelist():
                if not n.endswith("/") and not zipio.is_junk(n):
                    one(n, lambda n=n: zf.read(n), f"{z.resolve()}!{n}")

    for p in map(Path, paths):
        if p.is_dir():
            for f in sorted(q for q in p.rglob("*") if q.is_file()):
                if zipio.is_junk(f.relative_to(p).as_posix()):
                    continue
                if f.suffix.lower() == ".zip":
                    from_zip(f)
                else:
                    one(f.name, f.read_bytes, str(f.resolve()))
        elif p.suffix.lower() == ".zip":
            from_zip(p)
        elif p.is_file():
            one(p.name, p.read_bytes, str(p.resolve()))
    return out, warnings


def trim_hit(data: np.ndarray, sr: int, settings: Settings) -> np.ndarray | None:
    """From the attack to where the tail stays below peak + hit_tail_db (at most hit_max_len_s)."""
    th = settings.thresholds
    mono = data.mean(axis=1)
    pk = float(np.max(np.abs(mono))) if mono.size else 0.0
    if pk <= 0:
        return None
    start = int(np.argmax(np.abs(mono) >= pk * db_to_amp(th.hit_tail_db)))
    end = min(start + osmod.tail_end(mono[start:], sr, th.hit_tail_db, th.hit_tail_hold_ms),
              start + int(th.hit_max_len_s * sr))
    hit = np.array(data[start:max(end, start + 1)], dtype=np.float32)
    f = min(int(th.hit_fade_out_ms * sr / 1000), len(hit))
    if f > 1:
        hit[-f:] *= np.linspace(1.0, 0.0, f, dtype=np.float32)[:, None]
    return hit


def hit_key(name: str, mono: np.ndarray, sr: int, settings: Settings) -> tuple[str | None, str | None]:
    """(key label, "name" | "detected"): the name's key, a bare note in it with the sound's scale,
    else the sound's key."""
    named = name_key(name)
    if named:
        return named[0], "name"
    m = _KEY_BARE.search(Path(name).stem)
    detected = keymod.detect_key_audio(mono, sr, settings.thresholds)
    if m:
        pc = keymod.normalize_pitch(m.group(1))
        same = detected.label and keymod.parse_label(detected.label)[0] == pc
        # A bare note on a stab is most often its major chord, unless the sound says minor on that root.
        return keymod.make_label(pc, detected.scale if same and detected.scale else "major"), "name"
    return detected.label, "detected" if detected.label else None


def import_hits(settings: Settings, paths: list[str]) -> dict:
    """Add disco hits from files, folders and zips. Files already imported are skipped."""
    if not settings.library_path:
        raise HitError("no_library", "No library folder configured")
    lib = Path(settings.library_path)
    files, warnings = find_files(paths)
    if not files:
        raise HitError("no_audio", "No audio files (.wav, .aif, .flac) in what was added")
    out_sr = settings.output_sample_rate
    imported, skipped, failed = [], 0, []
    with LibraryDB(lib) as db, tempfile.TemporaryDirectory(prefix="drumvault-hits-") as tmp:
        for i, (name, data, origin) in enumerate(files):
            sha1 = hashlib.sha1(data).hexdigest()
            if db.hit_by_sha1(sha1):
                skipped += 1
                continue
            f = Path(tmp) / f"{i}{Path(name).suffix.lower()}"
            f.write_bytes(data)
            try:
                audio = load(f)
            except Exception as e:  # noqa: BLE001 - one bad file doesn't stop the rest
                failed.append(f"{name}: {e}")
                continue
            hit = trim_hit(audio.data, audio.sr, settings)
            if hit is None:
                failed.append(f"{name}: silent")
                continue
            label, source = hit_key(name, hit.mean(axis=1), audio.sr, settings)
            y = resample(hit, audio.sr, out_sr)
            y, pk_db, _ = normalize.peak_normalize(y, settings.thresholds.hit_peak_dbfs)
            base = naming.slugify(Path(name).stem, 60) or "hit"
            rel, k = f"{FOLDER}/{base}.wav", 1
            while db.hit_path_taken(rel) or (lib / rel).exists():
                k += 1
                rel = f"{FOLDER}/{base}-{k}.wav"
            write_wav(lib / rel, y, out_sr, settings.output_format)
            hid = db.insert_hit(file_name=name, rel_path=rel, original_path=origin, file_sha1=sha1,
                                key_label=label, key_camelot=keymod.camelot(*keymod.parse_label(label)) if label else None,
                                key_source=source, pitch_fix=0, duration_s=len(y) / out_sr, sample_rate=out_sr,
                                channels=y.shape[1], peak_db=pk_db, created_at=now_iso())
            imported.append({"id": hid, "file_name": name, "key_label": label, "key_source": source})
    return {"imported": imported, "skipped": skipped, "failed": failed, "warnings": warnings}


def set_hit_meta(settings: Settings, hit_id: int, key_label: str | None = None, clear_key: bool = False,
                 pitch_fix: int | None = None) -> dict:
    """Correct a hit's key (then marked "manual") or its pitch fix (semitones on top of the move into
    the track key; up to two octaves, the hit itself plays within one either way)."""
    with LibraryDB(settings.library_path) as db:
        if db.get_hit(hit_id) is None:
            raise HitError("not_found", f"No disco hit with id {hit_id}")
        fields: dict = {}
        if clear_key:
            fields.update(key_label=None, key_camelot=None, key_source="manual")
        elif key_label:
            fields.update(key_label=key_label, key_camelot=keymod.camelot(*keymod.parse_label(key_label)), key_source="manual")
        if pitch_fix is not None:
            fields["pitch_fix"] = max(-24, min(24, int(pitch_fix)))
        db.update_hit(hit_id, **fields)
    return {"id": hit_id}


def delete_hits(settings: Settings, hit_ids: list[int]) -> dict:
    """Remove hits from the library (file and row). Projects that use one show it missing."""
    lib = Path(settings.library_path)
    with LibraryDB(lib) as db:
        rows = [r for r in (db.get_hit(i) for i in hit_ids) if r is not None]
        for r in rows:
            (lib / r["rel_path"]).unlink(missing_ok=True)
            db.delete_hit(r["id"])
    return {"deleted": len(rows)}
