// Generate view session (SCOPE.md §6.6): the generations made this session, keep toggles and
// options. The next generation is computed and its audio decoded ahead of time, so cycling is
// instant.

import { create } from 'zustand'
import { api } from '../api'
import { playback } from '../audio/engine'
import {
  applyMix, bassBars, bassRenderOf, generate, LANES, rerollLane as rerollSounds, type GenerateOptions, type Generation, type GenerationBass,
  type Keep, type Mix, type Role,
} from '../generate/generator'
import { bassPath } from '../audio/schedule'
import { bassSettings, loadBass, useBass } from './bass'
import { keysSettings, loadKeys, useKeys } from './keys'
import { keysModel, generateKeys, generatedKeysMidi } from '../generate/keys'
import { bassModel, generatedMidi, generateBassline, isGenerated } from '../generate/bassline'
import { Rng, randomSeed } from '../generate/rng'
import { newProject } from '../lib/project'
import type { SampleListItem, TrackArrangement } from '../types/api'
import type { Project } from '../types/project'
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
  /** Bass on/off, its sidechain depth under the kick (0…1) and new basslines' length (null: any). */
  bass: { enabled: boolean; sidechain: number; bars: 1 | 2 | 4 | null }
  keys: { enabled: boolean; sidechain: number; bars: 1 | 2 | 4 | null }
}

const BASS_KEY = 'drumvault.generate.bass'

function savedBass(): GenerateSettings['bass'] {
  try {
    return { enabled: true, sidechain: 0.6, bars: null, ...JSON.parse(localStorage.getItem(BASS_KEY) ?? '{}') }
  } catch {
    return { enabled: true, sidechain: 0.6, bars: null }
  }
}

