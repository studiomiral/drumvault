"""Synthetic stem zips with known BPM, grid, key and structure.

Every fixture has 24 musical bars plus one silent tail bar, exported "from
bar 1" (sample 0 = downbeat):

    bars  1-8   full groove
    bars  9-16  breakdown: every drum stem is digitally silent, melodic stems continue
    bars 17-24  full groove again

Drum patterns repeat identically every bar (so 1-bar hat loops must dedupe to a
single loop), except the top loop, which uses pattern A in the first section
and a clearly different pattern B in the last one (two real variations).

Usage:  uv run python tests/make_fixtures.py <out_dir>
"""

from __future__ import annotations

import io
import json
import sys
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf
from scipy import signal

BARS = 24
BREAKDOWN = (8, 16)  # 0-based bar range [start, end) where all drums are silent
STEPS_PER_BAR = 16
TAIL_BARS = 1  # silent bar after the last musical bar


# --------------------------------------------------------------------------
# Sound design
# --------------------------------------------------------------------------

def _t(sr: int, seconds: float) -> np.ndarray:
    return np.arange(int(round(seconds * sr))) / sr


def _filt(x: np.ndarray, sr: int, btype: str, freq) -> np.ndarray:
    sos = signal.butter(4, freq, btype=btype, fs=sr, output="sos")
    return signal.sosfilt(sos, x)


def _gate(x: np.ndarray, floor: float = 1e-5) -> np.ndarray:
    """Zero the tail once the sound has decayed (keeps silence digital)."""
    above = np.nonzero(np.abs(x) > floor)[0]
    if len(above):
        x = x.copy()
        x[above[-1] + 1:] = 0.0
    return x


def _click(sr: int, n: int, amp: float, freq: float = 2500.0) -> np.ndarray:
    """One sine cycle: the stick/hand transient that makes real claps and snares peak first."""
    t = _t(sr, 1.0 / freq)
    out = np.zeros(n)
    out[:len(t)] = amp * np.sin(2 * np.pi * freq * t)
    return out


def kick(sr: int, rng) -> np.ndarray:
    t = _t(sr, 0.5)
    phase = 2 * np.pi * (45 * t + 105 * 0.03 * (1 - np.exp(-t / 0.03)))
    x = np.sin(phase) * np.exp(-t / 0.16)
    return _gate(x)


def clap(sr: int, rng) -> np.ndarray:
    t = _t(sr, 0.45)
    noise = _filt(rng.standard_normal(len(t)), sr, "bandpass", [900, 3500])
    noise /= np.max(np.abs(noise))
    env = np.zeros_like(t)
    for off, amp in ((0.0, 1.0), (0.009, 0.7), (0.018, 0.55)):
        m = t >= off
        env[m] += amp * np.exp(-(t[m] - off) / 0.004)
    m = t >= 0.018
    env[m] += 0.3 * np.exp(-(t[m] - 0.018) / 0.07)
    return _gate(noise * env + _click(sr, len(t), 1.3))


def snare(sr: int, rng) -> np.ndarray:
    t = _t(sr, 0.5)
    tone = np.sin(2 * np.pi * 185 * t) * np.exp(-t / 0.06)
    noise = _filt(rng.standard_normal(len(t)), sr, "highpass", 1000)
    noise /= np.max(np.abs(noise))
    return _gate(0.6 * tone + 0.7 * noise * np.exp(-t / 0.1) + _click(sr, len(t), 1.5))


def hat_closed(sr: int, rng) -> np.ndarray:
    t = _t(sr, 0.09)
    noise = _filt(rng.standard_normal(len(t)), sr, "highpass", 7000)
    return _gate(noise / np.max(np.abs(noise)) * np.exp(-t / 0.01))


def hat_open(sr: int, rng) -> np.ndarray:
    t = _t(sr, 0.45)
    noise = _filt(rng.standard_normal(len(t)), sr, "highpass", 6000)
    return _gate(noise / np.max(np.abs(noise)) * np.exp(-t / 0.055))


