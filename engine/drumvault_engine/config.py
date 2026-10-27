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

    # ---- peaks -------------------------------------------------------------
    peaks_oneshot_per_second: int = 200
    peaks_loop_per_bar: int = 1024


@dataclass
class Settings:
    library_path: str = ""
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
        return s

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)

    def processing_hash(self) -> str:
        """Hash of everything that affects the generated samples."""
        d = self.to_dict()
        d.pop("library_path", None)
        d.pop("workers", None)
        blob = json.dumps(d, sort_keys=True, default=str).encode()
        return hashlib.sha1(blob).hexdigest()[:16]

    def loop_lengths_for(self, category: str) -> list[int]:
        return list(self.loop_lengths.get(category, []))
