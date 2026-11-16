"""The mix profile, the pre-flight's checks and the reference tracks, on a synthetic club track:
a kick-and-hats intro and outro, two drops with a bass and a chord, breakdowns between."""

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import butter, sosfilt

from drumvault_engine import mixprofile, preflight, references
from drumvault_engine.config import Settings, Thresholds

SR = 44100
# (kind, bars): 80 bars.
SECTIONS = [("intro", 16), ("break", 8), ("drop", 16), ("break", 8), ("drop", 16), ("outro", 16)]


def sections() -> list[dict]:
    out, start = [], 0
    for kind, bars in SECTIONS:
        out.append({"kind": kind, "start": start, "bars": bars})
        start += bars
    return out


def track(bpm: float = 124.0, *, lead_s: float = 0.0, intro_kick: bool = True, wide_lows: bool = False,
          dark: bool = False, flat_drop: bool = False, seed: int = 1) -> np.ndarray:
    """The track as (frames, 2). `lead_s`: silence before bar 1; `intro_kick`: off, the intro is
    hats only; `wide_lows`: the bass out of phase between the sides; `dark`: no highs; `flat_drop`:
    the breakdowns as full as the drops."""
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    bars = sum(b for _, b in SECTIONS)
    n = int(round(bars * 4 * beat * SR))
    t = np.arange(n) / SR
    ph = t % beat
    kick = 0.8 * np.sin(2 * np.pi * (50 + 120 * np.exp(-ph * 30)) * ph) * np.exp(-ph * 9)
    off = (t - beat / 2) % beat
    bass = 0.35 * np.sin(2 * np.pi * 55 * t) * np.exp(-off * 6) * (off < beat * 0.45)
    hp = butter(4, 6000, btype="highpass", fs=SR, output="sos")
    hats = np.stack([sosfilt(hp, rng.standard_normal(n)) for _ in range(2)], axis=1) * (0.12 * np.exp(-off * 40))[:, None]
    pad = 0.08 * sum(np.sin(2 * np.pi * f * t) for f in (220.0, 261.63, 329.63))
    # What fills a drop up: a clap on 2 and 4 and a top loop on the 16ths.
    two = (t - beat) % (2 * beat)
    bp = butter(2, [900, 5000], btype="bandpass", fs=SR, output="sos")
    clap = sosfilt(bp, rng.standard_normal(n)) * 0.8 * np.exp(-two * 25)
    tops = np.stack([sosfilt(bp, rng.standard_normal(n)) for _ in range(2)], axis=1) * (0.25 * np.exp(-(t % (beat / 4)) * 45))[:, None]
    out = np.zeros((n, 2))
    start = 0
    for kind, b in SECTIONS:
        a, z = int(round(start * 4 * beat * SR)), int(round((start + b) * 4 * beat * SR))
        seg = slice(a, z)
        full = kind == "drop" or (flat_drop and kind == "break")
        if full or (kind in ("intro", "outro") and intro_kick):
            out[seg] += kick[seg, None]
        if full:
            out[seg] += clap[seg, None] + tops[seg]
            out[seg, 0] += bass[seg]
            out[seg, 1] += -bass[seg] if wide_lows else bass[seg]
        if kind != "break" or flat_drop:
            out[seg] += hats[seg]
        if full or kind == "break":
            out[seg] += pad[seg, None]
        start += b
    if dark:
        out = sosfilt(butter(4, 1500, btype="lowpass", fs=SR, output="sos"), out, axis=0)
    fade = int(0.05 * SR)
    out[-fade:] *= np.linspace(1, 0, fade)[:, None]
    if lead_s:
        out = np.concatenate([np.zeros((int(lead_s * SR), 2)), out])
    return (0.5 * out).astype(np.float32)


@pytest.fixture(scope="module")
def base() -> np.ndarray:
    return track()


@pytest.fixture(scope="module")
def th() -> Thresholds:
    return Thresholds()


def drops_of() -> list[tuple[int, int]]:
    return [(s["start"], s["start"] + s["bars"]) for s in sections() if s["kind"] == "drop"]


def status(checks: list[dict], cid: str) -> str | None:
    return next((c["status"] for c in checks if c["id"] == cid), None)


