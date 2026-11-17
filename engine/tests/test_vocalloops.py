"""Splice vocal loops and phrases (SCOPE.md §6.11a): made into takes with Splice's record of them and
the pack's link; and where the user's own tracks sing (their vocal stems, in the arrangement)."""

import json
import sqlite3
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from drumvault_engine import arrangement, splice, vocalloop
from drumvault_engine.config import Settings

SR = 44100


def sung(seconds: float, bpm: float, sr: int = SR, loud_from: float = 0.0) -> np.ndarray:
    """A line in A minor every 2 bars (C, E, B, A held), as long as asked; quiet before `loud_from` s."""
    beat = 60 / bpm
    line = []
    for midi, beats in ((72, 1), (76, 1), (71, 1), (69, 3)):
        t = np.arange(int(beats * beat * sr * 0.9)) / sr
        hz = 440 * 2 ** ((midi - 69) / 12)
        tone = 0.3 * (np.sin(2 * np.pi * hz * t) + 0.3 * np.sin(4 * np.pi * hz * t)) * np.minimum(1, t / 0.02)
        line.append(np.concatenate([tone, np.zeros(int(beats * beat * sr) - len(tone))]))
    phrase = np.concatenate(line + [np.zeros(int(2 * beat * sr))])
    n = int(seconds * sr)
    y = np.tile(phrase, n // len(phrase) + 1)[:n].astype(np.float32)
    if loud_from:
        y[: int(loud_from * sr)] *= 0.05
    return np.stack([y, y], axis=1)


def splice_db(path: Path, rows: list[tuple]) -> Path:
    """A Splice desktop database with `rows`: (local_path, filename, bpm, key, chord_type, sample_type)."""
    c = sqlite3.connect(path)
    c.executescript("""
        CREATE TABLE packs (id INTEGER PRIMARY KEY, uuid TEXT UNIQUE, name TEXT, description TEXT, cover_url TEXT, genre TEXT, permalink TEXT, provider_name TEXT);
        CREATE TABLE samples (id INTEGER PRIMARY KEY, local_path TEXT, attr_hash TEXT, dir TEXT, audio_key TEXT, bpm INTEGER, chord_type INTEGER,
          duration INTEGER, file_hash TEXT UNIQUE, sas_id TEXT, filename TEXT, genre INTEGER, pack_uuid TEXT, sample_type INTEGER, tags TEXT,
          popularity INTEGER, purchased_at timestamp, last_modified_at timestamp, waveform_url TEXT, provider_name TEXT);
        INSERT INTO packs (uuid, name, permalink, provider_name) VALUES ('p1', 'Vocal Allstars', 'toolroom-vocal-all-stars', 'Toolroom');
    """)
    for i, (local, name, bpm, key, chord, kind) in enumerate(rows):
        c.execute("INSERT INTO samples (local_path, filename, bpm, audio_key, chord_type, sample_type, file_hash, pack_uuid, tags) "
                  "VALUES (?, ?, ?, ?, ?, ?, ?, 'p1', 'vocals,house,male')", (local, name, bpm, key, chord, kind, f"h{i}"))
    c.commit()
    c.close()
    return path


@pytest.fixture
def lab(tmp_path, monkeypatch):
    """A library, a Splice folder, Splice's database, and splice.com answering only for the right label."""
    asked = []

    def answers(url, timeout):
        asked.append(url)
        return "/toolroom-records/" in url

    monkeypatch.setattr(vocalloop, "_answers", answers)
    src = tmp_path / "Splice"
    src.mkdir()
    return tmp_path, src, asked


def settings_for(tmp: Path, db: Path) -> Settings:
    return Settings(library_path=str(tmp / "lib"), library_bpm=124.0, splice_db=str(db))


def test_a_loop_becomes_a_take_with_splice_s_record_and_its_link(lab):
    tmp, src, asked = lab
    f = src / "T_VA_120_vocal_hook_loop_thatthing_male_Am.wav"
    sf.write(str(f), sung(4 * 4 * 60 / 120, 120), SR, subtype="PCM_24")   # 4 bars at 120
    db = splice_db(tmp / "sounds.db", [(str(f), f.name, 120, "a", "minor", "loop")])
    s = settings_for(tmp, db)
    r = vocalloop.import_loops(s, [str(src)])
    [got] = r["imported"]
    assert (got["key"], got["bpm"], got["bars"]) == ("Am", 120, 4) and "chops" not in got
    assert got["url"] == "https://splice.com/sounds/packs/toolroom-records/toolroom-vocal-all-stars/samples"
    d = Path(s.library_path) / "Vocals" / got["id"]
    meta = json.loads((d / "meta.json").read_text())
    assert meta["source"] == "splice" and meta["usedIn"] == [] and meta["vocal"] == f"Vocals/{got['id']}/vocal.wav"
    assert meta["analysis"]["chops"] == [] and not (d / "chops").exists()   # chops are out
    assert {k: meta["splice"][k] for k in ("file", "pack", "label", "bpm", "loop", "key_source")} == {
        "file": f.name, "pack": "Vocal Allstars", "label": "Toolroom", "bpm": 120, "loop": True, "key_source": "name"}
    # Its phrase loop: its 4 bars stretched to the library tempo, exactly.
    [ph] = meta["analysis"]["phrases"]
    y, sr = sf.read(str(Path(s.library_path) / ph["path"]), always_2d=True)
    assert len(y) == round(4 * 4 * 60 / 124 * sr) and ph["stretch"] == pytest.approx(120 / 124, abs=0.002)
    # The label's link part found once and remembered: the next pack of that label asks nothing.
    labels = json.loads((Path(s.library_path) / ".drumvault" / "splice_labels.json").read_text())
    assert labels == {"Toolroom": "toolroom-records"}
    assert asked == ["https://splice.com/sounds/packs/toolroom/toolroom-vocal-all-stars/samples",
                     "https://splice.com/sounds/packs/toolroom-records/toolroom-vocal-all-stars/samples"]
    asked.clear()
    assert vocalloop.pack_link(s, "Toolroom", "mark-knight-vol-6") == "https://splice.com/sounds/packs/toolroom-records/mark-knight-vol-6/samples"
    assert asked == []
    # The same file again: skipped; the scan knows it's on the Vocal Loops page.
    assert vocalloop.import_loops(s, [str(f)]) == {"imported": [], "skipped": 1, "failed": []}
    [c] = splice.scan(s, str(src))["candidates"]
    assert (c["kind"], c["imported"]) == ("vocal", "vocal")


def test_a_phrase_without_a_tempo_lies_on_the_bars_that_hold_it_unstretched(lab):
    tmp, src, _ = lab
    f = src / "Vocal_Phrase_Oneshot_Feel_It.wav"
    x = sung(3.0, 124)
    sf.write(str(f), x, SR, subtype="PCM_24")
    db = splice_db(tmp / "sounds.db", [(str(f), f.name, 0, "a", "", "oneshot")])
    s = settings_for(tmp, db)
    [got] = vocalloop.import_loops(s, [str(f)])["imported"]
    assert got["bpm"] is None and got["bars"] == 2                    # 3 s: 2 bars at 124 hold it
    meta = json.loads((Path(s.library_path) / "Vocals" / got["id"] / "meta.json").read_text())
    [ph] = meta["analysis"]["phrases"]
    assert ph["stretch"] == 1.0 and meta["splice"]["loop"] is False
    # Splice's root alone ("a", no scale): the scale sung on it.
    assert meta["key"] == "Am" and meta["splice"]["key_source"] == "splice"


def test_a_long_loop_keeps_the_8_bars_it_sings_most_in(lab):
    tmp, src, _ = lab
    f = src / "Vocal_Hook_Loop_124_Long_Am.wav"
    bar = 4 * 60 / 124
    sf.write(str(f), sung(24 * bar, 124, loud_from=8 * bar), SR, subtype="PCM_24")   # 24 bars, quiet for the first 8
    s = settings_for(tmp, splice_db(tmp / "sounds.db", []))
    [got] = vocalloop.import_loops(s, [str(f)])["imported"]
    meta = json.loads((Path(s.library_path) / "Vocals" / got["id"] / "meta.json").read_text())
    [ph] = meta["analysis"]["phrases"]
    assert ph["bars"] == 8
    y, sr = sf.read(str(Path(s.library_path) / ph["path"]), always_2d=True)
    assert len(y) == round(8 * bar * sr)
    # Not Splice's: no pack, no link; the tempo from the name.
    assert meta["splice"]["pack"] is None and meta["splice"]["url"] is None and meta["splice"]["bpm"] == 124


def test_too_short_too_long_or_silent_isnt_added(lab):
    tmp, src, _ = lab
    s = settings_for(tmp, splice_db(tmp / "sounds.db", []))
    sf.write(str(src / "vox_blip.wav"), sung(0.5, 124), SR)
    sf.write(str(src / "vox_quiet_124.wav"), np.zeros((SR * 4, 2), dtype=np.float32), SR)
    r = vocalloop.import_loops(s, [str(src)])
    assert r["imported"] == [] and len(r["failed"]) == 2
    with pytest.raises(vocalloop.VocalLoopError):
        vocalloop.import_loops(s, [str(tmp / "nothing")])


def test_splice_suggests_vocal_loops_near_the_tempo_and_phrases():
    S = Settings(library_bpm=124.0)
    assert splice.suggest("T_VA_124_vocal_hook_loop_thatthing_male_C#min.wav", 154.8, S) == ("vocal", "a vocal loop at 124 BPM")
    assert splice.suggest("91V_HV_124_vocal_hook_my_heart_went_boom_tail_wet_A#m.wav", 16.0, S) == ("vocal", "a vocal loop at 124 BPM")
    assert splice.suggest("T_TSMK6_vocal_phrase_oneshot_female_down_in_my_soul_wet_Am.wav", 4.0, S) == ("vocal", "a vocal phrase")
    assert splice.suggest("BOS_GVB_174_Vocal_Hook_Loop_Sabotage_Chorus_Lead_Dry_Fm.wav", 11.0, S) is None   # far off the tempo
    assert splice.suggest("ESM_ACV_Vocals_female_death_strained_cough.wav", 1.2, S) is None               # an FX, not words
    assert splice.suggest("BRS_Voice_Male_Grunts_Short.wav", 3.0, S) is None
    assert splice.suggest("AU_BTH_vocal_chop_one_shot_ah_F.wav", 0.6, S) is None                         # a chop one-shot
    assert splice.suggest("KMRBI_RHS4_90_key_piano_vocal_loop_grow_Bm.wav", 10.7, S) is None             # a piano loop


def test_the_arrangement_measures_where_the_track_sings_apart_from_its_parts():
    th = Settings().thresholds
    bpm, bars = 124.0, 16
    bar = int(4 * 60 / bpm * SR)
    rng = np.random.default_rng(1)
    kick = np.zeros(bars * bar, dtype=np.float32)
    for b in range(bars * 4):
        kick[b * bar // 4: b * bar // 4 + 2000] = np.sin(np.linspace(0, 60, 2000)) * 0.9
    vox = np.zeros(bars * bar, dtype=np.float32)
    vox[8 * bar: 12 * bar] = 0.02 * rng.standard_normal(4 * bar)         # sings in bars 9–12, under the kick
    stems = [("Kick.wav", "kick", kick, SR), ("Lead Vox.wav", "ignore", vox, SR), ("Reverb Return.wav", "ignore", vox * 0.5, SR)]
    assert arrangement.measured("Lead Vox.wav", "ignore") and not arrangement.measured("Reverb Return.wav", "ignore")
    a = arrangement.measure(stems, bpm, 0.0, th)
    assert set(a["parts"]) == {"kick"} and set(a["detail"]) == {"kick"}   # not a part: sections and balance as before
    v = a["levels"]["vocal"]
    assert v["bars"] == ("0" * 8 + "2" * 4 + "0" * 4)[: a["bars"]]
    assert v["lufs"] is not None and v["lufs"] < a["levels"]["parts"]["kick"]
    assert a["levels"]["vocals_measured"] is True
    # A track that doesn't sing: looked for, none.
    b = arrangement.measure(stems[:1], bpm, 0.0, th)
    assert b["levels"]["vocals_measured"] is True and "vocal" not in b["levels"]
