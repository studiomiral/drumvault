"""Mastering (SCOPE.md §6.5): the export's mixdown through Ozone 11 into `mastered.wav`, as House of
Tracks takes it: its loudest moment (momentary loudness, a meter's M) on the target (`master_target_lufs`),
the limiter's ceiling at `master_ceiling_db`.

The basic chain: the mixdown is first brought to one level (`master_pre_lufs`), so the compressor
works the same on every track; Ozone 11 Dynamics glues it gently (every band alike, RMS detection);
the Ozone 11 Maximizer, with some soft clip, takes it the rest of the way. Its input gain is solved
pass by pass until the result's loudest 400 ms measure the target (momentary LUFS, BS.1770). Ozone
is hosted like Serum (pedalboard), which compensates its look-ahead, so mastered.wav lines up with
the mixdown sample for sample and has its length. A pass over a six-minute track takes a few seconds.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from .config import Settings, Thresholds

log = logging.getLogger(__name__)

SUBTYPES = {"pcm24": "PCM_24", "float32": "FLOAT"}


class MasterError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def integrated_lufs(data: np.ndarray, sr: int) -> float:
    """Integrated loudness (BS.1770-4, gated) of (frames, channels) audio; -inf when silent."""
    import pyloudnorm
    return float(pyloudnorm.Meter(sr).integrated_loudness(data))


def max_loudness_lufs(data: np.ndarray, sr: int, window_s: float, hop_s: float = 0.1) -> float:
    """The loudest `window_s` of (frames, channels) audio in LUFS (BS.1770 momentary at 0.4 s,
    short-term at 3 s: each channel K-weighted, their powers summed, ungated), windows every `hop_s`;
    -inf when silent."""
    from .audioutil import k_weight
    power = sum(np.square(k_weight(data[:, c], sr)) for c in range(data.shape[1]))
    n = min(len(power), max(1, int(round(window_s * sr))))
    c = np.concatenate([[0.0], np.cumsum(power)])
    starts = np.arange(0, len(power) - n + 1, max(1, int(round(hop_s * sr))))
    loudest = float(np.max(c[starts + n] - c[starts])) / n
    return -0.691 + 10 * np.log10(loudest) if loudest > 0 else float("-inf")


def solve_gain(render: Callable[[float], np.ndarray], loudness: Callable[[np.ndarray], float], target: float,
               lo: float, hi: float, tolerance: float, passes: int) -> tuple[float, np.ndarray, float, int]:
    """The gain in [lo, hi] (dB) at which `render` measures `target`: loudness rises with the gain
    (a limiter's input), so bisection, steered by the secant between the bounds' measurements.
    Returns the gain, its render, its loudness and the passes it took; the closest one tried when
    `passes` run out (or the target lies outside what [lo, hi] can reach)."""
    best: tuple[float, np.ndarray, float] | None = None
    l_lo = l_hi = None
    g = (lo + hi) / 2
    n = 0
    for n in range(1, passes + 1):
        y = render(g)
        lu = loudness(y)
        if best is None or abs(lu - target) < abs(best[2] - target):
            best = (g, y, lu)
        if abs(lu - target) <= tolerance:
            break
        if lu < target:
            lo, l_lo = g, lu
        else:
            hi, l_hi = g, lu
        # Between the bounds, where the line through their loudness meets the target (once both are
        # measured), kept off the edges so a flat stretch can't stall it.
        if l_lo is not None and l_hi is not None and l_hi > l_lo:
            g = lo + (hi - lo) * min(0.9, max(0.1, (target - l_lo) / (l_hi - l_lo)))
        else:
            g = (lo + hi) / 2
    assert best is not None
    return best[0], best[1], best[2], n


def _set(plugin, name: str, value) -> None:
    """Set a plugin parameter to the valid value nearest `value`. Ozone lists its values as text in
    the Mac's number format ('0,00' with a Dutch locale), so a plain float isn't accepted."""
    prm = plugin.parameters[name]
    if isinstance(value, (bool, str)):
        setattr(plugin, name, value)
        return
    vals = prm.valid_values
    nums = [float(str(v).replace(",", ".")) for v in vals]
    setattr(plugin, name, vals[int(np.argmin([abs(x - value) for x in nums]))])


class _Chain:
    """Ozone's Dynamics and Maximizer, loaded once for the engine's lifetime; renders are serialised."""

    def __init__(self, dynamics_path: str, maximizer_path: str):
        self.paths = (dynamics_path, maximizer_path)
        self._plugins = None
        self.lock = threading.Lock()

    def plugins(self):
        if self._plugins is None:
            for p in self.paths:
                if not Path(p).exists():
                    raise MasterError("no_ozone", f"Ozone 11 not found at {p}")
            from pedalboard import load_plugin
            log.info("loading Ozone 11 (%s, %s)", *self.paths)
            self._plugins = tuple(load_plugin(p) for p in self.paths)
        return self._plugins


_chain: _Chain | None = None
_chain_lock = threading.Lock()


def _chain_for(settings: Settings) -> _Chain:
    global _chain
    with _chain_lock:
        paths = (settings.ozone_dynamics_plugin, settings.ozone_maximizer_plugin)
        if _chain is None or _chain.paths != paths:
            _chain = _Chain(*paths)
        return _chain


def _configure(dyn, mx, th: Thresholds) -> None:
    _set(dyn, "dyn_stereo_main_level_detection_method", "RMS")
    for b in range(1, 5):
        for k, v in (("comp_threshold", th.master_glue_threshold_db), ("comp_ratio", th.master_glue_ratio),
                     ("comp_attack", th.master_glue_attack_ms), ("comp_release", th.master_glue_release_ms),
                     ("lim_threshold", 0.0), ("gain", 0.0), ("mix", 100.0)):
            _set(dyn, f"dyn_stereo_main_band_{b}_{k}", v)
    _set(mx, "max_output_level", th.master_ceiling_db)
    _set(mx, "max_soft_clip_on_off", th.master_soft_clip_mix > 0)
    if th.master_soft_clip_mix > 0:
        _set(mx, "max_soft_clip_mix", th.master_soft_clip_mix)


def master_mixdown(settings: Settings, mix_path: str, out_path: str, fmt: str = "pcm24") -> dict:
    """Master the mixdown at `mix_path` into `out_path` (a .wav in the same folder) and report
    {"lufs", "peak_db", "gain_db", "passes"}."""
    mix, out = Path(mix_path), Path(out_path)
    if not (mix.is_absolute() and out.is_absolute() and mix.suffix.lower() == ".wav" and out.suffix.lower() == ".wav"
            and out.parent == mix.parent and out != mix):
        raise MasterError("bad_path", f"Bad master paths: {mix_path} → {out_path}")
    if fmt not in SUBTYPES:
        raise MasterError("bad_request", f"Unknown format {fmt}")
    if not mix.exists():
        raise MasterError("not_found", f"No mixdown at {mix_path}")
    th = settings.thresholds
    data, sr = sf.read(str(mix), dtype="float32", always_2d=True)
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    level = integrated_lufs(data, sr)
    if not np.isfinite(level):
        raise MasterError("silent", "The mixdown is silent")
    x = np.ascontiguousarray((data * 10 ** ((th.master_pre_lufs - level) / 20)).T)

    chain = _chain_for(settings)
    with chain.lock:
        from pedalboard import Pedalboard
        dyn, mx = chain.plugins()
        _configure(dyn, mx, th)
        board = Pedalboard([dyn, mx])

        def render(g: float) -> np.ndarray:
            _set(mx, "max_input_gain_db", g)
            return np.asarray(board(x, sr, reset=True), dtype=np.float32).T

        lo, hi = (float(v.replace(",", ".")) for v in (mx.parameters["max_input_gain_db"].valid_values[0],
                                                       mx.parameters["max_input_gain_db"].valid_values[-1]))
        gain, y, loudest, passes = solve_gain(render, lambda a: max_loudness_lufs(a, sr, th.master_loudness_window_s, th.master_loudness_hop_s),
                                            th.master_target_lufs, lo, hi, th.master_tolerance_lu, th.master_max_passes)
    if abs(loudest - th.master_target_lufs) > th.master_tolerance_lu * 3:
        raise MasterError("off_target", f"Mastering reached {loudest:.1f} LUFS at its loudest, not {th.master_target_lufs} (Maximizer at {gain:.1f} dB)")
    y = y[:data.shape[0]]
    lufs = integrated_lufs(y, sr)
    tmp = out.with_name(f".{out.name}.part")
    sf.write(str(tmp), y, sr, subtype=SUBTYPES[fmt], format="WAV")
    tmp.replace(out)
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    log.info("mastered %s: %.2f LUFS at its loudest (momentary), %.2f integrated, peak %.2f dBFS, Maximizer %.2f dB (%d passes)",
             out.name, loudest, lufs, 20 * np.log10(max(peak, 1e-12)), gain, passes)
    return {"lufs": round(float(lufs), 2), "max_lufs": round(float(loudest), 2),
            "peak_db": round(20 * float(np.log10(max(peak, 1e-12))), 2), "gain_db": round(float(gain), 2), "passes": passes}
