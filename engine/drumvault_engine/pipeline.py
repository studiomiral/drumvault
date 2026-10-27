"""Orchestrates one zip end to end (SCOPE.md §5.1)."""

from __future__ import annotations

import json
import logging
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from . import classify, events as eventmod, key as keymod, loops as loopmod, naming, normalize
from . import oneshots as osmod, peaks as peakmod, stretch, tempo as tempomod, zipio
from .audioutil import Audio, info as audio_info, load, resample, write_wav
from .config import DRUM_CATEGORIES, EVENT_CATEGORIES, ONESHOT_CATEGORIES, Settings
from .db import LibraryDB, library_dir, match_key, now_iso
from .schemas import KeyInfo, Overrides, ProcessResult, SampleCounts, StemInfo, TempoInfo, ZipAnalysis

log = logging.getLogger(__name__)


class Cancelled(Exception):
    pass


class PipelineError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


ProgressFn = Callable[[str, float, str], None]


@dataclass
class JobContext:
    progress: ProgressFn = lambda stage, pct, msg: None
    is_cancelled: Callable[[], bool] = lambda: False

    def check(self) -> None:
        if self.is_cancelled():
            raise Cancelled()


# ---------------------------------------------------------------------------
# Analysis (shared by `cli analyze` and processing)
# ---------------------------------------------------------------------------

@dataclass
class Extracted:
    zip_path: Path
    sha1: str
    root: Path
    files: dict[str, Path]                 # stem name (path inside zip) -> extracted file
    warnings: list[str] = field(default_factory=list)
    _cache: dict[str, Audio] = field(default_factory=dict)

    def audio(self, name: str) -> Audio:
        if name not in self._cache:
            self._cache[name] = load(self.files[name])
        return self._cache[name]

    def drop(self, name: str) -> None:
        self._cache.pop(name, None)


def _mono_sum(ex: Extracted, names: list[str]) -> tuple[np.ndarray, int]:
    sr = ex.audio(names[0]).sr
    parts = [resample(ex.audio(n).mono(), ex.audio(n).sr, sr) for n in names]
    out = np.zeros(max(len(p) for p in parts), dtype=np.float32)
    for p in parts:
        out[:len(p)] += p
    return out, sr


