"""Vocals (SCOPE.md §6.11): a vocal take made into what Generate plays, and its renders.

ElevenLabs sings a take a cappella and doesn't keep to the tempo it's asked for, so nothing here
trusts a tempo. The take repeats the same lines over and over: the length of one repetition (the
self-similarity of its pitch and level, `vocal_period_*`) is its **phrase loop**, cut from the onset
of a line after a rest and stretched to a whole number of bars at the library tempo (1, 2, 4 or 8:
the nearest, within `vocal_max_stretch`), so it loops on the grid with its own phrasing inside. A
take may have several (a line sung again every 2 bars, both its lines every 8): one loop for each.
**Chops** are its syllables: from an onset to the next (at most `vocal_chop_max_s`), each with the
note it's sung on (pYIN), the clearest and loudest kept. Its **key** is read from the notes sung
(pitch classes weighted by how long and loud they're held, against major and minor profiles).

A phrase plays in a track moved into the track key by Rubber Band with its formants kept (the
voice stays natural) and stretched to the track tempo; chops play like a sampler.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from . import normalize
from .audioutil import k_energy_db, load, resample, write_wav
from .config import Settings, Thresholds

PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
# Krumhansl–Kessler key profiles.
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def sung_pitch(mono: np.ndarray, sr: int, th: Thresholds) -> tuple[np.ndarray, np.ndarray]:
    """(f0 in MIDI notes or nan, frame level) per `vocal_hop` frame (pYIN on a 22.05 kHz copy)."""
    import librosa
    y = resample(mono.astype(np.float32), sr, 22050)
    f0, voiced, _ = librosa.pyin(y, fmin=th.vocal_fmin_hz, fmax=th.vocal_fmax_hz, sr=22050,
                                 frame_length=2048, hop_length=th.vocal_hop)
    notes = np.where(voiced & ~np.isnan(f0), librosa.hz_to_midi(np.nan_to_num(f0, nan=1.0)), np.nan)
    level = librosa.feature.rms(y=y, frame_length=2048, hop_length=th.vocal_hop)[0][:len(notes)]
    return notes, level


def sung_key(notes: np.ndarray, level: np.ndarray) -> str | None:
    """The key of what's sung: pitch classes weighted by level, against the key profiles."""
    ok = ~np.isnan(notes)
    if ok.sum() < 20:
        return None
    hist = np.bincount(np.round(notes[ok]).astype(int) % 12, weights=level[ok], minlength=12)
    best, label = -2.0, None
    for root in range(12):
        for prof, minor in ((_MAJOR, False), (_MINOR, True)):
            r = float(np.corrcoef(hist, np.roll(prof, root))[0, 1])
            if r > best:
                best, label = r, PITCHES[root] + ("m" if minor else "")
    return label


def repetition_periods(notes: np.ndarray, level: np.ndarray, frame_s: float, th: Thresholds) -> list[float]:
    """Seconds after which the take sings the same again, shortest first: the lags where its pitch
    and level line up with themselves about as well as anywhere (peaks within `vocal_period_tie` of
    the best: a line sung again, both lines sung again), between `vocal_period_min_s` and half the take."""
    n = len(level)
    lo, hi = int(th.vocal_period_min_s / frame_s), n // 2
    if hi <= lo:
        return []
    lv = level / (level.max() + 1e-12)
    pc = np.nan_to_num(notes, nan=-100.0)
    scores = np.zeros(hi)
    for k in range(lo, hi):
        a, b = lv[:-k], lv[k:]
        same = np.abs(pc[:-k] - pc[k:]) < 1.0  # the same note k frames later
        scores[k] = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12)) * 0.5 + float(same.mean()) * 0.5
    best = float(scores.max())
    if best < th.vocal_period_min_score:
        return []
    out = []
    for k in range(lo, hi):
        peak = scores[k] >= scores[max(lo, k - 1)] and scores[k] >= scores[min(hi - 1, k + 1)]
        if peak and scores[k] >= best - th.vocal_period_tie:
            out.append(k * frame_s)
    return out


def line_starts(level: np.ndarray, frame_s: float, th: Thresholds) -> list[float]:
    """Seconds where a line starts: sound after a rest of at least `vocal_rest_s`."""
    on = level > level.max() * 10 ** (th.vocal_silence_db / 20)
    rest = int(th.vocal_rest_s / frame_s)
    out, quiet = [], rest
    for i, v in enumerate(on):
        if v and quiet >= rest:
            out.append(i * frame_s)
        quiet = 0 if v else quiet + 1
    return out


def fit_bars(seconds: float, bpm: float, th: Thresholds) -> int | None:
    """The bars (1, 2, 4 or 8) a phrase of `seconds` stretches to at `bpm` the least, if within reach."""
    bar = 4 * 60 / bpm
    best = min((1, 2, 4, 8), key=lambda n: abs(math.log(n * bar / seconds)))
    return best if abs(math.log(best * bar / seconds)) <= math.log(1 + th.vocal_max_stretch) else None


