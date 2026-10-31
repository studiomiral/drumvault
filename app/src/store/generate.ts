// Generate view session (SCOPE.md §6.6): the generations made this session, keep toggles and
// options. The next generation is computed and its audio decoded ahead of time, so cycling is
// instant.
//
// The modules (Bass, Chords, Disco Hits, a lane's sound and choices) act on "the track": in
// Generate the generation on screen, in Arrange the open project when it was sent from Generate
// (it keeps its generation, Project.generation). There a change is an edit of the project (⌘Z).

import { create } from 'zustand'
import { api } from '../api'
import { playback } from '../audio/engine'
import {
  applyMix, bassBars, bassRenderOf, changeKey, generate, harmonyOfKeys, laneRole, LANES, newLaneSound, playedLine, rerollDisco, rerollKeys, rerollLane as rerollSounds, rerollStabs,
  setStabRhythm, setTrackRule, STAB_ROLES, type GenerateOptions, type Generation, type GenerationBass, type Keep, type Mix, type Role, type Rules, type VerbOptions,
} from '../generate/generator'
import { CHOICES } from '../generate/choices'
import { bassPath } from '../audio/schedule'
import { bassSettings, loadBass, saveBassSettings, useBass } from './bass'
import { keysSettings, loadKeys, saveKeysSettings, useKeys } from './keys'
import { loadHits, useHits } from './hits'
import { loadStabPresets, saveStabsSettings, stabPresetPool, stabsSettings, useStabPresets } from './stabs'
import { stabChordNotes, stabPartOf, stabPresetId } from '../generate/stabs'
import { hitSampleId, hitTranspose } from '../generate/disco'
import { keysModel, generateKeys, generatedKeysMidi } from '../generate/keys'
import { bassModel, generatedMidi, isGenerated } from '../generate/bassline'
import { bassFor } from '../generate/harmony'
import { Rng, randomSeed } from '../generate/rng'
import { newProject, uid } from '../lib/project'
import type { HitItem, SampleListItem, SavedStabRhythm, SerumPreset, TrackArrangement } from '../types/api'
import type { AudioClip, GenerationMeta, Project, Velocity } from '../types/project'
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
  /** Chord stabs on/off: when on, most tracks play them instead of the keys (SCOPE.md §6.9). */
  stabs: { enabled: boolean }
  /** Choices locked for every next track (choices.ts), by rule. */
  locks: Rules
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

const STABS_KEY = 'drumvault.generate.stabs'

function savedStabs(): GenerateSettings['stabs'] {
  try { return { enabled: true, ...JSON.parse(localStorage.getItem(STABS_KEY) ?? '{}') } }
  catch { return { enabled: true } }
}

const LOCKS_KEY = 'drumvault.generate.locks'

function savedLocks(): Rules {
  try { return JSON.parse(localStorage.getItem(LOCKS_KEY) ?? '{}') as Rules }
  catch { return {} }
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
  /** Lanes whose sound is kept: the main sample (kick, clap, …), the stab (its rhythm too), the disco hits. */
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
  /** Generations starred to keep (saved in the library), newest last. */
  shortlist: ShortlistItem[]
  set(patch: Partial<Omit<GenerateState, 'set'>>): void
}

export interface ShortlistItem {
  id: string
  savedAt: string
  g: Generation
}

export const useGenerate = create<GenerateState>((set) => ({
  samples: null,
  templates: [],
  history: [],
  index: -1,
  settings: { minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true, mix: savedMix(), tempo: savedTempo(), bass: savedBass(), keys: savedKeys(), verb: savedVerb(), disco: savedDisco(), stabs: savedStabs(), locks: savedLocks() },
  keep: { structure: false, key: false, lanes: [], bassline: false, patch: false, keysPart: false, keysPatch: false },
  lanes: { mute: [], solo: [] },
  pending: null,
  shortlist: [],
  set: (patch) => set(patch),
}))

const EMPTY = newProject('Generate', 124)

const inArrange = () => useApp.getState().view === 'arrange'

