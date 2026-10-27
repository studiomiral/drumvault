# Drumvault — Project Scope

> Working title. A personal macOS desktop app that turns zips of dance-track stems into a tempo-matched, key-labeled **drum** sample library, plus a minimal timeline DAW to arrange those drums and export full-length drum stems for finishing in Logic Pro.

**Owner / only user:** Lars (personal use — no distribution, no licensing concerns, no code signing required).
**Target machine:** MacBook Pro M1 Pro (Apple Silicon), 32 GB RAM, macOS Tahoe.
**Downstream DAW:** Logic Pro.

---

## 1. Goals

1. Drag one or many `.zip` files of stems into the app.
2. Automatically keep only **drum stems**, analyse them, and write finished samples into **one target library folder**:
   - **One-shots** (unstretched) from single-sound stems: kick, snare, clap, hats, rides, perc, etc.
   - **Loops**, time-stretched to a single library BPM: hats, perc, shakers, tops, grooves, full drum loops.
   - **FX & fills** ("events"), time-stretched like loops and cut on the bar grid: drum fills, snare rolls, risers, downlifters, impacts, sweeps, atmos.
3. **BPM** is detected on the zip's **kick stem** and applied to every stem in that zip.
4. Every sample is labeled with the **source track key**, detected from the zip's melodic stems (which are then discarded).
5. Normalize, deduplicate, name, and index all samples in a searchable library.
6. A **mini DAW**: lanes on a bar grid, drag samples from the library, arrange a full track structure, play it back, and **export one full-length WAV per lane**, all starting at bar 1, ready to drop into Logic.

## 2. Non-goals (explicitly out of scope)

- Melodic samples (bass, synths, vocals). Melodic stems are only used for key detection, never exported. Vocals (including "Vocal FX") are ignored.
- Effects, automation, MIDI, recording, plugins (VST/AU) in the DAW. One exception (Phase 5): a per-clip low-pass/high-pass filter, fixed or swept over the clip, for filtered kicks and filter builds.
- Real-time time-stretching or pitch-shifting in the DAW. The DAW plays samples at native speed at the library BPM.
- Windows/Linux support, auto-updates, code signing, notarization, multi-user anything.
- Stem separation (Demucs etc.) — inputs are already separate stems.

---

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Electron** + TypeScript | Chromium Web Audio is consistent and reliable; familiar JS/TS world |
| UI | **React + Vite** + TypeScript, Tailwind CSS | Lightweight; Next.js is unnecessary inside Electron |
| State | Zustand (+ immer) | Simple, works well for timeline state + undo/redo |
| Audio playback (DAW) | Web Audio API in the renderer | Sample-accurate scheduling, OfflineAudioContext for export |
| Analysis/processing engine | **Python 3.12 sidecar**, managed with **uv** | Best audio tooling |
| Python libs | numpy, scipy, soundfile, librosa, essentia (key), pyloudnorm (optional) | |
| Time-stretch | **Rubber Band** CLI (macOS: `brew install rubberband`; Linux cloud: `apt-get install rubberband-cli`), called via subprocess | Best quality available; GPL is fine for personal use |
| Library index | **SQLite** (WAL mode); Python writes, Electron reads via Node's built-in `node:sqlite` (read-only) | No native module to rebuild for Electron (originally planned: better-sqlite3) |
| Engine ↔ app | JSON-lines RPC over the sidecar's stdin/stdout | No ports, no servers |

Startup check: the app verifies `rubberband` and the Python environment exist and shows a clear setup message if not.

If `essentia` won't install cleanly on Apple Silicon, use the fallback key detector described in §5.5 (chroma + EDM key profiles in numpy). Keep key detection behind one interface so either backend can be used.

---

## 4. Repository structure

```
drumvault/
├── CLAUDE.md
├── SCOPE.md
├── app/                          # Electron + React
│   ├── package.json
│   ├── electron/
│   │   ├── main.ts               # window, menus, IPC handlers
│   │   ├── preload.ts            # typed contextBridge API
│   │   ├── sidecar.ts            # spawn + JSON-lines RPC client for the Python engine
│   │   ├── db.ts                 # read-only node:sqlite access to the library
│   │   └── fs.ts                 # export writing, folder pickers, settings file
│   └── src/
│       ├── main.tsx
│       ├── views/
│       │   ├── ProcessView.tsx   # drop zone + job queue + zip detail/review
│       │   ├── LibraryView.tsx   # browser/auditioning
│       │   └── ArrangeView.tsx   # mini DAW
│       ├── audio/
│       │   ├── engine.ts         # transport, scheduler, buffer cache
│       │   ├── render.ts         # OfflineAudioContext export
│       │   └── wav.ts            # 24-bit / 32-bit float WAV encoder
│       ├── daw/                  # timeline components, lanes, clips, pattern editor
│       ├── store/                # zustand stores (settings, library, project, undo)
│       └── types/                # shared TS types (mirror of engine schemas)
└── engine/                       # Python sidecar
    ├── pyproject.toml
    ├── drumvault_engine/
    │   ├── __main__.py           # entry: `rpc` mode (default) or `cli` mode
    │   ├── rpc.py                # JSON-lines server, job queue, progress events
    │   ├── cli.py                # standalone CLI for phase 1 + debugging
    │   ├── config.py             # settings dataclass + defaults
    │   ├── zipio.py              # extraction, file discovery, junk filtering
    │   ├── classify.py           # stem classification (filename rules + audio fallback)
    │   ├── tempo.py              # kick-based BPM + grid detection
    │   ├── key.py                # source-track key detection
    │   ├── stretch.py            # Rubber Band wrapper
    │   ├── oneshots.py           # hit detection, selection, trimming, dedupe
    │   ├── loops.py              # grid slicing, silence filter, dedupe
    │   ├── normalize.py
    │   ├── peaks.py              # waveform peak data for UI
    │   ├── naming.py             # filenames + folder routing
    │   ├── db.py                 # SQLite schema + writes
    │   └── pipeline.py           # orchestrates one zip end to end
    └── tests/
        ├── make_fixtures.py      # generates synthetic stem zips with known BPM/key
        └── test_*.py
```

