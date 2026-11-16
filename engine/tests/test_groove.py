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
    assert pipeline.analyze_library(settings) == {"atmos": {"moved": 0, "deleted": 0, "purged": 0}, "loudness": 0, "grooves": 0, "shapes": 0, "kept": 0, "not_kept": [],
                                                   "arrangements": 0, "missing": []}


def test_k_energy_matches_lufs():
    """A 997 Hz sine at -20 dBFS (mono) is -23.05 LUFS (ITU-R BS.1770); 4 s of it 6 dB more energy than 1 s."""
    from drumvault_engine.audioutil import k_energy_db
    import pyloudnorm
    for sr in (44100, 48000):
        t = np.arange(4 * sr) / sr
        x = (np.sin(2 * np.pi * 997 * t) * 0.1).astype(np.float32)
        assert k_energy_db(x, sr) - 10 * np.log10(4) == pytest.approx(pyloudnorm.Meter(sr).integrated_loudness(x.astype(np.float64)), abs=0.05)
        assert k_energy_db(x, sr) - k_energy_db(x[:sr], sr) == pytest.approx(10 * np.log10(4), abs=0.05)
    assert k_energy_db(np.zeros(1000, dtype=np.float32), 44100) is None


def test_arrangement_measures_the_producers_balance():
    """Each part's loudness in its full bars; the balance is the producer's unless the stems were normalised one by one."""
    kick = _bars([0.5] * 8 + [0] * 4 + [0.5] * 8)
    hats = _bars([0.05] * 20)
    a = arrangement.measure([("Kick", "kick", kick, 8000), ("Hats", "hat_closed", hats, 8000)], BPM, 0.0, Thresholds())
    lv = a["levels"]["parts"]
    assert lv["kick"] - lv["hats"] == pytest.approx(20.0, abs=1.5)   # the breakdown doesn't pull the kick down
    peaky = lambda x: x / np.max(np.abs(x))  # noqa: E731
    th = Thresholds()
    assert not a["levels"]["normalized"]
    norm = arrangement.measure([("Kick", "kick", peaky(kick), 8000), ("Hats", "hat_closed", peaky(hats), 8000),
                                ("Perc", "perc", peaky(hats), 8000)], BPM, 0.0, th)
    assert norm["levels"]["normalized"]
    # A full drum loop plays with the tops but isn't their level (it's mostly a kick).
    with_drums = arrangement.measure([("Kick", "kick", kick, 8000), ("Top", "top", hats, 8000), ("Drums", "drums", kick, 8000)],
                                     BPM, 0.0, th)
    assert with_drums["levels"]["parts"]["top"] == pytest.approx(lv["hats"], abs=0.2)
    # Each part's tone: its bands against its total; noise is flat per Hz, so it rises with the band
    # width (up to 4 kHz: the test stems are at 8 kHz).
    sp = a["levels"]["spectra"]["hats"]
    edges = np.geomspace(th.arrangement_band_lo_hz, th.arrangement_band_hi_hz, th.arrangement_bands + 1)
    top = int(np.searchsorted(edges, 3500)) - 1
    assert len(sp) == th.arrangement_bands and sp[top] > sp[0] + 10
    assert 10 * np.log10(sum(10 ** (v / 10) for v in sp)) == pytest.approx(0, abs=0.2)


def test_tone_of_a_sound():
    from drumvault_engine.arrangement import tone
    th = Thresholds()
    sr = 44100
    t = np.arange(sr) / sr
    low = tone(np.sin(2 * np.pi * 100 * t).astype(np.float32), sr, th)
    high = tone(np.sin(2 * np.pi * 5000 * t).astype(np.float32), sr, th)
    edges = np.geomspace(th.arrangement_band_lo_hz, th.arrangement_band_hi_hz, th.arrangement_bands + 1)
    assert int(np.argmax(low)) == int(np.searchsorted(edges, 100)) - 1
    assert int(np.argmax(high)) == int(np.searchsorted(edges, 5000)) - 1
    assert tone(np.zeros(1000, dtype=np.float32), sr, th) is None


