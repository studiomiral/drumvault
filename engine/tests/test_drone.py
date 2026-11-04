"""Drones: a sample (or a held Serum note) washed into a seamless loop at the track tempo, with its
rhythm, in the key; and drones dropped on the Drones page keep their length."""

from pathlib import Path

import numpy as np
import pyloudnorm
import soundfile as sf

from drumvault_engine import pipeline
from drumvault_engine.config import Settings, Thresholds
from drumvault_engine.drone import chopped, from_start, loop_frames, make_loop, pitched, rhythm_envelope, seamless, tiled, warped
from drumvault_engine.hits import import_hits

SR = 44100
TH = Thresholds()


def pad(seconds: float, hz: float = 220.0) -> np.ndarray:
    """A slowly breathing chord on `hz`: something with movement for the loop to hide."""
    t = np.arange(int(seconds * SR)) / SR
    y = sum(np.sin(2 * np.pi * f * t + i) for i, f in enumerate((hz, hz * 1.5, hz * 2)))
    y = 0.2 * y * (0.8 + 0.2 * np.sin(2 * np.pi * 0.3 * t))
    return np.stack([y, np.roll(y, 300)], axis=1).astype(np.float32)


def test_loops_without_a_seam_at_the_track_tempo():
    loop = make_loop(pad(20), SR, 124.0, 4, "pump", TH)
    assert loop.shape == (loop_frames(124.0, 4, SR), 2)
    # The wrap is no bigger a step than the ones inside the loop.
    steps = np.abs(np.diff(loop[:, 0]))
    assert abs(loop[0, 0] - loop[-1, 0]) <= np.percentile(steps, 99.9) + 1e-6


def test_seamless_runs_on_into_its_start():
    y = np.cumsum(np.ones((1000, 2), dtype=np.float32), axis=0)  # a ramp: y[i] = i + 1
    out = seamless(y, 100, 500, 50)
    assert out.shape == (500, 2)
    assert out[0, 0] == y[600, 0]  # where y would have gone on after the loop's last frame
    assert out[60, 0] == y[160, 0]  # past the crossfade, the loop as it was


def test_repeats_a_short_sample_to_fill_the_loop():
    x = pad(3)
    y = tiled(x, 10 * SR, int(0.5 * SR))
    assert y.shape == (10 * SR, 2)
    assert np.all(np.abs(y) < 1.0)