---

## 5. Processing engine (Python)

### 5.1 Pipeline per zip

```
zip → extract to temp dir → discover audio files → classify stems
    → detect BPM + grid (kick stem) → detect key (melodic stems)
    → one-shots from ORIGINAL (unstretched) single-sound stems
    → stretch drum + event stems to library BPM → slice loops / cut events on the grid
    → filter silence → dedupe → normalize → write files → peaks → index in DB
    → clean temp dir
```

Jobs are processed one zip at a time (queue). Within a zip, per-stem work may use a process pool. Each stage emits progress events.

A zip is identified by a **SHA-1 of the zip file**. Re-dropping an already processed zip is skipped unless the user chooses "Reprocess".

### 5.2 Extraction & discovery (`zipio.py`)

- Support nested folders and nested zips (one level deep).
- Ignore `__MACOSX/`, `._*`, `.DS_Store`, and hidden files.
- Accept `.wav`, `.aif`, `.aiff`, `.flac`. Skip `.mp3`/others with a warning in the job log.
- Load as float32; keep native sample rate during analysis. Stereo is preserved for output; analysis uses a mono downmix.
- Warn (not fail) if stem lengths differ by more than 1 bar's worth of samples — this suggests they weren't exported from bar 1.

### 5.3 Stem classification (`classify.py`)

