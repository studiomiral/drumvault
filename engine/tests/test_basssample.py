"""Bass from a one-shot sample (SCOPE.md §6.7a): import with its note, and the line played like a sampler."""

import sqlite3
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from drumvault_engine import basssample, hits, pipeline
from drumvault_engine.config import Settings
from drumvault_engine.midi import Note
from drumvault_engine.schemas import ImportHitsParams

from make_fixtures import midi_hz

SR = 44100
BPM = 120.0   # a beat is half a second


def oneshot(pitch: int, seconds: float = 1.5, sr: int = SR) -> np.ndarray:
    """A bass one-shot: one note with a fast attack, ringing out."""
    t = np.arange(int(seconds * sr)) / sr
    x = np.sin(2 * np.pi * midi_hz(pitch) * t) * np.minimum(1.0, t / 0.005) * np.exp(-t / 1.2)
    return np.stack([x, x], axis=1).astype(np.float32) * 0.6


def imported(tmp_path: Path, name: str, data: np.ndarray, kind: str = "bass") -> tuple[Settings, str, sqlite3.Row]:
    s = Settings(library_path=str(tmp_path / "lib"))
    src = tmp_path / "src" / name
    src.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(src), data, SR, subtype="PCM_24")
    [h] = hits.import_hits(s, [str(src)], kind=kind)["imported"]
    conn = sqlite3.connect(Path(s.library_path) / ".drumvault" / "library.sqlite")
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM hits WHERE id = ?", (h["id"],)).fetchone()
    return s, row["rel_path"], row


def peak_hz(x: np.ndarray, sr: int) -> float:
    m = x.mean(axis=1)
    mag = np.abs(np.fft.rfft(m * np.hanning(len(m))))
    return float(np.fft.rfftfreq(len(m), 1 / sr)[np.argmax(mag)])


def test_bass_samples_import_into_their_own_folder_with_their_note(tmp_path):
    s, rel, row = imported(tmp_path, "Deep Bass Oneshot A.wav", oneshot(33))
    assert rel.startswith("Bass Samples/") and row["kind"] == "bass"
    assert (row["key_label"], row["key_source"]) == ("A", "name")       # one note: its name's note, no scale read
    # No note in the name: from its pitch.
    s2, _, row2 = imported(tmp_path / "b", "Sub Oneshot.wav", oneshot(36))
    assert (row2["key_label"], row2["key_source"]) == ("C", "detected")
    assert ImportHitsParams(paths=["x"], kind="bass").kind == "bass"
    assert basssample.is_sample("Bass Samples/x.wav") and not basssample.is_sample("/Library/Presets/Bass/x.SerumPreset")


def test_piano_samples_import_into_their_own_folder_with_their_note(tmp_path):
    _, rel, row = imported(tmp_path, "Grand Piano C#.wav", oneshot(61), kind="piano")
    assert rel.startswith("Piano Samples/") and row["kind"] == "piano"
    assert (row["key_label"], row["key_source"]) == ("C#", "name")
    # No note in the name: from its pitch, read above the bass range too (E5).
    _, _, row2 = imported(tmp_path / "b", "Felt Piano Oneshot.wav", oneshot(76), kind="piano")
    assert (row2["key_label"], row2["key_source"]) == ("E", "detected")
    # A piano note rings longer than a hit: kept up to piano_sample_max_len_s.
    _, _, row3 = imported(tmp_path / "c", "Long Piano G.wav", oneshot(67, seconds=9.0) * 1.0, kind="piano")
    assert row3["duration_s"] > Settings().thresholds.hit_max_len_s
    assert ImportHitsParams(paths=["x"], kind="piano").kind == "piano"


def test_the_sample_plays_its_own_note_nearest_the_middle_of_the_line():
    line = [Note(0, 1, 33, 100), Note(1, 1, 36, 100), Note(2, 1, 40, 100)]
    assert basssample.reference_note(line, 9) == 33       # an A sample: the A in the line
    assert basssample.reference_note(line, 0) == 36       # a C sample: the C
    assert basssample.reference_note(line, 2) == 38       # a D sample: the D between them, though no note plays it
    assert basssample.reference_note([Note(0, 1, 45, 100)], 9) == 45


def test_a_line_is_played_like_a_sampler_as_a_seamless_loop(tmp_path):
    s, rel, _ = imported(tmp_path, "Bass A.wav", oneshot(33, 3.0))
    sr = s.output_sample_rate
    # A on beat 1 held a beat, C on beat 3 held half a beat, and an A starting on the last beat that rings round the end.
    line = [Note(0, 1, 33, 110), Note(2, 0.5, 36, 110), Note(3, 2, 33, 110)]
    y = basssample.render(s, rel, line, 9, BPM, 1)
    beat = int(0.5 * sr)
    assert y.shape == (4 * beat, 2)
    assert peak_hz(y[int(0.1 * beat): int(0.9 * beat)], sr) == pytest.approx(midi_hz(33), rel=0.03)      # as it is
    assert peak_hz(y[2 * beat + 200: int(2.45 * beat)], sr) == pytest.approx(midi_hz(36), rel=0.03)      # 3 semitones up
    # Let go: silent after its release, until the next note.
    assert np.abs(y[int(1.3 * beat): 2 * beat]).max() < 1e-3
    assert np.abs(y[int(2.8 * beat): 3 * beat - 10]).max() < 1e-3
    # One voice: the note from beat 4 rings round the loop's end and is cut where the first note starts.
    assert np.abs(y[int(3.5 * beat): 4 * beat]).max() > 0.05
    # A softer note is quieter, never silent.
    soft = basssample.render(s, rel, [Note(0, 1, 33, 1)], 9, BPM, 1)
    loud = basssample.render(s, rel, [Note(0, 1, 33, 127)], 9, BPM, 1)
    assert 0.3 < np.abs(soft).max() / np.abs(loud).max() < 0.5
    assert not basssample.render(s, rel, [], 9, BPM, 1).any()


