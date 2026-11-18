// The contract between the Electron main process and the renderer
// (exposed by electron/preload.ts as `window.drumvault`).

import type { Category, CleanRendersResult, EngineSettings, GridPreview, HealthResult, MasterResult, Overrides, PreflightResult, PreflightSection, ReferencesResult, ProcessResult, RpcError, SampleKind, StemRow, ZipRow, ZipStatus } from './engine'
import type { ProjectFileInfo } from './project'
import type { VocalMeta, VocalRequest } from '../vocals/plan'

/** Engine settings as stored by the app (the library path is kept separately). */
export type EngineOptions = Omit<EngineSettings, 'library_path'>

export interface AppSettings {
  libraryPath: string | null
  engine: EngineOptions
  /** Override for the engine folder (default: ../engine next to the app). */
  enginePath: string | null
  /** Override for the uv binary (default: found on PATH / Homebrew). */
  uvPath: string | null
  /** Arrange project opened last (file name in the projects folder). */
  lastProject: string | null
  /** Folder of the last stem export. */
  lastExportDir?: string | null
  /** The folder the Upload page lists exports from (SCOPE.md §6.5b); else the last export's, else the default. */
  uploadDir?: string | null
  /**
   * Serum 2's presets folder (SCOPE.md §6.7) the bass picks its folders under.
   */
  serumPresetRoot?: string
  /** Bass (SCOPE.md §6.7): Serum 2 presets to draw patches from, and the ones you starred. */
  bass?: BassSettings
  /** The Splice folder the Splice page looks through (SCOPE.md §6.12); ~/Splice when not set. */
  spliceFolder?: string | null
  /** The breakdown layer (SCOPE.md §6.7b): the Serum 2 folders with pad and reese patches. */
  pads?: { folders: string[] }
  /** Chord stabs (SCOPE.md §6.9): what Generate's step sequencer saved. */
  stabs?: StabsSettings
}

// ---- Upload to House of Tracks (SCOPE.md §6.5b) ---------------------------

/** The folders of an export that go to House of Tracks zipped. */
export type ZipPart = 'stems' | 'midi'

export interface UploadZip {
  path: string
  size: number
  /** Newer than every file in the folder it was made of. */
  fresh: boolean
}

/** What an export folder holds for the upload (absolute paths; null: not there). */
export interface UploadCheck {
  /** masters/mastered.wav, or a master renamed "… mastered.wav". */
  master: string | null
  masterInstrumental: string | null
  mixdown: string | null
  mixdownInstrumental: string | null
  /** WAVs in stems/, MIDI files in midi/. */
  stems: number
  midi: number
  info: boolean
  zips: Record<ZipPart, UploadZip | null>
}

/** An export folder (it has info.txt at its top). */
export interface UploadFolder {
  name: string
  path: string
  /** info.txt's text (parsed in the page: parseInfoText). */
  info: string
  /** When info.txt was written (ms). */
  modified: number
  check: UploadCheck
}

export interface ZipProgress {
  path: string
  part: ZipPart
  /** Bytes zipped of the folder's total. */
  done: number
  total: number
}

export type UploadStatus = 'none' | 'filled' | 'uploaded'

/** What is remembered of a track's upload, by export folder name (<Library>/.drumvault/uploads.json). */
export interface UploadRecord {
  status: UploadStatus
  /** Euros (PRICES); 299 until chosen. */
  price?: number
  /** The form's choices info.txt doesn't hold; their defaults until chosen. */
  genre?: string
  instrument?: string
  vocalCategory?: string
  /** ISO dates: when the form was last filled, when it was submitted. */
  filledAt?: string
  uploadedAt?: string
}

/** The values the upload form is filled with (as the form shows them; the main process maps them to the page). */
export interface HotFields {
  trackName: string
  bpm: string
  /** "F# minor" (the form's own name for it is found in the main process). */
  key: string
  genre: string
  description: string
  tags: string[]
  price: number
  instrument: string
  /** The form's "This track contains". */
  vocal: 'None' | 'Original' | 'Royalty Free' | 'AI Generated'
  vocalCategory: string
  lyrics: string
  /** A Royalty Free vocal's sample pack (name, and its page): '' when there's none. */
  vocalPack: string
  vocalPackUrl: string
}