def analyze(ex: Extracted, settings: Settings, overrides: Overrides, ctx: JobContext) -> ZipAnalysis:
    th = settings.thresholds
    names = sorted(ex.files)
    if not names:
        raise PipelineError("no_audio", "No usable audio files in the zip")

    ctx.progress("classify", 0.08, f"Classifying {len(names)} stems")
    classes = classify.classify_stems(names, ex.audio, th)
    stems: dict[str, StemInfo] = {}
    for n in names:
        frames, sr, ch = audio_info(ex.files[n])
        c = classes[n]
        ov = overrides.stems.get(n)
        stems[n] = StemInfo(file_name=n, category=ov or c.category, category_override=ov,
                            auto_classified=c.auto, classify_reason=c.reason,
                            duration_s=frames / sr, sample_rate=sr, channels=ch)
    # Audio decoded for classification of ignored stems is no longer needed.
    for n in names:
        if stems[n].category == "ignore":
            ex.drop(n)
    ctx.check()

    # ---- tempo -----------------------------------------------------------
    usable = {n: s.category for n, s in stems.items() if s.category != "ignore"}
    src_cat, src_names = tempomod.pick_source(usable or {n: s.category for n, s in stems.items()})
    mono, sr = _mono_sum(ex, src_names)
    tres = tempomod.detect_tempo(
        mono, sr, settings, source_stem=" + ".join(src_names), source_category=src_cat,
        names_for_bpm=[ex.zip_path.name, *names], bpm_override=overrides.bpm,
        grid_offset_ms=overrides.grid_offset_ms)
    for n in src_names:
        stems[n].used_for.append("tempo")
    ctx.progress("tempo", 0.2, f"{src_cat.title()}: {tres.bpm:.2f} BPM (conf {tres.confidence:.2f})")
    ctx.check()

    warnings = list(ex.warnings)
    lw = zipio.stem_length_warning({n: s.duration_s for n, s in stems.items() if s.category != "ignore"},
                                   tres.bpm, th.stem_length_mismatch_bars)
    if lw:
        warnings.append(lw)

    # ---- key -------------------------------------------------------------
    if overrides.key:
        kres = keymod.override_result(overrides.key, th)
    else:
        melodic = [n for n, s in stems.items() if s.category == "melodic"]
        full = [n for n, s in stems.items() if s.category == "full_mix"]
        key_names, source = (melodic, "melodic") if melodic else (full, "full_mix")
        if key_names:
            mix, ksr = keymod.mix_for_key(
                [(ex.audio(n).mono(), ex.audio(n).sr, classify.is_bass(n)) for n in key_names], th)
            kres = keymod.detect_key_audio(mix, ksr, th, source=source)
            for n in key_names:
                stems[n].used_for.append("key")
                ex.drop(n)
        else:
            kres = keymod.no_key()
            warnings.append("No melodic or full-mix stem: key unknown (NoKey)")
    ctx.progress("key", 0.3, f"Key: {kres.label or 'NoKey'} ({kres.camelot or '-'}, conf {kres.confidence:.2f})")

    return ZipAnalysis(
        file_name=ex.zip_path.name, file_sha1=ex.sha1, stems=[stems[n] for n in names],
        tempo=TempoInfo(bpm=tres.bpm, raw_bpm=tres.raw_bpm, detected_bpm=tres.detected_bpm, phase_samples=tres.phase_samples,
                        sample_rate=tres.sample_rate, confidence=tres.confidence,
                        source_stem=tres.source_stem, source_category=tres.source_category,
                        grid_warning=tres.grid_warning, bpm_warning=tres.bpm_warning,
                        warnings=tres.warnings),
        key=KeyInfo(key=kres.key, scale=kres.scale, label=kres.label, camelot=kres.camelot,
                    confidence=kres.confidence, uncertain=kres.uncertain, backend=kres.backend,
                    source=kres.source),
        warnings=warnings + tres.warnings,
    )


def extract(zip_path: Path, tmp_dir: Path) -> Extracted:
    disc = zipio.extract_zip(zip_path, tmp_dir)
    files = {disc.rel(p): p for p in disc.files}
    return Extracted(zip_path=zip_path, sha1=zipio.sha1_file(zip_path), root=tmp_dir, files=files,
                     warnings=list(disc.warnings))


def analyze_zip(zip_path: Path | str, settings: Settings, overrides: Overrides | None = None,
                ctx: JobContext | None = None) -> ZipAnalysis:
    """Classification, BPM and key only. Writes nothing."""
    ctx = ctx or JobContext()
    with tempfile.TemporaryDirectory(prefix="drumvault-") as d:
        ctx.progress("extract", 0.02, "Extracting")
        ex = extract(Path(zip_path), Path(d))
        return analyze(ex, settings, overrides or Overrides(), ctx)


# ---------------------------------------------------------------------------
# Per-stem processing
# ---------------------------------------------------------------------------

@dataclass
class StemOutput:
    name: str
    category: str
    oneshots: list[osmod.OneShot] = field(default_factory=list)
    loops: list[loopmod.Loop] = field(default_factory=list)
    events: list[eventmod.Event] = field(default_factory=list)
    loop_factor: float = 1.0               # duration factor applied before slicing
    loop_sr: int = 44100
    warnings: list[str] = field(default_factory=list)


