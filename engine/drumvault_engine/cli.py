"""Standalone CLI for Phase 1 and debugging (SCOPE.md §5.15).

    python -m drumvault_engine cli process <zip_or_folder>... --library ./out --bpm 124
    python -m drumvault_engine cli analyze <zip>
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from . import pipeline
from .config import Settings
from .schemas import Overrides


def _settings(args) -> Settings:
    data = json.loads(Path(args.settings).read_text()) if getattr(args, "settings", None) else {}
    s = Settings.from_dict(data)
    if getattr(args, "library", None):
        s.library_path = str(Path(args.library).resolve())
    if getattr(args, "bpm", None):
        s.library_bpm = float(args.bpm)
    if getattr(args, "workers", None):
        s.workers = int(args.workers)
    if getattr(args, "lufs", False):
        s.loop_norm_mode = "lufs"
    if getattr(args, "float32", False):
        s.output_format = "float32"
    if getattr(args, "sample_rate", None):
        s.output_sample_rate = int(args.sample_rate)
    return s


def _progress(name: str):
    def cb(stage: str, pct: float, msg: str) -> None:
        print(f"  [{pct * 100:5.1f}%] {stage:<8} {msg}", file=sys.stderr)
    return pipeline.JobContext(progress=cb)


def _overrides(args) -> Overrides:
    stems = {}
    for item in args.stem or []:
        name, _, cat = item.rpartition("=")
        stems[name] = cat
    return Overrides(bpm=args.source_bpm, key=args.key, grid_offset_ms=args.grid_offset_ms, stems=stems)


def cmd_process(args) -> int:
    settings = _settings(args)
    zips = pipeline.find_zips(args.paths)
    if not zips:
        print("No zips found", file=sys.stderr)
        return 1
    failed = 0
    for z in zips:
        print(f"== {z.name}", file=sys.stderr)
        try:
            r = pipeline.process_zip(z, settings, reprocess=args.reprocess, overrides=_overrides(args),
                                     ctx=_progress(z.name))
        except pipeline.PipelineError as e:
            print(f"{z.name}: ERROR {e}")
            failed += 1
            continue
        line = f"{r.source_code or '-'}  {z.name}: {r.status}"
        if r.analysis:
            t, k = r.analysis.tempo, r.analysis.key
            line += (f"  {t.bpm:g} BPM (conf {t.confidence:.2f})  key {k.label or 'NoKey'}"
                     f"{'?' if k.uncertain else ''}")
        line += f"  one-shots {r.counts.oneshots}  loops {r.counts.loops}  fx/fills {r.counts.events}"
        print(line)
        for w in r.warnings:
            print(f"    ! {w}")
    return 1 if failed else 0


def cmd_analyze(args) -> int:
    settings = _settings(args)
    a = pipeline.analyze_zip(args.zip, settings)
    if args.json:
        print(a.model_dump_json(indent=2))
        return 0
    print(f"{a.file_name}  (sha1 {a.file_sha1[:12]})")
    print("Stems:")
    for s in a.stems:
        flag = " [auto]" if s.auto_classified else ""
        roles = ",".join(s.used_for)
        print(f"  {s.category:<10} {s.file_name}{flag}  {s.duration_s:.1f}s {s.sample_rate}Hz "
              f"{s.channels}ch  {roles}")
    t = a.tempo
    print(f"Tempo: {t.bpm:g} BPM (raw {t.raw_bpm:.3f}, from {t.source_stem}), "
          f"phase {t.phase_samples} samples")
    k = a.key
    print(f"Key:   {k.label or 'NoKey'} {k.camelot or ''} (conf {k.confidence:.2f}, {k.backend}"
          f"{', uncertain' if k.uncertain else ''})")
    for w in a.warnings:
        print(f"  ! {w}")
    return 0


def cmd_delete(args) -> int:
    print(json.dumps(pipeline.delete_zip(_settings(args), args.zip_id, not args.keep_files)))
    return 0


def cmd_rebuild(args) -> int:
    for r in pipeline.rebuild_loops(_settings(args), ctx=_progress("rebuild")):
        print(f"{r.source_code}  {r.file_name}: {r.status}  loops {r.counts.loops}  fx/fills {r.counts.events}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="drumvault_engine cli")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p, library_required: bool):
        p.add_argument("--library", required=library_required, help="target library folder")
        p.add_argument("--bpm", type=float, help="library BPM (default 124)")
        p.add_argument("--settings", help="settings JSON file")
        p.add_argument("-v", "--verbose", action="store_true")

    p = sub.add_parser("process", help="process zips (or folders of zips) into the library")
    p.add_argument("paths", nargs="+")
    common(p, True)
    p.add_argument("--reprocess", action="store_true", help="reprocess zips already in the library")
    p.add_argument("--workers", type=int)
    p.add_argument("--lufs", action="store_true", help="loudness-normalise loops")
    p.add_argument("--float32", action="store_true", help="write 32-bit float WAVs")
    p.add_argument("--sample-rate", type=int, choices=[44100, 48000])
    p.add_argument("--source-bpm", type=float, help="override the detected source BPM")
    p.add_argument("--grid-offset-ms", type=float, help="override the grid offset (bar 1)")
    p.add_argument("--key", help="override the detected key, e.g. Fm")
    p.add_argument("--stem", action="append", metavar="NAME=CATEGORY", help="override a stem category")
    p.set_defaults(fn=cmd_process)

    p = sub.add_parser("analyze", help="print classification, BPM and key; writes nothing")
    p.add_argument("zip")
    common(p, False)
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_analyze)

    p = sub.add_parser("delete", help="delete a zip's samples from the library")
    p.add_argument("zip_id", type=int)
    common(p, True)
    p.add_argument("--keep-files", action="store_true")
    p.set_defaults(fn=cmd_delete)

    p = sub.add_parser("rebuild-loops", help="re-stretch all loops and FX/fills at the library BPM")
    common(p, True)
    p.set_defaults(fn=cmd_rebuild)

    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING, stream=sys.stderr,
                        format="%(levelname)s %(name)s: %(message)s")
    return args.fn(args)
