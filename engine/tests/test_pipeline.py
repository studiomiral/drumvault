"""End-to-end acceptance tests on the processed fixture library (SCOPE.md §7, Phase 1)."""

import json
import re
import shutil
from collections import Counter
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from test_stretch import onset_errors_ms
from drumvault_engine import loops, pipeline
from drumvault_engine.config import Settings
from drumvault_engine.db import LibraryDB, db_path, library_dir
from drumvault_engine.schemas import Overrides

OS_RE = re.compile(r"^One-Shots/[A-Za-z-]+/OS_[A-Za-z]+_(?:[A-G][#b]?m?|NoKey)_S\d{4}-[a-z0-9-]+_\d{2}\.wav$")
LP_RE = re.compile(r"^Loops/[A-Za-z-]+/LP_[A-Za-z]+_\d+(?:\.\d+)?_(?:[A-G][#b]?m?|NoKey)_S\d{4}-[a-z0-9-]+_\d+bar_\d{2}\.wav$")
EV_RE = re.compile(r"^(?:FX/[A-Za-z]+/FX|Fills/[A-Za-z-]+/FL)_[A-Za-z]+_\d+(?:\.\d+)?_(?:[A-G][#b]?m?|NoKey)_"
                   r"S\d{4}-[a-z0-9-]+_\d+bar_\d{2}\.wav$")


@pytest.fixture(scope="module")
def db(library):
    with LibraryDB(library.path) as d:
        yield d


def _samples(db, library, name, kind=None, category=None):
    zid = library.results[name].zip_id
    rows = db.samples_for_zip(zid, kind)
    return [r for r in rows if category is None or r["category"] == category]


def _stem_of(db, row):
    return db.conn.execute("SELECT file_name FROM stems WHERE id = ?", (row["stem_id"],)).fetchone()[0]


def test_all_fixtures_processed(library, fixtures):
    for name, r in library.results.items():
        truth = fixtures.truths[name]
        assert r.status == "done", (name, r.warnings)
        assert r.analysis.tempo.bpm == truth.bpm  # whole number, exact
        assert abs(r.analysis.tempo.raw_bpm - truth.bpm) <= 0.02
        assert not r.analysis.tempo.bpm_warning
    with LibraryDB(library.path) as d:
        for name, r in library.results.items():
            assert d.get_zip(r.zip_id)["detected_bpm"] == fixtures.truths[name].bpm
        assert r.analysis.tempo.phase_samples == 0
        assert r.analysis.key.label == truth.key
        assert r.counts.oneshots > 0 and r.counts.loops > 0
        assert r.counts.events == len(truth.events)
    assert [r.source_code for r in library.results.values()] == ["S0001", "S0002", "S0003"]


def test_files_and_rows_agree(library, db):
    rows = db.all_samples()
    on_disk = {p.relative_to(library.path).as_posix() for p in library.path.rglob("*.wav")}
    assert {r["rel_path"] for r in rows} == on_disk
    for r in rows:
        assert OS_RE.match(r["rel_path"]) or LP_RE.match(r["rel_path"]) or EV_RE.match(r["rel_path"]), r["rel_path"]
        info = sf.info(str(library.path / r["rel_path"]))
        assert info.samplerate == 44100 and info.subtype == "PCM_24"
        assert info.channels == r["channels"]
        assert (library_dir(library.path) / "peaks" / f"{r['id']}.json").exists()
        assert len(r["fingerprint"]) > 0


def test_db_is_wal_and_logs_written(library):
    import sqlite3
    con = sqlite3.connect(db_path(library.path))
    assert con.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    con.close()
    for r in library.results.values():
        log = json.loads((library_dir(library.path) / "logs" / f"{r.source_code}.json").read_text())
        assert log["status"] == r.status


def test_loops_are_whole_bars_at_library_bpm(library, db):
    bar = loops.bar_length(44100, 124.0)
    for r in db.all_samples():
        if r["kind"] == "loop":
            info = sf.info(str(library.path / r["rel_path"]))
            assert info.frames == r["bars"] * bar
            assert r["bpm"] == 124.0
            assert "_124_" in r["rel_path"]