def _process_stem(ex: Extracted, stem: StemInfo, analysis: ZipAnalysis, settings: Settings,
                  do_oneshots: bool, do_loops: bool, tmp: Path, ctx: JobContext) -> StemOutput:
    ctx.check()
    out = StemOutput(stem.file_name, stem.category)
    audio = load(ex.files[stem.file_name])
    t = analysis.tempo
    if do_oneshots and stem.category in ONESHOT_CATEGORIES:
        out.oneshots = osmod.extract_oneshots(audio, stem.category, settings)
    lengths = settings.loop_lengths_for(stem.category)
    is_event = stem.category in EVENT_CATEGORIES
    if do_loops and (lengths or is_event):
        ctx.check()
        y, out_sr, w = stretch.stretch_stem(audio.data, audio.sr, t.bpm, settings, tmp_dir=tmp)
        out.warnings += w
        phase = stretch.map_samples(round(t.phase_samples * audio.sr / t.sample_rate), audio.sr,
                                    t.bpm, settings.library_bpm, out_sr)
        if is_event:
            out.events = eventmod.extract_events(y, out_sr, phase, settings.library_bpm, settings)
        else:
            out.loops = loopmod.extract_loops(y, out_sr, phase, settings.library_bpm, lengths, settings)
        out.loop_factor = stretch.time_factor(t.bpm, settings.library_bpm)
        out.loop_sr = out_sr
    return out


# ---------------------------------------------------------------------------
# Full processing
# ---------------------------------------------------------------------------

def _merge_overrides(db: LibraryDB, zip_row, new: Overrides | None) -> Overrides:
    """Stored overrides from previous runs, updated with the new ones."""
    stored = Overrides(bpm=zip_row["bpm_override"], grid_offset_ms=zip_row["grid_offset_override_ms"],
                       key=zip_row["key_override"],
                       stems={r["file_name"]: r["category_override"] for r in db.stems_for_zip(zip_row["id"])
                              if r["category_override"]})
    if new is None:
        return stored
    stem_names = {str(r["id"]): r["file_name"] for r in db.stems_for_zip(zip_row["id"])}
    for k in new.model_fields_set - {"stems"}:
        setattr(stored, k, getattr(new, k))
    for k, cat in new.stems.items():
        stored.stems[stem_names.get(str(k), str(k))] = cat
    return stored


def _delete_sample_files(lib: Path, rows) -> None:
    for r in rows:
        (lib / r["rel_path"]).unlink(missing_ok=True)
        (library_dir(lib) / "peaks" / f"{r['id']}.json").unlink(missing_ok=True)


def process_zip(zip_path: Path | str | None, settings: Settings, *, reprocess: bool = False,
                zip_id: int | None = None, overrides: Overrides | None = None,
                loops_only: bool = False, ctx: JobContext | None = None) -> ProcessResult:
    """Process one zip into the library. Either `zip_path` or `zip_id` (reprocess) is required."""
    ctx = ctx or JobContext()
    if not settings.library_path:
        raise PipelineError("no_library", "No library folder configured")
    lib = Path(settings.library_path)
    lib.mkdir(parents=True, exist_ok=True)
    with LibraryDB(lib) as db:
        existing = None
        if zip_id is not None:
            existing = db.get_zip(zip_id)
            if existing is None:
                raise PipelineError("not_found", f"No zip with id {zip_id}")
            zip_path = existing["original_path"]
            reprocess = True
        zip_path = Path(zip_path)  # type: ignore[arg-type]
        if not zip_path.exists():
            raise PipelineError("missing_zip", f"Zip not found: {zip_path}")

        ctx.progress("extract", 0.01, "Hashing")
        sha1 = zipio.sha1_file(zip_path)
        if existing is None:
            existing = db.find_zip_by_sha1(sha1)
            if existing is not None and not reprocess and existing["status"] in ("done", "needs_review"):
                return ProcessResult(zip_id=existing["id"], source_code=existing["source_code"],
                                     file_name=zip_path.name, status="skipped",
                                     warnings=["Already processed (use reprocess)"])
        elif existing["file_sha1"] != sha1:
            raise PipelineError("zip_changed", f"{zip_path} no longer matches the processed zip")

        if existing is not None:
            zid, code = existing["id"], existing["source_code"]
            ov = _merge_overrides(db, existing, overrides)
            db.update_zip(zid, status="processing", original_path=str(zip_path.resolve()))
        else:
            code = naming.source_code(db.next_source_number())
            zid = db.insert_zip(source_code=code, file_name=zip_path.name, file_sha1=sha1,
                                original_path=str(zip_path.resolve()), status="processing")
            ov = overrides or Overrides()
        try:
            return _process(db, lib, zid, code, zip_path, settings, ov, loops_only, ctx)
        except Cancelled:
            if existing is None:
                db.delete_zip_rows(zid)  # nothing was written for a new zip
            else:
                db.update_zip(zid, status=existing["status"])
            raise
        except Exception as e:
            db.update_zip(zid, status="error", warnings=[f"{type(e).__name__}: {e}"])
            raise


