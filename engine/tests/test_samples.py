"""Loose samples (samples.py): reading names, cutting loops, and packs in the library."""

import json
import shutil
import sqlite3

import numpy as np
import pytest
import soundfile as sf

import make_fixtures as mf
from drumvault_engine import pipeline, samples
from drumvault_engine.audioutil import Audio
from drumvault_engine.config import Settings
from drumvault_engine.loops import bar_length
from drumvault_engine.schemas import Overrides

SR = 44100


def _pattern(sound, bpm: float, bars: int, steps: list[int], seed: int = 0, sr: int = SR) -> np.ndarray:
    rng = np.random.default_rng(seed)
    hit = sound(sr, rng)
    n = int(round(bars * 240 / bpm * sr))
    y = np.zeros(n)
    for b in range(bars):
        for s in steps:
            a = int(round((b * 16 + s) * 60 / bpm / 4 * sr))
            y[a:a + len(hit)] += hit[:n - a]
    return (0.8 * y / np.max(np.abs(y)))[:, None].repeat(2, axis=1).astype(np.float32)


def _write(path, data, sr=SR):
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), data, sr, subtype="PCM_24")


@pytest.fixture
def splice(tmp_path):
    """A Splice pack folder: one-shots, loops with and without a BPM in the name, and misfits."""
    root = tmp_path / "Splice" / "sounds" / "packs" / "House Tools"
    rng = np.random.default_rng(3)
    _write(root / "One Shots" / "HT_Kick_01.wav", mf.kick(SR, rng)[:, None].astype(np.float32) * 0.8)
    _write(root / "One Shots" / "HT_Clap_03_Am.wav", mf.clap(SR, rng)[:, None].astype(np.float32) * 0.8)
    _write(root / "Loops" / "HT_120_Hat_Loop_01.wav", _pattern(mf.hat_closed, 120, 2, [2, 6, 10, 14]))
    _write(root / "Loops" / "HT_Top_Loop_Fm.wav", _pattern(mf.shaker, 124, 4, list(range(0, 16, 2)), 1))
    _write(root / "Loops" / "HT_126_Kick_Loop.wav", _pattern(mf.kick, 126, 1, [0, 4, 8, 12]))
    _write(root / "Loops" / "HT_124_Bass_Loop.wav", _pattern(mf.conga, 124, 2, [0, 6]))
    _write(root / "Loops" / "HT_Hat_Loop_Odd.wav", _pattern(mf.hat_closed, 124, 2, [2, 6])[:SR * 3])
    (root / "Loops" / "HT_Preview.mp3").write_bytes(b"not audio")
    return root


def _settings(tmp_path, **kw):
    return Settings(library_path=str(tmp_path / "lib"), workers=2, **kw)


def _db(s):
    db = sqlite3.connect(f"{s.library_path}/.drumvault/library.sqlite")
    db.row_factory = sqlite3.Row
    return db


def test_reading_names():
    assert samples.name_bpm("Loops/HT_120_Hat_Loop_01.wav") == 120
    assert samples.name_bpm("Loops/Top Loop 126bpm.wav") == 126
    assert samples.name_bpm("124 BPM/Top Loop.wav") == 124
    assert samples.name_bpm("One Shots/HT_Kick_01.wav") is None
    assert samples.name_key("HT_Clap_03_Am.wav") == ("Am", "8A")
    assert samples.name_key("Stab F#min.wav") == ("F#m", "11A")
    assert samples.name_key("Kit_A_Kick.wav") is None              # a bare letter is no key
    assert samples.name_category("Kicks/BBH_03.wav") == "kick"     # from the folder
    assert samples.name_category("Loops/HT_Hat_Loop.wav") == "hat"
    assert samples.name_category("120_drum_loop_no_kick_enigma.wav") == "drums"


def test_loop_tempo_from_the_name_or_whole_bars():
    s = Settings()
    assert samples.loop_tempo(2 * 240 / 120, 120, s) == (120, 2)
    assert samples.loop_tempo(2 * 240 / 120 + 0.7, 120, s) == (120, 2)    # a tail is cut
    assert samples.loop_tempo(4 * 240 / 126, None, s) == (126, 4)          # whole bars, no name
    assert samples.loop_tempo(3.0, None, s) is None                         # no tempo fits