def test_loop_kicks_on_bar_starts_after_stretching(library, db, fixtures):
    """Acceptance: loop starts are sample-exact on the grid after stretching.

    The full drum loops contain the kick; every beat's kick onset must land within
    +-1 ms of its grid position (bar starts included), for a stretched 44.1 kHz
    source (122 BPM) and the unstretched one (124 BPM).
    """
    sr = 44100
    beat = 60.0 / 124.0 * sr
    checked = 0
    for name in ("night_drive", "deep_groove"):
        for r in _samples(db, library, name, "loop", "drums"):
            if "Drum Loop" not in _stem_of(db, r):
                continue
            data, fsr = sf.read(str(library.path / r["rel_path"]), always_2d=True)
            assert fsr == sr
            mono = data.mean(axis=1)
            positions = np.arange(r["bars"] * 4) * beat
            err = onset_errors_ms(mono, sr, positions)
            # Reference: the kick's own rise time in an unstretched render (~0.3 ms).
            assert np.max(np.abs(err - 0.32)) <= 1.0, (r["rel_path"], err)
            checked += 1
    assert checked >= 3


def test_48k_source_loops_on_grid(library, db):
    """48 kHz, 126 BPM source (resampled + stretched): the hats on beats 1 and 3 of every
    bar (beats 2 and 4 also carry a soft-attack shaker) land within 1 ms of the grid."""
    rows = _samples(db, library, "sunrise", "loop", "top")
    assert rows
    sr, beat = 44100, 60.0 / 124.0 * 44100
    for r in rows:
        data, _ = sf.read(str(library.path / r["rel_path"]), always_2d=True)
        mono = data.mean(axis=1)
        err = onset_errors_ms(mono, sr, np.arange(0, r["bars"] * 4, 2) * beat, rel=0.3, win_ms=8)
        assert np.max(np.abs(err)) <= 1.0, err


def test_mixed_sample_rates_in_one_zip(library, db):
    """night_drive's nested stems are 48 kHz, the rest 44.1 kHz: all output is 44.1 kHz,
    loops are whole bars, and the 48 kHz perc loops sit on the same grid."""
    stems = {r["file_name"]: r for r in db.stems_for_zip(library.results["night_drive"].zip_id)}
    assert stems["Extras.zip/Ride.wav"]["sample_rate"] == 48000
    assert stems["Night Drive - BD.aif"]["sample_rate"] == 44100
    bar = loops.bar_length(44100, 124.0)
    beat = bar / 4
    seen = set()
    for r in _samples(db, library, "night_drive"):
        stem = _stem_of(db, r)
        if not stem.startswith("Extras.zip/"):
            continue
        seen.add((stem, r["kind"]))
        data, sr = sf.read(str(library.path / r["rel_path"]), always_2d=True)
        assert sr == 44100 and r["sample_rate"] == 44100
        if r["kind"] == "loop":
            assert len(data) == r["bars"] * bar
            if "Conga" in stem:  # congas on steps 3, 6, 10, 11, 14 of every bar
                hits = [(b * 4 + s / 4) * beat for b in range(r["bars"]) for s in (3, 6, 10, 14)]
                err = onset_errors_ms(data.mean(axis=1), sr, hits, rel=0.3, win_ms=8)
                assert np.max(np.abs(err)) <= 1.0, err
    assert seen == {(s, k) for s in ("Extras.zip/Ride.wav", "Extras.zip/Perc Conga.wav")
                    for k in ("oneshot", "loop")}


def test_silent_breakdown_produces_no_loops(library, db, fixtures):
    """Acceptance: no loop is cut from the silent breakdown (bars 9-16)."""
    for name, truth in fixtures.truths.items():
        bar_s = 60.0 / truth.bpm * 4
        lo, hi = truth.breakdown
        for r in _samples(db, library, name, "loop"):
            start_bar = r["source_offset_s"] / bar_s
            end_bar = start_bar + r["bars"]
            overlap = max(0.0, min(end_bar, hi) - max(start_bar, lo))
            assert overlap <= 0.5 * r["bars"] + 1e-6, (name, r["rel_path"], start_bar)
            assert not (lo - 1e-3 <= start_bar < hi - 1e-3), (name, r["rel_path"], start_bar)