def _process(db: LibraryDB, lib: Path, zid: int, code: str, zip_path: Path, settings: Settings,
             ov: Overrides, loops_only: bool, ctx: JobContext) -> ProcessResult:
    th = settings.thresholds
    tag = naming.source_tag(code, naming.slugify(zip_path.name))
    with tempfile.TemporaryDirectory(prefix="drumvault-") as d:
        tmp = Path(d)
        ctx.progress("extract", 0.03, "Extracting")
        ex = extract(zip_path, tmp / "x")
        ctx.check()
        analysis = analyze(ex, settings, ov, ctx)
        ex._cache.clear()
        t, k = analysis.tempo, analysis.key
        warnings = list(analysis.warnings)
        status = "done"
        if t.confidence < th.tempo_min_confidence:
            status = "needs_review"
            warnings.append(f"Low tempo confidence ({t.confidence:.2f})")
        if t.grid_warning or t.bpm_warning:
            status = "needs_review"

        do_loops = stretch.stretch_allowed(t.bpm, settings.library_bpm, settings.max_stretch)
        if not do_loops:
            status = "needs_review"
            warnings.append(f"{t.bpm:g} -> {settings.library_bpm:g} BPM exceeds the max stretch "
                            f"({settings.max_stretch:.0%}); loops and FX/fills skipped, one-shots kept")

        # ---- per-stem work -------------------------------------------------
        sample_stems = [s for s in analysis.stems if s.category in DRUM_CATEGORIES + EVENT_CATEGORIES]
        outputs: list[StemOutput] = []
        done = 0
        with ThreadPoolExecutor(max_workers=max(1, settings.workers)) as pool:
            futs = [pool.submit(_process_stem, ex, s, analysis, settings, not loops_only, do_loops,
                                tmp, ctx) for s in sample_stems]
            try:
                for f in futs:
                    outputs.append(f.result())
                    done += 1
                    o = outputs[-1]
                    ctx.progress("stems", 0.3 + 0.55 * done / max(1, len(sample_stems)),
                                 f"{o.name}: {len(o.oneshots)} one-shots, {len(o.loops)} loops, "
                                 f"{len(o.events)} FX/fills")
            except BaseException:
                for f in futs:
                    f.cancel()
                raise
        for o in outputs:
            warnings += o.warnings
        warnings = list(dict.fromkeys(warnings))  # de-duplicate, keep order
        ctx.check()

        # ---- write ---------------------------------------------------------
        ctx.progress("write", 0.86, "Writing samples")
        counts = _write_outputs(db, lib, zid, tag, analysis, outputs, settings, loops_only, ctx)

        db.update_zip(
            zid, file_name=zip_path.name, detected_bpm=t.detected_bpm, bpm_override=ov.bpm,
            bpm_source_stem=t.source_stem, phase_samples=t.phase_samples,
            grid_offset_override_ms=ov.grid_offset_ms, tempo_confidence=t.confidence,
            key_label=k.label, key_camelot=k.camelot, key_confidence=k.confidence,
            key_override=ov.key, status=status, warnings=warnings, processed_at=now_iso(),
            settings_hash=settings.processing_hash())
        _write_log(lib, code, zip_path, analysis, counts, status, warnings, settings)
        ctx.progress("done", 1.0, f"{counts.oneshots} one-shots, {counts.loops} loops, "
                                  f"{counts.events} FX/fills")
        return ProcessResult(zip_id=zid, source_code=code, file_name=zip_path.name, status=status,
                             counts=counts, analysis=analysis, warnings=warnings)