export interface HotFillRequest {
  /** The export folder: its masters and zips are attached. */
  folder: string
  fields: HotFields
}

/** One field of the form after filling: what it was set to, and whether that took. */
export interface HotFillRow {
  field: string
  value: string
  ok: boolean
  note?: string
}

export interface HotFillResult {
  rows: HotFillRow[]
  /** Why nothing was filled (not logged in, the page didn't load). */
  error?: string
}

export interface BassSettings {
  /** The Serum 2 presets folder: the shared `serumPresetRoot` (stored here by older versions). */
  presetRoot: string
  /** Folders under presetRoot that make up the patch pool. */
  folders: string[]
  /** Starred presets (absolute paths): picked more often. */
  favorites: string[]
  /** Octave set for a preset in Generate (semitones, a multiple of 12, by path): kept for every next track. */
  octaves?: Record<string, number>
}

export interface StabsSettings {
  /** Rhythms saved in the step sequencer, that Generate learns from. */
  rhythms?: SavedStabRhythm[]
}

/** A chord stab rhythm saved in Generate's step sequencer (SCOPE.md §6.9): 1 or 2 bars of 16 steps (1 on, 0 off). */
export interface SavedStabRhythm {
  name: string
  steps: number[][]
}

/** An imported MIDI file (SCOPE.md §6.7). Notes: [start beats, length beats, pitch, velocity]. */
export interface MidiItem {
  id: number
  file_name: string
  name: string
  rel_path: string
  /** 'keys': a keys or chord part imported before keys parts were removed (never used). */
  role: 'bass' | 'keys' | 'other'
  bars: number
  key_label: string | null
  key_camelot: string | null
  notes: [number, number, number, number][]
  favorite: number
  /** The MIDI zip it came from ("83686"), and the processed stem zip of the same track (S0001). */
  source: string | null
  source_code: string | null
}

/** The ElevenLabs account (vocals, SCOPE.md §6.11): its plan and credits when the kept key works. */
export interface ElevenStatus {
  hasKey: boolean
  tier?: string
  credits?: { used: number; limit: number; resetsAt: string | null }
  error?: string
}

/** A disco hit (SCOPE.md §6.8): a stab or brass hit from the Disco Hits page, in <Library>/Disco Hits/. */
export interface HitItem {
  id: number
  /** A disco hit (the Disco Hits page), a chord stab (Chord Stabs), strings (Strings) or a bass one-shot (Bass Samples); older rows are disco hits, 'drone' rows unused. */
  kind: 'disco' | 'stab' | 'drone' | 'strings' | 'bass' | 'ambience'
  file_name: string
  name: string
  rel_path: string
  key_label: string | null
  key_camelot: string | null
  /** Where the key came from: the file name, the sound, or set by hand. */
  key_source: 'name' | 'detected' | 'manual' | null
  /** Semitones on top of the move into the track key (set with the pitch slider in Generate). */
  pitch_fix: number
  duration_s: number
  channels: number
  /** As SampleListItem.energy_db. */
  energy_db?: number | null
  /** As SampleListItem.tone. */
  tone?: number[] | null
  /** As SampleListItem.punch_db (schema v16; null until measured): the level a stab is set by, hit for hit. */
  punch_db?: number | null
  /** How many notes it plays (schema v16; null until measured): 1–2 a single note, 3 or more a chord. */
  voices?: number | null
  /** An Ambience texture (schema v18; null until measured): 1 a tonal bed (always pitched into the track key), 0 noise (never). */
  tonal?: number | null
}

/** What an import of Splice vocal loops did (vocalloop.import_loops). */
export interface VocalLoopImport {
  imported: { id: string; name: string; key: string | null; bpm: number | null; bars: number | null; url: string | null }[]
  skipped: number
  failed: string[]
}