def test_identical_bars_dedupe_to_one_loop(library, db, fixtures):
    """Acceptance: repeated identical bars dedupe to one loop per stem and length."""
    for name, truth in fixtures.truths.items():
        per = Counter((_stem_of(db, r), r["bars"]) for r in _samples(db, library, name, "loop"))
        for (stem, bars), n in per.items():
            expected = truth.top_variations if "top" in stem.lower() else 1
            assert n == expected, (name, stem, bars, n)


def test_events_start_on_their_bar_and_dedupe(library, db, fixtures):
    """Every fill/roll/FX sound occurs twice: one event each, starting on the bar line where
    the sound starts in the source, whole bars long at the library BPM."""
    bar = loops.bar_length(44100, 124.0)
    for name, truth in fixtures.truths.items():
        rows = _samples(db, library, name, "event")
        assert sorted(_stem_of(db, r) for r in rows) == sorted(truth.events), name
        for r in rows:
            start_bar, lo, hi = truth.events[_stem_of(db, r)]
            src_bar = r["source_offset_s"] / (60.0 / truth.bpm * 4)
            assert src_bar == pytest.approx(start_bar, abs=1e-3), (name, r["rel_path"], src_bar)
            assert lo <= r["bars"] <= hi, (r["rel_path"], r["bars"])
            assert sf.info(str(library.path / r["rel_path"])).frames == r["bars"] * bar
            assert r["bpm"] == 124.0 and "_124_" in r["rel_path"]
            assert r["peak_db"] < 0 and r["gain_applied_db"] == pytest.approx(-1.0 - r["peak_db"], abs=1e-6)


def test_stretched_snare_roll_is_on_the_grid(library, db):
    """122 BPM roll stretched to 124: its 8th-note hits land within 1 ms of the new grid."""
    (r,) = [r for r in _samples(db, library, "night_drive", "event", "roll")]
    data, sr = sf.read(str(library.path / r["rel_path"]), always_2d=True)
    eighth = 60.0 / 124.0 * sr / 2
    # 50%: R3's pre-echo ahead of a snare (with the previous hit's tail under it) can reach
    # ~35% of the attack a millisecond early; the attack itself stays on the grid.
    err = onset_errors_ms(data.mean(axis=1), sr, np.arange(16) * eighth, rel=0.5, win_ms=8)
    assert np.max(np.abs(err)) <= 1.0, err


def test_one_shot_categories_and_transients(library, db):
    """Acceptance: every one-shot category yields a clean hit (no fade-in, peak in the first 10 ms)."""
    by_cat: dict[str, list] = {}
    for r in db.all_samples():
        if r["kind"] == "oneshot":
            by_cat.setdefault(r["category"], []).append(r)
    expected = {"kick", "clap", "snare", "hat_closed", "hat_open", "ride", "cymbal", "shaker", "perc"}
    assert expected <= set(by_cat), set(by_cat)
    for cat in expected:
        ok = False
        for r in by_cat[cat]:
            data, sr = sf.read(str(library.path / r["rel_path"]), always_2d=True)
            a = np.max(np.abs(data), axis=1)
            peak_ms = np.argmax(a) / sr * 1000
            # No fade-in: the first millisecond already holds the attack's rise.
            if peak_ms <= 10.0 and a[: int(0.002 * sr)].max() > 0.05:
                ok = True
                assert r["peak_db"] < 0 and r["gain_applied_db"] == pytest.approx(-0.3 - r["peak_db"], abs=1e-6)
                assert a.max() == pytest.approx(10 ** (-0.3 / 20), abs=2e-3)
        assert ok, cat


def test_one_shots_are_never_stretched(library, db, fixtures, extracted):
    """A one-shot from a 122 BPM source matches the source audio sample for sample (after gain)."""
    rows = _samples(db, library, "night_drive", "oneshot", "kick")
    r = rows[0]
    out, sr = sf.read(str(library.path / r["rel_path"]), always_2d=True)
    disc = extracted("night_drive")
    src, ssr = sf.read(str(disc.root / _stem_of(db, r)), always_2d=True)
    start = round(r["source_offset_s"] * ssr)
    n = len(out) - int(0.006 * sr)
    gain = 10 ** (r["gain_applied_db"] / 20)
    np.testing.assert_allclose(out[:n], src[start:start + n] * gain, atol=2e-6)


