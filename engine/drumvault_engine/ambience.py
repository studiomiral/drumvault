"""The ambience bed (SCOPE.md §6.10a): a long texture from the Ambience page (vinyl crackle, tape
hiss, room tone, a field recording, or a tonal bed: a drone, a soft pad) under a generated track,
very quiet and constant.

A part is the sample made into a seamless loop of `bars` bars at the track tempo. A texture with
no tempo (no beat: crackle, a drone) is cut a little longer than the loop and its end crossfaded
(equal power) into its start, so it repeats with no seam; a sample shorter than the loop is laid
end to end the same way. No stretch. A texture with a tempo (`loop_bpm`: a guitar or music loop,
an atmos cut on the grid) has a rhythm: its whole bars are stretched to the track tempo and repeat
on the bar grid, so it plays in time with the drums. Noise (crackle, hiss, a crowd) has no key and is never pitched; a tonal bed has one and
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


_NUMBER = re.compile(r"[A-Za-z]+|\d+")


def loop_bpm(name: str, th: Thresholds) -> float | None:
    """A texture's tempo, from a number in its name in the dance range ("…_guitar_loop_122_Gm"):
    it has a rhythm, synced to the track. None: no beat."""
    for t in _NUMBER.findall(Path(name).stem):
        if t.isdigit() and th.ambience_loop_bpm_lo <= int(t) <= th.ambience_loop_bpm_hi:
            return float(t)
    return None


def loop_bars(frames: int, sr: int, bpm: float) -> int:
    """How many whole bars a loop of `frames` at `bpm` holds (at least one; a tail doesn't count)."""
    return max(1, int(round(frames / sr * bpm / 240.0)))


def bar_frames(bars: float, bpm: float, sr: int) -> int:
    return int(round(bars * 240.0 / bpm * sr))


def whole_bars(data: np.ndarray, sr: int, bpm: float, max_s: float) -> np.ndarray:
    """A loop as imported: from its start (its downbeat, never trimmed to its sound), its whole bars
    at `bpm` (at most `max_s`), a hair short made up with silence; no fades: it is cut on the grid."""
    bars = loop_bars(data.shape[0], sr, bpm)
    bars = max(1, min(bars, int(max_s * bpm / 240.0)))
    n = bar_frames(bars, bpm, sr)
    x = np.asarray(data[:n], dtype=np.float32)
    return np.pad(x, ((0, n - x.shape[0]), (0, 0))) if x.shape[0] < n else x


def make_loop(settings: Settings, rel_path: str, bpm: float, bars: int, semitones: int = 0,
              source_bpm: float | None = None) -> np.ndarray:
    """The bed's loop: (frames, 2) float32 at the library rate, `bars` bars at `bpm`, seamless;
    moved `semitones` first (a tonal bed in the track key). A texture with a tempo (`source_bpm`)
    is stretched to `bpm` and repeats on the bar grid."""
    f = Path(settings.library_path) / rel_path
    if ".." in Path(rel_path).parts or not f.exists():
        raise FileNotFoundError(rel_path)
    a = load(f)
    sr = settings.output_sample_rate
    x = a.data if a.data.shape[1] == 2 else np.repeat(a.data[:, :1], 2, axis=1)
    x = resample(x, a.sr, sr).astype(np.float32)
    if source_bpm:
        return _synced_loop(x, sr, float(source_bpm), bpm, bars, semitones, settings)
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


def _synced_loop(x: np.ndarray, sr: int, source_bpm: float, bpm: float, bars: int, semitones: int,
                 settings: Settings) -> np.ndarray:
    """A loop with a rhythm at the track tempo: its whole bars (no more than the bed's), stretched
    (and moved) as one cycle, laid end to end on the bar grid with no crossfade: each repeat starts
    on its bar line, sample-exact, so it never drifts off the drums."""
    sb = min(loop_bars(x.shape[0], sr, source_bpm), max(1, int(bars)))
    n_src = bar_frames(sb, source_bpm, sr)
    x = x[:n_src] if x.shape[0] >= n_src else np.pad(x, ((0, n_src - x.shape[0]), (0, 0)))
    cycle = sb * 240.0 / bpm * sr          # the loop's length at the track tempo, in frames (not whole)
    if abs(cycle - n_src) < 0.5 and not semitones:
        y = x
    else:
        # Three times round, the middle one kept: Rubber Band's edges fall outside it, and its ends
        # are the loop running into itself, so the repeats join as the loop does.
        y3 = stretch.stretch_pitch(np.concatenate([x, x, x]), sr, int(round(3 * cycle)), semitones, settings)
        y = y3[int(round(cycle)):int(round(cycle)) + int(np.ceil(cycle))]
    n = bar_frames(bars, bpm, sr)
    out = np.zeros((n, x.shape[1]), dtype=np.float32)
    k = 0
    while (start := int(round(k * cycle))) < n:
        end = min(n, int(round((k + 1) * cycle)), start + y.shape[0])
        out[start:end] = y[:end - start]
        k += 1
    return np.ascontiguousarray(out)


__all__ = ["make_loop", "tonality", "is_tonal", "named_noise", "loop_bpm", "whole_bars"]
