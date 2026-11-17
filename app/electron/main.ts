// Electron main process: window, menu, settings, engine sidecar, IPC (SCOPE.md §6).
// All heavy work happens in the Python sidecar; the main process only routes messages
// and runs small, indexed SQLite reads.

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { AppSettings, EngineStatus, JobMethod, SampleMeta } from '../src/types/api'
import type { EngineEvent, GridPreview, JobAccepted, Overrides } from '../src/types/engine'
import { keptDir, LibraryReader } from './db'
import { checkDeps } from './deps'
import {
  augmentedPath, deleteProjectFile, expandSamplePaths, expandZipPaths, SAMPLE_EXTENSIONS, findEngineDir, libraryFile, listProjects, loadSettings, readShortlist, writeShortlist,
  readProjectFile, saveSettings, which, writeProjectFile,
} from './fs'
import * as eleven from './eleven'
import { compositionPlan, type VocalAnalysis, type VocalMeta, type VocalRequest } from '../src/vocals/plan'
import { JobTracker } from './jobs'
import { Sidecar } from './sidecar'

// Tests and parallel profiles can point the app at their own settings folder. Otherwise settings,
// logs and the engine's environment stay in ~/Library/Application Support/Drumvault, where they
// were before the app was called Warehouse.
if (process.env.DRUMVAULT_USER_DATA) app.setPath('userData', process.env.DRUMVAULT_USER_DATA)
else app.setPath('userData', join(app.getPath('appData'), 'Drumvault'))

const settingsFile = () => join(app.getPath('userData'), 'settings.json')
const logFile = () => join(app.getPath('userData'), 'logs', 'engine.log')

let win: BrowserWindow | null = null
let settings: AppSettings
let reader = new LibraryReader(null)
let sidecar: Sidecar | null = null

const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

// Job snapshots are pushed at most every 100 ms (progress events can be frequent).
let jobsTimer: NodeJS.Timeout | null = null
const jobs = new JobTracker(() => {
  if (jobsTimer) return
  jobsTimer = setTimeout(() => {
    jobsTimer = null
    send('jobs', jobs.list())
  }, 100)
})