def test_hat_stem_split_into_open_and_closed(library, db):
    cats = {r["category"] for r in _samples(db, library, "sunrise", "oneshot")
            if _stem_of(db, r) == "Hat.wav"}
    assert cats == {"hat_open", "hat_closed"}


def test_stems_table(library, db, fixtures):
    for name, truth in fixtures.truths.items():
        rows = {r["file_name"]: r for r in db.stems_for_zip(library.results[name].zip_id)}
        assert set(rows) == {s.path for s in truth.stems}
        for s in truth.stems:
            row = rows[s.path]
            assert row["category"] in [s.category, *s.alt_categories]
            assert bool(row["auto_classified"]) == s.auto
            used = json.loads(row["used_for"])
            if s.category == "kick":
                assert "tempo" in used and "oneshots" in used
            if s.category == "melodic":
                assert used == ["key"]
            if s.path in truth.events:
                assert used == ["events"]


def test_peaks_json(library, db):
    r = next(r for r in db.all_samples() if r["kind"] == "loop" and r["bars"] == 2)
    p = json.loads((library_dir(library.path) / "peaks" / f"{r['id']}.json").read_text())
    assert len(p["points"]) == 2 * 1024 and p["kind"] == "loop"
    r = next(r for r in db.all_samples() if r["kind"] == "oneshot")
    p = json.loads((library_dir(library.path) / "peaks" / f"{r['id']}.json").read_text())
    assert abs(len(p["points"]) - r["duration_s"] * 200) <= 1
    assert all(lo <= hi for lo, hi in p["points"])


def test_already_processed_zip_is_skipped(library, fixtures):
    r = pipeline.process_zip(fixtures.zip("deep_groove"), library.settings)
    assert r.status == "skipped" and r.zip_id == library.results["deep_groove"].zip_id


# ---------------------------------------------------------------------------
# Reprocessing, overrides, deletion, rebuild (own library; deep_groove only: no stretching)
# ---------------------------------------------------------------------------

@pytest.fixture
def small_lib(fixtures, tmp_path):
    settings = Settings(library_path=str(tmp_path / "lib"))
    r = pipeline.process_zip(fixtures.zip("deep_groove"), settings)
    return settings, r


def test_reprocess_keeps_favorites_and_applies_overrides(small_lib):
    settings, r = small_lib
    lib = Path(settings.library_path)
    with LibraryDB(lib) as db:
        kick = next(s for s in db.samples_for_zip(r.zip_id, "oneshot") if s["category"] == "kick")
        hat_loop = next(s for s in db.samples_for_zip(r.zip_id, "loop") if s["category"] == "hat")
        db.conn.execute("UPDATE samples SET favorite = 1, rating = 5, tags = 'fat' WHERE id = ?", (kick["id"],))
        db.conn.execute("UPDATE samples SET rating = 3 WHERE id = ?", (hat_loop["id"],))
        stem_id = next(s["id"] for s in db.stems_for_zip(r.zip_id) if s["file_name"].endswith("Audio 07.wav"))

    r2 = pipeline.process_zip(None, settings, zip_id=r.zip_id,
                              overrides=Overrides(key="Fm", stems={str(stem_id): "perc"}))
    assert r2.zip_id == r.zip_id and r2.source_code == r.source_code
    assert r2.analysis.key.label == "Fm" and r2.analysis.key.backend == "override"
    with LibraryDB(lib) as db:
        z = db.get_zip(r.zip_id)
        assert z["key_override"] == "Fm" and z["key_label"] == "Fm"
        rows = db.samples_for_zip(r.zip_id)
        assert all("_Fm_" in s["rel_path"] for s in rows)
        assert not list(lib.rglob("*_Am_*.wav"))  # old files removed
        kick2 = next(s for s in rows if s["kind"] == "oneshot" and s["category"] == "kick")
        assert (kick2["favorite"], kick2["rating"], kick2["tags"]) == (1, 5, "fat")
        hat2 = next(s for s in rows if s["kind"] == "loop" and s["category"] == "hat"
                    and s["bars"] == hat_loop["bars"])
        assert hat2["rating"] == 3
        stem = next(s for s in db.stems_for_zip(r.zip_id) if s["file_name"].endswith("Audio 07.wav"))
        assert stem["category"] == "perc" and stem["category_override"] == "perc"
        assert any(s["category"] == "perc" for s in rows)

    # Stored overrides survive a plain reprocess.
    r3 = pipeline.process_zip(None, settings, zip_id=r.zip_id)
    assert r3.analysis.key.label == "Fm"


