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


def imported(tmp_path: Path, name: str, data: np.ndarray) -> tuple[Settings, str, sqlite3.Row]:
    s = Settings(library_path=str(tmp_path / "lib"))
    src = tmp_path / "src" / name
    src.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(src), data, SR, subtype="PCM_24")
    [h] = hits.import_hits(s, [str(src)], kind="bass")["imported"]
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
