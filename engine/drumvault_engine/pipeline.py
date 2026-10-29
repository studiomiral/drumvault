"""Orchestrates one zip end to end (SCOPE.md §5.1)."""

from __future__ import annotations

import dataclasses
import hashlib
import json
import logging
import re
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from . import arrangement as arrmod, classify, events as eventmod, groove as groovemod, key as keymod, loops as loopmod
from . import naming, normalize, originals, samples as samplemod
from . import oneshots as osmod, peaks as peakmod, stretch, tempo as tempomod, zipio
from .audioutil import Audio, info as audio_info, load, resample, write_wav
from .config import DRUM_CATEGORIES, EVENT_CATEGORIES, ONESHOT_CATEGORIES, Settings
from .db import LibraryDB, SampleMatcher, library_dir, now_iso
from .schemas import GridPreview, KeyInfo, Overrides, ProcessResult, SampleCounts, StemInfo, TempoInfo, ZipAnalysis

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
    if tres.grid_warning and overrides.grid_offset_ms is None:
        # Bar 1 moved off sample 0: check the other drum stems before believing the kick.
        others = [n for n, s in stems.items()
                  if s.category in DRUM_CATEGORIES and s.category != "kick" and n not in src_names]
        offsets = [o for n in others if (o := tempomod.stem_grid_offset(
            ex.audio(n).mono(), ex.audio(n).sr, stems[n].category, tres.bpm, settings)) is not None]
        tres = tempomod.keep_bar_one(tres, offsets, th)
    for n in src_names:
        stems[n].used_for.append("tempo")
    ctx.progress("tempo", 0.2, f"{src_cat.title()}: {tres.bpm:.2f} BPM")
    ctx.check()

    # ---- arrangement: where each part plays (before the melodic stems are let go) ----
    arrangement = arrmod.measure(
        [(n, s.category, ex.audio(n).mono(), ex.audio(n).sr) for n, s in stems.items()
         if arrmod.part_of(n, s.category)],
        tres.bpm, tres.phase_samples / tres.sample_rate, th)

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
        arrangement=arrangement,
    )


def extract(zip_path: Path, tmp_dir: Path) -> Extracted:
    disc = zipio.extract_zip(zip_path, tmp_dir)
    files = {disc.rel(p): p for p in disc.files}
    return Extracted(zip_path=zip_path, sha1=zipio.sha1_file(zip_path), root=tmp_dir, files=files,
                     warnings=list(disc.warnings))


def _source(lib: Path, row, tmp_dir: Path) -> Extracted:
    """A processed zip's stems: the library's kept copy (SCOPE.md §5.15), else the original zip."""
    kept = originals.kept_files(lib, row["source_code"])
    if kept is not None:
        return Extracted(zip_path=Path(row["original_path"] or row["file_name"]), sha1=row["file_sha1"],
                         root=originals.kept_dir(lib, row["source_code"]), files=kept)
    zip_path = Path(row["original_path"] or "")
    if not zip_path.is_file():
        raise PipelineError("missing_zip", f"Zip not found and not kept in the library: {zip_path}")
    return extract(zip_path, tmp_dir)


def has_source(lib: Path, row) -> bool:
    """The zip's (or pack's) audio can still be read: kept in the library, or where it came from."""
    return originals.is_kept(lib, row["source_code"]) or bool(row["original_path"] and Path(row["original_path"]).exists())


def _keep_original(lib: Path, code: str, files: dict[str, Path], settings: Settings, ctx: JobContext,
                   at: float, span: float) -> str | None:
    return originals.keep(lib, code, files, settings.thresholds, settings.workers,
                          lambda pct, n: ctx.progress("keep", at + span * pct, f"Keeping the original: {n}"))


