"""Strings (SCOPE.md §6.10): a long string sample from the Strings page, heard as it was recorded,
restarting on every line of its own length (8 bars at most; the app asks for as many bars as the
sample fills, so a 4-bar sample starts again every 4 bars and never leaves bars of silence).

A part is the sample from its start, moved `semitones` into the track key with its length kept
(Rubber Band: no faster or slower), cut to `bars` bars at the track tempo with a short fade where
the next start cuts it (or padded with silence when it's shorter), loudness-matched like the bass
renders. No warping, no wash, no rhythm: the lane's sidechain is the only movement.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from . import stretch
from .audioutil import load, resample
from .config import Settings


def part_frames(bpm: float, bars: int, sr: int) -> int:
    return int(round(bars * 4 * 60.0 / bpm * sr))


def make_part(settings: Settings, rel_path: str, semitones: int, bpm: float, bars: int) -> np.ndarray:
    """The part a Strings page sample plays from each 8-bar line: (frames, 2) float32 at the
    library rate."""
    f = Path(settings.library_path) / rel_path
    if ".." in Path(rel_path).parts or not f.exists():
        raise FileNotFoundError(rel_path)
    a = load(f)
    sr = settings.output_sample_rate
    x = a.data if a.data.shape[1] == 2 else np.repeat(a.data[:, :1], 2, axis=1)
    x = resample(x, a.sr, sr)
    if semitones:
        x = stretch.pitch_by(x, sr, semitones, settings)
    n = part_frames(bpm, bars, sr)
    if x.shape[0] > n:
        x = x[:n].copy()
        fade = min(n, int(round(settings.thresholds.strings_fade_s * sr)))
        x[n - fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)[:, None]
    else:
        # A sample that ends before the part does (a 4-bar loop cut at a slightly faster tempo): its
        # end fades over a moment, so it doesn't click into the gap before the next start.
        x = x.copy()
        fade = min(x.shape[0], int(round(settings.thresholds.strings_tail_fade_s * sr)))
        if fade > 1:
            x[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)[:, None]
        x = np.pad(x, ((0, n - x.shape[0]), (0, 0)))
    return np.ascontiguousarray(x, dtype=np.float32)


__all__ = ["make_part", "part_frames"]