function engineLog(line: string): void {
  try {
    mkdirSync(join(app.getPath('userData'), 'logs'), { recursive: true })
    appendFileSync(logFile(), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // logging must never take the app down
  }
  if (!app.isPackaged) console.log(`[engine] ${line}`)
}

/**
 * The engine's source: the user's override, the copy bundled in the packaged app, or the
 * repo's engine/ folder next to app/ (development).
 */
function engineDir(): string {
  if (settings.enginePath) return settings.enginePath
  if (app.isPackaged) return join(process.resourcesPath, 'engine')
  return findEngineDir(app.getAppPath()) || resolve(app.getAppPath(), '..', 'engine')
}

/**
 * uv arguments/environment. The packaged app keeps its Python environment in
 * ~/Library/Application Support/Drumvault/engine-venv (never inside the read-only app
 * bundle) and installs exactly the locked versions (--frozen).
 */
function engineCommand(dir: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const bundled = app.isPackaged && !settings.enginePath
  const args = ['run', ...(bundled ? ['--frozen'] : []), '--project', dir, 'python', '-m', 'drumvault_engine']
  const env: NodeJS.ProcessEnv = { PATH: augmentedPath() }
  if (bundled) env.UV_PROJECT_ENVIRONMENT = join(app.getPath('userData'), 'engine-venv')
  return { args, env }
}

function engineSettings(): Record<string, unknown> {
  return { ...settings.engine, library_path: settings.libraryPath }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function startEngine(): void {
  const uv = settings.uvPath || which('uv')
  const dir = engineDir()
  if (!uv || !existsSync(join(dir, 'pyproject.toml'))) {
    const status: EngineStatus = {
      state: 'missing', health: null, restarts: 0,
      message: !uv ? 'uv not found (brew install uv)' : `Engine folder not found: ${dir}`,
    }
    send('engine-status', status)
    sidecar = null
    lastStatus = status
    return
  }
  const { args, env } = engineCommand(dir)
  sidecar = new Sidecar({ command: uv, args, cwd: dir, env, log: engineLog })
  sidecar.on('status', (s: EngineStatus) => {
    lastStatus = s
    send('engine-status', s)
    if (s.state === 'ready') void analyzeLibraryIfNeeded()
  })
  sidecar.on('event', (e: EngineEvent) => {
    jobs.handleEvent(e)
    if (e.event === 'job_done' && ['done', 'needs_review', 'error'].includes(e.status)) {
      send('library-changed')
    }
  })
  sidecar.on('crashed', () => jobs.engineCrashed())
  sidecar.start()
}

let lastStatus: EngineStatus = { state: 'stopped', message: '', health: null, restarts: 0 }

async function restartEngine(): Promise<EngineStatus> {
  await sidecar?.stop()
  sidecar = null
  startEngine()
  return lastStatus
}

async function submit(method: JobMethod, params: Record<string, unknown>, label: string,
                      path: string | null = null, zipId: number | null = null): Promise<void> {
  if (!settings.libraryPath) throw new Error('Choose a library folder first')
  if (!sidecar) throw new Error(lastStatus.message || 'Engine is not running')
  const r = await sidecar.request<JobAccepted>(method, { ...params, settings: engineSettings() })
  jobs.add(r.job_id, method, label, path, zipId)
}

/**
 * Libraries from before schema v7 lack loop grooves and track arrangements (Generate needs
 * them): measure them once, in the background, when the engine is up.
 */
async function analyzeLibraryIfNeeded(): Promise<void> {
  try {
    if (!reader.needsAnalysis() || jobs.list().some((j) => j.method === 'analyze_library' && !j.finished)) return
    await submit('analyze_library', {}, 'Measure grooves and track structures, keep originals, move atmosphere to Ambience')
  } catch (e) {
    engineLog(`analyze_library not started: ${e}`)
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function applySettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const before = settings
  // `engine` is replaced as a whole: the settings form sends every value it shows.
  settings = { ...settings, ...patch }
  await saveSettings(settingsFile(), settings)
  if (before.libraryPath !== settings.libraryPath) {
    reader.close()
    reader = new LibraryReader(settings.libraryPath)
    send('library-changed')
  }
  if (before.enginePath !== settings.enginePath || before.uvPath !== settings.uvPath) {
    void restartEngine()
  }
  return settings
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function dragIcon(): Electron.NativeImage {
  // A small square in the accent purple (macOS needs a non-empty drag image).
  const size = 32
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y)
      const i = (y * size + x) * 4
      buf[i] = 0xed; buf[i + 1] = 0x3a; buf[i + 2] = 0x7c; buf[i + 3] = edge < 2 ? 0 : 0xe6 // BGRA
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function registerIpc(): void {
  const lib = () => {
    if (!settings.libraryPath) throw new Error('No library folder')
    return settings.libraryPath
  }

  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => applySettings(patch))
  ipcMain.handle('dialog:library', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose the Warehouse library folder',
      buttonLabel: 'Use as library',
      properties: ['openDirectory', 'createDirectory'],
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:zips', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Add stem zips or samples',
      buttonLabel: 'Add',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [{ name: 'Stem zips and samples', extensions: ['zip', ...SAMPLE_EXTENSIONS] }],
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('fs:expand', (_e, paths: string[]) => expandZipPaths(paths))
  ipcMain.handle('fs:samples', (_e, paths: string[]) => expandSamplePaths(paths))

  ipcMain.handle('engine:deps', () => checkDeps(engineDir(), settings.uvPath))
  ipcMain.handle('engine:status', () => lastStatus)
  ipcMain.handle('engine:restart', () => restartEngine())

  ipcMain.handle('jobs:list', () => jobs.list())
  ipcMain.handle('jobs:process', async (_e, paths: string[], reprocess = false) => {
    for (const p of paths) await submit('process_zip', { path: p, reprocess }, basename(p), p)
  })
  // Loose samples: the engine groups them into packs (a Splice pack or the dropped folder).
  ipcMain.handle('jobs:samples', async (_e, paths: string[]) => {
    const label = paths.length === 1 ? `Samples from ${basename(paths[0])}` : `Samples from ${paths.length} places`
    await submit('import_samples', { paths }, label, paths.length === 1 ? paths[0] : null)
  })
  ipcMain.handle('jobs:reprocess', async (_e, zipId: number, overrides: Overrides) => {
    const z = reader.zipDetail(zipId)?.zip
    await submit('reprocess_zip', { zip_id: zipId, overrides }, z?.file_name ?? `zip ${zipId}`,
      z?.original_path ?? null, zipId)
  })
  ipcMain.handle('jobs:delete', async (_e, zipId: number) => {
    const z = reader.zipDetail(zipId)?.zip
    await submit('delete_zip', { zip_id: zipId, delete_files: true },
      `Delete ${z?.source_code ?? zipId} ${z?.file_name ?? ''}`.trim(), null, zipId)
  })
  ipcMain.handle('jobs:rebuild', () => submit('rebuild_loops', {}, 'Rebuild loops'))
  ipcMain.handle('jobs:cancel', async (_e, jobId: string) => {
    await sidecar?.request('cancel', { job_id: jobId })
  })
  ipcMain.handle('jobs:clear', () => jobs.clearFinished())
  ipcMain.handle('sample:meta', async (_e, sampleId: number, meta: SampleMeta) => {
    if (!sidecar) throw new Error('Engine is not running')
    await sidecar.request('set_sample_meta', { sample_id: sampleId, ...meta, settings: engineSettings() })
    send('library-changed')
  })

  ipcMain.handle('zip:reviewed', async (_e, zipId: number) => {
    if (!sidecar) throw new Error('Engine is not running')
    await sidecar.request('mark_reviewed', { zip_id: zipId, settings: engineSettings() })
    send('library-changed')
  })

  ipcMain.handle('samples:delete', async (_e, sampleIds: number[]) => {
    if (!sidecar) throw new Error('Engine is not running')
    const r = await sidecar.request<{ deleted: number }>('delete_samples', { sample_ids: sampleIds, settings: engineSettings() }, 60_000)
    send('library-changed')
    return r.deleted
  })
  ipcMain.handle('samples:restore', async (_e, removedIds: number[]) => {
    if (!sidecar) throw new Error('Engine is not running')
    const r = await sidecar.request<{ restored: number; pending: number }>(
      'restore_samples', { removed_ids: removedIds, settings: engineSettings() }, 60_000)
    send('library-changed')
    return r
  })
  ipcMain.handle('samples:shift', async (_e, sampleId: number, beats: number) => {
    if (!sidecar) throw new Error('Engine is not running')
    const r = await sidecar.request<{ shift_beats: number }>(
      'shift_sample', { sample_id: sampleId, beats, settings: engineSettings() }, 60_000)
    reader.forgetPeaks(sampleId)
    send('library-changed')
    return r.shift_beats
  })
  ipcMain.handle('lib:shift', (_e, sampleId: number) => reader.sampleShift(sampleId))
  ipcMain.handle('samples:stretch', async (_e, relPaths: string[], bpm: number) => {
    if (!sidecar) throw new Error('Engine is not running')
    await sidecar.request('stretch_samples', { rel_paths: relPaths, bpm, settings: engineSettings() }, 600_000)
  })
  ipcMain.handle('midi:import', async (_e, paths: string[]) => {
    if (!sidecar) throw new Error('Engine is not running')
    // The engine searches folders and opens MIDI zips itself.
    const r = await sidecar.request('import_midi', { paths, settings: engineSettings() }, 600_000)
    send('library-changed')
    return r
  })
  ipcMain.handle('dialog:midi', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Add MIDI to learn from', buttonLabel: 'Add', properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [{ name: 'MIDI zips and files', extensions: ['zip', 'mid', 'midi'] }],
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('midi:key', async (_e, midiId: number, key: string | null) => {
    if (!sidecar) throw new Error('Engine is not running')
    await sidecar.request('set_midi_meta', { midi_id: midiId, key_label: key, clear_key: key == null, settings: engineSettings() })
    send('library-changed')
  })
  ipcMain.handle('midi:delete', async (_e, midiIds: number[]) => {
    if (!sidecar) throw new Error('Engine is not running')
    await sidecar.request('delete_midi', { midi_ids: midiIds, settings: engineSettings() })
    send('library-changed')
  })
  ipcMain.handle('lib:midi', () => reader.listMidi())
  ipcMain.handle('hits:import', async (_e, paths: string[], kind: 'disco' | 'stab' | 'strings' | 'bass' | 'ambience' = 'disco') => {
    if (!sidecar) throw new Error('Engine is not running')
    const r = await sidecar.request('import_hits', { paths, kind, settings: engineSettings() }, 600_000)
    send('library-changed')
    return r
  })
  // The Splice page (SCOPE.md §6.12): the engine looks through the folder (names and headers only).
  const spliceFolder = () => settings.spliceFolder || join(homedir(), 'Splice')
  ipcMain.handle('splice:scan', async () => {
    if (!sidecar) throw new Error('Engine is not running')
    return sidecar.request('scan_splice', { folder: spliceFolder(), settings: engineSettings() }, 300_000)
  })
  ipcMain.handle('dialog:splice', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Choose your Splice folder', buttonLabel: 'Choose', defaultPath: spliceFolder(), properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    await applySettings({ spliceFolder: r.filePaths[0] })
    return r.filePaths[0]
  })
  ipcMain.handle('splice:read', async (_e, path: string) => {
    // Only files inside the Splice folder are read.
    const rel = relative(resolve(spliceFolder()), resolve(path))
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path outside the Splice folder: ${path}`)
    const buf = await readFile(resolve(path))
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })
  ipcMain.handle('dialog:hits', async (_e, title = 'Add disco hits') => {
    const r = await dialog.showOpenDialog(win!, {
      title, buttonLabel: 'Add', properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [{ name: 'Audio files and zips', extensions: ['wav', 'aif', 'aiff', 'flac', 'zip'] }],
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('hits:key', async (_e, hitId: number, key: string | null) => {
    if (!sidecar) throw new Error('Engine is not running')
    await sidecar.request('set_hit_meta', { hit_id: hitId, key_label: key, clear_key: key == null, settings: engineSettings() })
    send('library-changed')
  })
  ipcMain.handle('hits:pitch', async (_e, hitId: number, pitchFix: number) => {
    if (!sidecar) throw new Error('Engine is not running')
    await sidecar.request('set_hit_meta', { hit_id: hitId, pitch_fix: pitchFix, settings: engineSettings() })
  })
  ipcMain.handle('hits:delete', async (_e, hitIds: number[]) => {
    if (!sidecar) throw new Error('Engine is not running')
    await sidecar.request('delete_hits', { hit_ids: hitIds, settings: engineSettings() })
    send('library-changed')
  })
  ipcMain.handle('lib:hits', () => reader.listHits())
  ipcMain.handle('lib:arrangements', () => reader.arrangements())
  ipcMain.handle('serum:presets', async (_e, root: string, folders: string[] | null) => {
    if (!sidecar) throw new Error('Engine is not running')
    return sidecar.request('serum_presets', { root, folders, settings: engineSettings() }, 120_000)
  })
  ipcMain.handle('bass:render', async (_e, p: { preset: string; midiId: number; transpose: number; bpm: number; outRel: string;
    notes?: number[][]; bars?: number; groove?: number[] }) => {
    if (!sidecar) throw new Error('Engine is not running')
    // The first render loads Serum 2 into the engine (several seconds).
    await sidecar.request('render_bass', {
      preset: p.preset, midi_id: p.midiId, transpose: p.transpose, bpm: p.bpm, out_rel: p.outRel,
      notes: p.notes ?? null, bars: p.bars ?? null, groove: p.groove ?? null, settings: engineSettings(),
    }, 300_000)
  })
  ipcMain.handle('midi:save', async (_e, p: { name: string; notes: number[][]; bars: number; keyLabel: string | null }) => {
    if (!sidecar) throw new Error('Engine is not running')
    const r = await sidecar.request<{ id: number }>('save_midi', {
      name: p.name, notes: p.notes, bars: p.bars, key_label: p.keyLabel, settings: engineSettings(),
    }, 60_000)
    send('library-changed')
    return r.id
  })
  ipcMain.handle('lib:removed', () => reader.removedSamples())
  ipcMain.handle('zip:gridPreview', async (_e, zipId: number) => {
    if (!sidecar) throw new Error('Engine is not running')
    const info = await sidecar.request<GridPreview>('grid_preview', { zip_id: zipId, settings: engineSettings() }, 180_000)
    const buf = await readFile(info.path)
    await rm(info.path, { force: true })
    return { info, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
  })

  ipcMain.handle('lib:zips', () => reader.listZips())
  ipcMain.handle('lib:zip', (_e, id: number) => reader.zipDetail(id))
  ipcMain.handle('lib:samples', (_e, filter) => reader.querySamples(filter))
  ipcMain.handle('lib:facets', () => reader.facets())
  ipcMain.handle('lib:peaks', (_e, id: number, points: number) => reader.peaks(id, points))
  ipcMain.handle('lib:byPath', (_e, relPaths: string[]) => reader.samplesByPath(relPaths))
  ipcMain.handle('shortlist:read', () => readShortlist(lib()))
  ipcMain.handle('shortlist:write', (_e, text: string) => writeShortlist(lib(), text))
  ipcMain.handle('projects:list', () => listProjects(lib()))
  ipcMain.handle('projects:read', (_e, file: string) => readProjectFile(lib(), file))
  ipcMain.handle('projects:write', (_e, prev: string | null, name: string, text: string) =>
    writeProjectFile(lib(), prev, name, text))
  ipcMain.handle('projects:delete', (_e, file: string) => deleteProjectFile(lib(), file))
  ipcMain.handle('lib:similar', (_e, id: number, limit: number) => reader.similar(id, limit))

  // ---- stem export --------------------------------------------------------
  const exportFile = (dir: string, name: string) => {
    if (!isAbsolute(dir) || name !== basename(name) || !/\.(wav|mid)$/i.test(name)) throw new Error(`Bad export path: ${name}`)
    return join(dir, name)
  }
  ipcMain.handle('export:defaultDir', () => join(app.getPath('music'), 'Drumvault Exports'))
  ipcMain.handle('export:chooseDir', async (_e, defaultPath: string | null) => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Export stems to', buttonLabel: 'Choose', defaultPath: defaultPath ?? undefined,
      properties: ['openDirectory', 'createDirectory'],
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('export:existing', (_e, dir: string, names: string[]) =>
    names.filter((n) => existsSync(exportFile(dir, n))))
  ipcMain.handle('export:write', async (_e, dir: string, name: string, data: ArrayBuffer) => {
    const path = exportFile(dir, name)
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.${name}.part`)
    await writeFile(tmp, Buffer.from(data))
    await rename(tmp, path)
  })
  // The mixdown through Ozone 11 into a master next to it (the engine's master.py; a few passes over the track).
  // Renders nothing uses any more: counted (dryRun) or deleted by the engine (pipeline.clean_renders).
  // ElevenLabs (vocals): the key in the keychain, the plan and its credits.
  ipcMain.handle('eleven:status', () => eleven.status())
  ipcMain.handle('eleven:setKey', (_e, k: string) => eleven.setKey(k))
  ipcMain.handle('eleven:clearKey', () => eleven.clearKey())
  // A vocal take (SCOPE.md §6.11): composed by ElevenLabs, its vocal split from it, into
  // <Library>/Vocals/<id>/ (take.mp3, stems.zip → stems/, vocal.wav, meta.json).
  ipcMain.handle('vocals:make', async (_e, req: VocalRequest): Promise<VocalMeta> => {
    if (!sidecar) throw new Error('Engine is not running')
    const id = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    const rel = `Vocals/${id}`
    const dir = join(lib(), rel)
    await mkdir(dir, { recursive: true })
    const before = (await eleven.status()).credits?.used ?? null
    // Starter plans get 128 kbps MP3 (192 from Creator, WAV from Pro).
    const format = 'mp3_44100_128'
    const plan = compositionPlan(req)
    let take: eleven.Take
    try {
      take = await eleven.compose(plan, format)
    } catch (e) {
      await rm(dir, { recursive: true, force: true })  // nothing was made (nor paid for)
      throw e
    }
    await writeFile(join(dir, 'take.mp3'), take.audio)
    const meta: VocalMeta = {
      ...req, id, createdAt: new Date().toISOString(), source: 'elevenlabs', model: 'music_v1', format, headers: take.headers,
      credits: null, take: `${rel}/take.mp3`, vocal: null, stems: [], durationS: null, keyHeard: null, usedIn: [],
    }
    const save = () => writeFile(join(dir, 'meta.json'), JSON.stringify({ ...meta, plan }, null, 2))
    await save()
    await writeFile(join(dir, 'stems.zip'), await eleven.separate(take.audio, 'take.mp3', format))
    const r = await sidecar.request<{ vocal: string; stems: string[]; duration_s: number; key_heard: string | null; analysis: VocalAnalysis }>(
      'import_vocal', { folder: rel, settings: engineSettings() }, 300_000)
    const after = (await eleven.status()).credits?.used ?? null
    // (The account's count can lag behind: no difference yet is no measurement.)
    Object.assign(meta, { vocal: r.vocal, stems: r.stems, durationS: r.duration_s, keyHeard: r.key_heard, analysis: r.analysis,
      credits: before != null && after != null && after > before ? after - before : null })
    await save()
    send('library-changed')
    return meta
  })
  // A take made before the engine analysed them: its phrase loops, chops and key, into its meta.json.
  ipcMain.handle('vocals:analyze', async (_e, id: string): Promise<VocalMeta> => {
    if (!sidecar) throw new Error('Engine is not running')
    if (!/^[\w-]+$/.test(id)) throw new Error(`Bad vocal id: ${id}`)
    const file = join(lib(), 'Vocals', id, 'meta.json')
    const m = JSON.parse(await readFile(file, 'utf8'))
    m.analysis = await sidecar.request<VocalAnalysis>('analyze_vocal', { folder: `Vocals/${id}`, settings: engineSettings() }, 300_000)
    if (m.analysis.key) m.keyHeard = m.analysis.key
    await writeFile(file, JSON.stringify(m, null, 2))
    const { plan: _p, ...meta } = m
    return meta as VocalMeta
  })
  // Exported in a track: House of Tracks takes each vocal only once.
  ipcMain.handle('vocals:used', async (_e, ids: string[], track: string) => {
    for (const id of ids) {
      if (!/^[\w-]+$/.test(id)) continue
      const file = join(lib(), 'Vocals', id, 'meta.json')
      if (!existsSync(file)) continue
      const m = JSON.parse(await readFile(file, 'utf8'))
      m.usedIn = [...new Set([...(m.usedIn ?? []), track])]
      await writeFile(file, JSON.stringify(m, null, 2))
    }
  })
  // Splice vocal loops and phrases (SCOPE.md §6.11a): made into takes by the engine (vocalloop.py).
  ipcMain.handle('vocals:import-loops', async (_e, paths: string[]) => {
    if (!sidecar) throw new Error('Engine is not running')
    const r = await sidecar.request('import_vocal_loops', { paths, settings: engineSettings() }, 900_000)
    send('library-changed')
    return r
  })
  // A Splice loop's pack link, set by hand (when splice.com didn't answer to its label's name).
  ipcMain.handle('vocals:set-url', async (_e, id: string, url: string | null) => {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Bad vocal id: ${id}`)
    if (url && !/^https:\/\/(www\.)?splice\.com\//.test(url)) throw new Error('Not a splice.com link')
    const file = join(lib(), 'Vocals', id, 'meta.json')
    const m = JSON.parse(await readFile(file, 'utf8'))
    if (m.splice) m.splice.url = url || null
    await writeFile(file, JSON.stringify(m, null, 2))
  })
  // Not used after all (an export thrown away): offered to new tracks again.
  ipcMain.handle('vocals:unuse', async (_e, id: string) => {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Bad vocal id: ${id}`)
    const file = join(lib(), 'Vocals', id, 'meta.json')
    const m = JSON.parse(await readFile(file, 'utf8'))
    m.usedIn = []
    await writeFile(file, JSON.stringify(m, null, 2))
  })
  ipcMain.handle('vocals:delete', async (_e, id: string) => {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Bad vocal id: ${id}`)
    await rm(join(lib(), 'Vocals', id), { recursive: true, force: true })
    send('library-changed')
  })
  ipcMain.handle('vocals:list', async (): Promise<VocalMeta[]> => {
    const root = join(lib(), 'Vocals')
    if (!existsSync(root)) return []
    const out: VocalMeta[] = []
    for (const d of await readdir(root)) {
      try {
        const { plan: _p, ...m } = JSON.parse(await readFile(join(root, d, 'meta.json'), 'utf8'))
        out.push(m as VocalMeta)
      } catch {
        // not a take (or one still being made)
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  })
  ipcMain.handle('renders:clean', async (_e, keep: string[], dryRun: boolean) => {
    if (!sidecar) throw new Error('Engine is not running')
    return sidecar.request('clean_renders', { keep, dry_run: dryRun, settings: engineSettings() }, 300_000)
  })
  ipcMain.handle('export:master', async (_e, dir: string, mix: string, out: string, format: 'pcm24' | 'float32') => {
    if (!sidecar) throw new Error('Engine is not running')
    if (!/\.wav$/i.test(mix) || !/\.wav$/i.test(out)) throw new Error(`Bad export path: ${out}`)
    return sidecar.request('master_mixdown', {
      mix_path: exportFile(dir, mix), out_path: exportFile(dir, out), format, settings: engineSettings(),
    }, 600_000)
  })
  // The masters as they were written, measured and checked (the engine's preflight.py).
  ipcMain.handle('export:preflight', async (_e, dir: string, mix: string, master: string | null,
                                            o: { bpm: number; sections: { kind: string; start: number; bars: number }[] | null; key: string | null; whole: boolean }) => {
    if (!sidecar) throw new Error('Engine is not running')
    if (!/\.wav$/i.test(mix) || (master !== null && !/\.wav$/i.test(master))) throw new Error(`Bad export path: ${master ?? mix}`)
    return sidecar.request('preflight', {
      mix_path: exportFile(dir, mix), master_path: master === null ? null : exportFile(dir, master),
      bpm: o.bpm, sections: o.sections, key_label: o.key, whole: o.whole, settings: engineSettings(),
    }, 300_000)
  })
  // The reference tracks in <Library>/References: listed, or (analyze) the new ones measured first.
  ipcMain.handle('references:scan', async (_e, analyze: boolean) => {
    if (!sidecar) throw new Error('Engine is not running')
    return sidecar.request('scan_references', { analyze, settings: engineSettings() }, 1_800_000)
  })
  ipcMain.handle('shell:revealPath', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('shell:openFolder', (_e, path: string) => shell.openPath(path))
  // A Splice pack's page in the browser (only splice.com: nothing else leaves the app this way).
  ipcMain.handle('shell:openSplice', (_e, url: string) => {
    if (!/^https:\/\/(www\.)?splice\.com\//.test(url)) throw new Error('Not a splice.com link')
    return shell.openExternal(url)
  })

  ipcMain.handle('lib:read', async (_e, relPath: string) => {
    const buf = await readFile(libraryFile(lib(), relPath))
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })
  ipcMain.handle('shell:revealSample', (_e, relPath: string) => shell.showItemInFolder(libraryFile(lib(), relPath)))
  ipcMain.handle('shell:revealZip', (_e, zipId: number) => {
    const d = reader.zipDetail(zipId)
    const p = d?.zip.original_path
    if (p && existsSync(p)) shell.showItemInFolder(p)
    else if (d?.originalKept) void shell.openPath(keptDir(lib(), d.zip.source_code))
    else return false
    return true
  })
  ipcMain.handle('shell:openLibrary', async () => {
    await shell.openPath(lib())
  })
  const icon = dragIcon()
  ipcMain.on('drag:start', (e, relPath: string) => {
    try {
      e.sender.startDrag({ file: libraryFile(lib(), relPath), icon })
    } catch (err) {
      engineLog(`drag failed: ${(err as Error).message}`)
    }
  })
}

// ---------------------------------------------------------------------------
// Window + menu
// ---------------------------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    title: 'Warehouse',
    backgroundColor: '#1c1d20',
    // macOS: hidden title bar, traffic lights over the sidebar.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } }
      : {}),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.once('ready-to-show', () => win?.show())
  // Drops that miss the drop zone must not navigate the window to the file.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  win.on('closed', () => {
    win = null
  })
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Add Zips…', accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'add-zips') },
        // (⌘S is handled in Create itself, the menu only shows it.)
        { label: 'Keep Track', accelerator: 'CmdOrCtrl+S', registerAccelerator: false, click: () => send('menu', 'keep') },
        { label: 'Export Stems…', accelerator: 'CmdOrCtrl+E', click: () => send('menu', 'export') },
        { label: 'Show Library in Finder', click: () => settings.libraryPath && shell.openPath(settings.libraryPath) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // These shortcuts are handled in the page (it knows whether a text field or the
        // arrangement has focus); the menu only shows them, so keys aren't handled twice.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: () => send('menu', 'undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', registerAccelerator: false, click: () => send('menu', 'redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { label: 'Duplicate', accelerator: 'CmdOrCtrl+D', registerAccelerator: false, click: () => send('menu', 'duplicate') },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', registerAccelerator: false, click: () => send('menu', 'select-all') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Create', accelerator: 'CmdOrCtrl+1', click: () => send('menu', 'view:create') },
        { type: 'separator' },
        { label: 'Drumvault', accelerator: 'CmdOrCtrl+2', click: () => send('menu', 'view:process') },
        { label: 'Library', accelerator: 'CmdOrCtrl+3', click: () => send('menu', 'view:library') },
        { label: 'Grid', click: () => send('menu', 'view:grid') },
        { type: 'separator' },
        { label: 'Chord Stabs', accelerator: 'CmdOrCtrl+4', click: () => send('menu', 'view:stabs') },
        { label: 'Disco Hits', click: () => send('menu', 'view:hits') },
        { label: 'Strings', click: () => send('menu', 'view:strings') },
        { label: 'Bass Samples', click: () => send('menu', 'view:basses') },
        { label: 'Ambience', click: () => send('menu', 'view:ambience') },
        { label: 'Vocal Loops', click: () => send('menu', 'view:vocalloops') },
        { label: 'MIDI', click: () => send('menu', 'view:midi') },
        { label: 'Splice', click: () => send('menu', 'view:splice') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('menu', 'view:settings') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => send('menu', 'shortcuts') }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark' // the UI is dark-only (native menus and dialogs follow)
  settings = await loadSettings(settingsFile())
  reader = new LibraryReader(settings.libraryPath)
  registerIpc()
  buildMenu()
  createWindow()
  startEngine()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Single-window app: quitting when the window closes keeps the engine lifecycle simple.
  app.quit()
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting || !sidecar) return
  e.preventDefault()
  quitting = true
  void sidecar.stop().finally(() => app.quit())
})