def test_punch_is_the_loudest_window_and_tells_a_snappy_hit_from_a_washy_one():
    from drumvault_engine.audioutil import k_energy_db, k_punch_db

    sr = 44100
    rng = np.random.default_rng(1)
    noise = rng.standard_normal(sr).astype(np.float32) * 0.1
    # A sound as long as the window: its punch is its loudness.
    assert k_punch_db(noise[: sr // 5], sr, 0.2) == pytest.approx(k_energy_db(noise[: sr // 5], sr) - 10 * np.log10(0.2), abs=0.05)
    # Steady noise: any window is as loud as the whole.
    assert k_punch_db(noise, sr, 0.2) == pytest.approx(k_energy_db(noise, sr), abs=0.5)
    # The same energy in 50 ms or spread over 800 ms: the snappy one hits 6 dB harder (0.8 s / 0.2 s).
    snappy = np.zeros(sr, dtype=np.float32)
    snappy[: sr // 20] = rng.standard_normal(sr // 20) * 0.4
    washy = np.zeros(sr, dtype=np.float32)
    washy[: 4 * sr // 5] = rng.standard_normal(4 * sr // 5) * 0.1
    assert k_energy_db(snappy, sr) == pytest.approx(k_energy_db(washy, sr), abs=0.5)
    assert k_punch_db(snappy, sr, 0.2) - k_punch_db(washy, sr, 0.2) == pytest.approx(6.0, abs=0.7)
    # Shorter than the window: counted as the window long. Stereo as its mono mix. Silence: none.
    assert k_punch_db(snappy[: sr // 20], sr, 0.2) == pytest.approx(k_punch_db(snappy, sr, 0.2), abs=0.05)
    assert k_punch_db(np.stack([snappy, snappy], axis=1), sr, 0.2) == pytest.approx(k_punch_db(snappy, sr, 0.2), abs=0.01)
    assert k_punch_db(np.zeros(1000, dtype=np.float32), sr, 0.2) is None


def test_samples_and_hits_get_their_loudness(fixtures, tmp_path):
    settings = Settings(library_path=str(tmp_path / "lib"))
    pipeline.process_zip(fixtures.zip("deep_groove"), settings)
    with LibraryDB(settings.library_path) as db:
        rows = db.conn.execute("SELECT id, energy_db, tone, punch_db FROM samples").fetchall()
        assert rows and all(r["energy_db"] is not None and -60 < r["energy_db"] < 20 for r in rows)
        assert all(r["punch_db"] is not None and -60 < r["punch_db"] < 10 for r in rows)
        punch = {r["id"]: r["punch_db"] for r in rows}
        assert all(len(json.loads(r["tone"])) == 24 for r in rows)
        measured = {r["id"]: r["energy_db"] for r in rows}
        db.conn.execute("UPDATE samples SET energy_db = NULL, tone = NULL, punch_db = NULL")
        assert db.get_arrangement(1)["levels"]["parts"]["kick"] < 0
    assert pipeline.analyze_library(settings)["loudness"] == len(measured)
    with LibraryDB(settings.library_path) as db:
        again = {r["id"]: r["energy_db"] for r in db.conn.execute("SELECT id, energy_db FROM samples")}
        assert again == pytest.approx(measured, abs=0.02)
        assert {r["id"]: r["punch_db"] for r in db.conn.execute("SELECT id, punch_db FROM samples")} == pytest.approx(punch, abs=0.02)


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


def test_arrangement_measures_stems_loaded_one_at_a_time():
    """Stems given as loaders measure exactly as stems given as audio (a long track never sits in memory whole)."""
    kick = _bars([0.5] * 8 + [0] * 4 + [0.5] * 8)
    hats = _bars([0.05] * 14)          # shorter than the kick: its last bars are silent
    th = Thresholds()
    given = arrangement.measure([("Kick", "kick", kick, 8000), ("Hats", "hat_closed", hats, 8000)], BPM, 0.0, th)
    loaded = []
    lazy = arrangement.measure([("Kick", "kick", lambda: loaded.append("k") or kick, 8000),
                                ("Hats", "hat_closed", lambda: loaded.append("h") or hats, 8000)], BPM, 0.0, th)
    assert lazy == given and loaded == ["k", "h"]
