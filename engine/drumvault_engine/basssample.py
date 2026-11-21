"""Bass from a one-shot sample (SCOPE.md §6.7a): the track's bassline played by a Bass Samples
page sample the way a sampler plays it, instead of through a Serum patch.

Every note of the line is the sample played faster or slower to its pitch: the sample is taken to
sound its own note (its key's root, from its name or its sound) on the note of that name nearest
the middle of the line, so most notes move it little. One voice: a note stops the one before it.
A note plays as long as it is held, then fades out; the loop wraps (a note ringing past the end
comes round to the start), so it repeats seamlessly. The app treats the result like a Serum
render: the same file naming, loudness, sidechain, edits and MIDI export.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from . import key as keymod
from .audioutil import load, resample
from .config import Settings
from .midi import Note

FOLDER = "Bass Samples"


def is_sample(preset: str) -> bool:
    """Whether a bass "preset" is a Bass Samples page sample (library-relative) and not a Serum preset file."""
    return preset.startswith(f"{FOLDER}/")


def sample_pitch_class(mono: np.ndarray, sr: int, settings: Settings, piano: bool = False) -> int | None:
    """The note a bass one-shot (or, `piano`, a Piano tab one-shot) plays (pitch class 0–11), from
    its sound: the median of its fundamental over where it is voiced. None when no pitch is found."""
    import librosa

    th = settings.thresholds
    y = np.asarray(mono, dtype=np.float32)[: int(th.bass_sample_pitch_window_s * sr)]
    if len(y) < 2048 or not np.any(y):
        return None
    lo, hi = (th.piano_sample_min_hz, th.piano_sample_max_hz) if piano else (th.bass_sample_min_hz, th.bass_sample_max_hz)
    f0, voiced, _ = librosa.pyin(y, fmin=lo, fmax=min(hi, sr / 2 - 1), sr=sr, frame_length=4096)
    f = f0[voiced & np.isfinite(f0)] if voiced is not None else np.array([])
    if not f.size:
        return None
    return int(round(69 + 12 * np.log2(float(np.median(f)) / 440.0))) % 12


def reference_note(notes: list[Note], root_pc: int) -> int:
    """The MIDI note the sample plays as it is: the one of its own pitch class nearest the middle
    of the line (ties: the lower)."""
    mid = float(np.median([n.pitch for n in notes])) if notes else 36.0
    base = int(round(mid))
    cands = [base + d for d in range(-11, 12) if (base + d) % 12 == root_pc % 12]
    return min(cands, key=lambda p: (abs(p - mid), p))


def _pitched(x: np.ndarray, semitones: float) -> np.ndarray:
    """`x` (frames, 2) played faster or slower by `semitones`, like a sampler (shorter when higher)."""
    if not semitones:
        return x
    rate = 2.0 ** (semitones / 12.0)
    at = np.arange(0.0, x.shape[0] - 1, rate)
    idx = np.arange(x.shape[0], dtype=np.float64)
    return np.stack([np.interp(at, idx, x[:, c]) for c in range(x.shape[1])], axis=1).astype(np.float32)


def render(settings: Settings, sample_rel: str, notes: list[Note], root_pc: int, bpm: float, bars: int) -> np.ndarray:
    """The line `notes` (already in the track key) played by the sample, as a seamless loop of
    `bars` bars at `bpm`: (frames, 2) float32 at the library rate."""
    th = settings.thresholds
    f = Path(settings.library_path) / sample_rel
    if ".." in Path(sample_rel).parts or not f.exists():
        raise FileNotFoundError(sample_rel)
    a = load(f)
    sr = settings.output_sample_rate
    x = a.data if a.data.shape[1] == 2 else np.repeat(a.data[:, :1], 2, axis=1)
    x = resample(x, a.sr, sr)
    n = int(round(bars * 4 * 60.0 / bpm * sr))
    out = np.zeros((n, 2), dtype=np.float32)
    if not notes or n <= 0:
        return out
    ref = reference_note(notes, root_pc)
    beat = 60.0 / bpm * sr
    release = max(2, int(round(th.bass_sample_release_ms * sr / 1000)))
    cut = max(2, int(round(th.bass_sample_cut_ms * sr / 1000)))
    line = sorted(notes, key=lambda q: q.start)
    starts = [int(round(q.start * beat)) % n for q in line]
    voices: dict[int, np.ndarray] = {}
    for i, q in enumerate(line):
        if q.pitch not in voices:
            voices[q.pitch] = _pitched(x, q.pitch - ref)
        v = voices[q.pitch]
        # One voice: the note ends where it is let go (plus its release), or where the next one starts.
        held = int(round(q.length * beat)) + release
        nxt = (starts[(i + 1) % len(line)] - starts[i]) % n or n
        length = max(1, min(v.shape[0], held, nxt + cut if len(line) > 1 else held))
        fade = min(length, cut if length == nxt + cut else release)
        y = v[:length].copy()
        if fade > 1:
            y[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)[:, None]
        y *= th.bass_sample_min_velocity + (1.0 - th.bass_sample_min_velocity) * max(0, min(127, q.velocity)) / 127.0
        # Into the loop, round its end.
        at = starts[i]
        while y.shape[0]:
            room = n - at
            out[at:at + min(room, y.shape[0])] += y[:room]
            y = y[room:]
            at = 0
    return out