def test_bpm_override(small_lib):
    settings, r = small_lib
    r2 = pipeline.process_zip(None, settings, zip_id=r.zip_id, overrides=Overrides(bpm=123.0))
    assert r2.analysis.tempo.bpm == 123.0 and r2.analysis.tempo.detected_bpm == 124.0
    with LibraryDB(settings.library_path) as db:
        z = db.get_zip(r.zip_id)
        assert z["bpm_override"] == 123.0 and z["detected_bpm"] == 124.0


def test_delete_zip(small_lib):
    settings, r = small_lib
    lib = Path(settings.library_path)
    assert list(lib.rglob("*.wav"))
    out = pipeline.delete_zip(settings, r.zip_id)
    assert out["deleted_samples"] == r.counts.oneshots + r.counts.loops + r.counts.events
    assert not list(lib.rglob("*.wav"))
    with LibraryDB(lib) as db:
        assert db.get_zip(r.zip_id) is None and not db.all_samples()
    assert not list((library_dir(lib) / "peaks").glob("*.json"))


def test_rebuild_loops_at_new_bpm(small_lib):
    settings, r = small_lib
    lib = Path(settings.library_path)
    oneshots_before = sorted(p.name for p in (lib / "One-Shots").rglob("*.wav"))
    settings.library_bpm = 126.0
    results = pipeline.rebuild_loops(settings)
    assert len(results) == 1 and results[0].status == "done"
    assert sorted(p.name for p in (lib / "One-Shots").rglob("*.wav")) == oneshots_before
    loops_now = list((lib / "Loops").rglob("*.wav"))
    events_now = list((lib / "Fills").rglob("*.wav"))
    assert loops_now and all("_126_" in p.name for p in loops_now)
    assert len(events_now) == 1 and "_126_" in events_now[0].name
    bar = loops.bar_length(44100, 126.0)
    for p in loops_now + events_now:
        info = sf.info(str(p))
        assert info.frames % bar == 0


def test_max_stretch_exceeded_keeps_one_shots(fixtures, tmp_path):
    settings = Settings(library_path=str(tmp_path / "lib"), library_bpm=100.0)
    r = pipeline.process_zip(fixtures.zip("deep_groove"), settings)
    assert r.status == "needs_review"
    assert r.counts.loops == 0 and r.counts.events == 0 and r.counts.oneshots > 0
    assert any("max stretch" in w for w in r.warnings)


def test_missing_zip_and_cancel(fixtures, tmp_path):
    settings = Settings(library_path=str(tmp_path / "lib"))
    with pytest.raises(pipeline.PipelineError):
        pipeline.process_zip(tmp_path / "nope.zip", settings)
    ctx = pipeline.JobContext(is_cancelled=lambda: True)
    with pytest.raises(pipeline.Cancelled):
        pipeline.process_zip(fixtures.zip("deep_groove"), settings, ctx=ctx)
    with LibraryDB(settings.library_path) as db:
        assert not db.list_zips()  # a cancelled new zip leaves nothing behind


def test_find_zips(fixtures, tmp_path):
    nested = tmp_path / "a" / "b"
    nested.mkdir(parents=True)
    shutil.copy(fixtures.zip("deep_groove"), nested / "x.zip")
    (tmp_path / "__MACOSX").mkdir()
    (tmp_path / "__MACOSX" / "._x.zip").write_bytes(b"junk")
    assert pipeline.find_zips([tmp_path]) == [nested / "x.zip"]


def test_analyze_writes_nothing(fixtures, tmp_path):
    settings = Settings(library_path=str(tmp_path / "lib"))
    a = pipeline.analyze_zip(fixtures.zip("sunrise"), settings)
    assert a.tempo.bpm == 126.0 and a.key.label == "D"
    assert not (tmp_path / "lib").exists()
