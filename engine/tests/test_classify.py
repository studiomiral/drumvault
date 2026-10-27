import pytest

from drumvault_engine import audioutil, classify
from drumvault_engine.config import Thresholds


@pytest.mark.parametrize("name,expected", [
    ("01 Kick.wav", "kick"),
    ("Bass Drum.wav", "kick"),
    ("BassDrum 2.wav", "kick"),
    ("BD.aif", "kick"),
    ("Kik_124.wav", "kick"),
    ("Kicks.wav", "kick"),
    ("03-CLAP.wav", "clap"),
    ("Handclaps.wav", "clap"),
    ("Snare Roll.wav", "snare"),
    ("Rimshot.wav", "snare"),
    ("Closed Hat.wav", "hat_closed"),
    ("CH.flac", "hat_closed"),
    ("HiHat Closed.wav", "hat_closed"),
    ("Open Hat.wav", "hat_open"),
    ("OH 2.wav", "hat_open"),
    ("02_HiHats.wav", "hat"),
    ("Hi-Hat.wav", "hat"),
    ("Ride.wav", "ride"),
    ("Crash Cymbal.wav", "cymbal"),
    ("Tambourine.wav", "shaker"),
    ("Shaker 16ths.wav", "shaker"),
    ("Percussion.wav", "perc"),
    ("Conga Loop.wav", "perc"),
    ("Tom Fill.wav", "perc"),
    ("Top Loop.wav", "top"),
    ("TOPS.wav", "top"),
    ("Groove.wav", "groove"),
    ("Drum Bus.wav", "drums"),
    ("Beat.wav", "drums"),
    ("Loop 3.wav", "drums"),
    ("Synth Loop.wav", "melodic"),
    ("Vocal Loop.wav", "ignore"),
    ("Bassline.wav", "melodic"),
    ("Sub Bass.aif", "melodic"),
    ("Chords.wav", "melodic"),
    ("Pad.flac", "melodic"),
    ("Master.wav", "full_mix"),
    ("Mixdown.wav", "full_mix"),
    ("FX Riser.wav", "ignore"),
    ("Vox Chop.wav", "ignore"),
    ("Reverb Return.wav", "ignore"),
    ("Audio 07.wav", None),
    ("Track 12.wav", None),
    ("Tomorrow.wav", None),          # word boundaries: not a tom
])
def test_filename_rules(name, expected):
    assert classify.match_rules(name) == expected


def test_shared_track_title_is_ignored():
    names = ["Deep Groove - Kick.wav", "Deep Groove - Bass.wav", "Deep Groove - Hats.wav",
             "Deep Groove - Pad.wav"]
    res = classify.match_rules_in_context(names)
    assert res == {"Deep Groove - Kick.wav": "kick", "Deep Groove - Bass.wav": "melodic",
                   "Deep Groove - Hats.wav": "hat", "Deep Groove - Pad.wav": "melodic"}
    # Without context the title would win.
    assert classify.match_rules("Deep Groove - Bass.wav") == "groove"


def test_bass_detection():
    assert classify.is_bass("05 Bassline.wav")
    assert classify.is_bass("Sub Bass.aif")
    assert not classify.is_bass("Chords.wav")


def test_all_fixture_stems_classified(fixtures, extracted):
    th = Thresholds()
    for name, truth in fixtures.truths.items():
        disc = extracted(name)
        files = {disc.rel(p): p for p in disc.files}
        res = classify.classify_stems(sorted(files), lambda n: audioutil.load(files[n]), th)
        for s in truth.stems:
            c = res[s.path]
            assert c.category in [s.category, *s.alt_categories], (name, s.path, c)
            assert c.auto == s.auto, (name, s.path)


def test_silent_stem_is_ignored():
    import numpy as np
    a = audioutil.Audio(np.zeros((44100 * 5, 1), np.float32), 44100)
    assert classify.classify_audio(a, Thresholds()).category == "ignore"