def ride(sr: int, rng) -> np.ndarray:
    t = _t(sr, 1.2)
    noise = _filt(rng.standard_normal(len(t)), sr, "highpass", 5000)
    noise /= np.max(np.abs(noise))
    bell = sum(np.sin(2 * np.pi * f * t) for f in (3100, 4700, 5900)) / 3
    return _gate(0.5 * noise * np.exp(-t / 0.15) + 0.4 * bell * np.exp(-t / 0.3))


def crash(sr: int, rng) -> np.ndarray:
    t = _t(sr, 3.5)
    noise = _filt(rng.standard_normal(len(t)), sr, "highpass", 4000)
    return _gate(noise / np.max(np.abs(noise)) * np.exp(-t / 0.6) + _click(sr, len(t), 1.3, 4000.0))


def shaker(sr: int, rng) -> np.ndarray:
    t = _t(sr, 0.1)
    noise = _filt(rng.standard_normal(len(t)), sr, "bandpass", [5000, 10000])
    noise /= np.max(np.abs(noise))
    env = np.minimum(t / 0.003, 1.0) * np.exp(-np.maximum(t - 0.003, 0) / 0.022)
    return _gate(noise * env)


def conga(sr: int, rng) -> np.ndarray:
    t = _t(sr, 0.35)
    f = 210 + 40 * np.exp(-t / 0.01)
    x = np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-t / 0.07)
    return _gate(x)


def rim(sr: int, rng) -> np.ndarray:
    t = _t(sr, 0.12)
    x = (np.sin(2 * np.pi * 1700 * t) + 0.6 * np.sin(2 * np.pi * 820 * t)) * np.exp(-t / 0.015)
    return _gate(x)


def midi_hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def tone(sr: int, freq: float, seconds: float, harmonics: int, attack: float,
         release: float, rolloff: float = 1.0) -> np.ndarray:
    t = _t(sr, seconds)
    x = sum(np.sin(2 * np.pi * freq * k * t) / k ** rolloff for k in range(1, harmonics + 1))
    env = np.minimum(t / attack, 1.0) * np.minimum((seconds - t) / release, 1.0)
    return x * np.clip(env, 0, 1)


# --------------------------------------------------------------------------
# Arrangement helpers
# --------------------------------------------------------------------------

class Track:
    def __init__(self, bpm: float, sr: int, bars: int = BARS, channels: int = 1):
        self.bpm, self.sr, self.bars = bpm, sr, bars
        self.step = 60.0 / bpm / 4 * sr  # samples per 16th, float
        # One extra bar of tail, like a real export that runs past the last bar.
        self.n = int(round((bars + TAIL_BARS) * STEPS_PER_BAR * self.step))
        self.buf = np.zeros((self.n, channels))

    def pos(self, bar: int, step: float) -> int:
        return int(round((bar * STEPS_PER_BAR + step) * self.step))

    def place(self, sound: np.ndarray, sample_pos: int, gain: float = 1.0) -> None:
        if sound.ndim == 1:
            sound = sound[:, None]
        m = min(len(sound), self.n - sample_pos)
        if m > 0:
            self.buf[sample_pos:sample_pos + m] += gain * sound[:m]

    def pattern(self, sound_fn: Callable, rng, steps: dict[float, float], bars,
                stereo_width: float = 0.0, fresh: bool = False) -> None:
        """Place `sound_fn` at {step: velocity} in each bar of `bars`.

        One rendered sound is reused for every hit (fresh=False) so repeated
        bars are identical, as they would be in a sample-based production.
        """
        def render():
            if self.buf.shape[1] == 2 and stereo_width:
                left, right = sound_fn(self.sr, rng), sound_fn(self.sr, rng)
                mid = 0.5 * (left + right)
                return np.stack([mid + stereo_width * (left - mid),
                                 mid + stereo_width * (right - mid)], 1)
            s = sound_fn(self.sr, rng)
            return np.repeat(s[:, None], self.buf.shape[1], 1)
        cached = render()
        for bar in bars:
            for step, vel in steps.items():
                self.place(render() if fresh else cached, self.pos(bar, step), vel)

    def silence(self, bar_range: tuple[int, int]) -> None:
        a, b = self.pos(bar_range[0], 0), self.pos(bar_range[1], 0)
        self.buf[a:b] = 0.0


