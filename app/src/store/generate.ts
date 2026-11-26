// Create's session (SCOPE.md §6.6): the tracks made this session and the options. The
// next generation is computed and its audio decoded ahead of time, so cycling is instant.
//
// The track on screen is always the open project (useProject): a generation is loaded into it as a
// scratch track, which is saved only once it's kept (edited by hand, starred, exported). The
// modules (Bass, Chords, Drop Hits, a lane's sound and choices) act on it through its generation
// (Project.generation); every change is an edit of the project (⌘Z). The history holds the tracks
// cycled through (← / →), each as it was left.

import { create } from 'zustand'
import { api } from '../api'
import { playback } from '../audio/engine'
import {
  addLane, applyMix, bassBars, bassClipRender, changeKey, generate, laneRole, newLaneSound, newStringsSound, rerollBed, rerollDisco, rerollPad, rerollStrings, rerollVocal, rerollLane as rerollSounds, rerollStabs,
  setStabRhythm, setTrackRule, setTrackRules, STAB_ROLES, type GenerateOptions, type Generation, type GenerationBass, type Mix, type Role, type Rules, type VerbOptions,
} from '../generate/generator'
import { CHOICES, choiceValue } from '../generate/choices'
import { refine, type RefineOptions } from '../generate/critic'
import { bassPath } from '../audio/schedule'
import { bassPatches, bassSettings, loadBass, pianoPatches, saveBassSettings, useBass, type BassSource } from './bass'
import { loadHits, useHits } from './hits'
import { saveStabsSettings, stabsSettings } from './stabs'
import { loadVocals, playableVocals, useVocals } from './vocals'
import { loadMusicLoops, useMusicLoops } from './musicloops'
import { musicFits } from '../generate/musicloops'
import { folderLoopFits, LOOP_CHANCE, loopFits, type VocalTake } from '../generate/vocals'
import { takeName, type VocalRequest } from '../vocals/plan'
import { hitSampleId, hitTranspose } from '../generate/disco'
import { bassModel, generateBassline, generatedMidi, isGenerated, type LoopBeats } from '../generate/bassline'
import { Rng, randomSeed } from '../generate/rng'
import { bestOf, bestOfSteps, CANDIDATES } from '../generate/score'
import { serializeProject } from '../lib/project'
import { nextGeneratedName, onProjects, openProject, refreshProjectList, saveNow, createProject, deleteCurrentProject } from '../arrange/persistence'
import { useArrange } from './arrange'
import type { HitItem, MusicLoopMeta, SampleListItem, SavedStabRhythm, SpliceCandidate, TrackArrangement } from '../types/api'
import { DEFAULT_GENRE, type Genre, type ReferenceTrack } from '../types/engine'
import type { AudioClip, GenerationMeta, LaneEnhance, Project, Velocity } from '../types/project'
import { ENHANCE_DEFAULTS } from '../audio/enhance'
import { attempt, useApp } from './app'
import { useProject } from './project'

export interface GenerateSettings {
  minMinutes: number
  maxMinutes: number
  zipIds: number[] | null
  useRatings: boolean
  /** The critic (critic.ts): every track made is listened back to and its clashing loops swapped. */
  listenBack: boolean
  /** Lane volume sliders (dB on top of the starting mix), per lane role. */
  mix: Mix
  /** Tempo per track: null = the library BPM, else a whole BPM from min–max (equal: fixed). */
  tempo: { min: number; max: number } | null
  /** Bass on/off, its sidechain depth under the kick (0…1) and new basslines' length (null: any). */
  /** …and what plays it: Serum patches, Bass Samples page one-shots, or either (SCOPE.md §6.7a). */
  /** `beats`: loop length of new basslines (2, 4 or 8 beats), null: as long as the library's really are. */
  bass: { enabled: boolean; sidechain: number; beats: LoopBeats | null; source: BassSource }
  /** Reverb builds on/off, on which parts, also every 8 or 16 bars, and how far the send rises. */
  verb: { enabled: boolean } & VerbOptions
  /** Drop hits on/off: when on, some tracks get one or two (SCOPE.md §6.8). */
  disco: { enabled: boolean }
  /** Chord stabs on/off: when on, every track plays them (SCOPE.md §6.9). */
  stabs: { enabled: boolean }
  /** Piano on/off (when on, a quarter of house tracks play a piano part instead of the stabs, SCOPE.md §6.9a) and what plays it. */
  piano: { enabled: boolean; source: BassSource }
  /** Strings on/off (when on, some tracks get them, SCOPE.md §6.10) and the Strings lane's sidechain depth (0…1). */
  strings: { enabled: boolean; sidechain: number }
  /** The breakdown layer on/off: when on, tracks may get a pad or a reese in their breakdowns (SCOPE.md §6.7b). */
  pads: { enabled: boolean }
  /** The ambience bed on/off: when on, most tracks get a very quiet texture under them (SCOPE.md §6.10a). */
  ambience: { enabled: boolean }
  /** Splice vocal loops on/off: when on, some new tracks sing one that fits their key and tempo (SCOPE.md §6.11a). */
  vocalLoops: { enabled: boolean }
  /** Music loops on/off: when on, a third of new house tracks without a piano play one that fits in place of the stabs (SCOPE.md §6.11b). */
  musicLoops: { enabled: boolean }
  /** Choices locked for every next track (choices.ts), by rule. */
  locks: Rules
}

// ---- genres: each its own settings (and its own tracks, below) ----

/** The genre whose settings are loaded: the app's active one (applyGenre). */
let storeGenre: Genre = DEFAULT_GENRE
/** A setting's key in the loaded genre's storage: house keeps the keys from before genres. */
const k = (key: string) => (storeGenre === DEFAULT_GENRE ? key : `${key}.${storeGenre}`)
/** What a genre's new tracks start from until it's set otherwise (SCOPE.md §5.18; house's: as before genres). */
const GENRE_START: Record<Genre, { tempo: { min: number; max: number } | null; minutes: [number, number] }> = {
  house: { tempo: null, minutes: [4, 6] },
  organic: { tempo: { min: 120, max: 123 }, minutes: [6.5, 7.5] },
}

const BASS_KEY = 'drumvault.generate.bass'

function savedBass(): GenerateSettings['bass'] {
  const base: GenerateSettings['bass'] = { enabled: true, sidechain: 0.6, beats: null, source: 'both' }
  try {
    const { bars, ...saved } = JSON.parse(localStorage.getItem(k(BASS_KEY)) ?? '{}')
    // (Saved before loops were counted in beats: a bar was 4 beats, longer ones are 8 now.)
    const beats = 'beats' in saved ? saved.beats : bars === 1 ? 4 : bars ? 8 : null
    return { ...base, ...saved, beats }
  } catch {
    return base
  }
}

const VERB_KEY = 'drumvault.generate.verb'
const VERB_DEFAULTS: GenerateSettings['verb'] = { enabled: true, tops: true, every: 16, amount: 0.6 }

function savedVerb(): GenerateSettings['verb'] {
  try { return { ...VERB_DEFAULTS, ...JSON.parse(localStorage.getItem(k(VERB_KEY)) ?? '{}') } }
  catch { return VERB_DEFAULTS }
}

const DISCO_KEY = 'drumvault.generate.disco'

function savedDisco(): GenerateSettings['disco'] {
  try { return { enabled: true, ...JSON.parse(localStorage.getItem(k(DISCO_KEY)) ?? '{}') } }
  catch { return { enabled: true } }
}