def analyze(settings: Settings, folder: str) -> dict:
    """Phrase loop, chops and key of a take (its vocal.wav), written into its folder (phrases/,
    chops/, analysis.json). Returns the analysis (paths library-relative)."""
    from . import stretch
    lib = Path(settings.library_path)
    d = lib / folder
    th = settings.thresholds
    a = load(d / "vocal.wav")
    sr = a.sr
    x = a.data if a.data.shape[1] == 2 else np.repeat(a.data[:, :1], 2, axis=1)
    mono = x.mean(axis=1)
    notes, level = sung_pitch(mono, sr, th)
    frame_s = th.vocal_hop / 22050
    key = sung_key(notes, level)
    bpm = settings.library_bpm
    out = {"key": key, "phrases": [], "chops": [], "bpm": bpm}

    # ---- the phrase loops: one per repetition length (a line, both lines), on whole bars ----
    starts = line_starts(level, frame_s, th)
    for period in repetition_periods(notes, level, frame_s, th) if starts else []:
        bars = fit_bars(period, bpm, th)
        if not bars or any(p["bars"] == bars for p in out["phrases"]):
            continue
        t0 = max(0.0, starts[0] - th.vocal_preroll_s)
        seg = x[int(t0 * sr):int((t0 + period) * sr)]
        if len(seg) < int(period * sr * 0.98):
            continue
        target = int(round(bars * 4 * 60 / bpm * sr))
        y = stretch.stretch_by(seg, sr, target / len(seg), settings) if abs(target - len(seg)) > 1 else seg
        y = y[:target] if len(y) >= target else np.pad(y, ((0, target - len(y)), (0, 0)))
        f = int(th.vocal_fade_ms * sr / 1000)
        y[:f] *= np.linspace(0, 1, f, dtype=np.float32)[:, None]
        y[-f:] *= np.linspace(1, 0, f, dtype=np.float32)[:, None]
        # At the level the mix balance takes rendered parts at (like the bass renders).
        y, _, _ = normalize.loudness_normalize(y, sr, th.bass_lufs_target, th.bass_peak_dbfs)
        rel = f"{folder}/phrases/phrase-{bars}bars.wav"
        write_wav(lib / rel, y, sr, "pcm24")
        out["phrases"].append({"path": rel, "bars": bars, "period_s": round(period, 3), "stretch": round(target / len(seg), 3)})

    # ---- chops: syllables with a clear note ----
    import librosa
    onsets = librosa.onset.onset_detect(y=mono, sr=sr, units="samples", backtrack=True, delta=th.vocal_onset_delta)
    cands = []
    for i, s in enumerate(onsets):
        e = min(onsets[i + 1] if i + 1 < len(onsets) else len(mono), s + int(th.vocal_chop_max_s * sr))
        if e - s < int(th.vocal_chop_min_s * sr):
            continue
        fr = slice(int(s / sr / frame_s), max(int(s / sr / frame_s) + 1, int(e / sr / frame_s)))
        ns = notes[fr]
        voiced = ns[~np.isnan(ns)]
        if len(voiced) < max(3, 0.5 * len(ns)):
            continue
        note = float(np.median(voiced))
        steady = float(np.std(voiced))
        loud = float(np.sqrt(np.mean(mono[s:e] ** 2)))
        cands.append((loud / (1 + steady), int(s), int(e), note))
    cands.sort(reverse=True)
    for k, (_, s, e, note) in enumerate(sorted(cands[:th.vocal_chops], key=lambda c: c[1])):
        y = x[s:e].copy()
        fi, fo = int(0.004 * sr), min(int(th.vocal_fade_ms * sr / 1000) * 2, (e - s) // 3)
        y[:fi] *= np.linspace(0, 1, fi, dtype=np.float32)[:, None]
        y[-fo:] *= np.linspace(1, 0, fo, dtype=np.float32)[:, None]
        y, _, _ = normalize.peak_normalize(y, th.hit_peak_dbfs)
        rel = f"{folder}/chops/chop-{k + 1:02d}.wav"
        write_wav(lib / rel, y, sr, "pcm24")
        out["chops"].append({"path": rel, "note": round(note, 2), "seconds": round((e - s) / sr, 3), "energy_db": k_energy_db(y, sr)})
    (d / "analysis.json").write_text(json.dumps(out, indent=2))
    return out


def render_phrase(settings: Settings, source: str, transpose: int, bpm: float, bars: int, out: Path) -> None:
    """A phrase loop (`source`, cut at the library tempo) moved `transpose` semitones with its
    formants kept and stretched to `bpm`: exactly `bars` bars, faded at its ends."""
    import subprocess
    import tempfile

    import soundfile as sf

    from . import stretch
    th = settings.thresholds
    a = load(Path(settings.library_path) / source)
    x = resample(a.data, a.sr, settings.output_sample_rate)
    sr = settings.output_sample_rate
    target = int(round(bars * 4 * 60 / bpm * sr))
    factor = target / len(x)
    if transpose or abs(factor - 1) > 1e-4:
        info = stretch.rubberband_info(settings.rubberband_binary, settings.rubberband_r3_flag)
        if not info.path:
            raise stretch.StretchError(f"Rubber Band binary not found: {settings.rubberband_binary}")
        opts, _ = stretch.effective_options(settings)
        with tempfile.TemporaryDirectory() as td:
            src, dst = Path(td) / "in.wav", Path(td) / "out.wav"
            sf.write(str(src), x, sr, subtype="FLOAT")
            cmd = [info.path, "-q", *opts, "--formant", "--pitch", str(transpose), "--time", repr(factor), str(src), str(dst)]
            p = subprocess.run(cmd, capture_output=True, text=True)
            if p.returncode != 0:
                raise stretch.StretchError(f"rubberband failed ({p.returncode}): {p.stderr.strip()[-300:]}")
            x, _ = sf.read(str(dst), dtype="float32", always_2d=True)
    x = x[:target] if len(x) >= target else np.pad(x, ((0, target - len(x)), (0, 0)))
    f = int(th.vocal_fade_ms * sr / 1000)
    x[:f] *= np.linspace(0, 1, f, dtype=np.float32)[:, None]
    x[-f:] *= np.linspace(1, 0, f, dtype=np.float32)[:, None]
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f".{out.name}.part")
    sf.write(str(tmp), x, sr, subtype="PCM_24", format="WAV")
    tmp.replace(out)