def _unkept(lib: Path, db: LibraryDB) -> list:
    """Zips and packs whose audio isn't (all) kept in the library yet but can still be read where
    it came from."""
    out = []
    for z in db.list_zips():
        if z["status"] not in ("done", "needs_review") or not z["original_path"] or not Path(z["original_path"]).exists():
            continue
        kept = originals.kept_files(lib, z["source_code"])
        if z["kind"] == "pack":
            root = Path(z["original_path"])
            need = {r["file_name"] for r in db.stems_for_zip(z["id"]) if (root / r["file_name"]).exists()}
            if need - set(kept or {}):
                out.append(z)
        elif kept is None:
            out.append(z)
    return out


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
    key: tuple[str, str] | None = None     # (label, camelot) of a loose sample, else the zip's key


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
            if existing["kind"] == "pack":
                return _process_pack(db, lib, existing, [r["file_name"] for r in db.stems_for_zip(zip_id)],
                                     settings, overrides, loops_only, ctx)
            zip_path = existing["original_path"]
            reprocess = True
        zip_path = Path(zip_path)  # type: ignore[arg-type]
        kept = existing is not None and originals.is_kept(lib, existing["source_code"])
        if not kept and not zip_path.exists():
            raise PipelineError("missing_zip", f"Zip not found: {zip_path}")

        ctx.progress("extract", 0.01, "Hashing")
        sha1 = existing["file_sha1"] if kept else zipio.sha1_file(zip_path)
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
            if not kept:
                db.update_zip(zid, original_path=str(zip_path.resolve()))
            db.update_zip(zid, status="processing")
        else:
            if zipio.is_midi_zip(zip_path):
                raise PipelineError("midi_zip", f"{zip_path.name} holds MIDI files, not stems: add it on the MIDI page")
            code = naming.source_code(db.next_source_number("S"))
            zid = db.insert_zip(source_code=code, file_name=zip_path.name, file_sha1=sha1,
                                original_path=str(zip_path.resolve()), status="processing")
            ov = overrides or Overrides()
        try:
            reviewed = bool(existing is not None and existing["reviewed"])
            return _process(db, lib, zid, code, zip_path, settings, ov, loops_only, ctx, reviewed)
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
             ov: Overrides, loops_only: bool, ctx: JobContext, reviewed: bool = False) -> ProcessResult:
    th = settings.thresholds
    tag = naming.source_tag(code, naming.slugify(zip_path.name))
    with tempfile.TemporaryDirectory(prefix="drumvault-") as d:
        tmp = Path(d)
        ctx.progress("extract", 0.03, "Extracting")
        ex = _source(lib, db.get_zip(zid), tmp / "x")
        ctx.check()
        analysis = analyze(ex, settings, ov, ctx)
        ex._cache.clear()
        t, k = analysis.tempo, analysis.key
        warnings = list(analysis.warnings)
        # Tempo confidence is not used: the detected BPM is trusted, Lars overrides it if wrong.
        status = "done"
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

        if reviewed and status == "needs_review":
            status = "done"  # the user marked this zip as reviewed; warnings stay visible

        # ---- write ---------------------------------------------------------
        ctx.progress("write", 0.86, "Writing samples")
        counts = _write_outputs(db, lib, zid, tag, analysis, outputs, settings, loops_only, ctx)
        db.set_arrangement(zid, analysis.arrangement)
        if w := _keep_original(lib, code, ex.files, settings, ctx, 0.93, 0.06):
            warnings.append(w)

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
                   ctx: JobContext, track: bool = True) -> SampleCounts:
    """`track`: the outputs are the stems of one track (a pack's files are not: their events
    share no timeline, so no source bar is stored)."""
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
            tol = (th.match_oneshot_tolerance_s, th.match_loop_tolerance_s)
            meta = SampleMatcher(db.user_meta(zid, kind_filter), *tol)
            removed = SampleMatcher(db.removed_for_zip(zid, kind_filter), *tol)
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
            key_of = {o.name: o.key for o in outputs if o.key}

            def add(stem_name: str, kind: str, category: str, data: np.ndarray, bars: int | None,
                    offset_s: float, fp: np.ndarray, peak_db: float, gain_db: float,
                    body_bars: int | None = None, bar: int | None = None) -> bool:
                label, camelot = key_of.get(stem_name, (k.label, k.camelot))
                file_key = label or key_label
                ik = (kind, category, bars, file_key)
                n = index.get(ik, 0) + 1
                if kind == "oneshot":
                    rel = naming.oneshot_rel_path(category, file_key, tag, n)
                elif kind == "event":
                    rel = naming.event_rel_path(category, settings.library_bpm, file_key, tag, bars or 0, n)
                else:
                    rel = naming.loop_rel_path(category, settings.library_bpm, file_key, tag, bars or 0, n)
                fields = dict(
                    kind=kind, category=category, rel_path=rel,
                    bpm=None if kind == "oneshot" else settings.library_bpm, bars=bars, body_bars=body_bars,
                    key_label=label, key_camelot=camelot, duration_s=len(data) / out_sr,
                    sample_rate=out_sr, channels=int(data.shape[1]), peak_db=peak_db,
                    gain_applied_db=gain_db, source_offset_s=offset_s, created_at=created)
                fingerprint = fp.astype(np.float32).tobytes()
                rid = removed.find(stem_name, kind, bars, offset_s)
                prev = json.loads(db.get_removed([rid])[0]["sample"] or "{}") if rid is not None else None
                um = prev if prev is not None else (meta.find(stem_name, kind, bars, offset_s) or {})
                # "Move sound" set in the Library: the new cut gets the same rotation.
                shift = int(um.get("shift_beats") or 0) if kind != "oneshot" else 0
                if shift:
                    data = rotate_beats(data, out_sr, settings.library_bpm, shift)
                fields["shift_beats"] = shift
                if kind == "loop":
                    fields["groove"] = json.dumps(groovemod.loop_groove(data, out_sr, settings.library_bpm, th) or {})
                if kind == "event":
                    fields["shape"] = json.dumps(_event_shape(data, out_sr, settings.library_bpm, bars or 1, body_bars,
                                                              bar if track else None, th))
                pk = peakmod.peaks_for(data, out_sr, kind, bars, th)
                if rid is not None:
                    # Deleted by the user: re-cut into the trash, so a restore gets this cut.
                    wav, pj = trash_files(lib, rid)
                    write_wav(wav, data, out_sr, settings.output_format)
                    peakmod.write_peaks(pj, pk)
                    db.update_removed(rid, {**fields, **{m: prev.get(m) for m in ("favorite", "rating", "tags")}},
                                      fingerprint)
                    return False
                index[ik] = n
                path = lib / rel
                write_wav(path, data, out_sr, settings.output_format)
                written.append(path)
                sid = db.insert_sample(
                    zip_id=zid, stem_id=stem_ids[stem_name], **fields, fingerprint=fingerprint,
                    favorite=int(um.get("favorite") or 0), rating=um.get("rating"), tags=um.get("tags"))
                ppath = library_dir(lib) / "peaks" / f"{sid}.json"
                peakmod.write_peaks(ppath, pk)
                written.append(ppath)
                return True

            for o in outputs:
                ctx.check()
                for h in sorted(o.oneshots, key=lambda h: h.start):
                    data = resample(h.data, h.sr, out_sr)
                    data, pk_db, gain = normalize.peak_normalize(data, settings.oneshot_peak_dbfs)
                    counts.oneshots += add(o.name, "oneshot", h.category, data, None, h.source_offset_s,
                                           h.fingerprint, pk_db, gain)
                for lp in sorted(o.loops, key=lambda lp: (lp.bars, lp.start)):
                    if settings.loop_norm_mode == "lufs":
                        data, pk_db, gain = normalize.loudness_normalize(
                            lp.data, lp.sr, settings.loop_lufs_target, settings.loop_peak_dbfs)
                    else:
                        data, pk_db, gain = normalize.peak_normalize(lp.data, settings.loop_peak_dbfs)
                    offset_s = lp.start / lp.sr / o.loop_factor
                    counts.loops += add(o.name, "loop", o.category, data, lp.bars, offset_s, lp.fingerprint,
                                        pk_db, gain)
                for ev in o.events:
                    data, pk_db, gain = normalize.peak_normalize(ev.data, settings.event_peak_dbfs)
                    offset_s = ev.start / ev.sr / o.loop_factor
                    counts.events += add(o.name, "event", o.category, data, ev.bars, offset_s, ev.fingerprint,
                                         pk_db, gain, ev.body_bars, ev.bar)
    except BaseException:
        for p in written:  # roll back files written by the aborted transaction
            p.unlink(missing_ok=True)
        raise
    return counts