/** A sound in the Splice folder that could go on one of the music pages (SCOPE.md §6.12). */
export interface SpliceCandidate {
  /** Absolute path of the file in the Splice folder. */
  path: string
  name: string
  /** The pack it is from (its folder under "packs"). */
  pack: string
  duration_s: number
  channels: number
  /** The key in its name ("Dm"), or only its root ("F": the scale is read from the sound on import). */
  key_label: string | null
  key_source: 'name' | 'root' | null
  /** A tempo in its name. */
  bpm: number | null
  /** The page it is suggested for, and why. */
  kind: 'stab' | 'disco' | 'strings' | 'bass' | 'ambience' | 'vocal'
  why: string
  /** The page it is on already. */
  imported: 'stab' | 'disco' | 'strings' | 'bass' | 'ambience' | 'vocal' | null
}

export interface SpliceScan {
  folder: string
  /** False when the folder doesn't exist. */
  found: boolean
  /** Audio files looked at. */
  files: number
  candidates: SpliceCandidate[]
}

export interface HitImportResult {
  imported: { id: number; file_name: string; key_label: string | null; key_source: string | null }[]
  skipped: number
  failed: string[]
  warnings: string[]
}

export interface SerumPreset {
  path: string
  name: string
  folder: string
  tags: string[]
  /** Sample files it names that aren't on this Mac (made on another computer): left out of the pools. */
  missing?: number
  /** Mono with legato and portamento: an overlapping next note glides (a bassline may slide on it). */
  glide?: boolean
  /**
   * Not a Serum preset but a Bass Samples page one-shot (SCOPE.md §6.7a): `path` is its
   * library-relative file, and the engine plays the bassline with it like a sampler.
   */
  sample?: boolean
}

export interface MidiImportResult {
  imported: { id: number; file_name: string; role: string; bars: number; key_label: string | null }[]
  skipped: number
  /** A zip's parts not named for the section (they only helped find its key). */
  ignored: number
  failed: string[]
}

// ---------------------------------------------------------------------------
// Engine process + jobs
// ---------------------------------------------------------------------------

export type EngineState = 'stopped' | 'starting' | 'ready' | 'crashed' | 'missing'

export interface EngineStatus {
  state: EngineState
  message: string
  health: HealthResult | null
  restarts: number
}

export interface DepCheck {
  name: string
  ok: boolean
  detail: string
  fix?: string
}

export interface DepsReport {
  ok: boolean
  checks: DepCheck[]
}

export type JobMethod = 'process_zip' | 'import_samples' | 'reprocess_zip' | 'delete_zip' | 'rebuild_loops' | 'analyze_library'

export interface JobInfo {
  job_id: string
  method: JobMethod
  label: string
  path: string | null
  zip_id: number | null
  status: ZipStatus
  stage: string
  pct: number
  message: string
  result: ProcessResult | null
  error: RpcError | null
  created: number
  finished: number | null
}

// ---------------------------------------------------------------------------
// Library (read-only SQLite)
// ---------------------------------------------------------------------------

export type SampleSort = 'name' | 'newest' | 'category' | 'key' | 'rating'

export interface SampleFilter {
  kind?: SampleKind | null
  categories?: Category[]
  /** Key labels ("Am", "F#"); "NoKey" selects samples without a key. */
  keys?: string[]
  /** Also include Camelot-compatible keys of the selected ones. */
  compatible?: boolean
  bars?: number[]
  zipIds?: number[]
  favoritesOnly?: boolean
  search?: string
  sort?: SampleSort
}

