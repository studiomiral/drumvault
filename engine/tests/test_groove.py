"""Loop grooves (groove.py), bass notes on a groove, and track arrangements (arrangement.py)."""

import json

import numpy as np
import pytest

from drumvault_engine import arrangement, groove, pipeline
from drumvault_engine.config import Settings, Thresholds
from drumvault_engine.db import LibraryDB
from drumvault_engine.midi import Note, apply_groove

SR = 44100
BPM = 124.0
S16 = 60 / BPM / 4


def _hats(steps: list[float], bars: int = 2, seed: int = 1, accent: int | None = 2) -> np.ndarray:
    """Noise hats at the given 16th positions (fractional = off the grid), every bar."""
    rng = np.random.default_rng(seed)
    y = np.zeros(int(bars * 16 * S16 * SR) + 10)
    for b in range(bars):
        for s in steps:
            a = int(round((b * 16 + s) * S16 * SR))
            h = rng.standard_normal(2000) * np.exp(-np.arange(2000) / 300) * (1.0 if accent is not None and int(s) % 4 == accent else 0.5)
            y[a:a + len(h)] += h[:len(y) - a]
    return y[:, None].astype(np.float32)


@pytest.mark.parametrize("swing", [0.0, 0.2, 0.33])
def test_measures_swing_on_the_odd_sixteenths(swing):
    g = groove.loop_groove(_hats([i + (swing if i % 2 else 0) for i in range(16)]), SR, BPM, Thresholds())
    assert g is not None
    assert g["swing"] == pytest.approx(swing, abs=0.02)
    assert g["push"] == pytest.approx(0.0, abs=0.02)
    for k in range(16):
        assert g["offsets"][k] == pytest.approx(swing if k % 2 else 0.0, abs=0.02)
        assert g["hits"][k] == 2


def test_offbeat_push_and_accents():
    # Offbeat 8ths played late, the loop's quarters on time: a "pushed" groove, accents on the offbeats.
    g = groove.loop_groove(_hats([0, 2.15, 4, 6.15, 8, 10.15, 12, 14.15]), SR, BPM, Thresholds())
    assert g["push"] == pytest.approx(0.15, abs=0.02)
    assert g["offsets"][1] is None and g["hits"][1] == 0
    assert g["levels"][2] == pytest.approx(0.0, abs=1.5) and g["levels"][0] < -3


def test_offsets_are_relative_to_the_loops_own_quarters():
    late = [s + 0.1 for s in range(16)]  # everything 0.1 of a 16th late: on time for this loop
    g = groove.loop_groove(_hats(late), SR, BPM, Thresholds())
    assert max(abs(o) for o in g["offsets"]) < 0.02


def test_silence_has_no_groove():
    assert groove.loop_groove(np.zeros((SR * 4, 2), dtype=np.float32), SR, BPM, Thresholds()) is None


def test_bass_notes_follow_the_groove():
    g = [0.0, 0.25] * 8
    notes = [Note(0, 0.25, 40, 100), Note(0.25, 0.25, 40, 100), Note(0.6, 0.2, 43, 90)]
    out = apply_groove(notes, g)
    assert out[0].start == 0 and out[0].length == 0.25
    assert out[1].start == pytest.approx(0.25 + 0.0625) and out[1].start + out[1].length == pytest.approx(0.5)
    assert out[2] == notes[2]  # off the 16th grid: left alone


def _bars(levels: list[float], bpm: float = BPM, sr: int = 8000) -> np.ndarray:
    bar = int(round(240 / bpm * sr))
    rng = np.random.default_rng(0)
    return np.concatenate([rng.standard_normal(bar) * a for a in levels]).astype(np.float32)


def test_arrangement_marks_full_quiet_and_silent_bars():
    kick = _bars([0.5] * 8 + [0] * 8 + [0.5] * 8)
    bass = _bars([0.05] * 4 + [0.4] * 20)            # filtered in, then full
    hats = _bars([0.3] * 24)
    a = arrangement.measure([("Kick", "kick", kick, 8000), ("Bass", "melodic", bass, 8000),
                             ("Chords", "melodic", hats * 0.1, 8000), ("Hats", "hat_closed", hats, 8000),
                             ("Vocal", "ignore", hats, 8000)], BPM, 0.0, Thresholds())
    assert a["bars"] == 24
    assert a["parts"]["kick"] == "2" * 8 + "0" * 8 + "2" * 8
    assert a["parts"]["bass"] == "1" * 4 + "2" * 20
    assert set(a["parts"]) == {"kick", "bass", "music", "hats"}


