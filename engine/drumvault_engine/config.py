"""Settings and analysis thresholds.

Every tunable number used by the analysis lives here (CLAUDE.md rule), so it
can be adjusted against real material without touching the algorithms.

`Settings` holds the user-facing settings (SCOPE.md §5.13) that the app
persists as JSON and sends with every job. `Thresholds` holds the analysis
constants; it is nested in `Settings` so the app *can* override them, but
normally never does.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

# --------------------------------------------------------------------------
# Category groups
# --------------------------------------------------------------------------

# Genres: every source (a zip or pack, a MIDI file, a sound on the Sounds pages) belongs to one, set
# when it is imported (the active genre, Create's top bar); everything from before genres is house.
# A reference track's genre is its folder: References/<name>/ (any other place: house).
GENRES = {"house": "House", "organic": "Organic"}
DEFAULT_GENRE = "house"


def genre_or_default(genre: str | None) -> str:
    return genre if genre in GENRES else DEFAULT_GENRE


ONESHOT_CATEGORIES = (
    "kick", "clap", "snare", "hat", "hat_closed", "hat_open",
    "ride", "cymbal", "shaker", "perc",
)
DRUM_CATEGORIES = ONESHOT_CATEGORIES + ("top", "groove", "drums")
# Stems cut into grid-aligned events (SCOPE.md §5.8a): fills, snare rolls and FX.
EVENT_CATEGORIES = (
    "fill", "roll", "fx_riser", "fx_downlifter", "fx_impact", "fx_sweep", "fx_atmos", "fx",
)
ALL_CATEGORIES = DRUM_CATEGORIES + EVENT_CATEGORIES + ("melodic", "full_mix", "ignore")


def _default_loop_lengths() -> dict[str, list[int]]:
    # SCOPE.md §5.8. Categories missing here (kick, cymbal) produce no loops.
    return {
        "snare": [2, 4],
        "clap": [2, 4],
        "hat": [1, 2, 4],
        "hat_closed": [1, 2, 4],
        "hat_open": [1, 2, 4],
        "ride": [1, 2, 4],
        "shaker": [1, 2, 4],
        "perc": [1, 2, 4],
        "top": [2, 4, 8],
        "groove": [2, 4, 8],
        "drums": [2, 4, 8],
    }


@dataclass
class Thresholds:
    # ---- discovery (zipio) ------------------------------------------------
    # Warn if stem lengths differ by more than this many bars.
    stem_length_mismatch_bars: float = 1.0

    # ---- classification audio fallback (classify) --------------------------
    classify_analysis_sr: int = 22050
    classify_max_seconds: float = 60.0
    # percussive_ratio = fraction of HPSS energy that is percussive.
    classify_min_onset_density: float = 0.5  # onsets/sec for a percussive stem
    classify_max_flatness_harmonic: float = 0.1  # noisier than this is not melodic
    classify_max_centroid_harmonic_hz: float = 4000.0  # brighter is not melodic (rides, risers)
    classify_silence_rms_db: float = -60.0   # quieter than this -> ignore
    # Decay = median level `classify_decay_probe_ms` after each onset relative
    # to the attack peak. Hits fall away (even tonal ones: congas, toms,
    # kicks); held notes don't.
    classify_decay_probe_ms: float = 100.0
    classify_attack_window_ms: float = 50.0
    classify_max_decay_db_percussive: float = -4.0
    classify_percussive_strong: float = 0.7  # this percussive alone is enough
    classify_harmonic_max: float = 0.6       # more percussive -> never melodic
    classify_loud_frame_db: float = -20.0     # frames this far below the loudest weight features
    classify_kick_centroid_hz: float = 250.0  # below -> kick
    classify_hat_centroid_hz: float = 6000.0  # above -> hat

    # ---- tempo -------------------------------------------------------------
    tempo_lowpass_hz: float = 150.0
    tempo_hop: int = 128
    tempo_strong_onset_rel: float = 0.25   # strength >= rel * p95 -> strong
    tempo_refine_iterations: int = 3
    tempo_inlier_beat_fraction: float = 0.25  # |residual| < frac * beat for fit
    # Source tracks are always whole-number BPM (Settings.integer_bpm). A raw
    # detection further than this from a whole number is flagged for review.
    tempo_integer_snap: float = 0.05
    tempo_filename_tolerance: float = 1.0   # use filename BPM within this
    tempo_phase_tolerance_ms: float = 15.0
    # When the kick puts bar 1 off sample 0, the other drum stems are checked: if their hits sit
    # (median, within tempo_phase_tolerance_ms) on a grid from sample 0, the kick is just late.
    tempo_bar_one_min_onsets: int = 8
    # "The same" sample after reprocessing (favourites, deleted samples): same stem, kind and
    # length, start within this distance. Loops and events move with bar 1; one-shots don't.
    match_oneshot_tolerance_s: float = 0.03
    match_loop_tolerance_s: float = 0.25
    # Grid view preview (SCOPE.md §6.2a): the drum stems summed to mono at this rate.
    grid_preview_sr: int = 22050
    grid_preview_peak_dbfs: float = -1.0
    # ---- Kept originals (SCOPE.md §5.8d) -----------------------------------
    # A zip's stems are only kept in the library while this much disk stays free afterwards.
    originals_min_free_gb: float = 5.0
    # FLAC size as a share of the PCM WAV, for that check (measured: 0.38 on a stem zip; erring large).
    originals_flac_ratio: float = 0.6
    # ---- MIDI import and bass rendering (SCOPE.md §6.7) ----------------------
    # A MIDI file's length is rounded up to one of these bar counts.
    midi_bar_lengths: tuple[int, ...] = (1, 2, 4, 8, 16)
    # Logic exports a region where it sits in the project (bar 49, say): the empty bars before the
    # first note are cut, so the loop starts on its bar 1. A first note up to this many beats early
    # (pushed or humanized) still counts as on that bar's 1.
    midi_early_beats: float = 0.25
    # A last note held this far past a bar line (a few ticks) still ends the loop on that bar.
    midi_overhang_beats: float = 0.125
    # Below this median pitch (G3) a part counts as bass when its name doesn't say.
    midi_bass_max_median_pitch: int = 55
    # Rendered basslines are loudness-matched so patches compare fairly.
    bass_lufs_target: float = -14.0
    # A Serum 2 patch glides from one bass note into an overlapping next one (the bassline's slide)
    # when it is mono with legato on and its portamento time (Serum's 0…1 knob) is at least this.
    serum_glide_min_porta: float = 0.03
    bass_peak_dbfs: float = -1.0
    # Bass from a one-shot sample (basssample.py): a note fades out over bass_sample_release_ms once
    # let go, and over bass_sample_cut_ms where the next note cuts it; the softest note plays at
    # bass_sample_min_velocity of full; the sample's own note is read from its first
    # bass_sample_pitch_window_s, between these frequencies.
    bass_sample_release_ms: float = 30.0
    bass_sample_cut_ms: float = 5.0
    bass_sample_min_velocity: float = 0.4
    bass_sample_pitch_window_s: float = 1.0
    bass_sample_min_hz: float = 27.0
    bass_sample_max_hz: float = 260.0
    # A Piano tab one-shot (one note per file, like a bass sample): its note is read between these
    # frequencies (A0 to about C8), and it keeps up to piano_sample_max_len_s of its ring.
    piano_sample_min_hz: float = 27.5
    piano_sample_max_hz: float = 4200.0
    piano_sample_max_len_s: float = 12.0
    # Drop hits (SCOPE.md §6.8): one stab or brass hit per file, from its attack to where its
    # tail falls below peak + hit_tail_db, at most hit_max_len_s, peak-normalised.
    hit_max_len_s: float = 6.0
    hit_tail_db: float = -60.0
    hit_tail_hold_ms: float = 50.0
    hit_fade_out_ms: float = 10.0
    hit_peak_dbfs: float = -1.0
    # How many notes a hit plays (key.count_voices): the pitch classes within hit_voice_rel of the
    # strongest, over its first hit_voice_window_s, between these frequencies. A single note shows one
    # or two (its fifth rings in its harmonics); from hit_chord_voices it is a chord.
    hit_voice_window_s: float = 0.6
    hit_voice_rel: float = 0.35
    hit_voice_lo_hz: float = 55.0
    hit_voice_hi_hz: float = 5000.0
    hit_chord_voices: int = 3
    tempo_confidence_window_ms: float = 10.0
    tempo_attack_rel: float = 0.1           # sample-accurate attack threshold
    tempo_attack_search_ms: float = 40.0    # look this far past the onset for the hit peak
    tempo_rms_floor_db: float = -80.0       # log-RMS novelty floor (relative to the loudest frame)
    tempo_envelope_ms: float = 10.0         # trailing max window (bridges low-freq zero crossings)
    # Confidence multipliers when the kick stem is not available.
    tempo_fallback_penalty: dict[str, float] = field(default_factory=lambda: {
        "kick": 1.0, "drums": 0.95, "clap": 0.9, "snare": 0.9,
        "full_mix": 0.85, "sum": 0.8,
    })

    # ---- key ---------------------------------------------------------------
    key_bass_weight: float = 1.5
    key_min_confidence: float = 0.5         # below -> key_uncertain
    key_analysis_sr: int = 44100
    key_silence_db: float = -50.0           # fallback: skip frames quieter than this
    key_fallback_profile: str = "temperley"  # temperley | edma (see key.PROFILES)

    # ---- one-shots ---------------------------------------------------------
    oneshot_hop: int = 256
    oneshot_min_len_ms: dict[str, float] = field(default_factory=lambda: {
        "kick": 200, "snare": 200, "clap": 200, "hat": 50, "hat_closed": 50,
        "hat_open": 150, "ride": 300, "cymbal": 500, "perc": 60, "shaker": 60,
    })
    oneshot_tail_db: float = -60.0          # trim tail below peak + this
    oneshot_tail_hold_ms: float = 20.0      # ...once it stays below for this long
    oneshot_fade_out_ms: float = 5.0
    oneshot_max_len_s: float = 2.0
    oneshot_max_len_cymbal_s: float = 4.0
    oneshot_attack_rel: float = 0.1         # attack = first sample >= rel * peak
    oneshot_preroll_ms: float = 0.5         # start this much before the attack
    oneshot_envelope_ms: float = 5.0        # trailing-max envelope used to find attacks
    oneshot_attack_search_ms: float = 50.0
    oneshot_preonset_ms: float = 20.0       # window used to measure bleed
    oneshot_bleed_floor_db: float = -60.0   # bleed at/below this (rel. to the hit peak) counts as none
    oneshot_rank_gap_cap_s: float = 1.0
    oneshot_rank_weights: tuple[float, float, float] = (1.0, 1.0, 1.0)  # gap, peak, bleed
    oneshot_min_peak_rel_db: float = -30.0  # ignore hits this far below the stem's loudest
    oneshot_fingerprint_ms: float = 150.0
    hat_open_decay_db: float = -40.0
    hat_open_decay_ms: float = 150.0

    # ---- fingerprints (one-shots + loops) ----------------------------------
    fingerprint_sr: int = 22050
    fingerprint_n_mels: int = 64
    fingerprint_n_fft: int = 1024
    fingerprint_hop: int = 256
    # Dynamic range of the log-mel fingerprints (dB below their own max).
    fingerprint_top_db: float = 50.0        # one-shots
    loop_fingerprint_top_db: float = 80.0   # loops (grid-centred pooling, see audioutil)
    loop_fingerprint_frames_per_bar: int = 32

    # ---- loops -------------------------------------------------------------
    loop_silence_rms_db: float = -50.0
    loop_beat_silence_db: float = -55.0
    # A beat also counts as silent this far below the stem's median beat level
    # (catches decaying tails in breakdowns that sit just above -55 dBFS).
    loop_beat_silence_rel_db: float = -24.0
    loop_max_silent_beat_fraction: float = 0.5
    loop_fade_in_ms: float = 1.0
    loop_near_zero_db: float = -60.0        # first sample above this -> fade in

    # ---- events (fills, rolls, FX) -------------------------------------------
    # A beat is part of an event if its RMS is within this of the stem's peak...
    event_active_rel_db: float = -50.0
    event_silence_db: float = -70.0         # ...and above this absolute level
    event_merge_gap_beats: int = 2          # quieter gaps up to this long don't split an event
    event_min_peak_rel_db: float = -30.0    # skip events this far below the stem's loudest
    # An event starting this little before a bar line starts on that bar: Rubber Band
    # smears ~15 ms of pre-ring ahead of a transient, and early flams belong to the bar.
    event_preroll_ms: float = 30.0
    event_max_bars: int = 32                # longer regions are beds (atmos)...
    event_bed_bars: int = 8                 # ...cut into chunks of this many bars
    event_fade_ms: float = 5.0              # where an event is cut off from its neighbour
    # The event's body (what a riser builds to, a roll's last hit) ends with its last beat
    # within this of its loudest beat; the rest is tail. body_bars lets the generator end
    # risers and rolls exactly on a downbeat.
    event_body_rel_db: float = -12.0
    # An event's shape (events.shape): where its sound ends before the body's last bar line
    # (the producer's silence before the drop), where it peaks and which way it goes. A 16th
    # still sounds within this of the event's loudest 16th...
    punch_window_ms: float = 200.0          # a sample's punch: the level of its loudest window this long
    shape_sound_rel_db: float = -24.0
    # ...and it rises (falls) when it gets this much louder (quieter) from its first to its last
    # 16ths of sound, or this many octaves brighter (darker) in spectral centroid.
    shape_slope_db: float = 6.0
    shape_bright_oct: float = 0.7
    shape_peak_late: float = 0.75           # a rise peaks after this share of its sound...
    shape_peak_early: float = 0.25          # ...a fall before this share
    shape_hit_attack: float = 0.15          # a hit: loudest within this share, then dies away

    # ---- groove (groove.py): each loop's timing and accents per 16th ------------
    groove_hop: int = 128                   # onset detection hop
    groove_envelope_ms: float = 2.0         # trailing max window for the attack
    groove_attack_rel: float = 0.15         # attack = first rise through rel x the hit's peak
    groove_attack_search_ms: float = 30.0   # look this far past the onset for the hit's peak
    groove_min_level_db: float = -30.0      # ignore hits this far below the loop's loudest
    groove_max_dev: float = 0.45            # hits further than this (in 16ths) from a step are ignored
    groove_min_hits: int = 4                # fewer hits in the whole loop: no groove

    # ---- arrangement (arrangement.py): where each part plays in the source track ----
    arrangement_silence_db: float = -60.0   # a bar quieter than this is silent (absolute)
    arrangement_reference_pct: float = 90.0  # a part's "full" level: this percentile of its bars
    arrangement_quiet_rel_db: float = -20.0  # playing (quietly/filtered) within this of full...
    arrangement_full_rel_db: float = -6.0    # ...and full within this
    # Rides (bar by bar, per part): loudness against the part's full level, and brightness, the
    # power-weighted mean of log2(frequency) over these bands, against its median in full bars.
    arrangement_bands: int = 24
    arrangement_band_lo_hz: float = 40.0
    arrangement_band_hi_hz: float = 16000.0
    # The mix balance (K-weighted loudness of each part in its full bars, the app's reference
    # levels): unless the stems were normalised one by one, when this share of them (and at
    # least this many) peaks within this of full scale.
    arrangement_normalized_peak_db: float = -1.0
    arrangement_normalized_share: float = 0.8
    arrangement_normalized_min_stems: int = 3

    # ---- loose samples (samples.py): Splice and other packs ----------------------
    sample_loop_fit_s: float = 0.03         # a loop's length within this of whole bars (else a tail is cut)
    sample_loop_max_bars: int = 16          # longer files are not loops (stems belong in a zip)
    sample_oneshot_max_s: float = 4.0       # a file this short without loop hints is a one-shot

    # ---- strings (strings.py): a long string sample, restarting on every 8-bar line --------
    # The Splice scan (splice.py): a sound shorter than splice_min_len_s is a click, not a stab; a string
    # sound from splice_strings_min_len_s goes to the Strings page; a number in this range in a name is a tempo.
    splice_min_len_s: float = 0.15
    splice_strings_min_len_s: float = 3.0
    splice_ambience_min_len_s: float = 4.0  # a texture for the bed lies under a section: no shorter than this
    splice_stab_max_len_s: float = 12.0     # a one-shot or stab by name may ring this long (the import trims it to hit_max_len_s)
    splice_bpm_min: float = 70.0
    splice_bpm_max: float = 180.0
    strings_max_len_s: float = 60.0         # a dropped-in string sample keeps this much (a hit only hit_max_len_s)
    # The ambience bed (ambience.py): its loop's end crossfades into its start over this; loudness-matched like strings.
    ambience_xfade_s: float = 1.5
    ambience_lufs_target: float = -14.0
    ambience_peak_dbfs: float = -1.0
    # Tonal or not (ambience.tonality): the share of a texture's energy (in the band the bed is heard,
    # above its 200 Hz low cut) in narrow peaks `ambience_tonal_peak_db` over the spectrum around
    # them that hold for `ambience_tonal_hold_s`: a held note does, crackle, rain or a crowd flicker.
    # From `ambience_tonal_min` a texture is a tonal bed, with a key, moved into each track's key; below,
    # noise, never moved. (Measured: noise 0.00–0.03, tonal atmos 0.11–0.67, a pad under loud noise 0.5.)
    ambience_tonal_min: float = 0.06
    ambience_tonal_lo_hz: float = 200.0
    ambience_tonal_hi_hz: float = 5000.0
    ambience_tonal_peak_db: float = 10.0
    ambience_tonal_hold_s: float = 1.0
    ambience_tonal_env_hz: float = 170.0     # the width of the spectrum a peak stands out from
    ambience_tonal_quiet_pct: float = 30.0   # the quietest frames (gaps, fades) don't count…
    ambience_tonal_floor_db: float = 30.0    # …nor any this far under its loud frames (a tail, a gap of silence)
    ambience_tonal_max_s: float = 30.0       # measured over at most this much from the start
    ambience_max_shift: int = 6              # a tonal bed moves the nearest way into the key: never more than this
    # A texture with a rhythm (a guitar loop, a music loop, an atmos cut on the grid) has a tempo: a
    # number in its name in this range (an atmos cut: the library's). It is kept whole bars on import
    # (not trimmed to its sound) and its bed is stretched to the track tempo, repeating on the bar grid.
    ambience_loop_bpm_lo: float = 80.0
    ambience_loop_bpm_hi: float = 160.0
    strings_tail_fade_s: float = 0.02       # a sample ending before its part does fades out over this (no click)
    strings_fade_s: float = 0.25            # where a part cuts the sample (the next 8-bar line), it fades out over this
    strings_lufs_target: float = -14.0      # like the bass renders (the mix balance takes it from there)
    strings_peak_dbfs: float = -1.0

    # ---- vocals (vocal.py): a take's phrase loop and key ----------------------------
    vocal_hop: int = 256                    # pYIN / level frame hop at 22.05 kHz (≈ 11.6 ms)
    vocal_fmin_hz: float = 70.0
    vocal_fmax_hz: float = 1100.0
    vocal_period_min_s: float = 1.5         # a repetition is at least this long (a 1-bar line at 160 BPM)
    vocal_period_min_score: float = 0.45    # how well a take must line up with itself to have a phrase loop
    vocal_period_tie: float = 0.05          # lags this close to the best one are repetitions too (phrase loops)
    vocal_max_stretch: float = 0.2          # a phrase is stretched at most this much to whole bars
    vocal_silence_db: float = -30.0         # below the take's loudest by this: a rest
    vocal_rest_s: float = 0.15              # a line starts after a rest this long
    vocal_preroll_s: float = 0.02           # the phrase starts this much before its line (the consonant)
    vocal_fade_ms: float = 8.0
    # Splice vocal loops and phrases (vocalloop.py): their length, and how long splice.com may take
    # to answer whether a pack's link is right.
    vocal_loop_min_s: float = 1.5
    vocal_loop_max_s: float = 240.0          # (a pack's whole hook: its best 8 bars are the phrase)
    splice_link_timeout_s: float = 6.0
    vocal_loop_suggest_bpm: float = 8.0     # the Splice page suggests vocal loops this close to the library tempo

    # ---- mastering (master.py): the mixdown through Ozone 11 into mastered.wav -----
    # The master's loudness is set by its drops: its loudest `master_short_term_s` (short-term
    # LUFS, a DAW meter's "max S"). An integrated target let drops reach -5.5 and distort; at this
    # the whole track lands about -8 integrated (House of Tracks: -9 … -5).
    master_target_lufs: float = -6.8        # the loudest short-term loudness of mastered.wav
    master_short_term_s: float = 3.0        # BS.1770 short-term window
    master_ceiling_db: float = 0.0          # the Maximizer's output ceiling (House of Tracks: -2 … 0 dB); Lars's choice
    master_true_peak: bool = True           # the Maximizer's "Prevent intersample clipping": the ceiling holds between
                                            # the samples too (real mixdowns: +0.5 … +1.0 dBTP without, about 0 with)
    master_tolerance_lu: float = 0.1        # the Maximizer's gain is solved until the result is this close
    master_max_passes: int = 10             # passes through the chain to get there
    master_pre_lufs: float = -14.0          # the mixdown is brought here first: the chain sees one level
    master_glue_threshold_db: float = -12.0  # the glue compressor (Ozone Dynamics), against that level
    master_glue_ratio: float = 1.5
    master_glue_attack_ms: float = 30.0
    master_glue_release_ms: float = 120.0
    master_soft_clip_mix: float = 50.0      # % of the Maximizer's soft clip (less limiting for the loudness)

    # ---- mix profile (mixprofile.py): a whole mix measured, a render or a reference track ----
    # The regions its tone is given in (Hz edges): lows, low mids, mids, high mids, highs (the app's REGIONS).
    profile_region_edges_hz: tuple = (40.0, 150.0, 500.0, 2000.0, 6000.0, 16000.0)
    profile_low_hz: float = 150.0           # the kick's and the bass's region: "the lows"
    profile_mono_hz: float = 120.0          # under this the two sides should be one
    profile_full_pct: float = 90.0          # without sections: a bar is full within...
    profile_full_rel_lu: float = -3.0       # ...this of that percentile of the bars' loudness...
    profile_full_low_rel_db: float = -8.0   # ...with its lows within this of that percentile of the lows
    profile_drop_min_bars: int = 8          # a run of full bars this long is a drop...
    profile_drop_gap_bars: int = 1          # ...bridging gaps this long (a fill, a bar of silence)...
    profile_drop_before_bars: int = 4       # ...after this many bars that aren't full
    profile_lift_bars: int = 8              # a drop's first bars against as many before it
    profile_dj_bars: int = 16               # the mix-in and mix-out: the first and the last bars
    profile_pulse_share: float = 0.4        # a kick's lows sit in this first share of each beat
    profile_kick_pulse_db: float = 3.0      # a bar has a kick when its lows are this much stronger on the beats...
    profile_kick_low_rel_db: float = -24.0  # ...and within this of the full bars' lows (else it's only noise in the lows)
    profile_head_db: float = -60.0          # the first sample over this is where the sound starts
    profile_tail_ms: float = 10.0           # the file's end: its peak over these last ms
    profile_true_peak_oversample: int = 4
    profile_true_peak_window_db: float = 3.0  # only blocks peaking within this of the highest are oversampled

    # ---- pre-flight (preflight.py): the export's masters checked before they go out -----
    preflight_lufs_min: float = -9.0        # House of Tracks takes -9 … -5 LUFS integrated
    preflight_lufs_max: float = -5.0
    preflight_true_peak_max_db: float = 1.0  # between the samples: over this converters clip audibly
    preflight_limiter_max_db: float = 12.0  # peaks the master lost against its loudness (the mixdown's crest less the master's)
    preflight_lift_loss_lu: float = 1.5     # the master may take this much off a drop's lift
    preflight_lift_min_lu: float = 1.0      # a drop lands: this much louder than the bars before...
    preflight_lift_min_low_db: float = 3.0  # ...or this much more low end
    preflight_low_side_max_db: float = -12.0  # the sides under profile_mono_hz against the middle
    preflight_dc_max_db: float = -50.0
    preflight_head_max_ms: float = 30.0     # bar 1 starts sounding within this
    preflight_tail_max_db: float = -40.0    # the last ms: louder and the end is cut off
    preflight_pulse_min_db: float = 3.0     # a kick on every beat: the lows this much stronger on the beats
    preflight_dj_low_rel_db: float = -15.0  # ...and within this of the drops' lows
    preflight_key_confidence: float = 0.6   # a key read with less doesn't count against the label
    preflight_tone_off_db: float = 3.0      # a region is off: this far from the references' median and outside them all
    preflight_width_off_db: float = 4.0
    reference_min_tracks: int = 3           # fewer references: nothing is compared
    reference_bpm_min: float = 110.0        # the tempo a reference is searched in
    reference_bpm_max: float = 150.0

    # ---- peaks -------------------------------------------------------------
    peaks_oneshot_per_second: int = 200
    peaks_loop_per_bar: int = 1024


@dataclass
class Settings:
    library_path: str = ""
    genre: str = DEFAULT_GENRE              # the active genre: what imports are tagged with, what lists show
    splice_db: str = ""                     # Splice's sounds.db; "" = the desktop app's own (vocalloop.splice_dbs)
    library_bpm: float = 124.0
    bpm_min: float = 115.0
    bpm_max: float = 135.0
    max_stretch: float = 0.15
    integer_bpm: bool = True                # source tracks are always whole-number BPM
    output_sample_rate: int = 44100
    output_format: str = "pcm24"            # pcm24 | float32
    loop_lengths: dict[str, list[int]] = field(default_factory=_default_loop_lengths)
    max_oneshots_per_stem: int = 4
    max_loops_per_length: int = 6
    max_events_per_stem: int = 6
    oneshot_peak_dbfs: float = -0.3
    loop_norm_mode: str = "peak"            # peak | lufs
    loop_peak_dbfs: float = -1.0
    loop_lufs_target: float = -14.0
    event_peak_dbfs: float = -1.0
    oneshot_dedupe_threshold: float = 0.97
    loop_dedupe_threshold: float = 0.96
    event_dedupe_threshold: float = 0.96
    rubberband_binary: str = "rubberband"
    # R3 engine. Dropped automatically (with a warning) if the installed
    # Rubber Band is 2.x and doesn't know the flag.
    rubberband_options: list[str] = field(default_factory=lambda: ["--fine"])
    rubberband_r3_flag: str = "--fine"
    workers: int = 4                        # per-stem threads within one zip
    # Serum 2, hosted by the engine to render basslines (SCOPE.md §6.7).
    serum_plugin: str = "/Library/Audio/Plug-Ins/VST3/Serum2.vst3"
    serum_plugin_name: str = "Serum 2"
    # Ozone 11, hosted the same way to master the mixdown (master.py).
    ozone_dynamics_plugin: str = "/Library/Audio/Plug-Ins/VST3/Ozone 11 Dynamics.vst3"
    ozone_maximizer_plugin: str = "/Library/Audio/Plug-Ins/VST3/Ozone 11 Maximizer.vst3"
    thresholds: Thresholds = field(default_factory=Thresholds)

    # ---------------------------------------------------------------------
    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "Settings":
        """Build from the app's JSON (unknown keys are ignored)."""
        data = dict(data or {})
        th = data.pop("thresholds", None) or {}
        known = {f.name for f in dataclasses.fields(cls)}
        s = cls(**{k: v for k, v in data.items() if k in known})
        th_known = {f.name for f in dataclasses.fields(Thresholds)}
        s.thresholds = Thresholds(**{k: v for k, v in th.items() if k in th_known})
        if isinstance(s.thresholds.oneshot_rank_weights, list):
            s.thresholds.oneshot_rank_weights = tuple(s.thresholds.oneshot_rank_weights)
        s.genre = genre_or_default(s.genre)
        return s

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)

    def processing_hash(self) -> str:
        """Hash of everything that affects the generated samples."""
        d = self.to_dict()
        d.pop("library_path", None)
        d.pop("genre", None)
        d.pop("workers", None)
        blob = json.dumps(d, sort_keys=True, default=str).encode()
        return hashlib.sha1(blob).hexdigest()[:16]

    def loop_lengths_for(self, category: str) -> list[int]:
        return list(self.loop_lengths.get(category, []))
