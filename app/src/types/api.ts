// The contract between the Electron main process and the renderer
// (exposed by electron/preload.ts as `window.drumvault`).

import type {
  Category, EngineSettings, GridPreview, HealthResult, Overrides, ProcessResult, RpcError, SampleKind,
  StemRow, ZipRow, ZipStatus,
} from './engine'
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

export type JobMethod = 'process_zip' | 'reprocess_zip' | 'delete_zip' | 'rebuild_loops'

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
  /** File dialog for zips and folders; folders are searched for zips. */
  chooseZips(): Promise<string[]>
  /** Absolute paths of dropped files/folders. */
  pathsForFiles(files: File[]): string[]
  /** Dropped files/folders -> zip paths (folders searched recursively). */
  expandPaths(paths: string[]): Promise<string[]>

  checkDeps(): Promise<DepsReport>
  engineStatus(): Promise<EngineStatus>
  restartEngine(): Promise<EngineStatus>
  onEngineStatus(cb: (s: EngineStatus) => void): () => void

  listJobs(): Promise<JobInfo[]>
  onJobs(cb: (jobs: JobInfo[]) => void): () => void
  processZips(paths: string[], reprocess?: boolean): Promise<void>
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
