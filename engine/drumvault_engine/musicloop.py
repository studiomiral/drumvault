"""Music loops (SCOPE.md §6.11b): loops of music (chords, guitars, keys, a riff) dropped on the Music
Loops page, played by some new house tracks in place of the chord stabs. Each is kept in
<Library>/Music Loops/<id>/ (loop.wav: its whole bars, cut on its own grid; meta.json), like a
Splice vocal loop is kept as a take, and marked used once a track with it is exported.

It is **never heard as it was**: every render moves it 1 to 3 semitones into the track key (Rubber
Band, its length set by the track tempo; no formants: it's an instrument) and colours it, an EQ
(a low cut, a bell in the mids, a high shelf) and a soft saturation, drawn per track by the app.

Its **tempo**: the one in its name, else the one that makes it whole bars (1, 2, 4, 8 or 16) in
`music_loop_bpm_*`, nearest the library tempo. Its **key**: the name's, else the one heard.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy import signal

from . import key as keymod, normalize, stretch, zipio
from .audioutil import load, resample, write_wav
from .config import Settings, Thresholds
from .samples import name_key
from .splice import name_bpm

FOLDER = "Music Loops"
_BARS = (1, 2, 4, 8)


class MusicLoopError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# ---- a loop from a file ------------------------------------------------------------------------

def loop_tempo(name: str, seconds: float, library_bpm: float, th: Thresholds) -> tuple[float | None, str]:
    """(tempo, where it's from): the name's, else the tempo at which `seconds` is whole bars
    (1, 2, 4, 8 or 16) within `music_loop_bpm_*`, nearest the library tempo; (None, 'none')."""
    named = name_bpm(name, th.splice_bpm_min, th.splice_bpm_max)
    if named:
        return float(named), "name"
    cands = [b * 240.0 / seconds for b in (1, 2, 4, 8, 16) if seconds > 0]
    cands = [t for t in cands if th.music_loop_bpm_min <= t <= th.music_loop_bpm_max]
    if not cands:
        return None, "none"
    return round(min(cands, key=lambda t: abs(t - library_bpm)), 2), "length"


def whole_bars(x: np.ndarray, sr: int, tempo: float, th: Thresholds) -> tuple[np.ndarray, int]:
    """The loop's whole bars (1, 2, 4 or 8) from its start, sample-exact on its own grid; of a longer
    one, the 8 bars on a 4-bar line that are loudest. (frames, bars); bars 0 when under a bar."""
    bar = 240.0 / tempo * sr
    own = x.shape[0] / bar
    bars = max([b for b in _BARS if b <= own + th.music_loop_bars_tolerance] or [0])
    if not bars:
        return x[:0], 0
    starts = list(range(0, max(1, int(own + th.music_loop_bars_tolerance) - bars + 1), 4))

    def energy(k: int) -> float:
        seg = x[int(round(k * bar)):int(round((k + bars) * bar))]
        return float(np.mean(np.square(seg))) if len(seg) else 0.0

    first = max(starts, key=energy)
    n = int(round(bars * bar))
    seg = x[int(round(first * bar)):int(round(first * bar)) + n]
    if seg.shape[0] < n:  # (a loop a hair short of its bars: the rest silent)
        seg = np.pad(seg, ((0, n - seg.shape[0]), (0, 0)))
    return np.ascontiguousarray(seg), bars


def _taken(lib: Path) -> dict[str, str]:
    """The music loops there are: their files' SHA-1 → loop id."""
    out = {}
    for m in (lib / FOLDER).glob("*/meta.json"):
        try:
            meta = json.loads(m.read_text())
        except (OSError, ValueError):
            continue
        if meta.get("sha1"):
            out[meta["sha1"]] = meta.get("id", m.parent.name)
    return out


def import_one(settings: Settings, path: Path, taken: dict[str, str]) -> dict:
    """One file made into a music loop. {"id", "name", "status": "imported" | "skipped", …}."""
    lib = Path(settings.library_path)
    th = settings.thresholds
    sha = hashlib.sha1(path.read_bytes()).hexdigest()
    if sha in taken:
        return {"id": taken[sha], "name": path.name, "status": "skipped"}
    a = load(path)
    sr = settings.output_sample_rate
    x = resample(a.data if a.data.shape[1] == 2 else np.repeat(a.data[:, :1], 2, axis=1), a.sr, sr).astype(np.float32)
    seconds = x.shape[0] / sr
    if not th.music_loop_min_s <= seconds <= th.music_loop_max_s:
        raise MusicLoopError("length", f"{path.name}: {seconds:.1f} s (a music loop is {th.music_loop_min_s:g}–{th.music_loop_max_s:g} s)")
    if float(np.max(np.abs(x))) <= 1e-5:
        raise MusicLoopError("silent", f"{path.name}: silent")
    tempo, tempo_source = loop_tempo(path.name, seconds, settings.library_bpm, th)
    if not tempo:
        raise MusicLoopError("no_tempo", f"{path.name}: no tempo in its name, and its length isn't whole bars at a house tempo")
    seg, bars = whole_bars(x, sr, tempo, th)
    if not bars:
        raise MusicLoopError("short", f"{path.name}: shorter than a bar at {tempo:g} BPM")
    named = name_key(path.name)
    if named:
        key, key_source = named[0], "name"
    else:
        k = keymod.detect_key_audio(seg.mean(axis=1), sr, th)
        key, key_source = (k.label, "heard") if k.label else (None, "none")
    lid = f"music-{sha[:12]}"
    folder = f"{FOLDER}/{lid}"
    d = lib / folder
    d.mkdir(parents=True, exist_ok=True)
    # (Cut on its grid, no fades: SCOPE.md's loops. At its own level: the render is levelled.)
    write_wav(d / "loop.wav", seg, sr, "pcm24")
    meta = {
        "id": lid, "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "file": path.name, "original": str(path), "sha1": sha, "loop": f"{folder}/loop.wav",
        "bpm": tempo, "tempoSource": tempo_source, "bars": bars, "key": key, "keySource": key_source,
        "seconds": round(seconds, 3), "usedIn": [], "genre": settings.genre,
    }
    (d / "meta.json").write_text(json.dumps(meta, indent=2))
    taken[sha] = lid
    return {"id": lid, "name": path.name, "status": "imported", "key": key, "bpm": tempo, "bars": bars}


def import_loops(settings: Settings, paths: list[str]) -> dict:
    """Music loops from files and folders."""
    if not settings.library_path:
        raise MusicLoopError("no_library", "No library folder configured")
    files: list[Path] = []
    for p in map(Path, paths):
        if p.is_dir():
            files += sorted(q for q in p.rglob("*") if q.is_file() and q.suffix.lower() in zipio.AUDIO_EXTS
                            and not zipio.is_junk(q.relative_to(p).as_posix()))
        elif p.is_file() and p.suffix.lower() in zipio.AUDIO_EXTS:
            files.append(p)
    if not files:
        raise MusicLoopError("no_audio", "No audio files (.wav, .aif, .flac) in what was added")
    taken = _taken(Path(settings.library_path))
    imported, skipped, failed = [], 0, []
    for f in files:
        try:
            r = import_one(settings, f, taken)
        except (MusicLoopError, OSError, RuntimeError, ValueError) as e:
            failed.append(str(e) if isinstance(e, MusicLoopError) else f"{f.name}: {e}")
            continue
        if r["status"] == "skipped":
            skipped += 1
        else:
            imported.append(r)
    return {"imported": imported, "skipped": skipped, "failed": failed}


# ---- its render in a track ---------------------------------------------------------------------

def _peaking(f0: float, db: float, q: float, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """RBJ peaking EQ."""
    A = 10 ** (db / 40)
    w = 2 * np.pi * f0 / sr
    al = np.sin(w) / (2 * q)
    b = np.array([1 + al * A, -2 * np.cos(w), 1 - al * A])
    a = np.array([1 + al / A, -2 * np.cos(w), 1 - al / A])
    return b / a[0], a / a[0]


def _high_shelf(f0: float, db: float, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """RBJ high shelf, slope 1."""
    A = 10 ** (db / 40)
    w = 2 * np.pi * f0 / sr
    al = np.sin(w) / 2 * np.sqrt(2)
    c = np.cos(w)
    b = np.array([A * ((A + 1) + (A - 1) * c + 2 * np.sqrt(A) * al), -2 * A * ((A - 1) + (A + 1) * c),
                  A * ((A + 1) + (A - 1) * c - 2 * np.sqrt(A) * al)])
    a = np.array([(A + 1) - (A - 1) * c + 2 * np.sqrt(A) * al, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - 2 * np.sqrt(A) * al])
    return b / a[0], a / a[0]


def clamp_color(color: list[float] | None, th: Thresholds) -> tuple[float, float, float, float, float, float] | None:
    """[low cut Hz, bell Hz, bell dB, bell Q, shelf dB, drive dB] within the thresholds; None: none."""
    if not color or len(color) < 6:
        return None
    lo, bell_hz, bell_db, q, shelf_db, drive = (float(v) for v in color[:6])
    return (float(np.clip(lo, *th.music_low_cut_hz)), float(np.clip(bell_hz, *th.music_bell_hz)),
            float(np.clip(bell_db, -th.music_bell_db, th.music_bell_db)), float(np.clip(q, 0.3, 3.0)),
            float(np.clip(shelf_db, -th.music_shelf_db, th.music_shelf_db)), float(np.clip(drive, *th.music_drive_db)))


def colour(x: np.ndarray, sr: int, color: tuple[float, float, float, float, float, float], th: Thresholds) -> np.ndarray:
    """The loop coloured: a low cut, a bell, a high shelf, then a soft saturation (gain matched)."""
    lo, bell_hz, bell_db, q, shelf_db, drive = color
    y = signal.sosfilt(signal.butter(2, lo, btype="highpass", fs=sr, output="sos"), x, axis=0)
    b, a = _peaking(bell_hz, bell_db, q, sr)
    y = signal.lfilter(b, a, y, axis=0)
    b, a = _high_shelf(min(th.music_shelf_hz, sr * 0.45), shelf_db, sr)
    y = signal.lfilter(b, a, y, axis=0)
    if drive > 0:
        peak = float(np.max(np.abs(y))) or 1.0
        g = 10 ** (drive / 20)
        # Into a tanh at the loop's peak level, back to that level: the peaks rounded, the body kept.
        y = np.tanh(y / peak * g) / np.tanh(g) * peak
    return y.astype(np.float32)


def render(settings: Settings, source: str, transpose: int, bpm: float, bars: int, color: list[float] | None) -> np.ndarray:
    """The loop in a track: `bars` bars at `bpm` (its own whole bars; a seamless cycle), moved
    `transpose` semitones and coloured, at the bass loudness target. (frames, 2) float32."""
    th = settings.thresholds
    lib = Path(settings.library_path)
    meta = json.loads((lib / Path(source).parent / "meta.json").read_text())
    a = load(lib / source)
    sr = settings.output_sample_rate
    x = resample(a.data if a.data.shape[1] == 2 else np.repeat(a.data[:, :1], 2, axis=1), a.sr, sr).astype(np.float32)
    shift = max(-th.music_max_shift, min(th.music_max_shift, int(transpose)))
    own = int(meta.get("bars") or bars)
    cycle = own * 240.0 / bpm * sr
    # Three times round, the middle one kept: Rubber Band's edges and the filters' settling fall
    # outside it, and its ends are the loop running into itself, so the repeats join as it does.
    y3 = stretch.stretch_pitch(np.concatenate([x, x, x]), sr, int(round(3 * cycle)), shift, settings)
    c = clamp_color(color, th)
    if c:
        y3 = colour(y3, sr, c, th)
    y = y3[int(round(cycle)):int(round(cycle)) + int(np.ceil(cycle))]
    n = int(round(bars * 240.0 / bpm * sr))
    out = np.zeros((n, 2), dtype=np.float32)
    k = 0
    while (start := int(round(k * cycle))) < n:
        end = min(n, int(round((k + 1) * cycle)), start + y.shape[0])
        out[start:end] = y[:end - start]
        k += 1
    if float(np.abs(out).max(initial=0.0)) > 1e-5:
        out, _, _ = normalize.loudness_normalize(out, sr, th.bass_lufs_target, th.bass_peak_dbfs)
    return np.ascontiguousarray(out, dtype=np.float32)


__all__ = ["import_loops", "import_one", "loop_tempo", "whole_bars", "render", "colour", "clamp_color", "MusicLoopError", "FOLDER"]
