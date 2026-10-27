// Loading, saving and autosaving Arrange projects (<Library>/.drumvault/projects/*.dvproj).

import { produce } from 'immer'
import { api } from '../api'
import { playback } from '../audio/engine'
import { newProject, parseProject, serializeProject } from '../lib/project'
import { useApp } from '../store/app'
import { useArrange } from '../store/arrange'
import { useProject } from '../store/project'
import type { Project } from '../types/project'
import { clearPeaks } from './peaks'

const AUTOSAVE_MS = 1200

function libraryBpm(): number {
  return useApp.getState().settings?.engine.library_bpm ?? 124
}

/** Refresh sample ids/lengths from the library by path; report samples that are gone. */
export async function resolveSamples(project: Project): Promise<Project> {
  const paths = [...new Set(project.clips.map((c) => c.sample.relPath))]
  const rows = paths.length ? await api.samplesByPath(paths) : []
  const byPath = new Map(rows.map((r) => [r.rel_path, r]))
  useArrange.getState().set({ missing: new Set(paths.filter((p) => !byPath.has(p))) })
  return produce(project, (d) => {
    // The project tempo always follows the library BPM (loops are rendered at it).
    d.bpm = libraryBpm()
    for (const c of d.clips) {
      const r = byPath.get(c.sample.relPath)
      if (r) Object.assign(c.sample, { id: r.id, bars: r.bars, durationS: r.duration_s, name: r.name, category: r.category })
    }
  })
}

async function open(project: Project, file: string | null): Promise<void> {
  playback.stop()
  clearPeaks()
  const resolved = await resolveSamples(project)
  useProject.getState().load(resolved, file)
  playback.setPosition(0)
  playback.syncLanes(resolved.lanes)
  void playback.preload(resolved)
  if (file) void useApp.getState().saveSettings({ lastProject: file })
}

export async function refreshProjectList(): Promise<void> {
  useArrange.getState().set({ projects: await api.listProjects() })
}

export async function saveNow(): Promise<void> {
  const { project, file, dirty, markSaved } = useProject.getState()
  if (!dirty && file) return
  useArrange.getState().set({ saving: true })
  try {
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

export async function createProject(name = 'Untitled'): Promise<void> {
  await saveNow()
  await open(newProject(name, libraryBpm()), null)
  await saveNow()
}

/** Generate → Send to Arrange: open a generated arrangement as a new project ("Generated 03"). */
export async function openGenerated(project: Project): Promise<void> {
  await saveNow()
  await refreshProjectList()
  const used = useArrange.getState().projects.map((p) => /^Generated (\d+)$/.exec(p.name)?.[1]).filter(Boolean).map(Number)
  const name = `Generated ${String(Math.max(0, ...used) + 1).padStart(2, '0')}`
  await open({ ...structuredClone(project), name, createdAt: new Date().toISOString() }, null)
  await saveNow()
}

export async function deleteCurrentProject(): Promise<void> {
  const { file } = useProject.getState()
  if (file) await api.deleteProject(file)
  useProject.setState({ file: null, dirty: false })
  await refreshProjectList()
  const next = useArrange.getState().projects[0]
  if (next) await open(parseProject(await api.readProject(next.file)), next.file)
  else await createProject()
}

/** Open the last project of this library (or a new one) and start autosaving. */
export async function initProjects(): Promise<void> {
  await refreshProjectList()
  const last = useApp.getState().settings?.lastProject
  const known = useArrange.getState().projects
  const file = last && known.some((p) => p.file === last) ? last : known[0]?.file
  try {
    if (file) {
      await open(parseProject(await api.readProject(file)), file)
      return
    }
  } catch (e) {
    useApp.getState().toast('error', `Could not open project: ${(e as Error).message}`)
  }
  await open(newProject('Untitled', libraryBpm()), null)
}

let timer: ReturnType<typeof setTimeout> | null = null
let started = false

export function startAutosave(): void {
  if (started) return
  started = true
  useProject.subscribe((s, prev) => {
    if (s.project !== prev.project) playback.syncLanes(s.project.lanes)
    if (!s.dirty) return
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
