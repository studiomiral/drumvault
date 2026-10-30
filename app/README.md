# Drumvault app

Electron + React shell around the Python engine: **Process** (drop zips, queue, review and
reprocess with overrides), **Library** (browse, filter, audition, favourite/rate) and
**Arrange** (the mini DAW) with stem export to Logic.

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
| S | find similar loops/one-shots (same category and length, most similar first) |

⌘/ or ? opens the overview of every keyboard shortcut.

Drag a row out of the list to drop the WAV into Finder or Logic.

## Build the .app (Mac)

```
cd app && npm install && npm run dist
open release/mac-arm64/Drumvault.app      # or drag it to /Applications
```

The `.app` contains the engine's source and `uv.lock`, not a frozen Python. It still needs
`brew install uv rubberband`. The first launch installs the engine's Python packages into
`~/Library/Application Support/Drumvault/engine-venv`, which takes about a minute; after
that the engine starts in a few seconds. The app is ad-hoc signed, not notarised: if macOS
blocks it, right-click → Open once. Settings → Engine folder overrides the bundled engine
(useful for running the repo's `engine/` in place).

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
| `src/audio/` | shared AudioContext + buffer cache, scheduler, transport engine, audition |
| `src/arrange/` | timeline canvas, lane headers, toolbar, step editor, library panel, project persistence, export dialog |
| `src/audio/render.ts`, `wav.ts` | offline stem rendering, WAV writer (24-bit / 32-bit float) |
| `src/lib/midi.ts` | markers MIDI file |
| `src/types/engine.ts` | mirror of `engine/drumvault_engine/schemas.py` |

Settings live in `~/Library/Application Support/Drumvault/settings.json`, the engine log in
`…/Drumvault/logs/engine.log`.

## Arrange (mini DAW)

Drag loops and one-shots from the library panel (right) onto lanes. Loops become audio
clips; one-shots become pattern clips with a preset that fits their category (kick: four
on the floor, clap/snare: 2 & 4, others: offbeat). Projects autosave to
`<Library>/.drumvault/projects/<name>.dvproj`; the Projects menu switches between them.

| Action | How |
|---|---|
| Play / stop | Space (or the play button) |
| Move the playhead | click the ruler; Home/Enter: back to bar 1 |
| Loop region | drag on the ruler; L toggles it |
| Select | click, ⇧-click to add, drag a marquee on empty space; ⌘A all |
| Move / copy | drag; ⌥ held when you click = copy |
| Snap | to bars; hold ⌥ while dragging to snap to beats |
| Extend / trim | drag a clip's right edge (repeats the loop or pattern); left edge of a loop trims whole beats |
| Duplicate | ⌘D places a copy right after the selection |
| Nudge | ← / → by a bar (⌥: a beat) |
| Delete | Backspace / Delete |
| Undo / redo | ⌘Z / ⇧⌘Z (200 steps) |
| Pattern | double-click a pattern clip: click steps to cycle full → medium → soft → off, ⇧-click clears |
| Sections | drag in the top band to add a marker; click it to select its clips (then ⌘D duplicates the section); double-click to rename/delete; drag its edges to resize |
| Zoom / scroll | ⌘ + scroll or pinch / scroll, or the zoom slider |
| Lanes | double-click a name to rename, click the colour bar to recolour, drag a lane to reorder, drag its bottom edge to resize, M / S mute and solo |

While the transport runs, auditioning a loop (in the panel or the Library view) starts it on
the next bar, in time with the arrangement.

Playback and stem export share one scheduler (`src/audio/schedule.ts`): event times are
computed from integer grid positions and snapped to whole sample frames, so there is no
drift over 192 bars.

## Export stems (⌘E)

File → Export Stems… or the Export button in Arrange. Pick a folder (default
`~/Music/Drumvault Exports`), a file prefix, the range (whole project or the loop region),
24-bit or 32-bit float, and which lanes. Muted lanes are skipped and solo is ignored.
**Master** adds a mix of every unmuted lane. **Markers (MIDI)** writes
`<Prefix>_markers.mid` with the tempo and your section markers.

Files are named `<Prefix>_<Lane>_<BPM>bpm.wav`, at the library's sample rate, and all have
the same length. In Logic: set the project tempo to the BPM, drag every file in at bar 1
(or at the loop region's first bar if you exported that), and drag the `.mid` file in too if
you want the markers.

If a 24-bit stem would clip, the export stops and asks you to choose: export as 32-bit
float (keeps the overs, no level change), auto-gain (turns every stem down by the same
amount so the loudest one peaks at about −0.3 dBFS, so the stems still sum to the master),
export anyway (clipped), or cancel. The dialog asks before overwriting existing files, and
offers Reveal in Finder when it's done.
