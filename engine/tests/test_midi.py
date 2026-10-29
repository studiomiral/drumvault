"""MIDI import and Serum 2 bass rendering (SCOPE.md §6.7)."""

import json
import sqlite3
from pathlib import Path

import mido
import numpy as np
import pytest
import soundfile as sf

from drumvault_engine import midi as midimod, pipeline, serum
from drumvault_engine.config import Settings, Thresholds

SERUM = Path(Settings().serum_plugin)
FACTORY_BASS = Path("/Library/Audio/Presets/Xfer Records/Serum 2 Presets/Presets/Factory/Bass")


def write_midi(path: Path, notes: list[tuple[float, float, int]], tpb: int = 480) -> Path:
    """notes: (start beats, length beats, pitch) on one track."""
    mf = mido.MidiFile(ticks_per_beat=tpb)
    tr = mido.MidiTrack()
    mf.tracks.append(tr)
    ev = []
    for s, l, p in notes:
        ev += [(round(s * tpb), mido.Message("note_on", note=p, velocity=100)),
               (round((s + l) * tpb), mido.Message("note_off", note=p, velocity=0))]
    t = 0
    for tick, msg in sorted(ev, key=lambda e: (e[0], e[1].type == "note_on")):
        tr.append(msg.copy(time=tick - t))
        t = tick
    path.parent.mkdir(parents=True, exist_ok=True)
    mf.save(str(path))
    return path


def f_minor_bass(bars: int = 2) -> list[tuple[float, float, int]]:
    # F1, Ab1, C2, Eb2 on offbeats, mostly F: a rolling F minor bassline.
    pitches = [29, 29, 32, 29, 36, 29, 27, 29]
    return [(b * 4 + i * 0.5 + 0.25, 0.25, pitches[i]) for b in range(bars) for i in range(8)]


def test_analyze_reads_bars_key_and_role(tmp_path):
    th = Thresholds()
    a = midimod.analyze(write_midi(tmp_path / "Rolling Bass Fmin 124.mid", f_minor_bass(2)), th)
    assert (a.bars, a.key_label, a.key_camelot, a.role) == (2, "Fm", "4A", "bass")
    assert a.notes[0].start == pytest.approx(0.25) and a.notes[0].length == pytest.approx(0.25)
    # No key in the name: found from the notes; a 3-bar part becomes 4 bars.
    b = midimod.analyze(write_midi(tmp_path / "groove_01.mid", f_minor_bass(3)), th)
    assert b.key_label == "Fm" and b.bars == 4 and b.role == "bass"
    # A bare note name: the tonic from the name, the scale from the notes.
    c = midimod.analyze(write_midi(tmp_path / "Line_F_124.mid", f_minor_bass(1)), th)
    assert c.key_label == "Fm"
    hi = [(i * 1.0, 0.9, 72 + (i % 3) * 4) for i in range(8)]
    assert midimod.analyze(write_midi(tmp_path / "Chords Am.mid", hi), th).role == "keys"
    assert midimod.guess_role("Organ.mid", [], th) == "keys" and midimod.guess_role("Synth Bass.mid", [], th) == "bass"


def test_transpose_to_track_key():
    assert midimod.transpose_to("Am", "Fm") == -4
    assert midimod.transpose_to("Fm", "Am") == 4
    assert midimod.transpose_to("C", "Am") == 0       # relative major → minor
    assert midimod.transpose_to("Am", "Am") == 0
    assert midimod.transpose_to(None, "Fm") == 0


def test_import_midi_copies_indexes_and_skips_duplicates(tmp_path):
    lib = tmp_path / "lib"
    s = Settings(library_path=str(lib))
    src = tmp_path / "pack"
    write_midi(src / "Bass A.mid", f_minor_bass(2))
    write_midi(src / "sub" / "Deep Sub Gm.mid", [(0, 1, 31), (2, 1, 34)])
    (src / "notes.txt").write_text("not midi")
    r = pipeline.import_midi(s, [str(src)])
    assert len(r["imported"]) == 2 and not r["failed"]   # both are basslines
    rows = sqlite3.connect(lib / ".drumvault" / "library.sqlite").execute(
        "SELECT rel_path, role, bars, key_label, notes FROM midi_files ORDER BY id").fetchall()
    assert all((lib / rel).exists() and rel.startswith("MIDI/Bass/") for rel, *_ in rows)
    assert rows[1][3] == "Gm" and json.loads(rows[1][4])[0] == [0.0, 1.0, 31, 100]
    again = pipeline.import_midi(s, [str(src)])
    assert again["skipped"] == 2 and not again["imported"]