export interface SampleListItem {
  id: number
  rel_path: string
  name: string
  kind: SampleKind
  category: Category
  bpm: number | null
  bars: number | null
  /** Events: bars until the main sound ends (tail excluded); null for other kinds or old libraries. */
  body_bars: number | null
  key_label: string | null
  key_camelot: string | null
  duration_s: number
  channels: number
  favorite: number
  rating: number | null
  tags: string | null
  zip_id: number
  source_code: string
  /** Loops: timing and accents per 16th (engine groove.py); null if not measured or none found. */
  groove?: LoopGroove | null
  /** Events: how it plays (engine events.shape); null until measured. */
  shape?: EventShape | null
  /**
   * How loud it plays (schema v13; null until measured): K-weighted energy of its mono mix in dB,
   * LUFS + 10·log10(seconds). Played for T seconds it is `energy_db − 10·log10(T)` LUFS loud.
   */
  energy_db?: number | null
  /** Its tone (schema v14; null until measured): power in the engine's 24 bands (40 Hz–16 kHz), dB against its total. */
  tone?: number[] | null
  /**
   * How hard it hits (schema v15; null until measured): the K-weighted level (as LUFS) of its
   * loudest 200 ms. Against `energy_db` it tells a snappy hit from a washy one.
   */
  punch_db?: number | null
}

/**
 * How an event plays, in 16ths from its start (the bar line it was cut on): where its sound
 * starts, peaks and ends, the silence from there to the end of its body (`gap`: the producer's
 * moment of silence before the drop), which way it goes, how noisy it is (0 a tone … 1 white
 * noise) and the bar of its source track its body ends on (null for loose samples).
 */
export interface EventShape {
  onset: number
  end: number
  gap: number
  peak: number
  dir: 'rise' | 'fall' | 'hit' | 'flat'
  noise: number
  boundary: number | null
}

/**
 * A loop's groove, per 16th step of the bar: how late (+) or early its hits land, in fractions
 * of a 16th, and how loud (dB below the loudest step); null where it plays nothing.
 */
export interface LoopGroove {
  offsets: (number | null)[]
  levels: (number | null)[]
  hits: number[]
  /** Mean offset of the odd 16ths (MPC swing: +0.33 = 66 %), and of the offbeat 8ths. */
  swing: number | null
  push: number | null
}

/**
 * Where each part plays in a processed track, bar by bar on its own grid (engine arrangement.py):
 * per part (kick, clap, hats, ride, perc, top, crash, fills, fx, bass, music) a string with one
 * character per bar: 0 silent, 1 quiet or filtered, 2 full.
 */
export interface TrackArrangement {
  zip_id: number
  source_code: string
  bpm: number
  bars: number
  parts: Record<string, string>
  /**
   * The producer's rides, per part and bar (schema v11; absent until measured): dB against the
   * part's full level, and brightness in octaves against its full bars (below 0 darker, a low-pass;
   * above, thinner, a high-pass). Null where the part is silent.
   */
  detail?: Record<string, { db: (number | null)[]; bright: (number | null)[] }> | null
  /**
   * The producer's balance (schema v13; absent until measured): each part's K-weighted loudness
   * (LUFS of its mono mix) in its full bars. `normalized`: the stems were normalised one by one,
   * so the balance isn't the producer's.
   */
  levels?: {
    parts: Record<string, number>; normalized: boolean; spectra?: Record<string, number[]>
    /** Where the track sings (its vocal stems, apart from the parts): bars "0"/"1"/"2" and the loudness of its full bars (LUFS). */
    vocal?: { bars: string; lufs: number | null }
    /** The vocals were looked for (absent: measured before; no `vocal`: it doesn't sing). */
    vocals_measured?: boolean
    /**
     * Each hit part's loudest hit (absent: measured before): the K-weighted level of its loudest
     * 200 ms, as `punch_db`. Parts: kick, clap, crash, fills, fx (risers, sweeps), impact (impacts,
     * downlifters), stab (music stems named as stabs or chord hits).
     */
    hits?: Record<string, number>
  } | null
}

export interface LibraryFacets {
  total: number
  categories: { kind: SampleKind; category: Category; count: number }[]
  keys: { label: string | null; camelot: string | null; count: number }[]
  bars: number[]
  zips: { id: number; source_code: string; file_name: string; count: number }[]
  loopBpms: number[]
}

export interface ZipListItem extends ZipRow {
  oneshots: number
  loops: number
  events: number
}

