"""Mastering: the Maximizer gain solved to the loudness target, paths kept to the export folder,
and (where Ozone 11 is installed) a real master on the target with the ceiling held."""

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from drumvault_engine.config import Settings
from drumvault_engine.master import MasterError, integrated_lufs, master_mixdown, solve_gain

SR = 44100


def club_mix(seconds: float = 20.0, level: float = 0.25) -> np.ndarray:
    """A kick on every beat at 124 BPM over a held chord: something a limiter has work on."""
    t = np.arange(int(seconds * SR)) / SR
    beat = 60 / 124
    ph = t % beat
    kick = np.sin(2 * np.pi * (50 + 120 * np.exp(-ph * 30)) * ph) * np.exp(-ph * 8)
    pad = 0.3 * sum(np.sin(2 * np.pi * f * t) for f in (220, 277.2, 329.6)) / 3
    mono = level * (kick + pad)
    return np.stack([mono, mono * 0.9], axis=1).astype(np.float32)


def test_solves_a_limiters_gain_to_the_target():
    x = club_mix()

    def render(g: float) -> np.ndarray:  # a soft limiter: louder with gain, never past full scale
        return np.tanh(x * 10 ** (g / 20)).astype(np.float32)

    gain, y, lufs, passes = solve_gain(render, lambda a: integrated_lufs(a, SR), -9.0, 0.0, 20.0, 0.1, 10)
    assert abs(lufs - -9.0) <= 0.1
    assert abs(integrated_lufs(y, SR) - lufs) < 1e-6
    assert 0 < gain < 20 and passes <= 10
    # Out of reach: the closest one tried, at the end of the range.
    gain, _, lufs, _ = solve_gain(render, lambda a: integrated_lufs(a, SR), 3.0, 0.0, 20.0, 0.1, 6)
    assert lufs < 3.0 and gain > 15


def test_keeps_the_master_next_to_the_mixdown(tmp_path: Path):
    mix = tmp_path / "mixdown.wav"
    sf.write(str(mix), club_mix(2.0), SR, subtype="PCM_24")
    s = Settings(library_path=str(tmp_path))
    for out in ("relative.wav", str(tmp_path / "sub" / "mastered.wav"), str(tmp_path / "mastered.txt"), str(mix)):
        with pytest.raises(MasterError) as e:
            master_mixdown(s, str(mix), out)
        assert e.value.code == "bad_path"
    with pytest.raises(MasterError) as e:
        master_mixdown(s, str(tmp_path / "missing.wav"), str(tmp_path / "mastered.wav"))
    assert e.value.code == "not_found"


def test_says_so_when_ozone_is_missing(tmp_path: Path):
    mix = tmp_path / "mixdown.wav"
    sf.write(str(mix), club_mix(2.0), SR, subtype="PCM_24")
    s = Settings(library_path=str(tmp_path), ozone_maximizer_plugin=str(tmp_path / "nope.vst3"))
    with pytest.raises(MasterError) as e:
        master_mixdown(s, str(mix), str(tmp_path / "mastered.wav"))
    assert e.value.code == "no_ozone"


@pytest.mark.skipif(not (Path(Settings().ozone_maximizer_plugin).exists() and Path(Settings().ozone_dynamics_plugin).exists()),
                    reason="Ozone 11 is not installed")
def test_masters_through_ozone_on_target_with_the_ceiling(tmp_path: Path):
    mix = tmp_path / "mixdown.wav"
    x = club_mix(30.0)
    sf.write(str(mix), x, SR, subtype="PCM_24")
    s = Settings(library_path=str(tmp_path))
    r = master_mixdown(s, str(mix), str(tmp_path / "mastered.wav"))
    y, sr = sf.read(str(tmp_path / "mastered.wav"), dtype="float32", always_2d=True)
    assert sr == SR and y.shape == x.shape  # the mixdown's length: every file of the export alike
    th = s.thresholds
    assert abs(integrated_lufs(y, SR) - th.master_target_lufs) <= th.master_tolerance_lu + 0.02
    assert abs(r["lufs"] - th.master_target_lufs) <= th.master_tolerance_lu
    assert np.max(np.abs(y)) <= 10 ** (th.master_ceiling_db / 20) + 1e-4
    # Ozone's look-ahead is compensated: the master lines up with the mixdown.
    a, b = x[SR * 5:SR * 6, 0], y[SR * 5 - 2000:SR * 6 + 2000, 0]
    assert int(np.argmax(np.correlate(b, a, "valid"))) - 2000 == 0
