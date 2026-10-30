import numpy as np
import pytest

from conftest import fixture_names
from make_fixtures import FOUR_ON_FLOOR, TWO_AND_FOUR, Track, clap, kick
from drumvault_engine import audioutil, tempo
from drumvault_engine.config import Settings


def _stem(extracted, fixtures, name, category):
    truth = fixtures.truths[name]
    path = next(s.path for s in truth.stems if s.category == category)
    disc = extracted(name)
    return audioutil.load(disc.root / path), truth


@pytest.mark.parametrize("name", fixture_names())
def test_bpm_and_phase_on_fixtures(name, fixtures, extracted):
    """Acceptance: BPM within +-0.02 of the truth, grid phase correct (bar 1 = sample 0)."""
    a, truth = _stem(extracted, fixtures, name, "kick")
    r = tempo.detect_tempo(a.mono(), a.sr, Settings(), source_stem="kick", source_category="kick")
    assert abs(r.raw_bpm - truth.bpm) <= 0.02
    assert abs(r.bpm - truth.bpm) <= 0.02
    assert r.phase_samples == 0
    assert not r.grid_warning
    assert r.confidence >= 0.95


def test_kick_entering_late_still_has_phase_zero(fixtures, extracted):
    a, truth = _stem(extracted, fixtures, "sunrise", "kick")
    assert truth.kick_start_bar > 0
    r = tempo.detect_tempo(a.mono(), a.sr, Settings(), source_category="kick")
    assert r.phase_samples == 0


@pytest.mark.parametrize("name,category", [("deep_groove", "clap"), ("night_drive", "snare"),
                                           ("night_drive", "drums")])
def test_fallback_sources(name, category, fixtures, extracted):
    a, truth = _stem(extracted, fixtures, name, category)
    r = tempo.detect_tempo(a.mono(), a.sr, Settings(), source_category=category)
    assert abs(r.bpm - truth.bpm) <= 0.02
    assert r.phase_samples == 0
    assert r.confidence < 1.0  # fallbacks are penalised
    assert any("No kick" in w for w in r.warnings)


def _kicks(bpm, bars=16, sr=44100):
    tr = Track(bpm, sr, bars=bars)
    tr.pattern(kick, None, FOUR_ON_FLOOR, range(bars))
    return tr.buf[:, 0].astype(np.float32)


def test_bpm_is_a_whole_number():
    mono = _kicks(123.97)
    r = tempo.detect_tempo(mono, 44100, Settings(), source_category="kick")
    assert r.bpm == 124.0 and abs(r.raw_bpm - 123.97) < 0.02
    assert not r.bpm_warning


def test_far_from_whole_number_is_rounded_and_flagged():
    mono = _kicks(123.4)
    r = tempo.detect_tempo(mono, 44100, Settings(), source_category="kick")
    assert r.bpm == 123.0 and abs(r.raw_bpm - 123.4) < 0.02
    assert r.bpm_warning and any("not a whole number" in w for w in r.warnings)


def test_fractional_bpm_when_integer_mode_is_off():
    mono = _kicks(126.5)
    r = tempo.detect_tempo(mono, 44100, Settings(integer_bpm=False), source_category="kick")
    assert abs(r.bpm - 126.5) <= 0.02 and not r.bpm_warning
    assert r.confidence > 0.95


def test_filename_bpm():
    mono = _kicks(123.6)
    # A filename BPM within +-1 of the detection wins (and settles the rounding).
    r = tempo.detect_tempo(mono, 44100, Settings(), source_category="kick",
                           names_for_bpm=["My Track 123 BPM.zip"])
    assert r.bpm == 123.0 and not r.bpm_warning
    # ...but not one that is far away.
    r = tempo.detect_tempo(mono, 44100, Settings(), source_category="kick", names_for_bpm=["Track_128bpm.zip"])
    assert r.bpm == 124.0 and r.bpm_warning


def test_offset_grid_sets_warning():
    sr, bpm = 44100, 124.0
    tr = Track(bpm, sr, bars=16)
    tr.pattern(kick, None, FOUR_ON_FLOOR, range(16))
    off = int(0.1 * sr)  # stems not exported from bar 1: 100 ms of silence first
    mono = np.concatenate([np.zeros(off), tr.buf[:, 0]]).astype(np.float32)
    r = tempo.detect_tempo(mono, sr, Settings(), source_category="kick")
    assert r.grid_warning
    assert abs(r.phase_samples - off) <= sr * 0.001
    assert r.confidence > 0.95


