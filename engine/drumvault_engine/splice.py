"""The Splice folder (SCOPE.md §6.12): sounds in it that could go on the Chord Stabs, Drop Hits,
Strings, Bass Samples, Ambience or Vocal Loops page.

A scan reads nothing but file names and audio headers, and changes nothing: each audio file's name
says what it is ("MALAY_strings_stab_fall_C#min", "RARE_piano_textured_Bmin_chord2"), its header
how long it is. A file is suggested for one page (or none): a short chord or stab for the Chord
Stabs, a brass, horn or orchestra hit for the Drop Hits, a long string sound for the Strings, a
bass one-shot for the Bass Samples, a long texture for the Ambience: noise (crackle, hiss,
room tone, a crowd) or a tonal bed (a drone, a soft pad in a key). Drums, vocals, FX, bass loops and loops of anything but strings
are left out. Adding one is the page's
own import (hits.import_hits), which copies it into the library.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

import soundfile as sf

from . import ambience, zipio
from .config import Settings
from .db import LibraryDB
from .samples import name_key

_TOKEN = re.compile(r"[A-Za-z]+|\d+")
_CAMEL = re.compile(r"(?<=[a-z])(?=[A-Z])")
_BARE_NOTE = re.compile(r"(?:^|[\s_-])([A-G][#b]?)(?=[\s_.-]|$)")

# What a name's words say.
STRINGS = {"string", "strings", "violin", "violins", "viola", "violas", "cello", "cellos"}
CHORDS = {"chord", "chords", "stab", "stabs", "piano", "pianos", "organ", "organs", "keys", "rhodes", "epiano", "wurli", "wurlitzer", "clav", "clavinet"}
DISCO = {"brass", "horn", "horns", "trumpet", "trumpets", "trombone", "sax", "saxophone", "disco", "orch", "orchestra", "orchestral"}
# A synth one-shot is a chord stab only when its name gives a whole key ("…_Dm"): a bare note is a single note.
SYNTH = {"synth", "synths"}
HIT = {"hit", "hits", "stab", "stabs"}
LOOP = {"loop", "loops", "bpm"}
# Not music for these pages, whatever else the name says ("fx" unless the name calls it a stab or a chord).
OTHER = {"kick", "kicks", "snare", "snares", "clap", "claps", "hat", "hats", "hihat", "perc", "percussion", "drum", "drums", "tom", "toms",
         "cymbal", "crash", "ride", "shaker", "sfx", "riser", "impact", "whoosh", "sweep", "foley", "vocal", "vocals", "vox", "voice",
         "fill", "drone", "lead", "cowbell", "conga", "bongo", "rim", "rimshot",
         "game", "spell", "sparkle", "magic"}
# A texture for the ambience bed: crackle, hiss, a room, a field recording (long, no beat, no tune).
AMBIENCE = {"vinyl", "crackle", "hiss", "tape", "roomtone", "ambience", "ambiance", "atmos", "atmosphere", "texture", "noise",
            "field", "rain", "crowd", "static", "foley", "air"}
# Words that make it music or drums, not a texture.
NOT_AMBIENCE = {"pad", "pads", "chord", "chords", "piano", "synth", "string", "strings", "lead", "melody", "melodic", "kick", "drum",
                "drums", "perc", "bass", "vocal", "vocals", "vox", "riser", "impact", "sweep", "fx", "sfx", "hit", "stab", "guitar",
                "songstarter", "percussion", "snare", "hat", "clap", "kit", "keys", "organ", "rhodes", "sax", "brass", "horn", "loop",
                "fall", "rise", "ris", "uplifter", "downlifter", "transition", "footstep", "explainer"}
# A tonal bed: a drone, a soft pad or soundscape held under the track (pitched into its key).
TONAL_BED = {"drone", "drones", "pad", "pads", "soundscape", "soundscapes", "ambient", "bed", "evolving"}
# …but not music that moves (chords, a melody, a loop at a tempo), an instrument of another page, drums or FX.
NOT_TONAL = (NOT_AMBIENCE - {"pad", "pads", "synth", "fx"}) | {"sidechained", "sidechain", "pumping", "arp", "arps", "arpeggio", "progression", "vinyl", "tape", "resampled"}
# A vocal loop or phrase: sung words…
VOCAL = {"vocal", "vocals", "vox", "voice", "acapella", "acappella", "acapellas"}
PHRASE = {"phrase", "phrases", "hook", "hooks", "chant", "chants", "line", "lyric", "lyrics"}
# …not a vocal FX, a noise, an instrument loop with a voice in it, a full mix or a texture.
NOT_VOCAL = {"fx", "sfx", "riser", "rise", "sweep", "impact", "drone", "ambience", "ambient", "atmos", "texture", "pad",
             "piano", "keys", "synth", "guitar", "bass", "drum", "drums", "perc", "percussion", "kick", "snare", "hat",
             "clap", "kit", "songstarter", "stems", "stem", "mix", "instrumental", "cough", "coughs", "grunt", "grunts", "groan",
             "groans", "scream", "screams",
             "laugh", "laughs", "breath", "breaths", "death", "pain", "effort", "reverse", "reversed", "fall", "uplifter",
             "downlifter", "transition", "build", "crowd"}
# A bass one-shot (one note a sampler can play a line with): never a loop, a drum or a kick's "sub".
BASS = {"bass", "basses", "sub", "808", "reese"}
NAMED = {"stab", "stabs", "chord", "chords"}


def words(name: str) -> list[str]:
    """A file name's words, lower-case ("PJ_CHII_KeysOneshot_Cm" → pj, chii, keys, oneshot, cm)."""
    return [t.lower() for t in _TOKEN.findall(_CAMEL.sub(" ", Path(name).stem))]


