"""The pre-flight (SCOPE.md §6.5a): an export's masters measured as they were written, before the
track goes out. The critic and the mix check in Generate work from what was measured of the
samples; this listens to the result: the mixdown, and the master made from it.

Both are profiled (mixprofile.py) on the project's grid, the drops taken from the track's sections
where it has them, and turned into checks, each "ok", "warn" or "info" (a number with nothing to
hold it against) with its value and, when it is off, what is off:

- the master's loudness in what House of Tracks takes, and its true peak;
- how much the master took off the peaks, and whether it flattened the drops;
- every drop landing: louder, or with more low end, than the bars before it;
- the low end in the middle, no DC, bar 1 sounding, the end not cut off;
- a kick on every beat through the first and the last bars (the DJ's mix-in and mix-out);
- the key the mix reads as against the track's;
- and, with enough reference tracks (references.py), its tone, its width and its dynamics against
  theirs.

Nothing is changed and nothing is written: the checks are for the user to read.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import soundfile as sf

from . import key as keymod, mixprofile, references
from .config import Settings, Thresholds

log = logging.getLogger(__name__)

REGION_NAMES = ("lows", "low mids", "mids", "high mids", "highs")


class PreflightError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _check(cid: str, label: str, status: str, value: str, detail: str = "") -> dict:
    return {"id": cid, "label": label, "status": status, "value": value, "detail": detail}


def _signed(v: float, unit: str) -> str:
    return f"{'+' if v >= 0 else '−'}{abs(v):.1f} {unit}"


def _num(v: float, unit: str, digits: int = 1) -> str:
    return f"{'−' if v < 0 else ''}{abs(v):.{digits}f} {unit}"


def key_check(mono: np.ndarray, sr: int, label: str, th: Thresholds) -> dict:
    """The key the mix reads as against the track's `label`."""
    name = "Key"
    try:
        pc, scale = keymod.parse_label(label)
        k = keymod.detect_key_audio(mono, sr, th, source="full_mix")
    except Exception as e:
        return _check("key", name, "info", label, f"The mix's key couldn't be read ({e}).")
    if k.label is None:
        return _check("key", name, "info", label, "The mix's key couldn't be read.")
    if k.label == keymod.make_label(pc, scale):
        return _check("key", name, "ok", k.label, "The mix reads as the track's key.")
    heard, want = k.camelot or "", keymod.camelot(pc, scale)
    if heard[:-1] == want[:-1]:
        return _check("key", name, "info", f"{label} (reads as {k.label})", f"{k.label} is the relative key of {label}: the same notes.")
    if k.confidence < th.preflight_key_confidence:
        return _check("key", name, "info", f"{label} (reads as {k.label})",
                      f"Read with little confidence ({k.confidence:.2f}): a track of mostly drums has little to read a key from.")
    return _check("key", name, "warn", f"{label} (reads as {k.label})",
                  f"The mix reads as {k.label} ({k.camelot}), the track is labelled {label} ({want}): a part may be out of key.")