/** The generation on screen in Generate. */
function generated(): Generation | null {
  const { history, index } = useGenerate.getState()
  return history[index] ?? null
}

/**
 * The track the modules act on: Generate's generation on screen, or in Arrange the open project's
 * (a copy to change: `apply` writes it back), when it was sent from Generate.
 */
export function current(): Generation | null {
  return inArrange() ? arrangeTrack(useProject.getState().project) : generated()
}

/** A project sent from Generate as its generation (a copy), its bass and keys as its clips play them now. */
export function arrangeTrack(project: Project): Generation | null {
  if (!project.generation) return null
  const { generation, ...rest } = project
  const g: Generation = { ...structuredClone(generation), project: structuredClone(rest) as Project }
  return { ...g, bass: partOfClips(g.bass, g.project, 'bass'), keys: partOfClips(g.keys, g.project, 'keys') }
}

/** A part as the project's clips play it (Arrange's own bass editing changes the clips, not the generation). */
function partOfClips(b: GenerationBass | null, project: Project, role: 'bass' | 'keys'): GenerationBass | null {
  const r = project.clips.find((c): c is AudioClip => c.type === 'audio' && !!c.bass && (c.bass.role ?? 'bass') === role)?.bass
  if (!b || !r) return b
  const { presets } = role === 'keys' ? useKeys.getState() : useBass.getState()
  const midis = role === 'keys' ? useKeys.getState().parts : useBass.getState().basslines
  const preset = r.preset === b.preset.path ? b.preset : presets.find((p) => p.path === r.preset) ?? { ...b.preset, path: r.preset, name: r.presetName }
  const midi = r.midiId === b.midi.id ? b.midi
    : midis.find((m) => m.id === r.midiId) ?? { ...b.midi, id: r.midiId, name: r.midiName, notes: r.notes ?? b.midi.notes, bars: r.bars ?? b.midi.bars }
  const edited = r.notes && JSON.stringify(r.notes) !== JSON.stringify(midi.notes) ? { notes: r.notes, bars: r.bars } : { notes: undefined, bars: undefined }
  return { ...b, preset, midi, transpose: r.transpose, ...edited }
}

/** What a project keeps of its generation. */
export function metaOf(g: Generation): GenerationMeta {
  const { project: _p, ...meta } = g
  return structuredClone(meta)
}

/**
 * `next` becomes the track: in Generate a new step in the history right after the current one
 * (`step` 'new': ← goes back to it) or the current one changed ('same'); in Arrange an edit of
 * the project named `label` (⌘Z goes back). Its clips `ids` load, and swap in at the playhead.
 */
function apply(next: Generation, ids: Iterable<string>, label: string, step: 'new' | 'same' = 'new'): void {
  if (inArrange()) {
    // Changes in place (a patch, a note dragged) one undo step while they keep coming.
    useProject.getState().edit(label, (d) => {
      d.clips = next.project.clips
      d.lanes = next.project.lanes
      d.generation = metaOf(next)
    }, { coalesce: step === 'same' ? `generation-${label}` : undefined })
    const p = useProject.getState().project
    playback.syncLanes(p.lanes)
    void playback.reloadClips(p, ids)
    return
  }
  const { history, index, set } = useGenerate.getState()
  const h = [...history]
  if (step === 'new') {
    h.splice(index + 1, 0, next)
    set({ history: h, index: index + 1 })
  } else {
    const was = h[index]
    h[index] = next
    set({ history: h })
    // A starred generation changed: its shortlisted copy follows.
    const id = was && starred.get(was)
    if (id) {
      starred.set(next, id)
      updateShortlisted(id, next)
    }
  }
  playback.syncLanes(next.project.lanes)
  void playback.reloadClips(next.project, ids)
  invalidate()
}

/** Clip ids of `g`'s lanes `names` (or a test), before and after a change. */
function clipIds(a: Generation, b: Generation, on: (laneName: string, c: Project['clips'][number]) => boolean): string[] {
  const of = (g: Generation) => g.project.clips.filter((c) => on(g.project.lanes.find((l) => l.id === c.laneId)?.name ?? '', c)).map((c) => c.id)
  return [...new Set([...of(a), ...of(b)])]
}

