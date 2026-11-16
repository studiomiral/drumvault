"""The ambience bed (SCOPE.md §6.10a): a long texture from the Ambience page (vinyl crackle, tape
hiss, room tone, a field recording) under a generated track, very quiet and constant.

A part is the sample made into a seamless loop of `bars` bars at the track tempo: cut a little
longer than the loop and its end crossfaded (equal power) into its start, so it repeats with no
seam; a sample shorter than the loop is laid end to end the same way. No pitch, no stretch: a
texture has no key and no beat. Loudness-matched like the other rendered parts.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .audioutil import load, resample
from .config import Settings


def make_loop(settings: Settings, rel_path: str, bpm: float, bars: int) -> np.ndarray:
    """The bed's loop: (frames, 2) float32 at the library rate, `bars` bars at `bpm`, seamless."""
    f = Path(settings.library_path) / rel_path
    if ".." in Path(rel_path).parts or not f.exists():
        raise FileNotFoundError(rel_path)
    a = load(f)
    sr = settings.output_sample_rate
    x = a.data if a.data.shape[1] == 2 else np.repeat(a.data[:, :1], 2, axis=1)
    x = resample(x, a.sr, sr).astype(np.float32)
    n = int(round(bars * 4 * 60.0 / bpm * sr))
    xf = max(1, min(int(round(settings.thresholds.ambience_xfade_s * sr)), x.shape[0] // 3, n // 4))
    # Laid end to end until there is a loop and a crossfade's worth, each join crossfaded.
    t = np.linspace(0.0, np.pi / 2, xf, dtype=np.float32)[:, None]
    fade_in, fade_out = np.sin(t), np.cos(t)
    src = x.copy()
    while src.shape[0] < n + xf:
        joined = np.concatenate([src[:-xf], src[-xf:] * fade_out + x[:xf] * fade_in, x[xf:]])
        src = joined
    loop = src[:n].copy()
    # The end of the loop runs into its start: the next xf frames fade in over the loop's first ones.
    loop[:xf] = loop[:xf] * fade_in + src[n:n + xf] * fade_out
    return np.ascontiguousarray(loop, dtype=np.float32)


__all__ = ["make_loop"]
