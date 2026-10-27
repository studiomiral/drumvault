"""One-shot extraction from original, unstretched stems (SCOPE.md §5.6)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .audioutil import Audio, attack_sample, causal_envelope, cosine, db_to_amp, logmel_fingerprint
from .config import Settings, Thresholds


@dataclass
class OneShot:
    data: np.ndarray          # (n, ch) float32, original sample rate
    sr: int
    category: str             # hat stems are split into hat_closed / hat_open
    start: int                # sample offset in the original stem
    attack: int               # samples from `start` to the attack
    peak: float
    score: float
    gap_s: float              # time to the next onset
    fingerprint: np.ndarray   # flattened (n_mels x frames), L2-normalised, zero-padded
    fp_frames: int            # frames of the fingerprint covered by the hit

    @property
    def source_offset_s(self) -> float:
        return self.start / self.sr


def detect_onsets(mono: np.ndarray, sr: int, th: Thresholds) -> np.ndarray:
    import librosa

    return librosa.onset.onset_detect(y=mono, sr=sr, hop_length=th.oneshot_hop, backtrack=True,
                                      units="samples")


def _min_len(category: str, th: Thresholds) -> int:
    return th.oneshot_min_len_ms.get(category, 50.0)


def tail_end(mono_seg: np.ndarray, sr: int, rel_db: float, hold_ms: float) -> int:
    """First sample after the peak from which the hit stays below peak + rel_db
    for at least `hold_ms` (so a following hit doesn't extend the tail)."""
    a = np.abs(mono_seg)
    if a.size == 0 or a.max() <= 0:
        return 0
    pk = int(np.argmax(a))
    below = a[pk:] < a[pk] * db_to_amp(rel_db)
    hold = max(1, int(hold_ms * sr / 1000))
    # run[i] = number of consecutive "below" samples starting at i
    idx = np.nonzero(~below)[0]
    if len(idx) == 0:
        return pk
    # Gaps between loud samples long enough to count as the end of the hit.
    nxt_loud = np.append(idx[1:], len(below))
    gaps = nxt_loud - idx - 1
    quiet = np.nonzero((gaps >= hold) | (nxt_loud == len(below)))[0]
    return pk + int(idx[quiet[0]]) + 1


def decay_time_s(mono_seg: np.ndarray, sr: int, rel_db: float, hold_ms: float) -> float:
    """Time from the peak until the hit has decayed below peak + rel_db."""
    a = np.abs(mono_seg)
    if a.size == 0 or a.max() <= 0:
        return 0.0
    return (tail_end(mono_seg, sr, rel_db, hold_ms) - int(np.argmax(a))) / sr


def similarity(a: OneShot, b: OneShot, th: Thresholds) -> float:
    """Cosine similarity over the frames both hits cover.

    A hit cut short by the next onset is still the same sound as a full one.
    """
    n = min(a.fp_frames, b.fp_frames)
    if n == a.fp_frames == b.fp_frames:
        return cosine(a.fingerprint, b.fingerprint)
    fa = a.fingerprint.reshape(th.fingerprint_n_mels, -1)[:, :n].ravel()
    fb = b.fingerprint.reshape(th.fingerprint_n_mels, -1)[:, :n].ravel()
    na, nb = float(np.linalg.norm(fa)), float(np.linalg.norm(fb))
    return float(np.dot(fa, fb) / (na * nb)) if na > 0 and nb > 0 else 0.0


def extract_oneshots(audio: Audio, category: str, settings: Settings) -> list[OneShot]:
    th = settings.thresholds
    sr = audio.sr
    data = audio.data
    mono = audio.mono()
    n = len(mono)
    onsets = detect_onsets(mono, sr, th)
    if len(onsets) == 0:
        return []

    env = causal_envelope(mono, int(th.oneshot_envelope_ms * sr / 1000))
    search = int(th.oneshot_attack_search_ms * sr / 1000)
    preroll = int(round(th.oneshot_preroll_ms * sr / 1000))
    hop = th.oneshot_hop

    # Sample-accurate starts: just before each hit's attack.
    starts = []
    for i, o in enumerate(onsets):
        lo = max(int(onsets[i - 1]) if i else 0, int(o) - hop)
        hi = min(int(onsets[i + 1]) if i + 1 < len(onsets) else n, int(o) + search)
        att, _ = attack_sample(env, lo, hi, th.oneshot_attack_rel)
        starts.append((max(lo, att - preroll), att))
    starts.sort()

    stem_peak = float(np.max(np.abs(data))) or 1.0
    min_peak = stem_peak * db_to_amp(th.oneshot_min_peak_rel_db)
    max_len_s = th.oneshot_max_len_cymbal_s if category == "cymbal" else th.oneshot_max_len_s
    fade = int(th.oneshot_fade_out_ms * sr / 1000)
    pre_win = int(th.oneshot_preonset_ms * sr / 1000)
    fp_frames = int(np.ceil(th.oneshot_fingerprint_ms / 1000 * th.fingerprint_sr / th.fingerprint_hop))
    w_gap, w_peak, w_bleed = th.oneshot_rank_weights
    min_len_cat = "hat_closed" if category == "hat" else category

    cands: list[OneShot] = []
    for i, (start, att) in enumerate(starts):
        nxt = starts[i + 1][0] if i + 1 < len(starts) else n
        if nxt - start < _min_len(min_len_cat, th) * sr / 1000:
            continue
        seg = data[start:nxt]
        seg_mono = mono[start:nxt]
        pk = float(np.max(np.abs(seg)))
        if pk < min_peak:
            continue

        # Tail: trim where the hit has decayed below peak + tail_db (or at the next onset).
        end = tail_end(seg_mono, sr, th.oneshot_tail_db, th.oneshot_tail_hold_ms)
        end = min(end, int(max_len_s * sr), len(seg))
        if end < _min_len(min_len_cat, th) * sr / 1000:
            continue

        cat = category
        if category == "hat":
            decay = decay_time_s(seg_mono, sr, th.hat_open_decay_db, th.oneshot_tail_hold_ms)
            cat = "hat_open" if decay * 1000 > th.hat_open_decay_ms else "hat_closed"

        hit = np.array(seg[:end], dtype=np.float32)
        f = min(fade, len(hit))
        if f > 1:
            hit[-f:] *= np.linspace(1.0, 0.0, f, dtype=np.float32)[:, None]

        pre = mono[max(0, start - pre_win):start]
        bleed = float(np.sqrt(np.mean(pre ** 2))) / pk if pre.size else 0.0
        floor = -th.oneshot_bleed_floor_db
        bleed_norm = float(np.clip((20 * np.log10(max(bleed, 1e-9)) + floor) / floor, 0, 1))
        gap_s = (nxt - start) / sr
        score = (w_gap * min(gap_s, th.oneshot_rank_gap_cap_s) / th.oneshot_rank_gap_cap_s
                 + w_peak * pk / stem_peak - w_bleed * bleed_norm)
        fp = logmel_fingerprint(hit.mean(axis=1), sr, th, n_frames=fp_frames)
        valid = min(fp_frames, max(1, int(len(hit) / sr * th.fingerprint_sr / th.fingerprint_hop)))
        cands.append(OneShot(hit, sr, cat, start, att - start, pk, score, gap_s, fp, valid))

    # Dedupe: best-ranked first; same sound if cosine similarity > threshold.
    cands.sort(key=lambda c: -c.score)
    kept: list[OneShot] = []
    for c in cands:
        if any(similarity(c, k, th) > settings.oneshot_dedupe_threshold for k in kept):
            continue
        kept.append(c)
        if len(kept) >= settings.max_oneshots_per_stem:
            break
    return kept