def test_preset_state_container_roundtrip():
    blob = bytes(range(256)) * 3 + b"xyz"
    assert serum.juce_b64_decode(serum.juce_b64_encode(blob)) == blob
    meta = {"a": 1}
    assert serum.read_xfer(serum.write_xfer(meta, b"\x01\x02")) == (meta, b"\x01\x02")


@pytest.mark.skipif(not SERUM.exists() or not FACTORY_BASS.exists(), reason="Serum 2 not installed")
def test_render_bass_through_serum_presets(tmp_path):
    lib = tmp_path / "lib"
    s = Settings(library_path=str(lib))
    write_midi(tmp_path / "Bass Fm.mid", f_minor_bass(2))
    mid = pipeline.import_midi(s, [str(tmp_path / "Bass Fm.mid")])["imported"][0]["id"]
    presets = sorted(FACTORY_BASS.rglob("*.SerumPreset"))
    a = pipeline.render_bass(s, str(presets[1]), mid, 0, 124, ".drumvault/bass/a.wav")
    b = pipeline.render_bass(s, str(presets[30]), mid, 0, 124, ".drumvault/bass/b.wav")
    ya, sr = sf.read(lib / a["path"], always_2d=True)
    yb, _ = sf.read(lib / b["path"], always_2d=True)
    assert ya.shape[0] == round(2 * 4 * 60 / 124 * sr)          # exactly 2 bars: a seamless loop
    assert np.abs(ya).max() > 0.05 and np.abs(ya - yb).mean() > 1e-3  # sound, and the presets differ
    assert pipeline.render_bass(s, str(presets[1]), mid, 0, 124, ".drumvault/bass/a.wav")["cached"]
    up = pipeline.render_bass(s, str(presets[1]), mid, 5, 124, ".drumvault/bass/a5.wav")
    assert not up["cached"]
    with pytest.raises(pipeline.PipelineError):
        pipeline.render_bass(s, str(presets[1]), mid, 0, 124, "../evil.wav")


def test_a_generated_bassline_renders_from_its_notes(tmp_path):
    # The app writes basslines itself (bassline.ts): no MIDI file, id < 1, notes and bars sent along.
    s = Settings(library_path=str(tmp_path / "lib"))
    with pytest.raises(pipeline.PipelineError, match="needs its notes"):
        pipeline.render_bass(s, "/nope.SerumPreset", -7, 0, 124, ".drumvault/bass/g.wav")
    with pytest.raises(pipeline.PipelineError, match="preset not found"):  # past the MIDI lookup
        pipeline.render_bass(s, "/nope.SerumPreset", -7, 0, 124, ".drumvault/bass/g.wav", notes=[[0, 1, 41, 100]], bars=1)
    if SERUM.exists() and FACTORY_BASS.exists():
        preset = sorted(FACTORY_BASS.rglob("*.SerumPreset"))[1]
        r = pipeline.render_bass(s, str(preset), -7, 0, 124, ".drumvault/bass/g.wav", notes=[[0, 0.5, 41, 100], [0.75, 0.5, 53, 100]], bars=1)
        y, sr = sf.read(tmp_path / "lib" / r["path"], always_2d=True)
        assert y.shape[0] == round(4 * 60 / 124 * sr) and np.abs(y).max() > 0.05


# Two presets where the second's unlisted settings used to carry over into the first (organ went dark).
ORGAN = Path("/Library/Audio/Presets/Xfer Records/Serum 2 Presets/Presets/House - Bass/VOX_MDTH2_Bass_go_organ.SerumPreset")
RESONANCE = ORGAN.with_name("FSS_S2MHEV5_Bass_Resonance.SerumPreset")


