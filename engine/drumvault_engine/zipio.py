"""Zip extraction and audio file discovery (SCOPE.md §5.2)."""

from __future__ import annotations

import hashlib
import logging
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

log = logging.getLogger(__name__)

AUDIO_EXTS = {".wav", ".aif", ".aiff", ".flac"}
# Audio we recognise but can't use: skipped with a warning in the job log.
UNSUPPORTED_AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wma", ".alac", ".caf"}
JUNK_NAMES = {".ds_store", "thumbs.db", "desktop.ini"}


@dataclass
class Discovery:
    root: Path
    files: list[Path] = field(default_factory=list)   # absolute paths of usable audio
    warnings: list[str] = field(default_factory=list)

    def rel(self, p: Path) -> str:
        return p.relative_to(self.root).as_posix()


def sha1_file(path: Path | str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()


def is_junk(rel_path: str) -> bool:
    parts = PurePosixPath(rel_path).parts
    if any(p == "__MACOSX" for p in parts):
        return True
    return any(p.startswith(".") or p.lower() in JUNK_NAMES for p in parts)


def _safe_extract(zf: zipfile.ZipFile, dest: Path) -> list[str]:
    """Extract everything except junk; refuse paths escaping `dest`."""
    dest = dest.resolve()
    names: list[str] = []
    for info in zf.infolist():
        name = info.filename
        if info.is_dir() or is_junk(name):
            continue
        target = (dest / name).resolve()
        if not target.is_relative_to(dest):
            log.warning("Skipping unsafe zip entry %r", name)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info) as src, open(target, "wb") as out:
            while block := src.read(1 << 20):
                out.write(block)
        names.append(name)
    return names


def extract_zip(zip_path: Path | str, dest: Path | str) -> Discovery:
    """Extract `zip_path` into `dest` and discover the usable audio files.

    Zips nested inside the zip are extracted one level deep, into a folder
    named after the inner zip (``Extras.zip`` -> ``Extras.zip/``).
    """
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []
    with zipfile.ZipFile(zip_path) as zf:
        names = _safe_extract(zf, dest)

    for name in names:
        if not name.lower().endswith(".zip"):
            continue
        inner_path = dest / name
        inner_dest = dest / (name + ".d")
        try:
            with zipfile.ZipFile(inner_path) as zf:
                inner_names = _safe_extract(zf, inner_dest)
        except zipfile.BadZipFile:
            warnings.append(f"Skipped corrupt nested zip: {name}")
            inner_path.unlink(missing_ok=True)
            continue
        inner_path.unlink()
        inner_dest.rename(inner_path)  # present nested files as "Extras.zip/<file>"
        for n in inner_names:
            if n.lower().endswith(".zip"):
                warnings.append(f"Ignored zip nested more than one level deep: {name}/{n}")

    disc = discover_audio(dest)
    disc.warnings[:0] = warnings
    return disc


def discover_audio(root: Path | str) -> Discovery:
    root = Path(root)
    disc = Discovery(root=root)
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        if is_junk(rel):
            continue
        ext = p.suffix.lower()
        if ext in AUDIO_EXTS:
            disc.files.append(p)
        elif ext in UNSUPPORTED_AUDIO_EXTS:
            disc.warnings.append(f"Skipped unsupported audio format ({ext}): {rel}")
        elif ext == ".zip":
            disc.warnings.append(f"Ignored zip nested more than one level deep: {rel}")
        else:
            log.debug("Ignoring non-audio file %s", rel)
    return disc


def stem_length_warning(durations_s: dict[str, float], bpm: float, max_bars: float) -> str | None:
    """Warn if stems differ by more than `max_bars` bars (not exported from bar 1?)."""
    if len(durations_s) < 2 or bpm <= 0:
        return None
    longest, shortest = max(durations_s.values()), min(durations_s.values())
    bar_s = 60.0 / bpm * 4
    if longest - shortest > max_bars * bar_s:
        short = min(durations_s, key=durations_s.get)
        return (f"Stem lengths differ by {longest - shortest:.2f}s (> {max_bars:g} bar); "
                f"shortest is {short}. Were all stems exported from bar 1?")
    return None
