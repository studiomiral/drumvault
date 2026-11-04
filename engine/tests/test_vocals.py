"""Vocal takes (SCOPE.md §6.11): the stems ElevenLabs splits a take into are unpacked, and its vocal
written as a WAV at the library rate."""

import io
import zipfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from drumvault_engine.config import Settings
from drumvault_engine.pipeline import PipelineError, import_vocal


def mp3(seconds: float, hz: float, sr: int = 44100) -> bytes:
    t = np.arange(int(seconds * sr)) / sr
    y = (0.3 * np.sin(2 * np.pi * hz * t)).astype(np.float32)
    buf = io.BytesIO()
    sf.write(buf, np.stack([y, y], axis=1), sr, format="MP3")
    return buf.getvalue()


def test_unpacks_a_take_and_writes_its_vocal(tmp_path: Path):
    take = tmp_path / "Vocals" / "2026-11-01-a"
    take.mkdir(parents=True)
    with zipfile.ZipFile(take / "stems.zip", "w") as z:
        z.writestr("take_vocals.mp3", mp3(3.0, 440.0))
        z.writestr("take_instrumental.mp3", mp3(3.0, 110.0))
    r = import_vocal(Settings(library_path=str(tmp_path)), "Vocals/2026-11-01-a")
    assert r["vocal"] == "Vocals/2026-11-01-a/vocal.wav"
    assert r["stems"] == ["Vocals/2026-11-01-a/stems/take_instrumental.mp3", "Vocals/2026-11-01-a/stems/take_vocals.mp3"]
    info = sf.info(str(take / "vocal.wav"))
    assert info.samplerate == 44100 and info.subtype == "PCM_24" and info.channels == 2
    assert abs(r["duration_s"] - 3.0) < 0.1


def test_refuses_what_isnt_a_take(tmp_path: Path):
    s = Settings(library_path=str(tmp_path))
    with pytest.raises(PipelineError):
        import_vocal(s, "Loops/x")
    (tmp_path / "Vocals" / "b").mkdir(parents=True)
    with zipfile.ZipFile(tmp_path / "Vocals" / "b" / "stems.zip", "w") as z:
        z.writestr("drums.mp3", mp3(1.0, 100.0))
    with pytest.raises(PipelineError) as e:
        import_vocal(s, "Vocals/b")
    assert e.value.code == "no_vocal"


def sung_take(path: Path, bpm: float = 124.0, reps: int = 6, sr: int = 44100) -> None:
    """A sung line every 2 bars: C, E, B, then A held (A minor), each note a beat, a rest after."""
    beat = 60 / bpm
    line = []
    for midi, beats in ((72, 1), (76, 1), (71, 1), (69, 3)):
        t = np.arange(int(beats * beat * sr * 0.9)) / sr
        hz = 440 * 2 ** ((midi - 69) / 12)
        tone = 0.3 * (np.sin(2 * np.pi * hz * t) + 0.3 * np.sin(4 * np.pi * hz * t)) * np.minimum(1, t / 0.02)
        line.append(np.concatenate([tone, np.zeros(int(beats * beat * sr) - len(tone))]))
    phrase = np.concatenate(line + [np.zeros(int(2 * beat * sr))])  # 8 beats = 2 bars
    y = np.tile(phrase, reps).astype(np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.stack([y, y], axis=1), sr, subtype="PCM_24")


def test_finds_the_phrase_loop_chops_and_key_of_a_take(tmp_path: Path):
    from drumvault_engine.vocal import analyze
    sung_take(tmp_path / "Vocals" / "t" / "vocal.wav")
    r = analyze(Settings(library_path=str(tmp_path), library_bpm=124.0), "Vocals/t")
    assert r["key"] in ("Am", "C")  # A minor (its relative major shares every note)
    two = next(p for p in r["phrases"] if p["bars"] == 2)  # (and 4 bars: the line twice)
    assert abs(two["period_s"] - 2 * 4 * 60 / 124) < 0.05
    assert all(p["bars"] in (2, 4, 8) for p in r["phrases"])
    y, sr = sf.read(str(tmp_path / two["path"]), always_2d=True)
    assert len(y) == round(2 * 4 * 60 / 124 * sr)  # exactly 2 bars at the library tempo
    assert r["chops"] and all(round(c["note"]) in (69, 71, 72, 76) for c in r["chops"])
    assert (tmp_path / "Vocals" / "t" / "analysis.json").exists()


def test_renders_a_phrase_in_another_key_and_tempo(tmp_path: Path):
    from drumvault_engine.vocal import analyze, render_phrase
    sung_take(tmp_path / "Vocals" / "t" / "vocal.wav")
    s = Settings(library_path=str(tmp_path), library_bpm=124.0)
    r = analyze(s, "Vocals/t")
    out = tmp_path / ".drumvault" / "vocals" / "x.wav"
    render_phrase(s, r["phrases"][0]["path"], 3, 128.0, r["phrases"][0]["bars"], out)
    y, sr = sf.read(str(out), always_2d=True)
    assert len(y) == round(r["phrases"][0]["bars"] * 4 * 60 / 128 * sr)
    assert np.abs(y).max() > 0.05
