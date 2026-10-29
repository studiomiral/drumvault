"""Kept originals (SCOPE.md §5.8d): the library's own copy of every imported zip's stems and every
pack's files, so the zips and folders dropped in can be deleted afterwards.

Each zip or pack keeps its audio under ``<Library>/.drumvault/originals/<source code>/``, as FLAC
where the file is 8-, 16- or 24-bit PCM (lossless: it decodes to exactly the same samples) and
copied as it is otherwise (float or 32-bit WAVs, files that are FLAC already). ``kept.json`` maps
each stem name (its path inside the zip) to its file; it is written last, so a folder without it
is an unfinished copy and is not used.
"""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import soundfile as sf

from .config import Thresholds
from .db import library_dir

MANIFEST = "kept.json"
_FLAC_SUBTYPES = {"PCM_S8", "PCM_U8", "PCM_16", "PCM_24"}
_BLOCK_FRAMES = 1 << 18


def kept_dir(lib: Path | str, code: str) -> Path:
    return library_dir(lib) / "originals" / code


def _manifest(lib: Path | str, code: str) -> dict[str, str] | None:
    try:
        return dict(json.loads((kept_dir(lib, code) / MANIFEST).read_text())["files"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def kept_files(lib: Path | str, code: str) -> dict[str, Path] | None:
    """Stem name -> kept file, or None when nothing (or not everything) is kept."""
    files = _manifest(lib, code)
    if files is None:
        return None
    d = kept_dir(lib, code)
    out = {n: d / rel for n, rel in files.items()}
    return out if all(p.is_file() for p in out.values()) else None


def is_kept(lib: Path | str, code: str) -> bool:
    return kept_files(lib, code) is not None


def _as_flac(src: Path) -> sf._SoundFileInfo | None:
    """The file's info when it becomes FLAC (lossless PCM), else None (copied as it is)."""
    try:
        info = sf.info(str(src))
    except RuntimeError:
        return None
    return info if info.format != "FLAC" and info.subtype in _FLAC_SUBTYPES else None


def _keep_one(src: Path, dest_dir: Path, name: str) -> str:
    """One file into `dest_dir`; returns its path there (relative)."""
    info = _as_flac(src)
    flac = info is not None
    rel = f"{name}.flac" if flac else name
    dst = (dest_dir / rel).resolve()
    if not dst.is_relative_to(dest_dir.resolve()):
        raise ValueError(f"Unsafe stem name {name!r}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    part = dst.with_name(dst.name + ".part")
    if flac:
        # Read as int32: 8/16/24-bit samples sit in the top bits, so writing them back at the
        # same bit depth is exact.
        subtype = "PCM_S8" if info.subtype == "PCM_U8" else info.subtype   # FLAC has no unsigned 8-bit
        with sf.SoundFile(str(src)) as f, sf.SoundFile(str(part), "w", samplerate=f.samplerate, channels=f.channels,
                                                       subtype=subtype, format="FLAC") as out:
            for block in f.blocks(blocksize=_BLOCK_FRAMES, dtype="int32", always_2d=True):
                out.write(block)
    else:
        shutil.copyfile(src, part)
    os.replace(part, dst)
    return rel


def no_room(lib: Path | str, need: int, th: Thresholds) -> str | None:
    """Why `need` bytes can't be kept (the disk would get too full), else None."""
    at = Path(lib)
    while not at.exists() and at != at.parent:   # a new library folder: the disk it will be on
        at = at.parent
    free = shutil.disk_usage(at).free
    if free - need >= th.originals_min_free_gb * 1e9:
        return None
    return (f"Original not kept in the library: {need / 1e9:.1f} GB needed, {free / 1e9:.1f} GB free "
            f"(at least {th.originals_min_free_gb:g} GB stays free); keep the original for now")


def keep(lib: Path | str, code: str, files: dict[str, Path], th: Thresholds, workers: int = 1,
         progress: Callable[[float, str], None] | None = None) -> str | None:
    """Keep `files` (stem name -> source file) for `code`, next to what is kept already. Returns a
    warning when they could not be kept (not enough free disk), else None."""
    d = kept_dir(lib, code)
    have = _manifest(lib, code) or {}
    todo = {n: p for n, p in files.items() if n not in have or not (d / have[n]).is_file()}
    if not todo:
        return None
    need = sum(p.stat().st_size * (th.originals_flac_ratio if _as_flac(p) else 1.0) for p in todo.values())
    if full := no_room(lib, int(need), th):
        return full
    d.mkdir(parents=True, exist_ok=True)
    names = sorted(todo)
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for i, (n, rel) in enumerate(zip(names, pool.map(lambda n: _keep_one(todo[n], d, n), names))):
            have[n] = rel
            if progress:
                progress((i + 1) / len(names), n)
    part = d / (MANIFEST + ".part")
    part.write_text(json.dumps({"files": have}, indent=1))
    os.replace(part, d / MANIFEST)
    return None


def remove(lib: Path | str, code: str) -> None:
    shutil.rmtree(kept_dir(lib, code), ignore_errors=True)