def name_bpm(name: str, lo: float, hi: float) -> int | None:
    """A tempo in the name: a number in the dance range standing on its own ("…_125_…", "120bpm")."""
    for t in _TOKEN.findall(Path(name).stem):
        if t.isdigit() and lo <= int(t) <= hi:
            return int(t)
    return None


def suggest(name: str, duration_s: float, settings: Settings) -> tuple[str, str] | None:
    """(page, why) for a file by its name and length: 'stab', 'disco' or 'strings'; None when it
    isn't one of them (drums, FX, vocals, basses, loops that aren't strings, sounds too long or short)."""
    th = settings.thresholds
    w = set(words(name))
    bed_len = th.splice_ambience_min_len_s <= duration_s <= th.strings_max_len_s
    # A texture first (its words aren't music for the other pages): long enough to lie under a section.
    # Noise (crackle, a crowd, rain: no key in the name) is never moved. (Named as noise, a loop is
    # still a texture: "texture_loop_vinyl_crackle".)
    noise = ambience.named_noise(name)
    if (w & AMBIENCE or {"room", "tone"} <= w) and not w & (NOT_AMBIENCE - ({"loop"} if noise else set())) and not name_key(name):
        return ("ambience", "noise for the ambience bed: never pitched") if bed_len else None
    # A tonal bed (a drone, a soft pad, an atmosphere in a key): always moved into the track's key.
    tonal = w & (AMBIENCE | TONAL_BED) and not w & NOT_TONAL and not ambience.named_noise(name)
    if tonal and (name_key_label(name)[0] or w & TONAL_BED - {"ambient", "evolving"}):
        return ("ambience", "a tonal bed: pitched into each track's key") if bed_len else None
    # A vocal loop or phrase (the Vocal Loops page): sung words, not a vocal FX, a chop one-shot or a mix.
    if w & VOCAL and not w & NOT_VOCAL:
        oneshot_ = "oneshot" in w or {"one", "shot"} <= w
        # (Of the numbers a tempo could be, the one nearest the library's: "91V_HV_124_…" is at 124.)
        tempi = [int(t) for t in _TOKEN.findall(Path(name).stem) if t.isdigit() and th.splice_bpm_min <= int(t) <= th.splice_bpm_max]
        tempo = min(tempi, key=lambda t: abs(t - settings.library_bpm)) if tempi else None
        if oneshot_ and not w & PHRASE or not th.vocal_loop_min_s <= duration_s <= th.vocal_loop_max_s:
            return None
        if tempo and not oneshot_:
            # A loop far off the library tempo never fits a track (Generate takes it within a few BPM).
            if abs(tempo - settings.library_bpm) > th.vocal_loop_suggest_bpm:
                return None
            return "vocal", f"a vocal loop at {tempo} BPM"
        return "vocal", "a vocal phrase"
    if w & OTHER or ("fx" in w and not w & NAMED):
        return None
    oneshot = "oneshot" in w or {"one", "shot"} <= w
    if w & BASS:
        # Only what a sampler can play a line with: one note, named a one-shot or short, not a loop.
        tempo = name_bpm(name, th.splice_bpm_min, th.splice_bpm_max) is not None
        if w & LOOP or (tempo and not oneshot) or w & (STRINGS | CHORDS - {"stab", "stabs"} | DISCO):
            return None
        if th.splice_min_len_s <= duration_s <= th.hit_max_len_s:
            return "bass", "a bass one-shot"
        return None
    # A number in the tempo range is the loop's tempo, unless the name says it is a one-shot (the pack's tempo).
    looped = bool(w & LOOP) or (not oneshot and name_bpm(name, th.splice_bpm_min, th.splice_bpm_max) is not None)
    if duration_s < th.splice_min_len_s:
        return None
    # A one-shot may ring longer than a hit is kept: the import trims it.
    short = duration_s <= (th.splice_stab_max_len_s if oneshot or w & NAMED else th.hit_max_len_s)
    if w & DISCO:
        return ("disco", "a brass or orchestra hit") if short and not looped else None
    if w & STRINGS:
        # A short string sound that is a hit is a chord stab; a long one goes under the track.
        if short and not looped and (w & HIT or oneshot or duration_s < th.splice_strings_min_len_s):
            return "stab", "a short string stab"
        if th.splice_strings_min_len_s <= duration_s <= th.strings_max_len_s:
            return "strings", "a string loop: check it holds at other tempos" if looped else "a long string sound"
        return None
    if looped or not short:
        return None
    if w & CHORDS:
        return "stab", "a chord or keys one-shot"
    if w & SYNTH and (oneshot or w & HIT) and name_key(name):
        return "stab", "a synth one-shot in a key"
    return None