function savedKeys(): GenerateSettings['keys'] {
  try { return { enabled: true, sidechain: 0.4, bars: null, ...JSON.parse(localStorage.getItem('drumvault.generate.keys') ?? '{}') } }
  catch { return { enabled: true, sidechain: 0.4, bars: null } }
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

/** Muted and soloed lanes (by name): they stay so while cycling through generations. */
export interface LaneToggles {
  mute: string[]
  solo: string[]
}

export interface KeepToggles {
  structure: boolean
  key: boolean
  lanes: Role[]
  bassline: boolean
  patch: boolean
  keysPart: boolean
  keysPatch: boolean
}

interface GenerateState {
  samples: SampleListItem[] | null
  /** Real tracks' arrangements: structure templates for most generations. */
  templates: TrackArrangement[]
  history: Generation[]
  index: number
  settings: GenerateSettings
  keep: KeepToggles
  lanes: LaneToggles
  /** The next generation, computed (and preloaded) ahead of time for the current keep/options. */
  pending: Generation | null
  set(patch: Partial<Omit<GenerateState, 'set'>>): void
}

export const useGenerate = create<GenerateState>((set) => ({
  samples: null,
  templates: [],
  history: [],
  index: -1,
  settings: { minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true, mix: savedMix(), tempo: savedTempo(), bass: savedBass(), keys: savedKeys() },
  keep: { structure: false, key: false, lanes: [], bassline: false, patch: false, keysPart: false, keysPatch: false },
  lanes: { mute: [], solo: [] },
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
  return {
    structure: k.structure ? g.sections : undefined, key: k.key ? g.key : undefined, picks,
    keysMidi: k.keysPart ? g.keys?.midi : undefined, keysPreset: k.keysPatch ? g.keys?.preset : undefined,
    keysEdit: k.keysPart && g.keys?.notes ? { notes: g.keys.notes, bars: bassBars(g.keys) } : undefined,
    bassMidi: k.bassline ? g.bass?.midi : undefined, bassPreset: k.patch ? g.bass?.preset : undefined,
    bassEdit: k.bassline && g.bass?.notes ? { notes: g.bass.notes, bars: bassBars(g.bass) } : undefined,
  }
}

function options(): GenerateOptions {
  const { settings, templates } = useGenerate.getState()
  const { basslines, presets } = useBass.getState()
  const bass = settings.bass.enabled && basslines.length && presets.length
    ? { midis: basslines, presets, favorites: bassSettings().favorites, sidechain: settings.bass.sidechain, bars: settings.bass.bars } : null
  const ks = useKeys.getState()
  const keys = settings.keys.enabled && ks.parts.length && ks.presets.length
    ? { midis: ks.parts, presets: ks.presets, favorites: keysSettings().favorites, sidechain: settings.keys.sidechain, bars: settings.keys.bars } : null
  return { ...settings, bpm: bpm(), bass, keys, templates }
}

function make(seed = randomSeed()): Generation | null {
  const { samples, keep } = useGenerate.getState()
  if (!samples?.length) return null
  const g = generate(samples, options(), seed, keepFrom(current(), keep))
  applyLaneToggles(g.project, useGenerate.getState().lanes)
  return g
}

function applyLaneToggles(project: Project, t: LaneToggles): void {
  for (const lane of project.lanes) {
    lane.mute = t.mute.includes(lane.name)
    lane.solo = t.solo.includes(lane.name)
  }
}

/** Mute or solo a lane (M / S in the overview): this and every other generation follow. */
export function toggleLane(name: string, what: 'mute' | 'solo'): void {
  const { lanes, history, pending, set } = useGenerate.getState()
  const list = lanes[what].includes(name) ? lanes[what].filter((n) => n !== name) : [...lanes[what], name]
  const next = { ...lanes, [what]: list }
  set({ lanes: next })
  for (const g of [...history, pending]) if (g) applyLaneToggles(g.project, next)
  const g = current()
  if (g) playback.syncLanes(g.project.lanes)
}

/**
 * A new sound for one lane, the rest of the track as it is (the overview's per-lane button):
 * added to the history right after the current generation (← goes back to it), and swapped in
 * at the playhead while playing.
 */
export function rerollLane(laneId: string): boolean {
  const { samples, history, index, set } = useGenerate.getState()
  const g = current()
  if (!g || !samples) return false
  const next = rerollSounds(samples, options(), g, laneId, randomSeed())
  if (!next) return false
  // The lane keeps its mix (volume, pan, sidechain, mute/solo): only its clips are new.
  const h = [...history]
  h.splice(index + 1, 0, next)
  set({ history: h, index: index + 1 })
  const ids = [...g.project.clips, ...next.project.clips].filter((c) => c.laneId === laneId).map((c) => c.id)
  if (playback.playing) void playback.reloadClips(next.project, ids)
  else void playback.preload(next.project)
  invalidate()
  return true
}

/** Point every bass clip of `g` at its current bass (another patch, bassline, transpose or edit). */
function writeBassClips(g: Generation): void {
  const b = g.bass
  if (!b) return
  const bars = bassBars(b)
  for (const c of g.project.clips) {
    if (c.type !== 'audio' || !c.bass || c.bass.role === 'keys') continue
    c.bass = bassRenderOf(b)
    c.sample = { ...c.sample, relPath: bassPath(c.bass, g.project.bpm), name: `${b.preset.name} · ${b.midi.name}`, bars,
      durationS: (bars * 4 * 60) / g.project.bpm }
    c.trimBeats %= bars * 4
  }
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

/**
 * Change the current generation's bass in place (another patch or bassline, or a transpose):
 * every bass clip follows, the new part renders and plays as soon as it's ready.
 */
export function setGenerationBass(change: Partial<GenerationBass>, g: Generation | null = current()): void {
  if (!g?.bass) return
  // Another bassline drops the piano-roll edits of the previous one.
  if (change.midi && change.midi.id !== g.bass.midi.id && !('notes' in change)) change = { ...change, notes: undefined, bars: undefined }
  g.bass = { ...g.bass, ...change }
  writeBassClips(g)
  useGenerate.getState().set({ history: [...useGenerate.getState().history] })
  void playback.reloadClips(g.project, g.project.clips.filter((c) => c.type === 'audio' && c.bass && c.bass.role !== 'keys').map((c) => c.id))
  invalidate()
}

/** Bass on/off and sidechain depth: remembered; the sidechain applies to the current generation at once. */
export function setBassOptions(patch: Partial<GenerateSettings['bass']>): void {
  const { settings, history, pending, set } = useGenerate.getState()
  const bass = { ...settings.bass, ...patch }
  set({ settings: { ...settings, bass } })
  for (const g of [...history, pending]) {
    const lane = g?.project.lanes.find((l) => l.name === 'Bass')
    if (lane) lane.duck = bass.sidechain
  }
  try {
    localStorage.setItem(BASS_KEY, JSON.stringify(bass))
  } catch {
    // not remembered
  }
  if (patch.enabled !== undefined || patch.bars !== undefined) invalidate()
}

/**
 * A new bassline for the current generation (Generate's bass section): written from what the
 * MIDI library's basslines have in common, in the track key, `bars` long (else the setting's).
 * A transpose of a line written before (an octave up, say) carries over.
 */
export function newBassline(bars: 1 | 2 | 4 | null = useGenerate.getState().settings.bass.bars): boolean {
  const g = current()
  const model = bassModel(useBass.getState().basslines)
  if (!g?.bass || !model) return false
  const line = generateBassline(model, new Rng(randomSeed()), { key: g.key, bars })
  setGenerationBass({ midi: generatedMidi(line, g.key), transpose: isGenerated(g.bass.midi) ? g.bass.transpose : 0 })
  return true
}

function writeKeysClips(g: Generation): void {
  const b = g.keys
  if (!b) return
  const bars = bassBars(b)
  for (const c of g.project.clips) {
    if (c.type !== 'audio' || !c.bass || c.bass.role !== 'keys') continue
    c.bass = bassRenderOf(b)
    c.sample = { ...c.sample, relPath: bassPath(c.bass, g.project.bpm), name: `${b.preset.name} · ${b.midi.name}`, bars,
      durationS: (bars * 4 * 60) / g.project.bpm }
    c.trimBeats %= bars * 4
  }
}

export function setGenerationKeys(change: Partial<GenerationBass>, g: Generation | null = current()): void {
  if (!g?.keys) return
  // Another Keys part drops the piano-roll edits of the previous one.
  if (change.midi && change.midi.id !== g.keys.midi.id && !('notes' in change)) change = { ...change, notes: undefined, bars: undefined }
  g.keys = { ...g.keys, ...change }
  writeKeysClips(g)
  useGenerate.getState().set({ history: [...useGenerate.getState().history] })
  void playback.reloadClips(g.project, g.project.clips.filter((c) => c.type === 'audio' && c.bass && c.bass.role === 'keys').map((c) => c.id))
  invalidate()
}

/** Keys on/off and sidechain depth: remembered; the sidechain applies to the current generation at once. */
export function setKeysOptions(patch: Partial<GenerateSettings['keys']>): void {
  const { settings, history, pending, set } = useGenerate.getState()
  const keys = { ...settings.keys, ...patch }
  set({ settings: { ...settings, keys } })
  for (const g of [...history, pending]) {
    const lane = g?.project.lanes.find((l) => l.name === 'Keys')
    if (lane) lane.duck = keys.sidechain
  }
  try {
    localStorage.setItem('drumvault.generate.keys', JSON.stringify(keys))
  } catch {
    // not remembered
  }
  if (patch.enabled !== undefined || patch.bars !== undefined) invalidate()
}

/**
 * A new Keys part for the current generation: written from what the
 * MIDI library's parts have in common, in the track key, `bars` long (else the setting's).
 * A transpose of a line written before (an octave up, say) carries over.
 */
export function newKeysPart(bars: 1 | 2 | 4 | null = useGenerate.getState().settings.keys.bars): boolean {
  const g = current()
  const model = keysModel(useKeys.getState().parts)
  if (!g?.keys || !model) return false
  const line = generateKeys(model, new Rng(randomSeed()), { key: g.key, bars })
  setGenerationKeys({ midi: generatedKeysMidi(line, g.key), transpose: isGenerated(g.keys.midi) ? g.keys.transpose : 0 })
  return true
}

/** Options or keep toggles changed: the prefetched generation no longer fits. */
export function invalidate(): void {
  prefetch()
}

export async function loadSamples(): Promise<void> {
  const [samples, templates] = await Promise.all([api.querySamples({ sort: 'name' }), api.arrangements(), loadBass(), loadKeys()])
  useGenerate.getState().set({ samples, templates })
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