def _event_shape(data: np.ndarray, sr: int, bpm: float, bars: int, body_bars: int | None, bar: int | None,
                 th) -> dict:
    """events.shape, plus `boundary`: the bar of the source track its body ends on (the drop it
    leads into), so the generator knows which events a producer layered at the same moment."""
    body = body_bars or bars
    out = eventmod.shape(data, sr, bpm, bars, body, th)
    out["boundary"] = bar + body if bar is not None else None
    return out


def _bar_one_s(db: LibraryDB, z) -> float:
    """Where bar one of a zip's track is, in seconds of the original stems."""
    if z["grid_offset_override_ms"] is not None:
        return float(z["grid_offset_override_ms"]) / 1000
    stems = db.stems_for_zip(z["id"])
    sources = (z["bpm_source_stem"] or "").split(" + ")
    phase_sr = next((r["sample_rate"] for r in stems if r["file_name"] in sources and r["sample_rate"]), 44100)
    return (z["phase_samples"] or 0) / phase_sr


def _write_log(lib: Path, code: str, zip_path: Path, analysis: ZipAnalysis, counts: SampleCounts,
               status: str, warnings: list[str], settings: Settings) -> None:
    logs = library_dir(lib) / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    payload = {"source_code": code, "zip": str(zip_path), "processed_at": now_iso(), "status": status,
               "counts": counts.model_dump(), "warnings": warnings,
               "analysis": analysis.model_dump(), "settings": settings.to_dict()}
    (logs / f"{code}.json").write_text(json.dumps(payload, indent=2, default=str))


# ---------------------------------------------------------------------------
# Loose samples (samples.py): packs
# ---------------------------------------------------------------------------

def import_samples(settings: Settings, paths: list[str], ctx: JobContext | None = None) -> list[ProcessResult]:
    """Add loose audio files (and the ones in dropped folders) to the library, one pack per
    Splice pack or folder. Files already in their pack are skipped; new files join it."""
    ctx = ctx or JobContext()
    if not settings.library_path:
        raise PipelineError("no_library", "No library folder configured")
    lib = Path(settings.library_path)
    lib.mkdir(parents=True, exist_ok=True)
    packs, warnings = samplemod.find_samples(paths)
    if not packs:
        raise PipelineError("no_audio", "No audio files (.wav, .aif, .flac) in what was added")
    results = []
    with LibraryDB(lib) as db:
        for i, (root, names) in enumerate(sorted(packs.items())):
            ctx.check()
            ctx.progress("samples", i / len(packs), f"{root.name}: {len(names)} samples")
            row = db.find_zip_by_sha1(samplemod.pack_id(root))
            if row is None:
                code = naming.source_code(db.next_source_number("P"), "P")
                zid = db.insert_zip(source_code=code, file_name=root.name, file_sha1=samplemod.pack_id(root),
                                    original_path=str(root), status="processing", kind="pack")
                row = db.get_zip(zid)
                known: list[str] = []
            else:
                known = [r["file_name"] for r in db.stems_for_zip(row["id"])]
            new = [n for n in names if n not in known]
            if not new and row["status"] in ("done", "needs_review"):
                results.append(ProcessResult(zip_id=row["id"], source_code=row["source_code"], file_name=root.name,
                                             status="skipped", warnings=["Already in the library"]))
                continue
            sub = JobContext(progress=lambda st, pct, msg, i=i: ctx.progress(st, (i + pct) / len(packs), msg),
                             is_cancelled=ctx.is_cancelled)
            r = _process_pack(db, lib, row, known + new, settings, None, False, sub, extra_warnings=warnings)
            results.append(r)
    return results