def checks(mix: dict, master: dict | None, refs: dict | None, th: Thresholds, whole: bool = True) -> list[dict]:
    """The checks from the mixdown's and the master's profiles and the references' summary."""
    out: list[dict] = []
    subject, what = (master, "master") if master else (mix, "mixdown")

    if master:
        lu = master["lufs"]
        if lu is not None:
            ok = th.preflight_lufs_min <= lu <= th.preflight_lufs_max
            out.append(_check("loudness", "Loudness", "ok" if ok else "warn", _num(lu, "LUFS"),
                              "" if ok else f"House of Tracks takes {th.preflight_lufs_min:g} to {th.preflight_lufs_max:g} LUFS integrated."))
        tp = master["true_peak_db"]
        if tp is not None:
            ok = tp <= th.preflight_true_peak_max_db
            out.append(_check("true_peak", "True peak", "ok" if ok else "warn", _num(tp, "dBTP"),
                              "" if ok else f"Between the samples the master peaks over {th.preflight_true_peak_max_db:+g} dB: "
                              "it can distort when converted (MP3, a club's converters)."))
        if mix["plr_db"] is not None and master["plr_db"] is not None:
            took = mix["plr_db"] - master["plr_db"]
            ok = took <= th.preflight_limiter_max_db
            ref = refs and refs.get("plr_db")
            out.append(_check("limiter", "Limiting", "ok" if ok else "warn", f"{took:.1f} dB off the peaks",
                              (f"The mixdown's peaks stand {mix['plr_db']:.1f} dB over its loudness, the master's {master['plr_db']:.1f}"
                               + (f" (references: {ref['median']:.1f}, {ref['min']:.1f} to {ref['max']:.1f})" if ref else "") + ". ")
                              + ("" if ok else "The limiter works hard: a kick or a bass that is too loud in the mix is what it pulls down.")))
        if mix["lift_lu"] is not None and master["lift_lu"] is not None:
            lost = mix["lift_lu"] - master["lift_lu"]
            ok = lost <= th.preflight_lift_loss_lu
            out.append(_check("flattened", "Drops after mastering", "ok" if ok else "warn",
                              f"{_signed(master['lift_lu'], 'LU')} (mixdown {_signed(mix['lift_lu'], 'LU')})",
                              "" if ok else f"The master takes {lost:.1f} LU off how much the drops come up: the limiter is flattening them."))

    drops = [d for d in subject["drops"] if d["lift_lu"] is not None]
    if drops:
        flat = [d for d in drops if d["lift_lu"] < th.preflight_lift_min_lu and d["lift_low_db"] < th.preflight_lift_min_low_db]
        ref = refs and refs.get("lift_lu")
        detail = "; ".join(f"bar {d['bar'] + 1}: {_signed(d['lift_lu'], 'LU')}, lows {_signed(d['lift_low_db'], 'dB')}" for d in drops)
        if ref:
            detail += f". References: {_signed(ref['median'], 'LU')} ({ref['min']:.1f} to {ref['max']:.1f})"
        if flat:
            detail = (f"The drop{'s' if len(flat) > 1 else ''} at bar {', '.join(str(d['bar'] + 1) for d in flat)} "
                      f"{'are' if len(flat) > 1 else 'is'} no louder and no heavier than the {th.profile_lift_bars} bars before. ") + detail
        out.append(_check("drops", "Drops land", "warn" if flat else "ok",
                          f"{len(drops) - len(flat)} of {len(drops)}", detail))
    elif not subject["drops"]:
        out.append(_check("drops", "Drops land", "info", "no drops", "No drop was found in the track."))

    if subject["low_side_db"] is not None:
        ok = subject["low_side_db"] <= th.preflight_low_side_max_db
        out.append(_check("low_mono", "Low end in the middle", "ok" if ok else "warn",
                          f"sides {_num(subject['low_side_db'], 'dB')}",
                          "" if ok else f"Under {th.profile_mono_hz:g} Hz the sides carry more than {th.preflight_low_side_max_db:g} dB "
                          "against the middle: the low end thins out on a mono club system."))

    if subject["dc_db"] is not None and subject["dc_db"] > th.preflight_dc_max_db:
        out.append(_check("dc", "DC offset", "warn", _num(subject["dc_db"], "dBFS"), f"The {what} sits off zero: headroom lost to nothing."))

    if whole:
        head = subject["head_ms"]
        if head is not None:
            ok = head <= th.preflight_head_max_ms
            out.append(_check("head", "Starts on bar 1", "ok" if ok else "warn", f"{head:.0f} ms",
                              "" if ok else f"The first {head:.0f} ms are silent: a DJ cueing bar 1 has nothing under the cue."))
        if subject["tail_db"] is not None:
            ok = subject["tail_db"] <= th.preflight_tail_max_db
            out.append(_check("tail", "Ends clean", "ok" if ok else "warn",
                              "ends in silence" if subject["tail_db"] <= -90 else _num(subject["tail_db"], "dBFS"),
                              "" if ok else "The file ends while it still sounds: the last bar is cut off with a click."))
        for name, title in (("intro", "Mix-in"), ("outro", "Mix-out")):
            p = subject[name]
            if not p or p["pulse_db"] is None:
                continue
            kick = p["pulse_db"] >= th.preflight_pulse_min_db and (p["low_rel_db"] is None or p["low_rel_db"] >= th.preflight_dj_low_rel_db)
            where = "first" if name == "intro" else "last"
            out.append(_check(name, title, "ok" if kick else "warn",
                              f"kick through the {where} {p['bars']} bars" if kick else f"no steady kick in the {where} {p['bars']} bars",
                              "" if kick else f"The lows are {_signed(p['pulse_db'], 'dB')} on the beats"
                              + (f" and {_num(p['low_rel_db'], 'dB')} against the drops'" if p["low_rel_db"] is not None else "")
                              + ": nothing for a DJ to beat-match on."))

    regions = refs and refs.get("regions")
    if regions and subject["regions"]:
        off = []
        for name, v, r in zip(REGION_NAMES, subject["regions"], regions):
            if r and abs(v - r["median"]) > th.preflight_tone_off_db and not r["min"] <= v <= r["max"]:
                off.append(f"the {name} are {abs(v - r['median']):.1f} dB {'over' if v > r['median'] else 'under'} "
                           f"(references {r['min']:.1f} to {r['max']:.1f} dB of the mix, here {v:.1f})")
        out.append(_check("tone", "Tone against the references", "warn" if off else "ok",
                          f"{len(off)} of {len(REGION_NAMES)} regions off" if off else "within the references",
                          ("In the drops " + "; ".join(off) + ".") if off else f"Against {refs['tracks']} tracks, in the drops."))
        w = refs.get("width_db")
        if w and subject["width_db"] is not None:
            v = subject["width_db"]
            bad = abs(v - w["median"]) > th.preflight_width_off_db and not w["min"] <= v <= w["max"]
            out.append(_check("width", "Width against the references", "warn" if bad else "ok", f"sides {_num(v, 'dB')}",
                              f"The references' sides are at {w['median']:.1f} dB against the middle ({w['min']:.1f} to {w['max']:.1f}): "
                              f"this is {'wider' if v > w['median'] else 'narrower'} than all of them." if bad else ""))
    else:
        out.append(_check("tone", "Tone against the references", "info", "no references",
                          f"With {th.reference_min_tracks} or more tracks in the library's References folder (Settings), "
                          "the tone, width and dynamics are held against them."))
    return out