def name_key_label(name: str) -> tuple[str | None, str | None]:
    """(key label, "name") when the name has a key; (root, "root") for a bare note ("…_C#_…": its
    scale is read from the sound on import); (None, None) otherwise."""
    named = name_key(name)
    if named:
        return named[0], "name"
    m = _BARE_NOTE.search(Path(name).stem)
    return (m.group(1), "root") if m else (None, None)


def scan(settings: Settings, folder: str) -> dict:
    """Every audio file under `folder` that could go on one of the three pages: its path, pack (the
    folder under "packs"), length, the key in its name, the page suggested and why, and the page it
    is on already (by its bytes, as the import tells). Nothing is written."""
    root = Path(folder).expanduser()
    if not root.is_dir():
        return {"folder": str(root), "found": False, "files": 0, "candidates": []}
    lib = Path(settings.library_path) if settings.library_path else None
    out = []
    files = 0
    from . import vocalloop
    voiced = vocalloop.taken_sha1s(settings) if lib else set()
    with (LibraryDB(lib) if lib and (lib / ".drumvault").exists() else _NoDb()) as db:
        for f in sorted(q for q in root.rglob("*") if q.is_file() and q.suffix.lower() in zipio.AUDIO_EXTS):
            rel = f.relative_to(root)
            if zipio.is_junk(rel.as_posix()):
                continue
            files += 1
            try:
                info = sf.info(str(f))
            except Exception:  # an unreadable header: not a sound we can offer
                continue
            dur = info.frames / info.samplerate if info.samplerate else 0.0
            s = suggest(f.name, dur, settings)
            if not s:
                continue
            key, source = name_key_label(f.name)
            parts = rel.parts
            at = parts.index("packs") + 1 if "packs" in parts else 0
            pack = parts[at] if at < len(parts) - 1 else ""
            sha = hashlib.sha1(f.read_bytes()).hexdigest()
            row = db.hit_by_sha1(sha) if db else None
            out.append({
                "path": str(f), "name": f.stem, "pack": pack, "duration_s": round(dur, 2), "channels": info.channels,
                "key_label": key, "key_source": source,
                "bpm": name_bpm(f.name, settings.thresholds.splice_bpm_min, settings.thresholds.splice_bpm_max),
                "kind": s[0], "why": s[1], "imported": "vocal" if sha in voiced else row["kind"] if row else None,
            })
    return {"folder": str(root), "found": True, "files": files, "candidates": out}


class _NoDb:
    """Stands in for the library when there is none yet: nothing is imported."""

    def __enter__(self):
        return None

    def __exit__(self, *a):
        return False