def _write_outputs(db: LibraryDB, lib: Path, zid: int, tag: str, analysis: ZipAnalysis,
                   outputs: list[StemOutput], settings: Settings, loops_only: bool,
                   ctx: JobContext) -> SampleCounts:
    th = settings.thresholds
    k = analysis.key
    key_label = k.label or "NoKey"
    out_sr = settings.output_sample_rate
    by_name = {o.name: o for o in outputs}
    counts = SampleCounts()
    written: list[Path] = []
    try:
        with db.transaction():
            # Loops and events depend on the library BPM; one-shots don't.
            kind_filter = ("loop", "event") if loops_only else None
            meta = db.user_meta(zid, kind_filter)
            old = db.samples_for_zip(zid, kind_filter)
            _delete_sample_files(lib, old)
            db.delete_samples(zid, kind_filter)

            if loops_only:
                stem_ids = {r["file_name"]: r["id"] for r in db.stems_for_zip(zid)}
            else:
                db.delete_stems(zid)
                stem_ids = {}
            for s in analysis.stems:
                o = by_name.get(s.file_name)
                if o is not None:
                    if o.oneshots and "oneshots" not in s.used_for:
                        s.used_for.append("oneshots")
                    if o.loops and "loops" not in s.used_for:
                        s.used_for.append("loops")
                    if o.events and "events" not in s.used_for:
                        s.used_for.append("events")
                fields = dict(category=s.category, category_override=s.category_override,
                              auto_classified=int(s.auto_classified), duration_s=s.duration_s,
                              sample_rate=s.sample_rate, channels=s.channels, used_for=s.used_for)
                if s.file_name in stem_ids:
                    db.update_stem(stem_ids[s.file_name], **fields)
                else:
                    stem_ids[s.file_name] = db.insert_stem(zip_id=zid, file_name=s.file_name, **fields)
                s.id = stem_ids[s.file_name]

            index: dict[tuple, int] = {}
            created = now_iso()

            def add(stem_name: str, kind: str, category: str, data: np.ndarray, bars: int | None,
                    offset_s: float, fp: np.ndarray, peak_db: float, gain_db: float) -> None:
                ik = (kind, category, bars)
                index[ik] = index.get(ik, 0) + 1
                if kind == "oneshot":
                    rel = naming.oneshot_rel_path(category, key_label, tag, index[ik])
                elif kind == "event":
                    rel = naming.event_rel_path(category, settings.library_bpm, key_label, tag, bars or 0,
                                                index[ik])
                else:
                    rel = naming.loop_rel_path(category, settings.library_bpm, key_label, tag, bars or 0,
                                               index[ik])
                path = lib / rel
                write_wav(path, data, out_sr, settings.output_format)
                written.append(path)
                um = meta.get(match_key(stem_name, kind, bars, offset_s), {})
                sid = db.insert_sample(
                    zip_id=zid, stem_id=stem_ids[stem_name], kind=kind, category=category, rel_path=rel,
                    bpm=None if kind == "oneshot" else settings.library_bpm, bars=bars,
                    key_label=k.label, key_camelot=k.camelot, duration_s=len(data) / out_sr,
                    sample_rate=out_sr, channels=int(data.shape[1]), peak_db=peak_db,
                    gain_applied_db=gain_db, source_offset_s=offset_s,
                    fingerprint=fp.astype(np.float32).tobytes(),
                    favorite=int(um.get("favorite") or 0), rating=um.get("rating"), tags=um.get("tags"),
                    created_at=created)
                pk = peakmod.peaks_for(data, out_sr, kind, bars, th)
                ppath = library_dir(lib) / "peaks" / f"{sid}.json"
                peakmod.write_peaks(ppath, pk)
                written.append(ppath)

            for o in outputs:
                ctx.check()
                for h in sorted(o.oneshots, key=lambda h: h.start):
                    data = resample(h.data, h.sr, out_sr)
                    data, pk_db, gain = normalize.peak_normalize(data, settings.oneshot_peak_dbfs)
                    add(o.name, "oneshot", h.category, data, None, h.source_offset_s, h.fingerprint,
                        pk_db, gain)
                    counts.oneshots += 1
                for lp in sorted(o.loops, key=lambda lp: (lp.bars, lp.start)):
                    if settings.loop_norm_mode == "lufs":
                        data, pk_db, gain = normalize.loudness_normalize(
                            lp.data, lp.sr, settings.loop_lufs_target, settings.loop_peak_dbfs)
                    else:
                        data, pk_db, gain = normalize.peak_normalize(lp.data, settings.loop_peak_dbfs)
                    offset_s = lp.start / lp.sr / o.loop_factor
                    add(o.name, "loop", o.category, data, lp.bars, offset_s, lp.fingerprint, pk_db, gain)
                    counts.loops += 1
                for ev in o.events:
                    data, pk_db, gain = normalize.peak_normalize(ev.data, settings.event_peak_dbfs)
                    offset_s = ev.start / ev.sr / o.loop_factor
                    add(o.name, "event", o.category, data, ev.bars, offset_s, ev.fingerprint, pk_db, gain)
                    counts.events += 1
    except BaseException:
        for p in written:  # roll back files written by the aborted transaction
            p.unlink(missing_ok=True)
        raise
    return counts


