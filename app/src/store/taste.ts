// Learning from exports (SCOPE.md §6.6): the export log (<Library>/.drumvault/exports.json), what
// Generate takes from it per genre (generate/taste.ts), and what an export adds to it: the record
// of what the user changed, and the track's bassline saved to the MIDI library (when it isn't there).

import { create } from 'zustand'
import { api } from '../api'
import { CHOICES, choicesFor } from '../generate/choices'
import { isGenerated, keyOfLine } from '../generate/bassline'
import { roleOfLane, type Generation } from '../generate/generator'
import { learnTaste, recordOf, type ExportRecord, type Taste } from '../generate/taste'
import type { Genre } from '../types/engine'
import type { AudioClip, Project } from '../types/project'
import { loadBass, useBass } from './bass'

const LEARN_KEY = 'drumvault.generate.learnFromExports'

interface TasteState {
  records: ExportRecord[]
  loaded: boolean
  /** New tracks lean to what the exports say (Options: "Learn from exports"). */
  enabled: boolean
}

function savedEnabled(): boolean {
  try {
    return localStorage.getItem(LEARN_KEY) !== '0'
  } catch {
    return true
  }
}

export const useTaste = create<TasteState>(() => ({ records: [], loaded: false, enabled: savedEnabled() }))

/** Learning from exports on or off (remembered). */
export function setLearning(enabled: boolean): void {
  useTaste.setState({ enabled })
  try {
    localStorage.setItem(LEARN_KEY, enabled ? '1' : '0')
  } catch {
    // private window or blocked storage: it just isn't remembered
  }
}

/** What new tracks of `genre` take from the exports; null when learning is off or there are none. */
export function tasteFor(genre: Genre): Taste | null {
  const st = useTaste.getState()
  if (!st.enabled || !st.records.length) return null
  // (Learned once per log and genre: the log is a new array whenever it changes.)
  if (cache?.records !== st.records) cache = { records: st.records, tastes: new Map() }
  if (!cache.tastes.has(genre)) cache.tastes.set(genre, learnTaste(st.records, genre, CHOICES))
  return cache.tastes.get(genre) ?? null
}
let cache: { records: ExportRecord[]; tastes: Map<Genre, Taste | null> } | null = null

/** (Re)load the export log. */
export async function loadTaste(): Promise<void> {
  try {
    const text = await api.readExportLog()
    const data = text ? (JSON.parse(text) as { tracks?: ExportRecord[] }) : null
    useTaste.setState({ records: Array.isArray(data?.tracks) ? data!.tracks : [], loaded: true })
  } catch {
    useTaste.setState({ loaded: true })
  }
}

/**
 * Log what an exported track changed from how it was made (a later export of the same track
 * replaces its record). False for a track without an origin (built by hand, made before this).
 */
export async function recordExport(project: Project, bassline?: number): Promise<boolean> {
  if (!project.origin || !project.generation) return false
  if (!useTaste.getState().loaded) await loadTaste()
  const g: Generation = { ...structuredClone(project.generation), project }
  const rec = recordOf(g, project.origin, choicesFor(g), CHOICES, roleOfLane)
  if (bassline != null) rec.bassline = bassline
  const records = [...useTaste.getState().records.filter((r) => r.id !== rec.id), rec]
  await api.writeExportLog(JSON.stringify({ version: 1, tracks: records }, null, 1))
  useTaste.setState({ records })
  return true
}

const EPS = 1e-3

/** A line's notes as the library keeps them: cut at the loop's end, in order. */
function asStored(notes: [number, number, number, number][], bars: number): [number, number, number, number][] {
  const end = bars * 4
  return notes.filter(([s]) => s < end).map(([s, l, p, v]) => [s, Math.min(s + l, end) - s, p, v] as [number, number, number, number])
    .sort((a, b) => a[0] - b[0] || a[2] - b[2])
}

function sameLine(a: [number, number, number, number][], b: [number, number, number, number][]): boolean {
  return a.length === b.length && a.every((n, i) => n.every((x, j) => Math.abs(x - b[i][j]) < EPS))
}

/**
 * The exported track's bassline into the MIDI library, when it isn't there yet (a line written for
 * the track, or a library line edited in the piano roll), so new basslines learn from it. The
 * track's clips stay as they are (their turns play from its notes). Returns the line saved, the one
 * already there, or null (no bass).
 */
export async function saveExportedBass(project: Project): Promise<{ id: number; name: string; saved: boolean } | null> {
  const c = project.clips.find((x): x is AudioClip => x.type === 'audio' && !!x.bass && (x.bass.role ?? 'bass') === 'bass')
  if (!c?.bass) return null
  const b = c.bass
  if (!useBass.getState().loaded) await loadBass()
  const lib = useBass.getState().basslines
  const file = isGenerated(b.midiId) ? undefined : lib.find((m) => m.id === b.midiId)
  const notes = b.notes ?? file?.notes
  if (!notes?.length) return null
  const bars = Math.max(1, Math.min(16, Math.round(b.bars ?? file?.bars ?? 1)))
  const line = asStored(notes, bars)
  const there = lib.find((m) => m.role === 'bass' && m.bars === bars && sameLine(asStored(m.notes, bars), line))
  if (there) return { id: there.id, name: there.name, saved: false }
  const name = isGenerated(b.midiId) ? `${project.name} bass` : `${b.midiName} edit (${project.name})`
  const id = await api.saveMidi({ name, notes, bars, keyLabel: b.keyLabel ?? file?.key_label ?? keyOfLine(notes), source: 'export' })
  await loadBass()
  return { id, name, saved: true }
}

/** What an export taught Generate: the bassline saved (or already there), and whether its changes were logged. */
export interface ExportLearning {
  bass: { id: number; name: string; saved: boolean } | null
  logged: boolean
  error?: string
}

/** After an export: its bassline into the library, and what it changed into the export log. Never throws. */
export async function learnFromExport(project: Project): Promise<ExportLearning> {
  let bass: ExportLearning['bass'] = null
  try {
    bass = await saveExportedBass(project)
    return { bass, logged: await recordExport(project, bass?.id) }
  } catch (e) {
    return { bass, logged: false, error: (e as Error).message }
  }
}