function bpm(): number {
  return useApp.getState().settings?.engine.library_bpm ?? 124
}

function keepFrom(g: Generation | null, k: KeepToggles): Keep {
  if (!g) return {}
  const picks: Keep['picks'] = {}
  const rules: Rules = {}
  for (const role of k.lanes) if (g.picks[role]) picks[role] = g.picks[role]
  // A kept stab plays its rhythm on; kept disco hits come in again.
  if (k.lanes.includes('stab') && g.picks.stab && g.rules.stabs) Object.assign(rules, { stabs: true, stabRhythm: g.rules.stabRhythm })
  if (k.lanes.includes('disco') && g.picks.disco) {
    if (g.picks.disco2) picks.disco2 = g.picks.disco2
    Object.assign(rules, { discoIn: true, discoCount: g.picks.disco2 ? 2 : 1 })
  }
  return {
    structure: k.structure ? g.sections : undefined, key: k.key ? g.key : undefined, picks, rules,
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
  const discoHits = hits.filter((h) => h.kind !== 'stab')
  const stabHits = hits.filter((h) => h.kind === 'stab')
  const disco = settings.disco.enabled && discoHits.length ? { hits: discoHits } : null
  const ss = stabsSettings()
  const stabPresets = stabPresetPool()
  const stabs = settings.stabs.enabled && stabHits.length + stabPresets.length
    ? { hits: stabHits, presets: stabPresets, favorites: ss.favorites, octaves: ss.octaves, rhythms: ss.rhythms ?? [] } : null
  return { ...settings, bpm: bpm(), bass, keys, verb: enabled ? verb : null, disco, stabs, templates }
}

function make(seed = randomSeed()): Generation | null {
  const { samples, keep } = useGenerate.getState()
  if (!samples?.length) return null
  const g = generate(samples, options(), seed, keepFrom(generated(), keep))
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
  const g = generated()
  if (g) playback.syncLanes(g.project.lanes)
}

/**
 * A new sound for one lane, the rest of the track as it is (the overview's per-lane button):
 * added to the history right after the current generation (← goes back to it), and swapped in
 * at the playhead while playing.
 */
export function rerollLane(laneId: string): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  const lane = g?.project.lanes.find((l) => l.id === laneId)
  if (!g || !samples || !lane) return false
  // The stab and disco lanes are made again with their module's rules (the stab in its rhythm).
  const role = laneRole(lane.name)
  if (role === 'stab') return newChordStabs()
  if (role === 'disco' || role === 'disco2') return newDiscoHits()
  const next = rerollSounds(samples, options(), g, laneId, randomSeed())
  if (!next) return false
  // The lane keeps its mix (volume, pan, sidechain, mute/solo): only its clips are new.
  apply(next, [...g.project.clips, ...next.project.clips].filter((c) => c.laneId === laneId).map((c) => c.id), `Remake ${lane.name}`)
  return true
}

/**
 * Other sounds on a lane, where it plays (a lane's "New sound"): another sample of the same kind
 * for each one on it; on Bass and Keys another patch, on the stab lane another stab of its kind
 * (sample or patch) in the same rhythm. The clips stay where they are.
 */
export function newSound(laneId: string): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  const lane = g?.project.lanes.find((l) => l.id === laneId)
  if (!g || !samples || !lane) return false
  const role = laneRole(lane.name)
  if (role === 'bass' || role === 'keys') {
    const b = role === 'bass' ? g.bass : g.keys
    const presets = role === 'bass' ? useBass.getState().presets : useKeys.getState().presets
    const others = presets.filter((p) => p.path !== b?.preset.path)
    if (!b || !others.length) return false
    const preset = others[Math.floor(Math.random() * others.length)];
    (role === 'bass' ? setGenerationBass : setGenerationKeys)({ preset }, g)
    return true
  }
  if (role === 'stab' && g.project.clips.some((c) => c.laneId === laneId && c.type === 'audio' && c.bass)) return newStabPatch(g)
  const next = newLaneSound(samples, options(), g, laneId, randomSeed())
  if (!next) return false
  apply(next, next.project.clips.filter((c) => c.laneId === laneId).map((c) => c.id), `New sound on ${lane.name}`)
  return true
}