def test_profiles_a_track_on_its_sections(base, th):
    p = mixprofile.measure(base, SR, 124.0, 0.0, th, drops_of())
    assert p["bars"] == 80 and p["sections_known"] and p["full_bars"] == 32
    assert -30 < p["lufs"] < -5 and p["true_peak_db"] >= p["peak_db"] and p["plr_db"] > 3
    assert [d["bar"] for d in p["drops"]] == [24, 48]
    assert all(d["lift_lu"] > 1 and d["lift_low_db"] > 6 for d in p["drops"])   # a breakdown before each
    assert p["break_depth_lu"] > 3
    assert p["low_side_db"] < -30                  # kick and bass in the middle
    assert p["width_db"] < 0                       # the hats differ between the sides, the rest doesn't
    assert p["head_ms"] < 5 and p["tail_db"] < -40
    assert p["intro"]["pulse_db"] > 6 and p["outro"]["pulse_db"] > 6
    lows, _, _, _, highs = p["regions"]
    assert lows > -6 and highs < lows              # a kick and a bass: most of the power


def test_finds_the_drops_without_sections(base, th):
    p = mixprofile.measure(base, SR, 124.0, 0.0, th)
    assert not p["sections_known"]
    assert [(d["bar"], d["bars"]) for d in p["drops"]] == [(24, 16), (48, 16)]
    # The intro and outro are a kick and hats, well under the drops: not full.
    assert p["full_bars"] == 32


def test_true_peak_is_over_the_samples_between_them(th):
    # A sine at a quarter of the sample rate, sampled 45° off its crests: the samples reach 0.707 of it.
    n = np.arange(SR)
    x = np.sin(2 * np.pi * (SR / 4) * n / SR + np.pi / 4).astype(np.float32)[:, None].repeat(2, axis=1)
    assert abs(20 * np.log10(np.max(np.abs(x))) - -3.01) < 0.05
    assert abs(mixprofile.true_peak_db(x, th) - 0.0) < 0.2


def test_a_good_track_passes(base, th):
    p = mixprofile.measure(base, SR, 124.0, 0.0, th, drops_of())
    cs = preflight.checks(p, None, None, th)
    assert [c["id"] for c in cs if c["status"] == "warn"] == []
    assert status(cs, "drops") == "ok" and status(cs, "intro") == "ok" and status(cs, "outro") == "ok"
    assert status(cs, "low_mono") == "ok" and status(cs, "head") == "ok" and status(cs, "tail") == "ok"
    assert status(cs, "tone") == "info"            # nothing to hold it against
    assert status(cs, "loudness") is None          # no master: nothing to say of one


@pytest.mark.parametrize("fault, check", [
    ({"wide_lows": True}, "low_mono"),
    ({"intro_kick": False}, "intro"),
    ({"flat_drop": True}, "drops"),
])
def test_says_what_is_wrong(fault, check, th):
    p = mixprofile.measure(track(**fault), SR, 124.0, 0.0, th, drops_of())
    cs = preflight.checks(p, None, None, th)
    assert status(cs, check) == "warn", [c for c in cs if c["id"] == check]


def test_a_silent_start_and_a_cut_end(base, th):
    late = np.concatenate([np.zeros((int(0.1 * SR), 2), dtype=np.float32), base])
    cut = base[:len(base) - int(round(8 * 60 / 124 * SR)) + 2000]  # ends in the middle of a kick
    assert status(preflight.checks(mixprofile.measure(late, SR, 124.0, 0.0, th, drops_of()), None, None, th), "head") == "warn"
    assert status(preflight.checks(mixprofile.measure(cut, SR, 124.0, 0.0, th, drops_of()), None, None, th), "tail") == "warn"
    # A loop region isn't a whole track: neither is asked of it.
    cs = preflight.checks(mixprofile.measure(late, SR, 124.0, 0.0, th, drops_of()), None, None, th, whole=False)
    assert status(cs, "head") is None and status(cs, "intro") is None


def test_the_master_against_its_mixdown(base, th):
    mix = mixprofile.measure(base, SR, 124.0, 0.0, th, drops_of())
    good = dict(mix, lufs=-6.5, true_peak_db=0.3, plr_db=6.8, lift_lu=mix["lift_lu"] - 0.5)
    cs = preflight.checks(dict(mix, plr_db=14.0), good, None, th)
    assert status(cs, "loudness") == "ok" and status(cs, "true_peak") == "ok"
    assert status(cs, "limiter") == "ok" and status(cs, "flattened") == "ok"
    crushed = dict(good, lufs=-3.9, true_peak_db=1.8, lift_lu=mix["lift_lu"] - 3)
    cs = preflight.checks(dict(mix, plr_db=20.5), crushed, None, th)
    assert [status(cs, c) for c in ("loudness", "true_peak", "limiter", "flattened")] == ["warn"] * 4


