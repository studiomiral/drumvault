"""Source-track key detection (SCOPE.md §5.5).

One interface (`detect_key`) over two backends: essentia's KeyExtractor with
the EDMA profile, and a numpy/librosa fallback (CQT chroma correlated with
EDM-style key profiles) used when essentia is unavailable.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import numpy as np

from .audioutil import resample
from .config import Thresholds

log = logging.getLogger(__name__)

PITCH_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
_ALIASES = {"Db": "C#", "D#": "Eb", "Gb": "F#", "G#": "Ab", "A#": "Bb", "Cb": "B", "B#": "C",
            "E#": "F", "Fb": "E"}

# Key profiles for the fallback detector, index 0 = tonic, as (major, minor).
# "edma" follows Faraldo's EDM profiles (what essentia uses), but those are
# tuned for essentia's HPCP; with librosa CQT chroma the Temperley profiles
# rank the tonic above the subdominant more reliably, so they are the default
# (config: Thresholds.key_fallback_profile).
PROFILES = {
    "edma": (
        np.array([0.1652, 0.0475, 0.0829, 0.0669, 0.0999, 0.0927,
                  0.0529, 0.1316, 0.0522, 0.0744, 0.0694, 0.0663]),
        np.array([0.1724, 0.0400, 0.0761, 0.1211, 0.0355, 0.0887,
                  0.0537, 0.1349, 0.0702, 0.0536, 0.0921, 0.0516]),
    ),
    "temperley": (
        np.array([5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0]),
        np.array([5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0]),
    ),
}


@dataclass
class KeyResult:
    key: str | None          # "A"
    scale: str | None        # "minor" | "major"
    label: str | None        # "Am"
    camelot: str | None      # "8A"
    confidence: float
    uncertain: bool
    backend: str
    source: str              # "melodic" | "full_mix" | "override" | "none"

    @property
    def file_label(self) -> str:
        return self.label or "NoKey"


def normalize_pitch(name: str) -> int:
    name = name.strip()
    name = name[0].upper() + name[1:]
    name = _ALIASES.get(name, name)
    return PITCH_NAMES.index(name)


def camelot(pc: int, scale: str) -> str:
    if scale == "minor":
        return f"{((pc - 9) * 7 % 12 + 7) % 12 + 1}A"
    return f"{(pc * 7 % 12 + 7) % 12 + 1}B"


def make_label(pc: int, scale: str) -> str:
    return PITCH_NAMES[pc] + ("m" if scale == "minor" else "")


def parse_label(label: str) -> tuple[int, str]:
    """'Fm' / 'F#min' / 'Bb major' / 'A minor' -> (pitch class, scale)."""
    m = re.fullmatch(r"\s*([A-Ga-g][#b]?)\s*(m|min|minor|maj|major)?\s*", label)
    if not m:
        raise ValueError(f"Unrecognised key label: {label!r}")
    scale = "minor" if (m.group(2) or "").lower() in ("m", "min", "minor") else "major"
    return normalize_pitch(m.group(1)), scale


def result_from(pc: int, scale: str, confidence: float, th: Thresholds, backend: str,
                source: str) -> KeyResult:
    return KeyResult(key=PITCH_NAMES[pc], scale=scale, label=make_label(pc, scale),
                     camelot=camelot(pc, scale), confidence=float(confidence),
                     uncertain=confidence < th.key_min_confidence, backend=backend, source=source)


def override_result(label: str, th: Thresholds) -> KeyResult:
    pc, scale = parse_label(label)
    r = result_from(pc, scale, 1.0, th, "override", "override")
    r.uncertain = False
    return r


def no_key() -> KeyResult:
    return KeyResult(None, None, None, None, 0.0, True, "none", "none")


# --------------------------------------------------------------------------
# Backends
# --------------------------------------------------------------------------

def _import_essentia():
    import essentia

    essentia.log.infoActive = False      # silence the import-time INFO banner
    essentia.log.warningActive = False
    import essentia.standard as es
    return essentia, es


def essentia_available() -> bool:
    try:
        _import_essentia()
        return True
    except Exception:  # pragma: no cover - depends on the platform
        return False


def _essentia_key(mono: np.ndarray, sr: int) -> tuple[int, str, float]:
    _, es = _import_essentia()
    ke = es.KeyExtractor(profileType="edma", sampleRate=float(sr))
    key, scale, strength = ke(mono.astype(np.float32))
    return normalize_pitch(key), scale, float(strength)


def _fallback_key(mono: np.ndarray, sr: int, th: Thresholds) -> tuple[int, str, float]:
    import librosa

    target = 22050
    y = resample(mono.astype(np.float32), sr, target)
    hop = 4096
    chroma = librosa.feature.chroma_cqt(y=y, sr=target, hop_length=hop, bins_per_octave=36)
    rms = librosa.feature.rms(y=y, frame_length=2 * hop, hop_length=hop)[0]
    n = min(chroma.shape[1], len(rms))
    chroma, rms = chroma[:, :n], rms[:n]
    loud = 20 * np.log10(rms + 1e-12) > (20 * np.log10(rms.max() + 1e-12) + th.key_silence_db)
    profile = chroma[:, loud].mean(axis=1) if loud.any() else chroma.mean(axis=1)

    major, minor = PROFILES[th.key_fallback_profile]
    scores = []
    for scale, ref in (("major", major), ("minor", minor)):
        for pc in range(12):
            r = np.corrcoef(profile, np.roll(ref, pc))[0, 1]
            scores.append((float(r), pc, scale))
    scores.sort(reverse=True)
    best_r, pc, scale = scores[0]
    return pc, scale, max(0.0, best_r)


def detect_key_audio(mono: np.ndarray, sr: int, th: Thresholds, backend: str = "auto",
                     source: str = "melodic") -> KeyResult:
    if backend in ("auto", "essentia") and essentia_available():
        pc, scale, conf = _essentia_key(mono, sr)
        return result_from(pc, scale, conf, th, "essentia", source)
    if backend == "essentia":
        raise RuntimeError("essentia is not installed")
    pc, scale, conf = _fallback_key(mono, sr, th)
    return result_from(pc, scale, conf, th, "fallback", source)


def mix_for_key(stems: list[tuple[np.ndarray, int, bool]], th: Thresholds) -> tuple[np.ndarray, int]:
    """Sum mono stems (resampled to a common rate), weighting bass stems.

    `stems` is a list of (mono, sample_rate, is_bass).
    """
    sr = th.key_analysis_sr
    parts = [resample(m, s, sr) * (th.key_bass_weight if bass else 1.0) for m, s, bass in stems]
    n = max(len(p) for p in parts)
    mix = np.zeros(n, dtype=np.float32)
    for p in parts:
        mix[:len(p)] += p
    peak = float(np.max(np.abs(mix))) if n else 0.0
    if peak > 0:
        mix /= peak
    return mix, sr
