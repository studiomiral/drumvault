# Drumvault app (Phase 2)

Electron + React shell around the Python engine: **Process** (drop zips, queue, review and
reprocess with overrides) and **Library** (browse, filter, audition, favourite/rate). Arrange
(the mini DAW) is Phase 3.

## Run it (Mac)

```
brew install node uv rubberband        # once
cd engine && uv sync && cd ..          # once: Python environment for the engine
cd app && npm install                  # once (downloads Electron)
npm run dev                            # start the app with hot reload
```

On first launch the app asks for the library folder. The engine starts in the background
(`uv run python -m drumvault_engine` in `../engine`); the dot at the bottom left turns
green when it's ready. If something is missing, the Process view says what and how to
install it.

| Key (Library) | Does |
|---|---|
| click / Space | play / stop the selected sample (loops repeat) |
| ↑ / ↓ | select the previous / next sample and play it |
| Esc | stop |
| F | toggle favourite |
| 1–5 | rate (press again to clear) |
| ⌘F | search |

Drag a row out of the list to drop the WAV into Finder or Logic.

## Develop

```
npm run typecheck
npm test          # unit + integration tests; builds a small real library with the engine first
npm run build     # production bundle in out/
```

Layout:

| Path | Role |
|---|---|
| `electron/main.ts` | window, menu, settings, IPC |
| `electron/sidecar.ts` | spawns the engine, JSON-lines RPC, health checks, restart with backoff |
| `electron/jobs.ts` | job queue state from engine events (survives view switches) |
| `electron/db.ts` | read-only library queries (`node:sqlite`, no native modules) |
| `electron/fs.ts`, `deps.ts` | settings file, zip discovery, PATH for Finder-launched apps, dependency checks |
| `electron/preload.ts` | typed `window.drumvault` bridge (`src/types/api.ts`) |
| `src/views/` | Process (+ zip detail panel), Library, Settings, Welcome |
| `src/audio/audition.ts` | Web Audio auditioning with a decoded-buffer cache |
| `src/types/engine.ts` | mirror of `engine/drumvault_engine/schemas.py` |

Settings live in `~/Library/Application Support/Drumvault/settings.json`, the engine log in
`…/Drumvault/logs/engine.log`.