const STRINGS_KEY = 'drumvault.generate.strings'

const PADS_KEY = 'drumvault.generate.pads'
const AMBIENCE_KEY = 'drumvault.generate.ambience'
const VOCAL_LOOPS_KEY = 'drumvault.generate.vocalLoops'
const MUSIC_LOOPS_KEY = 'drumvault.generate.musicLoops'

function savedMusicLoops(): GenerateSettings['musicLoops'] {
  try {
    return { enabled: true, ...JSON.parse(localStorage.getItem(k(MUSIC_LOOPS_KEY)) ?? '{}') }
  } catch {
    return { enabled: true }
  }
}

function savedVocalLoops(): GenerateSettings['vocalLoops'] {
  try {
    return { enabled: true, ...JSON.parse(localStorage.getItem(k(VOCAL_LOOPS_KEY)) ?? '{}') }
  } catch {
    return { enabled: true }
  }
}

function savedAmbience(): GenerateSettings['ambience'] {
  try {
    return { enabled: true, ...JSON.parse(localStorage.getItem(k(AMBIENCE_KEY)) ?? '{}') }
  } catch {
    return { enabled: true }
  }
}

function savedPads(): GenerateSettings['pads'] {
  try {
    return { enabled: true, ...JSON.parse(localStorage.getItem(k(PADS_KEY)) ?? '{}') }
  } catch {
    return { enabled: true }
  }
}

function savedStrings(): GenerateSettings['strings'] {
  try { return { enabled: true, sidechain: 0.6, ...JSON.parse(localStorage.getItem(k(STRINGS_KEY)) ?? '{}') } }
  catch { return { enabled: true, sidechain: 0.6 } }
}

const STABS_KEY = 'drumvault.generate.stabs'

function savedStabs(): GenerateSettings['stabs'] {
  try { return { enabled: true, ...JSON.parse(localStorage.getItem(k(STABS_KEY)) ?? '{}') } }
  catch { return { enabled: true } }
}

const PIANO_KEY = 'drumvault.generate.piano'

function savedPiano(): GenerateSettings['piano'] {
  try { return { enabled: true, source: 'both', ...JSON.parse(localStorage.getItem(k(PIANO_KEY)) ?? '{}') } }
  catch { return { enabled: true, source: 'both' } }
}

const LOCKS_KEY = 'drumvault.generate.locks'

function savedLocks(): Rules {
  try { return JSON.parse(localStorage.getItem(k(LOCKS_KEY)) ?? '{}') as Rules }
  catch { return {} }
}

const TEMPO_KEY = 'drumvault.generate.tempo'

function savedTempo(): GenerateSettings['tempo'] {
  try {
    const saved = localStorage.getItem(k(TEMPO_KEY))
    return saved == null ? GENRE_START[storeGenre].tempo : JSON.parse(saved) as GenerateSettings['tempo']
  } catch {
    return GENRE_START[storeGenre].tempo
  }
}

/** Remember the tempo option between sessions. */
export function saveTempo(tempo: GenerateSettings['tempo']): void {
  try {
    localStorage.setItem(k(TEMPO_KEY), JSON.stringify(tempo))
  } catch {
    // not remembered
  }
}

const MIX_KEY = 'drumvault.generate.laneMix'

function savedMix(): Mix {
  try {
    return JSON.parse(localStorage.getItem(k(MIX_KEY)) ?? '{}') as Mix
  } catch {
    return {}
  }
}

/** Muted and soloed lanes (by name): they stay so while cycling through generations. */
export interface LaneToggles {
  mute: string[]
  solo: string[]
}

interface GenerateState {
  samples: SampleListItem[] | null
  /** Real tracks' arrangements: structure templates for most generations. */
  templates: TrackArrangement[]
  /** Reference tracks (measured): structure templates beside the zips', and the arc candidates are scored on. */
  references: ReferenceTrack[]
  history: Generation[]
  index: number
  settings: GenerateSettings
  lanes: LaneToggles
  /** The next generation, computed (and preloaded) ahead of time for the current options. */
  pending: Generation | null
  /** The open project isn't one of the history's tracks (a track built by hand, or none yet). */
  detached: boolean
  set(patch: Partial<Omit<GenerateState, 'set'>>): void
}

/** Starred generations of the old shortlist (.drumvault/shortlist.json): moved to the saved tracks. */
interface ShortlistItem {
  id: string
  savedAt: string
  g: Generation
}

/** The loaded genre's settings, as remembered. */
function savedSettings(): GenerateSettings {
  const [minMinutes, maxMinutes] = GENRE_START[storeGenre].minutes
  return { minMinutes, maxMinutes, zipIds: null, useRatings: true, listenBack: true, mix: savedMix(), tempo: savedTempo(), bass: savedBass(), verb: savedVerb(), disco: savedDisco(), stabs: savedStabs(), piano: savedPiano(), strings: savedStrings(), pads: savedPads(), ambience: savedAmbience(), vocalLoops: savedVocalLoops(), musicLoops: savedMusicLoops(), locks: savedLocks() }
}

export const useGenerate = create<GenerateState>((set) => ({
  samples: null,
  templates: [],
  references: [],
  history: [],
  index: -1,
  settings: savedSettings(),
  lanes: { mute: [], solo: [] },
  pending: null,
  detached: true,
  set: (patch) => set(patch),
}))

/** How a track of the history was left: its file once saved, and whether it's still a scratch track. */
interface Entry {
  file: string | null
  scratch: boolean
}
const entries = new WeakMap<Generation, Entry>()
const entryOf = (g: Generation): Entry => entries.get(g) ?? { file: null, scratch: true }

/** The history's tracks not saved yet, and the prefetched one: settings changes follow into them. */
function scratchTracks(): Generation[] {
  const { history, index, detached, pending } = useGenerate.getState()
  // (The one on screen follows in the project itself.)
  return [...history.filter((g, i) => entryOf(g).scratch && (detached || i !== index)), ...(pending ? [pending] : [])]
}

/**
 * The track the modules act on: the open project's generation (a copy to change: `apply` writes
 * it back), or null for a track built by hand.
 */
export function current(): Generation | null {
  return arrangeTrack(useProject.getState().project)
}

/** A change to the track on screen that keeps it a scratch track (a setting followed, not a hand edit). */
function onScreen(label: string, recipe: (p: Project) => void, coalesce?: string): void {
  const st = useProject.getState()
  if (!st.project.generation) return
  st.edit(label, (d) => recipe(d as Project), { coalesce, keepScratch: true })
}

/** A project's generation (a copy), its bass as its clips play it now. */
export function arrangeTrack(project: Project): Generation | null {
  if (!project.generation) return null
  const { generation, ...rest } = project
  const g: Generation = { ...structuredClone(generation), project: structuredClone(rest) as Project }
  return { ...g, bass: bassOfClips(g.bass, g.project) }
}

