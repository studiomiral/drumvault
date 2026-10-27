# Drumvault engine (Phase 1)

Python 3.12 sidecar that turns stem zips into the drum sample library (SCOPE.md §5).
Setup and prerequisites: see `CLAUDE.md`.

```
uv sync
uv run pytest                                   # ~3.5 min; builds synthetic fixtures first
uv run python -m drumvault_engine cli process <zip_or_folder>... --library ./out --bpm 124
uv run python -m drumvault_engine cli analyze <zip> [--json]
uv run python -m drumvault_engine               # JSON-lines RPC on stdin/stdout
uv run python tests/make_fixtures.py ./fixtures # write the synthetic zips to look at / listen to
```

`cli process` also takes `--reprocess`, `--source-bpm`, `--grid-offset-ms`, `--key Fm`,
`--stem "Audio 07.wav=perc"`, `--lufs`, `--float32`, `--sample-rate 48000`, `--settings file.json`.
`cli delete <zip_id>` and `cli rebuild-loops` cover library maintenance.
Set `DRUMVAULT_FIXTURE_DIR=/some/dir` to cache fixtures between test runs.

## Modules

| Module | Role |
|---|---|
| `config.py` | `Settings` (user settings, §5.13) and `Thresholds` (every analysis constant) |
| `zipio.py` | extraction (nested zips one level deep, junk filtering, zip-slip safe), discovery |
| `classify.py` | filename rules (track-title prefixes ignored), audio fallback (HPSS ratio, decay, flatness, centroid) |
| `tempo.py` | kick onset envelope → autocorrelation → least-squares grid fit → snap / filename BPM → phase + confidence |
| `key.py` | essentia `KeyExtractor(profileType="edma")`, numpy/librosa chroma fallback |
| `stretch.py` | Rubber Band CLI wrapper (R3 `--fine` if available), resampling to the output rate |
| `oneshots.py` | onsets → sample-accurate starts → tail trim → rank → dedupe → hat open/closed split |
| `loops.py` | grid slicing, silence filter, dedupe, farthest-point cap, 1 ms fade-in only when needed |
| `normalize.py`, `peaks.py`, `naming.py`, `db.py` | output side (§5.9–5.12) |
| `pipeline.py` | one zip end to end; reprocess with overrides; delete; rebuild loops |
| `rpc.py`, `cli.py` | front ends (§5.14, §5.15) |
| `schemas.py` | pydantic RPC/result shapes, mirrored in `app/src/types/engine.ts` |

## Notes and deviations from SCOPE.md

- **Stretch ratio / phase (§5.7).** The spec defines `ratio = source_bpm / library_bpm` and
  then `new phase = phase / ratio`. With that ratio the stretched audio is `ratio` times as
  long, so the phase must be multiplied: `phase_out = phase_in * ratio` (`stretch.map_samples`).
- **Rubber Band R3 pre-echo.** R3 smears a kick's low end into a ~-20 dB pre-echo a few ms
  before the attack; the attack itself stays within 1 ms of the grid. The grid tests measure
  onsets at 30% of the local peak for that reason.
- **Loop silence (§5.8).** In addition to the absolute rules (RMS < -50 dBFS, > 50% of beats
  < -55 dBFS), a beat also counts as silent when it is more than 24 dB below the stem's median
  beat level (`loop_beat_silence_rel_db`). Without it, decaying tails at the start of a
  breakdown (e.g. a ride ringing out) produce "loops" that are mostly silence.
- **Fingerprints.** Log-mel fingerprints are level-invariant (dB relative to their own max)
  with a 50 dB range (`fingerprint_top_db`): with 80 dB, low-level stretch artefacts in the
  gaps between hits made identical bars look different. One-shots are compared over the
  frames both hits cover, so a hit cut short by the next onset dedupes with a full one.
- **Hit starts.** One-shots start 0.5 ms before the first sample reaching 10% of the hit's
  peak (trailing-max envelope, so the rise isn't moved early); when the previous hit's tail is
  still loud, the start is the envelope trough between the two.
- **Tempo onsets.** The onset envelope is librosa's onset strength over a log-RMS feature of
  the 150 Hz low-passed kick (mel spectral flux was too coarse); onsets are then refined to
  sample accuracy on the raw kick.
- **Key fallback profiles.** With librosa CQT chroma, Temperley's profiles found the tonic on
  the fixtures where EDMA-shaped weights picked the subdominant; `key_fallback_profile` selects
  either. essentia (EDMA) is the primary backend and installs from wheels on macOS arm64.
- **Classification fallback.** HPSS alone calls tonal percussion (congas, kicks) harmonic, so
  the classifier also measures how far each hit decays 100 ms after its onset. Bright content
  (centroid > 4 kHz: rides, risers) is never called melodic.
- **Track titles in stem names.** A token prefix/suffix shared by all (≥ 3) stems of a zip is
  ignored by the filename rules, so "Deep Groove - Bass" is a bass, not a groove.
- **Extras.** RPC also has `analyze_zip` and `shutdown`, emits a `ready` event at startup, and
  `job_done` carries the full result. Job statuses add `skipped` and `cancelled`.
- **Per-stem work** runs in a thread pool (`workers`, default 4); Rubber Band runs as
  subprocesses, so stretching parallelises.