@pytest.mark.skipif(not SERUM.exists() or not ORGAN.exists() or not RESONANCE.exists(), reason="Serum 2 or the presets not installed")
def test_a_preset_sounds_the_same_after_another_one(tmp_path):
    # A preset only lists what differs from Serum's defaults: nothing may carry over from the last one.
    lib = tmp_path / "lib"
    s = Settings(library_path=str(lib))
    write_midi(tmp_path / "Bass Fm.mid", f_minor_bass(2))
    mid = pipeline.import_midi(s, [str(tmp_path / "Bass Fm.mid")])["imported"][0]["id"]

    def centroid(rel: str) -> float:
        y, sr = sf.read(lib / rel)
        spec = np.abs(np.fft.rfft(y.mean(axis=1)))
        return float((spec * np.fft.rfftfreq(len(y), 1 / sr)).sum() / spec.sum())

    first = centroid(pipeline.render_bass(s, str(ORGAN), mid, 0, 124, ".drumvault/bass/a.wav")["path"])
    pipeline.render_bass(s, str(RESONANCE), mid, 0, 124, ".drumvault/bass/b.wav")
    again = centroid(pipeline.render_bass(s, str(ORGAN), mid, 0, 124, ".drumvault/bass/a2.wav")["path"])
    assert again == pytest.approx(first, rel=0.1)


def test_old_bass_renders_are_redone(tmp_path):
    folder = tmp_path / "bass"
    folder.mkdir()
    (folder / "old.wav").write_bytes(b"x")
    pipeline._drop_stale_bass_renders(folder)
    assert not (folder / "old.wav").exists()
    (folder / "new.wav").write_bytes(b"x")
    pipeline._drop_stale_bass_renders(folder)  # once only
    assert (folder / "new.wav").exists()


def test_save_edited_loop_as_new_bassline(tmp_path):
    lib = tmp_path / "lib"
    s = Settings(library_path=str(lib))
    notes = [[0.25, 0.25, 41, 100], [1.0, 0.5, 44, 80], [7.5, 1.0, 36, 120]]
    r = pipeline.save_midi(s, "Roll edit", notes, 2, "Fm")
    db = sqlite3.connect(lib / ".drumvault" / "library.sqlite")
    rel, bars, key, stored = db.execute("SELECT rel_path, bars, key_label, notes FROM midi_files WHERE id = ?", (r["id"],)).fetchone()
    assert rel == "MIDI/Bass/roll-edit.mid" and bars == 2 and key == "Fm"
    assert json.loads(stored) == [[0.25, 0.25, 41, 100], [1.0, 0.5, 44, 80], [7.5, 0.5, 36, 120]]  # cut at the loop end
    assert [(n.start, n.pitch) for n in midimod.read_notes(lib / rel)] == [(0.25, 41), (1.0, 44), (7.5, 36)]
    assert pipeline.save_midi(s, "Roll edit", notes, 2, "Fm") == r                      # same loop: no duplicate
    assert pipeline.save_midi(s, "Roll edit", notes[:2], 2, "Fm")["rel_path"] == "MIDI/Bass/roll-edit-2.mid"


@pytest.mark.skipif(not SERUM.exists() or not FACTORY_BASS.exists(), reason="Serum 2 not installed")
def test_render_bass_from_edited_notes(tmp_path):
    lib = tmp_path / "lib"
    s = Settings(library_path=str(lib))
    write_midi(tmp_path / "Bass Fm.mid", f_minor_bass(2))
    mid = pipeline.import_midi(s, [str(tmp_path / "Bass Fm.mid")])["imported"][0]["id"]
    preset = str(sorted(FACTORY_BASS.rglob("*.SerumPreset"))[1])
    a = pipeline.render_bass(s, preset, mid, 0, 124, ".drumvault/bass/orig.wav")
    b = pipeline.render_bass(s, preset, mid, 0, 124, ".drumvault/bass/edit.wav", notes=[[0, 3.5, 29, 110]], bars=1)
    ya, sr = sf.read(lib / a["path"], always_2d=True)
    yb, _ = sf.read(lib / b["path"], always_2d=True)
    assert yb.shape[0] == round(4 * 60 / 124 * sr) and ya.shape[0] == 2 * yb.shape[0]   # 1 bar instead of 2


@pytest.mark.skipif(not SERUM.exists() or not FACTORY_BASS.exists(), reason="Serum 2 not installed")
def test_render_bass_off_the_main_thread(tmp_path):
    # The RPC runs renders on worker threads, where Pedalboard can't reset a plugin.
    from concurrent.futures import ThreadPoolExecutor
    lib = tmp_path / "lib"
    s = Settings(library_path=str(lib))
    write_midi(tmp_path / "Bass Fm.mid", f_minor_bass(2))
    mid = pipeline.import_midi(s, [str(tmp_path / "Bass Fm.mid")])["imported"][0]["id"]
    presets = sorted(FACTORY_BASS.rglob("*.SerumPreset"))
    with ThreadPoolExecutor(max_workers=2) as pool:
        outs = list(pool.map(lambda i: pipeline.render_bass(s, str(presets[i]), mid, 0, 124, f".drumvault/bass/t{i}.wav"),
                             [1, 30]))
    for o in outs:
        assert np.abs(sf.read(lib / o["path"])[0]).max() > 0.05