def test_rhythms_have_their_shape():
    n = loop_frames(120.0, 1, SR)  # 2 s: a beat is 0.5 s
    assert np.all(rhythm_envelope(n, SR, 120.0, "pump", TH) == 1)
    g8 = rhythm_envelope(n, SR, 120.0, "gate8", TH)
    assert g8.min() >= TH.drone_gate_floor - 1e-6 and g8.max() <= 1 + 1e-6
    eighth = int(0.25 * SR)
    assert np.allclose(g8[:eighth], g8[eighth:2 * eighth], atol=1e-4)  # every 8th alike
    assert g8[int(0.1 * SR)] > 0.99 and g8[int(0.2 * SR)] < TH.drone_gate_floor + 0.01  # open, then shut
    g16 = rhythm_envelope(n, SR, 120.0, "gate16", TH)
    sixteenth = int(0.125 * SR)
    assert np.allclose(g16[:sixteenth], g16[sixteenth:2 * sixteenth], atol=2e-3)  # a 16th is 5512.5 frames here
    sw = rhythm_envelope(n, SR, 120.0, "swell", TH)
    beat = int(0.5 * SR)
    assert sw[0] < TH.drone_gate_floor + 0.01 and sw[beat // 2] > 0.99  # quiet on the beat, full on the offbeat


def test_pitches_like_a_sampler():
    x = np.sin(2 * np.pi * 220.0 * np.arange(2 * SR) / SR).astype(np.float32)
    up = pitched(x[:, None], SR, 12)[:, 0]
    assert abs(len(up) - len(x) / 2) <= 2
    spec = np.abs(np.fft.rfft(up * np.hanning(len(up))))
    hz = np.fft.rfftfreq(len(up), 1 / SR)[np.argmax(spec)]
    assert abs(hz - 440.0) < 5


def test_renders_a_sample_drone_into_the_library(tmp_path: Path):
    lib = tmp_path
    (lib / "Drones").mkdir()
    sf.write(str(lib / "Drones" / "air.wav"), pad(6), SR, subtype="PCM_24")
    s = Settings(library_path=str(lib))
    rel = ".drumvault/drones/test-gate8-124.wav"
    r = pipeline.render_bass(s, "Drones/air.wav", 0, 3, 124.0, rel, bars=4, drone={"rhythm": "gate8"})
    assert r == {"path": rel, "cached": False}
    y, sr = sf.read(str(lib / rel), dtype="float32", always_2d=True)
    assert sr == SR and y.shape[0] == loop_frames(124.0, 4, SR)
    assert abs(pyloudnorm.Meter(SR).integrated_loudness(y) - TH.drone_lufs_target) < 0.6
    assert pipeline.render_bass(s, "Drones/air.wav", 0, 3, 124.0, rel, bars=4, drone={"rhythm": "gate8"})["cached"]


def test_keeps_a_long_drone_when_dropped_on_its_page(tmp_path: Path):
    src = tmp_path / "in" / "Dark Drone Am.wav"
    src.parent.mkdir()
    sf.write(str(src), pad(12), SR, subtype="PCM_24")
    lib = tmp_path / "lib"
    lib.mkdir()
    r = import_hits(Settings(library_path=str(lib)), [str(src)], "drone")
    assert len(r["imported"]) == 1 and r["imported"][0]["kind"] == "drone" and r["imported"][0]["key_label"] == "Am"
    files = list((lib / "Drones").glob("*.wav"))
    assert len(files) == 1
    assert sf.info(str(files[0])).duration > 11.5  # a hit would be cut to hit_max_len_s


def test_the_engine_takes_drones_and_drone_renders():
    from drumvault_engine.schemas import ImportHitsParams, RenderBassParams
    assert ImportHitsParams.model_validate({"paths": ["/x.wav"], "kind": "drone"}).kind == "drone"
    p = RenderBassParams.model_validate({"preset": "Drones/air.wav", "midi_id": 0, "bpm": 124, "out_rel": ".drumvault/drones/x.wav",
                                         "bars": 4, "drone": {"rhythm": "swell"}})
    assert p.drone is not None and p.drone.rhythm == "swell"



def test_dotted_gate_opens_on_the_dotted_8ths():
    n = loop_frames(120.0, 1, SR)
    g = rhythm_envelope(n, SR, 120.0, "dotted", TH)
    s16 = int(0.125 * SR)
    for o in (0, 3, 6, 9, 12):
        assert g[o * s16 + s16 // 2] > 0.99  # open just after each onset
    assert g[2 * s16 + s16 // 2] < TH.drone_gate_floor + 0.01  # shut on the 16th before the next
    assert g[14 * s16 + s16 // 2] < TH.drone_gate_floor + 0.01  # the last 4 16ths: open for 2, then shut


def test_chops_16ths_from_a_few_places_in_a_pattern():
    t = np.arange(20 * SR) / SR
    y = np.stack([np.sin(2 * np.pi * 220 * t) * (t / 20), np.sin(2 * np.pi * 220 * t) * (t / 20)], axis=1).astype(np.float32)
    n = loop_frames(120.0, 2, SR)
    a = chopped(y, SR, n, SR, 120.0, TH, seed=7)
    assert a.shape == (n, 2)
    assert np.allclose(a, chopped(y, SR, n, SR, 120.0, TH, seed=7))  # the same seed, the same chop
    assert not np.allclose(a, chopped(y, SR, n, SR, 120.0, TH, seed=8))
    assert abs(a[0, 0]) < 1e-3 and abs(a[-1, 0]) < 1e-3  # faded at the loop's ends: no click on the wrap
    # y gets louder as it goes, so a 16th's level says where in y it came from: several places.
    s16 = int(0.125 * SR)
    levels = {round(float(np.sqrt(np.mean(a[k * s16:(k + 1) * s16, 0] ** 2))), 2) for k in range(16)}
    assert len(levels) >= 2


def test_warps_slow_or_reversed_and_starts_elsewhere():
    s = Settings()
    x = pad(2)
    assert np.array_equal(warped(x, SR, "none", s), x)
    assert np.array_equal(warped(x, SR, "reverse", s), x[::-1])
    slow = warped(x, SR, "slow2", s)
    assert slow.shape == (2 * len(x), 2)
    sine = np.repeat(np.sin(2 * np.pi * 220.0 * np.arange(2 * SR) / SR).astype(np.float32)[:, None], 2, axis=1)
    slow = warped(sine, SR, "slow4", s)
    assert slow.shape == (4 * len(sine), 2)
    spec = np.abs(np.fft.rfft(slow[:, 0] * np.hanning(len(slow))))
    assert abs(np.fft.rfftfreq(len(slow), 1 / SR)[np.argmax(spec)] - 220.0) < 2  # 4× as long, the same pitch
    long = pad(30)
    assert len(from_start(long, 0.5, 10 * SR)) == len(long) - int(0.5 * 20 * SR)
    assert len(from_start(pad(5), 0.9, 10 * SR)) == 5 * SR  # too short to start later: from its beginning


def test_renders_a_warped_chopped_drone(tmp_path: Path):
    lib = tmp_path
    (lib / "Drones").mkdir()
    sf.write(str(lib / "Drones" / "air.wav"), pad(6), SR, subtype="PCM_24")
    s = Settings(library_path=str(lib))
    rel = ".drumvault/drones/test-chop-124.wav"
    r = pipeline.render_bass(s, "Drones/air.wav", 0, -12, 124.0, rel, bars=4, drone={"rhythm": "chop", "warp": "slow2", "start": 0.4})
    assert r["cached"] is False
    y, _ = sf.read(str(lib / rel), dtype="float32", always_2d=True)
    assert y.shape[0] == loop_frames(124.0, 4, SR) and np.abs(y).max() > 0.05