/** The bass as the project's clips play it (Arrange's own bass editing changes the clips, not the generation). */
function bassOfClips(b: GenerationBass | null, project: Project): GenerationBass | null {
  const r = project.clips.find((c): c is AudioClip => c.type === 'audio' && !!c.bass && (c.bass.role ?? 'bass') === 'bass')?.bass
  if (!b || !r) return b
  const { basslines: midis } = useBass.getState()
  const presets = bassPatches()
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
 * `next` becomes the track: an edit of the project named `label` (⌘Z goes back), which keeps a
 * scratch track a scratch track. Changes in place (`step` 'same': a patch, a note dragged) are one
 * undo step while they keep coming. Its clips `ids` load, and swap in at the playhead.
 */
function apply(next: Generation, ids: Iterable<string>, label: string, step: 'new' | 'same' = 'new'): void {
  useProject.getState().edit(label, (d) => {
    d.clips = next.project.clips
    d.lanes = next.project.lanes
    d.generation = metaOf(next)
  }, { coalesce: step === 'same' ? `generation-${label}` : undefined, keepScratch: true })
  const p = useProject.getState().project
  playback.syncLanes(p.lanes)
  void playback.reloadClips(p, ids)
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

/** The generator's options: for a new track (`fresh`, which sings no vocal) or the one on screen. */
function options(fresh = false): GenerateOptions {
  const { settings, templates, references } = useGenerate.getState()
  const { basslines } = useBass.getState()
  const presets = bassPatches(settings.bass.source)
  const bass = settings.bass.enabled && basslines.length && presets.length
    ? { midis: basslines, presets, favorites: bassSettings().favorites, octaves: bassSettings().octaves, sidechain: settings.bass.sidechain, beats: settings.bass.beats } : null
  const { enabled, ...verb } = settings.verb
  const { hits } = useHits.getState()
  const discoHits = hits.filter((h) => h.kind === 'disco')
  const stabHits = hits.filter((h) => h.kind === 'stab')
  const disco = settings.disco.enabled && discoHits.length ? { hits: discoHits } : null
  const stabs = settings.stabs.enabled && stabHits.length ? { hits: stabHits, rhythms: stabsSettings().rhythms ?? [] } : null
  const pianoParts = useBass.getState().pianoParts
  const pianoPool = pianoPatches(settings.piano.source)
  const piano = settings.piano.enabled && pianoParts.length && pianoPool.length ? { midis: pianoParts, presets: pianoPool } : null
  const stringHits = hits.filter((h) => h.kind === 'strings')
  const strings = settings.strings.enabled && stringHits.length ? { hits: stringHits, sidechain: settings.strings.sidechain } : null
  // Vocals: the take the open track sings (made for it, or its Splice loop); a new track sings a
  // Splice loop now and then (the Vocal Loops module), never an ElevenLabs take (made for one track).
  const take = fresh ? null : projectTake(useProject.getState().project)
  const loops = fresh && settings.vocalLoops.enabled ? spliceTakes() : []
  const vocals = take ? { takes: [take] } : loops.length ? { takes: loops, pool: { chance: LOOP_CHANCE } } : null
  const padPresets = useBass.getState().padPresets
  const pads = settings.pads.enabled && padPresets.length ? { presets: padPresets } : null
  const bedHits = hits.filter((h) => h.kind === 'ambience')
  const ambience = settings.ambience.enabled && bedHits.length ? { hits: bedHits } : null
  // Music loops (house only): a new track draws from them while the module is on; the track on
  // screen keeps (and can change) the one it plays.
  const allLoops = useMusicLoops.getState().loops
  const musicLoops = storeGenre === 'house' && allLoops.length && (!fresh || settings.musicLoops.enabled) ? { loops: allLoops } : null
  return { ...settings, genre: storeGenre, bpm: bpm(), bass, verb: enabled ? verb : null, disco, stabs, piano, strings, pads, ambience, vocals, musicLoops, templates, references }
}

/**
 * A new track. With a seed (typed in), exactly that one; otherwise the best of CANDIDATES made
 * from a random one, each listened back to (score.ts).
 */
function make(seed?: number): Generation | null {
  const { samples } = useGenerate.getState()
  if (!samples?.length) return null
  const opts = options(true)
  const one = (s: number) => listenBack(generate(samples, opts, s), {}, true)
  const g = seed != null ? one(seed) : bestOf(samples, randomSeed(), CANDIDATES, one)
  applyLaneToggles(g.project, useGenerate.getState().lanes)
  return g
}

/** As make(), a candidate per tick: the screen and the playing track get the thread between them. */
async function makeSoon(): Promise<Generation | null> {
  const { samples } = useGenerate.getState()
  if (!samples?.length) return null
  const opts = options(true)
  const it = bestOfSteps(samples, randomSeed(), CANDIDATES, (s) => listenBack(generate(samples, opts, s), {}, true))
  for (;;) {
    const r = it.next()
    if (r.done) {
      applyLaneToggles(r.value.project, useGenerate.getState().lanes)
      return r.value
    }
    await new Promise((ok) => setTimeout(ok, 0))
  }
}

/** The track as the critic leaves it (critic.ts): its clashing loops swapped; as it is with "Listen back" off. */
function listenBack(g: Generation, o: RefineOptions = {}, fresh = false): Generation {
  const { samples, settings } = useGenerate.getState()
  return samples && settings.listenBack ? refine(samples, options(fresh), g, o) : g
}

function applyLaneToggles(project: Project, t: LaneToggles): void {
  for (const lane of project.lanes) {
    lane.mute = t.mute.includes(lane.name)
    lane.solo = t.solo.includes(lane.name)
  }
}

/** A lane's EQ on or off (bypassed, its makeup gain with it): an edit of the track (in Arrange, ⌘Z). */
export function toggleLaneEq(laneId: string): void {
  const g = current()
  const lane = g?.project.lanes.find((l) => l.id === laneId)
  if (!g || !lane?.eq) return
  const next = structuredClone(g)
  const eq = next.project.lanes.find((l) => l.id === laneId)!.eq!
  eq.off = !eq.off
  apply(next, [], eq.off ? 'EQ off' : 'EQ on', 'same')
}

/** A lane's compressor on or off (bypassed, its makeup with it): an edit of the track (in Arrange, ⌘Z). */
export function toggleLaneComp(laneId: string): void {
  const g = current()
  const lane = g?.project.lanes.find((l) => l.id === laneId)
  if (!g || !lane?.comp) return
  const next = structuredClone(g)
  const comp = next.project.lanes.find((l) => l.id === laneId)!.comp!
  comp.off = !comp.off
  apply(next, [], comp.off ? 'Compressor off' : 'Compressor on', 'same')
}

/**
 * The Vocal lane's Enhance changed (SCOPE.md §6.11c): on or off, or one of its settings (a lane
 * without one starts from the defaults). An edit of the track (⌘Z): a slider's drag is one step.
 */
export function setVocalEnhance(laneId: string, patch: Partial<LaneEnhance>, label: string): void {
  onScreen(label, (p) => {
    const lane = p.lanes.find((l) => l.id === laneId)
    if (lane) lane.enhance = { ...(lane.enhance ?? ENHANCE_DEFAULTS), ...patch }
  }, `enhance-${label}`)
}

/** The track's drum bus on or off (for all its drum lanes, its makeup with it): an edit of the track (in Arrange, ⌘Z). */
export function toggleDrumBus(): void {
  const g = current()
  if (!g?.project.drumBus) return
  const next = structuredClone(g)
  const bus = next.project.drumBus!
  bus.off = !bus.off
  apply(next, [], bus.off ? 'Drum bus off' : 'Drum bus on', 'same')
}

/**
 * Mute or solo a generated lane (M / S in its header): the track on screen (⌘Z), and the lane of
 * that name stays so in the next tracks while cycling.
 */
export function toggleLane(name: string, what: 'mute' | 'solo'): void {
  const { lanes, set } = useGenerate.getState()
  const lane = useProject.getState().project.lanes.find((l) => l.name === name)
  const on = lane ? !lane[what] : !lanes[what].includes(name)
  const next = { ...lanes, [what]: [...lanes[what].filter((n) => n !== name), ...(on ? [name] : [])] }
  set({ lanes: next })
  for (const g of scratchTracks()) applyLaneToggles(g.project, next)
  const label = what === 'mute' ? (on ? 'Mute' : 'Unmute') : on ? 'Solo' : 'Unsolo'
  onScreen(label, (p) => {
    const l = p.lanes.find((x) => x.name === name)
    if (l) l[what] = on
  })
}

/**
 * A new sound for one lane, the rest of the track as it is (the overview's per-lane button):
 * an edit of the track (⌘Z goes back), and swapped in
 * at the playhead while playing.
 */
export function rerollLane(laneId: string): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  const lane = g?.project.lanes.find((l) => l.id === laneId)
  if (!g || !samples || !lane) return false
  // An added lane (SCOPE.md §6.6, "Adding a lane"): filled again as its kind.
  if (lane.extra && !laneRole(lane.name)) return addTrackLane(lane.extra as Role, laneId)
  // The stab and disco lanes are made again with their module's rules (the stab in its rhythm).
  const role = laneRole(lane.name)
  if (role && STAB_ROLES.includes(role)) return newChordStabs()
  if (role === 'disco' || role === 'disco2') return newDiscoHits()
  const made = rerollSounds(samples, options(), g, laneId, randomSeed())
  if (!made) return false
  const next = role ? listenBack(made, { only: [role] }) : made
  // The lane keeps its mix (volume, pan, sidechain, mute/solo): only its clips are new.
  apply(next, [...g.project.clips, ...next.project.clips].filter((c) => c.laneId === laneId).map((c) => c.id), `Remake ${lane.name}`)
  return true
}

/**
 * A lane of `role`'s kind added to the track on screen (SCOPE.md §6.6, "Adding a lane"), filled
 * and mixed as the generator does that kind; `into`: an added lane filled again (its Remake).
 * Its module's samples are there to draw from even while the module is off for new tracks. False:
 * nothing came out (the library has nothing of the kind, or no track on screen is generated).
 */
export function addTrackLane(role: Role, into?: string): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  if (!g || !samples) return false
  const opts = options()
  const hits = useHits.getState().hits
  const of = (kind: HitItem['kind']) => hits.filter((h) => h.kind === kind)
  if (role === 'stab' && !opts.stabs && of('stab').length) opts.stabs = { hits: of('stab'), rhythms: stabsSettings().rhythms ?? [] }
  if (role === 'disco' && !opts.disco && of('disco').length) opts.disco = { hits: of('disco') }
  if (role === 'bed' && !opts.ambience && of('ambience').length) opts.ambience = { hits: of('ambience') }
  const made = addLane(samples, opts, g, role, randomSeed(), into)
  if (!made) return false
  const was = new Set(g.project.clips.map((c) => c.id))
  const lane = into ?? made.project.lanes.find((l) => !g.project.lanes.some((x) => x.id === l.id))?.id
  const ids = [...g.project.clips.filter((c) => c.laneId === into), ...made.project.clips.filter((c) => !was.has(c.id))].map((c) => c.id)
  const name = made.project.lanes.find((l) => l.id === lane)?.name ?? 'lane'
  apply(made, ids, into ? `Remake ${name}` : `Add ${name}`)
  return true
}

