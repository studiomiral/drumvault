"""Loose samples (Splice and other packs) into the library (SCOPE.md §5.16).

A zip of stems is one track: its tempo, bar 1, key and structure come from the whole track. A
loose sample is already cut: a one-shot, or a loop that starts on its downbeat. So each file is
handled on its own: its category from its name (then its folders, then its sound), one-shot,
loop or event from its name and length, its tempo from its name (or its length in whole bars),
its key from its name. Files are grouped into packs, one per Splice pack or dropped folder; a
pack is a source like a zip (its own code, P0001…) but has no arrangement, so it is never a
structure template.
"""

from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import classify, events as eventmod, key as keymod, loops as loopmod, oneshots as osmod, stretch, zipio
from .audioutil import Audio, db_to_amp, info as audio_info, load, logmel_fingerprint, rms_db, to_mono
from .config import DRUM_CATEGORIES, EVENT_CATEGORIES, ONESHOT_CATEGORIES, Settings, Thresholds
from .tempo import filename_bpms

LOOP_WORDS = ["loop", "loops"]
ONESHOT_WORDS = ["one shot", "one shots", "oneshot", "oneshots", "hit", "hits", "single", "singles"]
NEGATIONS = {"no", "without", "minus"}
# Bare numbers in a file name read as its tempo ("BBH_124_Hat_Loop").
BARE_BPM = (60, 200)
# Bar counts a loop of unknown tempo may have.
GUESS_BARS = (1, 2, 4, 8, 16)
_KEY_RE = re.compile(r"(?:^|[\s_\-(\[])([A-G](?:#|b)?)\s?(m|min|minor|maj|major)(?=$|[\s_\-)\].])", re.I)


def pack_id(root: Path) -> str:
    """Stands in for a zip's SHA-1: one pack per folder."""
    return "pack-" + hashlib.sha1(str(root).encode()).hexdigest()


def pack_root(file: Path, dropped: Path) -> Path:
    """A Splice pack (…/sounds/packs/<Pack>/…), else the dropped folder, else the file's folder."""
    parts = file.parts
    for i in range(len(parts) - 3):
        if parts[i].lower() == "sounds" and parts[i + 1].lower() == "packs":
            return Path(*parts[:i + 3])
    return dropped if dropped.is_dir() else file.parent


def find_samples(paths: list[str | Path]) -> tuple[dict[Path, list[str]], list[str]]:
    """Audio files in what was dropped, by pack root (paths relative to it), and warnings."""
    packs: dict[Path, list[str]] = defaultdict(list)
    warnings: list[str] = []
    for p in map(Path, paths):
        p = p.resolve()
        files = sorted(q for q in p.rglob("*") if q.is_file()) if p.is_dir() else [p]
        for f in files:
            rel = f.relative_to(p).as_posix() if p.is_dir() else f.name
            if zipio.is_junk(rel):
                continue
            ext = f.suffix.lower()
            if ext in zipio.UNSUPPORTED_AUDIO_EXTS:
                warnings.append(f"Skipped unsupported audio format ({ext}): {f.name}")
            if ext not in zipio.AUDIO_EXTS:
                continue
            root = pack_root(f, p)
            name = f.relative_to(root).as_posix()
            if name not in packs[root]:
                packs[root].append(name)
    return dict(packs), warnings


# ---- reading names ----------------------------------------------------------------------------

def _has(tokens: list[str], words: list[str]) -> bool:
    return any(classify._phrase_in(tokens, w) for w in words)


def name_bpm(name: str) -> float | None:
    """'…_124_Hat_Loop.wav' / '…124bpm…' → 124; folders count only with "bpm" written out."""
    path = Path(name)
    found = filename_bpms([path.name])
    if found:
        return found[0]
    for t in classify.tokenize(path.name):
        if t.isdigit() and BARE_BPM[0] <= int(t) <= BARE_BPM[1]:
            return float(t)
    found = filename_bpms(list(path.parent.parts))
    return found[0] if found else None


def name_key(name: str) -> tuple[str, str] | None:
    """(label, camelot) from '…_Am_…' / 'F#min' / 'Bb major'; a bare letter isn't a key."""
    stem = Path(name).stem
    m = _KEY_RE.search(stem)
    if not m:
        return None
    try:
        k = keymod.override_result(m.group(1) + m.group(2).lower(), Thresholds())
    except ValueError:
        return None
    return k.label, k.camelot


def _without_negated(tokens: list[str]) -> list[str]:
    """'drum loop no kick' → 'drum loop': what a sample leaves out isn't what it is."""
    return [t for i, t in enumerate(tokens) if t not in NEGATIONS and (i == 0 or tokens[i - 1] not in NEGATIONS)]


