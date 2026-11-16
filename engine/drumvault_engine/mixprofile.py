"""A whole mix measured (SCOPE.md §5.16): what the pre-flight checks of an export's masters and what
a reference track is remembered as. One measurement for both, so a render is held against the
references like for like.

On the track's grid (its BPM, bar 1 at `bar_one_s`), bar by bar: the K-weighted loudness (both
sides' power summed, as BS.1770 does), the lows, and the power in the arrangement bands. From
those the bars where the track is full (its drops: given, as the sections of a generated track, or
found: the loud bars with the low end in), and over them the tone in five regions, how wide the
mix is and how much of its low end sits in the sides. Around every drop its lift: how much louder,
and how much more low end, its first bars are than the bars before. And of the file as a whole:
integrated loudness, peak and true peak, DC, where the sound starts and how the file ends, and
whether a kick plays on every beat through the first and the last bars (the DJ's mix-in and
mix-out).
"""

from __future__ import annotations

import numpy as np

from .arrangement import bar_bands, bar_power
from .audioutil import k_weight
from .config import Thresholds

EPS = 1e-12


def _db(power: float) -> float:
    return 10 * float(np.log10(max(power, EPS)))


def _lowpass(x: np.ndarray, sr: int, hz: float) -> np.ndarray:
    from scipy.signal import butter, sosfilt
    return sosfilt(butter(4, hz, btype="lowpass", fs=sr, output="sos"), x.astype(np.float64))


def integrated_lufs(data: np.ndarray, sr: int) -> float | None:
    """Integrated loudness (BS.1770-4, gated) of (frames, channels) audio; None when silent or too short."""
    if data.shape[0] < int(0.4 * sr) + 1:
        return None
    import pyloudnorm
    lu = float(pyloudnorm.Meter(sr).integrated_loudness(data))
    return lu if np.isfinite(lu) else None


def true_peak_db(data: np.ndarray, th: Thresholds, block: int = 4096) -> float | None:
    """The peak between the samples too (dBTP): the blocks peaking within
    `profile_true_peak_window_db` of the highest sample, oversampled. None when silent."""
    from scipy.signal import resample_poly
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    if peak <= 0:
        return None
    n = data.shape[0]
    floor = peak * 10 ** (-th.profile_true_peak_window_db / 20)
    pad = n % block
    body = np.abs(data[:n - pad]).max(axis=1).reshape(-1, block).max(axis=1) if n >= block else np.zeros(0)
    hot = list(np.flatnonzero(body >= floor)[np.argsort(-body[body >= floor])][:64]) if body.size else []
    best = peak
    spans = [(max(0, int(i) * block - 64), min(n, (int(i) + 1) * block + 64)) for i in hot] or [(0, n)]
    if pad and float(np.max(np.abs(data[n - pad:]))) >= floor:
        spans.append((max(0, n - pad - 64), n))
    for a, z in spans:
        up = resample_poly(data[a:z].astype(np.float64), th.profile_true_peak_oversample, 1, axis=0)
        best = max(best, float(np.max(np.abs(up))))
    return round(20 * float(np.log10(best)), 2)


def beat_pulse_db(low: np.ndarray, sr: int, bpm: float, start_s: float, beats: int, share: float) -> float | None:
    """How much stronger `low` (the mix's lows) is at the start of each beat than in the rest of
    it, in dB: a kick on every beat puts its weight in the first `share` of the beat; a held bass
    is even (0), nothing but offbeats is below it. None when there is nothing there."""
    beat = 60.0 / bpm * sr
    on = off = 0.0
    n_on = n_off = 0
    for b in range(beats):
        a = int(round(start_s * sr + b * beat))
        m = int(round(start_s * sr + (b + share) * beat))
        z = int(round(start_s * sr + (b + 1) * beat))
        if a < 0 or z > low.size:
            continue
        on += float(np.sum(np.square(low[a:m])))
        off += float(np.sum(np.square(low[m:z])))
        n_on += m - a
        n_off += z - m
    if not n_on or not n_off or on + off <= EPS:
        return None
    return round(_db(on / n_on) - _db(off / n_off), 1)