/**
 * Other sounds on a lane, where it plays (a lane's "New sound"): another sample of the same kind
 * for each one on it; on Bass another patch, on the stab lane another stab in the same rhythm.
 * The clips stay where they are.
 */
export function newSound(laneId: string): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  const lane = g?.project.lanes.find((l) => l.id === laneId)
  if (!g || !samples || !lane) return false
  const role = laneRole(lane.name)
  if (role === 'bass') {
    const others = bassPatches(useGenerate.getState().settings.bass.source).filter((p) => p.path !== g.bass?.preset.path)
    if (!g.bass || !others.length) return false
    setGenerationBass({ preset: others[Math.floor(Math.random() * others.length)] }, g)
    return true
  }
  // (The Music Loop lane: another loop that fits.)
  if (role === 'music') return newMusicLoop()
  if (role === 'strings') {
    const next = newStringsSound(samples, options(), g, randomSeed())
    if (!next) return false
    apply(next, [...g.project.clips, ...next.project.clips].filter((c) => c.laneId === laneId || (c.type === 'audio' && c.bass?.role === 'strings')).map((c) => c.id), 'New strings sound')
    return true
  }
  const next = newLaneSound(samples, options(), g, laneId, randomSeed())
  if (!next) return false
  apply(next, next.project.clips.filter((c) => c.laneId === laneId).map((c) => c.id), `New sound on ${lane.name}`)
  return true
}

/**
 * The current generation in another key (the key menu in Generate): the bass moved, drop hits
 * and chord stabs pitched, out-of-key FX swapped, the drums as they are. A new step in the history.
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
  const next = listenBack(setTrackRule(samples, options(), g, rule, value, choice.roles), { only: choice.roles })
  apply(next, clipIds(g, next, (name) => choice.roles.includes(laneRole(name)!)), choice.label)
  return true
}

/** Lock a choice at the track's value for every next track, or let it be drawn again. */
export function toggleLock(rule: string): void {
  const { settings } = useGenerate.getState()
  const g = current()
  const { [rule]: was, ...rest } = settings.locks
  const c = CHOICES.find((x) => x.rule === rule)
  saveLocks(was !== undefined || !g ? rest : { ...settings.locks, [rule]: c ? choiceValue(c, g) : g.rules[rule] ?? null })
}

function saveLocks(locks: Rules): void {
  const { settings, set } = useGenerate.getState()
  set({ settings: { ...settings, locks } })
  try {
    localStorage.setItem(k(LOCKS_KEY), JSON.stringify(locks))
  } catch {
    // not remembered
  }
  invalidate()
}

/**
 * New drop hits for the current generation (the Drop Hits module's button): other hits and/or
 * other places, the rest of the track as it is. An edit of the track (⌘Z goes back).
 */
export function newDiscoHits(): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  if (!g || !samples) return false
  const next = rerollDisco(samples, options(), g, randomSeed())
  if (!next) return false
  apply(next, next.project.clips.filter((c) => c.sample.category === 'disco_hit').map((c) => c.id), 'New drop hits')
  return true
}

/**
 * New chord stabs for the current generation (the Chord Stabs module's button): other stabs, another
 * rhythm and placement, or stabs in a track that had none. An edit of the track (⌘Z goes back).
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

/** Point every bass clip of `g` at its current bass (another patch, bassline, transpose or edit). */
function writeBassClips(g: Generation): void {
  const b = g.bass
  if (!b) return
  const bars = bassBars(b)
  for (const c of g.project.clips) {
    if (c.type !== 'audio' || !c.bass || (c.bass.role ?? 'bass') !== 'bass') continue
    c.bass = bassClipRender(b, c.bass)
    c.sample = { ...c.sample, relPath: bassPath(c.bass, g.project.bpm), name: `${b.preset.name} · ${b.midi.name}`, bars,
      durationS: (bars * 4 * 60) / g.project.bpm }
    c.trimBeats %= bars * 4
  }
}

