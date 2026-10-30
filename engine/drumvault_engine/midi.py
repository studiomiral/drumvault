"""MIDI import (SCOPE.md §6.7): bass and keys parts added from folders like zips.

Each file is read with mido into notes in beats from the bar of its first note, its length
rounded up to whole bars and its key taken from the file name (or found from the notes). Its
role (bass or keys) is the MIDI page section it was added to.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from pathlib import Path

import mido
import numpy as np

from .config import Thresholds
from .key import PITCH_NAMES, PROFILES, camelot, make_label, normalize_pitch, parse_label

MIDI_EXTENSIONS = (".mid", ".midi")
_BASS_WORDS = re.compile(r"bass|(?<![a-z])(sub|808|reese|low)(?![a-z])", re.I)   # not "Slow Chords"
_KEYS_WORDS = re.compile(r"(?<![a-z])(keys?|keyboards?|piano|e[ ._-]?piano|pian|organ|rhodes|wurli|clav|chords?)(?![a-z])", re.I)
_OTHER_WORDS = re.compile(r"(chord|pad|lead|melod|arp|keys|pian|stab|vocal|top|hook|pluck|organ|guitar|string|solo|"
                          r"synth|brass|horn|bell|flute|choir|vox)", re.I)
# "Fm", "F#min", "Bb minor", "A_maj": a key with its scale in the name.
_KEY_SCALE = re.compile(r"(?<![A-Za-z])([A-Ga-g][#b]?)[\s_-]?(min(?:or)?|maj(?:or)?|m)(?![a-z])")
# A bare note name between separators ("Bass_A_124"): the tonic, scale from the notes.
_KEY_BARE = re.compile(r"(?:^|[\s_-])([A-G][#b]?)(?=[\s_.-]|$)")


@dataclass
class Note:
    start: float      # beats from the start of the file
    length: float     # beats
    pitch: int
    velocity: int


def apply_groove(notes: list[Note], groove: list[float], tolerance: float = 0.05) -> list[Note]:
    """Notes starting on a 16th move by that step's groove offset (in 16ths); others stay. The
    note's end stays put, so a late note is a little shorter and never overlaps the next."""
    out = []
    for n in notes:
        pos = n.start * 4
        step = round(pos)
        if abs(pos - step) > tolerance:
            out.append(n)
            continue
        d = groove[step % len(groove)] / 4
        start = max(0.0, n.start + d)
        out.append(Note(start, max(1 / 64, n.start + n.length - start), n.pitch, n.velocity))
    return out


@dataclass
class MidiInfo:
    notes: list[Note]
    bars: int
    key_label: str | None
    key_camelot: str | None
    role: str                      # "bass" | "keys" | "other"
    warnings: list[str] = field(default_factory=list)


def read_notes(path: Path | str) -> list[Note]:
    """All notes of all tracks, in beats (note on → matching note off)."""
    mf = mido.MidiFile(str(path))
    tpb = mf.ticks_per_beat or 480
    notes: list[Note] = []
    for track in mf.tracks:
        tick = 0
        open_: dict[tuple[int, int], tuple[int, int]] = {}
        for msg in track:
            tick += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                open_[(msg.channel, msg.note)] = (tick, msg.velocity)
            elif msg.type in ("note_off", "note_on"):
                start = open_.pop((msg.channel, msg.note), None)
                if start is not None and tick > start[0]:
                    notes.append(Note(start[0] / tpb, (tick - start[0]) / tpb, msg.note, start[1]))
    return sorted(notes, key=lambda n: (n.start, n.pitch))


def from_first_bar(notes: list[Note], th: Thresholds) -> list[Note]:
    """Notes moved back by the whole bars before the first one: a region exported from bar 49
    of a project becomes a loop from bar 1. A note a little early on that bar starts on its 1."""
    if not notes:
        return notes
    shift = math.floor((notes[0].start + th.midi_early_beats) / 4) * 4
    if shift <= 0:
        return notes
    out = []
    for n in notes:
        start = n.start - shift
        if start + n.length <= 0:
            continue
        out.append(Note(max(0.0, start), n.length + min(0.0, start), n.pitch, n.velocity))
    return out


