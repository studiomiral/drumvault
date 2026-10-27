"""Kick-based BPM and grid detection (SCOPE.md §5.4)."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field, replace

import numpy as np
from scipy import signal

from .audioutil import attack_sample, causal_envelope
from .config import Settings

log = logging.getLogger(__name__)

BPM_RE = re.compile(r"(\d{2,3}(?:\.\d+)?)\s?bpm", re.IGNORECASE)

# Source preference: first category present wins.
SOURCE_ORDER = ["kick", "drums", "clap", "snare", "full_mix"]
LOWPASS_SOURCES = {"kick", "drums", "full_mix", "sum"}


@dataclass
class TempoResult:
    bpm: float
    phase_samples: int            # at `sample_rate`
    sample_rate: int
    confidence: float
    source_stem: str              # stem name, or "sum"
    source_category: str
    raw_bpm: float = 0.0          # least-squares fit, before rounding / filename / override
    detected_bpm: float = 0.0     # what detection settled on (rounded, filename), ignoring the override
    warnings: list[str] = field(default_factory=list)
    grid_warning: bool = False
    bpm_warning: bool = False     # raw detection was far from a whole number


def pick_source(categories: dict[str, str]) -> tuple[str, list[str]]:
    """Choose the tempo source category and the stems that belong to it."""
    for cat in SOURCE_ORDER:
        names = [n for n, c in categories.items() if c == cat]
        if names:
            return cat, sorted(names)
    return "sum", sorted(categories)


def filename_bpms(names: list[str]) -> list[float]:
    out = []
    for n in names:
        for m in BPM_RE.finditer(n.replace("_", " ")):
            v = float(m.group(1))
            if 40 <= v <= 250:
                out.append(v)
    return out


def _attack_times(x: np.ndarray, sr: int, onsets: np.ndarray, th) -> np.ndarray:
    """Refine backtracked onsets to sample precision."""
    env = causal_envelope(x, int(th.tempo_envelope_ms * sr / 1000))
    after = int(th.tempo_attack_search_ms * sr / 1000)
    pre = 2 * th.tempo_hop
    return np.asarray([attack_sample(env, max(0, int(o) - pre), min(len(x), int(o) + after),
                                     th.tempo_attack_rel)[0] for o in onsets], dtype=np.float64)


def onset_times(mono: np.ndarray, sr: int, category: str, settings: Settings) -> tuple[np.ndarray, np.ndarray, int]:
    """Strong onset times in seconds, the onset envelope, and its hop."""
    import librosa

    th = settings.thresholds
    raw = x = mono.astype(np.float64)
    if category in LOWPASS_SOURCES:
        sos = signal.butter(4, th.tempo_lowpass_hz, btype="lowpass", fs=sr, output="sos")
        x = signal.sosfiltfilt(sos, x)  # zero phase: no timing shift
    hop = th.tempo_hop
    # Energy novelty: librosa onset strength over a log-RMS "spectrogram". Far
    # more precise than mel spectral flux for a low-passed kick.
    rms = librosa.feature.rms(y=x.astype(np.float32), frame_length=4 * hop, hop_length=hop, center=True)
    log_rms = librosa.amplitude_to_db(rms, ref=np.max, top_db=-th.tempo_rms_floor_db)
    env = librosa.onset.onset_strength(S=log_rms, lag=1, max_size=1)
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, backtrack=True,
                                        units="frames")
    if len(frames) == 0:
        return np.zeros(0), env, hop
    # Strength of each onset = peak of the envelope just after the backtracked frame.
    strength = np.array([env[f:f + 8].max() for f in frames])
    ref = np.percentile(strength, 95)
    strong = frames[strength >= th.tempo_strong_onset_rel * ref]
    samples = librosa.frames_to_samples(strong, hop_length=hop)
    # Single-sound stems: refine on the raw signal (sharp attack, no filter
    # pre-ringing). Mixed sources keep the low-pass so hats don't trigger it.
    ref_sig = raw if category in ("kick", "clap", "snare") else x
    samples = _attack_times(ref_sig, sr, samples, th)
    return samples / sr, env, hop


def rough_bpm(env: np.ndarray, sr: int, hop: int, bpm_min: float, bpm_max: float) -> float:
    """Autocorrelation of the onset envelope, restricted to the BPM range.

    Each candidate beat lag L is scored by ac[L] + ac[2L] + ac[4L], so a source
    that only hits every other beat (claps/snares on 2 and 4) still locks to
    the beat rather than to a wrong tempo inside the range.
    """
    e = env - env.mean()
    n = len(e)
    nfft = 1 << int(np.ceil(np.log2(2 * n)))
    spec = np.fft.rfft(e, nfft)
    ac = np.fft.irfft(spec * np.conj(spec), nfft)[:n]
    fps = sr / hop
    lag_min = int(np.floor(60.0 * fps / bpm_max))
    lag_max = int(np.ceil(60.0 * fps / bpm_min))
    lag_max = min(lag_max, n - 2)
    if lag_max <= lag_min:
        return (bpm_min + bpm_max) / 2
    def score(lag: np.ndarray) -> np.ndarray:
        out = ac[lag].copy()
        for mult in (2, 4):
            ok = lag * mult < n
            out[ok] += ac[lag[ok] * mult]
        return out

    lags = np.arange(lag_min, lag_max + 1)
    sc = score(lags)
    i = int(np.argmax(sc))
    k = int(lags[i])
    delta = 0.0
    if 0 < i < len(lags) - 1:
        # Parabolic interpolation on the score for sub-frame precision.
        y0, y1, y2 = sc[i - 1], sc[i], sc[i + 1]
        denom = y0 - 2 * y1 + y2
        if denom < 0:
            delta = float(np.clip(0.5 * (y0 - y2) / denom, -0.5, 0.5))
    return 60.0 * fps / (k + delta)


def _circular_phase(times: np.ndarray, period: float) -> float:
    ang = 2 * np.pi * times / period
    return (np.angle(np.mean(np.exp(1j * ang))) / (2 * np.pi)) * period % period


def fit_grid(times: np.ndarray, period: float, iterations: int, inlier_frac: float) -> tuple[float, float]:
    """Least-squares fit of t_n = phase + n * period to the onset times."""
    phase = _circular_phase(times, period)
    for _ in range(iterations):
        n = np.round((times - phase) / period)
        resid = times - (phase + n * period)
        inl = np.abs(resid) < inlier_frac * period
        if inl.sum() < 2 or len(np.unique(n[inl])) < 2:
            break
        A = np.stack([np.ones(inl.sum()), n[inl]], 1)
        (phase, period), *_ = np.linalg.lstsq(A, times[inl], rcond=None)
    return float(phase), float(period)


def fit_phase(times: np.ndarray, period: float, inlier_frac: float) -> float:
    """Best phase for a fixed period (after snapping the BPM)."""
    phase = _circular_phase(times, period)
    for _ in range(2):
        n = np.round((times - phase) / period)
        resid = times - (phase + n * period)
        inl = np.abs(resid) < inlier_frac * period
        if inl.any():
            phase += float(np.mean(resid[inl]))
    return phase % period


def grid_confidence(times: np.ndarray, phase: float, period: float, window_s: float) -> float:
    if len(times) == 0:
        return 0.0
    n = np.round((times - phase) / period)
    resid = np.abs(times - (phase + n * period))
    return float(np.mean(resid <= window_s))


def detect_tempo(mono: np.ndarray, sr: int, settings: Settings, *, source_stem: str = "",
                 source_category: str = "kick", names_for_bpm: list[str] | None = None,
                 bpm_override: float | None = None, grid_offset_ms: float | None = None) -> TempoResult:
    th = settings.thresholds
    warnings: list[str] = []
    times, env, hop = onset_times(mono, sr, source_category, settings)
    if len(times) < 4 and bpm_override is None:
        return TempoResult(bpm=settings.library_bpm, phase_samples=0, sample_rate=sr, confidence=0.0,
                           source_stem=source_stem, source_category=source_category,
                           raw_bpm=0.0, warnings=["Too few onsets to detect tempo"], grid_warning=True)

    raw = rough_bpm(env, sr, hop, settings.bpm_min, settings.bpm_max)
    phase, period = fit_grid(times, 60.0 / raw, th.tempo_refine_iterations, th.tempo_inlier_beat_fraction)
    bpm = 60.0 / period
    raw_bpm = bpm

    near_integer = abs(bpm - round(bpm)) <= th.tempo_integer_snap
    if near_integer or settings.integer_bpm:
        bpm = float(round(bpm))
    from_filename = False
    for fb in filename_bpms(names_for_bpm or []):
        if abs(fb - raw_bpm) <= th.tempo_filename_tolerance:
            from_filename = True
            fb = float(round(fb)) if settings.integer_bpm else fb
            if abs(fb - bpm) > 1e-9 and not bpm_override:
                warnings.append(f"Using BPM {fb:g} from filename (detected {raw_bpm:.3f})")
            bpm = fb
            break
    detected_bpm = bpm
    bpm_warning = False
    if bpm_override:
        bpm = float(bpm_override)
    elif settings.integer_bpm and not near_integer and not from_filename:
        bpm_warning = True
        warnings.append(f"Detected {raw_bpm:.2f} BPM, which is not a whole number; using {bpm:g}. "
                        f"Check the kick stem or set the BPM manually")
    period = 60.0 / bpm
    if len(times):
        phase = fit_phase(times, period, th.tempo_inlier_beat_fraction)

    grid_warning = False
    tol = th.tempo_phase_tolerance_ms / 1000.0
    if grid_offset_ms is not None:
        # Set by hand in the Grid view. Hits ahead of the very first downbeat (a negative
        # offset) start the grid one bar later, so cuts never begin before sample 0.
        phase_s = grid_offset_ms / 1000.0
        while phase_s < 0:
            phase_s += 4 * period
    elif min(phase, period - phase) <= tol:
        phase_s = 0.0
    else:
        # Not exported from bar 1: take the first strong kick (on the grid) as the downbeat.
        n = np.round((times - phase) / period)
        resid = np.abs(times - (phase + n * period))
        on_grid = times[resid <= th.tempo_confidence_window_ms / 1000.0]
        first = on_grid[0] if len(on_grid) else times[0]
        phase_s = phase + np.round((first - phase) / period) * period
        grid_warning = True
        warnings.append(f"Grid does not start at sample 0 (offset {phase * 1000:.1f} ms within the "
                        f"beat); using first kick at {phase_s:.3f}s as bar 1")

    conf = grid_confidence(times, phase_s, period, th.tempo_confidence_window_ms / 1000.0)
    conf *= th.tempo_fallback_penalty.get(source_category, th.tempo_fallback_penalty.get("sum", 0.8))
    if source_category != "kick":
        warnings.append(f"No kick stem; tempo detected from {source_category}")
    return TempoResult(bpm=float(bpm), phase_samples=int(round(phase_s * sr)), sample_rate=sr,
                       confidence=float(conf), source_stem=source_stem, source_category=source_category,
                       raw_bpm=float(raw_bpm), detected_bpm=float(detected_bpm), warnings=warnings,
                       grid_warning=grid_warning, bpm_warning=bpm_warning)


def stem_grid_offset(mono: np.ndarray, sr: int, category: str, bpm: float, settings: Settings) -> float | None:
    """Median signed distance (s) of a stem's strong onsets from a 16th grid starting at sample 0."""
    times, _, _ = onset_times(mono, sr, category, settings)
    if len(times) < settings.thresholds.tempo_bar_one_min_onsets:
        return None
    step = 60.0 / bpm / 4
    return float(np.median(times - np.round(times / step) * step))


def keep_bar_one(res: TempoResult, offsets: list[float], th) -> TempoResult:
    """The kick moved bar 1 off sample 0, but the other drums sit on a grid from sample 0.

    Then the stems were exported from bar 1 and only the kick is late (a slow attack or a
    nudged sample): keep bar 1 at sample 0, or every loop is cut late and flams.
    """
    if not res.grid_warning or not offsets or abs(float(np.median(offsets))) * 1000 > th.tempo_phase_tolerance_ms:
        return res
    period = 60.0 / res.bpm
    late_ms = ((res.phase_samples / res.sample_rate) % period) * 1000
    warnings = [w for w in res.warnings if not w.startswith("Grid does not start")]
    warnings.append(f"The {res.source_category} hits {late_ms:.0f} ms after the grid of the other drums; "
                    f"bar 1 kept at the start of the stems")
    return replace(res, phase_samples=0, grid_warning=False, warnings=warnings)
