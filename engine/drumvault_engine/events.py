"""Grid-aligned events from fill, roll and FX stems (SCOPE.md §5.8a).

These stems are mostly silent, with a sound every few bars: a fill before the
drop, an 8-bar riser, a downlifter after it. Each sound becomes one sample that
starts on the bar line where it begins and runs for whole bars (tail included),
so it drops onto the timeline exactly where it sat in the source track.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .audioutil import amp_to_db, cosine, db_to_amp, logmel_fingerprint, peak, to_mono
from .config import Settings, Thresholds
from .loops import bar_length, beat_levels, fade_in_if_needed


@dataclass
class Event:
    data: np.ndarray          # (bars * bar_len, ch) float32, starts on a bar line
    sr: int
    bars: int
    start: int                # sample offset in the stretched stem (a bar line)
    fingerprint: np.ndarray


def active_floor_db(mono: np.ndarray, th: Thresholds) -> float:
    return max(amp_to_db(peak(mono)) + th.event_active_rel_db, th.event_silence_db)


def active_regions(mono: np.ndarray, beat_len: float, phase: int, th: Thresholds) -> list[tuple[int, int]]:
    """[first, end) beat indices (from `phase`) of the stem's sounding regions."""
    levels = beat_levels(mono, beat_len, phase)
    if not len(levels):
        return []
    active = np.nonzero(levels >= active_floor_db(mono, th))[0]
    regions: list[list[int]] = []
    for b in map(int, active):
        if regions and b - regions[-1][1] <= th.event_merge_gap_beats:
            regions[-1][1] = b + 1
        else:
            regions.append([b, b + 1])
    return [(a, b) for a, b in regions]


def split_beds(regions: list[tuple[int, int]], th: Thresholds) -> list[tuple[int, int]]:
    """Regions longer than `event_max_bars` (atmos beds) cut into `event_bed_bars` chunks."""
    out = []
    for a, b in regions:
        if b - a <= th.event_max_bars * 4:
            out.append((a, b))
            continue
        bar0 = a // 4
        step = th.event_bed_bars * 4
        for s in range(bar0 * 4, b, step):
            out.append((max(a, s), min(b, s + step)))
    return out


def _fade(seg: np.ndarray, at: int, n: int, out: bool) -> None:
    """Silence `seg` after (out) or before (not out) sample `at`, with an n-sample ramp."""
    if out:
        a = max(0, at - n)
        seg[a:at] *= np.linspace(1.0, 0.0, at - a, dtype=np.float32)[:, None]
        seg[at:] = 0.0
    else:
        b = min(len(seg), at + n)
        seg[at:b] *= np.linspace(0.0, 1.0, b - at, dtype=np.float32)[:, None]
        seg[:at] = 0.0


def similarity(a: Event, b: Event) -> float:
    """Events only match others of the same length (fingerprints are per bar)."""
    return cosine(a.fingerprint, b.fingerprint) if a.bars == b.bars else 0.0


def farthest_point(events: list[Event], cap: int) -> list[Event]:
    """Greedy farthest-point selection, seeded with the first event, kept in time order."""
    if len(events) <= cap:
        return events
    chosen = [0]
    dist = np.array([1.0 - similarity(events[0], e) for e in events])
    while len(chosen) < cap:
        dist[chosen] = -1.0
        nxt = int(np.argmax(dist))
        chosen.append(nxt)
        dist = np.minimum(dist, [1.0 - similarity(events[nxt], e) for e in events])
    return [events[i] for i in sorted(chosen)]


def extract_events(data: np.ndarray, sr: int, phase: int, bpm: float, settings: Settings) -> list[Event]:
    """Cut the events of an already stretched stem on its bar grid."""
    th = settings.thresholds
    bar_len = bar_length(sr, bpm)
    beat_len = bar_len / 4
    mono = to_mono(data)
    n = len(mono)
    at = lambda beat: phase + int(round(beat * beat_len))  # noqa: E731
    regions = split_beds(active_regions(mono, beat_len, phase, th), th)
    min_peak = peak(mono) * db_to_amp(th.event_min_peak_rel_db)
    floor_amp = db_to_amp(active_floor_db(mono, th))
    preroll = int(round(th.event_preroll_ms * sr / 1000))
    fade = max(1, int(round(th.event_fade_ms * sr / 1000)))

    cands: list[Event] = []
    for i, (a, b) in enumerate(regions):
        seg_mono = mono[at(a):min(at(b), n)]
        if not len(seg_mono) or peak(seg_mono) < min_peak:
            continue
        onset = at(a) + int(np.argmax(np.abs(seg_mono) >= floor_amp))
        bar0 = int(onset - phase + preroll) // bar_len
        bars = max(1, -(-b // 4) - bar0)              # whole bars, tail included
        start = phase + bar0 * bar_len
        end = start + bars * bar_len
        seg = np.zeros((bars * bar_len, data.shape[1]), dtype=np.float32)
        seg[:min(end, n) - start] = data[start:min(end, n)]
        # A neighbouring event sharing the first or last bar is not part of this one.
        if i > 0 and at(regions[i - 1][1]) > start:
            _fade(seg, max(0, at(a) - start), fade, out=False)
        if i + 1 < len(regions) and at(regions[i + 1][0]) < end:
            _fade(seg, at(regions[i + 1][0]) - start, fade, out=True)
        seg, _ = fade_in_if_needed(seg, sr, th)
        if np.max(np.abs(seg[-1])) > db_to_amp(th.loop_near_zero_db):
            _fade(seg, len(seg), fade, out=True)  # a bed chunk cut mid-sound
        fp = logmel_fingerprint(to_mono(seg), sr, th, frames_per_chunk=th.loop_fingerprint_frames_per_bar * bars,
                                top_db=th.loop_fingerprint_top_db)
        cands.append(Event(seg, sr, bars, start, fp))

    # Dedupe: the same riser before every drop is one sample (first occurrence kept).
    kept: list[Event] = []
    for c in cands:
        if all(similarity(c, k) <= settings.event_dedupe_threshold for k in kept):
            kept.append(c)
    return farthest_point(kept, settings.max_events_per_stem)
