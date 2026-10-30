// Generate view session (SCOPE.md §6.6): the generations made this session, keep toggles and
// options. The next generation is computed and its audio decoded ahead of time, so cycling is
// instant.

import { create } from 'zustand'
import { api } from '../api'
import { playback } from '../audio/engine'
import {
  applyMix, bassBars, bassRenderOf, generate, harmonyOfKeys, LANES, playedLine, rerollLane as rerollSounds, type GenerateOptions, type Generation, type GenerationBass,
  type Keep, type Mix, type Role, type VerbOptions,
} from '../generate/generator'
import { bassPath } from '../audio/schedule'
import { bassSettings, loadBass, saveBassSettings, useBass } from './bass'
import { keysSettings, loadKeys, saveKeysSettings, useKeys } from './keys'
import { loadHits, useHits } from './hits'
import { hitSampleId, hitTranspose } from '../generate/disco'
import { keysModel, generateKeys, generatedKeysMidi } from '../generate/keys'
import { bassModel, generatedMidi, isGenerated } from '../generate/bassline'
import { bassFor } from '../generate/harmony'
import { Rng, randomSeed } from '../generate/rng'
import { newProject } from '../lib/project'
import type { HitItem, SampleListItem, TrackArrangement } from '../types/api'
import type { Project } from '../types/project'
import { attempt, useApp } from './app'
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
  /** Reverb builds on/off, on which parts, also every 8 or 16 bars, and how far the send rises. */
  verb: { enabled: boolean } & VerbOptions
  /** Disco hits on/off: when on, some tracks get one or two (SCOPE.md §6.8). */
  disco: { enabled: boolean }
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

const VERB_KEY = 'drumvault.generate.verb'
const VERB_DEFAULTS: GenerateSettings['verb'] = { enabled: true, tops: true, keys: true, every: 16, amount: 0.6 }

function savedVerb(): GenerateSettings['verb'] {
  try { return { ...VERB_DEFAULTS, ...JSON.parse(localStorage.getItem(VERB_KEY) ?? '{}') } }
  catch { return VERB_DEFAULTS }
}

const DISCO_KEY = 'drumvault.generate.disco'