/** Compute the next generation now and decode its samples, so the next press is instant. */
let prefetching = 0
function prefetch(): void {
  // (Only the latest one is kept: a change of settings meanwhile starts another.)
  const token = ++prefetching
  useGenerate.getState().set({ pending: null })
  void makeSoon().then((next) => {
    if (token !== prefetching) return
    useGenerate.getState().set({ pending: next })
    if (next) void playback.preload(next.project)
  })
}

/**
 * Move a lane's volume slider to `volumeDb`: the current, earlier and prefetched generations
 * follow at once (no re-roll), and the next ones are made with it. Remembered between sessions.
 */
export function setLaneVolume(role: Role, volumeDb: number): void {
  const { settings, set } = useGenerate.getState()
  const mix = { ...settings.mix, [role]: volumeDb }
  set({ settings: { ...settings, mix } })
  for (const g of scratchTracks()) applyMix(g.project, mix)
  onScreen('Lane volume', (p) => {
    for (const l of p.lanes) if (laneRole(l.name) === role) l.volumeDb = volumeDb
  }, `vol-${role}`)
  try {
    localStorage.setItem(k(MIX_KEY), JSON.stringify(mix))
  } catch {
    // private window or blocked storage: the mix just isn't remembered
  }
}

/** The octave saved for a bass patch (semitones, a multiple of 12). */
export function presetOctave(path: string): number {
  return bassSettings().octaves?.[path] ?? 0
}

/** Another patch plays at its own saved octave instead of the last one's. */
function withOctave(b: GenerationBass, change: Partial<GenerationBass>): Partial<GenerationBass> {
  if (!change.preset || change.preset.path === b.preset.path || 'transpose' in change) return change
  const d = presetOctave(change.preset.path) - presetOctave(b.preset.path)
  return d ? { ...change, transpose: Math.max(-24, Math.min(24, b.transpose + d)) } : change
}

/**
 * −12 / +12 in Generate: the bass part moves an octave, and its patch remembers that, so every
 * next track with the patch plays it in the same octave.
 */
export async function shiftOctave(semis: 12 | -12): Promise<void> {
  const g = current()
  const b = g?.bass
  if (!b) return
  const transpose = Math.max(-24, Math.min(24, b.transpose + semis))
  if (transpose === b.transpose) return
  const s = bassSettings()
  const octave = Math.max(-24, Math.min(24, (s.octaves?.[b.preset.path] ?? 0) + (transpose - b.transpose)))
  const octaves = { ...s.octaves }
  if (octave) octaves[b.preset.path] = octave
  else delete octaves[b.preset.path]
  await saveBassSettings({ octaves })
  setGenerationBass({ transpose }, g)
}

/**
 * Change the current generation's bass in place (another patch or bassline, or a transpose):
 * every bass clip follows, the new part renders and plays as soon as it's ready.
 */
export function setGenerationBass(change: Partial<GenerationBass>, g: Generation | null = current()): void {
  if (!g?.bass) return
  // Another bassline drops the piano-roll edits of the previous one.
  if (change.midi && change.midi.id !== g.bass.midi.id && !('notes' in change)) change = { ...change, notes: undefined, bars: undefined }
  change = withOctave(g.bass, change)
  g.bass = { ...g.bass, ...change }
  writeBassClips(g)
  apply(g, g.project.clips.filter((c) => c.type === 'audio' && c.bass && (c.bass.role ?? 'bass') === 'bass').map((c) => c.id), 'Bass', 'same')
}

/** Bass on/off and sidechain depth: remembered; the sidechain applies to the current generation at once. */
export function setBassOptions(patch: Partial<GenerateSettings['bass']>): void {
  const { settings, set } = useGenerate.getState()
  const bass = { ...settings.bass, ...patch }
  set({ settings: { ...settings, bass } })
  // (Only when the amount itself moves: each track's sidechain was set for its own kick and bassline.)
  if (patch.sidechain !== undefined) {
    for (const g of scratchTracks()) {
      const lane = g.project.lanes.find((l) => l.name === 'Bass')
      if (lane) lane.duck = bass.sidechain
    }
    duckOnScreen('Bass', bass.sidechain)
  }
  try {
    localStorage.setItem(k(BASS_KEY), JSON.stringify(bass))
  } catch {
    // not remembered
  }
  if (patch.enabled !== undefined || patch.beats !== undefined) invalidate()
}

/**
 * A new bassline for the current generation (Generate's bass section): written from what the
 * MIDI library's basslines have in common, in the track key, `beats` long (else the setting's),
 * sliding a note on a patch that glides. A transpose of a line written before (an octave up, say) carries over.
 */
export function newBassline(beats: LoopBeats | null = useGenerate.getState().settings.bass.beats): boolean {
  const g = current()
  const model = bassModel(useBass.getState().basslines)
  if (!g?.bass || !model) return false
  const line = generateBassline(model, new Rng(randomSeed()), { key: g.key, beats, glide: !!g.bass.preset.glide })
  setGenerationBass({ midi: generatedMidi(line, g.key), transpose: isGenerated(g.bass.midi) ? g.bass.transpose : presetOctave(g.bass.preset.path) })
  return true
}

/** A module's sidechain slider moved: the track's lane follows. */
function duckOnScreen(lane: string, duck: number): void {
  onScreen('Sidechain', (p) => {
    const l = p.lanes.find((x) => x.name === lane)
    if (l) l.duck = duck
  }, `duck-${lane}`)
}

/**
 * Strings on/off for new generations, and the Strings lane's sidechain depth: the current, earlier
 * and prefetched generations (and a generated track in Arrange) follow it at once. Remembered.
 */
export function setStringsOptions(patch: Partial<GenerateSettings['strings']>): void {
  const { settings, set } = useGenerate.getState()
  const strings = { ...settings.strings, ...patch }
  set({ settings: { ...settings, strings } })
  for (const g of scratchTracks()) {
    const lane = g.project.lanes.find((l) => l.name === 'Strings')
    if (lane) lane.duck = strings.sidechain
  }
  if (patch.sidechain !== undefined) duckOnScreen('Strings', strings.sidechain)
  try {
    localStorage.setItem(k(STRINGS_KEY), JSON.stringify(strings))
  } catch {
    // not remembered
  }
  if (patch.enabled !== undefined) invalidate()
}

/**
 * New strings for the current generation (the Strings module's button): another sample and
 * placement, or strings in a track that had none. An edit of the track (⌘Z goes back).
 */
/** The ambience bed on or off for new generations (remembered). */
export function setAmbienceOptions(patch: Partial<GenerateSettings['ambience']>): void {
  const { settings, set } = useGenerate.getState()
  const ambience = { ...settings.ambience, ...patch }
  set({ settings: { ...settings, ambience } })
  try {
    localStorage.setItem(k(AMBIENCE_KEY), JSON.stringify(ambience))
  } catch {
    // not remembered
  }
  if (patch.enabled !== undefined) invalidate()
}

/** Another ambience bed for the current track (another texture), or one in a track without; the rest as it is. */
export function newBed(): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  if (!g || !samples) return false
  const bedHits = useHits.getState().hits.filter((h) => h.kind === 'ambience')
  const next = rerollBed(samples, { ...options(), ambience: bedHits.length ? { hits: bedHits } : null }, g, randomSeed())
  if (!next) return false
  apply(next, [...g.project.clips, ...next.project.clips].filter((c) => c.type === 'audio' && c.bass?.role === 'ambience').map((c) => c.id), 'New ambience')
  return true
}

