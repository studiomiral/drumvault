"""Disco hits (SCOPE.md §6.8): import, key from the name or the sound, corrections, removal."""

import sqlite3
import zipfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from drumvault_engine import hits
from drumvault_engine.config import Settings

from make_fixtures import midi_hz, tone

SR = 44100


def stab(pitches: list[int], seconds: float = 1.2, lead: float = 0.3, sr: int = SR) -> np.ndarray:
    """A chord stab after `lead` seconds of silence, ringing out, then silence."""
    body = sum(tone(sr, midi_hz(p), seconds, 6, 0.004, seconds * 0.9, 1.3) for p in pitches) / len(pitches)
    body *= np.exp(-np.arange(len(body)) / (0.35 * sr))
    x = np.concatenate([np.zeros(int(lead * sr)), body, np.zeros(sr)])
    return np.stack([x, x * 0.9], axis=1) * 0.5


def write(path: Path, data: np.ndarray, sr: int = SR) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), data, sr, subtype="PCM_24")
    return path


def settings(tmp_path: Path) -> Settings:
    return Settings(library_path=str(tmp_path / "lib"))


def rows(s: Settings) -> list[sqlite3.Row]:
    conn = sqlite3.connect(Path(s.library_path) / ".drumvault" / "library.sqlite")
    conn.row_factory = sqlite3.Row
    return conn.execute("SELECT * FROM hits ORDER BY id").fetchall()


C_MINOR = [60, 63, 67]
F_MAJOR = [65, 69, 72]


def test_imports_trims_and_reads_the_key(tmp_path):
    s = settings(tmp_path)
    src = tmp_path / "drop"
    write(src / "Brass Stab Cm.wav", stab(C_MINOR))
    write(src / "Disco_Hit_F_02.wav", stab(F_MAJOR))
    write(src / "Orchestra Hit.wav", stab(F_MAJOR, seconds=1.0))   # other audio: the same bytes count as in
    r = hits.import_hits(s, [str(src)])
    assert len(r["imported"]) == 3 and not r["failed"]
    by = {x["file_name"]: x for x in rows(s)}
    assert (by["Brass Stab Cm.wav"]["key_label"], by["Brass Stab Cm.wav"]["key_source"]) == ("Cm", "name")
    # A bare note: the root from the name, major unless the sound says minor on it.
    assert (by["Disco_Hit_F_02.wav"]["key_label"], by["Disco_Hit_F_02.wav"]["key_source"]) == ("F", "name")
    # No key in the name: from the sound.
    assert by["Orchestra Hit.wav"]["key_source"] == "detected"
    assert by["Orchestra Hit.wav"]["key_label"] in ("F", "Dm")
    for row in by.values():
        assert row["rel_path"].startswith("Disco Hits/")
        data, sr = sf.read(str(Path(s.library_path) / row["rel_path"]), always_2d=True)
        assert sr == s.output_sample_rate
        # The silence before the attack and after the tail is gone; peak-normalised.
        assert np.max(np.abs(data[:20])) > 0.01
        assert len(data) / sr < 1.2 + 0.3
        assert 20 * np.log10(np.max(np.abs(data))) == pytest.approx(s.thresholds.hit_peak_dbfs, abs=0.1)
        assert row["pitch_fix"] == 0


def test_skips_what_is_in_and_reads_zips(tmp_path):
    s = settings(tmp_path)
    f = write(tmp_path / "Stab Am.wav", stab([57, 60, 64]))
    assert len(hits.import_hits(s, [str(f)])["imported"]) == 1
    z = tmp_path / "hits.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.write(f, "Pack/Stab Am.wav")
        zf.writestr("Pack/Horn Bb.wav", b"")
        write(tmp_path / "Horn Bbmaj.wav", stab([58, 62, 65]))
        zf.write(tmp_path / "Horn Bbmaj.wav", "Pack/Horn Bbmaj.wav")
        zf.writestr("__MACOSX/._Horn.wav", b"junk")
    r = hits.import_hits(s, [str(z)])
    assert r["skipped"] == 1
    assert [x["file_name"] for x in r["imported"]] == ["Horn Bbmaj.wav"]
    assert len(r["failed"]) == 1          # the empty file
    assert rows(s)[-1]["key_label"] == "Bb"
    with pytest.raises(hits.HitError):
        hits.import_hits(s, [str(tmp_path / "nothing.txt")])


