// Stretched FX for projects at another tempo than the library (SCOPE.md §6.4a): the engine
// renders them once per tempo; this makes sure they exist before playback or export loads them.

import { api } from '../api'
import type { Project } from '../types/project'
import { buffers } from './context'
import { soundPath, tempoMode, tempoPath } from './schedule'

/** `${bpm}|${relPath}` known to exist. */
const ready = new Set<string>()
const inflight = new Map<string, Promise<void>>()

/** Ask the engine for every stretched file the project needs that isn't known to exist yet. */
export async function ensureTempo(project: Project): Promise<void> {
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