def make_midi_zip(tmp_path: Path, name: str, parts: dict[str, list[tuple[float, float, int]]]) -> Path:
    import zipfile
    z = tmp_path / name
    with zipfile.ZipFile(z, "w") as zf:
        for part, notes in parts.items():
            f = write_midi(tmp_path / "parts" / name / f"{part}.mid", notes)
            zf.write(f, f"Midi/{part}.mid")
        zf.writestr("__MACOSX/Midi/._Bass.mid", b"junk")
    return z


def chords_fm(octave: int = 0):
    # Fm, Bbm, C (with the E natural), Fm: clearly F minor.
    out = []
    for bar, triad in enumerate([(65, 68, 72), (65, 70, 73), (64, 67, 72), (65, 68, 72)]):
        out += [(bar * 4.0, 4.0, p + 12 * octave) for p in triad]
    return out


def test_import_midi_zip_names_parts_and_shares_the_key(tmp_path):
    lib = tmp_path / "lib"
    s = Settings(library_path=str(lib))
    # A bassline that alone could be Ab major; with the chords the track is clearly F minor.
    bass = [(b * 4 + i, 0.5, p) for b in range(4) for i, p in enumerate([41, 44, 48, 44])]
    z = make_midi_zip(tmp_path, "777_midi.zip", {"Bass": bass, "Organ": chords_fm(), "Pianist": chords_fm(1)})
    from drumvault_engine import zipio
    assert zipio.is_midi_zip(z)
    r = pipeline.import_midi(s, [str(z)])
    # Bass and organ are kept in their independent training pools.
    assert [(m["file_name"], m["role"], m["key_label"]) for m in r["imported"]] == [("777 Bass.mid", "bass", "Fm"), ("777 Organ.mid", "keys", "Fm")]
    assert r["ignored"] == 1
    row = sqlite3.connect(lib / ".drumvault" / "library.sqlite").execute(
        "SELECT source, rel_path, original_path FROM midi_files WHERE role = 'bass'").fetchone()
    assert row[0] == "777" and row[1] == "MIDI/Bass/777-bass.mid" and row[2].endswith("777_midi.zip!Midi/Bass.mid")
    again = pipeline.import_midi(s, [str(z)])
    assert (again["skipped"], again["imported"]) == (2, [])


def test_midi_zip_takes_the_key_of_its_stem_zip(tmp_path):
    lib = tmp_path / "lib"
    s = Settings(library_path=str(lib))
    from drumvault_engine.db import LibraryDB
    with LibraryDB(lib) as db:
        db.insert_zip(source_code="S0007", file_name="888_stems.zip", file_sha1="x", status="done", key_label="Gm")
    z = make_midi_zip(tmp_path, "888_midi.zip", {"Bass": f_minor_bass(2)})
    [m] = pipeline.import_midi(s, [str(z)])["imported"]
    assert m["key_label"] == "Gm"   # the analysed track's key wins over the notes
    code = sqlite3.connect(lib / ".drumvault" / "library.sqlite").execute("SELECT source_code FROM midi_files").fetchone()[0]
    assert code == "S0007"


def test_process_refuses_a_midi_zip_and_midi_can_be_corrected_or_deleted(tmp_path):
    lib = tmp_path / "lib"
    s = Settings(library_path=str(lib))
    z = make_midi_zip(tmp_path, "999_midi.zip", {"Bass": f_minor_bass(1)})
    with pytest.raises(pipeline.PipelineError) as e:
        pipeline.process_zip(z, s)
    assert e.value.code == "midi_zip"
    assert not sqlite3.connect(lib / ".drumvault" / "library.sqlite").execute("SELECT COUNT(*) FROM zips").fetchone()[0]
    [m] = pipeline.import_midi(s, [str(z)])["imported"]
    pipeline.set_midi_meta(s, m["id"], "other", "Am", False)
    db = sqlite3.connect(lib / ".drumvault" / "library.sqlite")
    assert db.execute("SELECT role, key_label, key_camelot FROM midi_files").fetchone() == ("other", "Am", "8A")
    pipeline.set_midi_meta(s, m["id"], None, None, True)
    assert db.execute("SELECT key_label FROM midi_files").fetchone() == (None,)
    rel = db.execute("SELECT rel_path FROM midi_files").fetchone()[0]
    assert pipeline.delete_midi(s, [m["id"]]) == {"deleted": 1}
    assert not (lib / rel).exists() and not db.execute("SELECT COUNT(*) FROM midi_files").fetchone()[0]