def test_key_and_pitch_corrections_and_removal(tmp_path):
    s = settings(tmp_path)
    f = write(tmp_path / "Stab Cm.wav", stab(C_MINOR))
    hid = hits.import_hits(s, [str(f)])["imported"][0]["id"]
    hits.set_hit_meta(s, hid, pitch_fix=-3)
    assert rows(s)[0]["pitch_fix"] == -3
    hits.set_hit_meta(s, hid, key_label="Dm")
    row = rows(s)[0]
    assert (row["key_label"], row["key_camelot"], row["key_source"], row["pitch_fix"]) == ("Dm", "7A", "manual", -3)
    hits.set_hit_meta(s, hid, clear_key=True)
    assert rows(s)[0]["key_label"] is None
    path = Path(s.library_path) / rows(s)[0]["rel_path"]
    assert path.exists()
    assert hits.delete_hits(s, [hid]) == {"deleted": 1}
    assert not path.exists() and not rows(s)
    with pytest.raises(hits.HitError):
        hits.set_hit_meta(s, hid, pitch_fix=1)


def test_chord_stabs_import_into_their_own_folder(tmp_path):
    s = settings(tmp_path)
    src = tmp_path / "drop"
    write(src / "Organ Stab Cm.wav", stab(C_MINOR, seconds=0.5))
    write(src / "Brass Hit F.wav", stab(F_MAJOR))
    r = hits.import_hits(s, [str(src / "Organ Stab Cm.wav")], kind="stab")
    assert [x["kind"] for x in r["imported"]] == ["stab"]
    hits.import_hits(s, [str(src / "Brass Hit F.wav")])
    by = {x["file_name"]: x for x in rows(s)}
    assert (by["Organ Stab Cm.wav"]["kind"], by["Organ Stab Cm.wav"]["key_label"]) == ("stab", "Cm")
    assert by["Organ Stab Cm.wav"]["rel_path"].startswith("Chord Stabs/")
    assert (by["Brass Hit F.wav"]["kind"], by["Brass Hit F.wav"]["rel_path"].split("/")[0]) == ("disco", "Disco Hits")
    assert (Path(s.library_path) / by["Organ Stab Cm.wav"]["rel_path"]).exists()
    # The same file on the other page is already in.
    assert hits.import_hits(s, [str(src / "Organ Stab Cm.wav")])["skipped"] == 1
    with pytest.raises(hits.HitError):
        hits.import_hits(s, [str(src)], kind="pads")


def test_hits_from_before_chord_stabs_are_disco_hits(tmp_path):
    s = settings(tmp_path)
    db = Path(s.library_path) / ".drumvault" / "library.sqlite"
    db.parent.mkdir(parents=True)
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE hits (id INTEGER PRIMARY KEY, file_name TEXT, rel_path TEXT UNIQUE, original_path TEXT, "
                 "file_sha1 TEXT UNIQUE, key_label TEXT, key_camelot TEXT, key_source TEXT, pitch_fix INTEGER DEFAULT 0, "
                 "duration_s REAL, sample_rate INTEGER, channels INTEGER, peak_db REAL, created_at TEXT)")
    conn.execute("INSERT INTO hits (file_name, rel_path) VALUES ('Old.wav', 'Disco Hits/old.wav')")
    conn.commit()
    conn.close()
    from drumvault_engine.db import LibraryDB
    with LibraryDB(s.library_path):
        pass
    assert [x["kind"] for x in rows(s)] == ["disco"]
