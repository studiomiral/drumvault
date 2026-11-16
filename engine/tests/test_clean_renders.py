"""Cleaning up renders: what nothing uses goes, what's kept or just made stays, and samples,
projects and the rest of the library are never touched."""

import os
import time
from pathlib import Path

from drumvault_engine.config import Settings
from drumvault_engine.pipeline import clean_renders
from drumvault_engine.schemas import CleanRendersParams


def make(lib: Path, rel: str, size: int = 1000, age_s: float = 3600) -> Path:
    f = lib / rel
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(b"\0" * size)
    t = time.time() - age_s
    os.utime(f, (t, t))
    return f


def test_deletes_only_renders_nothing_uses(tmp_path: Path):
    lib = tmp_path
    used = make(lib, ".drumvault/bass/aaa-1-0-124.wav", 2000)
    old = [make(lib, ".drumvault/bass/bbb-2-0-124.wav", 3000), make(lib, ".drumvault/keys/ccc-0-128.wav"),
           make(lib, ".drumvault/stabs/ddd-0-124.wav"), make(lib, ".drumvault/drones/eee-pump-0-124.wav"),
           make(lib, ".drumvault/tempo/126/FX/Risers/x.wav")]
    fresh = make(lib, ".drumvault/drones/fff-swell-0-124.wav", age_s=30)  # a render under way / just prepared
    stretched = make(lib, ".drumvault/tempo/128/FX/Risers/y.wav")
    others = [make(lib, "Loops/Tops/top.wav"), make(lib, ".drumvault/projects/Generated 08.dvproj"),
              make(lib, ".drumvault/bass/.render-v2", 0), make(lib, ".drumvault/stabs/chords.json")]
    keep = [".drumvault/bass/aaa-1-0-124.wav", ".drumvault/tempo/128/FX/Risers/y.wav"]
    s = Settings(library_path=str(lib))

    dry = clean_renders(s, keep, dry_run=True)
    assert dry == {"files": 5, "bytes": 7000, "kept_files": 3, "kept_bytes": 4000}
    assert all(f.exists() for f in old)

    assert clean_renders(s, keep) == dry
    assert not any(f.exists() for f in old)
    assert used.exists() and fresh.exists() and stretched.exists() and all(f.exists() for f in others)
    assert not (lib / ".drumvault/tempo/126").exists()  # its empty tempo folder goes too
    assert clean_renders(s, keep)["files"] == 0


def test_the_engine_takes_the_request():
    p = CleanRendersParams.model_validate({"keep": [".drumvault/bass/a.wav"], "dry_run": True})
    assert p.dry_run and p.keep == [".drumvault/bass/a.wav"]
