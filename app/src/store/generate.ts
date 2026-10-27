// Generate view session (SCOPE.md §6.6): the generations made this session, keep toggles and
// options. The next generation is computed and its audio decoded ahead of time, so cycling is
// instant.

import { create } from 'zustand'
import { api } from '../api'
import { playback } from '../audio/engine'
import { applyMix, generate, LANES, type Generation, type Keep, type Mix, type Role } from '../generate/generator'
import { randomSeed } from '../generate/rng'
import { newProject } from '../lib/project'
import type { SampleListItem } from '../types/api'
import { useApp } from './app'
import { useProject } from './project'

export interface GenerateSettings {
  minMinutes: number
  maxMinutes: number
  zipIds: number[] | null
  useRatings: boolean
  /** Lane volume sliders (dB on top of the starting mix), per lane role. */
  mix: Mix
  /** Tempo per track: null = the library BPM, else a whole BPM from min–max (equal: fixed). */
  tempo: { min: number; max: number } | null
}

const TEMPO_KEY = 'drumvault.generate.tempo'

function savedTempo(): GenerateSettings['tempo'] {
  try {
    return JSON.parse(localStorage.getItem(TEMPO_KEY) ?? 'null') as GenerateSettings['tempo']
  } catch {
    return null
  }
}

/** Remember the tempo option between sessions. */
export function saveTempo(tempo: GenerateSettings['tempo']): void {
  try {
    localStorage.setItem(TEMPO_KEY, JSON.stringify(tempo))
  } catch {
    // not remembered
  }
}

const MIX_KEY = 'drumvault.generate.laneMix'

function savedMix(): Mix {
  try {
    return JSON.parse(localStorage.getItem(MIX_KEY) ?? '{}') as Mix
  } catch {
    return {}
  }
}

export interface KeepToggles {
  structure: boolean
  key: boolean
  lanes: Role[]
}

interface GenerateState {
  samples: SampleListItem[] | null
  history: Generation[]
  index: number
  settings: GenerateSettings
  keep: KeepToggles
  /** The next generation, computed (and preloaded) ahead of time for the current keep/options. */
  pending: Generation | null
  set(patch: Partial<Omit<GenerateState, 'set'>>): void
}

export const useGenerate = create<GenerateState>((set) => ({
  samples: null,
  history: [],
  index: -1,
  settings: { minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true, mix: savedMix(), tempo: savedTempo() },
  keep: { structure: false, key: false, lanes: [] },
  pending: null,
  set: (patch) => set(patch),
}))

const EMPTY = newProject('Generate', 124)

export function current(): Generation | null {
  const { history, index } = useGenerate.getState()
  return history[index] ?? null
}

function bpm(): number {
  return useApp.getState().settings?.engine.library_bpm ?? 124
}

function keepFrom(g: Generation | null, k: KeepToggles): Keep {
  if (!g) return {}
  const picks: Keep['picks'] = {}
  for (const role of k.lanes) if (g.picks[role]) picks[role] = g.picks[role]
  return { structure: k.structure ? g.sections : undefined, key: k.key ? g.key : undefined, picks }
}

function make(seed = randomSeed()): Generation | null {
  const { samples, settings, keep } = useGenerate.getState()
  if (!samples?.length) return null
  return generate(samples, { ...settings, bpm: bpm() }, seed, keepFrom(current(), keep))
}

/** Compute the next generation now and decode its samples, so the next press is instant. */
function prefetch(): void {
  const next = make()
  useGenerate.getState().set({ pending: next })
  if (next) void playback.preload(next.project)
}

/**
 * Move a lane's volume slider to `volumeDb`: the current, earlier and prefetched generations
 * follow at once (no re-roll), and the next ones are made with it. Remembered between sessions.
 */
export function setLaneVolume(role: Role, volumeDb: number): void {
  const { settings, history, pending, set } = useGenerate.getState()
  const base = LANES.find((l) => l.role === role)?.volumeDb ?? 0
  const mix = { ...settings.mix, [role]: volumeDb - base }
  set({ settings: { ...settings, mix } })
  for (const g of [...history, pending]) if (g) applyMix(g.project, mix)
  const g = current()
  if (g) playback.syncLanes(g.project.lanes)
  try {
    localStorage.setItem(MIX_KEY, JSON.stringify(mix))
  } catch {
    // private window or blocked storage: the mix just isn't remembered
  }
}

/** Options or keep toggles changed: the prefetched generation no longer fits. */
export function invalidate(): void {
  prefetch()
}

export async function loadSamples(): Promise<void> {
  const samples = await api.querySamples({ sort: 'name' })
  useGenerate.getState().set({ samples })
  prefetch()
}

/** Section index the playhead is in (to keep listening to the same part). */
function sectionAtPlayhead(g: Generation | null): number {
  if (!g || !playback.playing) return 0
  const bar = playback.position() / 4
  const i = g.sections.findIndex((s) => bar >= s.start && bar < s.start + s.bars)
  return Math.max(0, i)
}

function show(index: number, from?: number): void {
  const was = playback.playing
  const section = sectionAtPlayhead(current())
  useGenerate.getState().set({ index })
  const g = current()
  if (!g) return
  const start = from ?? (g.sections[Math.min(section, g.sections.length - 1)]?.start ?? 0) * 4
  if (was || from != null) void playback.play(start)
  else playback.setPosition(0)
}

/** A new generation (G / →), or the next one in the history when stepping forward. */
export function next(seed?: number): void {
  const { history, index, pending } = useGenerate.getState()
  if (seed == null && index < history.length - 1) {
    show(index + 1)
    return
  }
  const g = seed == null && pending ? pending : make(seed)
  if (!g) return
  useGenerate.getState().set({ history: [...history, g], pending: null })
  show(history.length, playback.playing ? undefined : 0)
  prefetch()
}

export function previous(): void {
  const { index } = useGenerate.getState()
  if (index > 0) show(index - 1)
}

export function playSection(i: number): void {
  const g = current()
  const s = g?.sections[i]
  if (s) void playback.play(s.start * 4)
}

/** Play generations while the Generate view is open; give the transport back to Arrange after. */
export function attachPlayback(): () => void {
  playback.stop()
  playback.connect(() => current()?.project ?? EMPTY)
  playback.setPosition(0)
  return () => {
    playback.stop()
    const arrange = useProject.getState().project
    playback.connect(() => useProject.getState().project)
    playback.syncLanes(arrange.lanes)
    playback.setPosition(0)
  }
}