def full_bars(lufs: np.ndarray, low_db: np.ndarray, th: Thresholds) -> np.ndarray:
    """Without sections: the bars where the track is full, loud and with the low end in. A stretch
    of kick and hats as loud as that counts too: in the user's own tracks it is 1 to 4 LU under
    the drops, so loudness alone doesn't tell them apart; the tone and the width are then taken
    over both, and a drop is still where the track comes up after bars that aren't full."""
    sounding = lufs > -70
    if not sounding.any():
        return np.zeros(lufs.size, dtype=bool)
    top = float(np.percentile(lufs[sounding], th.profile_full_pct))
    top_low = float(np.percentile(low_db[sounding], th.profile_full_pct))
    return sounding & (lufs >= top + th.profile_full_rel_lu) & (low_db >= top_low + th.profile_full_low_rel_db)


def drop_runs(full: np.ndarray, th: Thresholds) -> list[tuple[int, int]]:
    """The drops among the full bars: runs [from, to) of at least `profile_drop_min_bars`, short
    gaps bridged, each after `profile_drop_before_bars` that aren't full (so the track's start,
    if it starts full, is no drop: nothing leads into it)."""
    runs: list[list[int]] = []
    for b in np.flatnonzero(full):
        if runs and b - runs[-1][1] <= th.profile_drop_gap_bars:
            runs[-1][1] = int(b) + 1
        else:
            runs.append([int(b), int(b) + 1])
    out = []
    for a, z in runs:
        before = full[max(0, a - th.profile_drop_before_bars):a]
        if z - a >= th.profile_drop_min_bars and a >= th.profile_drop_before_bars and not before.any():
            out.append((a, z))
    return out


