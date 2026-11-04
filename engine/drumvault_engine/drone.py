"""Drones (SCOPE.md §6.10): an ambience in the track key that runs under the track, made into a
seamless loop at the track tempo.

The source is a sample from the Drones page, moved into the key like a sampler would (and maybe an
octave), then warped by the track's rule: as it is, slowed down 2× or 4× with its pitch kept (a
smear), or reversed; the loop takes it from a point of its own in the sound (`start`), so the same
sample sounds different in every track. (Older tracks' drones held a note through a Serum 2 pad.)
It is washed out: high- and low-passed (out of the bass's way, dark), then reverb into reverb until
no attack is left. The loop is cut from where the wash has built up (`drone_settle_s`), and its end
is crossfaded into its start (equal power), so it repeats without a seam. Then its rhythm, a track
rule: none (the lane's sidechain does the pumping), a soft 8th, 16th or dotted-8th gate, swells
peaking on every offbeat, or chopped (its 16ths from a few places in the sound, in a 1-bar
pattern). Loudness-matched like the bass renders.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from .audioutil import resample
from .config import Settings, Thresholds

RHYTHMS = ("pump", "gate8", "gate16", "swell", "dotted", "chop")
WARPS = ("none", "slow2", "slow4", "reverse")
# A dotted-8th gate: 16ths of each bar it opens on, open for 2 16ths each (3-3-3-3-4).
DOTTED_ONSETS = (0, 3, 6, 9, 12)


def rhythm_envelope(n: int, sr: int, bpm: float, rhythm: str, th: Thresholds) -> np.ndarray:
    """Gain over a loop of `n` frames from its downbeat: 1 for "pump" and "chop" (chopped() makes
    its rhythm); a gate open for `drone_gate_duty` of each 8th or 16th with soft edges; a dotted-8th
    gate; or a swell up to every offbeat 8th. Never below `drone_gate_floor`."""
    if rhythm not in RHYTHMS:
        raise ValueError(f"Unknown drone rhythm: {rhythm}")
    if rhythm in ("pump", "chop"):
        return np.ones(n, dtype=np.float32)
    beat = 60.0 / bpm
    t = np.arange(n) / sr
    floor = th.drone_gate_floor
    if rhythm == "swell":
        shape = np.sin(np.pi * ((t % beat) / beat)) ** 2  # quiet on the beat, fullest on the offbeat
    elif rhythm == "dotted":
        pos = (t % (4 * beat)) / (beat / 4)  # 16ths into the bar
        e = th.drone_gate_edge * 2
        shape = np.zeros(n)
        for o in DOTTED_ONSETS:
            local = pos - o
            win = np.minimum(np.clip(local / e, 0, 1), np.clip((2 - local) / e, 0, 1))
            shape = np.maximum(shape, 0.5 - 0.5 * np.cos(np.pi * win))
    else:
        step = beat / (2 if rhythm == "gate8" else 4)
        ph = (t % step) / step
        e, d = th.drone_gate_edge, th.drone_gate_duty
        rise = np.clip(ph / e, 0, 1)
        fall = np.clip((d - ph) / e, 0, 1)
        shape = 0.5 - 0.5 * np.cos(np.pi * np.minimum(rise, fall))
    return (floor + (1 - floor) * shape).astype(np.float32)


def pitched(x: np.ndarray, sr: int, semitones: float) -> np.ndarray:
    """`x` played `semitones` higher or lower, faster or slower (a sampler: no stretching)."""
    if not semitones:
        return x
    return resample(x, sr, int(round(sr / 2 ** (semitones / 12))))


def tiled(x: np.ndarray, frames: int, overlap: int) -> np.ndarray:
    """`x` repeated with equal-power crossfades of `overlap` frames until it's `frames` long."""
    if len(x) >= frames:
        return x[:frames]
    overlap = max(1, min(overlap, len(x) // 2))
    k = np.arange(overlap) / overlap
    fin, fout = np.sin(np.pi / 2 * k)[:, None], np.cos(np.pi / 2 * k)[:, None]
    out = x.copy()
    while len(out) < frames:
        joined = out[-overlap:] * fout + x[:overlap] * fin
        out = np.concatenate([out[:-overlap], joined, x[overlap:]])
    return out[:frames]


def wash(x: np.ndarray, sr: int, th: Thresholds) -> np.ndarray:
    """High- and low-passed, then reverb into reverb (`drone_reverb_passes`), (n, 2) float32."""
    from pedalboard import HighpassFilter, LowpassFilter, Pedalboard, Reverb
    fx = [HighpassFilter(th.drone_hp_hz), LowpassFilter(th.drone_lp_hz)]
    fx += [Reverb(room_size=th.drone_reverb_room, damping=th.drone_reverb_damping, wet_level=th.drone_reverb_wet,
                  dry_level=th.drone_reverb_dry, width=1.0) for _ in range(th.drone_reverb_passes)]
    return np.asarray(Pedalboard(fx)(np.ascontiguousarray(x.T), sr), dtype=np.float32).T


def seamless(y: np.ndarray, start: int, n: int, fade: int) -> np.ndarray:
    """`n` frames of `y` from `start`, the `fade` frames after them crossfaded over its first ones
    (equal power): its last frame runs on into its first as `y` would have gone on."""
    out = y[start:start + n].copy()
    tail = y[start + n:start + n + fade]
    fade = len(tail)
    if fade:
        k = np.arange(fade) / fade
        out[:fade] = out[:fade] * np.sin(np.pi / 2 * k)[:, None] + tail * np.cos(np.pi / 2 * k)[:, None]
    return out


def loop_frames(bpm: float, bars: int, sr: int) -> int:
    return int(round(bars * 4 * 60.0 / bpm * sr))


def source_frames(bpm: float, bars: int, sr: int, th: Thresholds) -> int:
    """How much source a loop needs: the settling, the loop and the crossfade after it."""
    return (int(round(th.drone_settle_s * sr)) + loop_frames(bpm, bars, sr)
            + int(round(th.drone_loop_fade_beats * 60.0 / bpm * sr)))


def warped(x: np.ndarray, sr: int, warp: str, settings: Settings) -> np.ndarray:
    """`x` as the track's warp has it: as it is, 2× or 4× as long with its pitch kept, or reversed."""
    if warp not in WARPS:
        raise ValueError(f"Unknown drone warp: {warp}")
    if warp == "reverse":
        return np.ascontiguousarray(x[::-1])
    if warp in ("slow2", "slow4"):
        from .stretch import stretch_by
        return stretch_by(x, sr, 2.0 if warp == "slow2" else 4.0, settings)
    return x


def from_start(x: np.ndarray, start: float, need: int) -> np.ndarray:
    """`x` from `start` (0…1) of the way into what can go before the loop's `need` frames run out:
    the same sample, another part of it. A sample shorter than that plays from its beginning."""
    room = len(x) - need
    return x[int(start * room):] if room > 0 else x


def chopped(y: np.ndarray, at: int, n: int, sr: int, bpm: float, th: Thresholds, seed: int) -> np.ndarray:
    """`n` frames of 16ths, each from one of `drone_chop_places` places in `y` after `at` (the
    same place played on runs, so it moves in a rhythm, not at random), in a 1-bar pattern that
    repeats; every 16th faded in and out (`drone_chop_fade_ms`), the loop's ends too."""
    rng = np.random.default_rng(seed)
    s16 = 60.0 / bpm / 4 * sr
    steps = int(round(n / s16))
    count = max(1, int(n // s16))  # where a place may be: any 16th of the loop's length after `at`
    places = at + rng.choice(count, size=th.drone_chop_places, replace=count < th.drone_chop_places) * s16
    pattern, v = [], 0
    for _ in range(16):
        if rng.random() < 0.45:
            v = int(rng.integers(0, th.drone_chop_places))
        pattern.append(v)
    out = np.zeros((n, y.shape[1]), dtype=np.float32)
    f = max(1, int(th.drone_chop_fade_ms * sr / 1000))
    for k in range(steps):
        a, b = int(round(k * s16)), min(n, int(round((k + 1) * s16)))
        src = int(places[pattern[k % 16]]) + a
        seg = y[src:src + (b - a)]
        seg = np.pad(seg, ((0, (b - a) - len(seg)), (0, 0))) if len(seg) < b - a else seg.copy()
        ff = min(f, len(seg) // 2)
        if ff:
            ramp = np.linspace(0.0, 1.0, ff, dtype=np.float32)[:, None]
            seg[:ff] *= ramp
            seg[-ff:] *= ramp[::-1]
        out[a:b] = seg
    return out


def make_loop(source: np.ndarray, sr: int, bpm: float, bars: int, rhythm: str, th: Thresholds, seed: int = 0) -> np.ndarray:
    """A drone loop of `bars` at `bpm` from `source` (stereo, at least `source_frames` long, or a
    short sample that is repeated to fill it); `seed` picks a chopped drone's places and pattern."""
    n = loop_frames(bpm, bars, sr)
    settle = int(round(th.drone_settle_s * sr))
    need = source_frames(bpm, bars, sr, th) + (n if rhythm == "chop" else 0)
    x = tiled(source, need, int(round(th.drone_tile_overlap_s * sr)))
    y = wash(x, sr, th)
    if rhythm == "chop":
        return chopped(y, settle, n, sr, bpm, th, seed)
    loop = seamless(y, settle, n, int(round(th.drone_loop_fade_beats * 60.0 / bpm * sr)))
    return np.ascontiguousarray(loop * rhythm_envelope(n, sr, bpm, rhythm, th)[:, None], dtype=np.float32)


def sample_source(settings: Settings, rel_path: str, semitones: float) -> np.ndarray:
    """A Drones page sample, stereo at the library rate, moved `semitones` into the key."""
    from .audioutil import load
    lib = Path(settings.library_path)
    f = lib / rel_path
    if ".." in Path(rel_path).parts or not f.exists():
        raise FileNotFoundError(rel_path)
    a = load(f)
    x = a.data if a.data.shape[1] == 2 else np.repeat(a.data[:, :1], 2, axis=1)
    x = resample(x, a.sr, settings.output_sample_rate)
    return pitched(x, settings.output_sample_rate, semitones)


def serum_seconds(bpm: float, bars: int, sr: int, th: Thresholds) -> float:
    """Seconds of a held note a loop needs (rendered whole: no repeating a synth)."""
    return math.ceil(source_frames(bpm, bars, sr, th) / sr) + 1.0