/** A sample deleted from the library (Library → Deleted), restorable from the library's trash. */
export interface RemovedSample {
  id: number               // removed_samples id
  zip_id: number
  source_code: string
  name: string
  kind: SampleKind
  category: Category | null
  bars: number | null
  key_label: string | null
  key_camelot: string | null
  duration_s: number | null
  removed_at: string | null
  /** Library-relative path of the trashed WAV; null if none was kept (it comes back on reprocess). */
  trash_path: string | null
}

export interface ZipDetail {
  zip: ZipListItem
  stems: StemRow[]
  warnings: string[]
  originalExists: boolean
  /** The library has its own copy (SCOPE.md §5.8d): reprocessing works without the original. */
  originalKept: boolean
}

export type PeakPoints = [number, number][]

export interface SampleMeta {
  favorite?: boolean
  rating?: number
  tags?: string
}

// ---------------------------------------------------------------------------
// window.drumvault
// ---------------------------------------------------------------------------

export interface DrumvaultAPI {
  platform: string

  getSettings(): Promise<AppSettings>
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  chooseLibraryFolder(): Promise<string | null>
  /** File dialog for zips, loose samples and folders (the chosen paths, not yet searched). */
  chooseZips(): Promise<string[]>
  /** Absolute paths of dropped files/folders. */
  pathsForFiles(files: File[]): string[]
  /** Dropped files/folders -> zip paths (folders searched recursively). */
  expandPaths(paths: string[]): Promise<string[]>
  /** Dropped files/folders -> loose audio files in them (.wav, .aif, .aiff, .flac). */
  findSamples(paths: string[]): Promise<string[]>

  checkDeps(): Promise<DepsReport>
  engineStatus(): Promise<EngineStatus>
  restartEngine(): Promise<EngineStatus>
  onEngineStatus(cb: (s: EngineStatus) => void): () => void

  listJobs(): Promise<JobInfo[]>
  onJobs(cb: (jobs: JobInfo[]) => void): () => void
  processZips(paths: string[], reprocess?: boolean): Promise<void>
  /** Loose samples or folders of them, added as packs (P0001…). */
  importSamples(paths: string[]): Promise<void>
  reprocessZip(zipId: number, overrides: Overrides): Promise<void>
  deleteZip(zipId: number): Promise<void>
  rebuildLoops(): Promise<void>
  cancelJob(jobId: string): Promise<void>
  clearFinishedJobs(): Promise<void>
  setSampleMeta(sampleId: number, meta: SampleMeta): Promise<void>
  /** Clear a zip's needs-review flag (it stays cleared when the zip is reprocessed). */
  markReviewed(zipId: number): Promise<void>

