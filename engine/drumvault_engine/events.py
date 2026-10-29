"""Grid-aligned events from fill, roll and FX stems (SCOPE.md §5.8a).

These stems are mostly silent, with a sound every few bars: a fill before the
drop, an 8-bar riser, a downlifter after it. Each sound becomes one sample that
starts on the bar line where it begins and runs for whole bars (tail included),
so it drops onto the timeline exactly where it sat in the source track.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .audioutil import amp_to_db, cosine, db_to_amp, logmel_fingerprint, peak, rms_db, to_mono
from .config import Settings, Thresholds
from .loops import bar_length, beat_levels, fade_in_if_needed


@dataclass
class Event:
    data: np.ndarray          # (bars * bar_len, ch) float32, starts on a bar line
    sr: int
    bars: int
    start: int                # sample offset in the stretched stem (a bar line)
    fingerprint: np.ndarray
    body_bars: int = 0        # bars from the start to the end of the main sound (tail excluded)
    bar: int = 0              # the bar it starts on, counted from the stem's bar one


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


def body_bars(mono: np.ndarray, beat_len: float, phase: int, bar0: int, a: int, b: int,
              th: Thresholds) -> int:
    """Whole bars from the event's start bar to the end of its last loud beat."""
    levels = beat_levels(mono, beat_len, phase)[a:b]
    if not len(levels):
        return 1
    loud = np.nonzero(levels >= levels.max() + th.event_body_rel_db)[0]
    last = a + int(loud[-1]) + 1                      # beat index after the last loud beat
    return max(1, -(-last // 4) - bar0)


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
        cands.append(Event(seg, sr, bars, start, fp, min(bars, body_bars(mono, beat_len, phase, bar0, a, b, th)), bar0))

    # Dedupe: the same riser before every drop is one sample (first occurrence kept).
    kept: list[Event] = []
    for c in cands:
        if all(similarity(c, k) <= settings.event_dedupe_threshold for k in kept):
            kept.append(c)
    return farthest_point(kept, settings.max_events_per_stem)


def shape(data: np.ndarray, sr: int, bpm: float, bars: int, body: int, th: Thresholds) -> dict:
    """How an event (cut on the grid at `bpm`) plays, in 16ths from its start:

    - `end`: where its sound ends, and `gap` the 16ths of silence from there to the end of its
      body (`body` bars): a riser that stops on beat 7 of 8 leaves the producer's beat of
      silence before the drop;
    - `peak`: its loudest 16th; `onset`: where it starts sounding;
    - `dir`: "rise" (louder or brighter towards its peak at the end), "fall" (the other way),
      "hit" (loudest at once, a beat later well down) or "flat";
    - `noise`: spectral flatness of its sound (1 white noise, 0 a tone), to layer a noise
      sweep with a tonal riser rather than two of a kind.
    """
    mono = to_mono(data)
    step = 60.0 / bpm / 4 * sr
    n = max(1, int(round(bars * 16)))
    edges = np.round(np.arange(n + 1) * step).astype(int)
    levels = np.array([rms_db(mono[a:b]) for a, b in zip(edges[:-1], edges[1:])])
    body16 = max(1, min(n, body * 16))
    loud = levels[:body16]
    sounding = np.nonzero(loud >= loud.max() + th.shape_sound_rel_db)[0]
    onset, end = int(sounding[0]), int(sounding[-1]) + 1
    # The sound running on past the body's bar line (into the tail) counts as reaching it.
    if end == body16 or (body16 < n and levels[body16] >= loud.max() + th.shape_sound_rel_db):
        end = body16
    peak_at = onset + int(np.argmax(loud[onset:end]))

    centroid, flat = [], []
    for a, b in zip(edges[onset:end], edges[onset + 1:end + 1]):
        seg = mono[a:b]
        if len(seg) < 64:
            continue
        sp = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) + 1e-12
        f = np.fft.rfftfreq(len(seg), 1 / sr)
        centroid.append(float((sp * f).sum() / sp.sum()))
        flat.append(float(np.exp(np.mean(np.log(sp))) / np.mean(sp)))
    length = end - onset
    k = max(1, min(4, length // 4))                  # first and last beat (or less) of the sound
    lv = loud[onset:end]
    slope = float(lv[-k:].mean() - lv[:k].mean())
    bright = float(np.log2((np.mean(centroid[-k:]) + 1) / (np.mean(centroid[:k]) + 1))) if centroid else 0.0
    where = (peak_at - onset) / max(1, length - 1)
    if where >= th.shape_peak_late and (slope >= th.shape_slope_db or bright >= th.shape_bright_oct):
        direction = "rise"
    elif peak_at - onset <= 1 and loud[min(peak_at + 4, end - 1)] <= loud[peak_at] - th.shape_slope_db:
        direction = "hit"                            # at once, and a beat later well down
    elif where <= th.shape_peak_early and (slope <= -th.shape_slope_db or bright <= -th.shape_bright_oct):
        direction = "fall"
    else:
        direction = "flat"
    return {"onset": onset, "end": end, "gap": body16 - end, "peak": peak_at, "dir": direction,
            "noise": round(float(np.mean(flat)), 3) if flat else 0.0}
