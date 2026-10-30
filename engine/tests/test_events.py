"""Event cutting on a known grid (no stretching): fills, rolls and FX (SCOPE.md §5.8a)."""

import numpy as np

from drumvault_engine import events
from drumvault_engine.config import Settings
from drumvault_engine.loops import bar_length

SR, BPM = 44100, 124.0
BAR = bar_length(SR, BPM)
BEAT = BAR / 4


def _stem(bars: int = 32) -> np.ndarray:
    return np.zeros((bars * BAR, 1), np.float32)


def _burst(n: int, seed: int, amp: float = 0.5) -> np.ndarray:
    """Decaying noise: the same seed gives the same sound."""
    rng = np.random.default_rng(seed)
    env = np.exp(-np.arange(n) / (0.3 * n))
    return (amp * rng.standard_normal(n) * env).astype(np.float32)[:, None]


def _put(stem: np.ndarray, beat: float, sound: np.ndarray) -> None:
    s = int(round(beat * BEAT))
    stem[s:s + len(sound)] += sound[:len(stem) - s]


def test_events_start_on_bar_lines_and_repeats_dedupe():
    stem = _stem()
    riser = _burst(4 * BAR, seed=1)
    _put(stem, 4 * 4, riser)       # bars 5-8
    _put(stem, 12 * 4, riser)      # bars 13-16, identical
    _put(stem, 20 * 4 + 1, _burst(int(1.5 * BEAT), seed=2))  # a hit on beat 2 of bar 21
    evs = events.extract_events(stem, SR, 0, BPM, Settings())
    assert [(e.start // BAR, e.bars) for e in evs] == [(4, 4), (20, 1)]
    edge = int(0.01 * SR)  # declick fades where the riser starts and stops mid-sound
    for e in evs:
        assert e.start % BAR == 0 and len(e.data) == e.bars * BAR
        np.testing.assert_array_equal(e.data[edge:-edge], stem[e.start + edge:e.start + len(e.data) - edge])


def test_tail_extends_to_whole_bars():
    stem = _stem()
    _put(stem, 8 * 4, _burst(int(4.5 * BEAT), seed=3))  # one bar plus two beats of tail
    (e,) = events.extract_events(stem, SR, 0, BPM, Settings())
    assert (e.start // BAR, e.bars) == (8, 2)


def test_grid_phase_is_respected():
    phase = 1234
    stem = _stem()
    _put(stem, 4 * 4 + phase / BEAT, _burst(2 * BAR, seed=4))
    (e,) = events.extract_events(stem, SR, phase, BPM, Settings())
    assert e.start == phase + 4 * BAR and e.bars == 2


def test_preroll_just_before_a_bar_belongs_to_that_bar():
    s = Settings()
    stem = _stem()
    early = s.thresholds.event_preroll_ms / 2 / 1000 * SR / BEAT   # in beats
    _put(stem, 8 * 4 - early, _burst(BAR, seed=5))
    (e,) = events.extract_events(stem, SR, 0, BPM, s)
    assert e.start == 8 * BAR

    stem = _stem()
    _put(stem, 8 * 4 - 0.5, _burst(BAR, seed=5))    # half a beat early: starts in bar 8
    (e,) = events.extract_events(stem, SR, 0, BPM, s)
    assert e.start == 7 * BAR


def test_neighbours_sharing_a_bar_are_cut_apart():
    s = Settings()
    s.thresholds.event_merge_gap_beats = 0
    stem = _stem()
    _put(stem, 8, _burst(int(BEAT), seed=6))        # beat 1 of bar 3
    _put(stem, 10, _burst(int(BEAT), seed=7))       # beat 3 of bar 3
    a, b = events.extract_events(stem, SR, 0, BPM, s)
    assert a.start == b.start == 2 * BAR
    cut = int(round(10 * BEAT)) - 2 * BAR
    assert not a.data[cut:].any() and a.data[:cut - 1000].any()
    assert not b.data[:cut].any() and b.data[cut + 1000:].any()


def test_quiet_events_are_skipped():
    stem = _stem()
    _put(stem, 4 * 4, _burst(BAR, seed=8))
    _put(stem, 12 * 4, _burst(BAR, seed=9, amp=0.5 * 10 ** (-40 / 20)))
    evs = events.extract_events(stem, SR, 0, BPM, Settings())
    assert [e.start // BAR for e in evs] == [4]


def test_long_beds_are_cut_into_chunks():
    s = Settings()
    rng = np.random.default_rng(10)
    stem = (0.2 * rng.standard_normal((48 * BAR, 1))).astype(np.float32)
    evs = events.extract_events(stem, SR, 0, BPM, s)
    assert len(evs) == 1 and evs[0].bars == s.thresholds.event_bed_bars  # steady noise: one texture

    s.event_dedupe_threshold = 1.0
    s.max_events_per_stem = 4
    evs = events.extract_events(stem, SR, 0, BPM, s)
    assert len(evs) == 4
    assert all(e.bars == 8 and e.start % (8 * BAR) == 0 for e in evs)
    for e in evs:  # chunks of a bed are faded, not clicked, at both ends
        assert abs(e.data[0, 0]) < 0.01 and e.data[-1, 0] == 0.0


def test_body_bars_exclude_the_tail():
    """A 4-bar build whose ring-out spills into a fifth bar: 5 bars long, a 4-bar body."""
    stem = _stem()
    n = 4 * BAR
    build = (0.5 * np.random.default_rng(11).standard_normal(n) * np.linspace(0.1, 1.0, n)).astype(np.float32)
    tail = (0.5 * np.random.default_rng(12).standard_normal(int(1.5 * BEAT))
            * np.exp(-np.arange(int(1.5 * BEAT)) / (0.15 * BEAT)) * 0.2).astype(np.float32)
    _put(stem, 8 * 4, np.concatenate([build, tail])[:, None])
    (e,) = events.extract_events(stem, SR, 0, BPM, Settings())
    assert (e.start // BAR, e.bars, e.body_bars) == (8, 5, 4)


def test_old_library_gets_the_body_bars_column(tmp_path):
    import sqlite3

    from drumvault_engine.db import SCHEMA, LibraryDB, db_path
    path = db_path(tmp_path)
    path.parent.mkdir(parents=True)
    con = sqlite3.connect(path)
    con.executescript(SCHEMA.replace("  body_bars INTEGER,\n", ""))  # a v1 library
    con.execute("INSERT INTO samples (kind, bars) VALUES ('event', 5)")
    con.commit()
    con.close()
    with LibraryDB(tmp_path) as db:
        cols = {r["name"] for r in db.conn.execute("PRAGMA table_info(samples)")}
        assert "body_bars" in cols
        assert db.conn.execute("SELECT bars, body_bars FROM samples").fetchone()[:] == (5, None)


def _shape(sound: np.ndarray, bars: int, body: int) -> dict:
    data = np.zeros((bars * BAR, 1), np.float32)
    data[:len(sound)] = sound[:len(data)]
    return events.shape(data, SR, BPM, bars, body, Settings().thresholds)


def _rising(n: int, seed: int) -> np.ndarray:
    """Noise getting louder and brighter (a riser)."""
    from scipy.signal import lfilter
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(n)
    lo = lfilter([0.05], [1, -0.95], x)                    # dark at the start...
    t = np.linspace(0, 1, n)
    return ((lo * (1 - t) + x * t) * np.linspace(0.02, 0.6, n)).astype(np.float32)[:, None]


def test_shape_finds_the_producers_silence_before_the_drop():
    # A two-bar riser that stops on the last beat: one beat (4 16ths) of silence left.
    s = _shape(_rising(int(7 * BEAT), seed=21), bars=2, body=2)
    assert s["dir"] == "rise" and s["gap"] == 4 and s["end"] == 28 and s["peak"] in (26, 27)
    # Right up to the drop, with a tail ringing on into the third bar: no silence.
    full = np.concatenate([_rising(int(8 * BEAT), seed=22), _burst(int(2 * BEAT), seed=23, amp=0.3)])
    s = _shape(full, bars=3, body=2)
    assert s["dir"] == "rise" and s["gap"] == 0 and s["end"] == 32


def test_shape_tells_falls_and_hits_apart():
    n = int(8 * BEAT)
    fall = _rising(n, seed=24)[::-1].copy()                  # a downlifter: the riser backwards
    assert _shape(fall, bars=2, body=2)["dir"] == "fall"
    hit = _burst(int(3 * BEAT), seed=25)                     # an impact: loud at once, then gone
    s = _shape(hit, bars=1, body=1)
    assert s["dir"] == "hit" and s["onset"] == 0 and s["peak"] == 0
    noise = _shape(_rising(n, seed=26), bars=2, body=2)["noise"]
    tone = np.sin(2 * np.pi * 440 * np.arange(n) / SR).astype(np.float32)[:, None] * np.linspace(0.05, 0.6, n)[:, None]
    assert _shape(tone, bars=2, body=2)["noise"] < 0.05 < noise


def test_events_know_the_bar_they_start_on():
    stem = _stem()
    _put(stem, 12 * 4, _burst(2 * BAR, seed=27))
    (e,) = events.extract_events(stem, SR, 1000, BPM, Settings())
    assert e.bar == 12  # 1000 samples early: within the preroll, so on bar 12