  /** Delete samples (files and index); reprocessing their zip doesn't bring them back. Returns the count. */
  deleteSamples(sampleIds: number[]): Promise<number>
  /** Library "Move sound": rotate a loop/event `beats` later inside itself. Returns the total shift. */
  shiftSample(sampleId: number, beats: number): Promise<number>
  /** A loop/event's current shift in beats (0..length-1). */
  sampleShift(sampleId: number): Promise<number>
  /** Stretch samples to a project tempo (cached per tempo); resolves when the files exist. */
  stretchSamples(relPaths: string[], bpm: number): Promise<void>
  /**
   * Add basslines to learn from (the MIDI page) from .mid files, MIDI zips and folders: every
   * file is a bassline (from a zip of several parts, the ones named for the bass).
   */
  importMidi(paths: string[]): Promise<MidiImportResult>
  /** File dialog for MIDI zips, .mid files and folders. */
  chooseMidi(): Promise<string[]>
  /** Correct a bassline's key (null: no key, so it isn't transposed). */
  setMidiKey(midiId: number, key: string | null): Promise<void>
  deleteMidi(midiIds: number[]): Promise<void>
  /** Imported MIDI files. */
  listMidi(): Promise<MidiItem[]>
  /** Add disco hits from audio files, folders and zips (SCOPE.md §6.8). */
  importHits(paths: string[], kind?: HitItem['kind']): Promise<HitImportResult>
  /** File dialog for disco hits: audio files, folders, zips. */
  chooseHits(title?: string): Promise<string[]>
  /** Look through the Splice folder (the saved one, else ~/Splice) for sounds for the music pages. Reads only. */
  scanSplice(): Promise<SpliceScan>
  /** Pick another Splice folder (saved in the settings); null when cancelled. */
  chooseSpliceFolder(): Promise<string | null>
  /** A file in the Splice folder, to listen to it. */
  readSplice(path: string): Promise<ArrayBuffer>
  /** Correct a hit's key (null: no key, never moved into the track key). */
  setHitKey(hitId: number, key: string | null): Promise<void>
  /** The semitones a hit plays off from the track key, −12…12 (a key read wrong, fixed once). */
  setHitPitch(hitId: number, pitchFix: number): Promise<void>
  deleteHits(hitIds: number[]): Promise<void>
  listHits(): Promise<HitItem[]>
  /** Every processed track's arrangement (the Generate view's structure templates). */
  arrangements(): Promise<TrackArrangement[]>
  /** Preset folders under `root` with counts, and the presets in `folders`. */
  serumPresets(root: string, folders: string[] | null): Promise<{ folders: { folder: string; count: number }[]; presets: SerumPreset[] }>
  /** Render a MIDI part through a Serum 2 preset as a loop at `bpm` into `outRel` (cached). */
  renderBass(p: { preset: string; midiId: number; transpose: number; bpm: number; outRel: string;
    notes?: [number, number, number, number][]; bars?: number; groove?: number[] }): Promise<void>
  /** Save an edited bassline to the MIDI library; returns its id. */
  saveMidi(p: { name: string; notes: [number, number, number, number][]; bars: number; keyLabel: string | null }): Promise<number>
  /** Deleted samples, newest first. */
  listRemoved(): Promise<RemovedSample[]>
  /** Put deleted samples back. `pending`: had no trashed file; they return on the next reprocess. */
  restoreSamples(removedIds: number[]): Promise<{ restored: number; pending: number }>
  /** A zip's drum stems summed to one file (Grid view), with the bar 1 it was cut on. */
  gridPreview(zipId: number): Promise<{ info: GridPreview; data: ArrayBuffer }>

  onLibraryChanged(cb: () => void): () => void
  listZips(): Promise<ZipListItem[]>
  zipDetail(zipId: number): Promise<ZipDetail | null>
  querySamples(filter: SampleFilter): Promise<SampleListItem[]>
  facets(): Promise<LibraryFacets>
  peaks(sampleId: number, points: number): Promise<PeakPoints | null>
  readSample(relPath: string): Promise<ArrayBuffer>

  revealSample(relPath: string): Promise<void>
  revealZip(zipId: number): Promise<boolean>
  openLibraryFolder(): Promise<void>
  /** Start a native drag of the sample file (to Finder / Logic). */
  startDrag(relPath: string): void
  /** Current library rows for these paths (sample ids change when a zip is reprocessed). */
  samplesByPath(relPaths: string[]): Promise<SampleListItem[]>

  /** Generate's shortlist (starred generations, JSON), or null before the first star. */
  readShortlist(): Promise<string | null>
  writeShortlist(text: string): Promise<void>
  listProjects(): Promise<ProjectFileInfo[]>
  readProject(file: string): Promise<string>
  /** Returns the file name used (it follows the project name). */
  writeProject(previousFile: string | null, name: string, text: string): Promise<string>
  deleteProject(file: string): Promise<void>