def name_category(name: str) -> str | None:
    """The file name's category, else its nearest folder's ("Kicks/BBH_03.wav")."""
    path = Path(name)
    for part in [path.name, *reversed(path.parent.parts)]:
        cat = classify.match_tokens(_without_negated(classify.tokenize(part)))
        if cat is not None:
            return cat
    return None


def loop_tempo(duration_s: float, bpm: float | None, settings: Settings) -> tuple[float, int] | None:
    """(BPM, bars) of a loop. With a BPM from the name, a tail after the last whole bar is
    allowed (it is cut); without, the length must be whole bars at a tempo the library can
    stretch to (the closest to the library BPM wins)."""
    th = settings.thresholds

    def bars_at(b: float, tail: bool) -> int | None:
        bar = 240.0 / b
        n = int(round(duration_s / bar))
        if 1 <= n <= th.sample_loop_max_bars and abs(duration_s - n * bar) <= th.sample_loop_fit_s:
            return n
        n = int((duration_s + th.sample_loop_fit_s) // bar)
        return n if tail and 1 <= n <= th.sample_loop_max_bars else None

    if bpm:
        n = bars_at(bpm, tail=True)
        return (bpm, n) if n else None
    lo = settings.library_bpm * (1 - settings.max_stretch)
    hi = settings.library_bpm * (1 + settings.max_stretch)
    cands = []
    for n in GUESS_BARS:
        b = n * 240.0 / duration_s
        if settings.integer_bpm and abs(b - round(b)) <= 0.05:
            b = float(round(b))
        if lo <= b <= hi and bars_at(b, tail=False) == n:
            cands.append((abs(b - settings.library_bpm), b, n))
    return min(cands)[1:] if cands else None


@dataclass
class Plan:
    kind: str | None          # oneshot | loop | event | hits (one-shots cut from a loop) | None: skipped
    bpm: float | None = None
    bars: int | None = None
    why: str = ""
    fixable: bool = False     # skipped for a reason a category override or a rename can fix


def plan(name: str, category: str, duration_s: float, settings: Settings) -> Plan:
    """What a file becomes, from its category, its name and its length."""
    if category in ("melodic", "full_mix", "ignore"):
        return Plan(None, why=f"not drums ({category})")
    tokens = [t for part in Path(name).parts for t in classify.tokenize(part)]
    bpm = name_bpm(name)
    if category in EVENT_CATEGORIES:
        return Plan("event", bpm)
    if _has(tokens, ONESHOT_WORDS) and not _has(classify.tokenize(Path(name).name), LOOP_WORDS):
        kind = "oneshot"
    else:
        t = loop_tempo(duration_s, bpm, settings)
        if t is None and (_has(tokens, LOOP_WORDS) or (bpm and duration_s > settings.thresholds.sample_oneshot_max_s)):
            return Plan(None, bpm, why=f"a loop, but {duration_s:.2f} s isn't whole bars"
                        + (f" at {bpm:g} BPM" if bpm else " at a tempo near the library's"), fixable=True)
        if t is not None:
            if category not in DRUM_CATEGORIES:
                return Plan(None, why=f"not drums ({category})")
            if not settings.loop_lengths_for(category):
                return Plan("hits", t[0], t[1])  # a kick or crash loop: its hits
            return Plan("loop", *t)
        if duration_s > settings.thresholds.sample_oneshot_max_s:
            return Plan(None, why=f"{duration_s:.1f} s is too long for a one-shot and isn't a loop")
        kind = "oneshot"
    if category not in ONESHOT_CATEGORIES:
        return Plan(None, why=f"a one-shot needs a single-sound category, not {category}", fixable=True)
    return Plan(kind)


# ---- cutting ----------------------------------------------------------------------------------

def cut_loop(audio: Audio, bpm: float, bars: int, settings: Settings, tmp: Path) -> tuple[loopmod.Loop | None, list[str]]:
    """The loop at the library BPM, exactly `bars` long. Three cycles are stretched and the
    middle one kept, so its ends join like a repeat (no stretch smear at the edges)."""
    th = settings.thresholds
    n = int(round(bars * 240.0 / bpm * audio.sr))
    x = audio.data[:n]
    if len(x) < n:
        x = np.pad(x, ((0, n - len(x)), (0, 0)))
    y, out_sr, warnings = stretch.stretch_stem(np.concatenate([x, x, x]), audio.sr, bpm, settings, tmp_dir=tmp)
    length = loopmod.bar_length(out_sr, settings.library_bpm) * bars
    start = stretch.map_samples(n, audio.sr, bpm, settings.library_bpm, out_sr)
    seg = np.array(y[start:start + length], dtype=np.float32)
    if len(seg) < length:
        seg = np.pad(seg, ((0, length - len(seg)), (0, 0)))
    mono = to_mono(seg)
    if rms_db(mono) < th.loop_silence_rms_db:
        return None, warnings
    fp = logmel_fingerprint(mono, out_sr, th, frames_per_chunk=th.loop_fingerprint_frames_per_bar * bars,
                            top_db=th.loop_fingerprint_top_db)
    seg, faded = loopmod.fade_in_if_needed(seg, out_sr, th)
    return loopmod.Loop(seg, out_sr, bars, 0, fp, faded), warnings


def whole_hit(audio: Audio, category: str, settings: Settings) -> osmod.OneShot | None:
    """The file as one hit, when onset detection finds none (a soft shaker): tail trimmed."""
    th = settings.thresholds
    mono = audio.mono()
    pk = float(np.max(np.abs(audio.data))) if audio.data.size else 0.0
    if pk <= 0:
        return None
    start = int(np.argmax(np.abs(mono) >= float(np.max(np.abs(mono))) * db_to_amp(th.oneshot_tail_db)))
    max_len = th.oneshot_max_len_cymbal_s if category == "cymbal" else th.oneshot_max_len_s
    end = min(start + osmod.tail_end(mono[start:], audio.sr, th.oneshot_tail_db, th.oneshot_tail_hold_ms),
              start + int(max_len * audio.sr))
    hit = np.array(audio.data[start:max(end, start + 1)], dtype=np.float32)
    f = min(int(th.oneshot_fade_out_ms * audio.sr / 1000), len(hit))
    if f > 1:
        hit[-f:] *= np.linspace(1.0, 0.0, f, dtype=np.float32)[:, None]
    fp_frames = int(np.ceil(th.oneshot_fingerprint_ms / 1000 * th.fingerprint_sr / th.fingerprint_hop))
    fp = logmel_fingerprint(hit.mean(axis=1), audio.sr, th, n_frames=fp_frames)
    cat = "hat_closed" if category == "hat" else category
    return osmod.OneShot(hit, audio.sr, cat, start, 0, pk, 1.0, len(hit) / audio.sr, fp, fp_frames)


@dataclass
class FileResult:
    category: str
    auto: bool
    reason: str
    duration_s: float
    sample_rate: int
    channels: int
    key: tuple[str, str] | None
    oneshots: list[osmod.OneShot]
    loops: list[loopmod.Loop]
    events: list[eventmod.Event]
    loop_factor: float
    loop_sr: int
    warnings: list[str]
    skipped: str = ""
    fixable: bool = False     # the pack wants a look (see Plan.fixable)


def process_file(path: Path, name: str, category: str | None, settings: Settings, do_oneshots: bool,
                 tmp: Path) -> FileResult:
    """One loose sample. `category`: the user's override, else it is read from the name / sound."""
    frames, sr, ch = audio_info(path)
    dur = frames / sr
    auto, reason = False, "override" if category else "filename"
    audio: Audio | None = None
    if category is None:
        category = name_category(name)
    if category is None:
        audio = load(path)
        c = classify.classify_audio(audio, settings.thresholds)
        category, auto, reason = c.category, True, c.reason
    r = FileResult(category, auto, reason, dur, sr, ch, name_key(name), [], [], [], 1.0,
                   settings.output_sample_rate, [])
    p = plan(name, category, dur, settings)
    if p.kind is None:
        r.skipped, r.fixable = p.why, p.fixable
        return r
    if p.kind == "loop" and not stretch.stretch_allowed(p.bpm, settings.library_bpm, settings.max_stretch):
        r.skipped = f"{p.bpm:g} BPM is too far from {settings.library_bpm:g} to stretch"
        return r
    if p.kind in ("oneshot", "hits") and not do_oneshots:
        return r
    audio = audio or load(path)
    if p.kind == "oneshot":
        hits = osmod.extract_oneshots(audio, category, settings)[:1] or [h for h in [whole_hit(audio, category, settings)] if h]
        r.oneshots = hits
    elif p.kind == "hits":
        r.oneshots = osmod.extract_oneshots(audio, category, settings)
    elif p.kind == "loop":
        lp, w = cut_loop(audio, p.bpm, p.bars, settings, tmp)
        r.warnings += w
        r.loops = [lp] if lp else []
    else:
        bpm = p.bpm if p.bpm and stretch.stretch_allowed(p.bpm, settings.library_bpm, settings.max_stretch) else None
        y, out_sr, w = stretch.stretch_stem(audio.data, audio.sr, bpm or settings.library_bpm, settings, tmp_dir=tmp)
        r.warnings += w
        r.events = eventmod.extract_events(y, out_sr, 0, settings.library_bpm, settings)
        r.loop_factor = stretch.time_factor(bpm or settings.library_bpm, settings.library_bpm)
        r.loop_sr = out_sr
    if not (r.oneshots or r.loops or r.events):
        r.skipped = "nothing audible found"
    return r
