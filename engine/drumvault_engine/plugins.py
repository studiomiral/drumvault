"""Where the engine's VST3s (Serum 2, Ozone 11) are loaded: the process's main thread.

JUCE, inside pedalboard, takes the first thread that touches it as its message thread, and only
there does pedalboard load a plugin or reload one (a call with `reset=True`). RPC requests run on
many threads (the job worker, a thread per direct call), so whichever plugin loaded first made its
thread JUCE's and every later load from another thread failed: after an export had mastered
through Ozone on the job worker, no Serum bass rendered until the engine restarted. Nor will just
any one thread do: with Ozone loaded on a background thread, Serum fails to load there too (on
macOS these plugins want the real main thread).

So the engine (rpc.main) reads stdin on a thread of its own and keeps the main thread for
plugins: `serve_plugins` runs there, and `on_plugin_thread` hands it loads and resetting renders.
Processing with `reset=False` may stay on the caller's thread. Without the engine serving (tests,
the CLI), calls run on the caller's thread.
"""

from __future__ import annotations

import queue
import threading
from concurrent.futures import Future
from typing import Callable, TypeVar

T = TypeVar("T")

_tasks: queue.Queue[tuple[Callable[[], object], Future] | None] = queue.Queue()
_serving: int | None = None  # the thread running serve_plugins, while it does


def on_plugin_thread(fn: Callable[..., T], *args, **kwargs) -> T:
    """Run `fn` on the main thread and return (or raise) what it does. On the main thread itself,
    or with nothing serving, it runs at once on the caller's thread."""
    serving = _serving
    if serving is None or threading.get_ident() == serving:
        return fn(*args, **kwargs)
    fut: Future = Future()
    _tasks.put((lambda: fn(*args, **kwargs), fut))
    return fut.result()


def load_plugin(path: str, **kwargs):
    """pedalboard.load_plugin, on the main thread."""
    def load():
        from pedalboard import load_plugin as _load
        return _load(path, **kwargs)
    return on_plugin_thread(load)


def serve_plugins(body: Callable[[], T]) -> T:
    """Run `body` on a new thread while this (the main) thread runs the plugin calls it and its
    threads hand over; return what `body` returns once it has, after the calls already handed over."""
    global _serving
    if threading.current_thread() is not threading.main_thread():
        raise RuntimeError("serve_plugins runs on the main thread")
    out: Future = Future()

    def run() -> None:
        try:
            out.set_result(body())
        except BaseException as e:  # noqa: BLE001 - raised again on the main thread
            out.set_exception(e)
        finally:
            _tasks.put(None)

    _serving = threading.get_ident()
    threading.Thread(target=run, name="drumvault-rpc", daemon=True).start()
    try:
        while (task := _tasks.get()) is not None:
            fn, fut = task
            if fut.set_running_or_notify_cancel():
                try:
                    fut.set_result(fn())
                except BaseException as e:  # noqa: BLE001 - the caller gets it
                    fut.set_exception(e)
    finally:
        _serving = None
        # Calls handed over as serving stopped run where they are, as without the engine.
        while True:
            try:
                task = _tasks.get_nowait()
            except queue.Empty:
                break
            if task is not None and task[1].set_running_or_notify_cancel():
                try:
                    task[1].set_result(task[0]())
                except BaseException as e:  # noqa: BLE001
                    task[1].set_exception(e)
    return out.result()