def _process_pack(db: LibraryDB, lib: Path, row, names: list[str], settings: Settings, overrides: Overrides | None,
                  loops_only: bool, ctx: JobContext, extra_warnings: list[str] | None = None) -> ProcessResult:
    """(Re)write all samples of a pack from its files."""
    zid, code = row["id"], row["source_code"]
    root = Path(row["original_path"])
    ov = _merge_overrides(db, row, overrides)
    db.update_zip(zid, status="processing")
    try:
        tag = naming.source_tag(code, naming.slugify(root.name))
        warnings = list(extra_warnings or [])
        stems: list[StemInfo] = []
        outputs: list[StemOutput] = []
        skipped: list[str] = []
        fixable = False
        kept = originals.kept_files(lib, code) or {}
        src = {n: kept.get(n, root / n) for n in names}
        present = [n for n in names if src[n].exists()]
        for n in names:
            if n not in present:
                warnings.append(f"File missing: {n}")
        with tempfile.TemporaryDirectory(prefix="drumvault-") as d, \
                ThreadPoolExecutor(max_workers=max(1, settings.workers)) as pool:
            futs = [pool.submit(samplemod.process_file, src[n], n, ov.stems.get(n), settings, not loops_only, Path(d))
                    for n in present]
            try:
                for j, (n, f) in enumerate(zip(present, futs)):
                    ctx.check()
                    fr = f.result()
                    ctx.progress("samples", 0.05 + 0.8 * (j + 1) / max(1, len(present)), n)
                    stems.append(StemInfo(file_name=n, category=fr.category, category_override=ov.stems.get(n),
                                          auto_classified=fr.auto, classify_reason=fr.reason,
                                          duration_s=fr.duration_s, sample_rate=fr.sample_rate, channels=fr.channels))
                    outputs.append(StemOutput(n, fr.category, fr.oneshots, fr.loops, fr.events, fr.loop_factor,
                                              fr.loop_sr, fr.warnings, fr.key))
                    warnings += fr.warnings
                    if fr.skipped:
                        skipped.append(f"{n}: {fr.skipped}")
                        fixable |= fr.fixable
            except BaseException:
                for f in futs:
                    f.cancel()
                raise
        warnings = list(dict.fromkeys(warnings + [f"Skipped {s}" for s in skipped]))
        analysis = ZipAnalysis(file_name=root.name, file_sha1=row["file_sha1"], stems=stems,
                               tempo=TempoInfo(bpm=settings.library_bpm, raw_bpm=settings.library_bpm, phase_samples=0,
                                               sample_rate=settings.output_sample_rate, confidence=1.0,
                                               source_stem="", source_category="pack"),
                               key=KeyInfo(), warnings=warnings)
        ctx.progress("write", 0.9, "Writing samples")
        counts = _write_outputs(db, lib, zid, tag, analysis, outputs, settings, loops_only, ctx, track=False)
        if w := _keep_original(lib, code, {n: src[n] for n in present}, settings, ctx, 0.93, 0.06):
            warnings.append(w)
        # Drum files skipped for a reason a category override or a rename can fix want a look;
        # a 174 BPM loop or a melodic file is only noted.
        status = "needs_review" if fixable and not row["reviewed"] else "done"
        db.update_zip(zid, file_name=root.name, status=status, warnings=warnings, processed_at=now_iso(),
                      settings_hash=settings.processing_hash())
        _write_log(lib, code, root, analysis, counts, status, warnings, settings)
        ctx.progress("done", 1.0, f"{counts.oneshots} one-shots, {counts.loops} loops, {counts.events} FX/fills")
        return ProcessResult(zip_id=zid, source_code=code, file_name=root.name, status=status, counts=counts,
                             warnings=warnings)
    except Cancelled:
        if not db.stems_for_zip(zid) and not db.samples_for_zip(zid):
            db.delete_zip_rows(zid)  # a new pack: nothing was written
        else:
            db.update_zip(zid, status=row["status"] if row["status"] != "processing" else "done")
        raise
    except Exception as e:
        db.update_zip(zid, status="error", warnings=[f"{type(e).__name__}: {e}"])
        raise


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
        trashed = db.removed_ids_for_zip(zip_id)
        db.delete_zip_rows(zip_id)
    if delete_files:
        originals.remove(lib, row["source_code"])
    for rid in trashed:
        for f in trash_files(lib, rid):
            f.unlink(missing_ok=True)
    return {"zip_id": zip_id, "deleted_samples": len(samples), "files_deleted": delete_files}


def rotate_beats(data: np.ndarray, sr: int, bpm: float, beats: int) -> np.ndarray:
    """The sound moved `beats` later (negative: earlier), wrapping around the end of the loop."""
    return np.roll(data, int(round(beats * sr * 60.0 / bpm)), axis=0)


def shift_sample(settings: Settings, sample_id: int, beats: int) -> dict:
    """Library "Move sound": rotate a loop or event `beats` later inside itself (rewrites the WAV
    and peaks). The total shift is stored, so reprocessing applies it to the new cut too."""
    lib = Path(settings.library_path)
    with LibraryDB(lib) as db:
        row = db.get_sample(sample_id)
        if row is None:
            raise PipelineError("not_found", f"No sample with id {sample_id}")
        if row["kind"] == "oneshot" or not row["bars"] or not row["bpm"]:
            raise PipelineError("not_a_loop", "Only loops, fills and FX can be moved by a beat")
        length = int(row["bars"]) * 4
        old = int(row["shift_beats"] or 0)
        new = (old + beats) % length
        path = lib / row["rel_path"]
        data, sr = sf.read(str(path), dtype="float32", always_2d=True)
        beat = sr * 60.0 / float(row["bpm"])
        # Rotate by the difference of the rounded totals, so repeated moves never drift.
        moved = np.roll(data, int(round(new * beat)) - int(round(old * beat)), axis=0)
        tmp = path.with_name(f".{path.name}.part")
        sf.write(str(tmp), moved, sr, subtype=sf.info(str(path)).subtype, format="WAV")
        tmp.replace(path)
        peakmod.write_peaks(library_dir(lib) / "peaks" / f"{sample_id}.json",
                            peakmod.peaks_for(moved, sr, row["kind"], row["bars"], settings.thresholds))
        db.set_shift(sample_id, new)
        if row["kind"] == "event":
            old_shape = json.loads(row["shape"] or "{}") if "shape" in row.keys() else {}
            shape = eventmod.shape(moved, sr, float(row["bpm"]), int(row["bars"]), int(row["body_bars"] or row["bars"]),
                                   settings.thresholds)
            db.set_shape(sample_id, {**shape, "boundary": old_shape.get("boundary")})
    return {"sample_id": sample_id, "shift_beats": new}


def stretch_samples(settings: Settings, rel_paths: list[str], bpm: float) -> dict:
    """Time-stretch library samples (FX, which can't be sliced) to a project tempo, keeping the
    pitch (Rubber Band, like processing). Cached under .drumvault/tempo/<bpm>/ and redone only
    when the sample is newer. Returns {"paths": {rel_path: path to play}}."""
    lib = Path(settings.library_path)
    with LibraryDB(lib) as db:
        rows = {r: db.sample_by_path(r) for r in dict.fromkeys(rel_paths)}
    out: dict[str, str] = {}
    todo: list[tuple[str, float, Path, Path]] = []
    for rel, row in rows.items():
        src = lib / rel
        if row is None or not src.exists():
            raise PipelineError("not_found", f"No sample {rel}")
        source_bpm = float(row["bpm"] or settings.library_bpm)
        if abs(source_bpm - bpm) < 1e-6:
            out[rel] = rel
            continue
        dst_rel = naming.tempo_rel_path(rel, bpm)
        dst = lib / dst_rel
        out[rel] = dst_rel
        if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
            todo.append((rel, source_bpm, src, dst))

    def one(job: tuple[str, float, Path, Path]) -> None:
        _rel, source_bpm, src, dst = job
        data, sr = sf.read(str(src), dtype="float32", always_2d=True)
        s = dataclasses.replace(settings, library_bpm=bpm, output_sample_rate=sr)
        y, _, _ = stretch.stretch_stem(data, sr, source_bpm, s)
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_name(f".{dst.name}.part")
        sf.write(str(tmp), y, sr, subtype=sf.info(str(src)).subtype, format="WAV")
        tmp.replace(dst)

    with ThreadPoolExecutor(max_workers=max(1, settings.workers)) as pool:
        list(pool.map(one, todo))
    return {"paths": out}


