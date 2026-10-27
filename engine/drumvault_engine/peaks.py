"""Waveform peak data for the UI (SCOPE.md §5.11)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .audioutil import to_mono


def compute_peaks(data: np.ndarray, n_points: int) -> list[list[float]]:
    """[min, max] pairs of the mono downmix over `n_points` equal buckets."""
    mono = to_mono(data)
    n_points = max(1, min(int(n_points), len(mono)))
    edges = np.linspace(0, len(mono), n_points + 1).astype(int)
    mins = np.minimum.reduceat(mono, edges[:-1])
    maxs = np.maximum.reduceat(mono, edges[:-1])
    return [[round(float(a), 4), round(float(b), 4)] for a, b in zip(mins, maxs)]


def peaks_for(data: np.ndarray, sr: int, kind: str, bars: int | None, th) -> dict:
    if kind == "loop":
        n = th.peaks_loop_per_bar * int(bars or 1)
    else:
        n = int(np.ceil(len(data) / sr * th.peaks_oneshot_per_second))
    pts = compute_peaks(data, n)
    return {"version": 1, "kind": kind, "sample_rate": sr, "frames": int(len(data)),
            "bars": bars, "points": pts}


def write_peaks(path: Path, peaks: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(peaks, separators=(",", ":")))