/** The breakdown layer on or off for new generations (remembered). */
export function setPianoOptions(patch: Partial<GenerateSettings['piano']>): void {
  const { settings, set } = useGenerate.getState()
  const piano = { ...settings.piano, ...patch }
  set({ settings: { ...settings, piano } })
  try {
    localStorage.setItem(k(PIANO_KEY), JSON.stringify(piano))
  } catch {
    // not remembered
  }
  invalidate()
}

/**
 * The track's piano made again (SCOPE.md §6.9a): another part (`part`: a new seed for it; under a
 * progression the bass follows it again) or the same part through another patch or one-shot (`sound`).
 */
export function rerollPiano(what: 'part' | 'sound'): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  const opts = options()
  if (!g?.piano || !samples || !opts.piano) return false
  const others = opts.piano.presets.filter((p) => p.path !== g.piano!.preset.path)
  if (what === 'sound' && !others.length) return false
  const [rule, value] = what === 'part' ? ['pianoSeed', randomSeed()] : ['pianoPreset', others[Math.floor(Math.random() * others.length)].path]
  const roles: Role[] = what === 'part' ? ['piano', 'bass', 'pad', 'strings'] : ['piano']
  const next = listenBack(setTrackRule(samples, opts, g, rule, value, roles), { only: roles })
  apply(next, clipIds(g, next, (name) => roles.includes(laneRole(name)!)), what === 'part' ? 'New piano' : 'New piano sound')
  return true
}

export function setPadsOptions(patch: Partial<GenerateSettings['pads']>): void {
  const { settings, set } = useGenerate.getState()
  const pads = { ...settings.pads, ...patch }
  set({ settings: { ...settings, pads } })
  try {
    localStorage.setItem(k(PADS_KEY), JSON.stringify(pads))
  } catch {
    // not remembered
  }
  if (patch.enabled !== undefined) invalidate()
}

/** Another breakdown layer for the current track (another patch), or one in a track without; the rest as it is. */
export function newPad(): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  if (!g || !samples) return false
  const next = rerollPad(samples, { ...options(), pads: useBass.getState().padPresets.length ? { presets: useBass.getState().padPresets } : null }, g, randomSeed())
  if (!next) return false
  apply(next, [...g.project.clips, ...next.project.clips].filter((c) => c.type === 'audio' && c.bass?.role === 'pad').map((c) => c.id), 'New break layer')
  return true
}

export function newStrings(): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  if (!g || !samples) return false
  const next = rerollStrings(samples, options(), g, randomSeed())
  if (!next) return false
  apply(next, [...g.project.clips, ...next.project.clips].filter((c) => c.type === 'audio' && c.bass?.role === 'strings').map((c) => c.id), 'New strings')
  return true
}

/** The Splice loops a track could sing (analysed, never exported). */
function spliceTakes(): VocalTake[] {
  return (playableVocals(useVocals.getState().vocals) as VocalTake[]).filter((t) => t.source === 'splice' && !t.usedIn.length)
}

/** Music loops on or off for new generations (remembered). */
export function setMusicLoopOptions(patch: Partial<GenerateSettings['musicLoops']>): void {
  const { settings, set } = useGenerate.getState()
  const musicLoops = { ...settings.musicLoops, ...patch }
  set({ settings: { ...settings, musicLoops } })
  try {
    localStorage.setItem(k(MUSIC_LOOPS_KEY), JSON.stringify(musicLoops))
  } catch {
    // not remembered
  }
  if (patch.enabled !== undefined) invalidate()
}

/** The music loops a track in `key` at `bpm` could play (never exported, moved 1–3 semitones, near its tempo). */
export function musicLoopsFitting(key: string | null, bpm: number): MusicLoopMeta[] {
  return storeGenre === 'house' ? useMusicLoops.getState().loops.filter((l) => musicFits(l, key, bpm)) : []
}

/**
 * Another music loop for the track on screen (SCOPE.md §6.11b), at random from the others that fit;
 * on a track playing stabs, a loop in their place. The rest stays (⌘Z goes back). False: none fits.
 */
export function newMusicLoop(): boolean {
  const { samples } = useGenerate.getState()
  const g = current()
  if (!g || !samples) return false
  const others = musicLoopsFitting(g.key, g.project.bpm).filter((l) => l.id !== g.music?.loop.id)
  if (!others.length) return false
  const pick = others[Math.floor(Math.random() * others.length)]
  const roles: Role[] = g.music ? ['music'] : ['music', ...STAB_ROLES, 'piano']
  const values = g.music ? { musicLoop: pick.id } : { keys: 'music', musicLoop: pick.id }
  const next = listenBack(setTrackRules(samples, options(), g, values, roles), { only: roles })
  apply(next, clipIds(g, next, (name) => roles.includes(laneRole(name)!)), g.music ? 'New music loop' : 'Music loop instead of stabs')
  return true
}

/** Splice vocal loops on or off for new generations (remembered). */
export function setVocalLoopOptions(patch: Partial<GenerateSettings['vocalLoops']>): void {
  const { settings, set } = useGenerate.getState()
  const vocalLoops = { ...settings.vocalLoops, ...patch }
  set({ settings: { ...settings, vocalLoops } })
  try {
    localStorage.setItem(k(VOCAL_LOOPS_KEY), JSON.stringify(vocalLoops))
  } catch {
    // not remembered
  }
  if (patch.enabled !== undefined) invalidate()
}

/** The Splice folder's vocal loops (a scan of names and headers: a few seconds), kept for the session. */
let folderVocals: Promise<SpliceCandidate[]> | null = null
function spliceFolderVocals(): Promise<SpliceCandidate[]> {
  folderVocals ??= api.scanSplice().then((s) => s.candidates.filter((c) => c.kind === 'vocal')).catch((e) => {
    folderVocals = null
    throw e
  })
  return folderVocals
}
/** Folder loops imported this session for a track (they're takes now, or came out without a phrase). */
const folderTried = new Set<string>()
/** Folder loops imported at most per click, when their name fits but the take may not. */
const FOLDER_TRIES = 4

/** The Splice loops a track in `key` at `bpm` could sing that aren't in the library yet (by their names). */
async function folderLoops(key: string | null, bpm: number): Promise<SpliceCandidate[]> {
  let all: SpliceCandidate[]
  try {
    all = await spliceFolderVocals()
  } catch {
    return []  // no engine or no Splice folder: the imported loops only
  }
  const taken = new Set(useVocals.getState().vocals.map((v) => v.splice?.original).filter(Boolean))
  return all.filter((c) => !folderTried.has(c.path) && !taken.has(c.path) && folderLoopFits(c, key, bpm))
}

/**
 * A Splice vocal loop for the track on screen (the Vocals module), drawn at random from all that fit
 * its key and tempo and aren't the one it sings: the imported loops, and the Splice folder's (by
 * their names), imported when drawn and sung if the take fits. Placed as Generate would; it replaces
 * whatever the track sings (one vocal per track). 'none' when nothing fits, 'gone' when the track
 * left the screen meanwhile.
 */
