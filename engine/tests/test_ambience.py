"""The ambience bed (SCOPE.md §6.10a): a texture imported without a key, made into a seamless loop."""

import sqlite3
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from drumvault_engine import ambience, hits, pipeline, splice
from drumvault_engine.config import Settings

SR = 44100
BPM = 120.0   # a bar is 2 s


def crackle(seconds: float, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(int(seconds * SR)).astype(np.float32) * 0.05
    x[rng.integers(0, len(x), int(seconds * 40))] += 0.6
    return np.stack([x, x * 0.9], axis=1)


def imported(tmp_path: Path, name: str, data: np.ndarray) -> tuple[Settings, str, sqlite3.Row]:
    s = Settings(library_path=str(tmp_path / "lib"))
    src = tmp_path / "src" / name
    src.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(src), data, SR, subtype="PCM_24")
    [h] = hits.import_hits(s, [str(src)], kind="ambience")["imported"]
    conn = sqlite3.connect(Path(s.library_path) / ".drumvault" / "library.sqlite")
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM hits WHERE id = ?", (h["id"],)).fetchone()
    return s, row["rel_path"], row


def test_a_texture_imports_long_into_its_own_folder_without_a_key(tmp_path):
    s, rel, row = imported(tmp_path, "Vinyl Crackle Am.wav", crackle(30))
    assert rel.startswith("Ambience/") and row["kind"] == "ambience"
    assert row["key_label"] is None                       # a texture is never moved, whatever its name says
    assert row["duration_s"] > 25


def test_the_loop_is_seamless_and_as_long_as_asked(tmp_path):
    s, rel, _ = imported(tmp_path, "Room Tone.wav", crackle(20))
    sr = s.output_sample_rate
    y = ambience.make_loop(s, rel, BPM, 8)
    assert y.shape == (int(round(16 * sr)), 2)
    # No seam where it repeats: the level across the join is the level elsewhere (no gap, no doubling).
    rms = lambda z: float(np.sqrt(np.mean(np.square(z))))
    join = np.concatenate([y[-sr // 2:], y[: sr // 2]])
    assert rms(join) == pytest.approx(rms(y), rel=0.25)
    # A sample shorter than the loop is laid end to end, never silent anywhere.
    short, rel2, _ = imported(tmp_path / "b", "Tape Hiss.wav", crackle(5, 2))
    z = ambience.make_loop(short, rel2, BPM, 8)
    windows = [rms(z[i:i + sr // 2]) for i in range(0, len(z) - sr // 2, sr // 2)]
    assert min(windows) > 0.3 * rms(z)


def test_render_bass_makes_the_bed_loop_and_caches_it(tmp_path):
    s, rel, _ = imported(tmp_path, "Field Recording.wav", crackle(12))
    out = ".drumvault/ambience/abc-0-b8-120.wav"
    assert pipeline.render_bass(s, rel, 0, 0, BPM, out, bars=8) == {"path": out, "cached": False}
    y, sr = sf.read(Path(s.library_path) / out, always_2d=True)
    assert y.shape[0] == int(round(16 * sr))
    assert pipeline.render_bass(s, rel, 0, 0, BPM, out, bars=8)["cached"] is True
    with pytest.raises(pipeline.PipelineError):
        pipeline.render_bass(s, "Strings/x.wav", 0, 0, BPM, ".drumvault/ambience/x-0-b8-120.wav", bars=8)


def test_splice_suggests_textures_for_the_bed():
    S = Settings()
    assert splice.suggest("SPLC_vinyl_crackle_01.wav", 20.0, S) == ("ambience", "a texture for the ambience bed")
    assert splice.suggest("Club_Room_Tone.wav", 30.0, S)[0] == "ambience"
    assert splice.suggest("tape_hiss_texture.wav", 12.0, S)[0] == "ambience"
    assert splice.suggest("vinyl_crackle_short.wav", 1.0, S) is None            # too short to lie under a section
    assert splice.suggest("dark_pad_texture_Am.wav", 12.0, S) is None           # music, not a texture
    assert splice.suggest("noise_riser_8bar.wav", 15.0, S) is None              # a riser
    assert splice.suggest("SC_DP_89_guitar_texture_dreamin_Bmin.wav", 21.6, S) is None   # music: a guitar, a key
    assert splice.suggest("SM_BSS_75_songstarter_tape_vinyl_roots_C#min.wav", 12.8, S) is None
    assert splice.suggest("FF_CL_ambience_london_bar_yellow.wav", 25.5, S)[0] == "ambience"
    assert splice.suggest("NOIZU_125_white_noise_fall_03.wav", 15.4, S) is None             # a downlifter