/** Another Serum stab patch for a track's stab lane: the same rhythm and octave rules, its own chord. */
function newStabPatch(g: Generation): boolean {
  const clips = g.project.clips.filter((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'stab')
  const was = clips[0]?.bass
  const others = stabPresetPool().filter((p) => p.path !== was?.preset)
  if (!was || !others.length) return false
  const p = others[Math.floor(Math.random() * others.length)]
  const oneKey = !!p.chord
  const voicing = oneKey ? null : p.voicing ?? null
  const part = stabPartOf(was.notes ?? [], was.bars ?? 2)
  const notes = stabChordNotes(part, was.keyLabel ?? g.key, oneKey, voicing)
  const transpose = Math.max(-24, Math.min(24, stabsSettings().octaves?.[p.path] ?? 0))
  for (const c of clips) {
    c.bass = { ...was, preset: p.path, presetName: p.name, transpose, notes, stab: voicing?.length ? { voicing } : { oneKey } }
    c.sample = { ...c.sample, relPath: bassPath(c.bass, g.project.bpm), name: p.name, id: stabPresetId(p.path) }
  }
  const pick = g.picks.stab
  if (pick) g.picks = { ...g.picks, stab: { ...pick, id: stabPresetId(p.path), name: p.name, rel_path: `serum:${p.path}` } }
  apply(g, clips.map((c) => c.id), 'New stab patch', 'same')
  return true
}

/**
 * The current generation in another key (the key menu in Generate): bass and keys moved, disco
 * hits pitched, out-of-key FX swapped, the drums as they are. A new step in the history.
 */
export function changeTrackKey(key: string): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  if (!g || !samples || key === g.key) return false
  const next = changeKey(samples, options(), g, key, randomSeed())
  const was = new Map(g.project.clips.map((c) => [c.id, JSON.stringify(c)]))
  apply(next, next.project.clips.filter((c) => was.get(c.id) !== JSON.stringify(c)).map((c) => c.id), `Key ${key}`)
  return true
}

/**
 * One of the track's choices set (a menu in Generate's Choices, or a lane's): the lanes it shapes
 * made again with it, the rest as it is. A locked choice's lock moves with it.
 */
export function setChoice(rule: string, value: unknown): boolean {
  const { samples, settings } = useGenerate.getState()
  const g = current()
  const choice = CHOICES.find((c) => c.rule === rule)
  if (!g || !samples || !choice) return false
  if (rule in settings.locks) saveLocks({ ...settings.locks, [rule]: value })
  const next = setTrackRule(samples, options(), g, rule, value, choice.roles)
  apply(next, clipIds(g, next, (name) => choice.roles.includes(laneRole(name)!)), choice.label)
  return true
}

/** Lock a choice at the track's value for every next track, or let it be drawn again. */
export function toggleLock(rule: string): void {
  const { settings } = useGenerate.getState()
  const g = current()
  const { [rule]: was, ...rest } = settings.locks
  saveLocks(was !== undefined || !g ? rest : { ...settings.locks, [rule]: g.rules[rule] ?? null })
}

function saveLocks(locks: Rules): void {
  const { settings, set } = useGenerate.getState()
  set({ settings: { ...settings, locks } })
  try {
    localStorage.setItem(LOCKS_KEY, JSON.stringify(locks))
  } catch {
    // not remembered
  }
  invalidate()
}

/**
 * Lock a lane (its 🔒 in the overview): its sound stays on the next press of G. Bass and Keys
 * keep their part and patch, the stab its rhythm, the disco lanes their hits.
 */