export async function newVocalLoop(): Promise<{ placed: string; from: 'library' | 'folder' } | 'none' | 'gone' | 'busy'> {
  if (useVocals.getState().making) return 'busy'
  const g = current()
  if (!g) return 'none'
  const was = useProject.getState().project.createdAt
  const now = g.picks.vocal?.rel_path
  const fits = (t: VocalTake) => loopFits(t, g.key, g.project.bpm) && `Vocals/${t.id}/vocal.wav` !== now
  useVocals.setState({ making: true })
  try {
    const pool: ({ take: VocalTake } | { file: SpliceCandidate })[] = [
      ...spliceTakes().filter(fits).map((take) => ({ take })),
      ...(await folderLoops(g.key, g.project.bpm)).map((file) => ({ file })),
    ]
    const rng = new Rng(randomSeed())
    for (let i = pool.length - 1; i > 0; i--) {
      const j = rng.int(0, i)
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    let tries = 0
    for (const p of pool) {
      let take = 'take' in p ? p.take : null
      if ('file' in p) {
        if (tries++ >= FOLDER_TRIES) continue
        folderTried.add(p.file.path)
        const r = await api.importVocalLoops([p.file.path])
        await loadVocals()
        const id = r.imported[0]?.id
        take = (id && spliceTakes().find((t) => t.id === id)) || null
        if (!take || !fits(take)) continue  // its key or tempo heard otherwise, or no phrase: it stays on the Vocal Loops page
      }
      if (!take) continue
      if (useProject.getState().project.createdAt !== was) return 'gone'
      const { samples } = useGenerate.getState()
      const at = current()
      if (!at || !samples) return 'gone'
      const next = rerollVocal(samples, { ...options(), vocals: { takes: [take] } }, at, randomSeed())
      if (!next) continue
      apply(next, [...at.project.clips, ...next.project.clips].filter((c) => c.sample.relPath.startsWith('Vocals/') || c.sample.relPath.startsWith('.drumvault/vocals/')).map((c) => c.id), now ? 'New vocal loop' : 'Add a vocal')
      return { placed: takeName(take), from: 'take' in p ? 'library' : 'folder' }
    }
    return 'none'
  } finally {
    useVocals.setState({ making: false })
  }
}

/** How many vocal loops could be drawn for a track in `key` at `bpm`: imported, and in the Splice folder by name. */
export async function vocalLoopsFitting(key: string | null, bpm: number): Promise<{ library: number; folder: number }> {
  return { library: spliceTakes().filter((t) => loopFits(t, key, bpm)).length, folder: (await folderLoops(key, bpm)).length }
}

/** The take the open track sings (its generation's pick), once it's analysed. */
function projectTake(project: Project): VocalTake | null {
  const rel = project.generation?.picks.vocal?.rel_path
  if (!rel) return null
  return (playableVocals(useVocals.getState().vocals) as VocalTake[]).find((t) => rel === `Vocals/${t.id}/vocal.wav`) ?? null
}

/**
 * A vocal made for the track on screen (the Vocals module, SCOPE.md §6.11): a new take from
 * ElevenLabs, sung in the track's key, then placed as Generate would (its phrase loop,
 * and where). An edit of the project (⌘Z); the take it replaces is never offered again.
 */
export async function makeVocal(req: VocalRequest): Promise<void> {
  const { toast } = useApp.getState()
  if (useVocals.getState().making) return
  const was = useProject.getState().project.createdAt
  useVocals.setState({ making: true })
  try {
    const take = await api.makeVocal(req)
    useVocals.setState((s) => ({ vocals: [...s.vocals.filter((v) => v.id !== take.id), take] }))
    const sung = takeName(take)
    if (useProject.getState().project.createdAt !== was) {
      toast('info', `The vocal ${sung} was made, but the track it was for isn't on screen any more.`)
      return
    }
    const { samples } = useGenerate.getState()
    const g = current()
    if (!g || !samples) return
    if (!playableVocals([take]).length) {
      toast('error', `The vocal ${sung} came out without a phrase loop to use: make another.`)
      return
    }
    const next = rerollVocal(samples, { ...options(), vocals: { takes: [take as VocalTake] } }, g, randomSeed())
    if (!next) return
    apply(next, [...g.project.clips, ...next.project.clips].filter((c) => c.sample.relPath.startsWith('Vocals/') || c.sample.relPath.startsWith('.drumvault/vocals/')).map((c) => c.id), 'New vocal')
    toast('info', `Vocal made: ${sung}${take.credits != null ? ` (${take.credits} credits)` : ''}.`)
  } catch (e) {
    toast('error', `The vocal wasn't made: ${(e as Error).message}`)
  } finally {
    useVocals.setState({ making: false })
  }
}

/** Drop hits on/off: remembered; for new generations. */
export function setDiscoOptions(patch: Partial<GenerateSettings['disco']>): void {
  const { settings, set } = useGenerate.getState()
  const disco = { ...settings.disco, ...patch }
  set({ settings: { ...settings, disco } })
  try {
    localStorage.setItem(k(DISCO_KEY), JSON.stringify(disco))
  } catch {
    // not remembered
  }
  invalidate()
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
    localStorage.setItem(k(STABS_KEY), JSON.stringify(stabs))
  } catch {
    // not remembered
  }
  invalidate()
}

/**
 * A drop hit (or chord stab) plays `pitch` semitones off in the current generation (every clip of it, at once),
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
  const { settings, set } = useGenerate.getState()
  const verb = { ...settings.verb, ...patch }
  set({ settings: { ...settings, verb } })
  if (patch.amount !== undefined && settings.verb.amount > 0) {
    const k = verb.amount / settings.verb.amount
    const scale = (p: Project) => {
      for (const c of p.clips) if (c.verb) c.verb = { from: c.verb.from * k, to: c.verb.to * k }
    }
    for (const g of scratchTracks()) scale(g.project)
    if (useProject.getState().scratch) onScreen('Reverb builds', scale, 'verb-amount')
  }
  try {
    localStorage.setItem(k(VERB_KEY), JSON.stringify(verb))
  } catch {
    // not remembered
  }
  if (patch.amount === undefined) invalidate()
}

/** Options changed: the prefetched generation no longer fits. */
export function invalidate(): void {
  prefetch()
}

export async function loadSamples(): Promise<void> {
  const [samples, templates, references] = await Promise.all([api.querySamples({ sort: 'name' }), api.arrangements(), fetchReferences(),
    loadBass(), loadHits(), loadVocals(), loadMusicLoops()])
  useGenerate.getState().set({ samples, templates, references })
  prefetch()
  void moveShortlist()
}

/** The measured reference tracks (none when the engine can't list them). */
async function fetchReferences(): Promise<ReferenceTrack[]> {
  try {
    return (await api.scanReferences(false)).tracks.filter((t) => t.profile)
  } catch {
    return []
  }
}

/** The reference tracks again (after they were measured): the next tracks follow them. */
export async function loadReferences(): Promise<void> {
  useGenerate.getState().set({ references: await fetchReferences() })
  invalidate()
}

// ---- keeping a track: saved tracks are projects (.drumvault/projects) ----

/** Whether the track on screen is saved (a project file, or kept and about to be). */
export const isKept = (): boolean => !useProject.getState().scratch

/** Keep the track on screen (★ / ⌘S): it's saved now and autosaved from then on. */
export async function keepTrack(): Promise<void> {
  useProject.getState().keep()
  await saveNow()
}

/**
 * The old shortlist's starred generations become saved tracks, once: the file keeps them under
 * "migrated", so nothing is lost and they aren't moved twice.
 */
