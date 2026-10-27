"""Stem classification: filename rules, then an audio fallback (SCOPE.md §5.3)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import PurePosixPath

import numpy as np

from .audioutil import Audio, rms_db, resample
from .config import Thresholds

# Checked in this order; the first category with a matching keyword wins
# (so "Bass Drum" is a kick, not bass). Multi-word keywords match as phrases.
# Vocals come first so "Vocal FX" stays ignored; fills and rolls come before the
# drum categories so "Snare Roll" and "Tom Fill" are events, not snare/perc.
RULES: list[tuple[str, list[str]]] = [
    ("ignore", ["vox", "vocal", "vocals", "voice", "acapella", "acappella"]),
    ("roll", ["roll", "snare roll", "snareroll", "drumroll", "snare build", "snarebuild"]),
    ("fill", ["fill", "drum fill", "drumfill"]),
    ("fx_riser", ["riser", "rise", "uplifter", "uplift", "upsweep", "up sweep", "build up",
                  "buildup"]),
    ("fx_downlifter", ["downlifter", "downlift", "downsweep", "down sweep"]),
    ("fx_impact", ["impact", "sub drop", "subdrop", "boom", "explosion"]),
    ("fx_sweep", ["sweep", "whoosh", "swoosh", "noise", "white noise", "reverse", "reversed"]),
    ("fx_atmos", ["atmos", "atmosphere", "ambience", "texture"]),
    ("fx", ["fx", "sfx", "effect", "effects"]),
    ("kick", ["kick", "kik", "bd", "bassdrum", "bass drum"]),
    ("clap", ["clap", "cp", "handclap"]),
    ("snare", ["snare", "sd", "rim", "rimshot"]),
    ("hat_closed", ["closed hat", "closed hihat", "hat closed", "closedhat", "ch", "chh",
                    "hihat closed", "hi hat closed"]),
    ("hat_open", ["open hat", "open hihat", "hat open", "openhat", "oh", "ohh"]),
    ("hat", ["hat", "hats", "hh", "hihat", "hi-hat"]),
    ("ride", ["ride"]),
    ("cymbal", ["crash", "cymbal", "china", "splash"]),
    ("shaker", ["shaker", "shake", "tamb", "tambourine", "maracas"]),
    ("perc", ["perc", "percussion", "conga", "bongo", "tom", "cowbell", "clave", "wood",
              "block", "timbale"]),
    ("top", ["top", "tops", "top loop"]),
    ("groove", ["groove", "grooves"]),
    ("drums", ["drums", "drum", "drum bus", "drumbus", "beat"]),
    ("melodic", ["bass", "sub", "subbass", "synth", "lead", "pad", "chord", "chords", "keys",
                 "piano", "stab", "pluck", "arp", "organ", "string", "music", "melody",
                 "melodic"]),
    ("full_mix", ["master", "mix", "full", "mixdown"]),
    ("ignore", ["reverb return", "send"]),
]
# "loop" alone means drums, but only if nothing melodic/ignorable is named.
LOOP_KEYWORD = "loop"
NOT_DRUM_LOOP = [kw for cat, kws in RULES if cat in ("melodic", "ignore") for kw in kws]
# Whole-word only: "Rolling Bass" is not a roll, "Filler" is not a fill.
NO_PREFIX = {"roll", "fill"}
# Words containing these are treated as bass for key weighting.
BASS_KEYWORDS = ["bass", "sub", "subbass", "bassline"]


@dataclass
class Classification:
    category: str
    auto: bool = False
    reason: str = ""


def tokenize(name: str) -> list[str]:
    """'02_HiHats-124BPM' -> ['02', 'hi', 'hats', '124', 'bpm']."""
    stem = PurePosixPath(name).name
    stem = re.sub(r"\.[A-Za-z0-9]{2,5}$", "", stem)
    stem = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", stem)          # camelCase
    stem = re.sub(r"(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])", " ", stem)
    return [t for t in re.split(r"[^a-z0-9]+", stem.lower()) if t]


def _token_match(token: str, kw: str) -> bool:
    if token == kw or token in (kw + "s", kw + "es"):
        return True
    # Longer keywords also match as a word prefix ("bassline", "percloop", "claps").
    return len(kw) >= 4 and kw not in NO_PREFIX and token.startswith(kw)


def _phrase_in(tokens: list[str], keyword: str) -> bool:
    kw = tokenize(keyword)
    if not kw:
        return False
    for i in range(len(tokens) - len(kw) + 1):
        if all(_token_match(tokens[i + j], kw[j]) for j in range(len(kw))):
            return True
    return False


def match_tokens(tokens: list[str]) -> str | None:
    for category, keywords in RULES:
        if any(_phrase_in(tokens, kw) for kw in keywords):
            return category
        if category == "drums" and _phrase_in(tokens, LOOP_KEYWORD):
            if not any(_phrase_in(tokens, kw) for kw in NOT_DRUM_LOOP):
                return "drums"
    return None


def match_rules(name: str) -> str | None:
    return match_tokens(tokenize(name))


def shared_affix_len(token_lists: list[list[str]]) -> tuple[int, int]:
    """Length of the token prefix and suffix shared by every stem name.

    Stems are often named "Artist - Track - Kick"; the track title must not be
    classified ("Deep Groove - Bass" is not a groove). Only applied with >= 3
    stems, and never strips a name down to nothing.
    """
    if len(token_lists) < 3:
        return 0, 0
    shortest = min(len(t) for t in token_lists)
    pre = 0
    while pre < shortest - 1 and len({t[pre] for t in token_lists}) == 1:
        pre += 1
    suf = 0
    while suf < shortest - 1 - pre and len({t[-1 - suf] for t in token_lists}) == 1:
        suf += 1
    return pre, suf


def match_rules_in_context(names: list[str]) -> dict[str, str | None]:
    """Filename rules for all stems of one zip, ignoring shared affixes."""
    tokens = [tokenize(n) for n in names]
    pre, suf = shared_affix_len(tokens)
    return {n: match_tokens(t[pre:len(t) - suf]) for n, t in zip(names, tokens)}


def is_bass(name: str) -> bool:
    tokens = tokenize(name)
    return any(_phrase_in(tokens, kw) for kw in BASS_KEYWORDS)


def audio_features(audio: Audio, th: Thresholds) -> dict[str, float]:
    import librosa

    y = audio.mono()[: int(th.classify_max_seconds * audio.sr)]
    y = resample(y, audio.sr, th.classify_analysis_sr)
    sr = th.classify_analysis_sr
    level = rms_db(y)
    if level < th.classify_silence_rms_db:
        return {"rms_db": level, "percussive_ratio": 0.0, "decay_db": 0.0, "flatness": 0.0,
                "onset_density": 0.0, "centroid_hz": 0.0}
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
    H, P = librosa.decompose.hpss(S)
    h_e, p_e = float(np.sum(H ** 2)), float(np.sum(P ** 2))
    flat = librosa.feature.spectral_flatness(S=S)[0]
    cent = librosa.feature.spectral_centroid(S=S, sr=sr)[0]
    energy = np.sum(S ** 2, axis=0)
    loud = energy > np.max(energy) * 10 ** (th.classify_loud_frame_db / 10)  # audible frames
    onsets = librosa.onset.onset_detect(y=y, sr=sr, hop_length=512, units="samples")
    return {
        "rms_db": level,
        "percussive_ratio": p_e / max(h_e + p_e, 1e-12),
        "decay_db": _median_decay_db(y, sr, onsets, th),
        "flatness": float(np.median(flat[loud])) if loud.any() else 0.0,
        "onset_density": len(onsets) / max(len(y) / sr, 1e-6),
        "centroid_hz": float(np.average(cent[loud], weights=energy[loud])) if loud.any() else 0.0,
    }


def _median_decay_db(y: np.ndarray, sr: int, onsets: np.ndarray, th: Thresholds) -> float:
    """Median RMS level `decay_probe_ms` after each onset relative to the attack."""
    frame = max(1, int(0.01 * sr))  # 10 ms RMS frames
    n = len(y) // frame
    env = np.sqrt(np.mean(np.square(y[:n * frame].reshape(n, frame)), axis=1)) + 1e-9
    att = max(1, int(round(th.classify_attack_window_ms / 10)))
    probe = int(round(th.classify_decay_probe_ms / 10))
    decays = []
    for i, o in enumerate(onsets):
        f0 = int(o) // frame
        nxt = int(onsets[i + 1]) // frame if i + 1 < len(onsets) else n
        if f0 + probe >= min(nxt, n):
            continue  # next hit arrives before we can measure
        decays.append(20 * np.log10(env[f0 + probe] / np.max(env[f0:f0 + att])))
    return float(np.median(decays)) if decays else 0.0


def classify_audio(audio: Audio, th: Thresholds) -> Classification:
    f = audio_features(audio, th)
    desc = ", ".join(f"{k}={v:.3g}" for k, v in f.items())
    if f["rms_db"] < th.classify_silence_rms_db:
        return Classification("ignore", True, f"silent ({desc})")
    percussive = f["onset_density"] >= th.classify_min_onset_density and (
        f["decay_db"] <= th.classify_max_decay_db_percussive
        or f["percussive_ratio"] >= th.classify_percussive_strong)
    if percussive:
        if f["centroid_hz"] < th.classify_kick_centroid_hz:
            cat = "kick"
        elif f["centroid_hz"] > th.classify_hat_centroid_hz:
            cat = "hat"
        else:
            cat = "drums"
        return Classification(cat, True, f"percussive ({desc})")
    if (f["percussive_ratio"] <= th.classify_harmonic_max
            and f["decay_db"] > th.classify_max_decay_db_percussive
            and f["flatness"] <= th.classify_max_flatness_harmonic
            and f["centroid_hz"] <= th.classify_max_centroid_harmonic_hz):
        return Classification("melodic", True, f"harmonic ({desc})")
    return Classification("ignore", True, f"ambiguous ({desc})")


def classify_stems(names: list[str], load_audio, th: Thresholds) -> dict[str, Classification]:
    """Classify all stems of a zip by filename, falling back to audio analysis.

    `load_audio(name)` is only called for names the rules can't place.
    """
    out: dict[str, Classification] = {}
    for name, cat in match_rules_in_context(names).items():
        if cat is not None:
            out[name] = Classification(cat, False, "filename")
        else:
            out[name] = classify_audio(load_audio(name), th)
    return out
