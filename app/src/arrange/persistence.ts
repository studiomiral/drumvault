// Loading, saving and autosaving Create's tracks (<Library>/.drumvault/projects/*.dvproj).
// A generation on screen is a scratch track (useProject.scratch): it's saved only once it's kept
// (edited by hand, starred with ⌘S, or exported), then autosaved like any project.

import { produce } from 'immer'
import { api } from '../api'
import { playback } from '../audio/engine'
import { newProject, parseProject, serializeProject } from '../lib/project'
import { useApp } from '../store/app'
import { useArrange } from '../store/arrange'
import { useProject } from '../store/project'
import { DEFAULT_GENRE, type Genre } from '../types/engine'
import type { Project } from '../types/project'
import { clearPeaks } from './peaks'

const AUTOSAVE_MS = 1200

function libraryBpm(): number {
  return useApp.getState().settings?.engine.library_bpm ?? 124
}

/** The active genre: a new project is made in it. */
export function activeGenre(): Genre {
  return useApp.getState().settings?.genre ?? DEFAULT_GENRE
}

/** Refresh sample ids/lengths from the library by path; report samples that are gone. */
export async function resolveSamples(project: Project): Promise<Project> {
  // Bass clips (and other rendered parts) play a render, not a library sample: it's made again when it's gone.
  const paths = [...new Set(project.clips.filter((c) => !(c.type === 'audio' && c.bass)).map((c) => c.sample.relPath))]
  const rows = paths.length ? await api.samplesByPath(paths) : []
  const byPath = new Map(rows.map((r) => [r.rel_path, r]))
  // Drop hits aren't library samples: they're there while the Drop Hits page has them.
  const hits = paths.some((p) => !byPath.has(p)) ? new Set((await api.listHits()).map((h) => h.rel_path)) : new Set<string>()
  useArrange.getState().set({ missing: new Set(paths.filter((p) => !byPath.has(p) && !hits.has(p))) })
  return produce(project, (d) => {
    // The project keeps its own tempo (a generation's, or the BPM field's): loops are sliced
    // and FX stretched to it (SCOPE.md §6.4a). Only a project without one takes the library BPM.
    if (!(d.bpm >= 60 && d.bpm <= 200)) d.bpm = libraryBpm()
    for (const c of d.clips) {
      const r = byPath.get(c.sample.relPath)
      if (r) Object.assign(c.sample, { id: r.id, bars: r.bars, durationS: r.duration_s, name: r.name, category: r.category })
    }
  })
}

/**
 * Told when a project file is opened (Create puts a generated one in its history); `genre` first
 * when it's of another genre than the active one (it becomes the active one).
 */
type Listener = { opened(file: string | null): void; genre?(g: Genre): Promise<void> }
const listeners: Listener[] = []
export function onProjects(l: Listener): void {
  listeners.push(l)
}

async function open(project: Project, file: string | null, scratch = false): Promise<void> {
  playback.stop()
  clearPeaks()
  if (project.genre !== activeGenre()) for (const l of listeners) await l.genre?.(project.genre)
  const resolved = await resolveSamples(project)
  useProject.getState().load(resolved, file, { scratch })
  playback.setPosition(0)
  playback.syncLanes(resolved.lanes)
  void playback.preload(resolved)
  if (file) void useApp.getState().saveSettings({ lastProject: file })
  for (const l of listeners) l.opened(file)
}

/** The next free "Generated NN" name. */
export async function nextGeneratedName(): Promise<string> {
  await refreshProjectList()
  const used = useArrange.getState().projects.map((p) => /^Generated (\d+)$/.exec(p.name)?.[1]).filter(Boolean).map(Number)
  return `Generated ${String(Math.max(0, ...used) + 1).padStart(2, '0')}`
}

/** The generator's own name for a track: it becomes "Generated NN" when it's first saved. */
const UNNAMED = 'Generated'

export async function refreshProjectList(): Promise<void> {
  useArrange.getState().set({ projects: await api.listProjects() })
}

let saves: Promise<void> = Promise.resolve()

/**
 * Save the open project if it has changes. One save at a time: a save asked for while another
 * runs waits for it (then saves only what changed since), so two never race for the same file
 * or both make a new project's file.
 */
export function saveNow(): Promise<void> {
  const next = saves.catch(() => {}).then(save)
  saves = next
  return next
}

async function save(): Promise<void> {
  const { file, dirty, scratch, markSaved } = useProject.getState()
  if ((!dirty && file) || scratch) return
  useArrange.getState().set({ saving: true })
  try {
    if (!file && useProject.getState().project.name === UNNAMED) {
      // (Not an edit: the name comes with the first save.)
      const name = await nextGeneratedName()
      useProject.setState((s) => ({ project: { ...s.project, name } }))
    }
    const { project } = useProject.getState()
    const saved = await api.writeProject(file, project.name, serializeProject(project))
    // Edits made while saving keep the project dirty.
    if (useProject.getState().project === project) markSaved(saved)
    else useProject.setState({ file: saved })
    if (saved !== file) void useApp.getState().saveSettings({ lastProject: saved })
    useArrange.getState().set({ lastSaved: Date.now() })
    void refreshProjectList()
  } finally {
    useArrange.getState().set({ saving: false })
  }
}

export async function openProject(file: string): Promise<void> {
  await saveNow()
  await open(parseProject(await api.readProject(file)), file)
}

/** An empty track to build by hand (Create's Saved menu): saved once something is put on it. */
export async function createProject(name = 'Untitled'): Promise<void> {
  await saveNow()
  await open(newProject(name, libraryBpm(), activeGenre()), null, true)
}

/** Delete the open track's file; `then` shows what comes instead (the next saved track, by default). */
export async function deleteCurrentProject(then?: () => Promise<void> | void): Promise<void> {
  const { file } = useProject.getState()
  if (file) await api.deleteProject(file)
  useProject.setState({ file: null, dirty: false, scratch: true })
  await refreshProjectList()
  if (then) {
    await then()
    return
  }
  const next = useArrange.getState().projects.find((p) => p.genre === activeGenre())
  if (next) await open(parseProject(await api.readProject(next.file)), next.file)
  else await createProject()
}

/** Open the last project of this library (or a new one) and start autosaving. */
export async function initProjects(): Promise<void> {
  await refreshProjectList()
  const last = useApp.getState().settings?.lastProject
  const known = useArrange.getState().projects
  const file = last && known.some((p) => p.file === last) ? last : known.find((p) => p.genre === activeGenre())?.file
  try {
    if (file) {
      await open(parseProject(await api.readProject(file)), file)
      return
    }
  } catch (e) {
    useApp.getState().toast('error', `Could not open project: ${(e as Error).message}`)
  }
  await open(newProject('Untitled', libraryBpm(), activeGenre()), null, true)
}

let timer: ReturnType<typeof setTimeout> | null = null
let started = false

export function startAutosave(): void {
  if (started) return
  started = true
  useProject.subscribe((s, prev) => {
    if (s.project !== prev.project) playback.syncLanes(s.project.lanes)
    if (!s.dirty || s.scratch) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void saveNow().catch((e) => useApp.getState().toast('error', `Autosave failed: ${(e as Error).message}`))
    }, AUTOSAVE_MS)
  })
  playback.connect(() => useProject.getState().project)
  window.addEventListener('beforeunload', () => {
    if (useProject.getState().dirty) void saveNow()
  })
}
