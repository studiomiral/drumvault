"""The Splice scan (SCOPE.md §6.12): what a file's name and length say it could be."""

from pathlib import Path

import numpy as np
import soundfile as sf

from drumvault_engine import hits, splice
from drumvault_engine.config import Settings
from drumvault_engine.schemas import RpcRequest

S = Settings()


def test_names_say_which_page_a_sound_is_for():
    stab = lambda name, dur=1.0: splice.suggest(name, dur, S)
    assert stab("FF_RUKH_piano_chord_Dmin.wav")[0] == "stab"
    assert stab("PJ_NV_oneshot_electric_piano_Chord_3_Cm.wav", 1.8)[0] == "stab"
    assert stab("TA_UH2_SYNTH_ONESHOT_RAVE_STAB_C.wav")[0] == "stab"
    assert stab("MALAY_strings_stab_fall_C#min.wav", 2.1) == ("stab", "a short string stab")
    assert stab("DS_DPH_brass_ensemble_stab_gone_D.wav", 1.5)[0] == "disco"
    assert stab("Orchestra Hit F.wav", 0.9)[0] == "disco"
    assert stab("FSW_melodic_strings_violins_Am.wav", 10.4) == ("strings", "a long string sound")
    assert stab("T_TSMK6_124_string_loop_cry_for_me_Bb.wav", 3.9) == ("strings", "a string loop: check it holds at other tempos")


def test_a_synth_one_shot_is_a_stab_only_with_a_whole_key():
    assert splice.suggest("ZEN_FORG_synth_one_shot_amazing_Dm.wav", 1.4, S)[0] == "stab"
    assert splice.suggest("PM_GB_Synth_One_Shot_Pluck_Saw_C.wav", 1.0, S) is None       # a single note
    assert splice.suggest("HP_Synth_Hit_07_F.wav", 1.6, S) is None


def test_a_bass_one_shot_goes_to_the_bass_samples_a_bass_loop_nowhere():
    assert splice.suggest("shs_dr_bass_synth_one_shot_Albatros_D.wav", 3.1, S) == ("bass", "a bass one-shot")
    assert splice.suggest("BS_KNMP_Bass_Synth_Neuro_hamour_D.wav", 0.5, S)[0] == "bass"
    assert splice.suggest("808_sub_C.wav", 1.2, S)[0] == "bass"
    assert splice.suggest("BOS_NTH_128_Bass_Synth_Loop_Puncher_Dry_Fm.wav", 7.5, S) is None       # a loop
    assert splice.suggest("AU_BTH_123_bass_synth_diamond_Emin.wav", 3.0, S) is None                # a tempo, not a one-shot
    assert splice.suggest("PACK_123_bass_oneshot_E.wav", 1.0, S)[0] == "bass"                      # the pack's tempo on a one-shot
    assert splice.suggest("bass_drum_one_shot.wav", 0.4, S) is None                                # a drum
    assert splice.suggest("Deep_Bass_C.wav", 9.0, S) is None                                       # too long for a one-shot


def test_drums_fx_vocals_bass_loops_and_other_loops_are_left_out():
    for name, dur in [("MIXREADY_kick_club_disco_pop_layered.wav", 0.5), ("OLIVER_120_drum_loop_disco_mixready_funk.wav", 8.6),
                      ("BOS_NTH_128_Bass_Synth_Loop_Puncher_Dry_Fm.wav", 7.5), ("KMRBI_RHS4_90_key_piano_vocal_loop_grow_Bm.wav", 10.7),
                      ("ESM_PG_cinematic_fx_archery_bow_fire_air_buzz_string_01.wav", 0.5), ("BOS_DLL_174_Piano_Chords_Loop_Fly_Wet_Fm.wav", 16.6),
                      ("SO_FH_125_brass_chords_moozic_Gmin.wav", 15.4), ("MA_HDD_Piano_Drone_One_Shot_Gaslamp_Am.wav", 19.2),
                      ("AU_BTH_synth_lead_one_shot_sunrising_G#.wav", 1.6)]:
        assert splice.suggest(name, dur, S) is None, name
    # "fx" in a name that calls itself a stab is still a stab.
    assert splice.suggest("OLIVER_hits_fx_one_shot_disco_string_stab_Bmaj.wav", 0.7, S)[0] == "disco"


