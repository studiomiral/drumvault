"""Music loops (SCOPE.md §6.11b): imported as their whole bars with their tempo and key, and rendered
into a track never as they were: moved into the key and coloured, a seamless cycle at its tempo."""

import json
import shutil
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from drumvault_engine import musicloop, pipeline
from drumvault_engine.config import Settings, Thresholds

SR = 44100


def chords(bars: int, bpm: float, sr: int = SR) -> np.ndarray:
    """A chord loop in A minor: Am, F, C, G, one a bar, each struck on the beat."""
    beat = 60 / bpm
    out = []
    for i in range(bars):
        root = (57, 53, 48, 55)[i % 4]
        third = 3 if i % 4 == 0 else 4
        t = np.arange(int(4 * beat * sr)) / sr
        env = np.exp(-((t % beat) / (beat * 0.6)))
        y = sum(0.15 * np.sin(2 * np.pi * 440 * 2 ** ((m - 69) / 12) * t) for m in (root, root + third, root + 7, root + 12))
        out.append(y * env)
    y = np.concatenate(out).astype(np.float32)
    return np.stack([y, y * 0.9], axis=1)


@pytest.fixture
def lib(tmp_path):
    src = tmp_path / "in"
    src.mkdir()
    return Settings(library_path=str(tmp_path / "lib"), library_bpm=124.0), src


def test_a_loop_is_imported_as_its_whole_bars_with_its_tempo_and_key(lib):
    s, src = lib
    f = src / "Deep Chords 122 Am.wav"
    x = chords(4, 122)
    sf.write(str(f), np.concatenate([x, x[: SR // 10]]), SR, subtype="PCM_24")   # a hair over 4 bars
    r = musicloop.import_loops(s, [str(src)])
    [got] = r["imported"]
    assert (got["key"], got["bpm"], got["bars"]) == ("Am", 122.0, 4)
    d = Path(s.library_path) / "Music Loops" / got["id"]
    meta = json.loads((d / "meta.json").read_text())
    assert meta["usedIn"] == [] and meta["genre"] == "house" and meta["tempoSource"] == "name" and meta["keySource"] == "name"
    y, sr = sf.read(str(d / "loop.wav"), always_2d=True)
    assert len(y) == round(4 * 240 / 122 * sr)   # cut on its own grid, sample-exact
    assert np.abs(y[:5]).max() == pytest.approx(np.abs(x[:5]).max(), abs=1e-3)   # no fade in
    # The same file again: skipped.
    assert musicloop.import_loops(s, [str(f)]) == {"imported": [], "skipped": 1, "failed": []}


def test_a_loop_without_a_tempo_gets_the_one_that_makes_it_whole_bars():
    th = Thresholds()
    assert musicloop.loop_tempo("Guitar Loop.wav", 4 * 240 / 120, 124, th) == (120.0, "length")
    assert musicloop.loop_tempo("Keys 126.wav", 3.0, 124, th) == (126.0, "name")
    assert musicloop.loop_tempo("Odd.wav", 0.7, 124, th) == (None, "none")


def test_a_loop_without_a_key_in_its_name_has_the_one_heard(lib):
    s, src = lib
    sf.write(str(src / "Chord Loop 124.wav"), chords(4, 124), SR, subtype="PCM_24")
    [got] = musicloop.import_loops(s, [str(src)])["imported"]
    assert got["key"] in ("Am", "C")   # (the relative major sounds the same chords)


def test_colour_changes_the_tone_but_not_the_length():
    x = chords(1, 124)
    y = musicloop.colour(x, SR, (180.0, 900.0, 4.0, 1.0, -3.0, 6.0), Thresholds())
    assert y.shape == x.shape and not np.allclose(y, x, atol=1e-3)
    # The low cut: a 40 Hz rumble is mostly gone (no saturation, to hear the filter alone).
    t = np.arange(len(x)) / SR
    rumble = x + 0.2 * np.sin(2 * np.pi * 40 * t)[:, None].astype(np.float32)
    z = musicloop.colour(rumble, SR, (180.0, 900.0, 0.0, 1.0, 0.0, 0.0), Thresholds())
    at40 = lambda w: np.abs(np.fft.rfft(w[:, 0]))[round(40 * len(w) / SR)]  # noqa: E731
    assert at40(z) < at40(rumble) * 0.1
    assert musicloop.clamp_color([10, 99999, 40, 1, -40, 99], Thresholds()) == (100.0, 4000.0, 6.0, 1.0, -4.0, 12.0)


@pytest.mark.skipif(not shutil.which("rubberband"), reason="Rubber Band not installed")
def test_a_render_is_moved_coloured_and_exactly_its_bars_at_the_track_tempo(lib):
    s, src = lib
    sf.write(str(src / "Deep Chords 122 Am.wav"), chords(4, 122), SR, subtype="PCM_24")
    [got] = musicloop.import_loops(s, [str(src)])["imported"]
    rel = f"Music Loops/{got['id']}/loop.wav"
    out_rel = ".drumvault/music/test-2-126.wav"
    r = pipeline.render_bass(s, rel, 0, 2, 126.0, out_rel, bars=4, color=[180, 900, 3, 1, -2, 4])
    assert r == {"path": out_rel, "cached": False}
    y, sr = sf.read(str(Path(s.library_path) / out_rel), always_2d=True)
    assert len(y) == round(4 * 240 / 126 * sr)
    # Moved up two semitones: the A (220 Hz) of the first chord is near B (247 Hz).
    spec = np.abs(np.fft.rfft(y[: sr // 2, 0] * np.hanning(sr // 2)))
    hz = np.fft.rfftfreq(sr // 2, 1 / sr)
    band = (hz > 200) & (hz < 260)
    assert abs(hz[band][np.argmax(spec[band])] - 246.9) < 6
    assert pipeline.render_bass(s, rel, 0, 2, 126.0, out_rel, bars=4, color=[180, 900, 3, 1, -2, 4])["cached"]
    with pytest.raises(pipeline.PipelineError):
        pipeline.render_bass(s, "Vocals/x/loop.wav", 0, 2, 126.0, ".drumvault/music/x.wav", bars=4)
