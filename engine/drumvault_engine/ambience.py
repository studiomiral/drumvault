"""The ambience bed (SCOPE.md §6.10a): a long texture from the Ambience page (vinyl crackle, tape
hiss, room tone, a field recording, or a tonal bed: a drone, a soft pad) under a generated track,
very quiet and constant.

A part is the sample made into a seamless loop of `bars` bars at the track tempo: cut a little
longer than the loop and its end crossfaded (equal power) into its start, so it repeats with no
seam; a sample shorter than the loop is laid end to end the same way. No stretch: a texture has
no beat. Noise (crackle, hiss, a crowd) has no key and is never pitched; a tonal bed has one and
is moved into the track key first (Rubber Band, its length kept). Loudness-matched like the other
rendered parts.

A tonal bed is never heard as recorded: a track it wouldn't move in (in its key, or the relative
one) takes another (the app's choice). `tonality` tells the two apart: the share of a texture's energy in narrow spectral peaks that
hold for about a second. A held note does; the peaks of crackle, rain or a crowd flicker.
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
from scipy.ndimage import median_filter

from . import stretch
from .audioutil import load, resample
from .config import Settings, Thresholds

_SR = 22050
_N_FFT = 4096
_HOP = 1024


def tonality(mono: np.ndarray, sr: int, th: Thresholds) -> float:
    """How tonal a texture is, 0…1: the median (over its frames) of the share
    of its energy between ambience_tonal_lo_hz and _hi_hz (the quiet frames left out) in peaks ambience_tonal_peak_db over the
    spectrum around them that hold for ambience_tonal_hold_s. Noise ≈ 0; a held chord ≈ 1."""
    x = resample(np.asarray(mono, dtype=np.float32), sr, _SR)[: int(th.ambience_tonal_max_s * _SR)]
    if x.shape[0] < _N_FFT * 2 or not np.any(x):
        return 0.0
    win = np.hanning(_N_FFT).astype(np.float32)
    frames = np.lib.stride_tricks.sliding_window_view(x, _N_FFT)[::_HOP] * win
    S = np.abs(np.fft.rfft(frames, axis=1)).T ** 2  # (bins, frames)
    freqs = np.fft.rfftfreq(_N_FFT, 1.0 / _SR)
    S = S[(freqs >= th.ambience_tonal_lo_hz) & (freqs <= th.ambience_tonal_hi_hz)]
    level = S.sum(axis=0)
    floor = max(np.percentile(level, th.ambience_tonal_quiet_pct), np.percentile(level, 95) * 10 ** (-th.ambience_tonal_floor_db / 10))
    S = S[:, level > floor]
    if S.shape[1] < 2:
        return 0.0
    bin_hz = _SR / _N_FFT
    env = median_filter(S, size=(max(3, int(round(th.ambience_tonal_env_hz / bin_hz)) | 1), 1))
    peaks = (S > env * 10 ** (th.ambience_tonal_peak_db / 10)).astype(np.float32)
    hold = max(3, int(round(th.ambience_tonal_hold_s * _SR / _HOP)) | 1)
    held = median_filter(peaks, size=(1, hold)) > 0.5
    share = (S * held).sum(axis=0) / (S.sum(axis=0) + 1e-20)
    return float(np.median(share))


# A texture named as noise is never pitched, whatever it measures (a crowd singing along still is a crowd).
# ("vinyl" and "tape" aren't: "vinyl_cut_…_Cmin" is a record sampled, music.)
NOISE_WORDS = {"crowd", "crowds", "applause", "cheer", "cheers", "cheering", "chatter", "audience", "people", "party",
               "crackle", "crackles", "hiss", "static", "noise", "rain", "wind", "waves", "sea", "water",
               "roomtone", "street", "traffic", "birds", "forest"}
_TOKEN = re.compile(r"[A-Za-z]+")
_CAMEL = re.compile(r"(?<=[a-z])(?=[A-Z])")


# …unless it is also called a pad or a drone ("Cmin_RainStation_Pad": a pad named after a station).
TONAL_WORDS = {"pad", "pads", "drone", "drones", "soundscape", "soundscapes"}


def name_words(name: str) -> set[str]:
    return {t.lower() for t in _TOKEN.findall(_CAMEL.sub(" ", Path(name).stem))}


def named_noise(name: str) -> bool:
    """The file name calls it noise: crowd, applause, crackle, hiss, rain, room tone, … (and not a pad or a drone)."""
    w = name_words(name)
    return (bool(w & NOISE_WORDS) or {"room", "tone"} <= w) and not w & TONAL_WORDS


def is_tonal(name: str, score: float | None, th: Thresholds) -> bool:
    """A tonal bed (moved into every track's key, never heard as recorded) or noise (never moved)."""
    return score is not None and score >= th.ambience_tonal_min and not named_noise(name)


def make_loop(settings: Settings, rel_path: str, bpm: float, bars: int, semitones: int = 0) -> np.ndarray:
    """The bed's loop: (frames, 2) float32 at the library rate, `bars` bars at `bpm`, seamless;
    moved `semitones` first (a tonal bed in the track key)."""
    f = Path(settings.library_path) / rel_path
    if ".." in Path(rel_path).parts or not f.exists():
        raise FileNotFoundError(rel_path)
    a = load(f)
    sr = settings.output_sample_rate
    x = a.data if a.data.shape[1] == 2 else np.repeat(a.data[:, :1], 2, axis=1)
    x = resample(x, a.sr, sr).astype(np.float32)
    if semitones:
        x = stretch.pitch_by(x, sr, semitones, settings).astype(np.float32)
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


__all__ = ["make_loop", "tonality", "is_tonal", "named_noise"]