def test_length_decides_between_a_hit_and_what_is_too_long_or_a_click():
    assert splice.suggest("piano_chord_Cm.wav", 0.05, S) is None                         # a click
    assert splice.suggest("piano_chord_Cm.wav", S.thresholds.hit_max_len_s + 5, S)[0] == "stab"   # named a chord: may ring on
    assert splice.suggest("organ_Cm.wav", S.thresholds.hit_max_len_s + 1, S) is None    # not named a one-shot: too long for a hit
    assert splice.suggest("piano_one_shot_Cm.wav", S.thresholds.splice_stab_max_len_s + 1, S) is None
    assert splice.suggest("warm_strings_Am.wav", S.thresholds.strings_max_len_s + 1, S) is None
    # A number in the tempo range is a tempo, unless the name says one-shot.
    assert splice.suggest("PACK_125_piano_Cm.wav", 2.0, S) is None
    assert splice.suggest("PACK_125_piano_oneshot_Cm.wav", 2.0, S)[0] == "stab"
    assert splice.name_bpm("dd_music_125_strut_string_C#.wav", 70, 180) == 125
    assert splice.name_bpm("Hit_07_F.wav", 70, 180) is None


def test_key_from_the_name():
    assert splice.name_key_label("FF_RUKH_piano_chord_Dmin.wav") == ("Dm", "name")
    assert splice.name_key_label("T_TSMK6_stab_oneshot_bone_F.wav") == ("F", "root")
    assert splice.name_key_label("fhg2_stab_endstab.wav") == (None, None)


def _tone(path: Path, seconds: float, hz: float = 220.0, sr: int = 22050) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    t = np.arange(int(seconds * sr)) / sr
    sf.write(str(path), (0.5 * np.sin(2 * np.pi * hz * t) * np.exp(-2 * t)).astype(np.float32), sr)


def test_scan_lists_candidates_reads_only_and_knows_what_is_already_in(tmp_path):
    root = tmp_path / "Splice"
    _tone(root / "sounds" / "packs" / "House Keys" / "One Shots" / "HK_piano_chord_Am.wav", 1.2)
    _tone(root / "sounds" / "packs" / "House Keys" / "HK_124_drum_loop.wav", 2.0)
    _tone(root / "sounds" / "packs" / "Strings Vol 1" / "SV_warm_strings_Dm.wav", 6.0, 146.8)
    _tone(root / "sounds" / "packs" / "Horns" / "HN_brass_hit_F.wav", 0.8, 174.6)
    (root / "sounds" / "packs" / "Horns" / "notes.txt").write_text("not audio")
    before = sorted(p.as_posix() for p in root.rglob("*"))
    settings = Settings(library_path=str(tmp_path / "lib"))

    r = splice.scan(settings, str(root))
    assert r["found"] and r["files"] == 4
    by = {c["name"]: c for c in r["candidates"]}
    assert set(by) == {"HK_piano_chord_Am", "SV_warm_strings_Dm", "HN_brass_hit_F"}
    assert (by["HK_piano_chord_Am"]["kind"], by["HK_piano_chord_Am"]["pack"], by["HK_piano_chord_Am"]["key_label"]) == ("stab", "House Keys", "Am")
    assert by["SV_warm_strings_Dm"]["kind"] == "strings" and by["SV_warm_strings_Dm"]["duration_s"] == 6.0
    assert by["HN_brass_hit_F"]["kind"] == "disco" and by["HN_brass_hit_F"]["key_source"] == "root"
    assert all(c["imported"] is None for c in r["candidates"])
    # Nothing in the Splice folder is touched, and no library is made by looking.
    assert sorted(p.as_posix() for p in root.rglob("*")) == before
    assert not (tmp_path / "lib").exists()

    # Added to a page (the page's own import): the next scan says where it is.
    hits.import_hits(settings, [by["HK_piano_chord_Am"]["path"]], "stab")
    again = {c["name"]: c for c in splice.scan(settings, str(root))["candidates"]}
    assert again["HK_piano_chord_Am"]["imported"] == "stab"
    assert again["HN_brass_hit_F"]["imported"] is None


def test_scan_of_a_missing_folder_and_the_rpc_method(tmp_path):
    r = splice.scan(Settings(library_path=str(tmp_path / "lib")), str(tmp_path / "nowhere"))
    assert r == {"folder": str(tmp_path / "nowhere"), "found": False, "files": 0, "candidates": []}
    assert RpcRequest.model_validate({"id": "1", "method": "scan_splice", "params": {"folder": "~/Splice"}}).method == "scan_splice"
