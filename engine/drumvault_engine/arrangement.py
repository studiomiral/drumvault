"""Where each part plays in the source track, bar by bar (the generator's structure templates).

Every stem of a zip is measured on the track's own grid (its BPM and bar 1) and grouped into the
generator's parts: kick, clap, hats, ride, perc, top, crash, fills, fx, bass, music. Each bar of a
part is "0" (silent), "1" (playing quietly or filtered) or "2" (full), relative to the part's own
full level. The app turns these into sections and track rules (app/src/generate/template.ts).

For the producer's rides (filter and fader moves) each part's bars are also measured finer: dB
against the part's full level, and brightness in octaves against its median in full bars (below
zero: darker, a low-pass; above: thinner, a high-pass). Null where the part is silent.

And the producer's balance: each part's K-weighted loudness in its full bars (LUFS of the mono
mix, ungated), which the app takes as reference levels, unless the stems were normalised one by
one (most of them peaking at full scale), when the balance is not the producer's. With it each
part's tone: its power in the 24 bands over its full bars, in dB against its total (the app's EQ
matches lanes to it; samples get the same measure, `tone`).
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np

from .audioutil import amp_to_db, k_weight
from .classify import is_bass
from .config import Thresholds

PART_OF = {
    "kick": "kick", "clap": "clap", "snare": "clap",
    "hat": "hats", "hat_closed": "hats", "hat_open": "hats", "shaker": "hats",
    "ride": "ride", "perc": "perc", "top": "top", "groove": "top", "drums": "top", "cymbal": "crash",
    "fill": "fills", "roll": "fills",
    "fx_riser": "fx", "fx_downlifter": "fx", "fx_impact": "fx", "fx_sweep": "fx", "fx_atmos": "fx", "fx": "fx",
}


# Stems that play where their part does but aren't its level: a full drum loop is mostly its kick.
BALANCE_SKIP = {"drums"}


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


def _tone_db(power: np.ndarray) -> list[float] | None:
    total = float(power.sum())
    if total <= 0:
        return None
    return [round(float(v), 1) for v in 10 * np.log10(np.maximum(power / total, 1e-9))]


def tone(x: np.ndarray, sr: int, th: Thresholds) -> list[float] | None:
    """A sound's tone (its mono mix): power in the arrangement bands, dB against its total; None when silent."""
    mono = x.mean(axis=1) if x.ndim == 2 else x
    if mono.size < 64:
        return None
    edges = np.geomspace(th.arrangement_band_lo_hz, th.arrangement_band_hi_hz, th.arrangement_bands + 1)
    spec = np.abs(np.fft.rfft(mono.astype(np.float64))) ** 2
    idx = np.searchsorted(np.fft.rfftfreq(mono.size, 1.0 / sr), edges)
    return _tone_db(np.array([spec[idx[i]:idx[i + 1]].sum() for i in range(th.arrangement_bands)]))


def brightness(bands: np.ndarray, th: Thresholds) -> np.ndarray:
    """Power-weighted mean log2 band centre per bar (NaN for silent bars)."""
    edges = np.geomspace(th.arrangement_band_lo_hz, th.arrangement_band_hi_hz, th.arrangement_bands + 1)
    centres = np.log2(np.sqrt(edges[:-1] * edges[1:]))
    total = bands.sum(axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(total > 0, (bands * centres).sum(axis=1) / total, np.nan)


def measure(stems: list[tuple[str, str, np.ndarray | Callable[[], np.ndarray], int]], bpm: float, bar_one_s: float,
            th: Thresholds) -> dict | None:
    """`stems`: (name, category, mono or a function loading it, sample rate). One stem at a time
    is in memory when they come as functions (a track can have 40 stems of 6 minutes).
    {"bpm", "bars", "parts": {part: "0012…"}, "detail": {part: {"db": [...], "bright": [...]}},
    "levels": {"parts": {part: LUFS}, "normalized": bool, "spectra": {part: [24 dB]}}}."""
    stems = [(n, c, m, sr) for n, c, m, sr in stems if part_of(n, c)]
    if not stems:
        return None
    if bar_one_s < 0:
        bar_one_s += 240.0 / bpm  # hits ahead of the first downbeat: the grid starts a bar later
    # Each stem measured over the bars it reaches (the last one partly), then all of them over the
    # whole bars of the longest.
    per: list[tuple[str, str, np.ndarray, np.ndarray | None, np.ndarray]] = []
    peaks: list[float] = []
    reach = 0.0
    for n, c, m, sr in stems:
        mono = m() if callable(m) else m
        span = (len(mono) / sr - bar_one_s) / (240.0 / bpm)
        reach = max(reach, span)
        own = max(0, int(np.ceil(span)))
        per.append((n, c, bar_power(mono, sr, bpm, bar_one_s, own),
                    bar_power(k_weight(mono, sr), sr, bpm, bar_one_s, own) if c not in BALANCE_SKIP else None,
                    bar_bands(mono, sr, bpm, bar_one_s, own, th)))
        peaks.append(amp_to_db(float(np.max(np.abs(mono)))) if mono.size else -240.0)
        del mono
    bars = int(reach)
    if bars < 1:
        return None
    fit = lambda a: np.pad(a[:bars], [(0, max(0, bars - len(a)))] + [(0, 0)] * (a.ndim - 1))  # noqa: E731
    power: dict[str, np.ndarray] = {}
    kpower: dict[str, np.ndarray] = {}
    bands: dict[str, np.ndarray] = {}
    tbands: dict[str, np.ndarray] = {}
    for n, c, pw_, kpw, bb in per:
        p = part_of(n, c)
        power[p] = power.get(p, np.zeros(bars)) + fit(pw_)
        if kpw is not None:
            kpower[p] = kpower.get(p, np.zeros(bars)) + fit(kpw)
        bands[p] = bands.get(p, np.zeros((bars, th.arrangement_bands))) + fit(bb)
        if c not in BALANCE_SKIP:
            tbands[p] = tbands.get(p, np.zeros((bars, th.arrangement_bands))) + fit(bb)
    parts = {}
    detail = {}
    levels = {}
    spectra = {}
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
        kfull = kpower[p][state == 2] if p in kpower else np.zeros(0)
        if kfull.size and kfull.mean() > 0:
            levels[p] = round(-0.691 + 10 * float(np.log10(kfull.mean())), 1)
        if p in tbands and (state == 2).any():
            t = _tone_db(tbands[p][state == 2].sum(axis=0))
            if t:
                spectra[p] = t
        detail[p] = {
            "db": [round(float(d - full), 1) if on else None for d, on in zip(db, playing)],
            "bright": [round(float(b - mid), 2) if on and np.isfinite(b) else None for b, on in zip(bright, playing)],
        }
    hot = sum(1 for d in peaks if d >= th.arrangement_normalized_peak_db)
    normalized = len(peaks) >= th.arrangement_normalized_min_stems and hot >= th.arrangement_normalized_share * len(peaks)
    return {"bpm": float(bpm), "bars": bars, "parts": parts, "detail": detail,
            "levels": {"parts": levels, "normalized": bool(normalized), "spectra": spectra}} if parts else None