def test_arrangement_measures_rides_bar_by_bar():
    """A low-passed stretch reads darker (and a little quieter); a fader move quieter, as bright."""
    from scipy.signal import butter, sosfilt
    sr = 32000
    chords = _bars([0.3] * 16, sr=sr)
    bar = len(chords) // 16
    lp = sosfilt(butter(4, 600, "low", fs=sr, output="sos"), chords[4 * bar:8 * bar]).astype(np.float32)
    chords = np.concatenate([chords[:4 * bar], lp, chords[8 * bar:12 * bar] * 0.3, chords[12 * bar:]])
    a = arrangement.measure([("Chords", "melodic", chords, sr)], BPM, 0.0, Thresholds())
    d = a["detail"]["music"]
    assert len(d["db"]) == len(d["bright"]) == a["bars"] >= 15
    full = range(0, 4)
    for b in full:
        assert abs(d["db"][b]) < 1.5 and abs(d["bright"][b]) < 0.15
    for b in range(4, 8):                     # low-passed at 600 Hz: octaves darker
        assert d["bright"][b] < -1.5
    for b in range(8, 12):                    # the fader down 10 dB: as bright
        assert d["db"][b] == pytest.approx(-10.5, abs=1.5)
        assert abs(d["bright"][b]) < 0.15
    silent = arrangement.measure([("Chords", "melodic", _bars([0.3] * 4 + [0] * 4, sr=sr), sr)], BPM, 0.0, Thresholds())
    sd = silent["detail"]["music"]
    assert all(v is None for v in sd["db"][4:] + sd["bright"][4:]) and len(sd["db"]) > 4


def test_arrangement_on_a_later_bar_one():
    kick = np.concatenate([np.zeros(1000, dtype=np.float32), _bars([0.5] * 4)])
    a = arrangement.measure([("Kick", "kick", kick, 8000)], BPM, 1000 / 8000, Thresholds())
    assert a["parts"]["kick"] == "2222"


def test_processing_stores_grooves_and_the_arrangement(library, fixtures):
    with LibraryDB(library.path) as db:
        loops = db.conn.execute("SELECT category, groove FROM samples WHERE kind = 'loop'").fetchall()
        assert loops and all(r["groove"] is not None for r in loops)
        hat = [json.loads(r["groove"]) for r in loops if r["category"] in ("hat", "hat_closed")]
        assert any(g and abs(g["swing"]) < 0.05 for g in hat)  # the fixtures are straight
        for name, truth in fixtures.truths.items():
            a = db.get_arrangement(library.results[name].zip_id)
            assert a is not None and a["bpm"] == truth.bpm
            kick = a["parts"]["kick"]
            lo, hi = truth.breakdown
            assert set(kick[lo:hi]) == {"0"}, name
            assert set(kick[truth.kick_start_bar:lo]) == {"2"}, name


def test_analyze_library_fills_in_older_libraries(fixtures, tmp_path):
    settings = Settings(library_path=str(tmp_path / "lib"))
    r = pipeline.process_zip(fixtures.zip("deep_groove"), settings)
    with LibraryDB(settings.library_path) as db:
        before = db.get_arrangement(r.zip_id)
        shapes = dict(db.conn.execute("SELECT id, shape FROM samples WHERE kind = 'event'").fetchall())
        db.conn.execute("UPDATE samples SET groove = NULL, shape = NULL")
        db.conn.execute("DELETE FROM arrangements")
    out = pipeline.analyze_library(settings)
    assert out["arrangements"] == 1 and out["grooves"] > 0 and out["shapes"] == len(shapes) > 0 and out["missing"] == []
    with LibraryDB(settings.library_path) as db:
        assert db.get_arrangement(r.zip_id) == before
        assert not db.loops_without_groove() and not db.events_without_shape()
        # The same shapes as processing measured, the source bar worked out from the stored offset.
        again = dict(db.conn.execute("SELECT id, shape FROM samples WHERE kind = 'event'").fetchall())
        assert {k: json.loads(v) for k, v in again.items()} == {k: json.loads(v) for k, v in shapes.items()}
    assert pipeline.analyze_library(settings) == {"grooves": 0, "shapes": 0, "kept": 0, "not_kept": [], "arrangements": 0,
                                                   "missing": []}


def test_old_library_gets_the_new_columns(tmp_path):
    lib = tmp_path / "lib"
    with LibraryDB(lib) as db:  # a v6 library: no groove column, no arrangements table
        db.conn.execute("ALTER TABLE samples DROP COLUMN groove")
        db.conn.execute("DROP TABLE arrangements")
    with LibraryDB(lib) as db:
        assert "groove" in {r["name"] for r in db.conn.execute("PRAGMA table_info(samples)")}
        assert db.get_arrangement(1) is None


def test_rpc_runs_analyze_library_as_a_job(tmp_path):
    from drumvault_engine.schemas import RpcRequest
    req = RpcRequest.model_validate({"id": "1", "method": "analyze_library", "params": {"settings": {}}})
    assert req.method == "analyze_library"
