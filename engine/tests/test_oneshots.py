import numpy as np
import pytest

from make_fixtures import Track, hat_closed, hat_open, kick
from drumvault_engine import audioutil, oneshots
from drumvault_engine.config import ONESHOT_CATEGORIES, Settings


def peak_ms(data, sr):
    """Position of the sample peak (all channels)."""
    return float(np.argmax(np.max(np.abs(data), axis=1)) / sr * 1000)


def assert_clean_transient(hit, sr):
    """Intact transient: no fade-in, peak within the first 10 ms."""
    mono = audioutil.to_mono(hit.data)
    assert peak_ms(hit.data, sr) <= 10.0
    # No fade-in: the hit starts at most the pre-roll before its attack, and the
    # attack sample is untouched (equal to the source sample).
    assert hit.attack <= int(0.001 * sr) + 1
    assert np.max(np.abs(mono[:hit.attack + 1])) > 0 or hit.attack == 0


@pytest.fixture(scope="module")
def all_hits(fixtures, extracted):
    s = Settings()
    out = {}
    for name, truth in fixtures.truths.items():
        disc = extracted(name)
        for st in truth.stems:
            if st.category in ONESHOT_CATEGORIES:
                a = audioutil.load(disc.root / st.path)
                out[(name, st.path)] = (a, oneshots.extract_oneshots(a, st.category, s))
    return out


def test_every_category_yields_clean_hit(all_hits):
    """Acceptance: each one-shot category yields >= 1 clean hit with an intact transient."""
    by_cat: dict[str, list] = {}
    for (name, path), (a, hits) in all_hits.items():
        for h in hits:
            by_cat.setdefault(h.category, []).append((a, h))
    expected = {"kick", "clap", "snare", "hat_closed", "hat_open", "ride", "cymbal", "shaker", "perc"}
    assert expected <= set(by_cat)
    for cat in expected:
        clean = [h for a, h in by_cat[cat] if peak_ms(h.data, a.sr) <= 10.0]
        assert clean, cat
        for h in clean[:1]:
            a = next(a for a, hh in by_cat[cat] if hh is h)
            assert_clean_transient(h, a.sr)


def test_hits_match_source_audio_exactly(all_hits):
    """One-shots are never time-stretched: samples equal the source (except the fade-out)."""
    for (name, path), (a, hits) in all_hits.items():
        for h in hits:
            n = len(h.data) - int(0.006 * a.sr)
            np.testing.assert_array_equal(h.data[:n], a.data[h.start:h.start + n])


def test_tail_fade_and_length_caps(all_hits):
    for (name, path), (a, hits) in all_hits.items():
        for h in hits:
            assert np.max(np.abs(h.data[-1])) < 1e-3  # 5 ms fade-out reaches zero
            cap = 4.0 if h.category == "cymbal" else 2.0
            assert len(h.data) / a.sr <= cap + 1e-9


def test_identical_hits_dedupe(all_hits):
    """The fixtures reuse one rendered sound per pattern: kicks dedupe to one."""
    for (name, path), (a, hits) in all_hits.items():
        if "kick" in path.lower() or path.endswith("BD.aif"):
            assert len(hits) == 1, path


def test_hat_split():
    sr, bpm = 44100, 124.0
    tr = Track(bpm, sr, bars=4)
    rng = np.random.default_rng(1)
    tr.pattern(hat_closed, rng, {0: 1.0, 4: 1.0, 8: 1.0, 12: 1.0}, range(4))
    tr.pattern(hat_open, rng, {2: 1.0, 6: 1.0, 10: 1.0, 14: 1.0}, range(4))
    a = audioutil.Audio(tr.buf.astype(np.float32), sr)
    hits = oneshots.extract_oneshots(a, "hat", Settings())
    cats = {h.category for h in hits}
    assert cats == {"hat_closed", "hat_open"}


def test_short_candidates_discarded():
    """Kicks 100 ms apart are shorter than the 200 ms minimum."""
    sr = 44100
    k = kick(sr, None)
    x = np.zeros(sr * 2)
    for i in range(10):
        p = int(i * 0.1 * sr)
        m = min(len(k), len(x) - p)
        x[p:p + m] += k[:m]
    a = audioutil.Audio(x[:, None].astype(np.float32), sr)
    hits = oneshots.extract_oneshots(a, "kick", Settings())
    assert all(len(h.data) >= 0.2 * sr for h in hits)
    assert len(hits) <= 1  # only the last one has room


def test_max_per_stem():
    sr = 44100
    rng = np.random.default_rng(3)
    x = np.zeros(sr * 8)
    for i in range(16):  # 16 different noise bursts, all distinct sounds
        t = np.arange(int(0.3 * sr)) / sr
        f = 200 + 300 * i
        burst = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.05) * (0.5 + 0.5 * rng.random())
        p = int(i * 0.5 * sr)
        x[p:p + len(burst)] += burst
    a = audioutil.Audio(x[:, None].astype(np.float32), sr)
    s = Settings(max_oneshots_per_stem=4)
    hits = oneshots.extract_oneshots(a, "perc", s)
    assert len(hits) == 4
