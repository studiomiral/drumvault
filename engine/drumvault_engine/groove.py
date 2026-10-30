"""A loop's groove: how late or early its hits land per 16th step, and how loud.

Loops are cut on the grid of the source track's kick, so a hat played behind the beat really is
late here. The generator plays one-shot patterns (and the bass) with the groove of the track's
main loop, so they sit in the same pocket as the loops instead of dead on the grid, and it picks
loops of a similar swing to layer.

Offsets are fractions of a 16th (tempo independent; +0.33 = MPC 66 % swing on that step),
relative to the loop's own quarter notes when it plays any.
"""

from __future__ import annotations

import numpy as np

from .audioutil import attack_sample, causal_envelope, to_mono
from .config import Thresholds

STEPS = 16


def _weighted_median(x: np.ndarray, w: np.ndarray) -> float:
    order = np.argsort(x)
    x, w = x[order], w[order]
    c = np.cumsum(w)
    return float(x[int(np.searchsorted(c, c[-1] / 2))])


def hits(data: np.ndarray, sr: int, th: Thresholds, margin: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Attack times (samples) and peak levels (linear) of the loop's hits. The loop is cyclic: its
    end is put in front of it, so a hit on sample 0 (or a little early) is found too; attacks in
    [-margin, len - margin) are kept, each hit once."""
    import librosa

    mono = to_mono(data).astype(np.float32)
    if not np.any(mono):
        return np.zeros(0), np.zeros(0)
    pad = min(len(mono), int(0.25 * sr) + margin)
    y = np.concatenate([mono[len(mono) - pad:], mono])
    onsets = librosa.onset.onset_detect(y=y, sr=sr, hop_length=th.groove_hop, backtrack=True, units="samples")
    env = causal_envelope(y, int(th.groove_envelope_ms * sr / 1000))
    after = int(th.groove_attack_search_ms * sr / 1000)
    att, lvl = [], []
    for i, o in enumerate(onsets):
        stop = min(len(y), int(o) + after, int(onsets[i + 1]) if i + 1 < len(onsets) else len(y))
        a, p = attack_sample(env, max(0, int(o) - 2 * th.groove_hop), max(stop, int(o) + 1), th.groove_attack_rel)
        if -margin <= a - pad < len(mono) - margin:
            att.append(a - pad)
            lvl.append(env[p])
    return np.asarray(att, dtype=np.float64), np.asarray(lvl, dtype=np.float64)


def loop_groove(data: np.ndarray, sr: int, bpm: float, th: Thresholds) -> dict | None:
    """Per 16th step of the bar: median offset (16ths), level (dB below the loudest step) and hit
    count; plus `swing` (the odd 16ths) and `push` (the offbeat 8ths). None without enough hits."""
    s16 = 60.0 / bpm / 4 * sr
    att, lvl = hits(data, sr, th, margin=int(th.groove_max_dev * s16))
    if len(att) == 0:
        return None
    keep = lvl >= lvl.max() * 10 ** (th.groove_min_level_db / 20)
    att, lvl = att[keep], lvl[keep]
    pos = att / s16
    step = np.round(pos).astype(int)
    dev = pos - step
    ok = np.abs(dev) <= th.groove_max_dev
    step, dev, lvl = step[ok] % STEPS, dev[ok], lvl[ok]
    if len(step) < th.groove_min_hits:
        return None

    quarters = np.isin(step, [0, 4, 8, 12])
    ref = _weighted_median(dev[quarters], lvl[quarters]) if quarters.sum() >= 2 else 0.0
    offsets: list[float | None] = []
    levels: list[float | None] = []
    counts: list[int] = []
    for k in range(STEPS):
        m = step == k
        counts.append(int(m.sum()))
        if not m.any():
            offsets.append(None)
            levels.append(None)
            continue
        offsets.append(round(_weighted_median(dev[m], lvl[m]) - ref, 3) + 0.0)
        levels.append(float(np.median(lvl[m])))
    top = max(v for v in levels if v is not None)
    levels = [None if v is None else round(float(20 * np.log10(max(v, 1e-9) / top)), 1) for v in levels]

    def mean_of(ks: list[int]) -> float | None:
        vals = [(offsets[k], counts[k]) for k in ks if offsets[k] is not None]
        n = sum(c for _, c in vals)
        return round(sum(o * c for o, c in vals) / n, 3) if n else None

    return {"offsets": offsets, "levels": levels, "hits": counts,
            "swing": mean_of(list(range(1, STEPS, 2))), "push": mean_of([2, 6, 10, 14])}
