"""Strings (SCOPE.md §6.10): long string samples, a part per 8 bars, moved into the key with their length kept."""

import sqlite3
import shutil
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from drumvault_engine import hits, pipeline, strings
from drumvault_engine.config import Settings

from make_fixtures import midi_hz

SR = 44100
BPM = 124.0
EIGHT_BARS_S = 8 * 4 * 60 / BPM  # 15.48 s


def held(pitches: list[int], seconds: float, sr: int = SR) -> np.ndarray:
    """A sustained string chord: a soft attack, then held at one level to the end."""
    t = np.arange(int(seconds * sr)) / sr
    x = sum(np.sin(2 * np.pi * midi_hz(p) * t) for p in pitches) / len(pitches)
    x *= np.minimum(1.0, t / 0.3)
    return np.stack([x, x * 0.95], axis=1).astype(np.float32) * 0.4


def write(path: Path, data: np.ndarray, sr: int = SR) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), data, sr, subtype="PCM_24")
    return path


def peak_hz(x: np.ndarray, sr: int) -> float:
    m = x.mean(axis=1) if x.ndim > 1 else x
    mag = np.abs(np.fft.rfft(m * np.hanning(len(m))))
    return float(np.fft.rfftfreq(len(m), 1 / sr)[np.argmax(mag)])


def imported(tmp_path: Path, name: str, data: np.ndarray) -> tuple[Settings, str]:
    s = Settings(library_path=str(tmp_path / "lib"))
    r = hits.import_hits(s, [str(write(tmp_path / "src" / name, data))], kind="strings")
    [h] = r["imported"]
    assert h["kind"] == "strings"
    conn = sqlite3.connect(Path(s.library_path) / ".drumvault" / "library.sqlite")
    rel, = conn.execute("SELECT rel_path FROM hits WHERE id = ?", (h["id"],)).fetchone()
    return s, rel


def test_string_samples_import_long_into_their_own_folder(tmp_path):
    s, rel = imported(tmp_path, "Strings Am.wav", held([57, 60, 64], 30.0))
    assert rel.startswith("Strings/")
    data, sr = sf.read(Path(s.library_path) / rel)
    assert len(data) / sr > 25          # a hit would keep 6 s; strings keep up to strings_max_len_s


def test_a_part_is_eight_bars_cut_with_a_fade(tmp_path):
    s, rel = imported(tmp_path, "Long Strings Am.wav", held([57], 30.0))
    r = pipeline.render_bass(s, rel, 0, 0, BPM, ".drumvault/strings/a-0-0-124.wav", bars=8)
    y, sr = sf.read(Path(s.library_path) / r["path"], always_2d=True)
    assert y.shape == (strings.part_frames(BPM, 8, sr), 2)
    assert np.abs(y[sr: 2 * sr]).max() > 0.05                                  # the sample as it is
    assert np.abs(y[-20:]).max() < 0.01                                        # faded where the next start cuts it
    assert pipeline.render_bass(s, rel, 0, 0, BPM, ".drumvault/strings/a-0-0-124.wav", bars=8)["cached"] is True


def test_a_short_sample_plays_once_then_silence(tmp_path):
    s, rel = imported(tmp_path, "Short Strings Am.wav", held([57], 5.0))
    r = pipeline.render_bass(s, rel, 0, 0, BPM, ".drumvault/strings/b-0-0-124.wav", bars=8)
    y, sr = sf.read(Path(s.library_path) / r["path"], always_2d=True)
    assert y.shape[0] == strings.part_frames(BPM, 8, sr)
    assert np.abs(y[int(7 * sr):]).max() < 1e-4                               # padded, not repeated


def test_a_four_bar_sample_fills_a_four_bar_part(tmp_path):
    # A 4-bar loop cut at 125 BPM, played as a 4-bar part at 124: it ends a moment before the line.
    seconds = 4 * 4 * 60 / 125
    s, rel = imported(tmp_path, "Loop Strings Am.wav", held([57], seconds))
    r = pipeline.render_bass(s, rel, 0, 0, BPM, ".drumvault/strings/c-0-b4-0-124.wav", bars=4)
    y, sr = sf.read(Path(s.library_path) / r["path"], always_2d=True)
    n = strings.part_frames(BPM, 4, sr)
    assert y.shape[0] == n
    # Sounding nearly to the end of the part: no bars of silence, only the short gap, faded into.
    assert np.abs(y[int(0.9 * n): int(0.95 * n)]).max() > 0.01
    gap = n - int(seconds * sr)
    assert 0 < gap < 0.02 * n
    assert np.abs(y[n - gap:]).max() < 1e-4


@pytest.mark.skipif(not shutil.which("rubberband"), reason="Rubber Band not installed")
def test_moved_into_the_key_with_its_length_kept(tmp_path):
    s, rel = imported(tmp_path, "Strings A.wav", held([57], 12.0))
    sr = s.output_sample_rate
    plain = strings.make_part(s, rel, 0, BPM, 8)
    up = strings.make_part(s, rel, 2, BPM, 8)
    assert up.shape == plain.shape
    a, b = peak_hz(plain[sr: 6 * sr], sr), peak_hz(up[sr: 6 * sr], sr)
    assert b / a == pytest.approx(2 ** (2 / 12), rel=0.01)
    # Still sounding where the original does (no faster playback ending it early).
    assert np.abs(up[int(10 * sr): int(11 * sr)]).max() > 0.05


def test_older_drones_play_from_their_files_only(tmp_path):
    s = Settings(library_path=str(tmp_path / "lib"))
    out = Path(s.library_path) / ".drumvault" / "drones" / "x-pump-0-124.wav"
    with pytest.raises(pipeline.PipelineError):
        pipeline.render_bass(s, "Drones/x.wav", 0, 0, BPM, ".drumvault/drones/x-pump-0-124.wav", bars=4)
    write(out, np.zeros((100, 2), dtype=np.float32))
    assert pipeline.render_bass(s, "Drones/x.wav", 0, 0, BPM, ".drumvault/drones/x-pump-0-124.wav", bars=4)["cached"] is True
