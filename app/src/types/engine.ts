// Mirror of engine/drumvault_engine/schemas.py (RPC + results) and the SQLite
// rows written by engine/drumvault_engine/db.py. Keep both sides in sync.

export type Category =
  | "kick" | "clap" | "snare" | "hat" | "hat_closed" | "hat_open" | "ride" | "cymbal"
  | "shaker" | "perc" | "top" | "groove" | "drums" | "fill" | "roll" | "fx_riser" | "fx_downlifter"
  | "fx_impact" | "fx_sweep" | "fx_atmos" | "fx" | "melodic" | "full_mix" | "ignore";

export type ZipStatus =
  | "queued" | "processing" | "done" | "needs_review" | "error" | "skipped" | "cancelled";

/** event = fill, snare roll or FX: starts on a bar line, plays once (SCOPE.md §5.8a). */
export type SampleKind = "oneshot" | "loop" | "event";
export type StemRole = "tempo" | "key" | "oneshots" | "loops" | "events";

// ---------------------------------------------------------------------------
// Analysis results
// ---------------------------------------------------------------------------

export interface TempoInfo {
  bpm: number;
  raw_bpm: number;             // least-squares fit
  detected_bpm: number;        // detection result ignoring the user's override
  phase_samples: number;
  sample_rate: number;
  confidence: number;
  source_stem: string;
  source_category: string;
  grid_warning: boolean;
  bpm_warning: boolean;        // raw detection far from a whole number
  warnings: string[];
}

export interface KeyInfo {
  key: string | null;          // "A"
  scale: string | null;        // "minor" | "major"
  label: string | null;        // "Am"
  camelot: string | null;      // "8A"
  confidence: number;
  uncertain: boolean;
  backend: string;             // essentia | fallback | override | none
  source: string;              // melodic | full_mix | override | none
}

export interface StemInfo {
  id: number | null;
  file_name: string;
  category: Category;
  category_override: Category | null;
  auto_classified: boolean;
  classify_reason: string;
  duration_s: number;
  sample_rate: number;
  channels: number;
  used_for: StemRole[];
}

export interface ZipAnalysis {
  file_name: string;
  file_sha1: string;
  stems: StemInfo[];
  tempo: TempoInfo;
  key: KeyInfo;
  warnings: string[];
}

export interface SampleCounts {
  oneshots: number;
  loops: number;
  events: number;
}

export interface ProcessResult {
  zip_id: number | null;
  source_code: string | null;
  file_name: string;
  status: ZipStatus;
  counts: SampleCounts;
  analysis: ZipAnalysis | null;
  warnings: string[];
}

export interface Overrides {
  bpm?: number | null;
  grid_offset_ms?: number | null;
  key?: string | null;                        // "Fm"
  stems?: Record<string, Category>;           // stem id -> category
}

// ---------------------------------------------------------------------------
// RPC (JSON lines over the sidecar's stdin/stdout)
// ---------------------------------------------------------------------------

/** Mirrors `Settings` in engine/drumvault_engine/config.py (snake_case, all optional). */
export interface EngineSettings {
  library_path: string;
  library_bpm?: number;
  bpm_min?: number;
  bpm_max?: number;
  max_stretch?: number;
  integer_bpm?: boolean;
  output_sample_rate?: 44100 | 48000;
  output_format?: "pcm24" | "float32";
  loop_lengths?: Partial<Record<Category, number[]>>;
  max_oneshots_per_stem?: number;
  max_loops_per_length?: number;
  max_events_per_stem?: number;
  oneshot_peak_dbfs?: number;
  loop_norm_mode?: "peak" | "lufs";
  loop_peak_dbfs?: number;
  loop_lufs_target?: number;
  event_peak_dbfs?: number;
  oneshot_dedupe_threshold?: number;
  loop_dedupe_threshold?: number;
  event_dedupe_threshold?: number;
  rubberband_binary?: string;
  rubberband_options?: string[];
  rubberband_r3_flag?: string;
  workers?: number;
  thresholds?: Record<string, unknown>;
}