def test_kind_from_name_and_length():
    s = Settings()
    assert samples.plan("One Shots/HT_Kick_01.wav", "kick", 0.5, s).kind == "oneshot"
    assert samples.plan("HT_120_Hat_Loop.wav", "hat", 4.0, s).kind == "loop"
    assert samples.plan("HT_126_Kick_Loop.wav", "kick", 240 / 126, s).kind == "hits"
    assert samples.plan("HT_105_Kick_Loop.wav", "kick", 2 * 240 / 105, s).kind == "hits"  # hits aren't stretched
    assert samples.plan("HT_124_Bass_Loop.wav", "melodic", 240 / 124, s).kind is None
    assert samples.plan("HT_124_Riser.wav", "fx_riser", 8.0, s).kind == "event"
    assert "whole bars" in samples.plan("HT_Hat_Loop_Odd.wav", "hat", 3.0, s).why


def test_pack_root():
    from pathlib import Path
    f = Path("/Users/x/Splice/sounds/packs/House Tools/Loops/a.wav")
    assert samples.pack_root(f, f) == Path("/Users/x/Splice/sounds/packs/House Tools")
    g = Path("/Users/x/Downloads/Kit/a.wav")
    assert samples.pack_root(g, g) == Path("/Users/x/Downloads/Kit")


def test_a_loop_at_the_library_tempo_is_kept_as_is(tmp_path):
    y = _pattern(mf.hat_closed, 124, 2, [2, 6, 10, 14])
    lp, _ = samples.cut_loop(Audio(y, SR), 124, 2, Settings(), tmp_path)
    assert lp.data.shape[0] == 2 * bar_length(SR, 124)
    assert np.allclose(lp.data, y[:lp.data.shape[0]], atol=1e-4)


def test_a_stretched_loop_joins_end_to_start(tmp_path):
    y = _pattern(mf.hat_closed, 120, 2, [2, 6, 10, 14])
    lp, _ = samples.cut_loop(Audio(y, SR), 120, 2, Settings(), tmp_path)
    assert lp.data.shape[0] == 2 * bar_length(SR, 124)
    # Hits stay on the 124 grid: the offbeat 8ths, none smeared over the loop's end.
    mono = np.abs(lp.data[:, 0])
    eighth = bar_length(SR, 124) // 8
    starts = [int(np.argmax(mono[i * eighth:(i + 1) * eighth] > 0.1)) + i * eighth for i in (1, 3, 5, 7)]
    assert all(abs(a - i * eighth) < 0.004 * SR for a, i in zip(starts, (1, 3, 5, 7)))
    assert np.max(mono[-200:]) < 0.05 and np.max(mono[:200]) < 0.05


def test_import_a_splice_pack(tmp_path, splice):
    s = _settings(tmp_path)
    [r] = pipeline.import_samples(s, [str(splice / "One Shots"), str(splice / "Loops")])
    assert r.source_code == "P0001" and r.file_name == "House Tools"
    assert r.status == "needs_review"                       # the odd hat loop wants a look
    assert any("HT_Hat_Loop_Odd.wav" in w for w in r.warnings)
    assert any("HT_124_Bass_Loop.wav" in w and "not drums" in w for w in r.warnings)
    assert any(".mp3" in w for w in r.warnings)
    db = _db(s)
    z = db.execute("SELECT * FROM zips").fetchone()
    assert z["kind"] == "pack" and db.execute("SELECT COUNT(*) FROM arrangements").fetchone()[0] == 0
    rows = {(x["category"], x["kind"]): x for x in db.execute("SELECT * FROM samples")}
    assert set(rows) == {("kick", "oneshot"), ("clap", "oneshot"), ("hat", "loop"), ("top", "loop")}
    loops = [x for x in db.execute("SELECT * FROM samples WHERE kind = 'loop'")]
    assert len(loops) == 2 and all(x["bpm"] == 124 and x["groove"] for x in loops)
    hat = next(x for x in loops if x["bars"] == 2)
    data, sr = sf.read(f"{s.library_path}/{hat['rel_path']}")
    assert len(data) == 2 * bar_length(sr, 124)
    top = next(x for x in loops if x["bars"] == 4)
    assert top["key_label"] == "Fm" and "_Fm_P0001-house-tools_" in top["rel_path"]
    clap = rows[("clap", "oneshot")]
    assert clap["key_label"] == "Am" and clap["rel_path"].startswith("One-Shots/Claps/OS_Clap_Am_P0001-house-tools")
    kicks = db.execute("SELECT COUNT(*) FROM samples WHERE category = 'kick'").fetchone()[0]
    assert kicks >= 2                                       # the one-shot and the kick loop's hit
    used = {x["file_name"]: json.loads(x["used_for"]) for x in db.execute("SELECT * FROM stems")}
    assert used["Loops/HT_120_Hat_Loop_01.wav"] == ["loops"] and used["Loops/HT_124_Bass_Loop.wav"] == []


