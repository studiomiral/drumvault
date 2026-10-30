"""Where each part plays in the source track, bar by bar (the generator's structure templates).

Every stem of a zip is measured on the track's own grid (its BPM and bar 1) and grouped into the
generator's parts: kick, clap, hats, ride, perc, top, crash, fills, fx, bass, music. Each bar of a
part is "0" (silent), "1" (playing quietly or filtered) or "2" (full), relative to the part's own
full level. The app turns these into sections and track rules (app/src/generate/template.ts).
"""

from __future__ import annotations

import numpy as np

from .classify import is_bass
from .config import Thresholds

PART_OF = {
    "kick": "kick", "clap": "clap", "snare": "clap",
    "hat": "hats", "hat_closed": "hats", "hat_open": "hats", "shaker": "hats",
    "ride": "ride", "perc": "perc", "top": "top", "groove": "top", "drums": "top", "cymbal": "crash",
    "fill": "fills", "roll": "fills",
    "fx_riser": "fx", "fx_downlifter": "fx", "fx_impact": "fx", "fx_sweep": "fx", "fx_atmos": "fx", "fx": "fx",
}


def part_of(name: str, category: str) -> str | None:
    if category == "melodic":
        return "bass" if is_bass(name) else "music"
    return PART_OF.get(category)


def bar_power(mono: np.ndarray, sr: int, bpm: float, bar_one_s: float, bars: int) -> np.ndarray:
    """Mean square of each bar from bar 1 (zero past the end of the stem)."""
    bar = 240.0 / bpm * sr
    start = bar_one_s * sr
    out = np.zeros(bars)
    for b in range(bars):
        a, z = int(round(start + b * bar)), int(round(start + (b + 1) * bar))
        seg = mono[max(0, a):max(0, z)]
        if seg.size:
            out[b] = float(np.mean(np.square(seg, dtype=np.float64)))
    return out


def measure(stems: list[tuple[str, str, np.ndarray, int]], bpm: float, bar_one_s: float,
            th: Thresholds) -> dict | None:
    """`stems`: (name, category, mono, sample rate). {"bpm", "bars", "parts": {part: "0012…"}}."""
    stems = [(n, c, m, sr) for n, c, m, sr in stems if part_of(n, c)]
    if not stems:
        return None
    if bar_one_s < 0:
        bar_one_s += 240.0 / bpm  # hits ahead of the first downbeat: the grid starts a bar later
    bars = int(max((len(m) / sr - bar_one_s) / (240.0 / bpm) for _, _, m, sr in stems))
    if bars < 1:
        return None
    power: dict[str, np.ndarray] = {}
    for n, c, m, sr in stems:
        p = part_of(n, c)
        power[p] = power.get(p, np.zeros(bars)) + bar_power(m, sr, bpm, bar_one_s, bars)
    parts = {}
    for p, pw in sorted(power.items()):
        db = 10 * np.log10(np.maximum(pw, 1e-12))
        loud = db[db > th.arrangement_silence_db]
        if not loud.size:
            continue
        full = float(np.percentile(loud, th.arrangement_reference_pct))
        state = np.where(db < max(th.arrangement_silence_db, full + th.arrangement_quiet_rel_db), 0,
                         np.where(db < full + th.arrangement_full_rel_db, 1, 2))
        parts[p] = "".join(str(int(v)) for v in state)
    return {"bpm": float(bpm), "bars": bars, "parts": parts} if parts else None
