"""RPC and result shapes shared with the app.

Mirrored by hand in `app/src/types/engine.ts` — keep both in sync.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

Category = Literal[
    "kick", "clap", "snare", "hat", "hat_closed", "hat_open", "ride", "cymbal", "shaker",
    "perc", "top", "groove", "drums", "fill", "roll", "fx_riser", "fx_downlifter", "fx_impact",
    "fx_sweep", "fx_atmos", "fx", "melodic", "full_mix", "ignore",
]
ZipStatus = Literal["queued", "processing", "done", "needs_review", "error", "skipped", "cancelled"]
SampleKind = Literal["oneshot", "loop", "event"]
StemRole = Literal["tempo", "key", "oneshots", "loops", "events"]


# ---------------------------------------------------------------------------
# Analysis results
# ---------------------------------------------------------------------------

class TempoInfo(BaseModel):
    bpm: float
    raw_bpm: float                     # least-squares fit
    detected_bpm: float = 0.0          # detection result ignoring the user's override
    phase_samples: int
    sample_rate: int
    confidence: float
    source_stem: str
    source_category: str
    grid_warning: bool = False
    bpm_warning: bool = False          # raw detection far from a whole number
    warnings: list[str] = Field(default_factory=list)


class KeyInfo(BaseModel):
    key: Optional[str] = None          # "A"
    scale: Optional[str] = None        # "minor" | "major"
    label: Optional[str] = None        # "Am"
    camelot: Optional[str] = None      # "8A"
    confidence: float = 0.0
    uncertain: bool = True
    backend: str = "none"              # essentia | fallback | override | none
    source: str = "none"               # melodic | full_mix | override | none


class StemInfo(BaseModel):
    id: Optional[int] = None           # DB id once indexed
    file_name: str                     # path inside the zip
    category: Category
    category_override: Optional[Category] = None
    auto_classified: bool = False
    classify_reason: str = ""
    duration_s: float
    sample_rate: int
    channels: int
    used_for: list[StemRole] = Field(default_factory=list)


class ZipAnalysis(BaseModel):
    file_name: str
    file_sha1: str
    stems: list[StemInfo]
    tempo: TempoInfo
    key: KeyInfo
    warnings: list[str] = Field(default_factory=list)
    # Where each part plays, bar by bar (arrangement.py); stored, not sent to the app.
    arrangement: Optional[dict[str, Any]] = Field(default=None, exclude=True)


class SampleCounts(BaseModel):
    oneshots: int = 0
    loops: int = 0
    events: int = 0


class ProcessResult(BaseModel):
    zip_id: Optional[int] = None
    source_code: Optional[str] = None
    file_name: str
    status: ZipStatus
    counts: SampleCounts = Field(default_factory=SampleCounts)
    analysis: Optional[ZipAnalysis] = None
    warnings: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Overrides (user corrections from the UI)
# ---------------------------------------------------------------------------

class Overrides(BaseModel):
    bpm: Optional[float] = None
    grid_offset_ms: Optional[float] = None
    key: Optional[str] = None                           # "Fm"
    stems: dict[str, Category] = Field(default_factory=dict)  # stem id (RPC) or file name -> category


# ---------------------------------------------------------------------------
# RPC envelopes (JSON lines over stdin/stdout)
# ---------------------------------------------------------------------------

Method = Literal["process_zip", "reprocess_zip", "import_samples", "delete_zip", "rebuild_loops", "analyze_library", "cancel", "health",
                 "analyze_zip", "set_sample_meta", "mark_reviewed", "grid_preview", "delete_samples", "restore_samples", "shift_sample", "stretch_samples", "import_midi",
                 "render_bass", "serum_presets", "save_midi", "set_midi_meta",
                 "delete_midi", "shutdown"]


class RpcRequest(BaseModel):
    id: str
    method: Method
    params: dict[str, Any] = Field(default_factory=dict)


class ProcessZipParams(BaseModel):
    path: str
    settings: dict[str, Any] = Field(default_factory=dict)
    reprocess: bool = False


class ImportSamplesParams(BaseModel):
    """Loose audio files or folders of them (Splice and other packs), SCOPE.md §5.16."""
    paths: list[str] = Field(min_length=1)
    settings: dict[str, Any] = Field(default_factory=dict)


class ReprocessZipParams(BaseModel):
    zip_id: int
    overrides: Overrides = Field(default_factory=Overrides)
    settings: dict[str, Any] = Field(default_factory=dict)


class DeleteZipParams(BaseModel):
    zip_id: int
    delete_files: bool = True
    settings: dict[str, Any] = Field(default_factory=dict)


class RebuildLoopsParams(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)


class CancelParams(BaseModel):
    job_id: str


class AnalyzeZipParams(BaseModel):
    path: str
    settings: dict[str, Any] = Field(default_factory=dict)


class MarkReviewedParams(BaseModel):
    """Clear a zip's needs-review flag (it stays cleared when the zip is reprocessed)."""
    zip_id: int
    settings: dict[str, Any] = Field(default_factory=dict)