def test_overrides():
    tr = Track(124.0, 44100, bars=8)
    tr.pattern(kick, None, FOUR_ON_FLOOR, range(8))
    mono = tr.buf[:, 0].astype(np.float32)
    r = tempo.detect_tempo(mono, 44100, Settings(), source_category="kick", bpm_override=125.0,
                           grid_offset_ms=20.0)
    assert r.bpm == 125.0
    assert r.phase_samples == round(0.02 * 44100)


def test_rough_bpm_locks_to_beat_for_two_and_four():
    tr = Track(126.0, 44100, bars=16)
    rng = np.random.default_rng(0)
    tr.pattern(clap, rng, TWO_AND_FOUR, range(16))
    mono = tr.buf[:, 0].astype(np.float32)
    r = tempo.detect_tempo(mono, 44100, Settings(), source_category="clap")
    assert abs(r.bpm - 126.0) <= 0.02


def test_pick_source_order():
    assert tempo.pick_source({"a": "melodic", "b": "kick", "c": "drums"}) == ("kick", ["b"])
    assert tempo.pick_source({"a": "melodic", "c": "drums"}) == ("drums", ["c"])
    assert tempo.pick_source({"a": "snare", "b": "melodic"}) == ("snare", ["a"])
    assert tempo.pick_source({"a": "full_mix", "b": "melodic"}) == ("full_mix", ["a"])
    assert tempo.pick_source({"a": "melodic", "b": "top"}) == ("sum", ["a", "b"])


def test_filename_bpm_regex():
    assert tempo.filename_bpms(["Track 124bpm.zip", "Kick_126.5 BPM.wav", "Hat.wav"]) == [124.0, 126.5]


def test_too_few_onsets():
    r = tempo.detect_tempo(np.zeros(44100 * 4, np.float32), 44100, Settings(), source_category="kick")
    assert r.confidence == 0.0 and r.grid_warning


def _late_kick_zip(kick_ms: float, clap_ms: float, sr: int = 44100, bpm: float = 124.0):
    """Kick and clap stems exported from bar 1, each shifted by its own delay."""
    def stem(sound, pattern, delay_ms):
        tr = Track(bpm, sr, bars=16)
        tr.pattern(sound, np.random.default_rng(1), pattern, range(16))
        d = int(delay_ms / 1000 * sr)
        return np.concatenate([np.zeros(d), tr.buf[:, 0]])[:len(tr.buf)].astype(np.float32)
    return stem(kick, FOUR_ON_FLOOR, kick_ms), stem(clap, TWO_AND_FOUR, clap_ms)


def test_late_kick_keeps_bar_one_when_the_other_drums_are_on_the_grid():
    """A kick that hits 24 ms late must not move bar 1: the claps say the export starts at 0."""
    sr, s = 44100, Settings()
    k, c = _late_kick_zip(24, 0)
    r = tempo.detect_tempo(k, sr, s, source_category="kick")
    assert r.grid_warning
    off = tempo.stem_grid_offset(c, sr, "clap", r.bpm, s)
    assert abs(off) < 0.003
    kept = tempo.keep_bar_one(r, [off], s.thresholds)
    assert kept.phase_samples == 0 and not kept.grid_warning
    assert any("24 ms after the grid" in w for w in kept.warnings)
    assert not any(w.startswith("Grid does not start") for w in kept.warnings)


def test_whole_export_offset_still_moves_bar_one():
    """Every stem 40 ms late (not exported from bar 1): the grid follows the kick."""
    sr, s = 44100, Settings()
    k, c = _late_kick_zip(40, 40)
    r = tempo.detect_tempo(k, sr, s, source_category="kick")
    off = tempo.stem_grid_offset(c, sr, "clap", r.bpm, s)
    kept = tempo.keep_bar_one(r, [off], s.thresholds)
    assert kept.grid_warning and kept.phase_samples == r.phase_samples
    assert abs(kept.phase_samples - 0.040 * sr) <= sr * 0.002


def test_negative_manual_offset_starts_the_grid_a_bar_later():
    """Hits ahead of sample-0's downbeat (set by hand in the Grid view) must not cut before 0."""
    tr = Track(124.0, 44100, bars=8)
    tr.pattern(kick, None, FOUR_ON_FLOOR, range(8))
    mono = tr.buf[:, 0].astype(np.float32)
    r = tempo.detect_tempo(mono, 44100, Settings(), source_category="kick", grid_offset_ms=-12.0)
    bar = 4 * 60.0 / 124.0
    assert r.phase_samples == round((bar - 0.012) * 44100)
    assert not r.grid_warning
