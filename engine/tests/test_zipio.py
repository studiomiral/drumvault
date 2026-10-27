import io
import zipfile

import numpy as np
import soundfile as sf

from drumvault_engine import zipio


def _wav_bytes(seconds=0.1, sr=44100):
    bio = io.BytesIO()
    sf.write(bio, np.zeros(int(seconds * sr), np.float32), sr, format="WAV")
    return bio.getvalue()


def test_fixture_stems_discovered_and_junk_ignored(fixtures, extracted):
    for name, truth in fixtures.truths.items():
        disc = extracted(name)
        found = sorted(disc.rel(p) for p in disc.files)
        assert found == sorted(s.path for s in truth.stems), name
        for junk in truth.junk:
            assert junk not in found


def test_nested_zip_is_extracted_one_level(extracted):
    disc = extracted("night_drive")
    names = {disc.rel(p) for p in disc.files}
    assert {"Extras.zip/Perc Conga.wav", "Extras.zip/Ride.wav"} <= names


def test_unsupported_audio_warns(fixtures, extracted):
    disc = extracted("night_drive")
    assert any("Night Drive - Lead.mp3" in w and "unsupported" in w.lower() for w in disc.warnings)
    assert not extracted("deep_groove").warnings  # readme.txt / .DS_Store are silent


def test_fixture_audio_properties(fixtures, extracted):
    for name, truth in fixtures.truths.items():
        disc = extracted(name)
        rates = {s.path: s.sample_rate or truth.sample_rate for s in truth.stems}
        for p in disc.files:
            info = sf.info(str(p))
            assert info.samplerate == rates[disc.rel(p)]
            bar_s = 60 / truth.bpm * 4
            assert abs(info.duration - (truth.bars + 1) * bar_s) < 0.01


def test_is_junk():
    assert zipio.is_junk("__MACOSX/foo/._Kick.wav")
    assert zipio.is_junk("Stems/._Kick.wav")
    assert zipio.is_junk("Stems/.DS_Store")
    assert zipio.is_junk(".hidden/kick.wav")
    assert not zipio.is_junk("Stems/Kick.wav")


def test_zip_slip_is_refused(tmp_path):
    z = tmp_path / "evil.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("../escape.wav", _wav_bytes())
        zf.writestr("ok/Kick.wav", _wav_bytes())
    disc = zipio.extract_zip(z, tmp_path / "out")
    assert not (tmp_path / "escape.wav").exists()
    assert [disc.rel(p) for p in disc.files] == ["ok/Kick.wav"]


def test_deeper_nested_zip_is_ignored_with_warning(tmp_path):
    inner2 = io.BytesIO()
    with zipfile.ZipFile(inner2, "w") as zf:
        zf.writestr("Deep.wav", _wav_bytes())
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as zf:
        zf.writestr("Hat.wav", _wav_bytes())
        zf.writestr("More.zip", inner2.getvalue())
    z = tmp_path / "outer.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("Kick.wav", _wav_bytes())
        zf.writestr("Inner.zip", inner.getvalue())
    disc = zipio.extract_zip(z, tmp_path / "out")
    assert sorted(disc.rel(p) for p in disc.files) == ["Inner.zip/Hat.wav", "Kick.wav"]
    assert any("More.zip" in w for w in disc.warnings)


def test_sha1_is_stable(fixtures):
    p = fixtures.zip("deep_groove")
    assert zipio.sha1_file(p) == zipio.sha1_file(p)
    assert len(zipio.sha1_file(p)) == 40


def test_stem_length_warning():
    bar = 60 / 124 * 4
    assert zipio.stem_length_warning({"a": 60.0, "b": 60.0 - 0.5 * bar}, 124, 1.0) is None
    w = zipio.stem_length_warning({"a": 60.0, "b": 60.0 - 1.5 * bar}, 124, 1.0)
    assert w and "b" in w
