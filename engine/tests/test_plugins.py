"""Plugins load on the engine's main thread: Serum still renders bass after an export has
mastered through Ozone on another thread, and mastering still works after Serum loaded first
(JUCE takes the first thread that touches it as the only one that may load plugins)."""

import subprocess
import sys
import textwrap
import threading
from pathlib import Path

import pytest

from drumvault_engine.config import Settings
from drumvault_engine.plugins import on_plugin_thread, serve_plugins


def test_plugin_calls_run_on_the_main_thread_while_serving():
    main = threading.get_ident()

    def where() -> int:
        return threading.get_ident()

    def body() -> list[int]:
        seen: list[int] = []
        threads = [threading.Thread(target=lambda: seen.append(on_plugin_thread(where))) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        seen.append(on_plugin_thread(where))
        with pytest.raises(ValueError):
            on_plugin_thread(lambda: (_ for _ in ()).throw(ValueError("raised there, raised here")))
        # Handed over from the main thread itself, it runs at once rather than waiting on itself.
        seen.append(on_plugin_thread(lambda: on_plugin_thread(where)))
        return seen

    assert serve_plugins(body) == [main] * 6
    # Not serving: on the caller's thread, as in the tests and the CLI.
    out: list[int] = []
    t = threading.Thread(target=lambda: out.append(on_plugin_thread(where)))
    t.start()
    t.join()
    assert out[0] == t.ident


SCENARIO = textwrap.dedent("""
    import glob, sys, threading
    import numpy as np, soundfile as sf
    from drumvault_engine import master, serum
    from drumvault_engine.config import Settings
    from drumvault_engine.midi import Note
    from drumvault_engine.plugins import serve_plugins

    tmp, order = sys.argv[1], sys.argv[2]
    s = Settings(library_path=tmp)
    preset = sorted(glob.glob("/Library/Audio/Presets/Xfer Records/Serum 2 Presets/Presets/Factory/Pad/*.SerumPreset"))[0]
    sr = 44100
    t = np.arange(sr * 8) / sr
    mono = 0.2 * np.sin(2 * np.pi * 55 * t) * (1 + np.sign(np.sin(2 * np.pi * 2 * t))) / 2
    sf.write(f"{tmp}/mixdown.wav", np.stack([mono, mono], axis=1).astype(np.float32), sr, subtype="PCM_24")
    out = {}

    def bass():
        y = serum.host(s.serum_plugin, s.serum_plugin_name).render_loop(preset, [Note(0, 2, 45, 100)], 124.0, 1, sr)
        out["bass"] = float(abs(y).max())

    def mastered():
        out["master"] = master.master_mixdown(s, f"{tmp}/mixdown.wav", f"{tmp}/mastered.wav")["short_term_lufs"]

    def engine():
        # Each on its own thread, as the engine runs them (the job worker; a thread per direct call).
        for f in ((mastered, bass) if order == "master-first" else (bass, mastered)):
            th = threading.Thread(target=f)
            th.start()
            th.join()

    serve_plugins(engine)  # as rpc.main does
    print(out)
    assert out["bass"] > 0.01 and np.isfinite(out["master"]), out
""")


@pytest.mark.skipif(not (Path(Settings().serum_plugin).exists() and Path(Settings().ozone_maximizer_plugin).exists()
                         and Path(Settings().ozone_dynamics_plugin).exists()),
                    reason="Serum 2 and Ozone 11 are not both installed")
@pytest.mark.parametrize("order", ["master-first", "bass-first"])
def test_serum_and_ozone_load_from_any_thread_in_either_order(tmp_path: Path, order: str):
    # A fresh process: JUCE's message thread is chosen once per process.
    r = subprocess.run([sys.executable, "-c", SCENARIO, str(tmp_path), order], capture_output=True, text=True, timeout=600)
    assert r.returncode == 0, r.stderr[-3000:]