@pytest.mark.parametrize("name", ["Key Cm.mid", "Keys.mid", "Piano_Am.mid", "Organ.mid", "Rhodes.mid", "Keyboard.mid", "Chords.mid", "E-Piano.mid"])
def test_keys_roles_are_separate_from_bass(name):
    assert midimod.guess_role(name, [], Thresholds()) == "keys"
    assert midimod.guess_role("Bass Piano.mid", [], Thresholds()) == "bass"
    assert midimod.guess_role("Lead.mid", [], Thresholds()) == "other"


def test_keys_import_save_reimport_and_role_correction(tmp_path):
    s = Settings(library_path=str(tmp_path / "lib"))
    z = make_midi_zip(tmp_path, "keys_midi.zip", {"Piano Cm": [(0, 1, 60), (0, 1, 63), (0, 1, 67)],
                                               "Bass Cm": [(0, 1, 36)], "Strings": [(0, 1, 84)]})
    r = pipeline.import_midi(s, [str(z)])
    assert sorted(m["role"] for m in r["imported"]) == ["bass", "keys"]
    assert r["ignored"] == 1
    with sqlite3.connect(Path(s.library_path) / ".drumvault/library.sqlite") as db:
        row = db.execute("SELECT rel_path, notes FROM midi_files WHERE role = 'keys'").fetchone()
        assert row[0].startswith("MIDI/Keys/") and len(json.loads(row[1])) == 3
    notes = [[0, 2, 60, 110], [0, 1.5, 63, 95], [0, 1.75, 67, 90]]
    saved = pipeline.save_midi(s, "My piano edit", notes, 1, "Cm", "keys")
    assert saved["rel_path"].startswith("MIDI/Keys/")
    assert pipeline.save_midi(s, "My piano edit", notes, 1, "Cm", "keys")["id"] == saved["id"]
    restored = midimod.read_notes(Path(s.library_path) / saved["rel_path"])
    assert [n.pitch for n in restored] == [60, 63, 67]
    assert pipeline.import_midi(s, [str(z)])["skipped"] == 2
    pipeline.set_midi_meta(s, saved["id"], "bass", None, False)
    pipeline.set_midi_meta(s, saved["id"], "keys", None, False)
    with sqlite3.connect(Path(s.library_path) / ".drumvault/library.sqlite") as db:
        assert db.execute("SELECT role FROM midi_files WHERE id = ?", (saved["id"],)).fetchone()[0] == "keys"


@pytest.mark.skipif(not SERUM.exists() or not FACTORY_BASS.exists(), reason="Serum 2 not installed")
def test_render_polyphonic_keys_through_serum(tmp_path):
    s = Settings(library_path=str(tmp_path / "lib"))
    preset_root = FACTORY_BASS.parent
    keys_presets = sorted((preset_root / "Piano").rglob("*.SerumPreset"))
    if not keys_presets:
        keys_presets = sorted(preset_root.rglob("*.SerumPreset"))
    notes = [[0, 1.5, 60, 100], [0, 1.5, 63, 90], [0, 1.5, 67, 95], [2.5, 1, 70, 90]]
    out = ".drumvault/keys/poly.wav"
    result = pipeline.render_bass(s, str(keys_presets[0]), -1, 0, 124, out, notes=notes, bars=1)
    audio, sr = sf.read(Path(s.library_path) / out, always_2d=True)
    assert audio.shape == (round(4 * 60 / 124 * sr), 2)
    assert np.isfinite(audio).all() and np.abs(audio).max() > 0.01
    assert result["cached"] is False
    assert pipeline.render_bass(s, str(keys_presets[0]), -1, 0, 124, out, notes=notes, bars=1)["cached"] is True
