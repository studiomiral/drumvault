"""Mastering: the Maximizer gain solved to the loudness target, paths kept to the export folder,
Ozone's saved state edited, and (where Ozone 11 is installed) a real master on the target with the
ceiling held, between the samples too."""

from pathlib import Path

import re
import struct
import zlib

import numpy as np
import pytest
import soundfile as sf

from drumvault_engine.config import Settings
from drumvault_engine.master import (MasterError, integrated_lufs, juce_b64_decode, juce_b64_encode, master_mixdown,
                                     max_short_term_lufs, set_ozone_state_bool, solve_gain)
from drumvault_engine.mixprofile import true_peak_db

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


def test_measures_the_loudest_three_seconds():
    # A quiet intro, then a 4 s drop (steady noise) much louder: the loudest 3 s are the drop's, as a meter reads it alone.
    x = club_mix(20.0, 0.05)
    drop = (0.2 * np.random.default_rng(1).standard_normal((SR * 4, 2))).astype(np.float32)
    x[SR * 10:SR * 14] = drop
    s = max_short_term_lufs(x, SR, 3.0)
    assert abs(s - integrated_lufs(drop[SR // 2:SR * 7 // 2], SR)) < 0.3
    assert s > max_short_term_lufs(x[:SR * 10], SR, 3.0) + 6
    assert max_short_term_lufs(np.zeros((SR * 4, 2), np.float32), SR, 3.0) == float("-inf")


def ozone_state(doc: str) -> bytes:
    """A VST3 raw_state shaped like Ozone's: its settings as zlib'd JSON in JUCE base64 inside the XML."""
    js = doc.encode()
    z = zlib.compress(js)
    blob = struct.pack("<4I", 0x688ADE, 4, len(z) + 4, len(js)) + z
    xml = f'<?xml version="1.0" encoding="UTF-8"?> <VST3PluginState><IComponent>{juce_b64_encode(blob)}</IComponent></VST3PluginState>'
    return b"VC2!" + struct.pack("<I", len(xml)) + xml.encode()


def state_doc(raw: bytes) -> str:
    xml = raw[8:8 + struct.unpack("<I", raw[4:8])[0]].decode()
    return zlib.decompress(juce_b64_decode(re.search(r"<IComponent>(.*?)</IComponent>", xml).group(1))[16:]).decode()


def test_sets_a_setting_in_ozones_state():
    for n in (0, 1, 2, 3, 100, 1631):
        b = bytes(np.random.default_rng(n).integers(0, 256, n, dtype=np.uint8))
        assert juce_b64_decode(juce_b64_encode(b)) == b
    doc = """{
   "Margin" : {
      "Type" : "Float",
      "Value" : 0
   },
   "Prevent Intersample Clipping" : {
      "Type" : "Bool",
      "Value" : false
   }
}
"""
    raw = set_ozone_state_bool(ozone_state(doc), "Prevent Intersample Clipping", True)
    assert state_doc(raw) == doc.replace("false", "true")
    assert state_doc(set_ozone_state_bool(raw, "Prevent Intersample Clipping", False)) == doc
    with pytest.raises(ValueError):
        set_ozone_state_bool(raw, "Missing Setting", True)


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
    # Noisy offbeat hats: limited without true-peak limiting, this master peaks at +2.4 dBTP between the samples.
    t = np.arange(len(x)) / SR
    hat = np.random.default_rng(3).standard_normal(len(x)) * np.exp(-((t + 60 / 248) % (60 / 124)) * 60) * 0.08
    x = (x + np.stack([hat, hat], axis=1)).astype(np.float32)
    sf.write(str(mix), x, SR, subtype="PCM_24")
    s = Settings(library_path=str(tmp_path))
    r = master_mixdown(s, str(mix), str(tmp_path / "mastered.wav"))
    y, sr = sf.read(str(tmp_path / "mastered.wav"), dtype="float32", always_2d=True)
    assert sr == SR and y.shape == x.shape  # the mixdown's length: every file of the export alike
    th = s.thresholds
    # Its loudest 3 s (the drops) on the target; the whole track, with its quieter parts, under it.
    assert abs(max_short_term_lufs(y, SR, th.master_short_term_s) - th.master_target_lufs) <= th.master_tolerance_lu + 0.02
    assert abs(r["short_term_lufs"] - th.master_target_lufs) <= th.master_tolerance_lu
    assert abs(r["lufs"] - integrated_lufs(y, SR)) <= 0.01 and r["lufs"] < r["short_term_lufs"]
    assert np.max(np.abs(y)) <= 10 ** (th.master_ceiling_db / 20) + 1e-4
    assert true_peak_db(y, th) <= th.master_ceiling_db + 0.1  # between the samples too
    # Ozone's look-ahead is compensated: the master lines up with the mixdown.
    a, b = x[SR * 5:SR * 6, 0], y[SR * 5 - 2000:SR * 6 + 2000, 0]
    assert int(np.argmax(np.correlate(b, a, "valid"))) - 2000 == 0