def write(path: Path, data: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), data, SR, subtype="PCM_16")


@pytest.fixture(scope="module")
def lib(tmp_path_factory, base) -> Settings:
    """A library with three reference tracks at three tempos, one not starting on bar 1."""
    root = tmp_path_factory.mktemp("reflib")
    s = Settings(library_path=str(root))
    write(root / "References" / "One - 124.wav", base)
    write(root / "References" / "Two.wav", track(126.0, seed=2))
    write(root / "References" / "label" / "Three.wav", track(128.0, lead_s=0.25, seed=3))
    return s


def test_measures_the_references(lib: Settings):
    before = references.scan(lib)
    assert before["tracks"] == [] and before["pending"] == 3 and before["summary"] is None
    r = references.scan(lib, analyze=True)
    assert r["pending"] == 0 and [t["name"] for t in r["tracks"]] == ["Three", "One - 124", "Two"]
    by = {t["name"]: t for t in r["tracks"]}
    assert [by[n]["bpm"] for n in ("One - 124", "Two", "Three")] == [124.0, 126.0, 128.0]
    for t in r["tracks"]:
        p = t["profile"]
        assert t["error"] is None and len(p["drops"]) == 2 and p["lift_lu"] > 1, t["name"]
        assert abs(p["drops"][0]["bar"] - 24) <= 1 and abs(p["drops"][1]["bar"] - 48) <= 1
    sm = r["summary"]
    assert sm["tracks"] == 3 and sm["lift_lu"]["n"] == 3 and len(sm["regions"]) == 5
    assert sm["bpm"] == {"median": 126.0, "min": 124.0, "max": 128.0, "n": 3}
    # Measured once: nothing to do the second time, and the list is the same without `analyze`.
    again = references.scan(lib)
    assert [t["analyzed_at"] for t in again["tracks"]] == [t["analyzed_at"] for t in r["tracks"]]


def test_references_follow_the_folder(lib: Settings):
    references.scan(lib, analyze=True)
    root = references.folder(lib)
    write(root / "short.wav", track()[: SR * 5])
    (root / "notes.txt").write_text("not audio")
    assert references.scan(lib)["pending"] == 1
    r = references.scan(lib, analyze=True)
    short = next(t for t in r["tracks"] if t["name"] == "short")
    assert short["profile"] is None and "30 seconds" in short["error"]
    assert r["summary"]["tracks"] == 3             # it doesn't count
    (root / "short.wav").unlink()
    assert "short" not in [t["name"] for t in references.scan(lib, analyze=True)["tracks"]]


def test_preflight_of_an_export_against_the_references(lib: Settings, base, tmp_path: Path):
    references.scan(lib, analyze=True)
    mix = tmp_path / "masters" / "mixdown.wav"
    write(mix, base)
    r = preflight.run(lib, str(mix), None, 124.0, sections(), "Am")
    assert r["subject"] == "mixdown" and r["master"] is None and r["references"] == {"tracks": 3, "pending": 0}
    assert status(r["checks"], "tone") == "ok" and status(r["checks"], "width") == "ok"
    assert status(r["checks"], "key") in ("ok", "info", "warn")
    assert r["warnings"] == sum(1 for c in r["checks"] if c["status"] == "warn")
    # A master next to it is what is checked; a dull one is off against the references.
    write(mix.with_name("mastered.wav"), track(dark=True))
    r = preflight.run(lib, str(mix), str(mix.with_name("mastered.wav")), 124.0, sections())
    assert r["subject"] == "master" and status(r["checks"], "tone") == "warn"
    assert status(r["checks"], "loudness") == "warn"   # nowhere near a master's level
    assert r["checks"][0]["status"] == "warn"          # what is wrong comes first


def test_preflight_refuses_what_it_cannot_check(tmp_path: Path):
    s = Settings(library_path=str(tmp_path))
    with pytest.raises(preflight.PreflightError) as e:
        preflight.run(s, str(tmp_path / "nope.wav"), None, 124.0)
    assert e.value.code == "not_found"
    with pytest.raises(preflight.PreflightError) as e:
        preflight.run(s, "relative.wav", None, 124.0)
    assert e.value.code == "bad_path"
    write(tmp_path / "silent.wav", np.zeros((SR, 2), dtype=np.float32))
    with pytest.raises(preflight.PreflightError) as e:
        preflight.run(s, str(tmp_path / "silent.wav"), None, 124.0)
    assert e.value.code == "silent"
