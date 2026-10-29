// The contract between the Electron main process and the renderer
// (exposed by electron/preload.ts as `window.drumvault`).

import type { Category, EngineSettings, GridPreview, HealthResult, Overrides, ProcessResult, RpcError, SampleKind, StemRow, ZipRow, ZipStatus } from './engine'
import type { ProjectFileInfo } from './project'

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
  /** Bass (SCOPE.md §6.7): Serum 2 presets to draw patches from, and the ones you starred. */
  bass?: BassSettings
}

export interface BassSettings {
  /** The Serum 2 presets folder. */
  presetRoot: string
  /** Folders under presetRoot that make up the patch pool. */
  folders: string[]
  /** Starred presets (absolute paths): picked more often. */
  favorites: string[]
}

/** An imported MIDI file (SCOPE.md §6.7). Notes: [start beats, length beats, pitch, velocity]. */
export interface MidiItem {
  id: number
  file_name: string
  name: string
  rel_path: string
  role: 'bass' | 'other'
  bars: number
  key_label: string | null
  key_camelot: string | null
  notes: [number, number, number, number][]
  favorite: number
  /** The MIDI zip it came from ("83686"), and the processed stem zip of the same track (S0001). */
  source: string | null
  source_code: string | null
}

export interface SerumPreset {
  path: string
  name: string
  folder: string
  tags: string[]
}

export interface MidiImportResult {
  imported: { id: number; file_name: string; role: string; bars: number; key_label: string | null }[]
  skipped: number
  /** Parts that aren't basslines (only bass MIDI is kept). */
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
  /** Add bass MIDI from .mid files, MIDI zips and folders; already imported ones are skipped. */
  importMidi(paths: string[]): Promise<MidiImportResult>
  /** File dialog for MIDI zips, .mid files and folders. */
  chooseMidi(): Promise<string[]>
  /** Correct a bassline's key (null: no key, so it isn't transposed). */
  setMidiKey(midiId: number, key: string | null): Promise<void>
  deleteMidi(midiIds: number[]): Promise<void>
  /** Imported MIDI files. */
  listMidi(): Promise<MidiItem[]>
  /** Every processed track's arrangement (the Generate view's structure templates). */
  arrangements(): Promise<TrackArrangement[]>
  /** Preset folders under `root` with counts, and the presets in `folders`. */
  serumPresets(root: string, folders: string[] | null): Promise<{ folders: { folder: string; count: number }[]; presets: SerumPreset[] }>
  /** Render a MIDI part through a Serum 2 preset as a loop at `bpm` into `outRel` (cached). */
  renderBass(p: { preset: string; midiId: number; transpose: number; bpm: number; outRel: string;
    notes?: [number, number, number, number][]; bars?: number; groove?: number[] }): Promise<void>
  /** Save an edited loop as a new bassline in the MIDI library; returns its id. */
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
  revealPath(path: string): Promise<void>
  /** Nearest neighbours by fingerprint (same kind, category and loop length). */
  similarSamples(sampleId: number, limit: number): Promise<(SampleListItem & { similarity: number })[]>

  /** Commands from the application menu ("add-zips", "view:library", …). */
  onMenu(cb: (cmd: string) => void): () => void
}