export function toggleLaneKeep(role: Role): void {
  const { keep, set } = useGenerate.getState()
  const on = laneKept(role, keep)
  const lanes = keep.lanes.filter((r) => r !== role)
  set({
    keep: role === 'bass' ? { ...keep, bassline: !on, patch: !on }
      : role === 'keys' ? { ...keep, keysPart: !on, keysPatch: !on }
        : { ...keep, lanes: on ? lanes : [...lanes, role] },
  })
  invalidate()
}

/** Whether the next press of G keeps a lane (all of it: Bass and Keys their part and patch). */
export function laneKept(role: Role, keep: KeepToggles = useGenerate.getState().keep): boolean {
  return role === 'bass' ? keep.bassline && keep.patch : role === 'keys' ? keep.keysPart && keep.keysPatch : keep.lanes.includes(role)
}

/** Lanes that can be kept: the ones with a main sound of their own. */
export const LOCKABLE: Role[] = ['kick', 'clap', 'hats', 'perc', 'top', 'groove', 'bass', 'keys', 'stab', 'disco']

/**
 * New disco hits for the current generation (the Disco Hits module's button): other hits and/or
 * other places, the rest of the track as it is. A new step in the history (← goes back).
 */
export function newDiscoHits(): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  if (!g || !samples) return false
  const next = rerollDisco(samples, options(), g, randomSeed())
  if (!next) return false
  apply(next, next.project.clips.filter((c) => c.sample.category === 'disco_hit').map((c) => c.id), 'New disco hits')
  return true
}

/**
 * New chord stabs for the current generation (the Chord Stabs module's button): other stabs, another
 * rhythm and placement, or stabs instead of the keys. A new step in the history (← goes back).
 */
export function newChordStabs(): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  if (!g || !samples) return false
  const next = rerollStabs(samples, options(), g, randomSeed())
  if (!next) return false
  apply(next, next.project.clips.filter((c) => c.sample.category === 'chord_stab').map((c) => c.id), 'New chord stabs')
  return true
}

/** Keys instead of chord stabs in the track (the Chords module's switch): a new keys part with the track's bass. */
export function keysInstead(): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  if (!g || !samples) return false
  const next = rerollKeys(samples, options(), g, randomSeed())
  if (!next) return false
  apply(next, clipIds(g, next, (name) => name === 'Keys' || STAB_ROLES.includes(laneRole(name)!)), 'Keys instead of stabs')
  return true
}

export type ChordsMode = 'keys' | 'both' | 'stabs' | 'off'

/**
 * New generations' chords (the Chords module's mode): keys only, keys or stabs (most tracks
 * stabs), stabs only, or none. Remembered.
 */
export function setChordsMode(mode: ChordsMode): void {
  setKeysOptions({ enabled: mode === 'keys' || mode === 'both' })
  setStabOptions({ enabled: mode === 'stabs' || mode === 'both' })
}