_MIDI_SUFFIX = re.compile(r"[\s_-]*(midi|mid|midis)$", re.I)
_STEMS_SUFFIX = re.compile(r"[\s_-]*(stems?|multitracks?|parts?)$", re.I)


def _track_key(db: LibraryDB, label: str) -> tuple[str | None, str | None]:
    """The processed stem zip a MIDI pack belongs to ("83686_midi" ↔ "83686_stems"): (code, key)."""
    for z in db.list_zips():
        if _STEMS_SUFFIX.sub("", Path(z["file_name"] or "").stem).lower() == label.lower():
            return z["source_code"], z["key_override"] or z["key_label"]
    return None, None


def import_midi(settings: Settings, paths: list[str]) -> dict:
    """Add bass MIDI to the library (SCOPE.md §6.7) from loose .mid files, MIDI zips (a track's
    parts) and folders of either. Only basslines are kept (copied to MIDI/Bass/, indexed with
    bars and key); other parts are counted as ignored. Files already imported are skipped.

    A zip's bassline is named after the zip ("83686 Bass") and gets the key of the processed
    stem zip with the same name if there is one, else the key all the zip's parts together
    point to (chords and lead say more about the key than a bassline alone)."""
    import tempfile
    import zipfile
    from . import midi as midimod
    lib = Path(settings.library_path)
    th = settings.thresholds
    # Sources: (label for names, [(display name, bytes, original path)])
    groups: list[tuple[str | None, list[tuple[str, bytes, str]]]] = []

    def add_zip(z: Path) -> None:
        with zipfile.ZipFile(z) as zf:
            members = [(Path(n).stem, zf.read(n), f"{z.resolve()}!{n}") for n in zipio.midi_members(z)]
        if members:
            groups.append((_MIDI_SUFFIX.sub("", z.stem) or z.stem, members))

    for p in map(Path, paths):
        if p.is_dir():
            for f in sorted(p.rglob("*")):
                if not f.is_file() or zipio.is_junk(str(f.relative_to(p))):
                    continue
                if f.suffix.lower() in midimod.MIDI_EXTENSIONS:
                    groups.append((None, [(f.stem, f.read_bytes(), str(f.resolve()))]))
                elif f.suffix.lower() == ".zip" and zipio.is_midi_zip(f):
                    add_zip(f)
        elif p.suffix.lower() == ".zip":
            add_zip(p)
        elif p.suffix.lower() in midimod.MIDI_EXTENSIONS:
            groups.append((None, [(p.stem, p.read_bytes(), str(p.resolve()))]))

    imported, skipped, ignored, failed = [], 0, 0, []
    with LibraryDB(lib) as db, tempfile.TemporaryDirectory(prefix="drumvault-midi-") as tmp:
        for label, members in groups:
            infos = []
            for i, (name, data, origin) in enumerate(members):
                f = Path(tmp) / f"{i}-{naming.slugify(name, 40) or 'midi'}.mid"
                f.write_bytes(data)
                try:
                    info = midimod.analyze(f, th)
                    # Key words in the part's own name count; the temp name doesn't carry them.
                    named = midimod.detect_key(f"{name}.mid", []) if midimod.has_key_in_name(name) else None
                    infos.append((name, data, origin, f, info, named))
                except Exception as e:  # noqa: BLE001 - one bad file doesn't stop the rest
                    failed.append(f"{name}: {e}")
            code, track_key = _track_key(db, label) if label else (None, None)
            if not track_key and label and len(infos) > 1:
                together = [n for *_, info, _ in infos for n in info.notes]
                k = midimod.detect_key("", together)
                track_key = midimod.make_label(*k) if k else None
            for name, data, origin, f, info, named in infos:
                if not info.notes:
                    failed.append(f"{name}: no notes")
                    continue
                if midimod.guess_role(f"{name}.mid", info.notes, th) != "bass":
                    ignored += 1   # only basslines are used (Serum bass)
                    continue
                role = "bass"
                sha1 = hashlib.sha1(data).hexdigest()
                if db.midi_by_sha1(sha1):
                    skipped += 1
                    continue
                key_label = midimod.make_label(*named) if named else track_key or info.key_label
                title = f"{label} {name}" if label else name
                folder = "Bass" if role == "bass" else "Other"
                base = naming.slugify(title, 60) or "midi"
                rel, k = f"MIDI/{folder}/{base}.mid", 1
                while db.midi_path_taken(rel) or (lib / rel).exists():
                    k += 1
                    rel = f"MIDI/{folder}/{base}-{k}.mid"
                (lib / rel).parent.mkdir(parents=True, exist_ok=True)
                (lib / rel).write_bytes(data)
                notes = [[round(n.start, 6), round(n.length, 6), n.pitch, n.velocity] for n in info.notes]
                mid = db.insert_midi(file_name=f"{title}.mid", rel_path=rel, original_path=origin, file_sha1=sha1,
                                     role=role, bars=info.bars, key_label=key_label,
                                     key_camelot=midimod.camelot(*midimod.parse_label(key_label)) if key_label else None,
                                     notes=json.dumps(notes), source=label, source_code=code, created_at=now_iso())
                imported.append({"id": mid, "file_name": f"{title}.mid", "role": role, "bars": info.bars,
                                 "key_label": key_label})
    return {"imported": imported, "skipped": skipped, "ignored": ignored, "failed": failed}


