import numpy as np
import pytest

from conftest import fixture_names
from make_fixtures import PROGRESSIONS, Track, chords
from drumvault_engine import audioutil, classify, key
from drumvault_engine.config import Thresholds

TH = Thresholds()


def _key_mix(fixtures, extracted, name):
    truth = fixtures.truths[name]
    disc = extracted(name)
    stems = []
    for s in truth.stems:
        if s.category == "melodic":
            a = audioutil.load(disc.root / s.path)
            stems.append((a.mono(), a.sr, classify.is_bass(s.path)))
    return key.mix_for_key(stems, TH), truth


@pytest.mark.parametrize("name", fixture_names())
def test_key_on_fixtures_essentia(name, fixtures, extracted):
    """Acceptance: the key is correct on all fixtures."""
    if not key.essentia_available():
        pytest.skip("essentia not installed")
    (mix, sr), truth = _key_mix(fixtures, extracted, name)
    r = key.detect_key_audio(mix, sr, TH, backend="essentia")
    assert r.label == truth.key
    assert r.camelot == truth.camelot
    assert not r.uncertain


@pytest.mark.parametrize("name", fixture_names())
def test_key_on_fixtures_fallback(name, fixtures, extracted):
    (mix, sr), truth = _key_mix(fixtures, extracted, name)
    r = key.detect_key_audio(mix, sr, TH, backend="fallback")
    assert r.backend == "fallback"
    assert r.label == truth.key


@pytest.mark.parametrize("label,camelot", [
    ("Am", "8A"), ("C", "8B"), ("Em", "9A"), ("G", "9B"), ("Fm", "4A"), ("Ab", "4B"), ("D", "10B"),
    ("Bm", "10A"), ("B", "1B"), ("Abm", "1A"), ("F#", "2B"), ("C#m", "12A"), ("E", "12B"),
])
def test_camelot(label, camelot):
    pc, scale = key.parse_label(label)
    assert key.camelot(pc, scale) == camelot
    assert key.make_label(pc, scale) == label


def test_parse_label_variants():
    assert key.parse_label("F minor") == (5, "minor")
    assert key.parse_label("Gbmin") == (6, "minor")
    assert key.parse_label("Bb major") == (10, "major")
    assert key.parse_label("db") == (1, "major")
    with pytest.raises(ValueError):
        key.parse_label("H#m")


def test_override_and_nokey():
    r = key.override_result("Fm", TH)
    assert (r.label, r.camelot, r.uncertain, r.backend) == ("Fm", "4A", False, "override")
    n = key.no_key()
    assert n.label is None and n.file_label == "NoKey"


def test_bass_weighting_and_resampling():
    tr = Track(124, 48000, bars=4)
    chords(tr, "Am")
    mono = tr.buf[:, 0].astype(np.float32)
    mix, sr = key.mix_for_key([(mono, 48000, False), (mono[:1000], 48000, True)], TH)
    assert sr == TH.key_analysis_sr
    assert abs(len(mix) - len(mono) * sr / 48000) <= 2
    assert np.max(np.abs(mix)) == pytest.approx(1.0)


def test_full_mix_key(fixtures):
    """A plain chord track (as a full mix stand-in) is detected in the fallback too."""
    tr = Track(124, 44100, bars=8)
    chords(tr, "D")
    r = key.detect_key_audio(tr.buf[:, 0].astype(np.float32), 44100, TH, backend="fallback",
                             source="full_mix")
    assert r.label == "D" and r.source == "full_mix"
    assert PROGRESSIONS["D"][0][0] % 12 == 2