def groove_bars(start: int = 0) -> list[int]:
    return [b for b in range(start, BARS) if not (BREAKDOWN[0] <= b < BREAKDOWN[1])]


FOUR_ON_FLOOR = {0: 1.0, 4: 1.0, 8: 1.0, 12: 1.0}
TWO_AND_FOUR = {4: 1.0, 12: 1.0}
OFFBEATS = {2: 1.0, 6: 1.0, 10: 1.0, 14: 1.0}
SIXTEENTHS = {s: (1.0 if s % 4 == 2 else 0.55) for s in range(16)}

# Chord progressions, one chord per bar, as MIDI note lists (root first).
PROGRESSIONS = {
    # i - VI - iv - V (harmonic minor V) in A minor: Am F Dm E
    "Am": [[57, 60, 64], [53, 57, 60], [50, 53, 57], [52, 56, 59]],
    # I - IV - I - V in D major: D G D A
    "D": [[50, 54, 57], [55, 59, 62], [50, 54, 57], [57, 61, 64]],
}
PROGRESSIONS["Fm"] = [[n + 8 for n in chord] for chord in PROGRESSIONS["Am"]]


def bassline(track: Track, key: str) -> None:
    prog = PROGRESSIONS[key]
    for bar in range(track.bars):
        root = prog[bar % 4][0]
        while root >= 45:
            root -= 12
        note = tone(track.sr, midi_hz(root), 0.22, 6, 0.004, 0.03)
        for step in (2, 6, 10, 14):  # house offbeat bass
            track.place(note, track.pos(bar, step), 0.7)
        track.place(note, track.pos(bar, 0), 0.5)


def chords(track: Track, key: str, seconds_scale: float = 1.0, detune: float = 0.0) -> None:
    prog = PROGRESSIONS[key]
    bar_s = 60.0 / track.bpm * 4
    for bar in range(track.bars):
        for i, m in enumerate(prog[bar % 4]):
            for ch in range(track.buf.shape[1]):
                f = midi_hz(m + 12) * (1 + (detune if ch else -detune))
                x = tone(track.sr, f, bar_s * seconds_scale, 4, 0.02, 0.05, rolloff=2.0)
                pos = track.pos(bar, 0)
                m_len = min(len(x), track.n - pos)
                track.buf[pos:pos + m_len, ch] += 0.25 * x[:m_len]


def melody(track: Track, key: str) -> None:
    """Sustained string-like line on chord tones (quarter notes, soft attack)."""
    prog = PROGRESSIONS[key]
    q = 60.0 / track.bpm
    for bar in range(track.bars):
        notes = prog[bar % 4]
        for beat, idx in enumerate((0, 1, 2, 1)):
            x = tone(track.sr, midi_hz(notes[idx] + 12), q * 0.98, 5, 0.03, 0.04, rolloff=1.5)
            track.place(x, track.pos(bar, beat * 4), 0.3)


def vocal_chop(track: Track, rng) -> None:
    for bar in range(0, track.bars, 2):
        t = _t(track.sr, 0.4)
        f = 520 * (1 + 0.03 * np.sin(2 * np.pi * 5.5 * t))
        x = np.sin(2 * np.pi * np.cumsum(f) / track.sr) * np.sin(np.pi * t / 0.4)
        track.place(x, track.pos(bar, 6), 0.4)