def test_adding_to_a_pack_and_skipping_what_is_in(tmp_path, splice):
    s = _settings(tmp_path)
    pipeline.import_samples(s, [str(splice / "One Shots")])
    [again] = pipeline.import_samples(s, [str(splice / "One Shots" / "HT_Kick_01.wav")])
    assert again.status == "skipped"
    db = _db(s)
    db.execute("UPDATE samples SET favorite = 1 WHERE category = 'kick'")
    db.commit()
    [more] = pipeline.import_samples(s, [str(splice / "Loops" / "HT_120_Hat_Loop_01.wav")])
    assert more.source_code == "P0001" and more.counts.loops == 1
    assert db.execute("SELECT COUNT(*) FROM zips").fetchone()[0] == 1
    assert db.execute("SELECT favorite FROM samples WHERE category = 'kick'").fetchone()[0] == 1  # kept
    # A zip after a pack is still S0001.
    with pipeline.LibraryDB(s.library_path) as ldb:
        assert ldb.next_source_number("S") == 1 and ldb.next_source_number("P") == 2


def test_reprocess_rebuild_and_delete_a_pack(tmp_path, splice):
    s = _settings(tmp_path)
    [r] = pipeline.import_samples(s, [str(splice / "Loops")])
    db = _db(s)
    stem = db.execute("SELECT id FROM stems WHERE file_name = 'Loops/HT_124_Bass_Loop.wav'").fetchone()[0]
    r2 = pipeline.process_zip(None, s, zip_id=r.zip_id, overrides=Overrides(stems={str(stem): "perc"}))
    assert r2.status == "needs_review"
    assert db.execute("SELECT COUNT(*) FROM samples WHERE category = 'perc' AND kind = 'loop'").fetchone()[0] == 1
    s.library_bpm = 126.0
    [rb] = pipeline.rebuild_loops(s)
    assert rb.counts.loops == r2.counts.loops
    assert {x[0] for x in db.execute("SELECT bpm FROM samples WHERE kind = 'loop'")} == {126.0}
    with pytest.raises(pipeline.PipelineError):
        pipeline.grid_preview(s, r.zip_id)
    pipeline.delete_zip(s, r.zip_id)
    assert db.execute("SELECT COUNT(*) FROM samples").fetchone()[0] == 0
    assert (splice / "Loops" / "HT_120_Hat_Loop_01.wav").exists()   # the originals stay


def test_a_dropped_folder_outside_splice_is_one_pack(tmp_path, splice):
    kit = tmp_path / "Downloads" / "Garage Kit"
    shutil.copytree(splice / "One Shots", kit / "Drums")
    s = _settings(tmp_path)
    [r] = pipeline.import_samples(s, [str(kit)])
    assert r.file_name == "Garage Kit" and r.counts.oneshots == 2 and r.status == "done"


def test_rpc_accepts_import_samples():
    from drumvault_engine.schemas import ImportSamplesParams, RpcRequest
    req = RpcRequest.model_validate({"id": "1", "method": "import_samples", "params": {"paths": ["/x"]}})
    assert ImportSamplesParams.model_validate(req.params).paths == ["/x"]


def test_a_kick_loop_too_far_to_stretch_still_gives_its_hits(tmp_path):
    f = tmp_path / "HT_105_Kick_Loop.wav"
    _write(f, _pattern(mf.kick, 105, 2, [0, 4, 8, 12]))
    r = samples.process_file(f, f.name, None, Settings(), True, tmp_path)
    assert r.category == "kick" and len(r.oneshots) >= 1 and not r.loops and not r.skipped


def test_loops_too_far_to_stretch_are_noted_not_flagged(tmp_path):
    kit = tmp_path / "DnB Kit"
    _write(kit / "DB_174_Hat_Loop.wav", _pattern(mf.hat_closed, 174, 2, [2, 6, 10, 14]))
    _write(kit / "DB_Snare_01.wav", mf.snare(SR, np.random.default_rng(0))[:, None].astype(np.float32) * 0.8)
    [r] = pipeline.import_samples(_settings(tmp_path), [str(kit)])
    assert r.status == "done" and r.counts.oneshots == 1 and r.counts.loops == 0
    assert any("174 BPM is too far" in w for w in r.warnings)
