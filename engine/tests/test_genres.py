"""Genres: every source belongs to one, set on import; everything from before genres is house."""

import sqlite3
from pathlib import Path

import mido
import numpy as np
import soundfile as sf

from drumvault_engine import hits, pipeline, references
from drumvault_engine.config import Settings
from drumvault_engine.db import LibraryDB

SR = 44100


def hit(path: Path, hz: float) -> Path:
    t = np.arange(int(0.6 * SR)) / SR
    x = np.concatenate([np.zeros(SR // 10), np.sin(2 * np.pi * hz * t) * np.exp(-t / 0.15), np.zeros(SR // 2)])
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.stack([x, x], axis=1) * 0.5, SR, subtype="PCM_24")
    return path


def bassline(path: Path) -> Path:
    mf = mido.MidiFile(ticks_per_beat=480)
    tr = mido.MidiTrack()
    mf.tracks.append(tr)
    for i in range(8):
        tr.append(mido.Message("note_on", note=41 + (i % 2) * 7, velocity=100, time=0 if i == 0 else 240))
        tr.append(mido.Message("note_off", note=41 + (i % 2) * 7, velocity=0, time=240))
    path.parent.mkdir(parents=True, exist_ok=True)
    mf.save(str(path))
    return path


def genres(lib: Path, table: str) -> list[str]:
    conn = sqlite3.connect(lib / ".drumvault" / "library.sqlite")
    try:
        return [g for (g,) in conn.execute(f"SELECT genre FROM {table} ORDER BY id")]
    finally:
        conn.close()


def test_a_library_from_before_genres_is_all_house(tmp_path):
    lib = tmp_path / "lib"
    path = lib / ".drumvault" / "library.sqlite"
    path.parent.mkdir(parents=True)
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE zips (id INTEGER PRIMARY KEY, source_code TEXT UNIQUE, file_name TEXT, file_sha1 TEXT UNIQUE, status TEXT)")
    conn.execute("CREATE TABLE midi_files (id INTEGER PRIMARY KEY, file_name TEXT, rel_path TEXT UNIQUE, file_sha1 TEXT UNIQUE, notes TEXT)")
    conn.execute("CREATE TABLE hits (id INTEGER PRIMARY KEY, file_name TEXT, rel_path TEXT UNIQUE, file_sha1 TEXT UNIQUE)")
    conn.execute("INSERT INTO zips (source_code, file_name, status) VALUES ('S0001', 'Track.zip', 'done')")
    conn.execute("INSERT INTO midi_files (file_name, rel_path, notes) VALUES ('Bass.mid', 'MIDI/Bass/bass.mid', '[]')")
    conn.execute("INSERT INTO hits (file_name, rel_path) VALUES ('Stab.wav', 'Chord Stabs/stab.wav')")
    conn.commit()
    conn.close()
    with LibraryDB(lib):
        pass
    assert [genres(lib, t) for t in ("zips", "midi_files", "hits")] == [["house"], ["house"], ["house"]]


def test_imports_take_the_active_genre(tmp_path):
    lib = tmp_path / "lib"
    house, organic = Settings(library_path=str(lib)), Settings(library_path=str(lib), genre="organic")
    hits.import_hits(house, [str(hit(tmp_path / "src" / "Brass Hit F.wav", 349.2))])
    hits.import_hits(organic, [str(hit(tmp_path / "src" / "Marimba Hit A.wav", 440.0))], kind="stab")
    assert genres(lib, "hits") == ["house", "organic"]
    pipeline.import_midi(organic, [str(bassline(tmp_path / "src" / "Saw Bass Fm.mid"))])
    pipeline.save_midi(house, "Edited", [[0, 0.5, 41, 100]], 1, "Fm")
    assert genres(lib, "midi_files") == ["organic", "house"]
    [pack] = pipeline.import_samples(organic, [str(hit(tmp_path / "Kit" / "Shaker 01.wav", 5000.0))])
    with LibraryDB(lib) as db:
        assert db.get_zip(pack.zip_id)["genre"] == "organic"


def test_a_reference_is_of_its_folders_genre():
    assert references.genre_of("Track.wav") == "house"
    assert references.genre_of("House/Track.wav") == "house"
    assert references.genre_of("Organic/Track.wav") == "organic"
    assert references.genre_of("organic/deep/Track.wav") == "organic"
    assert references.genre_of("Organic.wav") == "house"


def test_the_genre_changes_nothing_about_processing():
    assert Settings(genre="organic").processing_hash() == Settings().processing_hash()
    assert Settings.from_dict({"genre": "polka"}).genre == "house"
    assert Settings.from_dict({"genre": "organic"}).genre == "organic"