def riser(track: Track, rng) -> None:
    start, end = track.pos(BREAKDOWN[1] - 4, 0), track.pos(BREAKDOWN[1], 0)
    n = end - start
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    hop = 4096
    for i in range(0, n, hop):
        fc = 300 + 9000 * (i / n) ** 2
        seg = noise[i:i + hop]
        if len(seg) > 64:
            out[i:i + hop] = _filt(seg, track.sr, "bandpass", [fc, min(fc * 1.5, track.sr / 2 - 100)])
    out *= np.linspace(0.05, 0.5, n)
    track.place(out, start)


# --------------------------------------------------------------------------
# Fixture definitions
# --------------------------------------------------------------------------

@dataclass
class StemTruth:
    path: str                      # path inside the zip ("Extras.zip/Ride.wav" for nested)
    category: str                  # expected classification
    auto: bool = False             # expected to need the audio fallback
    alt_categories: list[str] = field(default_factory=list)  # also acceptable


@dataclass
class FixtureTruth:
    name: str
    zip_name: str
    bpm: float
    key: str                       # label, e.g. "Am"
    camelot: str
    sample_rate: int
    bars: int
    breakdown: tuple[int, int]
    kick_start_bar: int
    stems: list[StemTruth]
    junk: list[str]                # entries that must be ignored
    skipped_warnings: list[str]    # file names that must produce a skip warning
    top_variations: int            # expected distinct top loops per length


def _write(buf: np.ndarray, sr: int, fmt: str, subtype: str, peak: float) -> bytes:
    mx = np.max(np.abs(buf))
    if mx > 0:
        buf = buf / mx * peak
    data = buf[:, 0] if buf.shape[1] == 1 else buf
    bio = io.BytesIO()
    sf.write(bio, data.astype(np.float32 if subtype == "FLOAT" else np.float64), sr,
             format=fmt, subtype=subtype)
    return bio.getvalue()


def _drum(bpm, sr, channels, start_bar=0):
    return Track(bpm, sr, channels=channels), groove_bars(start_bar)


