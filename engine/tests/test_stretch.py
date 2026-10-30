import numpy as np
import pytest

from make_fixtures import FOUR_ON_FLOOR, Track, kick
from drumvault_engine import stretch
from drumvault_engine.config import Settings


def _kick_track(bpm, sr, bars=8):
    tr = Track(bpm, sr, bars=bars, channels=2)
    tr.pattern(kick, None, FOUR_ON_FLOOR, range(bars))
    return tr.buf.astype(np.float32)


def onset_errors_ms(mono, sr, positions, rel=0.3, win_ms=20.0):
    """For each expected position: first sample reaching `rel` x the local peak, minus the position.

    30% rather than 10%: Rubber Band's R3 engine smears a kick's low end into a
    ~-20 dB pre-echo a few ms ahead of the attack; the attack itself stays put.
    """
    w = int(win_ms * sr / 1000)
    errs = []
    for c in positions:
        c = int(round(c))
        seg = np.abs(mono[max(0, c - w):c + w])
        first = int(np.argmax(seg >= rel * seg.max()))
        errs.append((max(0, c - w) + first - c) / sr * 1000)
    return np.array(errs)


def test_rubberband_present_and_probed():
    info = stretch.rubberband_info()
    assert info.path, "rubberband CLI not installed (see CLAUDE.md)"
    assert info.version


def test_r3_flag_dropped_when_unsupported():
    s = Settings(rubberband_options=["--not-a-real-flag"], rubberband_r3_flag="--not-a-real-flag")
    opts, warnings = stretch.effective_options(s)
    assert opts == [] and warnings
    s = Settings()
    opts, warnings = stretch.effective_options(s)
    if stretch.rubberband_info().supports_r3:
        assert opts == ["--fine"] and not warnings


def test_ratio_and_limits():
    assert stretch.time_factor(122, 124) == pytest.approx(122 / 124)
    assert stretch.stretch_allowed(122, 124, 0.15)
    assert not stretch.stretch_allowed(100, 124, 0.15)
    assert stretch.map_samples(48000, 48000, 122, 124, 44100) == round(44100 * 122 / 124)


def test_no_stretch_when_tempo_matches():
    x = _kick_track(124, 44100, bars=2)
    y, sr, w = stretch.stretch_stem(x, 44100, 124.0, Settings())
    assert sr == 44100 and y.shape == x.shape and np.array_equal(y, x)


def test_resample_only():
    x = _kick_track(124, 48000, bars=2)
    y, sr, _ = stretch.stretch_stem(x, 48000, 124.0, Settings())
    assert sr == 44100
    assert abs(y.shape[0] - x.shape[0] * 44100 / 48000) <= 1


@pytest.mark.parametrize("src_bpm,src_sr", [(122.0, 44100), (126.0, 48000), (123.0, 48000)])
def test_stretched_kicks_land_on_grid(src_bpm, src_sr):
    """After stretching (and resampling), every kick sits on the library grid within 1 ms."""
    bars = 8
    x = _kick_track(src_bpm, src_sr, bars)
    s = Settings()
    y, sr, _ = stretch.stretch_stem(x, src_sr, src_bpm, s)
    expected_len = round(round(x.shape[0] * sr / src_sr) * stretch.time_factor(src_bpm, s.library_bpm))
    assert abs(y.shape[0] - expected_len) <= 1
    beat = 60.0 / s.library_bpm * sr
    err_ms = onset_errors_ms(y.mean(axis=1), sr, np.arange(bars * 4) * beat)
    # The same measurement on the unstretched source (the kick's own rise time).
    ref_ms = onset_errors_ms(x.mean(axis=1), src_sr, np.arange(bars * 4) * 60.0 / src_bpm * src_sr)
    assert np.max(np.abs(err_ms - ref_ms.mean())) <= 1.0, err_ms - ref_ms.mean()