class DeleteSamplesParams(BaseModel):
    """Delete single samples from the library; reprocessing their zip doesn't bring them back."""
    sample_ids: list[int]
    settings: dict[str, Any] = Field(default_factory=dict)


class RestoreSamplesParams(BaseModel):
    """Put deleted samples (removed_samples ids) back into the library from its trash."""
    removed_ids: list[int]
    settings: dict[str, Any] = Field(default_factory=dict)


class ShiftSampleParams(BaseModel):
    """Library "Move sound": rotate a loop or event `beats` later (negative: earlier) inside itself."""
    sample_id: int
    beats: int
    settings: dict[str, Any] = Field(default_factory=dict)


class StretchSamplesParams(BaseModel):
    """Time-stretch samples (library-relative paths) to a project tempo, cached per tempo."""
    rel_paths: list[str]
    bpm: float = Field(gt=40, lt=250)
    settings: dict[str, Any] = Field(default_factory=dict)


class ImportMidiParams(BaseModel):
    """Add MIDI files or folders of them to a section of the MIDI page (SCOPE.md §6.7)."""
    paths: list[str]
    role: Literal["bass", "keys"] = "bass"
    settings: dict[str, Any] = Field(default_factory=dict)


class RenderBassParams(BaseModel):
    """Render an imported MIDI part through a Serum 2 preset as a loop at `bpm`."""
    preset: str
    midi_id: int
    transpose: int = Field(default=0, ge=-24, le=24)
    bpm: float = Field(gt=40, lt=250)
    out_rel: str
    # Edited in the piano roll: these replace the imported file's notes / length.
    notes: Optional[list[list[float]]] = None
    bars: Optional[int] = Field(default=None, ge=1, le=16)
    # The track's groove: per 16th step of the bar, how late (16ths) notes starting there play.
    groove: Optional[list[float]] = Field(default=None, min_length=16, max_length=16)
    settings: dict[str, Any] = Field(default_factory=dict)


class SetMidiMetaParams(BaseModel):
    """Correct an imported MIDI file's role or key."""
    midi_id: int
    role: Optional[Literal["bass", "keys", "other"]] = None
    key_label: Optional[str] = None
    clear_key: bool = False
    settings: dict[str, Any] = Field(default_factory=dict)


class DeleteMidiParams(BaseModel):
    midi_ids: list[int]
    settings: dict[str, Any] = Field(default_factory=dict)


class SaveMidiParams(BaseModel):
    """Save an edited loop as a new MIDI file in the library."""
    name: str
    notes: list[list[float]]
    bars: int = Field(ge=1, le=16)
    key_label: Optional[str] = None
    role: Literal["bass", "keys", "other"] = "bass"
    settings: dict[str, Any] = Field(default_factory=dict)


class SerumPresetsParams(BaseModel):
    """Preset folders under `root` (with counts), and the presets in the chosen `folders`."""
    root: str
    folders: Optional[list[str]] = None
    settings: dict[str, Any] = Field(default_factory=dict)


class GridPreviewParams(BaseModel):
    """Sum a zip's drum stems into one preview file for the Grid view."""
    zip_id: int
    settings: dict[str, Any] = Field(default_factory=dict)


class GridPreview(BaseModel):
    zip_id: int
    path: str                      # absolute path of the mono preview WAV
    sample_rate: int
    duration_s: float
    bpm: float                     # the zip's tempo (override or detected)
    bar_one_ms: float              # where bar 1 starts in the stems now
    manual: bool                   # bar 1 was set by hand
    stems: list[str]               # the stems in the preview


class SetSampleMetaParams(BaseModel):
    """Favourite / rating / tags of one sample. Only the fields given are changed."""
    sample_id: int
    favorite: Optional[bool] = None
    rating: Optional[int] = Field(default=None, ge=0, le=5)   # 0 clears the rating
    tags: Optional[str] = None
    settings: dict[str, Any] = Field(default_factory=dict)


class RpcError(BaseModel):
    code: str
    message: str


class RpcResponse(BaseModel):
    id: str
    result: Optional[Any] = None
    error: Optional[RpcError] = None


class JobAccepted(BaseModel):
    job_id: str
    queue_position: int


class HealthResult(BaseModel):
    ok: bool
    version: str
    python: str
    rubberband: Optional[str]
    rubberband_r3: bool
    key_backend: str
    queue_length: int
    current_job: Optional[str] = None


class ProgressEvent(BaseModel):
    event: Literal["progress"] = "progress"
    job_id: str
    zip: str
    stage: str
    pct: float
    message: str = ""


class JobDoneEvent(BaseModel):
    event: Literal["job_done"] = "job_done"
    job_id: str
    zip_id: Optional[int] = None
    zip: str = ""
    status: ZipStatus
    counts: SampleCounts = Field(default_factory=SampleCounts)
    result: Optional[Any] = None
    error: Optional[RpcError] = None