def build_deep_groove(out: Path) -> FixtureTruth:
    """124 BPM (no stretch), A minor, 44.1 kHz float WAV, nested folder, __MACOSX junk."""
    bpm, sr, key, seed = 124.0, 44100, "Am", 1
    rng = np.random.default_rng(seed)
    files: dict[str, bytes] = {}
    root = "Deep Groove Stems/"
    W = lambda tr, peak: _write(tr.buf, sr, "WAV", "FLOAT", peak)

    k, bars = _drum(bpm, sr, 1)
    k.pattern(kick, rng, FOUR_ON_FLOOR, bars)
    files[root + "01 Kick.wav"] = W(k, 0.9)

    h, _ = _drum(bpm, sr, 2)
    h.pattern(hat_closed, rng, SIXTEENTHS, bars, stereo_width=0.6)
    files[root + "02_HiHats.wav"] = W(h, 0.5)

    c, _ = _drum(bpm, sr, 1)
    c.pattern(clap, rng, TWO_AND_FOUR, bars)
    files[root + "03-CLAP.wav"] = W(c, 0.7)

    top = Track(bpm, sr, channels=2)
    sec_a = [b for b in bars if b < BREAKDOWN[0]]
    sec_b = [b for b in bars if b >= BREAKDOWN[1]]
    top.pattern(hat_closed, rng, {s: 0.5 for s in range(0, 16, 2)}, sec_a, stereo_width=0.5)
    top.pattern(conga, rng, {3: 0.8, 6: 0.6, 11: 0.8, 14: 0.6}, sec_a)
    # Pattern B: rides + rimshots on different steps, no hats.
    top.pattern(ride, rng, {0: 0.6, 4: 0.6, 8: 0.6, 12: 0.6}, sec_b, stereo_width=0.5)
    top.pattern(rim, rng, {1: 0.8, 7: 0.8, 9: 0.6, 15: 0.8}, sec_b)
    files[root + "04 Top Loop.wav"] = W(top, 0.6)

    b = Track(bpm, sr, channels=1)
    bassline(b, key)
    files[root + "05 Bassline.wav"] = W(b, 0.8)

    ch = Track(bpm, sr, channels=2)
    chords(ch, key, detune=0.002)
    files[root + "06 Chords.wav"] = W(ch, 0.6)

    # Meaningless name, percussive content -> audio fallback must say drums/perc.
    p = Track(bpm, sr, channels=1)
    p.pattern(conga, rng, {0: 0.9, 3: 0.7, 6: 0.8, 10: 0.7, 13: 0.6}, bars)
    p.pattern(rim, rng, {4: 0.5, 12: 0.5}, bars)
    files[root + "Audio 07.wav"] = W(p, 0.6)

    v = Track(bpm, sr, channels=1)
    vocal_chop(v, rng)
    files[root + "07 Vocal Chop.wav"] = W(v, 0.5)

    junk = {
        "__MACOSX/Deep Groove Stems/._01 Kick.wav": b"\x00\x05\x16\x07" + b"\x00" * 200,
        root + ".DS_Store": b"\x00\x00\x00\x01Bud1" + b"\x00" * 100,
        root + "readme.txt": b"Stems exported from bar 1.",
    }
    _zip(out / "Deep Groove (Original Mix) Stems.zip", {**files, **junk})
    return FixtureTruth(
        name="deep_groove", zip_name="Deep Groove (Original Mix) Stems.zip", bpm=bpm, key=key,
        camelot="8A", sample_rate=sr, bars=BARS, breakdown=BREAKDOWN, kick_start_bar=0,
        stems=[
            StemTruth(root + "01 Kick.wav", "kick"),
            StemTruth(root + "02_HiHats.wav", "hat"),
            StemTruth(root + "03-CLAP.wav", "clap"),
            StemTruth(root + "04 Top Loop.wav", "top"),
            StemTruth(root + "05 Bassline.wav", "melodic"),
            StemTruth(root + "06 Chords.wav", "melodic"),
            StemTruth(root + "Audio 07.wav", "drums", auto=True, alt_categories=["perc"]),
            StemTruth(root + "07 Vocal Chop.wav", "ignore"),
        ],
        junk=list(junk), skipped_warnings=[], top_variations=2,
    )


