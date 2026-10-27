"""RPC and result shapes shared with the app.

Mirrored by hand in `app/src/types/engine.ts` — keep both in sync.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

Category = Literal[
    "kick", "clap", "snare", "hat", "hat_closed", "hat_open", "ride", "cymbal", "shaker",
    "perc", "top", "groove", "drums", "melodic", "full_mix", "ignore",
]
ZipStatus = Literal["queued", "processing", "done", "needs_review", "error", "skipped", "cancelled"]
SampleKind = Literal["oneshot", "loop"]
StemRole = Literal["tempo", "key", "oneshots", "loops"]


# ---------------------------------------------------------------------------
# Analysis results
# ---------------------------------------------------------------------------

class TempoInfo(BaseModel):
    bpm: float
    raw_bpm: float
    phase_samples: int
    sample_rate: int
    confidence: float
    source_stem: str
    source_category: str
    grid_warning: bool = False
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


class SampleCounts(BaseModel):
    oneshots: int = 0
    loops: int = 0


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

Method = Literal["process_zip", "reprocess_zip", "delete_zip", "rebuild_loops", "cancel", "health",
                 "analyze_zip", "shutdown"]


class RpcRequest(BaseModel):
    id: str
    method: Method
    params: dict[str, Any] = Field(default_factory=dict)


class ProcessZipParams(BaseModel):
    path: str
    settings: dict[str, Any] = Field(default_factory=dict)
    reprocess: bool = False


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
