"""Peak / loudness normalisation (SCOPE.md §5.9)."""

from __future__ import annotations

import logging

import numpy as np

from .audioutil import amp_to_db, db_to_amp, peak

log = logging.getLogger(__name__)


def peak_normalize(x: np.ndarray, target_dbfs: float) -> tuple[np.ndarray, float, float]:
    """Scale so the peak sits at `target_dbfs`. Returns (audio, original peak dB, gain dB)."""
    p = peak(x)
    if p <= 0:
        return x, -240.0, 0.0
    peak_db = amp_to_db(p)
    gain_db = target_dbfs - peak_db
    return (x * db_to_amp(gain_db)).astype(np.float32), peak_db, gain_db


def loudness_normalize(x: np.ndarray, sr: int, target_lufs: float, ceiling_dbfs: float
                       ) -> tuple[np.ndarray, float, float]:
    """Normalise integrated loudness to `target_lufs`, never exceeding `ceiling_dbfs` peak.

    Loops are short (often under the 3 s short-term window), so integrated
    loudness over the whole loop stands in for "short-term" loudness here.
    """
    import pyloudnorm

    p = peak(x)
    if p <= 0:
        return x, -240.0, 0.0
    peak_db = amp_to_db(p)
    try:
        lufs = pyloudnorm.Meter(sr).integrated_loudness(x.astype(np.float64))
    except ValueError:  # shorter than one 400 ms gating block
        lufs = float("-inf")
    if not np.isfinite(lufs):
        return peak_normalize(x, ceiling_dbfs)
    gain_db = min(target_lufs - lufs, ceiling_dbfs - peak_db)
    return (x * db_to_amp(gain_db)).astype(np.float32), peak_db, gain_db
