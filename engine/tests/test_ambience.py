"""The ambience bed (SCOPE.md §6.10a): noise imported without a key, a tonal bed with one (always
pitched into the track key), made into a seamless loop."""

import sqlite3
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from drumvault_engine import ambience, hits, pipeline, splice, stretch
from drumvault_engine.config import Settings
from drumvault_engine.db import LibraryDB

SR = 44100
BPM = 120.0   # a bar is 2 s


def crackle(seconds: float, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(int(seconds * SR)).astype(np.float32) * 0.05
    x[rng.integers(0, len(x), int(seconds * 40))] += 0.6
    return np.stack([x, x * 0.9], axis=1)


def pad(seconds: float, root_hz: float = 220.0, noise: float = 0.0, seed: int = 3) -> np.ndarray:
    """A held A minor chord (A, C, E with overtones), under some noise: a tonal bed."""
    t = np.arange(int(seconds * SR)) / SR
    x = sum(np.sin(2 * np.pi * f * k * t) / k ** 1.5 for f in (root_hz, root_hz * 2 ** (3 / 12), root_hz * 2 ** (7 / 12)) for k in range(1, 6))
    x = 0.3 * x / np.abs(x).max()
    if noise:
        x = x + noise * np.random.default_rng(seed).standard_normal(len(t))
    return np.stack([x, x], axis=1).astype(np.float32)


def peak_hz(y: np.ndarray, sr: int, lo: float = 150.0, hi: float = 400.0) -> float:
    m = y.mean(axis=1)
    spec = np.abs(np.fft.rfft(m * np.hanning(len(m))))
    f = np.fft.rfftfreq(len(m), 1 / sr)
    band = (f >= lo) & (f <= hi)
    return float(f[band][np.argmax(spec[band])])


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


def test_noise_imports_long_into_its_own_folder_without_a_key(tmp_path):
    s, rel, row = imported(tmp_path, "Vinyl Crackle Am.wav", crackle(30))
    assert rel.startswith("Ambience/") and row["kind"] == "ambience"
    assert row["key_label"] is None and row["tonal"] == 0  # noise is never moved, whatever its name says
    assert row["duration_s"] > 25


def test_tonality_tells_a_held_tone_from_noise():
    th = Settings().thresholds
    assert ambience.tonality(crackle(10).mean(axis=1), SR, th) < 0.02
    rng = np.random.default_rng(5)
    assert ambience.tonality(rng.standard_normal(SR * 10).astype(np.float32), SR, th) < 0.02
    assert ambience.tonality(pad(10).mean(axis=1), SR, th) > 0.9
    # Still a tonal bed under loud noise; hum below the bed's 200 Hz low cut isn't a tone.
    assert ambience.tonality(pad(10, noise=0.15).mean(axis=1), SR, th) >= th.ambience_tonal_min
    t = np.arange(SR * 10) / SR
    hum = 0.3 * np.sin(2 * np.pi * 50 * t) + 0.15 * np.sin(2 * np.pi * 100 * t) + 0.01 * rng.standard_normal(len(t))
    assert ambience.tonality(hum.astype(np.float32), SR, th) < th.ambience_tonal_min


def test_a_tonal_bed_imports_with_its_key_from_the_name_or_the_sound(tmp_path):
    _, _, row = imported(tmp_path, "Dark Drone Fm.wav", pad(20))
    assert (row["tonal"], row["key_label"], row["key_source"]) == (1, "Fm", "name")
    _, _, row = imported(tmp_path / "b", "Soft Bed.wav", pad(20, seed=4))
    assert row["tonal"] == 1 and row["key_label"] in ("Am", "C") and row["key_source"] == "detected"


def test_named_noise_is_never_tonal_whatever_it_measures(tmp_path):
    # A crowd singing along holds notes, but a crowd is never pitched; a pad named after the rain is a pad.
    _, _, row = imported(tmp_path, "Crowd Cheers Applause.wav", pad(20))
    assert (row["tonal"], row["key_label"]) == (0, None)
    _, _, row = imported(tmp_path / "b", "Cmin_RainStation_Pad.wav", pad(20, seed=6))
    assert (row["tonal"], row["key_label"]) == (1, "Cm")
    assert ambience.named_noise("SO_HS_120_texture_loop_vinyl_crackle.wav")
    assert not ambience.named_noise("rss_110_vinyl_cut_magicfunk_C#min.wav")   # a record sampled: music


def test_a_key_set_by_hand_makes_a_texture_tonal_and_none_makes_it_noise(tmp_path):
    s, _, row = imported(tmp_path, "Tape Hiss.wav", crackle(10))
    hits.set_hit_meta(s, row["id"], key_label="Dm")
    with LibraryDB(s.library_path) as db:
        h = db.get_hit(row["id"])
        assert (h["tonal"], h["key_label"], h["key_source"]) == (1, "Dm", "manual")
    hits.set_hit_meta(s, row["id"], clear_key=True)
    with LibraryDB(s.library_path) as db:
        assert (db.get_hit(row["id"])["tonal"], db.get_hit(row["id"])["key_label"]) == (0, None)


def test_textures_from_before_are_told_tonal_or_noise(tmp_path):
    s, _, a = imported(tmp_path, "fx-atmos-124-am-s0044-stems-8bar-02.wav", pad(20))
    src = tmp_path / "src" / "Room Noise.wav"
    sf.write(str(src), crackle(10), SR, subtype="PCM_24")
    [nb] = hits.import_hits(s, [str(src)], kind="ambience")["imported"]
    with LibraryDB(s.library_path) as db:
        db.conn.execute("UPDATE hits SET tonal = NULL, key_label = NULL, key_camelot = NULL, key_source = NULL")
        assert len(db.textures_unmeasured()) == 2
    assert pipeline.measure_textures(s) == 1
    with LibraryDB(s.library_path) as db:
        assert (db.get_hit(a["id"])["tonal"], db.get_hit(a["id"])["key_label"]) == (1, "Am")   # the stem's key, in its name
        assert (db.get_hit(nb["id"])["tonal"], db.get_hit(nb["id"])["key_label"]) == (0, None)
        assert db.textures_unmeasured() == []


def test_a_tonal_bed_is_pitched_into_the_key_its_length_kept(tmp_path):
    if not stretch.rubberband_info(Settings().rubberband_binary, Settings().rubberband_r3_flag).path:
        pytest.skip("Rubber Band not installed")
    t = np.arange(20 * SR) / SR
    drone = 0.3 * sum(np.sin(2 * np.pi * 220 * k * t) / k for k in range(1, 4))   # one note: A3
    s, rel, _ = imported(tmp_path, "Warm Drone Am.wav", np.stack([drone, drone], axis=1).astype(np.float32))
    out = ".drumvault/ambience/abc-0-b8-3-120.wav"
    pipeline.render_bass(s, rel, 0, 3, BPM, out, bars=8)
    y, sr = sf.read(Path(s.library_path) / out, always_2d=True)
    assert y.shape[0] == int(round(16 * sr))
    plain = ".drumvault/ambience/abc-0-b8-0-120.wav"
    pipeline.render_bass(s, rel, 0, 0, BPM, plain, bars=8)
    y0, _ = sf.read(Path(s.library_path) / plain, always_2d=True)
    assert peak_hz(y0, sr) == pytest.approx(220, rel=0.01)
    assert peak_hz(y, sr) == pytest.approx(220 * 2 ** (3 / 12), rel=0.01)    # A up 3: C


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


def test_splice_suggests_noise_and_tonal_beds():
    S = Settings()
    NOISE = ("ambience", "noise for the ambience bed: never pitched")
    TONAL = ("ambience", "a tonal bed: pitched into each track's key")
    assert splice.suggest("SPLC_vinyl_crackle_01.wav", 20.0, S) == NOISE
    assert splice.suggest("SO_HS_120_texture_loop_vinyl_crackle.wav", 8.0, S) == NOISE      # a crackle loop is still crackle
    assert splice.suggest("BRS_Crowd_Cheers_Applause_The_Boat_Drunk.wav", 39.7, S) == NOISE
    assert splice.suggest("dark_pad_texture_Am.wav", 12.0, S) == TONAL
    assert splice.suggest("HCOLE_texture_michael_scotch_intro_ambience_Amin.wav", 46.0, S) == TONAL
    assert splice.suggest("ZEN_STRAT_122_drone_fx_scenesetter_Fmin.wav", 31.5, S) == TONAL
    assert splice.suggest("OS_LMN_172_Cmin_RainStation_02_Pad.wav", 11.2, S) == TONAL
    assert splice.suggest("Dark_Drone_F.wav", 20.0, S) == TONAL
    assert splice.suggest("DS_VSH3_128_chords_loop_pad_Cm_28.wav", 15.0, S) is None          # chords that move
    assert splice.suggest("SS_FMTH_122_synth_flex_sidechained_atmos_bed_G#min.wav", 7.9, S) is None   # it pumps
    assert splice.suggest("rss_110_vinyl_cut_magicfunk_C#min.wav", 17.0, S) is None          # a record sampled: music
    assert splice.suggest("Club_Room_Tone.wav", 30.0, S)[0] == "ambience"
    assert splice.suggest("tape_hiss_texture.wav", 12.0, S)[0] == "ambience"
    assert splice.suggest("vinyl_crackle_short.wav", 1.0, S) is None            # too short to lie under a section
    assert splice.suggest("noise_riser_8bar.wav", 15.0, S) is None              # a riser
    assert splice.suggest("SC_DP_89_guitar_texture_dreamin_Bmin.wav", 21.6, S) is None   # music: a guitar, a key
    assert splice.suggest("SM_BSS_75_songstarter_tape_vinyl_roots_C#min.wav", 12.8, S) is None
    assert splice.suggest("FF_CL_ambience_london_bar_yellow.wav", 25.5, S)[0] == "ambience"
    assert splice.suggest("NOIZU_125_white_noise_fall_03.wav", 15.4, S) is None             # a downlifter


# ---- Textures with a rhythm (a guitar loop): synced to the track tempo ----

def clicks(bpm: float, bars: int, lead_s: float = 0.0, tail_s: float = 0.0) -> np.ndarray:
    """A loop with a rhythm: a short plucked click on every beat at `bpm` (`lead_s` of near-silence
    before its first beat inside the loop, `tail_s` of ring after its last bar)."""
    beat = 60.0 / bpm
    n = int(round(bars * 4 * beat * SR + tail_s * SR))
    x = np.zeros(n, dtype=np.float32)
    t = np.arange(int(0.08 * SR)) / SR
    pluck = (np.sin(2 * np.pi * 440 * t) * np.exp(-t * 60)).astype(np.float32) * 0.5
    for b in range(bars * 4):
        i = int(round((b * beat + lead_s) * SR))
        x[i:i + len(pluck)] += pluck[:max(0, n - i)]
    return np.stack([x, x], axis=1)


def onsets_s(y: np.ndarray, sr: int) -> list[float]:
    """Where each click starts (s): the envelope crossing half its peak after a quiet stretch."""
    env = np.abs(y.mean(axis=1))
    thr = 0.5 * env.max()
    out, last = [], -sr
    for i in np.flatnonzero(env > thr):
        if i - last > sr // 10:
            out.append(i / sr)
        last = i
    return out


def test_a_tempo_in_the_name_makes_a_texture_a_loop():
    th = Settings().thresholds
    assert ambience.loop_bpm("ZEN_SONI_122_electric_guitar_loop_chank_Gmin.wav", th) == 122
    assert ambience.loop_bpm("fh2_kit19_shak_guitar_electric_2_loop_120_Gm.wav", th) == 120
    assert ambience.loop_bpm("MRJ_Music_Loop_004_Cm_122.wav", th) == 122
    assert ambience.loop_bpm("FX_Atmos_124_Bbm_S0002-83259-stems_8bar_05.wav", th) == 124
    assert ambience.loop_bpm("Vinyl Crackle Am.wav", th) is None
    assert ambience.loop_bpm("Room Tone 2.wav", th) is None


def test_a_loop_imports_whole_bars_from_its_start_never_trimmed(tmp_path):
    # Its first beat a little in (a soft attack) and a ring after its 2 bars: kept from the start, 2 bars.
    s, _, row = imported(tmp_path, "T_APFG_120_electric_guitar_loop_luvv_Gmaj.wav", clicks(BPM, 2, lead_s=0.05, tail_s=0.3))
    assert row["bpm"] == 120 and row["duration_s"] == pytest.approx(4.0, abs=1e-3)
    y, sr = sf.read(Path(s.library_path) / row["rel_path"], always_2d=True)
    assert onsets_s(y, sr)[0] == pytest.approx(0.05, abs=0.003)
    _, _, noise = imported(tmp_path / "b", "Room Tone.wav", crackle(10))
    assert noise["bpm"] == 0


def test_a_loop_is_stretched_to_the_track_tempo_on_the_grid(tmp_path):
    if not stretch.rubberband_info(Settings().rubberband_binary, Settings().rubberband_r3_flag).path:
        pytest.skip("Rubber Band not installed")
    s, rel, _ = imported(tmp_path, "Guitar_Loop_120_Gm.wav", clicks(BPM, 2))
    sr = s.output_sample_rate
    y = ambience.make_loop(s, rel, 125.0, 8, 0, 120.0)
    assert y.shape[0] == int(round(8 * 240 / 125 * sr))
    # Every beat of every repeat on the track's beat (125 BPM), none off it, none missing.
    found = onsets_s(y, sr)
    beat = 60 / 125
    assert len(found) == 32
    assert max(abs(t - round(t / beat) * beat) for t in found) < 0.004
    # Unsynced, it drifts (the old bed): a click lands off the grid.
    loose = ambience.make_loop(s, rel, 125.0, 8)
    assert max(abs(t - round(t / beat) * beat) for t in onsets_s(loose, sr)) > 0.02


def test_render_bass_syncs_a_loop_by_its_tempo_on_the_page(tmp_path):
    if not stretch.rubberband_info(Settings().rubberband_binary, Settings().rubberband_r3_flag).path:
        pytest.skip("Rubber Band not installed")
    s, rel, _ = imported(tmp_path, "Wahmatic_Guitar_125_G#Min_PL_2.wav", clicks(125.0, 1, tail_s=0.2))
    out = ".drumvault/ambience/abc-0-b4-0-120.wav"
    pipeline.render_bass(s, rel, 0, 0, BPM, out, bars=4)
    y, sr = sf.read(Path(s.library_path) / out, always_2d=True)
    assert y.shape[0] == int(round(8 * sr))
    found = onsets_s(y, sr)
    assert len(found) == 16 and max(abs(t - round(t / 0.5) * 0.5) for t in found) < 0.004


def test_textures_from_before_get_their_tempo_and_their_whole_bars_back(tmp_path):
    s, _, loop = imported(tmp_path, "FF_DHG_123_kit_loop_neon_guitar_pluck_Gmin.wav", clicks(123.0, 4, tail_s=0.3))
    _, _, noise = imported(tmp_path, "Tape Hiss.wav", crackle(8))
    lib = Path(s.library_path)
    # As an older import left it: trimmed short of its 4 bars, no tempo looked for.
    y, sr = sf.read(lib / loop["rel_path"], always_2d=True)
    sf.write(str(lib / loop["rel_path"]), y[: int(6.9 * sr)], sr, subtype="PCM_24")
    with LibraryDB(s.library_path) as db:
        db.conn.execute("UPDATE hits SET bpm = NULL")
        db.update_hit(loop["id"], duration_s=6.9)
        assert len(db.textures_untimed()) == 2
    assert pipeline.time_textures(s) == 1
    with LibraryDB(s.library_path) as db:
        h = db.get_hit(loop["id"])
        assert h["bpm"] == 123 and h["duration_s"] == pytest.approx(4 * 240 / 123, abs=1e-3)
        assert db.get_hit(noise["id"])["bpm"] == 0
        assert db.textures_untimed() == []
    assert sf.info(str(lib / loop["rel_path"])).frames == int(round(4 * 240 / 123 * s.output_sample_rate))