def set_midi_meta(settings: Settings, midi_id: int, role: str | None, key_label: str | None, clear_key: bool) -> dict:
    """Correct a MIDI file's role (bass / other) or key."""
    from . import midi as midimod
    with LibraryDB(settings.library_path) as db:
        if db.get_midi(midi_id) is None:
            raise PipelineError("not_found", f"No MIDI file with id {midi_id}")
        fields: dict = {}
        if role in ("bass", "other"):
            fields["role"] = role
        if clear_key:
            fields.update(key_label=None, key_camelot=None)
        elif key_label:
            fields.update(key_label=key_label, key_camelot=midimod.camelot(*midimod.parse_label(key_label)))
        db.update_midi(midi_id, **fields)
    return {"id": midi_id}


def delete_midi(settings: Settings, midi_ids: list[int]) -> dict:
    """Remove MIDI files from the library (file and row). Projects keep their bass clips' renders."""
    lib = Path(settings.library_path)
    with LibraryDB(lib) as db:
        rows = [r for r in (db.get_midi(i) for i in midi_ids) if r is not None]
        for r in rows:
            (lib / r["rel_path"]).unlink(missing_ok=True)
            db.delete_midi(r["id"])
    return {"deleted": len(rows)}


# 2: Serum goes back to its init patch before each preset (before, settings a preset doesn't
# list carried over from the preset rendered before it).
BASS_RENDER_VERSION = 2


def _drop_stale_bass_renders(folder: Path) -> None:
    """Bass renders are a cache: the ones from an older render version are deleted, once."""
    stamp = folder / f".render-v{BASS_RENDER_VERSION}"
    if stamp.exists():
        return
    if folder.exists():
        for f in folder.glob("*.wav"):
            f.unlink(missing_ok=True)
    folder.mkdir(parents=True, exist_ok=True)
    stamp.touch()


def render_bass(settings: Settings, preset: str, midi_id: int, transpose: int, bpm: float, out_rel: str,
                notes: list[list[float]] | None = None, bars: int | None = None,
                groove: list[float] | None = None) -> dict:
    """Render a MIDI part through a Serum 2 preset as a seamless loop at `bpm`, loudness-matched,
    to `out_rel` (under .drumvault/bass/). Cached: redone only when the preset or MIDI changed.
    `notes`/`bars` (edited in the piano roll) replace the imported file's; the app names such
    renders after the notes, so the file stays a cache. A line the app generated has no file
    (`midi_id` < 1): its `notes` and `bars` are all there is. `groove` (16ths per step) moves
    notes that start on a 16th the way the track's loops are played."""
    from . import midi as midimod, serum
    from .midi import Note
    lib = Path(settings.library_path)
    if not out_rel.startswith(".drumvault/bass/") or ".." in Path(out_rel).parts or not out_rel.endswith(".wav"):
        raise PipelineError("bad_path", f"Bad bass render path: {out_rel}")
    out = lib / out_rel
    _drop_stale_bass_renders(out.parent)
    row = None
    if midi_id >= 1:
        with LibraryDB(lib) as db:
            row = db.get_midi(midi_id)
        if row is None:
            raise PipelineError("not_found", f"No MIDI file with id {midi_id}")
    elif notes is None or not bars:
        raise PipelineError("bad_request", "A generated bassline needs its notes and bars")
    src = Path(preset)
    if not src.exists():
        raise PipelineError("not_found", f"Serum preset not found: {preset}")
    midi_file = lib / row["rel_path"] if row is not None else None
    newest = max(src.stat().st_mtime, midi_file.stat().st_mtime if midi_file is not None and midi_file.exists() else 0)
    if out.exists() and out.stat().st_mtime >= newest:
        return {"path": out_rel, "cached": True}
    source = notes if notes is not None else json.loads(row["notes"])
    loop_bars = int(bars or row["bars"])
    parts = [Note(s, l, max(0, min(127, int(p) + transpose)), int(v)) for s, l, p, v in source if s < loop_bars * 4]
    if groove:
        parts = midimod.apply_groove(parts, groove)
    sr = settings.output_sample_rate
    try:
        data = serum.host(settings.serum_plugin, settings.serum_plugin_name).render_loop(src, parts, bpm, loop_bars, sr)
    except serum.SerumError as e:
        raise PipelineError("serum", str(e)) from e
    if float(np.abs(data).max(initial=0.0)) > 1e-5:
        data, _, _ = normalize.loudness_normalize(data, sr, settings.thresholds.bass_lufs_target,
                                                  settings.thresholds.bass_peak_dbfs)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f".{out.name}.part")
    sf.write(str(tmp), data, sr, subtype="PCM_24", format="WAV")
    tmp.replace(out)
    return {"path": out_rel, "cached": False}


def save_midi(settings: Settings, name: str, notes: list[list[float]], bars: int, key_label: str | None,
              role: str = "bass") -> dict:
    """Save an edited loop (piano roll) as a new MIDI file in the library, like an import."""
    import mido
    from . import midi as midimod
    lib = Path(settings.library_path)
    tpb = 480
    mf = mido.MidiFile(ticks_per_beat=tpb)
    tr = mido.MidiTrack()
    mf.tracks.append(tr)
    tr.append(mido.MetaMessage("track_name", name=name, time=0))
    ev = []
    for s, l, p, v in notes:
        if s >= bars * 4:
            continue
        on, off = round(s * tpb), round(min(s + l, bars * 4) * tpb)
        ev.append((on, 1, mido.Message("note_on", note=int(p), velocity=max(1, min(127, int(v))))))
        ev.append((max(on + 1, off), 0, mido.Message("note_off", note=int(p), velocity=0)))
    t = 0
    for tick, _, msg in sorted(ev, key=lambda e: (e[0], e[1])):
        tr.append(msg.copy(time=tick - t))
        t = tick
    tr.append(mido.MetaMessage("end_of_track", time=max(0, bars * 4 * tpb - t)))
    folder = "Bass" if role == "bass" else "Other"
    base = naming.slugify(name, 60) or "bassline"
    with LibraryDB(lib) as db:
        rel, k = f"MIDI/{folder}/{base}.mid", 1
        while db.midi_path_taken(rel) or (lib / rel).exists():
            k += 1
            rel = f"MIDI/{folder}/{base}-{k}.mid"
        (lib / rel).parent.mkdir(parents=True, exist_ok=True)
        mf.save(str(lib / rel))
        same = db.midi_by_sha1(zipio.sha1_file(lib / rel))
        if same is not None:  # the very same loop was saved before
            (lib / rel).unlink()
            return {"id": same["id"], "rel_path": same["rel_path"]}
        info = midimod.analyze(lib / rel, settings.thresholds)
        stored = [[round(n.start, 6), round(n.length, 6), n.pitch, n.velocity] for n in info.notes]
        mid = db.insert_midi(file_name=f"{name}.mid", rel_path=rel, original_path=None,
                             file_sha1=zipio.sha1_file(lib / rel), role=role, bars=bars,
                             key_label=key_label or info.key_label,
                             key_camelot=midimod.camelot(*midimod.parse_label(key_label)) if key_label else info.key_camelot,
                             notes=json.dumps(stored), created_at=now_iso())
    return {"id": mid, "rel_path": rel}


