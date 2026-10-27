"""Rubber Band wrapper (SCOPE.md §5.7).

Whole stems are stretched once, before slicing, so loop boundaries stay
sample-exact. Tempo only; pitch is preserved.
"""

from __future__ import annotations

import functools
import logging
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from .audioutil import resample
from .config import Settings

log = logging.getLogger(__name__)


class StretchError(RuntimeError):
    pass


@dataclass(frozen=True)
class RubberBandInfo:
    path: str | None
    version: str | None
    supports_r3: bool


@functools.lru_cache(maxsize=8)
def rubberband_info(binary: str = "rubberband", r3_flag: str = "--fine") -> RubberBandInfo:
    path = shutil.which(binary)
    if not path:
        return RubberBandInfo(None, None, False)
    try:
        ver = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=10)
        version = (ver.stdout + ver.stderr).strip().splitlines()[0] if (ver.stdout + ver.stderr).strip() else None
        hlp = subprocess.run([path, "--help"], capture_output=True, text=True, timeout=10)
        supports = re.search(rf"(^|\s){re.escape(r3_flag)}\b", hlp.stdout + hlp.stderr) is not None
    except (OSError, subprocess.SubprocessError) as e:  # pragma: no cover
        log.warning("rubberband probe failed: %s", e)
        return RubberBandInfo(path, None, False)
    return RubberBandInfo(path, version, supports)


def effective_options(settings: Settings) -> tuple[list[str], list[str]]:
    """Configured options minus an R3 flag the installed version doesn't know."""
    info = rubberband_info(settings.rubberband_binary, settings.rubberband_r3_flag)
    opts = list(settings.rubberband_options)
    warnings: list[str] = []
    if settings.rubberband_r3_flag in opts and not info.supports_r3:
        opts.remove(settings.rubberband_r3_flag)
        warnings.append(f"Rubber Band {info.version or '?'} has no R3 engine "
                        f"({settings.rubberband_r3_flag}); using the default engine")
    return opts, warnings


def time_factor(source_bpm: float, library_bpm: float) -> float:
    """Duration multiplier: 122 -> 124 BPM gives 122/124 (shorter output).

    SCOPE.md calls this `ratio`; the stem's grid phase scales by the same
    factor (phase_out = phase_in * ratio).
    """
    return source_bpm / library_bpm


def stretch_allowed(source_bpm: float, library_bpm: float, max_stretch: float) -> bool:
    return abs(1.0 - time_factor(source_bpm, library_bpm)) <= max_stretch + 1e-12


def map_samples(pos: int, sr_in: int, source_bpm: float, library_bpm: float, sr_out: int) -> int:
    """Map a sample position in the source stem to the stretched/resampled stem."""
    return int(round(pos * (sr_out / sr_in) * time_factor(source_bpm, library_bpm)))


def stretch_stem(data: np.ndarray, sr: int, source_bpm: float, settings: Settings,
                 tmp_dir: Path | None = None) -> tuple[np.ndarray, int, list[str]]:
    """Resample to the output rate, then time-stretch to the library BPM.

    Returns (audio (n, ch) float32, output sample rate, warnings). The output
    length is exactly round(n_resampled * factor) samples.
    """
    out_sr = settings.output_sample_rate
    warnings: list[str] = []
    x = resample(data, sr, out_sr) if sr != out_sr else data
    factor = time_factor(source_bpm, settings.library_bpm)
    if factor == 1.0:
        return np.ascontiguousarray(x, dtype=np.float32), out_sr, warnings

    info = rubberband_info(settings.rubberband_binary, settings.rubberband_r3_flag)
    if not info.path:
        raise StretchError(f"Rubber Band binary not found: {settings.rubberband_binary}")
    opts, w = effective_options(settings)
    warnings += w
    expected = int(round(x.shape[0] * factor))

    with tempfile.TemporaryDirectory(dir=tmp_dir) as d:
        src, dst = Path(d) / "in.wav", Path(d) / "out.wav"
        sf.write(str(src), x, out_sr, subtype="FLOAT")
        cmd = [info.path, "-q", *opts, "--time", repr(factor), str(src), str(dst)]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise StretchError(f"rubberband failed ({proc.returncode}): {proc.stderr.strip()[-500:]}")
        y, _ = sf.read(str(dst), dtype="float32", always_2d=True)

    # Rubber Band's offline mode compensates its latency and produces the
    # requested length; guard against off-by-one rounding regardless.
    if y.shape[0] != expected:
        if abs(y.shape[0] - expected) > 2:
            log.warning("rubberband length %d != expected %d", y.shape[0], expected)
        y = y[:expected] if y.shape[0] > expected else np.pad(y, ((0, expected - y.shape[0]), (0, 0)))
    return np.ascontiguousarray(y), out_sr, warnings
