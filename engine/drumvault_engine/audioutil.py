"""Small audio helpers shared by the analysis modules."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr

EPS = 1e-12


@dataclass
class Audio:
    """Float32 audio, shape (frames, channels)."""
    data: np.ndarray
    sr: int

    @property
    def frames(self) -> int:
        return self.data.shape[0]

    @property
    def channels(self) -> int:
        return self.data.shape[1]

    @property
    def duration(self) -> float:
        return self.frames / self.sr

    def mono(self) -> np.ndarray:
        return to_mono(self.data)


def load(path: Path | str) -> Audio:
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return Audio(np.ascontiguousarray(data), int(sr))


def info(path: Path | str) -> tuple[int, int, int]:
    """(frames, sample_rate, channels) without decoding."""
    i = sf.info(str(path))
    return int(i.frames), int(i.samplerate), int(i.channels)


def to_mono(x: np.ndarray) -> np.ndarray:
    if x.ndim == 1:
        return x.astype(np.float32, copy=False)
    return x.mean(axis=1, dtype=np.float32)


def db_to_amp(db: float) -> float:
    return float(10.0 ** (db / 20.0))


def amp_to_db(a: float) -> float:
    return float(20.0 * np.log10(max(float(a), EPS)))


def peak(x: np.ndarray) -> float:
    return float(np.max(np.abs(x))) if x.size else 0.0


def rms_db(x: np.ndarray) -> float:
    if x.size == 0:
        return -240.0
    return amp_to_db(float(np.sqrt(np.mean(np.square(x, dtype=np.float64)))))


def causal_envelope(x: np.ndarray, window: int) -> np.ndarray:
    """Running max of |x| over the trailing `window` samples.

    Bridges zero crossings and noise dips without moving a rising edge earlier
    (unlike a centred filter or a Hilbert envelope).
    """
    from scipy.ndimage import maximum_filter1d

    window = max(1, int(window))
    return maximum_filter1d(np.abs(x), size=window, origin=(window - 1) // 2)


def attack_sample(env: np.ndarray, start: int, stop: int, rel: float) -> tuple[int, int]:
    """(attack, peak) of the hit whose envelope peak lies in env[start:stop].

    The attack is the first rise through `rel` x peak. If a previous hit's
    tail is already above that level at `start`, the attack is instead the
    envelope's trough between that tail and the new peak.
    """
    seg = env[start:stop]
    if seg.size == 0 or seg.max() <= 0:
        return start, start
    pk = int(np.argmax(seg))
    thr = rel * seg[pk]
    if seg[0] < thr:
        att = int(np.argmax(seg[:pk + 1] >= thr))
    else:
        att = int(np.argmin(seg[:pk + 1]))
    return start + att, start + pk


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """High-quality resample along axis 0 (works for 1-D or (n, ch))."""
    if sr_in == sr_out:
        return x
    return soxr.resample(x, sr_in, sr_out, quality="VHQ").astype(np.float32)


def logmel_fingerprint(mono: np.ndarray, sr: int, th, n_frames: int | None = None,
                       frames_per_chunk: int | None = None) -> np.ndarray:
    """Level-invariant log-mel fingerprint, flattened and L2-normalised.

    The audio is resampled to a fixed rate so fingerprints are comparable
    across sources. If `n_frames` is given the spectrogram is cropped/padded
    to that many STFT frames (one-shots). If `frames_per_chunk` is given it is
    instead pooled into that many equal time chunks (loops, coarse grid).
    """
    import librosa

    y = resample(mono.astype(np.float32), sr, th.fingerprint_sr)
    if len(y) < th.fingerprint_n_fft:
        y = np.pad(y, (0, th.fingerprint_n_fft - len(y)))
    S = librosa.feature.melspectrogram(
        y=y, sr=th.fingerprint_sr, n_fft=th.fingerprint_n_fft,
        hop_length=th.fingerprint_hop, n_mels=th.fingerprint_n_mels, power=2.0,
    )
    if frames_per_chunk is not None:
        edges = np.linspace(0, S.shape[1], frames_per_chunk + 1).astype(int)
        S = np.stack([S[:, a:max(b, a + 1)].mean(axis=1) for a, b in zip(edges[:-1], edges[1:])], 1)
    if n_frames is not None:
        S = S[:, :n_frames]
        if S.shape[1] < n_frames:
            S = np.pad(S, ((0, 0), (0, n_frames - S.shape[1])))
    ref = max(float(S.max()), EPS)
    L = librosa.power_to_db(S, ref=ref, top_db=th.fingerprint_top_db) + th.fingerprint_top_db
    v = L.astype(np.float32).ravel()
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b))


def write_wav(path: Path, data: np.ndarray, sr: int, fmt: str) -> None:
    subtype = "FLOAT" if fmt == "float32" else "PCM_24"
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), data if data.shape[1] > 1 else data[:, 0], sr, subtype=subtype, format="WAV")