def serum_presets(settings: Settings, root: str, folders: list[str] | None) -> dict:
    from . import serum
    return {"folders": serum.preset_folders(root), "presets": serum.list_presets(root, folders) if folders else []}


def trash_files(lib: Path, removed_id: int) -> tuple[Path, Path]:
    """Where a deleted sample's WAV and peaks wait until it is restored."""
    d = library_dir(lib) / "trash"
    return d / f"{removed_id}.wav", d / f"{removed_id}.json"


def delete_samples(settings: Settings, sample_ids: list[int]) -> dict:
    """Delete single samples from the library into its trash. They stay deleted when the zip is
    reprocessed (re-cut into the trash instead) until restored."""
    lib = Path(settings.library_path)
    with LibraryDB(lib) as db:
        removed = db.remove_samples(sample_ids)
    for row, rid in removed:
        wav, pj = trash_files(lib, rid)
        wav.parent.mkdir(parents=True, exist_ok=True)
        src = lib / row["rel_path"]
        if src.exists():
            src.replace(wav)
        peaks = library_dir(lib) / "peaks" / f"{row['id']}.json"
        if peaks.exists():
            peaks.replace(pj)
    return {"deleted": len(removed)}


def _free_rel_path(db: LibraryDB, lib: Path, rel: str) -> str:
    """`rel`, or the same name with the next free number (a re-cut may have reused it)."""
    m = re.match(r"^(.*_)(\d+)(\.wav)$", rel)
    candidate, n = rel, 0
    while db.rel_path_taken(candidate) or (lib / candidate).exists():
        n += 1
        candidate = f"{m.group(1)}{int(m.group(2)) + n:02d}{m.group(3)}" if m else f"{rel[:-4]}_{n}.wav"
    return candidate


def restore_samples(settings: Settings, removed_ids: list[int]) -> dict:
    """Put deleted samples back from the trash. One without a trashed file (deleted before the
    trash existed) is only forgotten as deleted: the next reprocess of its zip brings it back."""
    lib = Path(settings.library_path)
    restored = pending = 0
    with LibraryDB(lib) as db:
        for r in db.get_removed(removed_ids):
            wav, pj = trash_files(lib, r["id"])
            sample = json.loads(r["sample"] or "null")
            stem = next((s for s in db.stems_for_zip(r["zip_id"]) if s["file_name"] == r["stem_file"]), None)
            if not sample or stem is None or not wav.exists():
                db.delete_removed(r["id"])
                wav.unlink(missing_ok=True)
                pj.unlink(missing_ok=True)
                pending += 1
                continue
            rel = _free_rel_path(db, lib, sample["rel_path"])
            with db.transaction():
                sid = db.insert_sample(zip_id=r["zip_id"], stem_id=stem["id"], **{**sample, "rel_path": rel},
                                       fingerprint=r["fingerprint"])
                db.delete_removed(r["id"])
                (lib / rel).parent.mkdir(parents=True, exist_ok=True)
                wav.replace(lib / rel)
            if pj.exists():
                pj.replace(library_dir(lib) / "peaks" / f"{sid}.json")
            restored += 1
    return {"restored": restored, "pending": pending}


def grid_preview(settings: Settings, zip_id: int) -> GridPreview:
    """The zip's drum stems summed to one mono file, for setting bar 1 by ear in the Grid view.

    All stems of a zip share one timeline, so one bar-1 offset fits them all.
    """
    th = settings.thresholds
    lib = Path(settings.library_path)
    with LibraryDB(lib) as db:
        row = db.get_zip(zip_id)
        if row is None:
            raise PipelineError("not_found", f"No zip with id {zip_id}")
        if row["kind"] == "pack":
            raise PipelineError("pack", "Loose samples have no shared grid to align")
        stems = db.stems_for_zip(zip_id)
    zip_path = Path(row["original_path"] or row["file_name"])
    category = {r["file_name"]: r["category_override"] or r["category"] for r in stems}
    names = [n for n, c in category.items() if c in DRUM_CATEGORIES]
    if not names:
        names = [n for n, c in category.items() if c in EVENT_CATEGORIES]
    if not names:
        raise PipelineError("no_drums", "This zip has no drum stems to align")
    sources = (row["bpm_source_stem"] or "").split(" + ")
    phase_sr = next((r["sample_rate"] for r in stems if r["file_name"] in sources and r["sample_rate"]), 44100)
    sr = th.grid_preview_sr
    with tempfile.TemporaryDirectory(prefix="drumvault-") as d:
        ex = _source(lib, row, Path(d))
        names = [n for n in names if n in ex.files]
        if not names:
            raise PipelineError("zip_changed", f"{zip_path} no longer has the processed stems")
        parts = [resample(ex.audio(n).mono(), ex.audio(n).sr, sr) for n in names]
    mix = np.zeros(max(len(p) for p in parts), dtype=np.float32)
    for p in parts:
        mix[:len(p)] += p
    peak = float(np.max(np.abs(mix))) if len(mix) else 0.0
    if peak > 0:
        mix *= 10 ** (th.grid_preview_peak_dbfs / 20) / peak
    out = library_dir(lib) / "grid" / f"{zip_id}.wav"
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out), mix, sr, subtype="PCM_16", format="WAV")
    manual = row["grid_offset_override_ms"] is not None
    bar_one_ms = (float(row["grid_offset_override_ms"]) if manual
                  else (row["phase_samples"] or 0) / phase_sr * 1000)
    return GridPreview(zip_id=zip_id, path=str(out), sample_rate=sr, duration_s=len(mix) / sr,
                       bpm=float(row["bpm_override"] or row["detected_bpm"] or settings.library_bpm),
                       bar_one_ms=bar_one_ms, manual=manual, stems=sorted(names))