async function moveShortlist(): Promise<void> {
  try {
    const text = await api.readShortlist()
    const items = text ? (JSON.parse(text) as unknown) : null
    if (!Array.isArray(items) || !items.length) return
    for (const item of items as ShortlistItem[]) {
      const name = await nextGeneratedName()
      const project = { ...item.g.project, name, createdAt: item.savedAt, generation: metaOf(item.g) }
      await api.writeProject(null, name, serializeProject(project))
    }
    await api.writeShortlist(JSON.stringify({ migrated: items }))
    await refreshProjectList()
    useApp.getState().toast('info', `${items.length} starred track${items.length === 1 ? '' : 's'} moved to Saved.`)
  } catch (e) {
    useApp.getState().toast('error', `Could not move the starred tracks to Saved: ${(e as Error).message}`)
  }
}

// ---- the history: cycling through tracks ----

/** Section index the playhead is in (to keep listening to the same part). */
function sectionAtPlayhead(g: Generation | null): number {
  if (!g || !playback.playing) return 0
  const bar = playback.position() / 4
  const i = g.sections.findIndex((s) => bar >= s.start && bar < s.start + s.bars)
  return Math.max(0, i)
}

/** The track on screen goes back into the history as it is now (edits, saved file and all). */
function commit(): void {
  const { history, index, detached, set } = useGenerate.getState()
  if (detached || !history[index]) return
  const st = useProject.getState()
  const g = arrangeTrack(st.project)
  if (!g) return
  entries.set(g, { file: st.file, scratch: st.scratch })
  const h = [...history]
  h[index] = g
  set({ history: h })
}

/** Put a track of the history on screen. */
function load(g: Generation): void {
  const e = entryOf(g)
  const project: Project = { ...structuredClone(g.project), generation: metaOf(g) }
  useProject.getState().load(project, e.file, { scratch: e.scratch })
  playback.syncLanes(project.lanes)
  useArrange.getState().fitToTrack()
  if (e.file) void useApp.getState().saveSettings({ lastProject: e.file })
}

/** Track switches one at a time: the one on screen is saved (when kept) before the next loads. */
let switching: Promise<void> = Promise.resolve()
function switchTo(fn: () => Promise<void> | void): Promise<void> {
  switching = switching.catch(() => {}).then(async () => {
    await saveNow()
    commit()
    await fn()
  })
  return switching
}

function show(index: number, from?: number): void {
  void switchTo(() => {
    const was = playback.playing
    const section = sectionAtPlayhead(current())
    const g = useGenerate.getState().history[index]
    if (!g) return
    useGenerate.getState().set({ index, detached: false })
    load(g)
    const start = from ?? (g.sections[Math.min(section, g.sections.length - 1)]?.start ?? 0) * 4
    if (was || from != null) void playback.play(start)
    else playback.setPosition(0)
  })
}

/** → : the next track of the history, or a new one at its end. */
export function forward(): void {
  const { history, index, detached } = useGenerate.getState()
  if (!detached && index < history.length - 1) show(index + 1)
  else next()
}

/** A new track (G): the best of CANDIDATES, or exactly the one a typed `seed` makes. */
export function next(seed?: number): void {
  void switchTo(() => {
    const { pending, history: h } = useGenerate.getState()
    const was = playback.playing
    const section = sectionAtPlayhead(current())
    const g = seed == null && pending ? pending : make(seed)
    if (!g) return
    entries.set(g, { file: null, scratch: true })
    useGenerate.getState().set({ history: [...h, g], index: h.length, pending: null, detached: false })
    load(g)
    const start = was ? (g.sections[Math.min(section, g.sections.length - 1)]?.start ?? 0) * 4 : 0
    void playback.play(start)
    prefetch()
  })
}

export function previous(): void {
  const { index, detached, history } = useGenerate.getState()
  if (detached && history[index]) show(index)
  else if (index > 0) show(index - 1)
}

/** Play from a section (1–9): the track's sections, or the markers of one built by hand. */
export function playSection(i: number): void {
  const g = current()
  const starts = g ? g.sections.map((s) => s.start * 4) : [...useProject.getState().project.markers].sort((a, b) => a.start - b.start).map((m) => m.start)
  if (starts[i] != null) void playback.play(starts[i])
}

/** Open a saved track (the Saved menu): it joins the history. */
export function openTrack(file: string): Promise<void> {
  return switchTo(() => openProject(file))
}

/** An empty track to build by hand. */
export function newEmptyTrack(): Promise<void> {
  return switchTo(() => createProject())
}

// ---- genres: each its own settings and tracks ----

/** The tracks of the genres not loaded (← and → go through the loaded genre's only). */
const otherTracks = new Map<Genre, { history: Generation[]; index: number }>()

/**
 * Load genre `g`'s settings and tracks, the loaded genre's put aside (they come back with it).
 * False when `g` is loaded already. The library lists follow the app's genre setting.
 */
function applyGenre(g: Genre): boolean {
  if (g === storeGenre) return false
  const { history, index, set } = useGenerate.getState()
  otherTracks.set(storeGenre, { history, index })
  storeGenre = g
  const back = otherTracks.get(g)
  set({ settings: savedSettings(), history: back?.history ?? [], index: back?.index ?? -1, pending: null, detached: true,
        lanes: { mute: [], solo: [] } })
  return true
}

// The app's genre setting loaded or changed: its settings and tracks.
useApp.subscribe((s) => {
  applyGenre(s.settings?.genre ?? DEFAULT_GENRE)
})

/** Make `g` the active genre: its settings and tracks, its library. */
async function adoptGenre(g: Genre): Promise<void> {
  if (g === storeGenre) return
  applyGenre(g)
  await useApp.getState().saveSettings({ genre: g })
  await loadSamples()
}

/** Create's genre menu: the genre's settings, library and tracks (its last one on screen, else a new empty track). */
export function switchGenre(g: Genre): Promise<void> {
  return switchTo(async () => {
    if (g === storeGenre) return
    playback.stop()
    await adoptGenre(g)
    const { history, index, set } = useGenerate.getState()
    if (history[index]) {
      set({ detached: false })
      load(history[index])
    } else {
      await createProject()
    }
  })
}

/** Delete the track on screen (its file when saved), and show the one before it. */
export function deleteTrack(): Promise<void> {
  switching = switching.catch(() => {}).then(async () => {
    const { history, index, detached, set } = useGenerate.getState()
    const h = detached ? history : history.filter((_, i) => i !== index)
    const at = Math.min(index, h.length - 1)
    set({ history: h, index: at, detached: true })
    await deleteCurrentProject(h[at] ? () => {
      set({ index: at, detached: false })
      load(h[at])
    } : undefined)
  })
  return switching
}

// A saved track opened (at start, from the Saved menu): a generated one joins the history.
onProjects({
  // A track of another genre opened (the last one at start): its genre becomes the active one.
  genre: adoptGenre,
  opened(file) {
    const project = useProject.getState().project
    const g = arrangeTrack(project)
    const { history, set } = useGenerate.getState()
    useArrange.getState().fitToTrack()
    if (!g) {
      set({ detached: true })
      return
    }
    entries.set(g, { file, scratch: useProject.getState().scratch })
    const at = file ? history.findIndex((x) => entryOf(x).file === file) : -1
    if (at >= 0) {
      const h = [...history]
      h[at] = g
      set({ history: h, index: at, detached: false })
    } else {
      set({ history: [...history, g], index: history.length, detached: false })
    }
  },
})
