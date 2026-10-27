"""JSON-lines RPC server (SCOPE.md §5.14).

Requests arrive on stdin, one JSON object per line. Long-running methods are
queued and processed one at a time by a worker thread; they answer at once
with a job id and report through `progress` / `job_done` events. Only RPC
messages are written to the protocol stream; everything else goes to stderr.
"""

from __future__ import annotations

import json
import logging
import os
import platform
import sys
import threading
import traceback
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, TextIO

from pydantic import ValidationError

from . import __version__, key as keymod, pipeline, stretch
from .config import Settings
from .schemas import (
    AnalyzeZipParams, CancelParams, DeleteZipParams, HealthResult, JobAccepted, JobDoneEvent,
    ProcessZipParams, ProgressEvent, RebuildLoopsParams, ReprocessZipParams, RpcError, RpcRequest,
    SampleCounts, SetSampleMetaParams,
)
from .db import LibraryDB

log = logging.getLogger(__name__)

JOB_METHODS = {"process_zip", "reprocess_zip", "delete_zip", "rebuild_loops", "analyze_zip"}


@dataclass
class Job:
    job_id: str
    method: str
    params: Any
    label: str
    cancelled: threading.Event = field(default_factory=threading.Event)


class RpcServer:
    def __init__(self, out: TextIO):
        self._out = out
        self._out_lock = threading.Lock()
        self._queue: deque[Job] = deque()
        self._cond = threading.Condition()
        self._current: Job | None = None
        self._stopping = False
        self._worker = threading.Thread(target=self._work, name="drumvault-worker", daemon=True)

    # ---- output ------------------------------------------------------------
    def send(self, obj: Any) -> None:
        if hasattr(obj, "model_dump"):
            obj = obj.model_dump(mode="json", exclude_none=False)
        line = json.dumps(obj, separators=(",", ":"), default=str)
        with self._out_lock:
            self._out.write(line + "\n")
            self._out.flush()

    def _reply(self, req_id: str, result: Any) -> None:
        if hasattr(result, "model_dump"):
            result = result.model_dump(mode="json")
        self.send({"id": req_id, "result": result})

    def _error(self, req_id: str | None, code: str, message: str) -> None:
        self.send({"id": req_id, "error": {"code": code, "message": message}})

    # ---- input -------------------------------------------------------------
    def serve(self, inp: TextIO) -> None:
        self._worker.start()
        for line in inp:
            line = line.strip()
            if not line:
                continue
            self.handle_line(line)
            if self._stopping:
                break
        self.stop(wait=self._stopping)

    def stop(self, wait: bool) -> None:
        with self._cond:
            self._stopping = True
            if not wait:
                for j in self._queue:
                    j.cancelled.set()
                if self._current:
                    self._current.cancelled.set()
            self._cond.notify_all()
        if self._worker.is_alive():
            self._worker.join(timeout=None if wait else 30)

    def handle_line(self, line: str) -> None:
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as e:
            self._error(None, "parse_error", str(e))
            return
        req_id = raw.get("id") if isinstance(raw, dict) else None
        try:
            req = RpcRequest.model_validate(raw)
        except ValidationError as e:
            self._error(req_id, "bad_request", _short(e))
            return
        try:
            self.dispatch(req)
        except ValidationError as e:
            self._error(req.id, "bad_params", _short(e))
        except Exception as e:  # pragma: no cover - defensive
            log.exception("request failed")
            self._error(req.id, "internal", f"{type(e).__name__}: {e}")

    def dispatch(self, req: RpcRequest) -> None:
        m = req.method
        if m == "health":
            self._reply(req.id, self.health())
        elif m == "cancel":
            p = CancelParams.model_validate(req.params)
            self._reply(req.id, {"job_id": p.job_id, "cancelled": self.cancel(p.job_id)})
        elif m == "set_sample_meta":
            # Immediate (not queued): starring a sample must not wait for a running zip.
            p = SetSampleMetaParams.model_validate(req.params)
            settings = Settings.from_dict(p.settings)
            if not settings.library_path:
                self._error(req.id, "no_library", "No library folder configured")
                return
            with LibraryDB(settings.library_path) as db:
                ok = db.set_sample_meta(p.sample_id, p.favorite, p.rating, p.tags)
            if ok:
                self._reply(req.id, {"sample_id": p.sample_id})
            else:
                self._error(req.id, "not_found", f"No sample with id {p.sample_id}")
        elif m == "shutdown":
            self._reply(req.id, {"ok": True})
            self._stopping = True
        elif m in JOB_METHODS:
            model = {"process_zip": ProcessZipParams, "reprocess_zip": ReprocessZipParams,
                     "delete_zip": DeleteZipParams, "rebuild_loops": RebuildLoopsParams,
                     "analyze_zip": AnalyzeZipParams}[m]
            params = model.model_validate(req.params)
            label = getattr(params, "path", None) or (f"zip {params.zip_id}" if hasattr(params, "zip_id")
                                                      else "library")
            job = Job(job_id=str(uuid.uuid4()), method=m, params=params, label=os.path.basename(str(label)))
            with self._cond:
                self._queue.append(job)
                pos = len(self._queue) + (1 if self._current else 0)
                self._cond.notify_all()
            self._reply(req.id, JobAccepted(job_id=job.job_id, queue_position=pos))
        else:  # pragma: no cover - guarded by the schema
            self._error(req.id, "unknown_method", m)

    # ---- jobs --------------------------------------------------------------
    def health(self) -> HealthResult:
        info = stretch.rubberband_info()
        return HealthResult(
            ok=info.path is not None, version=__version__, python=platform.python_version(),
            rubberband=info.version, rubberband_r3=info.supports_r3,
            key_backend="essentia" if keymod.essentia_available() else "fallback",
            queue_length=len(self._queue), current_job=self._current.job_id if self._current else None)

    def cancel(self, job_id: str) -> bool:
        with self._cond:
            for j in list(self._queue):
                if j.job_id == job_id:
                    self._queue.remove(j)
                    self.send(JobDoneEvent(job_id=j.job_id, zip=j.label, status="cancelled"))
                    return True
            if self._current and self._current.job_id == job_id:
                self._current.cancelled.set()
                return True
        return False

    def _work(self) -> None:
        while True:
            with self._cond:
                while not self._queue and not self._stopping:
                    self._cond.wait()
                if not self._queue:
                    return
                job = self._queue.popleft()
                self._current = job
            try:
                self._run(job)
            finally:
                with self._cond:
                    self._current = None

    def _ctx(self, job: Job) -> pipeline.JobContext:
        def progress(stage: str, pct: float, msg: str) -> None:
            self.send(ProgressEvent(job_id=job.job_id, zip=job.label, stage=stage,
                                    pct=round(float(pct), 4), message=msg))
        return pipeline.JobContext(progress=progress, is_cancelled=job.cancelled.is_set)

    def _run(self, job: Job) -> None:
        ctx = self._ctx(job)
        p = job.params
        try:
            settings = Settings.from_dict(p.settings)
            if job.method == "process_zip":
                r = pipeline.process_zip(p.path, settings, reprocess=p.reprocess, ctx=ctx)
                self._done(job, r.status, r.zip_id, r.counts, r)
            elif job.method == "reprocess_zip":
                r = pipeline.process_zip(None, settings, zip_id=p.zip_id, overrides=p.overrides, ctx=ctx)
                self._done(job, r.status, r.zip_id, r.counts, r)
            elif job.method == "analyze_zip":
                a = pipeline.analyze_zip(p.path, settings, ctx=ctx)
                self._done(job, "done", None, SampleCounts(), a)
            elif job.method == "delete_zip":
                r = pipeline.delete_zip(settings, p.zip_id, p.delete_files)
                self._done(job, "done", p.zip_id, SampleCounts(), r)
            elif job.method == "rebuild_loops":
                rs = pipeline.rebuild_loops(settings, ctx=ctx)
                counts = SampleCounts(oneshots=sum(r.counts.oneshots for r in rs),
                                      loops=sum(r.counts.loops for r in rs))
                status = "done" if all(r.status in ("done", "needs_review") for r in rs) else "needs_review"
                self._done(job, status, None, counts, [r.model_dump(mode="json") for r in rs])
        except pipeline.Cancelled:
            self.send(JobDoneEvent(job_id=job.job_id, zip=job.label, status="cancelled"))
        except pipeline.PipelineError as e:
            self.send(JobDoneEvent(job_id=job.job_id, zip=job.label, status="error",
                                   error=RpcError(code=e.code, message=str(e))))
        except Exception as e:
            log.error("job %s failed:\n%s", job.job_id, traceback.format_exc())
            self.send(JobDoneEvent(job_id=job.job_id, zip=job.label, status="error",
                                   error=RpcError(code="internal", message=f"{type(e).__name__}: {e}")))

    def _done(self, job: Job, status: str, zip_id, counts: SampleCounts, result: Any) -> None:
        if hasattr(result, "model_dump"):
            result = result.model_dump(mode="json")
        self.send(JobDoneEvent(job_id=job.job_id, zip_id=zip_id, zip=job.label, status=status,
                               counts=counts, result=result))


def _short(e: ValidationError) -> str:
    return "; ".join(f"{'.'.join(map(str, err['loc']))}: {err['msg']}" for err in e.errors())


def protect_stdout() -> TextIO:
    """Reserve the real stdout for RPC and send everything else (print, C++ logs) to stderr."""
    rpc_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(rpc_fd, "w", buffering=1, encoding="utf-8")


def main(out_factory: Callable[[], TextIO] = protect_stdout) -> int:
    logging.basicConfig(level=os.environ.get("DRUMVAULT_LOG", "INFO"), stream=sys.stderr,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    out = out_factory()
    server = RpcServer(out)
    log.info("drumvault engine %s ready (rpc)", __version__)
    server.send({"event": "ready", "version": __version__})
    server.serve(sys.stdin)
    return 0
