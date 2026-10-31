"""Where each part plays in the source track, bar by bar (the generator's structure templates).

Every stem of a zip is measured on the track's own grid (its BPM and bar 1) and grouped into the
generator's parts: kick, clap, hats, ride, perc, top, crash, fills, fx, bass, music. Each bar of a
part is "0" (silent), "1" (playing quietly or filtered) or "2" (full), relative to the part's own
full level. The app turns these into sections and track rules (app/src/generate/template.ts).

For the producer's rides (filter and fader moves) each part's bars are also measured finer: dB
against the part's full level, and brightness in octaves against its median in full bars (below
zero: darker, a low-pass; above: thinner, a high-pass). Null where the part is silent.
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


def bar_bands(mono: np.ndarray, sr: int, bpm: float, bar_one_s: float, bars: int, th: Thresholds) -> np.ndarray:
    """Power of each bar in log-spaced bands, (bars, bands)."""
    edges = np.geomspace(th.arrangement_band_lo_hz, th.arrangement_band_hi_hz, th.arrangement_bands + 1)
    bar = 240.0 / bpm * sr
    start = bar_one_s * sr
    out = np.zeros((bars, th.arrangement_bands))
    for b in range(bars):
        a, z = int(round(start + b * bar)), int(round(start + (b + 1) * bar))
        seg = mono[max(0, a):max(0, z)]
        if seg.size < 64:
            continue
        spec = np.abs(np.fft.rfft(seg.astype(np.float64))) ** 2
        freqs = np.fft.rfftfreq(seg.size, 1.0 / sr)
        idx = np.searchsorted(freqs, edges)
        out[b] = [spec[idx[i]:idx[i + 1]].sum() for i in range(th.arrangement_bands)]
    return out


def brightness(bands: np.ndarray, th: Thresholds) -> np.ndarray:
    """Power-weighted mean log2 band centre per bar (NaN for silent bars)."""
    edges = np.geomspace(th.arrangement_band_lo_hz, th.arrangement_band_hi_hz, th.arrangement_bands + 1)
    centres = np.log2(np.sqrt(edges[:-1] * edges[1:]))
    total = bands.sum(axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(total > 0, (bands * centres).sum(axis=1) / total, np.nan)


def measure(stems: list[tuple[str, str, np.ndarray, int]], bpm: float, bar_one_s: float,
            th: Thresholds) -> dict | None:
    """`stems`: (name, category, mono, sample rate). {"bpm", "bars", "parts": {part: "0012…"},
    "detail": {part: {"db": [...], "bright": [...]}}}."""
    stems = [(n, c, m, sr) for n, c, m, sr in stems if part_of(n, c)]
    if not stems:
        return None
    if bar_one_s < 0:
        bar_one_s += 240.0 / bpm  # hits ahead of the first downbeat: the grid starts a bar later
    bars = int(max((len(m) / sr - bar_one_s) / (240.0 / bpm) for _, _, m, sr in stems))
    if bars < 1:
        return None
    power: dict[str, np.ndarray] = {}
    bands: dict[str, np.ndarray] = {}
    for n, c, m, sr in stems:
        p = part_of(n, c)
        power[p] = power.get(p, np.zeros(bars)) + bar_power(m, sr, bpm, bar_one_s, bars)
        bands[p] = bands.get(p, np.zeros((bars, th.arrangement_bands))) + bar_bands(m, sr, bpm, bar_one_s, bars, th)
    parts = {}
    detail = {}
    for p, pw in sorted(power.items()):
        db = 10 * np.log10(np.maximum(pw, 1e-12))
        loud = db[db > th.arrangement_silence_db]
        if not loud.size:
            continue
        full = float(np.percentile(loud, th.arrangement_reference_pct))
        state = np.where(db < max(th.arrangement_silence_db, full + th.arrangement_quiet_rel_db), 0,
                         np.where(db < full + th.arrangement_full_rel_db, 1, 2))
        parts[p] = "".join(str(int(v)) for v in state)
        bright = brightness(bands[p], th)
        ref = bright[(state == 2) & np.isfinite(bright)]
        mid = float(np.median(ref)) if ref.size else float(np.nanmedian(bright))
        playing = state > 0
        detail[p] = {
            "db": [round(float(d - full), 1) if on else None for d, on in zip(db, playing)],
            "bright": [round(float(b - mid), 2) if on and np.isfinite(b) else None for b, on in zip(bright, playing)],
        }
    return {"bpm": float(bpm), "bars": bars, "parts": parts, "detail": detail} if parts else None