def _load(path: Path) -> tuple[np.ndarray, int]:
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return data, int(sr)


def run(settings: Settings, mix_path: str, master_path: str | None, bpm: float,
        sections: list[dict] | None = None, key_label: str | None = None, whole: bool = True) -> dict:
    """Check the masters of an export: {"subject", "mix", "master", "checks", "warnings",
    "references": {"tracks", "pending"}}. `sections`: the track's, as {"kind", "start", "bars"}
    in bars from the file's start (its drops are then known); `whole`: the file is the whole track."""
    mix = Path(mix_path)
    master = Path(master_path) if master_path else None
    for p in (mix, master):
        if p is not None and not (p.is_absolute() and p.suffix.lower() == ".wav"):
            raise PreflightError("bad_path", f"Bad pre-flight path: {p}")
    if not mix.exists():
        raise PreflightError("not_found", f"No mixdown at {mix_path}")
    if not bpm or bpm <= 0:
        raise PreflightError("bad_request", "The pre-flight needs the project's tempo")
    th = settings.thresholds
    drops = [(int(s["start"]), int(s["start"]) + int(s["bars"])) for s in sections if s.get("kind") == "drop"] if sections else None
    data, sr = _load(mix)
    if not data.size or not float(np.max(np.abs(data))) > 0:
        raise PreflightError("silent", "The mixdown is silent")
    mix_profile = mixprofile.measure(data, sr, bpm, 0.0, th, drops)
    key = key_check(data.mean(axis=1), sr, key_label, th) if key_label else None
    del data
    master_profile = None
    if master is not None and master.exists():
        mdata, msr = _load(master)
        # The same drops as the mixdown's (found there when the track has no sections): a master is
        # flatter, so its own would be found elsewhere and the two couldn't be compared.
        master_profile = mixprofile.measure(mdata, msr, bpm, 0.0, th,
                                            drops if drops is not None else [(d["bar"], d["bar"] + d["bars"]) for d in mix_profile["drops"]])
        del mdata
    try:
        refs = references.scan(settings) if settings.library_path else {"tracks": [], "pending": 0, "summary": None}
    except Exception as e:  # the references are extra: the export's own checks stand without them
        log.warning("references not read: %s", e)
        refs = {"tracks": [], "pending": 0, "summary": None}
    out = checks(mix_profile, master_profile, refs["summary"], th, whole)
    if key:
        out.append(key)
    order = {"warn": 0, "ok": 1, "info": 2}
    out.sort(key=lambda c: order[c["status"]])
    return {"subject": "master" if master_profile else "mixdown", "mix": mix_profile, "master": master_profile,
            "checks": out, "warnings": sum(1 for c in out if c["status"] == "warn"),
            "references": {"tracks": len([t for t in refs["tracks"] if t["profile"]]), "pending": refs["pending"]}}
