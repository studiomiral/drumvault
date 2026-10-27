# CLAUDE.md

This repo is **Drumvault**, a personal macOS desktop app. `SCOPE.md` is the source of truth for what to build — read it before starting any task, and follow its phases in order.

## Project in one line
Drag zips of dance-track stems in → get a tempo-matched, key-labeled drum sample library out → arrange drums on a mini timeline → export full-length drum stems for Logic Pro.

## Stack
- `app/` — Electron + React + Vite (electron-vite) + TypeScript + Tailwind + Zustand. Web Audio for playback/export. Dark glass theme with a subtle yellow accent (see SCOPE.md §6.1).
- `engine/` — Python 3.12 sidecar managed with **uv**: numpy, scipy, soundfile, librosa, essentia. Time-stretch via the `rubberband` CLI.
- SQLite library index in `<Library>/.drumvault/library.sqlite` (engine writes, app reads).
- App ↔ engine: JSON-lines RPC over stdin/stdout (see SCOPE.md §5.14). The engine must only print RPC messages to stdout; all logs go to stderr.

## Working rules
- Work phase by phase (SCOPE.md §7). Don't start UI work before Phase 1 passes its acceptance criteria.
- Every audio analysis threshold goes in `engine/drumvault_engine/config.py` — never hard-code thresholds inline.
- One-shots are never time-stretched. Loops are cut sample-exact on the grid, with no end fades.
- Write tests against the synthetic fixtures (`engine/tests/make_fixtures.py`) for every engine module; run `uv run pytest` before calling a task done.
- Never block the Electron main process; heavy work belongs in the sidecar.
- Share scheduling logic between live playback and offline export — don't duplicate it.
- Keep the Python schemas (`schemas.py`) and TS types (`app/src/types/`) in sync when changing either.
- Target: Apple Silicon (M1 Pro), macOS. No Windows/Linux, signing, or auto-update work. (Linux is only used as a cloud dev environment for the engine — see below.)

## Environment setup
Check which machine you're on first (`uname -s`), then install prerequisites before any engine work.

**macOS (Lars's Mac, local sessions):**
```
brew install rubberband uv node
```

**Linux (Claude Code cloud sessions — no Homebrew here):**
```
sudo apt-get update && sudo apt-get install -y rubberband-cli libsndfile1 ffmpeg
pip install uv          # or: pipx install uv
```
- The apt package is `rubberband-cli`; the binary is still `rubberband`. Verify with `rubberband --version`.
- Older distro packages may be Rubber Band 2.x, which has no R3 engine (`--fine`). Check `rubberband --help`; if `--fine` is missing, use the default engine in cloud tests. Keep the option configurable in `config.py` — don't remove R3 support, the Mac uses it.
- If `essentia` fails to install, use the numpy key-detection fallback (SCOPE.md §5.5) and keep going.
- Cloud sessions are for Phase 1 (engine + tests). Phases 2–4 (Electron UI, audio playback, testing with real zips) run in a local session on the Mac.

## Commands
- Engine setup: `cd engine && uv sync`
- Engine tests: `cd engine && uv run pytest`
- Engine CLI: `uv run python -m drumvault_engine cli process <zip> --library ./out --bpm 124`
- App dev (Mac only): `cd app && npm install && npm run dev`
- Node 22.13+ required for the app's build tools and tests (`node:sqlite`); Electron bundles its own Node at runtime.
- App tests: `cd app && npm test` (builds a small library with the engine first; needs uv).