def build_night_drive(out: Path) -> FixtureTruth:
    """122 BPM (stretch up), F minor, 44.1 kHz AIFF/FLAC, nested zip, an mp3 to skip."""
    bpm, sr, key, seed = 122.0, 44100, "Fm", 2
    rng = np.random.default_rng(seed)
    files: dict[str, bytes] = {}
    pre = "Night Drive - "
    AIF = lambda tr, peak: _write(tr.buf, sr, "AIFF", "PCM_24", peak)
    FLAC = lambda tr, peak: _write(tr.buf, sr, "FLAC", "PCM_24", peak)

    k, bars = _drum(bpm, sr, 1)
    k.pattern(kick, rng, FOUR_ON_FLOOR, bars)
    files[pre + "BD.aif"] = AIF(k, 0.9)

    ch, _ = _drum(bpm, sr, 1)
    ch.pattern(hat_closed, rng, {s: 0.7 for s in (0, 4, 8, 12)}, bars)
    files[pre + "CH.flac"] = FLAC(ch, 0.5)

    oh, _ = _drum(bpm, sr, 2)
    oh.pattern(hat_open, rng, OFFBEATS, bars, stereo_width=0.4)
    files[pre + "OH.flac"] = FLAC(oh, 0.5)

    sn, _ = _drum(bpm, sr, 1)
    sn.pattern(snare, rng, TWO_AND_FOUR, bars)
    files[pre + "Snare.aif"] = AIF(sn, 0.7)

    sh, _ = _drum(bpm, sr, 1)
    sh.pattern(shaker, rng, {s: (0.8 if s % 2 else 0.5) for s in range(16)}, bars)
    files[pre + "Shaker.flac"] = FLAC(sh, 0.4)

    # Full drum loop (kick + hats + snare) -> `drums`, looped. Used to check
    # that kick onsets land on bar starts after stretching.
    dl, _ = _drum(bpm, sr, 2)
    dl.pattern(kick, rng, FOUR_ON_FLOOR, bars)
    dl.pattern(snare, rng, TWO_AND_FOUR, bars)
    dl.pattern(hat_open, rng, {s: 0.4 for s in OFFBEATS}, bars, stereo_width=0.3)
    files[pre + "Drum Loop.aif"] = AIF(dl, 0.9)

    b = Track(bpm, sr, channels=1)
    bassline(b, key)
    files[pre + "Sub Bass.aif"] = AIF(b, 0.8)

    pad = Track(bpm, sr, channels=2)
    chords(pad, key, detune=0.004)
    files[pre + "Pad.flac"] = FLAC(pad, 0.6)

    fx = Track(bpm, sr, channels=1)
    riser(fx, rng)
    files[pre + "FX Riser.aif"] = AIF(fx, 0.5)

    files[pre + "Lead.mp3"] = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\xff\xfb" * 300

    # Nested zip (one level deep) with a perc and a ride stem.
    perc, _ = _drum(bpm, sr, 1)
    perc.pattern(conga, rng, {3: 0.8, 6: 0.6, 10: 0.9, 11: 0.5, 14: 0.7}, bars)
    rd, _ = _drum(bpm, sr, 2)
    rd.pattern(ride, rng, FOUR_ON_FLOOR, bars, stereo_width=0.3)
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("Perc Conga.wav", _write(perc.buf, sr, "WAV", "PCM_24", 0.6))
        z.writestr("Ride.wav", _write(rd.buf, sr, "WAV", "PCM_24", 0.5))
        z.writestr("__MACOSX/._Ride.wav", b"\x00\x05\x16\x07")
    files["Extras.zip"] = inner.getvalue()

    junk = {"__MACOSX/._" + pre + "BD.aif": b"\x00\x05\x16\x07" + b"\x00" * 64}
    _zip(out / "Night Drive 122 BPM.zip", {**files, **junk})
    return FixtureTruth(
        name="night_drive", zip_name="Night Drive 122 BPM.zip", bpm=bpm, key=key, camelot="4A",
        sample_rate=sr, bars=BARS, breakdown=BREAKDOWN, kick_start_bar=0,
        stems=[
            StemTruth(pre + "BD.aif", "kick"),
            StemTruth(pre + "CH.flac", "hat_closed"),
            StemTruth(pre + "OH.flac", "hat_open"),
            StemTruth(pre + "Snare.aif", "snare"),
            StemTruth(pre + "Shaker.flac", "shaker"),
            StemTruth(pre + "Drum Loop.aif", "drums"),
            StemTruth(pre + "Sub Bass.aif", "melodic"),
            StemTruth(pre + "Pad.flac", "melodic"),
            StemTruth(pre + "FX Riser.aif", "ignore"),
            StemTruth("Extras.zip/Perc Conga.wav", "perc"),
            StemTruth("Extras.zip/Ride.wav", "ride"),
        ],
        junk=list(junk) + ["Extras.zip/__MACOSX/._Ride.wav"],
        skipped_warnings=[pre + "Lead.mp3"], top_variations=0,
    )