**Step 1 — filename rules** (case-insensitive, word-boundary-aware, checked in this priority order so "Bass Drum" isn't caught as bass, "Snare Roll" is a roll and "Vocal FX" stays ignored):

| Category | Keywords |
|---|---|
| `ignore` (vocals, checked first) | vox, vocal, vocals, voice, acapella |
| `roll` | roll, snare roll, drumroll, snare build (whole word: "Rolling Bass" is not a roll) |
| `fill` | fill, drum fill (whole word) |
| `fx_riser` | riser, rise, uplifter, upsweep, build up |
| `fx_downlifter` | downlifter, downsweep |
| `fx_impact` | impact, sub drop, boom, explosion |
| `fx_sweep` | sweep, whoosh, noise, white noise, reverse (so "Reverse Crash" is FX, not a cymbal) |
| `fx_atmos` | atmos, atmosphere, ambience, texture |
| `fx` | fx, sfx, effect, effects |
| `kick` | kick, kik, bd, bassdrum, bass drum |
| `clap` | clap, cp, handclap |
| `snare` | snare, sd, rim, rimshot |
| `hat_closed` | closed hat, ch, chh, hihat closed |
| `hat_open` | open hat, oh, ohh |
| `hat` | hat, hats, hh, hihat, hi-hat |
| `ride` | ride |
| `cymbal` | crash, cymbal, china, splash |
| `shaker` | shaker, shake, tamb, tambourine, maracas |
| `perc` | perc, percussion, conga, bongo, tom, cowbell, clave, wood, block, timbale |
| `top` | top, tops, top loop |
| `groove` | groove, grooves |
| `drums` | drums, drum, drum bus, drumbus, beat, loop (only if no melodic keyword) |
| `melodic` (key only) | bass, sub, synth, lead, pad, chord, chords, keys, piano, stab, pluck, arp, organ, string, music, melody |
| `full_mix` (key fallback) | master, mix, full, mixdown |
| `ignore` | reverb return, send |

**Step 2 — audio fallback** for files that match no rule: compute harmonic/percussive energy ratio (librosa HPSS), spectral flatness, and onset density. Clearly percussive → `drums` (or a more specific category if the spectral centroid strongly suggests kick or hats); clearly harmonic → `melodic`; otherwise `ignore`. Mark these stems `auto_classified = true` so the UI can highlight them for review.

The user can override any stem's category in the UI and reprocess the zip.

### 5.4 Tempo & grid (`tempo.py`)

Source: the zip's `kick` stem. Fallback order if missing: `drums` → `clap`/`snare` → `full_mix` → sum of all stems. Fallbacks reduce the confidence score.

Algorithm:
1. Mono, low-pass ~150 Hz, onset envelope (librosa), pick strong onsets with backtracking for precise attack times.
2. Rough BPM from the onset envelope via autocorrelation, constrained to the configured range (default **115–135 BPM**) to avoid half/double errors.
3. **Refine** by fitting a linear grid `t_n = phase + n · period` to the onset times (nearest-beat assignment + least squares, iterate 2–3×).
4. Source tracks are always whole-number BPM: round the refined BPM to the nearest integer. If it was more than ±0.05 away from that integer, flag `needs_review` (the detection is suspect) unless a filename BPM confirms it. (Configurable: `integer_bpm`.)
5. If the zip name or any stem filename contains a BPM (regex `(\d{2,3}(?:\.\d+)?)\s?bpm`, case-insensitive) within ±1 of the detected value, use the filename BPM.
6. **Grid phase / bar 1**: assume stems were exported from bar 1 (sample 0 = downbeat). Validate: if the fitted phase is within ±15 ms of 0 modulo one beat, use phase = 0. Otherwise check the other drum stems first: if their hits (median) sit within ±15 ms of a 16th grid from sample 0, the export does start at bar 1 and only the kick is late (a slow attack or a nudged sample): keep phase = 0 and note it. Only when the other drums are offset too, use the first strong kick onset as the downbeat and flag `grid_warning`. (A late kick taken as bar 1 cuts every loop late, so they flam against loops from other zips.)
7. **Confidence** = fraction of strong onsets within ±10 ms of the grid. Logged only: it never flags a zip or shows in the UI. The detected BPM is trusted; Lars overrides it when it's wrong.

Output: `{bpm, phase_samples, confidence, source_stem, warnings[]}`.

User override in the UI: BPM and grid offset (in ms or beats) → reprocess.

### 5.5 Source-track key (`key.py`)

- Input: all stems classified `melodic`, summed. If none, use `full_mix`. If neither exists → key = `null` (filename label `NoKey`).
- Weight bass stems ×1.5 in the sum (house keys are most clearly defined by the bassline).
- Primary: essentia `KeyExtractor` with `profileType="edma"` (tuned for electronic dance music).
- Fallback (if essentia unavailable): librosa CQT chroma, averaged over non-silent frames, matched against EDM-style major/minor key profiles (correlation over all 24 rotations).
- Output: `{key: "A", scale: "minor", label: "Am", camelot: "8A", confidence}`. Below 0.5 confidence → still store, but mark `key_uncertain` (UI shows it with a "?" badge).
- User can override the key in the UI.
- The detected key is applied to **every sample** from that zip.

### 5.6 One-shots (`oneshots.py`)

**From the original, unstretched audio** — never time-stretch one-shots.

Source stems: `kick`, `clap`, `snare`, `hat`, `hat_closed`, `hat_open`, `ride`, `cymbal`, `shaker`, `perc`. Not from `top`, `groove`, or `drums` (too many overlapping sounds).

Steps:
1. Onset detection with backtracking.
2. Each candidate hit runs from its onset to the next onset (or end of file).
3. Discard candidates shorter than the minimum length for the category (defaults: kick 200 ms, snare/clap 200 ms, hat_closed 50 ms, hat_open 150 ms, ride 300 ms, cymbal 500 ms, perc/shaker 60 ms).
4. **Trim the tail** at −60 dBFS relative to the hit's peak, or at the next onset if sooner. Apply a 5 ms fade-out; no fade-in (preserve the transient). Cap length at 2 s (cymbals 4 s).
5. Prefer "clean" hits: rank by (a) gap to the next onset, (b) peak level, (c) low pre-onset energy (nothing bleeding in).
6. **Dedupe**: fingerprint each hit (log-mel spectrogram of the first 150 ms, flattened and L2-normalized). Hits with cosine similarity > 0.97 are the same sound; keep the best-ranked one.
7. Within `hat`-category stems, split into `hat_closed` / `hat_open` by decay length (−40 dB decay time > 150 ms → open).
8. Keep at most **N distinct one-shots per stem** (default 4).

### 5.7 Stretching (`stretch.py`)

- Applies to drum stems used for loops only.
- Stretch the **whole stem once**, before slicing, so loop boundaries stay sample-exact and no edge artifacts appear.
- Ratio = `source_bpm / library_bpm`. After stretching, the new phase = `phase_samples / ratio` (rounded).
- Rubber Band CLI, R3 engine (`--fine`), tempo-only (pitch preserved). Verify flags against `rubberband --help` of the installed version and keep options configurable in `config.py`.
- If `|1 − ratio|` > the max stretch setting (default **15%**), skip loops for this zip, still extract one-shots, and flag `needs_review`.
- If ratio == 1.0 exactly, skip stretching.
- Resample to the output sample rate (default 44.1 kHz) at this stage if needed.

### 5.8 Loops (`loops.py`)

Source stems and default loop lengths (in bars, configurable):

| Category | Loops? | Default lengths |
|---|---|---|
| kick | no (one-shots only) | — |
| snare, clap | yes | 2, 4 |
| hat, hat_closed, hat_open, ride, shaker, perc | yes | 1, 2, 4 |
| top, groove, drums | yes | 2, 4, 8 |
| cymbal | no | — |

Steps:
1. Bar length in samples = `round(sr · 60 / library_bpm · 4)`. Slice positions = `phase + k · bar_len · length` for k = 0, 1, 2, …, with **non-overlapping** slices per length.
2. **Silence filter**: drop a slice if RMS < −50 dBFS, or if more than 50% of its beats are silent (per-beat RMS < −55 dBFS). This removes breakdowns where the part drops out.
3. **Dedupe** per stem and length: fingerprint = log-mel spectrogram (coarse time resolution, e.g. 32 frames per bar), L2-normalized. Cosine similarity > 0.96 → duplicate; keep the first occurrence. This is the step that turns 40 copies of the same 4 bars into 1–5 real variations.
4. Optional per-stem cap: max loops per length (default 6), keeping the most mutually distinct ones (greedy farthest-point selection on fingerprints).
5. Loops are cut exactly on the grid with **no fades** (they must loop seamlessly). Only if the first sample is not near zero, apply a 1 ms fade-in to prevent a click; never fade the end.

### 5.8a Events: fills, rolls and FX (`events.py`)

Stems in the categories `fill`, `roll` and `fx_*` / `fx` are mostly silent with a sound every few bars (a fill before the drop, an 8-bar riser, a downlifter after it). Each sound becomes one sample that starts on the bar line where it begins, so it drops onto the timeline exactly where it sat in the source track.

1. The whole stem is stretched to the library BPM first (as for loops, §5.7). If the stretch exceeds the max stretch setting, events are skipped like loops.
2. A beat is *active* if its RMS is within −50 dB of the stem's peak (and above −70 dBFS). Active beats separated by ≤ 2 quieter beats form one region.
3. The event starts on the bar line at or before the region's first sample above that level. A start within **30 ms before a bar line** belongs to that bar (Rubber Band smears ~15 ms of pre-ring ahead of a transient; early flams belong to the bar).
4. The event runs for **whole bars, tail included** (an 8-bar roll that rings into the next bar is a 9-bar sample), so it works as an audio clip on the grid. If a neighbouring event shares its first or last bar, that part is silenced with a 5 ms fade.
5. Regions longer than 32 bars (atmos beds) are cut into 8-bar chunks.
6. Skip events quieter than −30 dB relative to the stem's loudest. **Dedupe**: same fingerprint as loops (per bar), only events of equal length compared, cosine > 0.96 = duplicate, first occurrence kept. Cap: 6 per stem (farthest-point selection).
7. Peak normalize to −1.0 dBFS. Key label, BPM and bar count are stored like loops.

Events are not one-shots: they are time-stretched, because they must line up with the bar grid at the library BPM.

### 5.9 Normalization (`normalize.py`)

- One-shots: peak normalize to **−0.3 dBFS**.
- Loops: peak normalize to **−1.0 dBFS**.
- Optional setting: loudness mode for loops (pyloudnorm, target −14 LUFS short-term, with a peak ceiling of −1 dBFS).
- Store both the original peak and the applied gain in the DB.

### 5.10 Output format, naming & folders (`naming.py`)

- Format: **WAV, 24-bit, 44.1 kHz** by default (settings: 44.1/48 kHz; 24-bit/32-bit float). Stereo stays stereo; mono stays mono.
- Source ID: `S` + 4-digit incrementing zip number (e.g. `S0037`), plus a short slug of the zip name (max 20 chars, ASCII, dashes).

Folder layout in the target library folder:

```
<Library>/
├── One-Shots/
│   ├── Kicks/ Snares/ Claps/ Hats-Closed/ Hats-Open/ Rides/ Cymbals/ Shakers/ Perc/
├── Loops/
│   ├── Snares-Claps/ Hats/ Rides/ Shakers/ Perc/ Tops/ Grooves/ Full-Drums/
├── Fills/
│   ├── Drum-Fills/ Snare-Rolls/
├── FX/
│   ├── Risers/ Downlifters/ Impacts/ Sweeps/ Atmos/ Other/
└── .drumvault/
    ├── library.sqlite
    └── peaks/<sample_id>.json
```

Filenames:
- One-shot: `OS_Kick_Am_S0037-deep-groove_01.wav`
- Loop: `LP_Top_124_Am_S0037-deep-groove_4bar_03.wav`
- Fill / roll: `FL_Roll_124_Am_S0037-deep-groove_9bar_01.wav`
- FX: `FX_Riser_124_Am_S0037-deep-groove_8bar_01.wav`
- Unknown key: `NoKey` in place of the key.

Keeping the database inside the library folder makes the library self-contained and portable (back it up, move it to another drive).

### 5.11 Peaks (`peaks.py`)

For every written sample, store min/max peak pairs at ~200 points per second for one-shots, and at a fixed 1024 points per bar for loops, as JSON. The UI never decodes full audio just to draw waveforms.

### 5.12 Database schema (`db.py`)

```sql
CREATE TABLE zips (
  id INTEGER PRIMARY KEY,
  source_code TEXT UNIQUE,          -- "S0037"
  file_name TEXT, file_sha1 TEXT UNIQUE, original_path TEXT,
  detected_bpm REAL, bpm_override REAL, bpm_source_stem TEXT,
  phase_samples INTEGER, grid_offset_override_ms REAL, tempo_confidence REAL,
  key_label TEXT, key_camelot TEXT, key_confidence REAL, key_override TEXT,
  status TEXT,                      -- queued|processing|done|needs_review|error
  reviewed INTEGER DEFAULT 0,       -- "Mark as reviewed": stays done when reprocessed (schema v2)
  warnings TEXT,                    -- JSON array
  processed_at TEXT, settings_hash TEXT
);

CREATE TABLE stems (
  id INTEGER PRIMARY KEY,
  zip_id INTEGER REFERENCES zips(id) ON DELETE CASCADE,
  file_name TEXT, category TEXT, category_override TEXT,
  auto_classified INTEGER, duration_s REAL, sample_rate INTEGER, channels INTEGER,
  used_for TEXT                     -- JSON: ["tempo","key","oneshots","loops"]
);

CREATE TABLE samples (
  id INTEGER PRIMARY KEY,
  zip_id INTEGER REFERENCES zips(id) ON DELETE CASCADE,
  stem_id INTEGER REFERENCES stems(id) ON DELETE CASCADE,
  kind TEXT,                        -- oneshot|loop|event
  category TEXT,                    -- kick|snare|clap|hat_closed|...|top|groove|drums
  rel_path TEXT UNIQUE,             -- relative to the library root
  bpm REAL,                         -- library BPM for loops, NULL for one-shots
  bars INTEGER,                     -- loops and events (events include their tail)
  body_bars INTEGER,                -- events: bars until the main sound ends (schema v2)
  key_label TEXT, key_camelot TEXT,
  duration_s REAL, sample_rate INTEGER, channels INTEGER,
  peak_db REAL, gain_applied_db REAL,
  source_offset_s REAL,             -- position in the original stem
  fingerprint BLOB,                 -- for dedupe + "similar sounds"
  favorite INTEGER DEFAULT 0, rating INTEGER, tags TEXT,
  created_at TEXT
);

CREATE INDEX idx_samples_cat ON samples(kind, category);
CREATE INDEX idx_samples_key ON samples(key_label);
```

Reprocessing a zip deletes that zip's samples (files + rows) and regenerates them. `favorite`, `rating` and `tags` should survive reprocessing where a regenerated sample matches an old one by stem + offset + length.

### 5.13 Settings (`config.py`, persisted by the app as JSON in the app-data folder)

| Setting | Default |
|---|---|
| Library folder | (must be chosen on first run) |
| Library BPM | 124 |
| BPM search range | 115–135 |
| Max stretch | 15% |
| Output sample rate / bit depth | 44.1 kHz / 24-bit |
| Loop lengths per category | see §5.8 |
| Max one-shots per stem | 4 |
| Max loops per stem per length | 6 |
| One-shot peak target | −0.3 dBFS |
| Loop normalization | peak −1.0 dBFS (or LUFS mode) |
| Dedupe thresholds | one-shots 0.97, loops 0.96 |
| Rubber Band options | `--fine` |

**Changing the library BPM** requires reprocessing loops and FX & fills (one-shots stay). The UI offers a "Rebuild loops at new BPM" action that reruns stretching, slicing and event cutting for all zips. The original zips must still be available (store `original_path`; warn if missing).

### 5.14 RPC protocol (`rpc.py`)

JSON lines on stdin/stdout; logs go to stderr only.

Requests from the app:
```json
{"id": "uuid", "method": "process_zip", "params": {"path": "...", "settings": {...}}}
{"id": "uuid", "method": "reprocess_zip", "params": {"zip_id": 12, "overrides": {"bpm": 123, "key": "Fm", "stems": {"34": "perc"}}}}
{"id": "uuid", "method": "delete_zip", "params": {"zip_id": 12, "delete_files": true}}
{"id": "uuid", "method": "rebuild_loops", "params": {"settings": {...}}}
{"id": "uuid", "method": "cancel", "params": {"job_id": "..."}}
{"id": "uuid", "method": "grid_preview", "params": {"zip_id": 12, "settings": {...}}}
{"id": "uuid", "method": "health", "params": {}}
```

Responses and events from the engine:
```json
{"id": "uuid", "result": {...}}
{"id": "uuid", "error": {"code": "...", "message": "..."}}
{"event": "progress", "job_id": "...", "zip": "...", "stage": "tempo", "pct": 0.4, "message": "Kick: 124.00 BPM (conf 0.97)"}
{"event": "job_done", "job_id": "...", "zip_id": 12, "status": "done", "counts": {"oneshots": 18, "loops": 41}}
```

`grid_preview` is not queued behind imports (it runs on its own thread) and answers directly: it sums the zip's drum stems to one mono 16-bit WAV at `grid_preview_sr` in `.drumvault/grid/<zip_id>.wav` and returns its path, sample rate, duration, the zip's BPM, the bar 1 the library is cut on (`bar_one_ms`, and `manual` if it was set by hand) and the stem names. The app reads the file and deletes it. A negative `grid_offset_ms` (hits ahead of the first downbeat) starts the grid one bar later, so cuts never begin before sample 0.

### 5.15 CLI (`cli.py`) — needed for Phase 1

```
uv run python -m drumvault_engine cli process <zip_or_folder>... --library ./out --bpm 124
uv run python -m drumvault_engine cli analyze <zip>        # prints classification, BPM, key; writes nothing
```

---

## 6. Desktop app (Electron + React)

### 6.1 Layout

A single window with a left nav: **Process**, **Library**, **Grid**, **Generate**, **Arrange**. The Library browser also appears as a collapsible side panel inside Arrange. The UI uses a dark matte theme modelled on the NeuroNest dashboard reference: charcoal surfaces with thin borders and large rounded cards, a grouped sidebar (Samples: Process, Library, Grid · Create: Generate, Arrange · Settings: Settings, Shortcuts) with the library and engine status at the bottom, pastels for kinds (blue one-shots, mint loops, lavender FX & fills), and a subtle yellow accent for primary actions and selection. Process opens with a gradient hero banner beside the drop box. Page titles in the top bar are heavy display capitals (Bricolage Grotesque ExtraBold). The Drumvault name, the Process banner and dialog titles use a book serif (Newsreader); the UI uses a grotesk (Hanken Grotesk). All fonts are bundled locally.

### 6.2 Process view

- A large drop zone; it accepts multiple zips or a folder (all zips inside it are found recursively).
- A job queue list: zip name, status chip, progress bar with the current stage, detected BPM + confidence, key, and sample counts.
- Clicking a zip opens a detail panel:
  - Stem table: filename, category (dropdown to override), an "auto" badge if auto-classified, and which roles the stem was used for.
  - BPM/grid: detected value, source stem, override field, and a grid-offset nudge.
  - Key: detected value, confidence, override dropdown.
  - Warnings.
  - Buttons: **Reprocess**, **Align grid** (opens the Grid view, §6.2a), **Mark as reviewed** (needs-review zips: the warnings are fine; the zip counts as done, also after reprocessing), **Delete samples from library**, **Reveal in Finder**.
- A filter for `needs_review` zips.
- Adding zips whose file name is already in the library, already queued, or twice in one drop opens a warning listing them, with **Skip duplicates** / **Add anyway** / **Cancel** (identical contents are skipped by the engine anyway; this catches re-downloads).
- Processing continues while the user is in another view.

### 6.2a Grid view

Sets bar 1 of one zip by ear and eye. All stems of a zip share one timeline (they are never offset from each other), so one offset fits the whole zip.
- A zip picker in the top bar (opens on the first needs-review zip; **Align grid** in the zip panel opens a specific one), with the BPM and number of drum stems.
- **Waveform:** all drum stems summed (engine `grid_preview`), under a fixed grid of bars, beats and 16ths with bar numbers. Dragging the waveform moves the stems against the grid (⇧ for fine moves); ⌘-scroll or pinch zooms around the pointer down to single samples; clicking the ruler or the waveform sets the playhead, which follows playback.
- **Every beat stacked:** the envelope of every beat folded onto one (±15 ms, ±50 ms or a whole beat), with the grid line in the centre and a readout of how far the hits are early or late. Dragging here moves bar 1 precisely.
- **Transport:** Space plays the stems with a metronome on the grid (accent on the downbeat), M toggles the metronome, separate click and drums levels. Clicks not yet heard are rescheduled when bar 1 moves, so a drag is audible straight away.
- **Bar 1:** the offset in ms with −10/−1/+1/+10 nudges (← → and ⇧← ⇧→ too), **Snap to hits** (moves bar 1 to the stacked hits' attack), **Revert**, **Apply & re-cut** (reprocesses the zip with `grid_offset_ms`) and **Use detected** (drops a hand-set bar 1).

### 6.3 Library view

- Filters: kind (one-shot / loop / FX & fills), category, key (multi-select, plus "compatible keys" via Camelot neighbors), bars, source zip, favorites, and text search on filename/tags.
- A virtualized list (thousands of rows): waveform thumbnail from peaks, name, category, key, bars, a favorite star, and a rating.
- **Audition**: click or Space plays the sample, ↑/↓ moves to the next sample and plays it, Esc stops. Loops repeat while auditioning. When the Arrange transport is playing, an auditioned loop starts on the next bar, in sync.
- "Find similar" action: nearest neighbors by fingerprint within the same category.
- Drag a sample out to Finder or Logic (Electron `startDrag`) as a bonus.

### 6.4 Arrange view (mini DAW)

**Project model**
- Project BPM = library BPM (fixed per project, shown read-only).
- Time signature: 4/4 only.
- Length in bars (default 192, editable).
- Saved as JSON `.dvproj` files (default folder `<Library>/.drumvault/projects/`), with autosave.

**Lanes**
- Default lanes: Kick, Clap, Snare, Hats, Perc, Tops, Groove. The user can add, rename, reorder, color (click the colour strip for a palette), and delete lanes.
- Per lane: volume (dB, a bar filled to the level: click/drag to set, double-click for 0 dB), mute, solo, and pan (same bar, filled from the centre).
- **Each lane exports as one stem.**

**Clip types**
1. **Audio clip** (loops): placed on the bar grid. Dragging the right edge extends the clip by repeating the loop (a whole number of loop lengths, or any bar count, ending mid-loop is allowed). Per-clip gain. Optional left trim in whole beats.
   FX & fills (events) also become audio clips: placed at a bar, they play once over their length; extending one repeats it like a loop.
2. **Pattern clip** (one-shots): references 1 one-shot sample and holds a step grid of 16 steps per bar, pattern length 1, 2 or 4 bars, and 3 velocity levels per step. A pattern clip repeats when extended, like an audio clip. Double-click opens a step editor beneath the timeline. Quick presets: "4 on the floor", "offbeat", "every 2 & 4".

**Editing**
- Snapping follows the zoom: moves and resizes snap to the finest division at least 14 px wide (several bars zoomed far out, bars at the default zoom, then beats, 8ths and 16ths zoomed in close). Hold ⌥ to snap four times finer, down to 16ths.
- Select, multi-select (drag a marquee or ⇧-click), move, copy (⌥-drag), R or ⌘D duplicate (places the copy right after), Delete.
- ⌘Z / ⇧⌘Z undo/redo (command-pattern history in the store, minimum 100 steps).
- **Section markers**: named ranges (Intro, Build, Drop, Break, Breakdown, Outro, custom), drawn in a band above the ruler. Click an empty spot to add an 8-bar section (or up to the next one), or drag to set its range; a name box opens right away with quick picks. Double-click a marker to rename or delete it. Clicking a marker selects all clips in that range, enabling a "duplicate section" workflow. Generated arrangements arrive with their sections named.
- Horizontal zoom (pinch / ⌘ + scroll) and scroll; vertical lane height adjustment.
- Rendering performance: the timeline uses a single canvas (or virtualized DOM) and must stay smooth at 192 bars × 10 lanes × ~200 clips.

**Transport**
- Space = play/stop, click on the ruler = move the playhead, a loop region (drag on the ruler), an optional metronome, a bar.beat position display, and the playhead time next to the total length (m:ss.t / m:ss).
- Playback starts within 50 ms of pressing play.

**Audio engine** (`audio/engine.ts`)
- AudioBuffer cache (LRU, ~1.5 GB cap) decoded from the library files via `file://` reads routed through the preload.
- Lookahead scheduler: a 25 ms timer tick schedules everything in the next 120 ms with `AudioBufferSourceNode.start(when, offset, duration)`.
- Graph: source → clip gain → lane gain/pan → master gain → destination.
- Playback must be sample-accurate: no drift over 192 bars.

### 6.5 Export

- An **Export Stems** dialog: export folder, file name prefix (default = project name), range (whole project or loop region), format (24-bit or 32-bit float WAV, sample rate = library rate), and checkboxes per lane plus an optional **Master** (all lanes).
- Rendering: one `OfflineAudioContext` per lane, from bar 1 to the end bar; the same scheduling logic as live playback (shared code, not duplicated). Muted lanes are skipped; solo is ignored.
- All exported files have **identical length** and start exactly at bar 1, so in Logic you import them at bar 1, set the project to the same BPM, and everything lines up.
- File names: `<Prefix>_<LaneName>_<BPM>bpm.wav`.
- Clipping check: if any lane peaks above 0 dBFS in 24-bit mode, warn and offer 32-bit float or auto-gain.
- Also export `<Prefix>_markers.mid`: a MIDI file containing the tempo and section markers, which can be imported into Logic to get the markers. (Phase 4 nice-to-have.)
- "Reveal in Finder" after export.
- *Implementation notes:* event start times and sample offsets are snapped to whole sample frames, so a stem is a bit-exact copy of the placed samples (live playback uses the same snapping). Lane gain nodes are upmixed to stereo before the pan node, so a mono sample panned centre plays at unity rather than −3 dB. Exporting the loop region gives files that start at that region's first bar; the MIDI markers file uses the same start.

### 6.6 Generate view (Phase 5)

A view of its own (sidebar: Create → **Generate**) that instantly builds complete, DJ-friendly drum arrangements from random combinations of the library. You cycle through generations fast, listening as you go; when one is good, **Send to Arrange** turns it into a normal project to finish and export. The goal is range: no two generations need share a structure, a build style or a kick treatment.

**Cycling**
- **Generate** (G or →) makes a new arrangement in well under a second and starts playing it right away (from the start, or from the same section you were listening to). ← goes back through this session's history; generations are kept until the app quits.
- Space plays/stops; 1–9 jump to a section; a read-only overview shows the sections as a coloured band and every lane's clips as blocks (the same drawing as Arrange, scaled to fit).
- Shown per generation: length, BPM, the track key, its structure (e.g. "Intro 32 · Build 16 · Drop 32 · Break 8 · …"), the variation choices made, and which zips the samples come from.
- **Keep** toggles hold parts while cycling: keep the structure, keep the kick, keep a lane's sample, keep the key. Everything not kept is re-rolled.
- Options: length range (default 4–6 min), sources (all zips or a selection), favourites/ratings bias (on), and a seed field (the same seed + library + options gives the same generation).
- **Send to Arrange** (Enter) creates a new project ("Generated 01", …), opens it in Arrange and keeps the Generate history, so you can go back and send another. The current Arrange project is never overwritten.

**Structure: a grammar, not a template**
An arrangement is a sequence of sections, each a whole number of 8-bar phrases, generated from weighted rules and then fitted to the chosen length. Hard constraints only where DJs need them:
- **Always:** a mix-in intro and a mix-out outro of ≥ 16 bars each, with a steady kick and hats (beatmatchable, nothing tonal); the track starts and ends on a bar line.
- **Everything else varies.** Examples of what the rules can produce:
  - Intro → build → drop → break → drop → long break → drop → outro (the classic shape).
  - One long breakdown in the middle, or three short ones (no "false drops": every breakdown runs into a real drop or the outro).
  - Two or three drops of 16–48 bars; drops that change their top/groove halfway.
  - Builds of 8–32 bars: layered slowly one element per phrase, all at once, or in **double time** (hats/perc/snare density doubling 8ths → 16ths → 32nds towards the drop).
- Weights favour the classic shape, so most generations are sensible and some are surprising.

**Variation dimensions** (each chosen per generation, some per section)
- **Kick in breakdowns:** fully out; filtered (low-pass, fixed or sweeping open into the drop); half-time; only on the downbeat of each bar; kept. Each breakdown chooses on its own.
- **Drum patterns:** kick dropouts at phrase ends (e.g. the last beat or two of an 8-bar phrase), skipped kicks before a drop, clap/snare rolls, ghost notes, open-hat accents, offbeat vs 16th hats, perc swaps between sections. Applied through pattern clips (one-shots) and by gaps/edits on loop clips.
- **Fills and FX:** drum fills at phrase ends (more often before breaks and drops); a riser or snare roll that **ends** on the drop downbeat; downlifters and impacts that **start** on a section downbeat; atmos in breakdowns. FX density varies from sparse to busy.
- **Sample picks:** one main sample per lane for the track (so it sounds like one record), variations for later drops; picks come from different zips while the library allows it (the same zip may repeat once there are fewer zips than lanes); favourites and ratings bias the picks.
- **Key:** one key per track. Tonal FX and atmos are picked from that key or its Camelot neighbours; drums ignore key.

**What it needs from the rest of the app**
- **Clip filter** (the one effect allowed in the DAW): per clip, off / low-pass / high-pass, a cutoff, an optional sweep to a second cutoff over the clip, and resonance. Same node graph in live playback and offline export (shared code, like the scheduler); editable in Arrange (clip inspector); saved in the project file.
- **Event body length:** risers and rolls must end exactly on the downbeat, but an event's `bars` includes its tail. The engine also stores `body_bars` (bars from the start to where the main sound ends); existing libraries need one reprocess.
- **Loop gaps:** dropping a loop or the kick for a beat needs no new clip model: loops get shorter or split clips, kick/clap variations are per-bar pattern clips.

**Implementation notes**
- A pure TypeScript generator in the renderer (`src/generate/`): `generate(samples, options, seed, keep) → Project`, with a seeded PRNG and the structure grammar, rule weights and pattern variations as data (easy to tune). Unit-tested without audio: constraints (DJ intro/outro, phrase alignment, FX end/start on downbeats, length range), determinism per seed, and coverage (over many seeds every variation dimension occurs).
- Generations are ordinary `Project` objects played by the existing engine; buffers are preloaded per generation, so cycling is instant after the first load. Nothing changes in export.

---

## 7. Phases & acceptance criteria

### Phase 1 — Engine + CLI (no UI)
- All of §5 implemented and runnable through the CLI.
- `tests/make_fixtures.py` generates synthetic zips with a programmatic kick at known BPMs (e.g. 122, 124, 126; source tracks are always whole-number BPM), hats, claps, a top loop, a bassline + chords in a known key, a "silent breakdown" section, mixed naming conventions, `__MACOSX` junk, and one stem with a meaningless name.
- **Acceptance**
  - BPM is detected within ±0.02 of the truth on all fixtures; grid phase is correct.
  - The key is correct on all fixtures.
  - Loop starts are sample-exact on the grid after stretching (verify with a test that checks kick onsets fall on the bar start ±1 ms).
  - Silent breakdown sections produce no loops; repeated identical bars dedupe to 1 loop.
  - Each one-shot category yields ≥1 clean hit with an intact transient (no fade-in, peak within the first 10 ms).
  - Running on 3 of Lars's real zips produces a library he judges usable by ear. **This is the real gate before continuing.**

### Phase 2 — App shell, Process & Library views
- Electron app with sidecar management (spawn, restart on crash, health check), the settings screen, a first-run library folder picker, and dependency checks.
- Process view complete (§6.2), including overrides + reprocess.
- Library view complete (§6.3), including auditioning and filters.
- **Acceptance:** drop 20 zips at once; the queue works through them while the user browses the library; overrides/reprocess work; the library list stays smooth with 5,000+ samples.

### Phase 3 — Arrange: timeline + playback
- Lanes, audio clips, pattern clips with the step editor, markers, editing operations, undo/redo, zoom, save/load/autosave, and the transport.
- **Acceptance:** build a 192-bar arrangement with 8 lanes; playback is in time with no drift or glitches; save → reopen gives an identical project.

### Phase 4 — Export + polish
- Stem export (§6.5), the clipping check, the MIDI markers file, "find similar", favorites/ratings, "rebuild loops at new BPM", keyboard shortcut overview, and an unsigned local `.app` build (electron-builder; the Python engine bundled with PyInstaller onedir, or pointing to the uv environment). *Chosen: the uv route.* The `.app` carries the engine source and `uv.lock`; on first launch it runs `uv run --frozen` into `~/Library/Application Support/Drumvault/engine-venv` (needs `uv` and `rubberband` from Homebrew). Ad-hoc signed so it launches on Apple Silicon.
- **Acceptance:** exported stems imported into Logic at bar 1 at the same BPM line up sample-accurately with each other and with Logic's grid.

### Phase 5 — Generate view
- The Generate view in §6.6: the structure grammar and variation dimensions, fast cycling with history, keep toggles and seeds, the overview and section jumps, and Send to Arrange. Plus what it needs elsewhere: the per-clip filter (playback, export, Arrange inspector, project file), `body_bars` for events (engine, schema, reprocess), and short gaps in loop clips.
- **Acceptance:** with ≥ 5 processed zips, a new generation is ready and playing in under a second (after the first buffer load); every generation is 4–6 minutes with a DJ intro and outro of ≥ 16 bars on kick + hats, phrase-aligned sections, and risers/rolls ending exactly on drop downbeats; samples come from ≥ 3 different zips and tonal FX match the track key; over 100 seeds the structures differ and every variation dimension (kick treatments, build styles, pattern variations) occurs; the same seed gives the same generation; Send to Arrange opens an editable project that plays and exports like any other.

---

## 8. Development notes

- **Prerequisites (macOS):** Node 20+, `brew install rubberband uv`, Python 3.12 via uv.
- **Prerequisites (Linux cloud sessions, Phase 1 only):** `apt-get install -y rubberband-cli libsndfile1 ffmpeg`, `pip install uv`. Distro Rubber Band may be 2.x without the R3 engine (`--fine`); detect this and fall back to the default engine there. Full setup steps live in `CLAUDE.md`.
- **Dev run:** `cd engine && uv sync` → `cd app && npm install && npm run dev`. In dev, the app spawns the engine with `uv run python -m drumvault_engine`.
- Never block the Electron main process; all heavy work happens in the sidecar. Audio decode happens in the renderer.
- Keep engine types and TS types in sync: define the RPC/DB shapes once (in `engine/drumvault_engine/schemas.py` with pydantic) and mirror them in `app/src/types/` (manual sync is fine, or generate the TS from JSON Schema).
- Every analysis threshold lives in `config.py`, never hard-coded inline, so it can be tuned against real material.
- Log every processed zip's analysis summary to `<Library>/.drumvault/logs/` for debugging bad results.

## 9. Open questions (sensible defaults chosen — change if wrong)

1. Library BPM 124 — is one BPM for the whole library right, or does it need per-genre sub-libraries later?
2. Default loop lengths per category (§5.8) — tune after hearing Phase 1 output.
3. Should one-shots from different zips that are near-identical (the same sample-pack kick used in several tracks) be deduped **across** zips too? Default: no in Phase 1, a possible toggle later.