def _write_log(lib: Path, code: str, zip_path: Path, analysis: ZipAnalysis, counts: SampleCounts,
               status: str, warnings: list[str], settings: Settings) -> None:
    logs = library_dir(lib) / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    payload = {"source_code": code, "zip": str(zip_path), "processed_at": now_iso(), "status": status,
               "counts": counts.model_dump(), "warnings": warnings,
               "analysis": analysis.model_dump(), "settings": settings.to_dict()}
    (logs / f"{code}.json").write_text(json.dumps(payload, indent=2, default=str))


# ---------------------------------------------------------------------------
# Library maintenance
# ---------------------------------------------------------------------------

def delete_zip(settings: Settings, zip_id: int, delete_files: bool = True) -> dict:
    lib = Path(settings.library_path)
    with LibraryDB(lib) as db:
        row = db.get_zip(zip_id)
        if row is None:
            raise PipelineError("not_found", f"No zip with id {zip_id}")
        samples = db.samples_for_zip(zip_id)
        if delete_files:
            _delete_sample_files(lib, samples)
        db.delete_zip_rows(zip_id)
    return {"zip_id": zip_id, "deleted_samples": len(samples), "files_deleted": delete_files}


def rebuild_loops(settings: Settings, ctx: JobContext | None = None) -> list[ProcessResult]:
    """Re-stretch and re-cut every zip's loops and events at the (new) library BPM; one-shots stay."""
    ctx = ctx or JobContext()
    with LibraryDB(settings.library_path) as db:
        rows = [r for r in db.list_zips() if r["status"] in ("done", "needs_review")]
    results = []
    for i, r in enumerate(rows):
        ctx.check()
        ctx.progress("rebuild", i / max(1, len(rows)), f"{r['file_name']} ({i + 1}/{len(rows)})")
        if not Path(r["original_path"] or "").exists():
            results.append(ProcessResult(zip_id=r["id"], source_code=r["source_code"],
                                         file_name=r["file_name"], status="error",
                                         warnings=[f"Original zip missing: {r['original_path']}"]))
            continue
        results.append(process_zip(None, settings, zip_id=r["id"], loops_only=True, ctx=ctx))
    return results


def find_zips(paths: list[str | Path]) -> list[Path]:
    """Expand folders to all zips inside them (recursively)."""
    out: list[Path] = []
    for p in map(Path, paths):
        if p.is_dir():
            out += sorted(q for q in p.rglob("*.zip") if not zipio.is_junk(q.relative_to(p).as_posix()))
        else:
            out.append(p)
    return out

