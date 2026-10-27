import numpy as np
import pytest

from make_fixtures import FOUR_ON_FLOOR, SIXTEENTHS, Track, conga, hat_closed, kick, rim
from drumvault_engine import loops
from drumvault_engine.config import Settings

SR, BPM = 44100, 124.0
BAR = loops.bar_length(SR, BPM)


def _track(bars, fill):
    tr = Track(BPM, SR, bars=bars, channels=2)
    fill(tr)
    return tr.buf.astype(np.float32)


def test_bar_length_and_slice_positions():
    assert BAR == round(SR * 60 / BPM * 4)
    starts = loops.slice_starts(10 * BAR + 5, 100, 2 * BAR)
    assert starts == [100, 100 + 2 * BAR, 100 + 4 * BAR, 100 + 6 * BAR]  # 100 + 10 bars doesn't fit
    assert all(b - a == 2 * BAR for a, b in zip(starts, starts[1:]))  # non-overlapping, contiguous


def test_identical_bars_dedupe_to_one():
    rng = np.random.default_rng(0)
    x = _track(8, lambda tr: tr.pattern(hat_closed, rng, SIXTEENTHS, range(8)))
    out = loops.extract_loops(x, SR, 0, BPM, [1, 2, 4], Settings())
    assert sorted(l.bars for l in out) == [1, 2, 4]


def test_variations_are_kept_in_order():
    rng = np.random.default_rng(1)

    def fill(tr):
        tr.pattern(hat_closed, rng, SIXTEENTHS, range(0, 4))
        tr.pattern(conga, rng, {3: 1.0, 11: 1.0}, range(4, 8))
        tr.pattern(rim, rng, {1: 1.0, 7: 1.0, 9: 1.0}, range(8, 12))
    x = _track(12, fill)
    out = [l for l in loops.extract_loops(x, SR, 0, BPM, [4], Settings())]
    assert [l.start // BAR for l in out] == [0, 4, 8]


def test_silent_breakdown_produces_no_loops():
    rng = np.random.default_rng(2)
    x = _track(16, lambda tr: tr.pattern(hat_closed, rng, SIXTEENTHS, [b for b in range(16) if not 4 <= b < 12]))
    out = loops.extract_loops(x, SR, 0, BPM, [1, 2, 4], Settings())
    for l in out:
        first_bar = l.start // BAR
        assert not (4 <= first_bar < 12), l.start


def test_more_than_half_silent_beats_dropped():
    th = Settings().thresholds
    beat = BAR // 4
    loud = (0.3 * np.random.default_rng(3).standard_normal(BAR)).astype(np.float32)
    m = loud.copy()
    m[beat:] = 0.0  # 3 of 4 beats silent
    assert loops.is_silent(m, 4, th)
    m = loud.copy()
    m[2 * beat:] = 0.0  # exactly half silent -> kept
    assert not loops.is_silent(m, 4, th)
    assert loops.is_silent(np.full(BAR, 1e-4, np.float32), 4, th)  # -80 dBFS overall


def test_relative_beat_silence_catches_tails():
    th = Settings().thresholds
    beat = BAR // 4
    m = np.zeros(BAR, np.float32)
    m[:beat] = 0.05                    # -26 dBFS
    m[beat:2 * beat] = 0.0025          # -52 dBFS: above -55 absolute, but 26 dB below the stem
    assert not loops.is_silent(m, 4, th)
    assert loops.is_silent(m, 4, th, ref_db=-20.0)


def test_cap_keeps_most_distinct():
    rng = np.random.default_rng(4)
    fps = [v / np.linalg.norm(v) for v in rng.random((10, 32))]
    sel = loops.farthest_point(fps, 4)
    assert len(sel) == 4 and sel[0] == 0 and sel == sorted(sel)
    assert loops.farthest_point(fps[:3], 6) == [0, 1, 2]


def test_max_loops_per_length():
    rng = np.random.default_rng(5)

    def fill(tr):  # 10 different one-bar patterns
        for b in range(10):
            steps = {int(s): 1.0 for s in rng.choice(16, size=4, replace=False)}
            tr.pattern(conga if b % 2 else rim, rng, steps, [b])
    x = _track(10, fill)
    s = Settings(max_loops_per_length=6)
    out = loops.extract_loops(x, SR, 0, BPM, [1], s)
    assert len(out) <= 6


def test_no_fades_on_grid_cut():
    x = _track(4, lambda tr: tr.pattern(kick, None, FOUR_ON_FLOOR, range(4)))
    out = loops.extract_loops(x, SR, 0, BPM, [1], Settings())
    assert len(out) == 1
    l = out[0]
    assert len(l.data) == BAR
    assert not l.faded_in  # kick starts at a zero crossing
    np.testing.assert_array_equal(l.data, x[:BAR])  # sample exact, no end fade


def test_fade_in_only_when_needed():
    th = Settings().thresholds
    seg = np.full((1000, 2), 0.5, np.float32)
    out, faded = loops.fade_in_if_needed(seg, SR, th)
    assert faded and out[0, 0] == 0.0 and out[-1, 0] == 0.5
    n = round(th.loop_fade_in_ms * SR / 1000)
    np.testing.assert_array_equal(out[n:], seg[n:])
    seg[0] = 0.0
    out, faded = loops.fade_in_if_needed(seg, SR, th)
    assert not faded and out is seg


@pytest.mark.parametrize("phase", [0, 1234])
def test_phase_offsets_slices(phase):
    x = _track(4, lambda tr: tr.pattern(kick, None, FOUR_ON_FLOOR, range(4)))
    x = np.concatenate([np.zeros((phase, 2), np.float32), x])
    out = loops.extract_loops(x, SR, phase, BPM, [1], Settings())
    assert out and out[0].start == phase
