"""Grid slicing, silence filter, dedupe and selection of loops (SCOPE.md §5.8)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .audioutil import cosine, db_to_amp, logmel_fingerprint, rms_db, to_mono
from .config import Settings, Thresholds


@dataclass
class Loop:
    data: np.ndarray          # (n, ch) float32 at the output rate, n = bars * bar_len
    sr: int
    bars: int
    start: int                # sample offset in the stretched stem
    fingerprint: np.ndarray
    faded_in: bool


def bar_length(sr: int, bpm: float) -> int:
    return int(round(sr * 60.0 / bpm * 4))


def slice_starts(n_samples: int, phase: int, seg_len: int) -> list[int]:
    """Non-overlapping slice starts phase + k * seg_len that fit entirely."""
    starts = []
    k = 0
    while phase + (k + 1) * seg_len <= n_samples:
        starts.append(phase + k * seg_len)
        k += 1
    return starts


def beat_levels(mono: np.ndarray, beat_len: float, start: int = 0) -> np.ndarray:
    """RMS dB of every whole beat from `start`."""
    n = int((len(mono) - start) // beat_len)
    edges = start + np.round(np.arange(n + 1) * beat_len).astype(int)
    return np.array([rms_db(mono[a:b]) for a, b in zip(edges[:-1], edges[1:])])


def reference_beat_db(mono: np.ndarray, beat_len: float, start: int, th: Thresholds) -> float:
    """Typical level of the stem's playing beats (median of non-silent beats)."""
    lv = beat_levels(mono, beat_len, start)
    lv = lv[lv >= th.loop_beat_silence_db]
    return float(np.median(lv)) if len(lv) else th.loop_beat_silence_db


def is_silent(mono: np.ndarray, beats: int, th: Thresholds, ref_db: float | None = None) -> bool:
    """Drop slices that are quiet overall, or silent on more than half their beats."""
    if rms_db(mono) < th.loop_silence_rms_db:
        return True
    floor = th.loop_beat_silence_db
    if ref_db is not None:
        floor = max(floor, ref_db + th.loop_beat_silence_rel_db)
    edges = np.round(np.linspace(0, len(mono), beats + 1)).astype(int)
    silent = sum(rms_db(mono[a:b]) < floor for a, b in zip(edges[:-1], edges[1:]))
    return silent / beats > th.loop_max_silent_beat_fraction


def dedupe(fps: list[np.ndarray], threshold: float) -> list[int]:
    """Indices of first occurrences; later near-duplicates are dropped."""
    kept: list[int] = []
    for i, f in enumerate(fps):
        if all(cosine(f, fps[j]) <= threshold for j in kept):
            kept.append(i)
    return kept


def farthest_point(fps: list[np.ndarray], cap: int) -> list[int]:
    """Greedy farthest-point selection, seeded with the first loop."""
    if len(fps) <= cap:
        return list(range(len(fps)))
    chosen = [0]
    dist = np.array([1.0 - cosine(fps[0], f) for f in fps])
    while len(chosen) < cap:
        dist[chosen] = -1.0
        nxt = int(np.argmax(dist))
        chosen.append(nxt)
        dist = np.minimum(dist, [1.0 - cosine(fps[nxt], f) for f in fps])
    return sorted(chosen)


def fade_in_if_needed(seg: np.ndarray, sr: int, th: Thresholds) -> tuple[np.ndarray, bool]:
    """1 ms fade-in only if the first sample isn't near zero. Never fade the end."""
    if np.max(np.abs(seg[0])) <= db_to_amp(th.loop_near_zero_db):
        return seg, False
    n = max(1, int(round(th.loop_fade_in_ms * sr / 1000)))
    seg = seg.copy()
    seg[:n] *= np.linspace(0.0, 1.0, n, endpoint=False, dtype=np.float32)[:, None]
    return seg, True


def extract_loops(data: np.ndarray, sr: int, phase: int, bpm: float, lengths: list[int],
                  settings: Settings) -> list[Loop]:
    """Cut loops of each length (in bars) on the grid of an already stretched stem."""
    th = settings.thresholds
    bar_len = bar_length(sr, bpm)
    mono = to_mono(data)
    ref_db = reference_beat_db(mono, bar_len / 4, phase, th)
    out: list[Loop] = []
    for bars in lengths:
        seg_len = bar_len * bars
        cands = []
        for s in slice_starts(len(mono), phase, seg_len):
            m = mono[s:s + seg_len]
            if is_silent(m, 4 * bars, th, ref_db):
                continue
            fp = logmel_fingerprint(m, sr, th, frames_per_chunk=th.loop_fingerprint_frames_per_bar * bars)
            cands.append((s, fp))
        if not cands:
            continue
        fps = [fp for _, fp in cands]
        uniq = dedupe(fps, settings.loop_dedupe_threshold)
        sel = farthest_point([fps[i] for i in uniq], settings.max_loops_per_length)
        for i in (uniq[j] for j in sel):
            s, fp = cands[i]
            seg, faded = fade_in_if_needed(np.array(data[s:s + seg_len], dtype=np.float32), sr, th)
            out.append(Loop(seg, sr, bars, s, fp, faded))
    return out