def bars_for(notes: list[Note], th: Thresholds) -> int:
    end = max((n.start + n.length for n in notes), default=4.0)
    need = max(1, math.ceil((end - th.midi_overhang_beats) / 4 - 1e-6))
    return next((b for b in th.midi_bar_lengths if b >= need), th.midi_bar_lengths[-1])


def _profile_scores(notes: list[Note]) -> list[tuple[float, int, str]]:
    hist = np.zeros(12)
    for n in notes:
        hist[n.pitch % 12] += n.length
    if not hist.any():
        return []
    major, minor = PROFILES["temperley"]
    out = []
    for scale, ref in (("major", major), ("minor", minor)):
        for pc in range(12):
            out.append((float(np.corrcoef(hist, np.roll(ref, pc))[0, 1]), pc, scale))
    return sorted(out, reverse=True)


def has_key_in_name(name: str) -> bool:
    """The name says its key with a scale ("Fm", "A minor")."""
    return bool(_KEY_SCALE.search(Path(name).stem if "." in name else name))


def detect_key(name: str, notes: list[Note]) -> tuple[int, str] | None:
    """Key from the file name when it says so, else from the notes (duration-weighted)."""
    stem = Path(name).stem
    m = _KEY_SCALE.search(stem)
    if m:
        scale = "major" if m.group(2).lower().startswith("maj") else "minor"
        return normalize_pitch(m.group(1)), scale
    scores = _profile_scores(notes)
    m = _KEY_BARE.search(stem)
    if m:
        pc = normalize_pitch(m.group(1))
        best = max((s for s in scores if s[1] == pc), default=None)
        return pc, best[2] if best else "minor"
    return (scores[0][1], scores[0][2]) if scores else None


def named_role(name: str) -> str | None:
    """"bass" or "keys" when the part's name says so ("Sub", "Deep Chords", "Rhodes"), else None."""
    if _BASS_WORDS.search(name):
        return "bass"
    return "keys" if _KEYS_WORDS.search(Path(name).stem) else None


def guess_role(name: str, notes: list[Note], th: Thresholds) -> str:
    if _BASS_WORDS.search(name):
        return "bass"
    if _KEYS_WORDS.search(Path(name).stem):
        return "keys"
    if _OTHER_WORDS.search(name):
        return "other"
    median = float(np.median([n.pitch for n in notes])) if notes else 60.0
    return "bass" if median <= th.midi_bass_max_median_pitch else "other"


def analyze(path: Path | str, th: Thresholds) -> MidiInfo:
    notes = from_first_bar(read_notes(path), th)
    warnings = [] if notes else ["No notes in this MIDI file"]
    bars = bars_for(notes, th)
    end = bars * 4
    notes = [Note(n.start, min(n.length, end - n.start), n.pitch, n.velocity) for n in notes if n.start < end]
    key = detect_key(Path(path).name, notes)
    return MidiInfo(notes=notes, bars=bars, key_label=make_label(*key) if key else None,
                    key_camelot=camelot(*key) if key else None, role=guess_role(Path(path).name, notes, th),
                    warnings=warnings)


def transpose_to(key_from: str | None, key_to: str | None) -> int:
    """Semitones that move a part from one key to another (nearest way, -6…+5). A major part
    in a minor track (or the other way) goes to the relative key."""
    if not key_from or not key_to:
        return 0
    pf, sf_ = parse_label(key_from)
    pt, st = parse_label(key_to)
    if sf_ != st:
        pf = (pf + (-3 if sf_ == "major" else 3)) % 12   # C major ≈ A minor
    d = (pt - pf) % 12
    return d - 12 if d > 5 else d


__all__ = ["MIDI_EXTENSIONS", "MidiInfo", "Note", "analyze", "camelot", "detect_key", "from_first_bar", "guess_role",
           "has_key_in_name", "make_label", "parse_label", "read_notes", "transpose_to", "PITCH_NAMES"]