  /** Folder dialog for stem export. */
  chooseExportFolder(defaultPath: string | null): Promise<string | null>
  /** Default export folder (~/Music/Drumvault Exports). */
  defaultExportFolder(): Promise<string>
  /** Which of `names` already exist in `dir`. */
  existingFiles(dir: string, names: string[]): Promise<string[]>
  writeExportFile(dir: string, name: string, data: ArrayBuffer): Promise<void>
  /** Master `mix` (a .wav in `dir`) through Ozone 11 into `out` next to it, on the loudness target. */
  masterMixdown(dir: string, mix: string, out: string, format: 'pcm24' | 'float32'): Promise<MasterResult>
  /**
   * The pre-flight (SCOPE.md §6.5a): `mix` and the master made from it (both .wav in `dir`; no
   * `master`, the mixdown alone) measured and checked. `sections`: a generated track's, in bars
   * from the file's start; `whole`: the files are the whole track, not a loop region.
   */
  preflight(dir: string, mix: string, master: string | null, o: { bpm: number; sections: PreflightSection[] | null; key: string | null; whole: boolean }): Promise<PreflightResult>
  /** The reference tracks in `<Library>/References`; with `analyze`, new files are measured first (some seconds each). */
  scanReferences(analyze: boolean): Promise<ReferencesResult>
  /**
   * The bass and strings renders (and older tracks' keys, stab and drone ones) and stretched FX
   * that aren't in `keep` (library-relative) nor made in the last 10 minutes: deleted, or with
   * `dryRun` only counted.
   */
  cleanRenders(keep: string[], dryRun: boolean): Promise<CleanRendersResult>
  /** ElevenLabs: whether a key is kept (in the keychain), and the plan and credits it has. */
  elevenStatus(): Promise<ElevenStatus>
  setElevenKey(key: string): Promise<ElevenStatus>
  clearElevenKey(): Promise<void>
  /** Make a vocal take with ElevenLabs (it costs credits) into <Library>/Vocals/<id>/. */
  makeVocal(req: VocalRequest): Promise<VocalMeta>
  listVocals(): Promise<VocalMeta[]>
  /** Remove a vocal take and its folder. */
  deleteVocal(id: string): Promise<void>
  /** Find a take's phrase loops and key (takes made before the engine did). */
  analyzeVocal(id: string): Promise<VocalMeta>
  /** These takes were exported in `track` (House of Tracks takes each vocal once). */
  markVocalsUsed(ids: string[], track: string): Promise<void>
  /** Splice vocal loops and phrases made into takes (SCOPE.md §6.11a); files already there are skipped. */
  importVocalLoops(paths: string[]): Promise<VocalLoopImport>
  /** A Splice loop's pack link set by hand (null: none). */
  setVocalUrl(id: string, url: string | null): Promise<void>
  /** A take offered to new tracks again (its export thrown away). */
  unuseVocal(id: string): Promise<void>
  revealPath(path: string): Promise<void>

  /** Folder dialog for the Upload page's exports. */
  chooseUploadFolder(defaultPath: string | null): Promise<string | null>
  /** The export folders in `dir`, newest first (SCOPE.md §6.5b). */
  listExports(dir: string): Promise<UploadFolder[]>
  checkExport(path: string): Promise<UploadCheck>
  /** Zip the export's stems/ and midi/ (those without a fresh zip) next to them; progress on onZipProgress. */
  zipExport(path: string): Promise<UploadCheck>
  cancelZip(path: string): Promise<void>
  onZipProgress(cb: (p: ZipProgress) => void): () => void
  uploadRecords(): Promise<Record<string, UploadRecord>>
  setUploadRecord(name: string, patch: Partial<UploadRecord>): Promise<UploadRecord>
  /** House of Tracks' upload page in its own window (its login kept). */
  hotOpen(): Promise<void>
  /** Fill the upload form and attach the files. Never submits it. */
  hotFill(req: HotFillRequest): Promise<HotFillResult>
  /** Dev only: every field of the page as it is now, written to a JSON file; returns its path. */
  hotDump(): Promise<string>
  /** House of Tracks' window: a page loaded (its URL), or the window closed (null). */
  onHotPage(cb: (url: string | null) => void): () => void
  /** A splice.com page (a pack's) in the browser. */
  openSplice(url: string): Promise<void>
  /** Open a folder in Finder; resolves to an error message, or '' when it opened. */
  openFolder(path: string): Promise<string>
  /** Nearest neighbours by fingerprint (same kind, category and loop length). */
  similarSamples(sampleId: number, limit: number): Promise<(SampleListItem & { similarity: number })[]>

  /** Commands from the application menu ("add-zips", "view:library", …). */
  onMenu(cb: (cmd: string) => void): () => void
}