def build_sunrise(out: Path) -> FixtureTruth:
    """126.5 BPM (stretch down, non-integer), D major, 48 kHz 24-bit WAV.

    The kick only enters at bar 3 (grid phase must still be 0).
    """
    bpm, sr, key, seed = 126.5, 48000, "D", 3
    rng = np.random.default_rng(seed)
    files: dict[str, bytes] = {}
    W = lambda tr, peak: _write(tr.buf, sr, "WAV", "PCM_24", peak)

    k, bars = _drum(bpm, sr, 1)
    k.pattern(kick, rng, FOUR_ON_FLOOR, groove_bars(2))
    files["KICK.wav"] = W(k, 0.9)

    h, _ = _drum(bpm, sr, 2)
    h.pattern(hat_closed, rng, {0: 0.6, 4: 0.6, 8: 0.6, 12: 0.6}, bars, stereo_width=0.5)
    h.pattern(hat_open, rng, OFFBEATS, bars, stereo_width=0.5)
    files["Hat.wav"] = W(h, 0.5)

    sn, _ = _drum(bpm, sr, 1)
    sn.pattern(snare, rng, TWO_AND_FOUR, bars)
    files["Snare.wav"] = W(sn, 0.7)

    cy, _ = _drum(bpm, sr, 2)
    cy.pattern(crash, rng, {0: 1.0}, [0, 16], stereo_width=0.6)
    files["Cymbal Crash.wav"] = W(cy, 0.6)

    pc, _ = _drum(bpm, sr, 1)
    pc.pattern(rim, rng, {3: 0.8, 7: 0.6, 13: 0.8}, bars)
    files["Perc.wav"] = W(pc, 0.5)

    gr, _ = _drum(bpm, sr, 2)
    gr.pattern(shaker, rng, {s: 0.6 for s in range(1, 16, 2)}, bars)
    gr.pattern(conga, rng, {2: 0.8, 10: 0.8, 13: 0.6}, bars)
    files["Groove.wav"] = W(gr, 0.6)

    tp, _ = _drum(bpm, sr, 2)
    tp.pattern(hat_closed, rng, SIXTEENTHS, bars, stereo_width=0.7)
    tp.pattern(shaker, rng, {4: 0.6, 12: 0.6}, bars)
    files["Tops.wav"] = W(tp, 0.6)

    b = Track(bpm, sr, channels=1)
    bassline(b, key)
    files["Bass.wav"] = W(b, 0.8)

    kb = Track(bpm, sr, channels=2)
    chords(kb, key, detune=0.001)
    files["Keys.wav"] = W(kb, 0.6)

    # Meaningless name, harmonic content -> audio fallback must say melodic.
    m = Track(bpm, sr, channels=1)
    melody(m, key)
    files["Track 12.wav"] = W(m, 0.6)

    junk = {"._Hat.wav": b"\x00\x05\x16\x07" + b"\x00" * 64, "Info.txt": b"126.5"}
    _zip(out / "Sunrise Theory.zip", {**files, **junk})
    return FixtureTruth(
        name="sunrise", zip_name="Sunrise Theory.zip", bpm=bpm, key=key, camelot="10B",
        sample_rate=sr, bars=BARS, breakdown=BREAKDOWN, kick_start_bar=2,
        stems=[
            StemTruth("KICK.wav", "kick"),
            StemTruth("Hat.wav", "hat"),
            StemTruth("Snare.wav", "snare"),
            StemTruth("Cymbal Crash.wav", "cymbal"),
            StemTruth("Perc.wav", "perc"),
            StemTruth("Groove.wav", "groove"),
            StemTruth("Tops.wav", "top"),
            StemTruth("Bass.wav", "melodic"),
            StemTruth("Keys.wav", "melodic"),
            StemTruth("Track 12.wav", "melodic", auto=True),
        ],
        junk=list(junk), skipped_warnings=[], top_variations=1,
    )


def _zip(path: Path, files: dict[str, bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
        for name, data in files.items():
            z.writestr(name, data)


BUILDERS = {
    "deep_groove": build_deep_groove,
    "night_drive": build_night_drive,
    "sunrise": build_sunrise,
}


def build_all(out_dir: Path | str, only: list[str] | None = None) -> dict[str, FixtureTruth]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    truths = {name: fn(out) for name, fn in BUILDERS.items() if not only or name in only}
    (out / "truth.json").write_text(json.dumps({k: asdict(v) for k, v in truths.items()}, indent=2))
    return truths


if __name__ == "__main__":
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "fixtures")
    for name, truth in build_all(target).items():
        print(f"{truth.zip_name}: {truth.bpm} BPM, {truth.key}, {truth.sample_rate} Hz")
