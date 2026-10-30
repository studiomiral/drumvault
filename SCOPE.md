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
- Real-time time-stretching or pitch-shifting in the DAW. The DAW plays samples at native speed at the library BPM (exceptions: 16th slicing for other tempos, §6.4a, and sampler-style pitch on drum clips, §6.4 — both just a playback rate per slice, no DSP).
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
8. **Shape** (`events.shape`, stored as JSON in `samples.shape`): per 16th of the written file, its level. Where the sound starts (`onset`), peaks (`peak`) and ends (`end`: the last 16th within `shape_sound_rel_db` = −24 dB of its loudest, up to the body's end; sound ringing on past it counts as reaching it), and `gap` = 16ths from `end` to the end of the body: the producer's silence before the line it leads into (a riser stopping on beat 7 of 8 has a gap of 4). `dir`: `rise` (peaks late and gets ≥ 6 dB louder or ≥ 0.7 octave brighter from its first to its last beat of sound), `hit` (loudest at once and ≥ 6 dB down a beat later), `fall` (peaks early and gets that much quieter or darker) or `flat`. `noise`: mean spectral flatness (0 a tone, 1 white noise). `boundary`: the bar of the source track (from its bar 1) its body ends on, so events a producer layered at one moment can be found again; null for loose samples (§5.8c). Library "Move sound" measures the shape again.

Events are not one-shots: they are time-stretched, because they must line up with the bar grid at the library BPM.

### 5.8b Grooves and arrangements (`groove.py`, `arrangement.py`)

What the generator needs to sound played rather than programmed (§6.6):
- **Loop groove** (every loop, when it is written): its hits (onsets refined to the attack, the loop treated as cyclic so a hit on sample 0 counts), placed on the 16th grid of the library BPM. Per 16th step of the bar: the median offset in fractions of a 16th (+ late, − early), relative to the loop's own quarter notes when it plays any (else to the grid, which is the source track's kick grid); the median level in dB below the loudest step; and the hit count. Plus `swing` (mean offset of the odd 16ths: +0.33 = MPC 66 %) and `push` (the offbeat 8ths). Stored as JSON in `samples.groove` (`{}` when the loop has too few hits).
- **Track arrangement** (every zip, during analysis, before the melodic stems are let go): each stem measured bar by bar on the track's own grid (its BPM and bar 1) and summed into parts: kick, clap (and snare), hats (and shaker), ride, perc, top (top, groove, drums), crash (cymbal), fills (fill, roll), fx, bass (melodic stems named as bass), music (other melodic). Per part and bar: `0` silent (below `arrangement_silence_db` or 20 dB under the part's full level), `1` quiet or filtered, `2` full (within 6 dB of the part's full level = its 90th-percentile bar). Stored in `arrangements` (one row per zip).
- **Older libraries**: `analyze_library` (a job) fills in grooves from the loop files, event shapes from the event files (the source bar from `source_offset_s` on the zip's stored BPM and bar 1), kept originals (§5.8d) for zips and packs imported before, while they are still where they came from, and arrangements from each zip's stems (on their stored BPM and bar 1). The app starts it by itself when the engine is up and something is missing.

### 5.8c Loose samples (`samples.py`, job `import_samples`)

Zips are whole tracks (tempo, bar 1, key and structure come from all their stems together). Loose samples (Splice and other packs) are already cut, so they don't go through that pipeline: each file is read on its own and lands in the same library.

- **Packs.** Files are grouped by their Splice pack (`…/sounds/packs/<Pack>/…`), else by the dropped folder, else by the file's own folder. A pack is a source like a zip: its own code (`P0001`, separate from `S0001…`), in the Process list with its files as "stems", in the Library's source filter, in Generate's spread over sources. It has no arrangement, so it is never a structure template (§6.6), and no grid (the Grid view leaves packs out). Adding files to a pack's folder later and dropping them adds them to the same pack (the pack is re-cut, favourites and deletions kept); files already in it are skipped.
- **Category:** filename rules (§5.3) on the file name, else on its folders from the nearest up ("Kicks/BBH_03.wav"), else the audio fallback. Overridable per file like stems, then reprocess.
- **Kind:** FX, fills and rolls → event. "One shot"/"hit" in the path (and not "loop" in the file name) → one-shot. Otherwise a **loop** when its length is whole bars: at the BPM in the name ("124bpm", or a bare 60–200 like `BBH_124_Hat_Loop`; a tail after the last whole bar is cut), or without one at the tempo within the max stretch that makes it 1, 2, 4, 8 or 16 bars (closest to the library BPM). Short files (≤ `sample_oneshot_max_s`) that aren't whole bars are one-shots. A "loop" that isn't whole bars, melodic files, longer files and loops too far from the library BPM to stretch are skipped with a warning; only skips a category override or a rename can fix (a loop that isn't whole bars, a one-shot without a single-sound category) flag the pack `needs_review`.
- **Loops** start on their downbeat. Three cycles are stretched to the library BPM (Rubber Band, §5.7) and the middle one kept, so the ends join like a repeat; cut sample-exact to `bars × bar length`, no end fades (§5.8 step 5). Kick and cymbal loops (no loop lengths) give their distinct hits as one-shots instead.
- **One-shots** are never stretched: the best hit of the file (§5.6), or the whole file with its tail trimmed when no onset is found.
- **Events:** stretched when the name has a usable BPM, then cut on bar lines like §5.8a.
- **Key** from the name only ("_Am_", "F#min", "Bb major"; a bare letter is not a key), else none. BPM, normalization, grooves, peaks and file names as for zips (`LP_Hat_124_NoKey_P0001-house-tools_2bar_01.wav`).

### 5.8d Kept originals (`originals.py`)

The library keeps its own copy of what was imported, so the zips and folders dropped in can be deleted afterwards: reprocessing, a new library BPM (`rebuild_loops`), the Grid view's preview and `analyze_library` read the kept copy first and the original only when nothing is kept.

- **Where:** `<Library>/.drumvault/originals/<source code>/`, every audio file of a zip (its path inside the zip, nested zips included) or the pack's files. `kept.json` maps each stem name to its file and is written last; a folder without it (an interrupted copy), or with a file missing, is not used.
- **Lossless:** 8-, 16- and 24-bit PCM (WAV, AIFF) become FLAC at the same bit depth: decoded, the samples are bit-identical, so reprocessing gives the same library. About 60 % of the zip's size. Float and 32-bit files, and files that are FLAC already, are copied as they are. WAV metadata chunks are not kept (nothing reads them).
- **When:** at the end of every import and reprocess of a zip, and for every file a pack gets. Not while the disk would have less than `originals_min_free_gb` free afterwards: the zip then gets a warning to keep the original for now, and `analyze_library` tries again on a later launch (it checks the space before unzipping, and the SHA-1 so a changed zip isn't kept).
- **Delete:** deleting a zip's samples deletes its kept copy too. The zip's `original_path` keeps saying where it came from; the zip panel says "Kept in the library", and Reveal opens the kept folder once the original is gone.

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
  processed_at TEXT, settings_hash TEXT,
  kind TEXT DEFAULT 'stems'         -- 'stems' (a zip of one track) | 'pack' (loose samples, schema v8, §5.16)
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
  shift_beats INTEGER DEFAULT 0,    -- loops/events: Library "Move sound", beats later (schema v5)
  groove TEXT,                      -- loops: timing and accents per 16th, JSON (v7, §5.8b)
  shape TEXT,                       -- events: how it plays and the source bar it leads into, JSON (v9, §5.8a)
  created_at TEXT
);

-- Samples the user deleted (schema v3); reprocessing re-cuts matching ones into the trash.
CREATE TABLE removed_samples (
  id INTEGER PRIMARY KEY,
  zip_id INTEGER REFERENCES zips(id) ON DELETE CASCADE,
  stem_file TEXT, kind TEXT, bars INTEGER, source_offset_s REAL,
  sample TEXT,                      -- v4: the sample row (JSON) a restore inserts again
  fingerprint BLOB,                 -- v4
  removed_at TEXT                   -- v4
);

CREATE INDEX idx_samples_cat ON samples(kind, category);
CREATE INDEX idx_samples_key ON samples(key_label);
```

Schema v7 adds `arrangements (zip_id PRIMARY KEY, bpm, bars, parts TEXT, created_at)`: per part a string with one character per bar (§5.8b).

Schema v9 adds `samples.shape` (§5.8a); `analyze_library` fills it in for older libraries.

Schema v8 adds `zips.kind`: a pack of loose samples is a row like a zip (code `P0001…`, `original_path` = its folder, `file_sha1` = `pack-` + the SHA-1 of the folder path), its files are its `stems` rows (paths relative to the folder). Zips keep their own numbering (`S0001…`).

Reprocessing a zip deletes that zip's samples (files + rows) and regenerates them. `favorite`, `rating` and `tags` survive reprocessing where a regenerated sample matches an old one by stem + kind + length + offset (nearest, within a tolerance so a moved bar 1 still matches); samples matching a `removed_samples` row are not written at all.

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
{"id": "uuid", "method": "import_samples", "params": {"paths": ["/…/Splice/sounds/packs/House Tools", "/…/Kick.wav"], "settings": {...}}}
{"id": "uuid", "method": "reprocess_zip", "params": {"zip_id": 12, "overrides": {"bpm": 123, "key": "Fm", "stems": {"34": "perc"}}}}
{"id": "uuid", "method": "delete_zip", "params": {"zip_id": 12, "delete_files": true}}
{"id": "uuid", "method": "rebuild_loops", "params": {"settings": {...}}}
{"id": "uuid", "method": "cancel", "params": {"job_id": "..."}}
{"id": "uuid", "method": "grid_preview", "params": {"zip_id": 12, "settings": {...}}}
{"id": "uuid", "method": "delete_samples", "params": {"sample_ids": [301, 302], "settings": {...}}}
{"id": "uuid", "method": "restore_samples", "params": {"removed_ids": [7], "settings": {...}}}
{"id": "uuid", "method": "shift_sample", "params": {"sample_id": 301, "beats": 1, "settings": {...}}}
{"id": "uuid", "method": "render_bass", "params": {"preset": "/…/X.SerumPreset", "midi_id": 3, "transpose": -4, "bpm": 124, "out_rel": ".drumvault/bass/….wav", "notes": null, "bars": null, "settings": {...}}}
{"id": "uuid", "method": "save_midi", "params": {"name": "Roll edit", "notes": [[0.25, 0.25, 41, 100]], "bars": 2, "key_label": "Fm", "settings": {...}}}
{"id": "uuid", "method": "stretch_samples", "params": {"rel_paths": ["FX/Risers/..."], "bpm": 128, "settings": {...}}}
{"id": "uuid", "method": "analyze_library", "params": {"settings": {...}}}
{"id": "uuid", "method": "health", "params": {}}
```

Responses and events from the engine:
```json
{"id": "uuid", "result": {...}}
{"id": "uuid", "error": {"code": "...", "message": "..."}}
{"event": "progress", "job_id": "...", "zip": "...", "stage": "tempo", "pct": 0.4, "message": "Kick: 124.00 BPM (conf 0.97)"}
{"event": "job_done", "job_id": "...", "zip_id": 12, "status": "done", "counts": {"oneshots": 18, "loops": 41}}
```

`delete_samples` answers `{"deleted": n}` and `restore_samples` `{"restored": n, "pending": m}`. Favourites, ratings and tags, and deletions, are matched to the new samples after reprocessing by stem, kind, length and start (within `match_oneshot_tolerance_s` / `match_loop_tolerance_s`, so a moved bar 1 keeps them).

`grid_preview` is not queued behind imports (it runs on its own thread) and answers directly: it sums the zip's drum stems to one mono 16-bit WAV at `grid_preview_sr` in `.drumvault/grid/<zip_id>.wav` and returns its path, sample rate, duration, the zip's BPM, the bar 1 the library is cut on (`bar_one_ms`, and `manual` if it was set by hand) and the stem names. The app reads the file and deletes it. A negative `grid_offset_ms` (hits ahead of the first downbeat) starts the grid one bar later, so cuts never begin before sample 0.

### 5.15 CLI (`cli.py`) — needed for Phase 1

```
uv run python -m drumvault_engine cli process <zip_or_folder>... --library ./out --bpm 124
uv run python -m drumvault_engine cli analyze <zip>        # prints classification, BPM, key; writes nothing
```

---

## 6. Desktop app (Electron + React)

### 6.1 Layout

A single window with a left nav: **Process**, **Library**, **Grid**, **Generate**, **Arrange**. The Library browser also appears as a collapsible side panel inside Arrange. The UI uses a dark matte theme modelled on the NeuroNest dashboard reference: charcoal surfaces with thin borders and large rounded cards, a grouped sidebar without a logo or name (the top holds the window buttons; Samples: Process, Library, Grid · Create: Generate, Arrange · Settings: Settings, Shortcuts) with the library and engine status at the bottom, pastels for kinds (blue one-shots, mint loops, lavender FX & fills), and a subtle yellow accent for primary actions and selection. Process opens with a gradient hero banner beside the drop box. Page titles in the top bar are heavy display capitals (Bricolage Grotesque ExtraBold). The Process banner and dialog titles use a book serif (Newsreader); the UI uses a grotesk (Hanken Grotesk). All fonts are bundled locally.

### 6.2 Process view

- A large drop zone; it accepts multiple zips or a folder (all zips inside it are found recursively), and loose samples (WAV/AIFF/FLAC, or folders of them), which become packs (§5.8c). A pack's panel shows its files with their category, and no tempo, grid or key controls (each file has its own).
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
- **Cleaning up:** ⌘-click, ⇧-click (range) and ⌘A select several samples; **Delete** / ⌫ removes them at once, without a confirm since they can be restored (engine `delete_samples`: WAV files, peaks and rows). Deleted samples are remembered per zip in `removed_samples`, so reprocessing the zip (also a Grid re-cut or a library BPM rebuild) doesn't bring them back; it re-cuts them into the trash instead, so a restore matches the current grid and BPM. Whole zips are removed from the zip panel (**Delete samples**).
- **Move sound** (selected loop, fill or FX: −1 / +1 in the bottom bar, or ← / →): rotates the sample file a beat earlier or later inside itself, wrapping around (e.g. a fill on beat 3 of its bar moved to beat 4). Engine `shift_sample` rewrites the WAV and peaks and stores the total in `samples.shift_beats`; reprocessing applies it to the new cut (matched like favourites). Arrange clips using the sample change with it.
- **Deleted** (top bar, with a count) lists the deleted samples, newest first: play them, select one or several (⌘/⇧-click, ⌘A) and **Restore** (Enter). Their WAV and peaks wait in `.drumvault/trash/<id>.wav|json`; restoring (engine `restore_samples`) moves them back under their name, or the next free number if a re-cut reused it, with favourite, rating and tags. Deletions from before the trash existed have no file: restoring them only forgets the deletion, and the next reprocess brings them back.

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
1. **Audio clip** (loops): placed on the bar grid. Dragging the right edge extends the clip by repeating the loop (a whole number of loop lengths, or any bar count, ending mid-loop is allowed). Per-clip gain. Optional left trim in whole beats. **Fades:** dragging the top half of a clip's edge (or the fade handle inside it) sets a linear fade-in or fade-out, snapped like everything else; the bottom half still resizes. Fades follow the edges when a clip is resized, never overlap, apply to pattern clips too, and are scheduled in `schedule.ts` (`fadeAt`), so playback and export match. **Move sound** (−1 / +1 in the clip bar, ⇧← / ⇧→) moves the sound a beat later or earlier inside the clip's loop, wrapping around, while the clip stays where it is (e.g. a fill on beat 3 moved to beat 4); pattern clips rotate their steps the same way.
   FX & fills (events) also become audio clips: placed at a bar, they play once over their length; extending one repeats it like a loop.
2. **Pattern clip** (one-shots): references 1 one-shot sample and holds a step grid of 16 steps per bar, pattern length 1, 2 or 4 bars, and 3 velocity levels per step. A pattern clip repeats when extended, like an audio clip. Double-click opens a step editor beneath the timeline. Quick presets: "4 on the floor", "offbeat", "every 2 & 4". A pattern may carry a **groove** (16 step offsets in 16ths and 16 accents in dB, taken from a loop, §6.6): each step lands that much late or early (by its place in the bar) at that accent.
3. **Loop variations** (audio and pattern clips, not bass): **pitch** in semitones, played faster/slower like a sampler; a pitched loop plays as 16th slices that each start on the grid (the same slicing as another tempo, §6.4a), so it stays in time. **Only the first bars** (`loopBars`): an audio clip repeats only its loop's first 1 or 2 bars. Both show in the clip label (`+1 st`, `bar 1`), are scheduled in `schedule.ts` (playback = export) and are set from the right-click menu.

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

**Right-click menu** (Arrange timeline), the same commands as the keys:
- On clips (the clicked one joins or becomes the selection): Cut ⌘X, Copy ⌘C, Paste here ⌘V, Duplicate ⌘D, Delete ⌫; Split here (S splits at the playhead; a split clip plays exactly as before: the loop or pattern carries on); Move sound a beat earlier/later; Remove fades; Edit pattern; Replace with copied sample (copy one clip, then replace the sample of others, keeping place, length and pattern); Swap for a similar sound (the most similar library sample, again for the next); Pitch up / down a semitone, Original pitch; Play the whole loop (a clip on its first bars); Play straight (a pattern without its groove); Show in Library; Reveal in Finder.
- On a section marker: Rename, Duplicate section, Loop this section, Play section, Delete marker (the clips stay).
- On empty space / the ruler: Paste here, Select all, Play from here.
- The clipboard holds clips inside the app; ⌘X/⌘C/⌘V act on clips when no text field has focus.

### 6.4a Project tempo

Samples are cut at the library BPM. A project (Arrange, or a generation) can run at another tempo without changing pitch, like warping in Ableton or Logic:
- **Drum loops, fills and rolls** play as 16th slices: each slice starts on the project's grid with its own piece of the loop (Ableton's Beats mode), so transients and pitch are untouched. Faster: a slice is cut at the next one (3 ms fade); slower: a tiny gap after it. Done in `schedule.ts`, so playback and export match; at the library tempo a loop is one event as before (bit-exact).
- **FX** (risers, downlifters, impacts, sweeps, atmos) would break up when sliced: the engine stretches them with Rubber Band (`stretch_samples`) into `.drumvault/tempo/<bpm>/<rel_path>`, once per tempo, redone only when the sample changes. Playback and export make sure they exist before loading (`audio/tempo.ts`).
- **One-shot patterns** just land on the new grid.
- Clips store their sample's tempo (`SampleRef.bpm`; older projects derive it from the length).
- **Arrange:** the BPM field in the toolbar (60–200) sets the project tempo; positions stay in beats, the playhead stays on its bar. It shows in the accent colour when it differs from the library BPM.
- **Generate:** a Tempo option: Library (default), Fixed, or a Range from which every track picks a whole BPM (seeded). Remembered between sessions.
- Auditioning a library loop in sync while a project plays at another tempo speeds the preview up or down (audition only, slight pitch change).

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
- **Volume** slider on every lane of the overview, the same control as Arrange's lane headers (double-click: the starting level): it changes the current generation at once (no re-roll), applies to the next ones and to what is sent to Arrange, and is remembered between sessions (per lane: Kick, Clap 2, Tops 3, …). The starting mix has the kick at −2 dB.
- **Per lane, on the right of the overview:** M and S (mute and solo, kept by lane name while cycling, and carried to Arrange) and a re-roll button: that lane made again, the rest of the track exactly as it is. It gets a new sample (not one already in the track) and draws the lane's own track rules again: how often the crash comes (every 8 or 16 bars, into breakdowns, into the outro), where the kick drops out, clap rolls and ghost notes, how many tops and when they come in, fills into which parts, FX density, the bass in breakdowns and builds. The structure, key, tempo and track-wide rules (the silence before drops) stay, so the new lane still fits. On the Bass lane it also picks another bassline and/or patch. The result is a new history entry right after the current one (← goes back), swapped in at the playhead while playing. Drops can also crash every 8 bars (a rule of its own).
- **Send to Arrange** (Enter) creates a new project ("Generated 01", …), opens it in Arrange and keeps the Generate history, so you can go back and send another. The current Arrange project is never overwritten.

**Structure: a real track's, changed a little, or the grammar**
Most generations (80 % when the library has arrangements, §5.8b) follow a **real track's** structure and the decisions its producer made, about 90 % of the way (`template.ts`):
- The track's arrangement is read phrase by phrase: no full kick = breakdown; kick with the bass full or near the track's highest energy (the full parts that play) = drop; the first four phrases before the first drop the intro, more than that a build; after the last drop the outro; a quieter kick part after a breakdown builds into the next drop. Sections are kept within the limits below (an intro of 48 bars becomes 32) and the generator's grammar (a build runs into a drop); a track that ends on its drop gets its last 16 bars as the outro.
- Its rules where they can be read: hats in breakdowns, claps and perc in the intro, when the top loops come into the intro, bass in breakdowns / builds / intro (low-passed or out), the ride (later in drop 1 and/or the later drops), four kicks out before drops, crashes every 16 and every 8 bars, fills into 16-bar marks and drops, FX density, the breakdown kick (out, thin/filtered when quiet).
- Then made new: each rule read is drawn again with a chance of 12 %; one section a phrase longer or shorter (60 %); sometimes another breakdown kick or build style; always at least one change. Fitted to the length range only when outside it. The choices list starts with "structure after S0012 (drop longer, …)".

Otherwise an arrangement is a sequence of sections, each a whole number of 8-bar phrases, generated from weighted rules and then fitted to the chosen length. Hard constraints only where DJs need them:
- **Always:** a mix-in intro and a mix-out outro of ≥ 16 bars each, with a steady kick and hats (beatmatchable, nothing tonal); the kick there is subtly high-passed (60–110 Hz) so it mixes over another track, and top loops come in (intro) and thin out (outro); the track starts and ends on a bar line.
- **Everything else varies.** Examples of what the rules can produce:
  - Intro → build → drop → break → drop → long break → drop → outro (the classic shape).
  - One long breakdown in the middle, or three short ones (no "false drops": every breakdown runs into a real drop or the outro).
  - Two or three drops of 16–48 bars; drops that change their top/groove halfway.
  - Builds of 8–32 bars: layered slowly one element per phrase, all at once, or in **double time** (hats/perc/snare density doubling 8ths → 16ths → 32nds towards the drop).
- Weights favour the classic shape, so most generations are sensible and some are surprising.

**Track rules: random between tracks, consistent within one**
Every variation below is decided once per track and applied to every section of the same kind, so a track has its own logic and doesn't feel random: if drop 1 has a crash (or four kicks out, or a fill) every 16 bars, so does every drop, and the intro and outro crash on the same 16-bar rule. All drops share the kick variation at 8-bar ends, clap ghost notes and rolls, the number of top loops (the last drop adds one), when groove and the second perc come in, and the halfway loop switch. Every way into a drop is the same (four kicks out or just the last kick, roll or fill, riser, impact, the beats of silence, a crash on the 1), and so is every way into a breakdown. One fill, roll, riser, impact and downlifter sample per track, reused (another only where it doesn't fit). The outro mirrors the intro: tops, claps and perc leave the way they came in. Breakdowns are the exception: a break is a break from the rest, so each one chooses its own kick treatment and content.

**Variation dimensions** (each chosen per generation as one of the track's rules; breakdowns per section)
- **Kick in breakdowns:** fully out; thin (high-passed at 180–350 Hz, the common filtered one); low-passed (fixed or sweeping open into the drop, kept rare); only on the downbeat of each bar; kept (no half-time kick: it sounded off).
- **Announcing parts:** usually the last bar before a drop has no kick (four kicks out), and inside drops the bar before bar 17, 33, … often too; the next bar starts with a crash. Most tracks also go silent for one or two beats right before each drop, except FX, fills and hits (risers, rolls and impacts ring through).
- **One moment into every drop** (the producer's): an event is placed by its body, so the silence its producer left before the line (its shape's `gap`) comes with it. Everything leading into a drop stops together: the riser decides (or, without one, the fill or roll), and the fill or roll and any second FX layer must agree with it: all run up to the line (gap ≤ 1 16th), or all stop early within 2 16ths of each other. Never one riser into the drop and another, or the fill, leaving a beat of silence. A riser the track's fill can stop with is preferred, so the track keeps one fill. When they stop early, the rest of the track (every lane but fills, FX and hits) goes silent there too, up to 2 beats; when they run up to the line, the track's own beat or two of silence applies and they ring through it. Events silent for more than 2 beats before their line (a hit on the 1 and a rest, cut from a fill stem) never lead into one. The measured stops per drop are stored with the rules (`dropGaps`) and kept by lane re-rolls, so a re-rolled FX or fill lane stops where the rest of the track does (or the re-roll finds nothing new). Libraries without shapes count every event as running up to the line.
- **Layered FX:** in normal and busy tracks, often a second FX layer into drops (lane FX 2): a riser or a sweep/other FX that measures as rising, never two of a kind from two tracks: another length (a long build with a short lift on top), another texture (noise with a tone), or the same track's. Sometimes a downlifter as the drop hits, next to the impact (on a lane free there: FX lanes never stack sounds). Tonal FX stay in key when the library has any in key, even if that leaves no layer.
- **The producer's own FX:** events of one track that lead into the same bar of it (bodies ending there) or start on it (an impact, a downlifter) were layered there by its producer. Half the tracks (when the library has such moments with a riser in key) take one moment as their FX into drops: its riser(s), fill or roll, impact and downlifter are the track's picks for those jobs, and the rules follow it (a roll if it had one, the impact, two layers if it had two risers). Its own track's moments are preferred when the structure is that track's.
- **Crashes** (their own lane) on the 1 of key moments: every drop, after a four-kicks-out bar, where a ride comes in, usually the outro and sometimes a breakdown.
- **Rides** (their own lane, never in intros or outros): coming in later in the first drop, all through from the second drop, or both. Each breakdown chooses on its own.
- **Drum patterns:** kick dropouts at phrase ends (e.g. the last beat or two of an 8-bar phrase), skipped kicks before a drop, clap/snare rolls, ghost notes, open-hat accents, offbeat vs 16th hats, perc swaps between sections. Applied through pattern clips (one-shots) and by gaps/edits on loop clips.
- **Fills and FX:** drum fills at phrase ends (more often before breaks and drops); a riser or snare roll whose body **ends** on the drop downbeat; downlifters and impacts that **start** on a section downbeat; into breakdowns a sweep that rises **ending** on its downbeat and/or a downlifter falling away from it. Sweeps and other FX go where their measured shape says (rising ones end on a line, falling ones start on one); unmeasured sweeps count as falling. Atmos in breakdowns. FX density varies from sparse to busy.
- **Layering:** more of the same stem where it makes sense, each layer on its own lane a little quieter: two to four **top loops** (several at once in drops, all of them in the last drop, one more per phrase in layered builds), up to three **claps** stacked on the backbeat in drops, a second hat loop and a second perc loop in drops. Never a second kick.
- **Sample picks:** one main sample per lane for the track (so it sounds like one record), variations for later drops; picks come from different zips while the library allows it (the same zip may repeat once there are fewer zips than lanes); favourites and ratings bias the picks. Loops are picked to fit the track's feel first (similar swing and push), then spread over zips.
- **Feel** (`feel.ts`): the groove of the track's main loop (its groove loop, else its first top, perc or hat loop with enough hits measured, §5.8b) is applied, 70–100 % of the way (a track rule), to every one-shot pattern except the kick and crash (offsets clamped to ±0.4 of a 16th; accents at half strength, at most −6 dB, relative to each pattern's loudest step so nothing gets quieter overall) and to the bass (its notes rendered on the groove). Shown as "feel of S0021's groove loop (62 % swing)".
- **Loop variations:** a top layer, the second perc or the second hat loop pitched ±1–2 semitones for the whole track (sometimes); intro loops repeating only their first bar or two in the intro's first half, the outro mirroring it (sometimes).
- **Something changes every 8 bars.** At every 8-bar mark inside a section where nothing changes by itself (no element in or out, no fill, kick variation or crash in the bars around it), one subtle variation is added, not the same kind twice in a row: a kick variation in the bar before (not in intro/outro), the hats stopping for the last beat or two (not in intro/outro), a loop layer out for the last bar or half bar, a loop playing another part of itself for the next 8 bars (only its first bar or two, from another bar, a semitone up or down, or a short gap), a clap ghost note, a fill into the mark, a high-pass lift on a top loop. In the DJ intro and outro the kick and hats keep playing (hat loops may vary there, never stop).
- **Key:** one key per track. Tonal FX and atmos are picked from that key or its Camelot neighbours; drums ignore key.

**What it needs from the rest of the app**
- **Clip filter** (the one effect allowed in the DAW): per clip, off / low-pass / high-pass, a cutoff, an optional sweep to a second cutoff over the clip, and resonance. Same node graph in live playback and offline export (shared code, like the scheduler); editable in Arrange (clip inspector); saved in the project file.
- **Event body length:** risers and rolls must end exactly on the downbeat, but an event's `bars` includes its tail. The engine also stores `body_bars` (bars from the start to where the main sound ends); existing libraries need one reprocess.
- **Loop gaps:** dropping a loop or the kick for a beat needs no new clip model: loops get shorter or split clips, kick/clap variations are per-bar pattern clips.

**Implementation notes**
- A pure TypeScript generator in the renderer (`src/generate/`): `generate(samples, options, seed, keep) → Project`, with a seeded PRNG and the structure grammar, rule weights and pattern variations as data (easy to tune). Unit-tested without audio: constraints (DJ intro/outro, phrase alignment, FX end/start on downbeats, length range), determinism per seed, and coverage (over many seeds every variation dimension occurs).
- Generations are ordinary `Project` objects played by the existing engine; buffers are preloaded per generation, so cycling is instant after the first load. Nothing changes in export.

---

### 6.7 Bass and Keys: MIDI through Serum 2 (Phase 6)

Basslines and keys/chord parts are written by the app, learned from the MIDI page's two sections (learning material only: Generate never plays those files as they are); the sound comes from Serum 2 presets, rendered by the engine, from a separate patch pool for each.
- **MIDI import** (Samples → **MIDI**, ⌘6, its own page; Process takes stem zips only and refuses a MIDI-only zip with a pointer to this page). The page has two sections, **Bass** and **Keys & chords** (the one shown is remembered), each with its own drop zone, list and "What Generate learned" panel. `import_midi(paths, role)`: every .mid file dropped on a section (loose or in folders) is that part, whatever its name; from a MIDI zip with several parts (Bass, Organ, Strings, …) only the parts named for the section are kept (bass/sub/808/reese; keys, keyboard, piano, e-piano, organ, Rhodes, Wurli, clav, chord(s)), the others counted as left out (they still help find the key). The engine reads all notes (in beats, from the bar of the first note: a region exported from bar 49 of a Logic project starts on bar 1), rounds the length up to 1/2/4/8/16 bars (a last note a few ticks past a bar line doesn't add a bar) and finds the key: a key in the part's name ("Fm", "F#min", "A_maj") wins; else a MIDI zip named like a processed stem zip ("83686_midi" ↔ "83686_stems") takes that track's key; else the key all the zip's parts point to together (duration-weighted pitch classes against key profiles); a loose file uses its own notes. A zip's part is named after the zip ("83686 Bass"). Files are copied to `<Library>/MIDI/Bass/` or `MIDI/Keys/` and indexed in `midi_files` (schema v6: notes as JSON, `role` bass/keys, `source` zip, `source_code` of the linked stem zip); the same file twice is skipped. Each list shows its parts (a note thumbnail, bars, notes, source and linked track) with search, a key dropdown (`set_midi_meta`), "To Bass" / "To Keys & chords" for a part in the wrong section, and remove (`delete_midi`).
- **Serum 2 in the engine** (`serum.py`): Pedalboard hosts the VST3 offline, one instance for the engine's lifetime (loading takes ~10 s, rendering a few bars ~0.1 s). A `.SerumPreset` is loaded without Serum's browser: Serum's plugin state is JUCE binary XML whose `<IComponent>` holds an "XferJson" container (JSON header with an MD5 of the payload + zstd-compressed CBOR patch); a preset file is the same CBOR except that untouched sections say `"default"` and the processor's `component` entry is missing, so the engine fills those in, re-compresses, re-hashes and sets the state. Serum 1 `.fxp` presets are not supported yet.
- **Writing basslines** (`src/generate/bassline.ts`, pure and seeded). The MIDI library is what the generator learns from (`learnBass`); the MIDI page shows what it took from it (where notes start per 16th, the notes it plays most, how later bars vary). Every file is read on the 16th grid relative to the root it plays on its very first 1 (the files' key labels are often wrong), one note per step, an 8-bar file as two 4-bar loops, a major line with its 3rd and 6th as the minor ones (so a move to its VI is the minor VI). Learned: where the next note starts after one on each 16th (and where notes start at all, to fall back on after a rare step); the intervals from the root (octave included) per beat position (the 1, the 3, beats 2 and 4, 8th offbeats, 16ths) and from note to note; how many different notes a main bar plays; note lengths as a share of the room to the next note (one articulation per line) and the longest usual note (90th percentile); the register (median root on the 1); loop lengths; how often bar 2 of 2 and bars 2, 3, 4 of 4 differ from bar 1, from which 16th they differ (the 1: the whole bar; 9: its second half turned around), the notes of those turnarounds, and how often a whole-bar change is the bar on another root (and which). `generateBassline` writes a loop of 1, 2 or 4 bars (the length chosen, else as the library's tend to be): the main bar's rhythm a walk over the learned moves (between the usual fewest and most notes), the root on the 1, the other notes by beat position and after each other (note-to-note tempered, so the many repeats of the library don't make one-note bars) until the bar plays as many different notes as a library line; later bars repeat it or vary like the library's (its second half rewritten from a learned 16th with the turnaround notes, or the bar on another root), at least one in a 2- or 4-bar loop; lengths in one learned articulation, capped by the longest usual note; velocities as learned. Notes are in the track key's scale (minor, or mixolydian major with the b7; both with the note a semitone under the root, the turnarounds' approach), the root at the octave nearest the learned register. A generated line is a bassline like an imported one (`generatedMidi`: a negative id named after its notes, "Bassline 3fa1c (2 bars)", key = the track key, transpose 0): it renders from its notes (`render_bass` with `midi_id` < 1 needs `notes` and `bars`), and its notes go into every bass clip (`BassRender.notes`). Its timing stays on the grid: the track's feel moves it (as for imported lines). Saving a line or an edit adds it to the MIDI library, so it is learned from too.
- **Patch pool:** the Serum 2 presets folder (default `/Library/Audio/Presets/Xfer Records/Serum 2 Presets/Presets`) and the folders under it you tick in Settings → Bass (a folder includes its sub-folders). Patches can be starred (picked more often). App settings `bass: {presetRoot, folders, favorites}`.
- **Rendering** (`render_bass`): Serum back on its init patch first (a preset lists only what differs from the defaults, so nothing may carry over from the preset before), then the MIDI, transposed, through the preset, as a seamless loop at the project tempo (two cycles rendered, the second kept, so tails and modulation wrap like a repeat), loudness-matched (`bass_lufs_target`), written to `.drumvault/bass/<preset hash>-<midi id>[-g<groove hash>]-<transpose>-<bpm>.wav` (the app names the file, `bassPath`), cached until the preset or MIDI changes (renders from an older `BASS_RENDER_VERSION` are deleted once and redone). With the track's feel (`groove`: 16 step offsets in 16ths), notes that start on a 16th move by their step's offset (their ends stay). Another tempo means another render, never slicing.
- **In Generate** (a separate Bass section): each generation writes a new bassline in the track key and picks a patch. **New bassline** writes another one for the current generation; **Any / 1 / 2 / 4** sets the length of new basslines (remembered) and writes one at once. A transpose of a written line (an octave up) carries over to the next one. (A line from the MIDI library, kept from an older session or saved, still plays transposed into the key the nearest way, a major part in a minor track via the relative key.) The bassline repeats through every drop; breakdowns get it low-passed or not at all, builds out / low-passed / a low-pass opening up, intro and outro usually without (sometimes low-passed in their inner half), all as the track's rules. The section browses in place: previous / next / random patch (with ★), a new bassline, transpose by semitone or octave, sidechain depth, and bass on/off for new generations. Keep toggles hold the bassline and the patch. "Rendering with Serum 2…" shows while a part renders (the first one loads Serum).
- **Sidechain:** a lane with `duck` (0…1) dips by that much on every kick hit (pattern clips with a kick one-shot, also kick lanes not being exported), reaching full depth in 4 ms and recovering over 0.6 beat; scheduled by the shared scheduler (`kickHits`) for live playback and export alike. The Bass lane gets it from Generate; in Arrange a lane with a sidechain shows an extra slider in its header.
- **In Arrange** a bass clip is an audio clip with `bass: {preset, presetName, midiId, midiName, transpose}`; it moves, repeats, trims, splits, filters and fades like a loop. The right-click menu adds transpose ±1 semitone / octave, next / previous / random patch and **New bassline** (one written line for all selected bass clips, in the key they play now: the root on its first note, minor unless it plays a major 3rd and no minor one); they re-render and play on. A written line has no "back to the imported MIDI": it is its notes.
- **Piano roll** (one loop of 1–16 bars): double-click a bass clip in Arrange (or "Edit notes…" in its menu), or **Edit notes** in Generate's Bass section. Click to add a note (a 16th, or the selected note's length; drag right away to size it), drag to move in time and pitch (16ths, ⌥ 64ths), drag a note's end to resize, right-click / double-click / ⌫ to delete, ↑↓ ←→ to nudge the selected note (⇧↑↓ an octave); a velocity lane below; loop length 1/2/4/8/16 bars. The roll shows the pitches as heard (with the transpose). Each edit (on mouse-up) re-renders the loop through Serum; the edited notes live in the project (`BassRender.notes` / `bars`, at the MIDI's own pitch) and apply to every clip of that bassline in the track (Generate: the current generation, and kept generations when the bassline is kept); the render file is named after the notes. **Revert** goes back to the imported file; **Save as new bassline** writes the loop as a .mid to `MIDI/Bass/` and indexes it (engine `save_midi`; saving the same loop twice gives the existing one), and the track switches to it.
- **Export:** next to `<Prefix>_markers.mid`, `<Prefix>_Bass.mid` and `<Prefix>_Keys.mid` hold the bass and keys parts as notes (looped, trimmed and transposed as in the arrangement), to play through the real Serum patches in Logic; each has its own WAV stem.
- **Writing keys parts** (`src/generate/keys.ts`, pure and seeded). Learned from the Keys & chords section (`learnKeys`): notes starting together are one voicing (inversions, extensions, each voice's length and velocity kept), relative to the part's key (major parts with their 3rd, 6th and 7th as the minor ones), per 1-, 2- or 4-bar phrase; plus the register, voicing size and where chords start. `generateKeys` combines one learned phrase's rhythm with another's chords in the track key and register; the whole part sits at C3 or higher (an octave up while it would reach into the bass), and a note that one rhythm's lengths would hold into its own next hit is cut there. A generated part is a MIDI part like a bassline (`generatedKeysMidi`, role keys, "Keys 3fa1c (2 bars)"), rendered by `render_bass` into `.drumvault/keys/`.
- **Bass and keys that go together** (`src/generate/harmony.ts`), the club house way: each part is its own learned loop and nothing is rewritten to match. The bass is a riff (mostly on one chord, its length as set); the keys a chord or loop in their own learned rhythm. `harmonyOf` reads a keys loop's chords half a bar at a time (the root that makes the sounding notes most chord-like: a 5th, a 3rd, the lowest note, in the scale; a half bar without chords keeps the one before). `pairScore` listens to a pair: per half bar the riff on the chord's root counts most, on another chord tone a little, against the chord it costs; every riff note a semitone against a chord tone sounding with it (and not itself in the chord) costs more. A generation writes the riff first, then the keys loop as the best of twelve for it (a riff on one chord gets keys on that chord). Under kept keys the riff is the best of twelve for them. **New bassline** fits the generation's keys, **New keys part** its riff; in Arrange the same with the project's first keys or bass clip. The Keys section and the generation's choices name the chords ("i" for a loop on one chord, "i – iv", a bar changing halfway "VI/VII").
- **Keys in Generate and Arrange:** a Keys section beside Bass (both fold down to a header with their on/off check and a summary), with the same controls: patch browsing and stars from Settings → Keys (its own preset folders), New keys part, Any / 1 / 2 / 4 bars, transpose, the piano roll, Save (to the Keys & chords section), sidechain, and Keep part / patch. The Keys lane follows Bass: in drops; in breakdowns full, low-passed or out and in builds swept, low-passed or out (per track); never in the DJ intro and outro. Its own random stream, so turning Keys on doesn't change the drums or the bass's other choices. Arrange's right-click menu has the keys versions of the bass actions.

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

### Phase 6 — Bass (MIDI + Serum 2)
- §6.7: MIDI import, the Serum 2 host and preset loading, bass rendering, the patch pool in Settings, the Bass section in Generate, sidechain ducking, bass clips in Arrange, and the bass MIDI in the export.
- **Acceptance:** dropping a folder of bass MIDI imports every file with bars, key and role (duplicates skipped); with preset folders chosen, every generation has a Bass lane playing a newly written bassline (learned from the MIDI library) through a Serum 2 patch in the track key in every drop (low-passed or out elsewhere, by the track's rules); next/random patch or a new bassline is heard within a second once Serum is loaded; the bass ducks under the kick by the chosen amount in playback and export; Send to Arrange keeps the bass editable (transpose, patch, bassline); the export writes the bass as a stem and as `<Prefix>_Bass.mid`.

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