function savedDisco(): GenerateSettings['disco'] {
  try { return { enabled: true, ...JSON.parse(localStorage.getItem(DISCO_KEY) ?? '{}') } }
  catch { return { enabled: true } }
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
  settings: { minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true, mix: savedMix(), tempo: savedTempo(), bass: savedBass(), keys: savedKeys(), verb: savedVerb(), disco: savedDisco() },
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
    ? { midis: basslines, presets, favorites: bassSettings().favorites, octaves: bassSettings().octaves, sidechain: settings.bass.sidechain, bars: settings.bass.bars } : null
  const ks = useKeys.getState()
  const keys = settings.keys.enabled && ks.parts.length && ks.presets.length
    ? { midis: ks.parts, presets: ks.presets, favorites: keysSettings().favorites, octaves: keysSettings().octaves, sidechain: settings.keys.sidechain, bars: settings.keys.bars } : null
  const { enabled, ...verb } = settings.verb
  const { hits } = useHits.getState()
  const disco = settings.disco.enabled && hits.length ? { hits } : null
  return { ...settings, bpm: bpm(), bass, keys, verb: enabled ? verb : null, disco, templates }
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

/** The octave saved for a patch (semitones, a multiple of 12), Bass's and Keys' each their own. */
export function presetOctave(role: 'bass' | 'keys', path: string): number {
  return (role === 'keys' ? keysSettings() : bassSettings()).octaves?.[path] ?? 0
}

/** Another patch plays at its own saved octave instead of the last one's. */
function withOctave(role: 'bass' | 'keys', b: GenerationBass, change: Partial<GenerationBass>): Partial<GenerationBass> {
  if (!change.preset || change.preset.path === b.preset.path || 'transpose' in change) return change
  const d = presetOctave(role, change.preset.path) - presetOctave(role, b.preset.path)
  return d ? { ...change, transpose: Math.max(-24, Math.min(24, b.transpose + d)) } : change
}

/**
 * −12 / +12 in Generate: the bass or keys part moves an octave, and its patch remembers that, so
 * every next track with the patch plays it in the same octave.
 */
export async function shiftOctave(role: 'bass' | 'keys', semis: 12 | -12): Promise<void> {
  const g = current()
  const b = role === 'keys' ? g?.keys : g?.bass
  if (!b) return
  const transpose = Math.max(-24, Math.min(24, b.transpose + semis))
  if (transpose === b.transpose) return
  const s = role === 'keys' ? keysSettings() : bassSettings()
  const octave = Math.max(-24, Math.min(24, (s.octaves?.[b.preset.path] ?? 0) + (transpose - b.transpose)))
  const octaves = { ...s.octaves }
  if (octave) octaves[b.preset.path] = octave
  else delete octaves[b.preset.path]
  await (role === 'keys' ? saveKeysSettings : saveBassSettings)({ octaves })
  if (role === 'keys') setGenerationKeys({ transpose }, g)
  else setGenerationBass({ transpose }, g)
}

/**
 * Change the current generation's bass in place (another patch or bassline, or a transpose):
 * every bass clip follows, the new part renders and plays as soon as it's ready.
 */
export function setGenerationBass(change: Partial<GenerationBass>, g: Generation | null = current()): void {
  if (!g?.bass) return
  // Another bassline drops the piano-roll edits of the previous one.
  if (change.midi && change.midi.id !== g.bass.midi.id && !('notes' in change)) change = { ...change, notes: undefined, bars: undefined }
  change = withOctave('bass', g.bass, change)
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
  // A riff that goes with the track's keys, when it has them.
  const line = bassFor(model, new Rng(randomSeed()), { key: g.key, bars }, harmonyOfKeys(g.keys, g.key))
  setGenerationBass({ midi: generatedMidi(line, g.key), transpose: isGenerated(g.bass.midi) ? g.bass.transpose : presetOctave('bass', g.bass.preset.path) })
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
  change = withOctave('keys', g.keys, change)
  g.keys = { ...g.keys, ...change }
  writeKeysClips(g)
  useGenerate.getState().set({ history: [...useGenerate.getState().history] })
  void playback.reloadClips(g.project, g.project.clips.filter((c) => c.type === 'audio' && c.bass && c.bass.role === 'keys').map((c) => c.id))
  invalidate()
}

/** Disco hits on/off: remembered; for new generations. */
export function setDiscoOptions(patch: Partial<GenerateSettings['disco']>): void {
  const { settings, set } = useGenerate.getState()
  const disco = { ...settings.disco, ...patch }
  set({ settings: { ...settings, disco } })
  try {
    localStorage.setItem(DISCO_KEY, JSON.stringify(disco))
  } catch {
    // not remembered
  }
  invalidate()
}

/**
 * A disco hit plays `pitch` semitones off in the current generation (every clip of it, at once),
 * and the difference from the move into the track key is saved on the hit: the next tracks
 * pitch it the same way (a key read wrong, fixed once).
 */
export function setHitPitchInTrack(hit: HitItem, pitch: number): void {
  const g = current()
  if (!g) return
  const id = hitSampleId(hit.id)
  for (const c of g.project.clips) {
    if (c.sample.id !== id) continue
    if (pitch) c.pitch = pitch
    else delete c.pitch
  }
  const fix = pitch - hitTranspose(hit, g.key)
  useHits.setState((s) => ({ hits: s.hits.map((h) => (h.id === hit.id ? { ...h, pitch_fix: fix } : h)) }))
  useGenerate.getState().set({ history: [...useGenerate.getState().history] })
  void attempt(() => api.setHitPitch(hit.id, fix))
  invalidate()
}

/**
 * Reverb builds: remembered; for new generations. A new amount also applies to the builds of the
 * generations already made (their sends scale with it).
 */
export function setVerbOptions(patch: Partial<GenerateSettings['verb']>): void {
  const { settings, history, pending, set } = useGenerate.getState()
  const verb = { ...settings.verb, ...patch }
  set({ settings: { ...settings, verb } })
  if (patch.amount !== undefined && settings.verb.amount > 0) {
    const k = verb.amount / settings.verb.amount
    for (const g of [...history, pending]) {
      for (const c of g?.project.clips ?? []) if (c.verb) c.verb = { from: c.verb.from * k, to: c.verb.to * k }
    }
  }
  try {
    localStorage.setItem(VERB_KEY, JSON.stringify(verb))
  } catch {
    // not remembered
  }
  if (patch.amount === undefined) invalidate()
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
  // A keys loop that goes with the track's bass riff.
  const line = generateKeys(model, new Rng(randomSeed()), { key: g.key, bars, bass: g.bass ? playedLine(g.bass) : null })
  setGenerationKeys({ midi: generatedKeysMidi(line, g.key), transpose: isGenerated(g.keys.midi) ? g.keys.transpose : presetOctave('keys', g.keys.preset.path) })
  return true
}

/** Options or keep toggles changed: the prefetched generation no longer fits. */
export function invalidate(): void {
  prefetch()
}

export async function loadSamples(): Promise<void> {
  const [samples, templates] = await Promise.all([api.querySamples({ sort: 'name' }), api.arrangements(), loadBass(), loadKeys(), loadHits()])
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
