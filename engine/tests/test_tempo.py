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


def test_integer_snap_and_filename_bpm():
    tr = Track(123.97, 44100, bars=16)
    tr.pattern(kick, None, FOUR_ON_FLOOR, range(16))
    mono = tr.buf[:, 0].astype(np.float32)
    r = tempo.detect_tempo(mono, 44100, Settings(), source_category="kick")
    assert r.bpm == 124.0 and abs(r.raw_bpm - 123.97) < 0.02
    # A filename BPM within +-1 of the detection wins.
    r = tempo.detect_tempo(mono, 44100, Settings(), source_category="kick",
                           names_for_bpm=["My Track 123.5 BPM.zip"])
    assert r.bpm == 123.5
    # ...but not one that is far away.
    r = tempo.detect_tempo(mono, 44100, Settings(), source_category="kick", names_for_bpm=["Track_128bpm.zip"])
    assert r.bpm == 124.0


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