/** Point every bass clip of `g` at its current bass (another patch, bassline, transpose or edit). */
function writeBassClips(g: Generation): void {
  const b = g.bass
  if (!b) return
  const bars = bassBars(b)
  for (const c of g.project.clips) {
    if (c.type !== 'audio' || !c.bass || (c.bass.role ?? 'bass') !== 'bass') continue
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
  apply(g, g.project.clips.filter((c) => c.type === 'audio' && c.bass && (c.bass.role ?? 'bass') === 'bass').map((c) => c.id), 'Bass', 'same')
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
  if (patch.sidechain !== undefined) duckInArrange('Bass', bass.sidechain)
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
  apply(g, g.project.clips.filter((c) => c.type === 'audio' && c.bass && c.bass.role === 'keys').map((c) => c.id), 'Keys', 'same')
}

/** A sidechain slider moved while in Arrange: the project's lane follows. */
function duckInArrange(lane: string, duck: number): void {
  if (!inArrange() || !useProject.getState().project.generation) return
  useProject.getState().edit('Sidechain', (d) => {
    const l = d.lanes.find((x) => x.name === lane)
    if (l) l.duck = duck
  }, { coalesce: `duck-${lane}` })
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
 * −12 / +12 on a stab patch in Generate: its stabs in the current track move an octave, and the
 * patch remembers it for every next track.
 */
export async function shiftStabOctave(preset: string, semis: 12 | -12): Promise<void> {
  const g = current()
  if (!g) return
  const clips = g.project.clips.filter((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'stab' && c.bass.preset === preset)
  const now = clips[0]?.bass?.transpose
  if (now == null) return
  const transpose = Math.max(-24, Math.min(24, now + semis))
  if (transpose === now) return
  const s = stabsSettings()
  const octave = Math.max(-24, Math.min(24, (s.octaves?.[preset] ?? 0) + (transpose - now)))
  const octaves = { ...s.octaves }
  if (octave) octaves[preset] = octave
  else delete octaves[preset]
  await saveStabsSettings({ octaves })
  for (const c of clips) {
    c.bass = { ...c.bass!, transpose }
    c.sample = { ...c.sample, relPath: bassPath(c.bass, g.project.bpm) }
  }
  apply(g, clips.map((c) => c.id), 'Stab octave', 'same')
}

/**
 * Whether a stab patch plays a chord from one key (the switch on its row in Generate): remembered
 * for the patch; its stabs in the current track play the root alone, or the key's seventh chord.
 */
export async function setStabChord(preset: Pick<SerumPreset, 'path' | 'name'>, chord: boolean): Promise<void> {
  await saveStabsSettings({ chords: { ...stabsSettings().chords, [preset.path]: chord } })
  const g = current()
  if (!g) return
  const clips = g.project.clips.filter((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'stab' && c.bass.preset === preset.path)
  // On: the root alone. Off: the patch's own chord (its clip player's), else the key's seventh chord.
  const voicing = chord ? null : useStabPresets.getState().voicings[preset.path] ?? null
  for (const c of clips) {
    const notes = stabChordNotes(stabPartOf(c.bass!.notes ?? [], c.bass!.bars ?? 2), c.bass!.keyLabel ?? g.key, chord, voicing)
    c.bass = { ...c.bass!, notes, stab: voicing ? { voicing } : { oneKey: chord } }
    c.sample = { ...c.sample, relPath: bassPath(c.bass, g.project.bpm) }
  }
  apply(g, clips.map((c) => c.id), 'Stab chord', 'same')
}

/**
 * The current track's stabs play `rhythm` (an edit in the step sequencer): the same stab where it
 * played, the rest as it is; the generation changes in place (no new step per click).
 */
export function setTrackStabRhythm(rhythm: Velocity[][]): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  if (!g || !samples) return false
  const next = setStabRhythm(samples, options(), g, rhythm)
  if (!next) return false
  apply(next, [...g.project.clips, ...next.project.clips].filter((c) => c.sample.category === 'chord_stab').map((c) => c.id), 'Stab rhythm', 'same')
  return true
}

/** Save a stab rhythm for Generate to learn from (a name already saved is replaced). */
export async function saveStabRhythm(r: SavedStabRhythm): Promise<void> {
  const rhythms = (stabsSettings().rhythms ?? []).filter((x) => x.name !== r.name)
  await saveStabsSettings({ rhythms: [...rhythms, r] })
  invalidate()
}

export async function deleteStabRhythm(name: string): Promise<void> {
  await saveStabsSettings({ rhythms: (stabsSettings().rhythms ?? []).filter((x) => x.name !== name) })
  invalidate()
}

/** Chord stabs on/off: remembered; for new generations. */
export function setStabOptions(patch: Partial<GenerateSettings['stabs']>): void {
  const { settings, set } = useGenerate.getState()
  const stabs = { ...settings.stabs, ...patch }
  set({ settings: { ...settings, stabs } })
  try {
    localStorage.setItem(STABS_KEY, JSON.stringify(stabs))
  } catch {
    // not remembered
  }
  invalidate()
}

/**
 * A disco hit (or chord stab) plays `pitch` semitones off in the current generation (every clip of it, at once),
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
  void attempt(() => api.setHitPitch(hit.id, fix))
  apply(g, g.project.clips.filter((c) => c.sample.id === id).map((c) => c.id), 'Hit pitch', 'same')
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
  if (patch.sidechain !== undefined) duckInArrange('Keys', keys.sidechain)
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

// A patch's own chord read after tracks were prepared: prepare them again with it.
useStabPresets.subscribe((s, prev) => {
  if (s.voicings !== prev.voicings || s.measured !== prev.measured) invalidate()
})

export async function loadSamples(): Promise<void> {
  const [samples, templates] = await Promise.all([api.querySamples({ sort: 'name' }), api.arrangements(), loadBass(), loadKeys(), loadHits(), loadStabPresets(), loadShortlist()])
  useGenerate.getState().set({ samples, templates })
  prefetch()
}

// ---- the shortlist: starred generations, saved in the library (.drumvault/shortlist.json) ----

/** Generations in the history that are (copies of) shortlisted ones, by shortlist id. */
const starred = new WeakMap<Generation, string>()

async function loadShortlist(): Promise<void> {
  try {
    const text = await api.readShortlist()
    const items = text ? (JSON.parse(text) as ShortlistItem[]) : []
    useGenerate.getState().set({ shortlist: Array.isArray(items) ? items : [] })
  } catch (e) {
    useApp.getState().toast('error', `Could not read the shortlist: ${(e as Error).message}`)
  }
}

let saving: Promise<void> = Promise.resolve()

function saveShortlist(items: ShortlistItem[]): void {
  useGenerate.getState().set({ shortlist: items })
  const text = JSON.stringify(items)
  saving = saving.then(() => api.writeShortlist(text)).catch((e) => useApp.getState().toast('error', `Could not save the shortlist: ${(e as Error).message}`))
}

function updateShortlisted(id: string, g: Generation): void {
  const items = useGenerate.getState().shortlist
  if (items.some((x) => x.id === id)) saveShortlist(items.map((x) => (x.id === id ? { ...x, g: structuredClone(g) } : x)))
}

/** The shortlist id of a generation in the history, when it is starred. */
export function shortlistId(g: Generation | null, items = useGenerate.getState().shortlist): string | null {
  const id = g ? starred.get(g) : undefined
  return id && items.some((x) => x.id === id) ? id : null
}

/** Star the generation on screen (S), or take it off the shortlist. */
export function toggleStar(): void {
  const g = generated()
  if (!g) return
  const items = useGenerate.getState().shortlist
  const id = shortlistId(g, items)
  if (id) {
    saveShortlist(items.filter((x) => x.id !== id))
    return
  }
  const item = { id: uid('s'), savedAt: new Date().toISOString(), g: structuredClone(g) }
  starred.set(g, item.id)
  saveShortlist([...items, item])
}

export function removeShortlisted(id: string): void {
  saveShortlist(useGenerate.getState().shortlist.filter((x) => x.id !== id))
}

/** Open a shortlisted generation: it comes back at the end of the history, starred. */
export function openShortlisted(id: string): void {
  const item = useGenerate.getState().shortlist.find((x) => x.id === id)
  if (!item) return
  const at = useGenerate.getState().history.findIndex((g) => starred.get(g) === id)
  if (at >= 0) {
    show(at, 0)
    return
  }
  const g = structuredClone(item.g)
  applyLaneToggles(g.project, useGenerate.getState().lanes)
  applyMix(g.project, useGenerate.getState().settings.mix)
  starred.set(g, id)
  const { history } = useGenerate.getState()
  useGenerate.getState().set({ history: [...history, g] })
  show(history.length, 0)
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
  const section = sectionAtPlayhead(generated())
  useGenerate.getState().set({ index })
  const g = generated()
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
  const g = generated()
  const s = g?.sections[i]
  if (s) void playback.play(s.start * 4)
}

/** Play generations while the Generate view is open; give the transport back to Arrange after. */
export function attachPlayback(): () => void {
  playback.stop()
  playback.connect(() => generated()?.project ?? EMPTY)
  playback.setPosition(0)
  return () => {
    playback.stop()
    const arrange = useProject.getState().project
    playback.connect(() => useProject.getState().project)
    playback.syncLanes(arrange.lanes)
    playback.setPosition(0)
  }
}