def measure(data: np.ndarray, sr: int, bpm: float, bar_one_s: float, th: Thresholds,
            drops: list[tuple[int, int]] | None = None) -> dict:
    """The profile of (frames, 2) audio at `bpm` with bar 1 at `bar_one_s`. `drops`: its drops as
    bars [from, to), where they are known (a generated track's sections); found when None."""
    if data.ndim == 1:
        data = data[:, None]
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    data = data[:, :2]
    frames = data.shape[0]
    bar_s = 240.0 / bpm
    bars = max(0, int((frames / sr - bar_one_s) / bar_s + 0.01))  # a file a few samples short of its last bar still has it
    left, right = data[:, 0], data[:, 1]
    mid, side = (left + right) / 2, (left - right) / 2
    grid = (sr, bpm, bar_one_s, bars)

    kpow = bar_power(k_weight(left, sr), *grid) + bar_power(k_weight(right, sr), *grid)
    lufs = -0.691 + 10 * np.log10(np.maximum(kpow, EPS))
    bands = bar_bands(mid, sr, bpm, bar_one_s, bars, th)
    edges = np.geomspace(th.arrangement_band_lo_hz, th.arrangement_band_hi_hz, th.arrangement_bands + 1)
    centres = np.sqrt(edges[:-1] * edges[1:])
    low_mid = _lowpass(mid, sr, th.profile_low_hz)
    low_pow = bar_power(low_mid, *grid)
    low_db = 10 * np.log10(np.maximum(low_pow, EPS))

    known = drops is not None
    if known:
        full = np.zeros(bars, dtype=bool)
        for a, z in drops:
            full[max(0, a):max(0, min(bars, z))] = True
        runs = [(max(0, a), min(bars, z)) for a, z in drops if min(bars, z) > max(0, a)]
    else:
        full = full_bars(lufs, low_db, th) if bars else np.zeros(0, dtype=bool)
        runs = drop_runs(full, th)

    out: dict = {
        "seconds": round(frames / sr, 2), "bpm": float(bpm), "bars": bars, "sections_known": known,
        "lufs": None, "peak_db": None, "true_peak_db": None, "plr_db": None,
        "bar_lufs": [round(float(v), 1) if v > -100 else None for v in lufs],
        "full_bars": int(full.sum()), "full_lufs": None, "regions": None, "width_db": None, "low_side_db": None,
        "drops": [], "lift_lu": None, "lift_low_db": None, "break_depth_lu": None,
        "dc_db": None, "head_ms": None, "tail_db": None, "intro": None, "outro": None,
    }
    lu = integrated_lufs(data, sr)
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    if lu is not None:
        out["lufs"] = round(lu, 2)
    if peak > 0:
        out["peak_db"] = round(20 * float(np.log10(peak)), 2)
        out["true_peak_db"] = true_peak_db(data, th)
        if lu is not None:
            out["plr_db"] = round(out["true_peak_db"] - lu, 2)
        out["dc_db"] = round(20 * float(np.log10(max(float(np.max(np.abs(data.mean(axis=0, dtype=np.float64)))), 1e-9))), 1)
        over = np.flatnonzero(np.abs(data).max(axis=1) > 10 ** (th.profile_head_db / 20))
        out["head_ms"] = round(float(over[0]) / sr * 1000, 1) if over.size else None
        tail = data[-max(1, int(th.profile_tail_ms / 1000 * sr)):]
        out["tail_db"] = round(20 * float(np.log10(max(float(np.max(np.abs(tail))), 1e-9))), 1)

    if full.any():
        out["full_lufs"] = round(-0.691 + _db(float(kpow[full].mean())), 2)
        total = bands[full].sum(axis=0)
        if total.sum() > 0:
            r = th.profile_region_edges_hz
            out["regions"] = [round(_db(float(total[(centres >= r[i]) & (centres < r[i + 1])].sum()) / float(total.sum())), 1)
                              for i in range(len(r) - 1)]
        mid_pow, side_pow = bar_power(mid, *grid)[full].sum(), bar_power(side, *grid)[full].sum()
        if mid_pow > 0:
            out["width_db"] = round(_db(float(side_pow)) - _db(float(mid_pow)), 1)
        low_side = bar_power(_lowpass(side, sr, th.profile_mono_hz), *grid)[full].sum()
        low_m = bar_power(_lowpass(mid, sr, th.profile_mono_hz), *grid)[full].sum()
        if low_m > 0:
            out["low_side_db"] = round(max(-60.0, _db(float(low_side)) - _db(float(low_m))), 1)

    n = th.profile_lift_bars
    for a, z in runs:
        d: dict = {"bar": a, "bars": z - a, "lufs": round(-0.691 + _db(float(kpow[a:z].mean())), 2),
                   "lift_lu": None, "lift_low_db": None}
        w = min(n, z - a, a)
        if w >= 1 and kpow[a - w:a].mean() > EPS:
            d["lift_lu"] = round(_db(float(kpow[a:a + w].mean())) - _db(float(kpow[a - w:a].mean())), 1)
            d["lift_low_db"] = round(min(40.0, _db(float(low_pow[a:a + w].mean())) - _db(float(low_pow[a - w:a].mean()))), 1)
        out["drops"].append(d)
    lifts = [d["lift_lu"] for d in out["drops"] if d["lift_lu"] is not None]
    if lifts:
        out["lift_lu"] = round(float(np.median(lifts)), 1)
        out["lift_low_db"] = round(float(np.median([d["lift_low_db"] for d in out["drops"] if d["lift_low_db"] is not None])), 1)
    if len(runs) >= 2 and out["full_lufs"] is not None:
        # The deepest the track goes between its first and its last drop, a phrase at a time.
        a, z = runs[0][1], runs[-1][0]
        if z - a >= n:
            c = np.concatenate([[0.0], np.cumsum(kpow[a:z])])
            quiet = float((c[n:] - c[:-n]).min()) / n
            out["break_depth_lu"] = round(min(40.0, out["full_lufs"] - (-0.691 + _db(quiet))), 1)

    dj = min(th.profile_dj_bars, bars)
    if dj >= 1:
        ref_low = _db(float(low_pow[full].mean())) if full.any() else None
        for name, start in (("intro", 0), ("outro", bars - dj)):
            lows = _db(float(low_pow[start:start + dj].mean()))
            out[name] = {
                "bars": dj,
                "pulse_db": beat_pulse_db(low_mid, sr, bpm, bar_one_s + start * bar_s, dj * 4, th.profile_pulse_share),
                "low_rel_db": round(max(-60.0, lows - ref_low), 1) if ref_low is not None else None,
            }
    return out