def test_render_bass_takes_a_bass_sample_in_place_of_a_serum_preset(tmp_path):
    s, rel, _ = imported(tmp_path, "Bass A.wav", oneshot(33, 2.0))
    notes = [[0, 0.5, 33, 100], [1.5, 0.5, 36, 100], [2, 0.5, 33, 100]]
    out_rel = ".drumvault/bass/abc-e1-0-120.wav"
    r = pipeline.render_bass(s, rel, 0, 0, BPM, out_rel, notes=notes, bars=1)
    assert r == {"path": out_rel, "cached": False}
    y, sr = sf.read(Path(s.library_path) / out_rel, always_2d=True)
    assert y.shape[0] == int(round(4 * 60 / BPM * sr))
    assert peak_hz(y[: int(0.2 * sr)], sr) == pytest.approx(midi_hz(33), rel=0.05)
    assert pipeline.render_bass(s, rel, 0, 0, BPM, out_rel, notes=notes, bars=1)["cached"] is True
    # Moved into another key: the whole line, the sample following it.
    up = ".drumvault/bass/abc-e1-2-120.wav"
    pipeline.render_bass(s, rel, 0, 2, BPM, up, notes=notes, bars=1)
    y2, _ = sf.read(Path(s.library_path) / up, always_2d=True)
    assert peak_hz(y2[: int(0.2 * sr)], sr) == pytest.approx(midi_hz(35), rel=0.05)
    with pytest.raises(pipeline.PipelineError):
        pipeline.render_bass(s, "Bass Samples/missing.wav", 0, 0, BPM, ".drumvault/bass/x-e1-0-120.wav", notes=notes, bars=1)
    with pytest.raises(pipeline.PipelineError):
        pipeline.render_bass(s, "Bass Samples/../../etc.wav", 0, 0, BPM, ".drumvault/bass/y-e1-0-120.wav", notes=notes, bars=1)


def test_a_piano_part_plays_its_chords_with_a_voice_per_note(tmp_path):
    s, rel, _ = imported(tmp_path, "Grand Piano C.wav", oneshot(60, 3.0), kind="piano")
    sr = s.output_sample_rate
    beat = int(0.5 * sr)
    # A C major triad on beat 1, held a beat: all three notes sound together.
    chord = [Note(0, 1, 60, 100), Note(0, 1, 64, 100), Note(0, 1, 67, 100)]
    y = basssample.render(s, rel, chord, 0, BPM, 1, poly=True)
    mag = np.abs(np.fft.rfft(y[: beat // 2].mean(axis=1) * np.hanning(beat // 2)))
    freqs = np.fft.rfftfreq(beat // 2, 1 / sr)
    for p in (60, 64, 67):
        k = np.argmin(np.abs(freqs - midi_hz(p)))
        assert mag[k - 2: k + 3].max() > 0.2 * mag.max()
    # A held note rings on under the next one (the bass's one voice would cut it there).
    held = [Note(0, 2, 60, 100), Note(1, 1, 72, 100)]
    for poly, rings in ((True, True), (False, False)):
        z = basssample.render(s, rel, held, 0, BPM, 1, poly=poly)
        seg = z[int(1.2 * beat): int(1.8 * beat)].mean(axis=1)
        m = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
        f = np.fft.rfftfreq(len(seg), 1 / sr)
        k = np.argmin(np.abs(f - midi_hz(60)))
        assert bool(m[k - 2: k + 3].max() > 0.1 * m.max()) is rings
    # Let go: it rings for its release, then stops.
    rel_s = s.thresholds.piano_sample_release_ms / 1000
    assert np.abs(y[beat + int(rel_s * sr) + 50: 2 * beat]).max() < 1e-3


def test_render_bass_plays_a_piano_part_from_a_piano_sample(tmp_path):
    s, rel, _ = imported(tmp_path, "Keys A.wav", oneshot(57, 2.0), kind="piano")
    assert rel.startswith("Piano Samples/") and basssample.is_piano_sample(rel) and not basssample.is_sample(rel)
    notes = [[0, 1, 57, 100], [0, 1, 60, 100], [0, 1, 64, 100], [2, 1, 55, 100], [2, 1, 59, 100]]
    out_rel = ".drumvault/piano/abc-e1-0-120.wav"
    assert pipeline.render_bass(s, rel, 0, 0, BPM, out_rel, notes=notes, bars=1) == {"path": out_rel, "cached": False}
    y, sr = sf.read(Path(s.library_path) / out_rel, always_2d=True)
    assert y.shape[0] == int(round(4 * 60 / BPM * sr)) and np.abs(y).max() > 0.05
    # Only a Piano tab sample plays in the piano folder; a path out of the library never does.
    with pytest.raises(pipeline.PipelineError):
        pipeline.render_bass(s, "Piano Samples/../../etc.wav", 0, 0, BPM, ".drumvault/piano/y-e1-0-120.wav", notes=notes, bars=1)