def analyze_library(settings: Settings, ctx: JobContext | None = None) -> dict:
    """Fill in what older libraries lack: loop grooves (from the loop files), event shapes (from
    the event files), the kept originals (copied from where the zips and packs came from) and
    each zip's arrangement (from its stems, on its stored grid). Nothing else changes."""
    ctx = ctx or JobContext()
    th = settings.thresholds
    lib = Path(settings.library_path)
    with LibraryDB(lib) as db:
        loops = db.loops_without_groove()
        events = db.events_without_shape()
        zips = db.zips_without_arrangement()
        unkept = _unkept(lib, db)
        total = max(1, len(loops) + len(events) + 10 * len(unkept) + 10 * len(zips))
        for i, r in enumerate(loops):
            ctx.check()
            if i % 10 == 0:
                ctx.progress("groove", i / total, f"Loop grooves ({i + 1}/{len(loops)})")
            path = lib / r["rel_path"]
            g = None
            if path.exists():
                a = load(path)
                g = groovemod.loop_groove(a.data, a.sr, float(r["bpm"] or settings.library_bpm), th)
            db.set_groove(r["id"], g)
        zip_rows = {}
        for i, r in enumerate(events):
            ctx.check()
            if i % 10 == 0:
                ctx.progress("shape", (len(loops) + i) / total, f"Event shapes ({i + 1}/{len(events)})")
            path = lib / r["rel_path"]
            if not path.exists():
                continue
            bar = None
            if r["zip_kind"] == "stems" and r["source_offset_s"] is not None:
                z = zip_rows.get(r["zip_id"]) or zip_rows.setdefault(r["zip_id"], db.get_zip(r["zip_id"]))
                bpm = float(z["bpm_override"] or z["detected_bpm"] or settings.library_bpm)
                bar = int(round((float(r["source_offset_s"]) - _bar_one_s(db, z)) * bpm / 240.0))
            a = load(path)
            db.set_shape(r["id"], _event_shape(a.data, a.sr, float(r["bpm"] or settings.library_bpm), int(r["bars"] or 1),
                                               r["body_bars"], bar, th))
        not_kept = []
        for j, z in enumerate(unkept):
            ctx.check()
            at = (len(loops) + len(events) + 10 * j) / total
            ctx.progress("keep", at, f"Keeping {z['file_name']} in the library ({j + 1}/{len(unkept)})")
            sub = JobContext(progress=lambda st, pct, msg, at=at: ctx.progress(st, at + 10 * pct / total, msg),
                             is_cancelled=ctx.is_cancelled)
            src = Path(z["original_path"])
            with tempfile.TemporaryDirectory(prefix="drumvault-") as d:
                if z["kind"] == "pack":
                    files = {r["file_name"]: src / r["file_name"] for r in db.stems_for_zip(z["id"])
                             if (src / r["file_name"]).exists()}
                    w = None
                else:
                    # Checked before unzipping: a full disk shouldn't cost an extract every launch.
                    w = originals.no_room(lib, src.stat().st_size, th)
                    if w is None and zipio.sha1_file(src) != z["file_sha1"]:
                        w = f"{src} has changed since it was processed; not kept"
                    files = {} if w else extract(src, Path(d)).files
                w = w or _keep_original(lib, z["source_code"], files, settings, sub, 0.0, 1.0)
            if w:
                not_kept.append(f"{z['file_name']}: {w}")
        missing = []
        base = len(loops) + len(events) + 10 * len(unkept)
        for j, z in enumerate(zips):
            ctx.check()
            ctx.progress("arrangement", (base + 10 * j) / total,
                         f"Arrangement of {z['file_name']} ({j + 1}/{len(zips)})")
            if not has_source(lib, z):
                missing.append(z["file_name"])
                continue
            stems = db.stems_for_zip(z["id"])
            category = {r["file_name"]: r["category_override"] or r["category"] for r in stems}
            bar_one_s = _bar_one_s(db, z)
            bpm = float(z["bpm_override"] or z["detected_bpm"] or settings.library_bpm)
            with tempfile.TemporaryDirectory(prefix="drumvault-") as d:
                ex = _source(lib, z, Path(d))
                names = [n for n, c in category.items() if n in ex.files and arrmod.part_of(n, c)]
                arr = arrmod.measure([(n, category[n], ex.audio(n).mono(), ex.audio(n).sr) for n in names],
                                     bpm, bar_one_s, th)
            db.set_arrangement(z["id"], arr)
    ctx.progress("done", 1.0, f"{len(loops)} loop grooves, {len(events)} event shapes, "
                              f"{len(unkept) - len(not_kept)} originals kept, {len(zips) - len(missing)} arrangements")
    return {"grooves": len(loops), "shapes": len(events), "kept": len(unkept) - len(not_kept), "not_kept": not_kept,
            "arrangements": len(zips) - len(missing), "missing": missing}


def rebuild_loops(settings: Settings, ctx: JobContext | None = None) -> list[ProcessResult]:
    """Re-stretch and re-cut every zip's loops and events at the (new) library BPM; one-shots stay."""
    ctx = ctx or JobContext()
    with LibraryDB(settings.library_path) as db:
        rows = [r for r in db.list_zips() if r["status"] in ("done", "needs_review")]
    results = []
    for i, r in enumerate(rows):
        ctx.check()
        ctx.progress("rebuild", i / max(1, len(rows)), f"{r['file_name']} ({i + 1}/{len(rows)})")
        if not has_source(Path(settings.library_path), r):
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

