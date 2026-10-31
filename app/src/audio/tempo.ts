// Files the engine makes for a project before playback or export can load them: FX stretched
// to another tempo than the library (SCOPE.md §6.4a) and bass parts rendered through Serum 2
// (§6.7). Each is made once and cached by the engine.

import { api } from '../api'
import type { BassRender, Project } from '../types/project'
import { buffers } from './context'
import { bassPath, soundPath, tempoMode, tempoPath } from './schedule'

/** `${bpm}|${relPath}` known to exist. */
const ready = new Set<string>()
const inflight = new Map<string, Promise<void>>()

/** Ask the engine for every stretched FX and rendered bass the project needs that isn't known to exist yet. */
export async function ensureTempo(project: Project): Promise<void> {
  // Settled, not all: a failed bass render must not let playback load FX still being stretched.
  const results = await Promise.allSettled([ensureStretched(project), ensureBass(project)])
  const failed = results.find((r) => r.status === 'rejected')
  if (failed) throw (failed as PromiseRejectedResult).reason
}

const bassReady = new Set<string>()
const bassInflight = new Map<string, Promise<void>>()
const renderState = {
  bass: { listeners: new Set<(rendering: boolean) => void>(), pending: 0 },
  keys: { listeners: new Set<(rendering: boolean) => void>(), pending: 0 },
  stab: { listeners: new Set<(rendering: boolean) => void>(), pending: 0 },
}

/** Listen for bass rendering starting / finishing (the Generate view shows it). */
export function onBassRendering(fn: (rendering: boolean) => void, role: 'bass' | 'keys' | 'stab' = 'bass'): () => void {
  const state = renderState[role]
  state.listeners.add(fn)
  fn(state.pending > 0)
  return () => state.listeners.delete(fn)
}

/** Render one bass part (if not cached). Several parts render one after another in the engine. */
export function renderBass(b: BassRender, bpm: number): Promise<void> {
  const path = bassPath(b, bpm)
  if (bassReady.has(path)) return Promise.resolve()
  let p = bassInflight.get(path)
  if (!p) {
    const state = renderState[b.role ?? 'bass']
    if (state.pending++ === 0) for (const fn of state.listeners) fn(true)
    p = api.renderBass({ preset: b.preset, midiId: b.midiId, transpose: b.transpose, bpm, outRel: path, notes: b.notes, bars: b.bars, groove: b.groove })
      .then(() => {
        bassReady.add(path)
      })
      .finally(() => {
        bassInflight.delete(path)
        if (--state.pending === 0) for (const fn of state.listeners) fn(false)
      })
    bassInflight.set(path, p)
  }
  return p
}

export async function ensureBass(project: Project): Promise<void> {
  const parts = new Map<string, BassRender>()
  for (const c of project.clips) if (c.type === 'audio' && c.bass) parts.set(bassPath(c.bass, project.bpm), c.bass)
  await Promise.all([...parts.values()].map((b) => renderBass(b, project.bpm)))
}

export async function ensureStretched(project: Project): Promise<void> {
  const bpm = project.bpm
  const need = [...new Set(project.clips.filter((c) => tempoMode(c, bpm) === 'stretched').map((c) => c.sample.relPath))]
    .filter((rel) => !ready.has(`${bpm}|${rel}`))
  if (!need.length) return
  const key = `${bpm}|${need.join('\n')}`
  let p = inflight.get(key)
  if (!p) {
    p = api.stretchSamples(need, bpm).then(() => {
      for (const rel of need) ready.add(`${bpm}|${rel}`)
    }).finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  await p
}

/** Every file the project plays at its tempo. */
export function projectSounds(project: Project): string[] {
  return [...new Set(project.clips.map((c) => soundPath(c, project.bpm)))]
}

/** A sample's file changed (Library "Move sound"): its stretched copies must be made again. */
export function forgetTempo(relPath: string): void {
  for (const key of [...ready]) {
    const [bpm, rel] = [Number(key.slice(0, key.indexOf('|'))), key.slice(key.indexOf('|') + 1)]
    if (rel !== relPath) continue
    ready.delete(key)
    buffers.forget(tempoPath(rel, bpm))
  }
}
