import numpy as np
import pytest

from drumvault_engine import audioutil, naming, normalize, peaks
from drumvault_engine.config import Settings, Thresholds
from drumvault_engine.db import LibraryDB, match_key


def test_slugify():
    assert naming.slugify("Deep Groove.zip") == "deep-groove"
    assert naming.slugify("Deep Groove (Original Mix) Stems.zip") == "deep-groove-original"
    assert naming.slugify("Night Drive 122 BPM.zip") == "night-drive"
    assert naming.slugify("Café del Mär — Edit.zip") == "cafe-del-mar-edit"
    assert naming.slugify("!!!.zip") == "untitled"
    assert len(naming.slugify("x" * 50)) <= 20


def test_filenames():
    tag = naming.source_tag(naming.source_code(37), "deep-groove")
    assert naming.oneshot_rel_path("kick", "Am", tag, 1) == "One-Shots/Kicks/OS_Kick_Am_S0037-deep-groove_01.wav"
    assert naming.loop_rel_path("top", 124.0, "Am", tag, 4, 3) == "Loops/Tops/LP_Top_124_Am_S0037-deep-groove_4bar_03.wav"
    assert naming.loop_rel_path("clap", 124.5, "NoKey", tag, 2, 1).startswith("Loops/Snares-Claps/LP_Clap_124.5_NoKey_")
    assert naming.oneshot_rel_path("hat_open", "F#m", tag, 2).startswith("One-Shots/Hats-Open/OS_HatOpen_F#m_")


def test_peak_normalize():
    x = np.array([[0.5, -0.25]], np.float32).repeat(10, 0)
    y, pk, gain = normalize.peak_normalize(x, -1.0)
    assert pk == pytest.approx(-6.0206, abs=1e-3)
    assert gain == pytest.approx(5.0206, abs=1e-3)
    assert np.max(np.abs(y)) == pytest.approx(10 ** (-1 / 20), abs=1e-6)
    z, pk, gain = normalize.peak_normalize(np.zeros((5, 1), np.float32), -1.0)
    assert gain == 0.0


def test_loudness_normalize_respects_ceiling():
    sr = 44100
    t = np.arange(sr * 2) / sr
    x = (0.01 * np.sin(2 * np.pi * 440 * t))[:, None].astype(np.float32)
    y, pk, gain = normalize.loudness_normalize(x, sr, -14.0, -1.0)
    assert np.max(np.abs(y)) <= 10 ** (-1 / 20) + 1e-6
    loud = np.repeat(x * 50, 2, 1)
    y, pk, gain = normalize.loudness_normalize(loud, sr, -30.0, -1.0)
    assert gain < 0


def test_peaks():
    x = np.sin(np.linspace(0, 20 * np.pi, 44100))[:, None].astype(np.float32)
    p = peaks.peaks_for(x, 44100, "oneshot", None, Thresholds())
    assert len(p["points"]) == 200
    assert max(hi for _, hi in p["points"]) == pytest.approx(1.0, abs=1e-3)
    p = peaks.peaks_for(x, 44100, "loop", 2, Thresholds())
    assert len(p["points"]) == 2048


def test_settings_roundtrip():
    s = Settings(library_bpm=126.0)
    s.thresholds.tempo_phase_tolerance_ms = 7.0
    d = s.to_dict()
    s2 = Settings.from_dict({**d, "unknown_key": 1})
    assert s2.library_bpm == 126.0 and s2.thresholds.tempo_phase_tolerance_ms == 7.0
    assert s2.processing_hash() == s.processing_hash()
    s2.library_path = "/elsewhere"
    assert s2.processing_hash() == s.processing_hash()
    s2.library_bpm = 125.0
    assert s2.processing_hash() != s.processing_hash()
    assert Settings().loop_lengths_for("kick") == [] and Settings().loop_lengths_for("top") == [2, 4, 8]


def test_db_source_codes_and_cascade(tmp_path):
    with LibraryDB(tmp_path) as db:
        assert db.next_source_number() == 1
        zid = db.insert_zip(source_code="S0001", file_name="a.zip", file_sha1="x", status="done")
        db.insert_zip(source_code="S0009", file_name="b.zip", file_sha1="y", status="done")
        assert db.next_source_number() == 10
        with db.transaction():
            sid = db.insert_stem(zip_id=zid, file_name="Kick.wav", category="kick", used_for=["tempo"])
            db.insert_sample(zip_id=zid, stem_id=sid, kind="oneshot", category="kick", rel_path="a.wav",
                             source_offset_s=1.234, favorite=1)
        meta = db.user_meta(zid)
        assert meta[match_key("Kick.wav", "oneshot", None, 1.2341)]["favorite"] == 1
        db.delete_zip_rows(zid)
        assert not db.all_samples() and not db.stems_for_zip(zid)


def test_db_transaction_rolls_back(tmp_path):
    with LibraryDB(tmp_path) as db:
        zid = db.insert_zip(source_code="S0001", file_name="a.zip", file_sha1="x")
        with pytest.raises(RuntimeError):
            with db.transaction():
                db.insert_stem(zip_id=zid, file_name="Kick.wav")
                raise RuntimeError
        assert not db.stems_for_zip(zid)


def test_attack_sample():
    env = np.concatenate([np.zeros(100), np.linspace(0, 1, 10), np.linspace(1, 0.2, 100)])
    att, pk = audioutil.attack_sample(env, 50, 300, 0.1)
    assert att == 101 and pk == 109
    tail = np.concatenate([np.linspace(0.5, 0.3, 100), np.linspace(0.3, 1.0, 5), np.linspace(1, 0.2, 50)])
    att, pk = audioutil.attack_sample(tail, 0, len(tail), 0.1)
    assert att == 99  # trough between the previous tail and the new hit


def test_fingerprint_is_level_invariant():
    rng = np.random.default_rng(0)
    x = rng.standard_normal(22050).astype(np.float32) * np.exp(-np.arange(22050) / 2000)
    th = Thresholds()
    a = audioutil.logmel_fingerprint(x, 22050, th, n_frames=13)
    b = audioutil.logmel_fingerprint(0.1 * x, 22050, th, n_frames=13)
    assert audioutil.cosine(a, b) == pytest.approx(1.0, abs=1e-5)
    assert np.linalg.norm(a) == pytest.approx(1.0, abs=1e-5)