export type RpcRequest =
  | { id: string; method: "process_zip"; params: { path: string; settings: EngineSettings; reprocess?: boolean } }
  | { id: string; method: "reprocess_zip"; params: { zip_id: number; overrides?: Overrides; settings: EngineSettings } }
  | { id: string; method: "delete_zip"; params: { zip_id: number; delete_files?: boolean; settings: EngineSettings } }
  | { id: string; method: "rebuild_loops"; params: { settings: EngineSettings } }
  | { id: string; method: "analyze_zip"; params: { path: string; settings?: EngineSettings } }
  | { id: string; method: "cancel"; params: { job_id: string } }
  | { id: string; method: "set_sample_meta"; params: { sample_id: number; favorite?: boolean; rating?: number; tags?: string; settings: EngineSettings } }
  | { id: string; method: "health"; params: Record<string, never> }
  | { id: string; method: "shutdown"; params: Record<string, never> };

export interface RpcError {
  code: string;
  message: string;
}

export interface RpcResponse<T = unknown> {
  id: string | null;
  result?: T;
  error?: RpcError;
}

/** Immediate result of every job method (process/reprocess/delete/rebuild/analyze). */
export interface JobAccepted {
  job_id: string;
  queue_position: number;
}

export interface HealthResult {
  ok: boolean;
  version: string;
  python: string;
  rubberband: string | null;
  rubberband_r3: boolean;
  key_backend: "essentia" | "fallback";
  queue_length: number;
  current_job: string | null;
}

export interface ReadyEvent {
  event: "ready";
  version: string;
}

export interface ProgressEvent {
  event: "progress";
  job_id: string;
  zip: string;
  stage: "extract" | "classify" | "tempo" | "key" | "stems" | "write" | "done" | "rebuild";
  pct: number;   // 0..1
  message: string;
}

export interface JobDoneEvent {
  event: "job_done";
  job_id: string;
  zip_id: number | null;
  zip: string;
  status: ZipStatus;
  counts: SampleCounts;
  result: unknown;           // ProcessResult | ZipAnalysis | ProcessResult[] | delete summary
  error: RpcError | null;
}

export type EngineEvent = ReadyEvent | ProgressEvent | JobDoneEvent;

// ---------------------------------------------------------------------------
// SQLite rows (<Library>/.drumvault/library.sqlite, read-only from the app)
// ---------------------------------------------------------------------------

export interface ZipRow {
  id: number;
  source_code: string;          // "S0037"
  file_name: string;
  file_sha1: string;
  original_path: string;
  detected_bpm: number | null;   // detection result (whole number); effective = bpm_override ?? detected_bpm
  bpm_override: number | null;
  bpm_source_stem: string | null;
  phase_samples: number | null;
  grid_offset_override_ms: number | null;
  tempo_confidence: number | null;
  key_label: string | null;
  key_camelot: string | null;
  key_confidence: number | null;
  key_override: string | null;
  status: ZipStatus;
  warnings: string | null;      // JSON string[]
  processed_at: string | null;
  settings_hash: string | null;
}

export interface StemRow {
  id: number;
  zip_id: number;
  file_name: string;
  category: Category;
  category_override: Category | null;
  auto_classified: 0 | 1;
  duration_s: number;
  sample_rate: number;
  channels: number;
  used_for: string;             // JSON StemRole[]
}

export interface SampleRow {
  id: number;
  zip_id: number;
  stem_id: number;
  kind: SampleKind;
  category: Category;
  rel_path: string;
  bpm: number | null;
  bars: number | null;
  key_label: string | null;
  key_camelot: string | null;
  duration_s: number;
  sample_rate: number;
  channels: number;
  peak_db: number;
  gain_applied_db: number;
  source_offset_s: number;
  fingerprint: Uint8Array;      // float32 little-endian, L2-normalised log-mel
  favorite: 0 | 1;
  rating: number | null;
  tags: string | null;
  created_at: string;
}

/** <Library>/.drumvault/peaks/<sample_id>.json */
export interface PeaksFile {
  version: 1;
  kind: SampleKind;
  sample_rate: number;
  frames: number;
  bars: number | null;
  points: [number, number][];   // [min, max] of the mono downmix
}
