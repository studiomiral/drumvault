"""Kept originals (SCOPE.md §5.8d): the library's own lossless copy of what was imported."""

import json
import shutil
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from drumvault_engine import originals, pipeline
from drumvault_engine.config import Settings, Thresholds
from drumvault_engine.db import LibraryDB

SR = 44100


def _wav(path: Path, subtype: str, channels: int = 2, fmt: str = "WAV") -> Path:
    rng = np.random.default_rng(len(subtype))
    x = (rng.standard_normal((SR // 2, channels)) * 0.3).clip(-1, 1)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), x, SR, subtype=subtype, format=fmt)
    return path


def test_keeps_pcm_as_lossless_flac_and_the_rest_as_it_is(tmp_path):
    src = tmp_path / "src"
    files = {
        "Stems/Kick.wav": _wav(src / "Kick.wav", "PCM_24"),
        "Stems/Hat.wav": _wav(src / "Hat.wav", "PCM_16", 1),
        "Lofi.wav": _wav(src / "Lofi.wav", "PCM_U8", 1),
        "Pad.aif": _wav(src / "Pad.aif", "PCM_24", fmt="AIFF"),
        "Float.wav": _wav(src / "Float.wav", "FLOAT"),
        "Already.flac": _wav(src / "Already.flac", "PCM_16", fmt="FLAC"),
    }
    lib = tmp_path / "lib"
    assert originals.keep(lib, "S0001", files, Thresholds(originals_min_free_gb=0), workers=2) is None
    kept = originals.kept_files(lib, "S0001")
    assert set(kept) == set(files)
    for name in ("Stems/Kick.wav", "Stems/Hat.wav", "Lofi.wav", "Pad.aif"):
        assert kept[name].name.endswith(".flac") and sf.info(str(kept[name])).format == "FLAC"
    assert kept["Float.wav"].name == "Float.wav" and kept["Already.flac"].name == "Already.flac"
    for name, f in files.items():
        a, sa = sf.read(str(f), dtype="float32", always_2d=True)
        b, sb = sf.read(str(kept[name]), dtype="float32", always_2d=True)
        assert sa == sb and np.array_equal(a, b), name   # the same samples, bit for bit
    assert sum(p.stat().st_size for p in kept.values()) < sum(p.stat().st_size for p in files.values())
    assert not list(originals.kept_dir(lib, "S0001").rglob("*.part"))


def test_an_unfinished_or_damaged_copy_is_not_used(tmp_path):
    lib = tmp_path / "lib"
    files = {"Kick.wav": _wav(tmp_path / "Kick.wav", "PCM_24"), "Hat.wav": _wav(tmp_path / "Hat.wav", "PCM_24")}
    th = Thresholds(originals_min_free_gb=0)
    originals.keep(lib, "S0001", files, th)
    assert originals.is_kept(lib, "S0001")
    originals.kept_files(lib, "S0001")["Hat.wav"].unlink()
    assert originals.kept_files(lib, "S0001") is None
    originals.keep(lib, "S0001", files, th)                     # keeping again fills the gap
    assert originals.is_kept(lib, "S0001")
    (originals.kept_dir(lib, "S0001") / originals.MANIFEST).unlink()
    assert not originals.is_kept(lib, "S0001")


def test_nothing_is_kept_when_the_disk_would_get_too_full(tmp_path):
    lib = tmp_path / "lib"
    w = originals.keep(lib, "S0001", {"Kick.wav": _wav(tmp_path / "Kick.wav", "PCM_24")},
                       Thresholds(originals_min_free_gb=1e9))
    assert w and "not kept" in w
    assert not originals.is_kept(lib, "S0001") and not originals.kept_dir(lib, "S0001").exists()


def _counts(db: LibraryDB, zip_id: int) -> tuple[int, int, int]:
    rows = db.samples_for_zip(zip_id)
    return tuple(sum(r["kind"] == k for r in rows) for k in ("oneshot", "loop", "event"))


def test_a_zip_can_be_deleted_after_import(fixtures, tmp_path):
    dropped = tmp_path / "Downloads" / fixtures.zip("deep_groove").name
    dropped.parent.mkdir()
    shutil.copy(fixtures.zip("deep_groove"), dropped)
    s = Settings(library_path=str(tmp_path / "lib"))
    lib = Path(s.library_path)
    r = pipeline.process_zip(dropped, s)
    assert r.status in ("done", "needs_review")
    assert not any("not kept" in w for w in r.warnings)
    kept = originals.kept_files(lib, r.source_code)
    assert kept and all(p.is_relative_to(lib) for p in kept.values())
    with LibraryDB(lib) as db:
        before = _counts(db, r.zip_id)
        stems = {x["file_name"] for x in db.stems_for_zip(r.zip_id)}
    assert stems <= set(kept)

    dropped.unlink()                                           # deleted after the import
    again = pipeline.process_zip(None, s, zip_id=r.zip_id)    # re-process from the kept stems
    assert again.status == r.status
    with LibraryDB(lib) as db:
        assert _counts(db, r.zip_id) == before
        assert db.get_zip(r.zip_id)["original_path"] == str(dropped.resolve())  # still says where it came from
    assert pipeline.grid_preview(s, r.zip_id).duration_s > 0
    [rb] = pipeline.rebuild_loops(Settings(library_path=str(lib), library_bpm=122))
    assert rb.status in ("done", "needs_review")

    pipeline.delete_zip(s, r.zip_id)
    assert not originals.kept_dir(lib, r.source_code).exists()


def test_older_imports_are_kept_by_the_library_analysis(fixtures, tmp_path):
    dropped = tmp_path / fixtures.zip("deep_groove").name
    shutil.copy(fixtures.zip("deep_groove"), dropped)
    lib = tmp_path / "lib"
    full = Settings(library_path=str(lib), thresholds=Thresholds(originals_min_free_gb=1e9))
    r = pipeline.process_zip(dropped, full)
    assert any("not kept" in w for w in r.warnings)            # as if imported before this existed
    assert not originals.is_kept(lib, r.source_code)

    still_full = pipeline.analyze_library(full)
    assert still_full["kept"] == 0 and len(still_full["not_kept"]) == 1
    out = pipeline.analyze_library(Settings(library_path=str(lib)))
    assert out["kept"] == 1 and out["not_kept"] == []
    assert originals.is_kept(lib, r.source_code)
    assert pipeline.analyze_library(Settings(library_path=str(lib)))["kept"] == 0   # nothing left to do

    dropped.unlink()
    assert pipeline.process_zip(None, Settings(library_path=str(lib)), zip_id=r.zip_id).status == r.status


def test_a_pack_keeps_its_files_and_new_ones_join(tmp_path):
    root = tmp_path / "Kit"
    rng = np.random.default_rng(1)
    for name in ("Kick 01.wav", "Clap 01.wav"):
        x = np.zeros((SR // 2, 1))
        x[:2000, 0] = rng.standard_normal(2000) * np.linspace(0.8, 0, 2000)
        root.mkdir(exist_ok=True)
        sf.write(str(root / name), x, SR, subtype="PCM_24")
    s = Settings(library_path=str(tmp_path / "lib"))
    lib = Path(s.library_path)
    [r] = pipeline.import_samples(s, [str(root / "Kick 01.wav")])
    assert set(originals.kept_files(lib, r.source_code)) == {"Kick 01.wav"}
    [r2] = pipeline.import_samples(s, [str(root / "Clap 01.wav")])
    assert r2.zip_id == r.zip_id
    assert set(originals.kept_files(lib, r.source_code)) == {"Kick 01.wav", "Clap 01.wav"}
    with LibraryDB(lib) as db:
        before = _counts(db, r.zip_id)
    shutil.rmtree(root)
    again = pipeline.process_zip(None, s, zip_id=r.zip_id)
    assert not any("missing" in w for w in again.warnings)
    with LibraryDB(lib) as db:
        assert _counts(db, r.zip_id) == before
    manifest = json.loads((originals.kept_dir(lib, r.source_code) / originals.MANIFEST).read_text())
    assert set(manifest["files"]) == {"Kick 01.wav", "Clap 01.wav"}


@pytest.mark.parametrize("missing", [True, False])
def test_has_source(tmp_path, missing):
    lib = tmp_path / "lib"
    row = {"source_code": "S0001", "original_path": None if missing else str(_wav(tmp_path / "a.wav", "PCM_16"))}
    assert pipeline.has_source(lib, row) is (not missing)
