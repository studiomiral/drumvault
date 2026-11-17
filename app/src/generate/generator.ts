// The generator (SCOPE.md §6.6): builds a complete drum arrangement from the library.
//
// generate(samples, options, seed, keep) is pure: it picks a structure (a real track's, changed
// a little: template.ts, or one from the grammar: structure.ts), a key for tonal FX, one main
// sample per lane (spread over different zips, matching the feel of the main loop), per-track
// style choices (kick drop-outs, clap rolls, FX density, loop variations, …), then writes every
// lane bar by bar, makes sure something changes every 8 bars, and turns that into ordinary
// Arrange clips. The same seed + library + options + keep gives the same arrangement.

import { expandCompatible } from '../lib/camelot'
import { BEATS_PER_BAR, makeLane, makeMarker, newProject, replaceSample, sampleRef, STEPS_PER_BAR, uid } from '../lib/project'
import type { Category, ReferenceTrack, SampleKind } from '../types/engine'
import { bassPath, stringsRenderPrefix } from '../audio/schedule'
import type { HitItem, MidiItem, SampleListItem, SavedStabRhythm, SerumPreset, TrackArrangement } from '../types/api'
import type { AudioClip, BassRender, Clip, ClipFilter, ClipReverb, PatternClip, Project, StepGroove, Velocity } from '../types/project'
import { bassModel, generateBassline, generatedMidi, isGenerated, type BassTurn, type LoopBeats } from './bassline'
import { hitPitch, hitSample } from './disco'
import { BED_CHANCE, BED_DUCK, BED_FADE_BARS, bedItem, bedRender, bedSample, bedShift } from './ambience'
import { STRINGS_BREAK_RISE_DB, STRINGS_CHANCE, STRINGS_FADE_IN_BARS, STRINGS_FADE_OUT_BARS, stringsItem, stringsRender, stringsSample, stringsShift } from './strings'
import { takeAbout } from '../vocals/plan'
import { chopPitch, loopFits, phraseRender, phraseSample, vocalItem, type VocalTake } from './vocals'
import { accented, bassSteps, closestGap, focusWeight, loopJobs, loopParts, perBarFor, rollBar, sparse, stabParts, stabRhythm, stabWeight, turned, type StabBass, type StabJob, type StabLayout, type StabRoll, type StabTurn, type StabTurns } from './stabs'
import { BASS_HP_MIN_HZ, MIX_HP_FROM_HZ, MIX_HP_TO_HZ, rideSources, ridePieces, sectionBars, type RidePart } from './rides'
import { audible, feelFit, grooveFor, hasFeel, stepGroove } from './feel'
import { Rng } from './rng'
import { barsFor, BUILD_LABEL, halfwayBars, KICK_MODE_LABEL, makeStructure, PHRASE, type Section } from './structure'
import { mainBuildOf, mainBuilds, readReference, templateFrom, templateFromReference, vocalAtWeights, type Arc, type Template } from './template'
import { checkMix, kickBass, REGIONS, type MixCheck } from './mix'
import {
  breakShape, CHARACTER_LABEL, characterRules, CHARACTERS, isReese, LEAD_DB, LEAD_LABEL, leadRules, PAD_BARS, PAD_CHANCE, padNotes, pickLead,
  type Character, type Lead,
} from './character'
import { balanceFrom, dropRanges, evenClips, laneHitDb, levelLanes, punchRefs, STAB_UNDER_KICK_DB, type Balance } from './balance'
import { bassy, filterLoss, eqLanes } from './eq'
import { busLanes, compLanes } from './comp'
import { GATE_FAMILIES, GATE_LABEL, gatedPhrases, introGate, type GateFamily } from './gate'
import { FILL_WORDS, varyFills } from './fills'
import { interlockFit, paletteFit, paletteFor, paletteRefs, type Palette } from './palette'
import type { Score } from './score'

export type Role = 'kick' | 'clap' | 'clap2' | 'clap3' | 'buildup' | 'hats' | 'hats2' | 'ride' | 'perc' | 'perc2'
  | 'top' | 'top2' | 'top3' | 'top4' | 'groove' | 'bass' | 'fills' | 'fx' | 'fx2' | 'fx3' | 'crash' | 'hits' | 'atmos'
  | 'disco' | 'disco2' | 'stab' | 'stab2' | 'stab3' | 'strings' | 'pad' | 'bed' | 'vocal' | 'vchop'

/** Volume per lane (dB on top of the balanced mix), set with the Generate view's lane sliders. */
export type Mix = Partial<Record<Role, number>>

/**
 * Lanes of a generated project, in order. Layers of the same kind (up to three claps, four top
 * loops, …) get their own lane, each a little quieter (`startDb`: the step between them). The mix
 * balance (balance.ts) levels each lane; `startDb` is also the level of a lane whose samples
 * aren't measured yet (the starting mix from before the balance). The sliders start at 0 dB.
 */
export const LANES: { role: Role; name: string; startDb: number; color: string }[] = [
  { role: 'kick', name: 'Kick', startDb: -2, color: '#e2c35f' },
  { role: 'clap', name: 'Clap', startDb: -3, color: '#f472b6' },
  { role: 'clap2', name: 'Clap 2', startDb: -7, color: '#f9a8d4' },
  { role: 'clap3', name: 'Clap 3', startDb: -9, color: '#fbcfe8' },
  { role: 'buildup', name: 'Build-up', startDb: -5, color: '#fb7185' },
  { role: 'hats', name: 'Hats', startDb: -6, color: '#22d3ee' },
  { role: 'hats2', name: 'Hats 2', startDb: -9, color: '#67e8f9' },
  { role: 'ride', name: 'Ride', startDb: -9, color: '#5eead4' },
  { role: 'perc', name: 'Perc', startDb: -7, color: '#4ee3a6' },
  { role: 'perc2', name: 'Perc 2', startDb: -9, color: '#86efac' },
  { role: 'top', name: 'Tops', startDb: -6, color: '#60a5fa' },
  { role: 'top2', name: 'Tops 2', startDb: -8, color: '#7dd3fc' },
  { role: 'top3', name: 'Tops 3', startDb: -9, color: '#93c5fd' },
  { role: 'top4', name: 'Tops 4', startDb: -10, color: '#a5b4fc' },
  { role: 'groove', name: 'Groove', startDb: -8, color: '#a3e635' },
  { role: 'bass', name: 'Bass', startDb: -4, color: '#fda4af' },
  { role: 'stab', name: 'Stab', startDb: -7, color: '#fcd34d' },
  { role: 'stab2', name: 'Stab 2', startDb: -7, color: '#fde68a' },
  { role: 'stab3', name: 'Stab 3', startDb: -7, color: '#fef3c7' },
  { role: 'strings', name: 'Strings', startDb: -12, color: '#99f6e4' },
  { role: 'pad', name: 'Pad', startDb: -10, color: '#c4b5fd' },
  { role: 'bed', name: 'Ambience', startDb: -24, color: '#cbd5e1' },
  { role: 'vocal', name: 'Vocal', startDb: -3, color: '#f9a8d4' },
  { role: 'vchop', name: 'Vocal Chops', startDb: -6, color: '#fbcfe8' },
  { role: 'disco', name: 'Disco Hit', startDb: -6, color: '#f0abfc' },
  { role: 'disco2', name: 'Disco Hit 2', startDb: -7, color: '#f5d0fe' },
  { role: 'fills', name: 'Fills', startDb: -5, color: '#fb923c' },
  { role: 'fx', name: 'FX', startDb: -9, color: '#a78bfa' },
  { role: 'fx2', name: 'FX 2', startDb: -11, color: '#c4b5fd' },
  { role: 'fx3', name: 'FX 3', startDb: -12, color: '#ddd6fe' },
  { role: 'crash', name: 'Crash', startDb: -8, color: '#fef08a' },
  { role: 'hits', name: 'Hits', startDb: -6, color: '#fde68a' },
  { role: 'atmos', name: 'Atmos', startDb: -11, color: '#94a3b8' },
]
/** Lanes that keep playing in the beat or two of silence before a drop. */
const THROUGH_SILENCE = new Set<Role>(['fills', 'fx', 'fx2', 'fx3', 'hits', 'bed'])
/** What rings through a track's gap before drops (rule `dropIn` 'gap'): the drum fill alone (and the bed under the track). */
const GAP_THROUGH = new Set<Role>(['fills', 'hits', 'bed'])
/** The Strings lane's sidechain depth when Generate doesn't set one. */
const STRINGS_SIDECHAIN = 0.6
/** The rules the Strings lane owns, kept with kept strings. */
export const STRINGS_RULES = ['stringsAt'] as const

export function laneRole(laneName: string): Role | undefined {
  return LANES.find((x) => x.name === laneName)?.role
}
const TOP_ROLES: Role[] = ['top', 'top2', 'top3', 'top4']
const CLAP_ROLES: Role[] = ['clap', 'clap2', 'clap3']
/** What an intro's lift brings in (and an outro's lets go). */
type LiftRole = 'hats' | 'perc' | 'top2' | 'clap'
/** Bars an intro (or outro) of `bars` fills up over (thins out over): 8, or 16 from 32 bars. */
export const liftBars = (bars: number) => (bars >= 32 ? 16 : 8)
/** The chord stab lanes (SCOPE.md §6.9): one to three samples taking turns in the track's stab rhythm. */
export const STAB_ROLES: Role[] = ['stab', 'stab2', 'stab3']
/** What stops with the tops in a full breath before drops. */
const BREATH_DRUMS: Role[] = [...CLAP_ROLES, 'hats', 'hats2', 'perc', 'perc2', 'bass']
/** A bass build's high-pass ends here: the sub coming in towards the drop. */
const BASS_SWEEP_TO_HZ = 40

/**
 * The build-ups into drops (SCOPE.md §6.6), programmed on their own lane over the last bars
 * before each drop: a snare roll in 16ths opening from low-passed and thinning out at the end,
 * a snare in quarters, 8ths, then 16ths, a low-passed kick in 8ths (the kick lane out there), or
 * claps on every beat (the clap lane out there). Each gets louder towards the drop.
 */
export const BUILDUPS = ['snareRoll', 'snareSteps', 'kickRoll', 'claps'] as const
export type Buildup = typeof BUILDUPS[number] | 'none'
/** The way into every drop (rule `dropIn`): straight in, a gap with the drum fill alone in it, a gap with only the FX pulling in. */
export type DropIn = 'straight' | 'gap' | 'suck'
export type BigDrums = 'both' | 'claps' | 'snare'
export type BigKick = 'out' | 'back' | 'roll'
/** What the big build sends to reverb (and the drums to delay): the build's drums, the stabs, the top loops, all of them (the vocals too). */
export type BigVerb = 'drums' | 'stabs' | 'drums+stabs' | 'drums+tops' | 'all'
/** The big build's drums: dB they start at (rising to 0 at the drop), where their low-pass opens from. */
const BIG_CLAPS_FROM_DB = -9
const BIG_SNARE_FROM_DB = -12
const BIG_KICK_FROM_DB = -6
const BIG_CLAP_LP_FROM_HZ = 1500
const BIG_OPEN_HZ = 18000
/** The big build's reverb send where it peaks (on the drop's line), and its delay throws (the last bar of each 4; the build's last). */
const BIG_VERB_PEAK = 0.85
const BIG_ECHO = 0.3
const BIG_ECHO_LAST = 0.5
/** Crashes into a big build's drop: per bar before it, how often (16ths apart) and how loud (dB). */
const BIG_CRASH_FASTER: [number, number][] = [[16, -9], [8, -6], [4, -3], [2, 0]]
/** A sweep this noisy (the event's measured share of noise) is pitchless: any key will do (a riser stays in the key). */
const BIG_NOISE = 0.5
/** The snare roll's low-pass opens from … to … Hz, then a high-pass rises from … to … Hz over its last quarter. */
const ROLL_LP_FROM_HZ = 350
const ROLL_LP_TO_HZ = 16000
const ROLL_HP_FROM_HZ = 60
const ROLL_HP_TO_HZ = 1800
/** The kick roll's low-pass opens from … to … Hz. */
const KICK_ROLL_LP_FROM_HZ = 160
const KICK_ROLL_LP_TO_HZ = 2400
/** dB each build-up starts at, rising evenly to 0 on the drop. */
const BUILDUP_FROM_DB: Record<typeof BUILDUPS[number], number> = { snareRoll: -15, snareSteps: -9, kickRoll: -6, claps: -4 }
/** Crashes coming faster into drops: per bar before it, how often (16ths apart) and how loud (dB). */
const CRASH_FASTER: [number, number][] = [[8, -6], [4, -3], [2, 0]]
const BUILDUP_NOTE: Record<typeof BUILDUPS[number], string> = {
  snareRoll: 'snare roll opening up', snareSteps: 'snare in 4ths, 8ths, 16ths', kickRoll: 'low-passed kick roll', claps: 'claps on every beat',
}
/**
 * Rules newer than some saved generations: a track made before them is remade without them
 * (no build-up appears on a lane made again).
 */
const LATER_RULES: Rules = { bedIn: false, character: null, lead: null, padIn: false, stabFit: false, glue: false, buildup: 'none', buildupBars: 4, buildupCrash: 'none', ioLift: false, firstDrop: 'full', stringsIn: false, vocalIn: false, stabCount: 1, stabTurns: 'hits', stabLoop: false, bassTurn: 'none', dropIn: null, bigBuild: 'usual' }
const rulesOf = (g: Generation): Rules => ({ ...LATER_RULES, ...g.rules })

/** A lane's step in the starting mix (see LANES). */
const startingDb = (role: Role) => LANES.find((l) => l.role === role)?.startDb ?? 0

/**
 * Every generated lane of `project` (or `only` these) brought to its place in the balance
 * (balance.ts): the producers' in the user's tracks, else the house defaults; and its EQ (eq.ts).
 */
function balanceLanes(project: Project, all: SampleListItem[], opts: GenerateOptions, sections: Section[], only?: Set<string>, lead?: Lead | null):
    Balance & { measured: number; evened: number; mix: MixCheck | null } {
  const hits = [...opts.disco?.hits ?? [], ...opts.stabs?.hits ?? []].map(hitSample)
  const byPath = new Map([...all, ...hits].map((s) => [s.rel_path, s]))
  const balance = balanceFrom(opts.templates ?? [])
  const drops = dropRanges(sections)
  // How hard each kind of one-shot usually hits in the library: a snappier one counts louder.
  const punch = punchRefs(all)
  // A lane's samples evened out first, then the lane brought to its place, then its EQ and compressor.
  const evened = evenClips(project, byPath, drops, laneRole, only, punch)
  const measured = levelLanes(project, byPath, balance, drops, laneRole, startingDb, only, punch)
  eqLanes(project, byPath, opts.templates ?? [], drops, laneRole, only)
  compLanes(project, byPath, drops, laneRole, only)
  // The whole mix against the user's tracks (a whole track only: one lane made again keeps the rest's levels).
  const mix = only ? null : checkMix(project, byPath, opts.templates ?? [], drops, laneRole, punch)
  // The mix check may have moved the clap: the stabs and the moments (fills, …) go by its hits, so they follow.
  if (mix?.moves.length) levelLanes(project, byPath, balance, drops, laneRole, startingDb, undefined, punch, true)
  // The track's lead sits a little over where the balance puts it (a stab's hits still never near the kick's).
  if (lead && measured) {
    const kickLane = project.lanes.find((l) => l.name === 'Kick')
    const kick = kickLane ? laneHitDb(project, byPath, kickLane.id) : null
    for (const l of project.lanes) {
      const role = laneRole(l.name)
      const mine = lead === 'stab' ? STAB_ROLES.includes(role!) : role === lead
      if (!mine || l.levelDb == null || (only && !only.has(l.id))) continue
      const hit = lead === 'stab' ? laneHitDb(project, byPath, l.id) : null
      l.levelDb = hit != null && kick != null
        ? Math.min(l.levelDb + LEAD_DB[lead], Math.max(l.levelDb, l.levelDb + kick - STAB_UNDER_KICK_DB - hit))
        : l.levelDb + LEAD_DB[lead]
    }
  }
  // The drum bus last: its threshold goes from the drums' levels as they now stand.
  busLanes(project, byPath, drops, laneRole)
  return { ...balance, measured, evened, mix }
}

/** Lane volumes = the Generate view's sliders (dB per lane, 0 by default). */
export function applyMix(project: Project, mix: Mix): void {
  for (const lane of project.lanes) {
    const l = LANES.find((x) => x.name === lane.name)
    if (l) lane.volumeDb = mix[l.role] ?? 0
  }
}

/**
 * One groove (SCOPE.md §6.6): how the drums carry through breakdowns. What stays closes over
 * GLUE_CLOSE_BARS after the line; hats are thinned (high-passed) instead of darkened; a low-pass
 * (a high-pass) counts as open at GLUE_LP_OPEN_HZ (GLUE_HP_OPEN_HZ); nothing gets darker than
 * GLUE_MIN_HZ. Every later breakdown is GLUE_DEEPER times as dark and GLUE_DEEPER_DB lower. What
 * leaves closes to GLUE_LEAVE_HZ over the GLUE_BEFORE_BARS before the line and fades GLUE_FADE_DB
 * down after it. The long breakdown is bare (the thread alone) when its middle is at least
 * GLUE_BARE_MIN_BARS. At most GLUE_RETURNERS loops open up into the next part.
 */
const GLUE_CLOSE_BARS = 4
const GLUE_THIN_HZ = 900
const GLUE_LP_OPEN_HZ = 18000
const GLUE_HP_OPEN_HZ = 30
const GLUE_MIN_HZ = 250
const GLUE_DEEPER = 0.7
const GLUE_DEEPER_DB = 1.5
const GLUE_LEAVE_HZ = 6000
const GLUE_BEFORE_BARS = 2
const GLUE_FADE_DB = 16
const GLUE_BARE_MIN_BARS = 12
const GLUE_RETURNERS = 4
/** A percussion lead plays through breakdowns this much under its drop level (dB), unfiltered. */
const LEAD_BREAK_DB = -2
/** What stays sits this much further under its drop loudness than the track's `glueDb`, its filter's loss made up for (within these). */
const GLUE_UNDER_DB = 4
const GLUE_MAX_MAKEUP_DB = 6
const GLUE_MAX_CUT_DB = 12
/** The kick's and the bass's low end (the kick roll's and the impacts' too) is mono below this (Hz). */
const MONO_BELOW_HZ = 120
const MONO_ROLES = new Set<Role>(['kick', 'bass', 'buildup', 'hits'])
/** The loops that leave after the line, the first staying longest; and those that come back, the first earliest. */
const GLUE_LEAVE_ORDER: Role[] = ['top', 'hats', 'perc', 'top2', 'groove', 'hats2', 'perc2', 'top3', 'top4', 'ride']
const GLUE_RETURN_ORDER: Role[] = ['hats', 'perc', 'top', 'top2', 'groove', 'hats2', 'perc2', 'top3']

/** The engine's tone bands per octave (24 bands from 40 Hz to 16 kHz). */
const TONE_BANDS_PER_OCTAVE = 24 / Math.log2(16000 / 40)

/** The tone of several sounds together (each as its share of power per band); null when none is measured. */
function meanTone(tones: (number[] | null | undefined)[]): number[] | null {
  const xs = tones.filter((t): t is number[] => !!t && t.length === 24)
  if (!xs.length) return null
  const acc = new Array(24).fill(0)
  for (const t of xs) {
    const p = t.map((v) => 10 ** (v / 10))
    const total = p.reduce((a, b) => a + b, 0)
    if (total > 0) p.forEach((v, i) => { acc[i] += v / total / xs.length })
  }
  return acc.map((v) => 10 * Math.log10(Math.max(v, 1e-9)))
}

/**
 * Stabs that fit (SCOPE.md §6.9). They sit in a room by `STAB_ROOM` and duck under the kick by
 * `STAB_DUCK` over `STAB_DUCK_BEATS`; a hit is gated to `STAB_GATE_SHARE` of the gap to the next
 * stab (never under `STAB_GATE_MIN_BEATS`); a delay throw sends `STAB_ECHO`. A filter opening runs
 * from the track's `stabsCutoff` to `STAB_OPEN_HZ`. In breakdowns what stays is `STAB_BREAK_DB`
 * down; what leaves fades by `STAB_FADE_DB` a bar. A tease sits `STAB_TEASE_DB` down, and only in
 * an intro of `STAB_TEASE_MIN_INTRO` bars or more (16 bars of it stay clean for the DJ). Two stabs
 * sit `STAB_PAN` apart either side; of three, the first stays in the middle.
 */
const STAB_ROOM = 0.18
const STAB_DUCK = 0.25
const STAB_DUCK_BEATS = 0.4
const STAB_GATE_SHARE = 0.92
const STAB_GATE_MIN_BEATS = 0.25
const STAB_ECHO = 0.5
const STAB_OPEN_HZ = 16000
const STAB_BREAK_DB = -3
const STAB_FADE_DB = -5
const STAB_TEASE_DB = -4
const STAB_TEASE_MIN_INTRO = 24
const STAB_TEASE_BARS = 8
const STAB_PAN = 0.25
/**
 * One stab loop (rule `stabLoop`, SCOPE.md §6.9): the stabs duck `STAB_LOOP_DUCK` under the kick;
 * a layer sits `STAB_LAYER_DB` under the main sound; each job has its place (`STAB_JOB_PAN`).
 * Before a drop they announce it: from `STAB_ANNOUNCE_FROM` of the track's cutoff (never under
 * `STAB_ANNOUNCE_MIN_HZ`) opening to `STAB_ANNOUNCE_HZ`, the resonance rising over `STAB_ANNOUNCE_Q`
 * (dB, as Web Audio takes it), the room up to `STAB_ANNOUNCE_ROOM`, the delay over
 * `STAB_ANNOUNCE_ECHO`, `STAB_ANNOUNCE_DB` down at first; the last bar dry from step
 * `STAB_DRY_FROM` on, thrown `STAB_THROW` to the delay.
 */
const STAB_LOOP_DUCK = 0.1
const STAB_LAYER_DB = -4
const STAB_JOB_PAN: Record<StabJob, number> = { main: 0, layer: 0.15, pickups: -0.25 }
const STAB_ANNOUNCE_FROM = 0.6
const STAB_ANNOUNCE_MIN_HZ = 350
const STAB_ANNOUNCE_HZ = 7000
const STAB_ANNOUNCE_Q: [number, number] = [0.8, 7]
const STAB_ANNOUNCE_ROOM = 0.4
const STAB_ANNOUNCE_ECHO: [number, number] = [0.12, 0.5]
const STAB_ANNOUNCE_DB = -4
const STAB_DRY_FROM = 12
const STAB_THROW = 0.9
/** How often a loop has a moved hit (rule `stabMove`). */
const STAB_MOVE_CHANCE = 0.4

/**
 * The patches a track's bass is drawn from (SCOPE.md §6.7a): when the pool has Serum patches and
 * bass samples both, one kind or the other with even chances (however many there are of each),
 * decided by the seed alone (the track's own random stream is left as it is).
 */
function bassPool(presets: SerumPreset[], seed: number): SerumPreset[] {
  const samples = presets.filter((p) => p.sample)
  const serum = presets.filter((p) => !p.sample)
  if (!samples.length || !serum.length) return presets
  return new Rng(seed ^ 0x42535350).chance(0.5) ? samples : serum
}

/** Whether a structure has one drop only. */
const drops1 = (sections: Section[]) => sections.filter((s) => s.kind === 'drop').length === 1

/**
 * The breakdown layer (SCOPE.md §6.7b): a pad's filter opens to `PAD_OPEN_HZ`, a reese's to
 * `PAD_REESE_OPEN_HZ` (it starts an octave lower); the layer swells in over `PAD_FADE_BARS` and
 * rises `PAD_RISE_DB` into the next part.
 */
const PAD_OPEN_HZ = 7000
const PAD_REESE_OPEN_HZ = 1800
const PAD_FADE_BARS = 2
const PAD_RISE_DB = 8

/** Lanes whose main sample can be kept while cycling. */
export const KEEPABLE: Role[] = ['kick', 'clap', 'hats', 'perc', 'top', 'groove']

export interface GenerateOptions {
  bpm: number
  minMinutes: number
  maxMinutes: number
  /** Only samples from these zips; null = all. */
  zipIds: number[] | null
  /** Favourites and ratings make samples more likely. */
  useRatings: boolean
  /** Volume per lane in dB, on top of the balanced mix. */
  mix?: Mix
  /** Bass (SCOPE.md §6.7): imported basslines and the Serum patch pool; null or empty = no bass. */
  bass?: BassOptions | null
  /** Reverb builds on top loops; null or left out = none. */
  verb?: VerbOptions | null
  /** Disco hits (SCOPE.md §6.8) a track may drop at key moments; null or empty = none. */
  disco?: { hits: HitItem[] } | null
  /**
   * Chord stabs (SCOPE.md §6.9) every track plays: the Chord Stabs page's samples, moved into the
   * track key; null or empty = none.
   */
  stabs?: {
    hits: HitItem[]
    /** Rhythms saved in the step sequencer: they replace the built-in ones (some tracks take one as it is, the rest learn from them). */
    rhythms?: SavedStabRhythm[]
  } | null
  /**
   * Strings (SCOPE.md §6.10) some tracks play under them: the Strings page's samples, and the
   * Strings lane's sidechain depth; null or empty = none.
   */
  strings?: { hits: HitItem[]; sidechain?: number } | null
  /**
   * The breakdown layer (SCOPE.md §6.7b): Serum 2 patches for pads (a chord) and reeses (one low
   * note), from the Pads module's folders; null or empty = none.
   */
  pads?: { presets: SerumPreset[] } | null
  /** The ambience bed (SCOPE.md §6.10a): the Ambience page's textures; null or empty = none. */
  ambience?: { hits: HitItem[] } | null
  /**
   * Vocals (SCOPE.md §6.11): the Vocals page's analysed takes, one sung in every track (one not
   * used in an export yet while there are some); null or empty = none.
   */
  /**
   * Vocals: the take made for this track (it sings it), or the Vocal Loops module's Splice loops
   * (`pool`: a track sings one that fits its key and tempo, `chance` of the time).
   */
  vocals?: { takes: VocalTake[]; pool?: { chance: number } } | null
  /**
   * Choices locked in Generate (choices.ts): these rules, whatever the track would draw or the
   * real track it's built on does. Applied last, also when a lane is made again.
   */
  locks?: Rules | null
  /**
   * Project tempo: a whole BPM from this range per track (min = max for a fixed one); null or
   * left out = the library BPM (`bpm`). Loops are sliced and FX stretched to it in playback.
   */
  tempo?: { min: number; max: number } | null
  /**
   * Real tracks' arrangements (the library's processed zips): most generations take one as a
   * template for their structure and rules, changed a little. None: the grammar only.
   */
  templates?: TrackArrangement[] | null
  /**
   * Reference tracks (finished mixes, SCOPE.md §5.17): their structures are templates beside the
   * zips' (an even share), and their arc (drop lift, break depth) is what candidates are scored on.
   */
  references?: ReferenceTrack[] | null
}

/** Share of generations built on a real track's structure when there are templates. */
const TEMPLATE_CHANCE = 0.8
/** With both, the share of templates taken from the reference tracks (the rest from the zips). */
const REFERENCE_SHARE = 0.5

/** A structure template: from a zip's arrangement or a reference track, an even share when there are both. */
function pickTemplate(rng: Rng, arrangements: TrackArrangement[], refs: ReferenceTrack[], minBars: number, maxBars: number): Template | null {
  const fromRef = refs.length > 0 && (!arrangements.length || rng.chance(REFERENCE_SHARE))
  return fromRef ? templateFromReference(rng.pick(refs), rng, minBars, maxBars)
    : templateFrom(rng.pick(arrangements), rng, minBars, maxBars)
}

/**
 * The arc to aim for: the template reference's own, else the references' median (every candidate
 * of a track then has one, so they are scored alike); null without references.
 */
export function arcOf(refs: ReferenceTrack[] | null | undefined, tpl: Template | null): (Arc & { from: string }) | null {
  if (tpl?.arc && (tpl.arc.liftLu != null || tpl.arc.breakDepthLu != null)) return { ...tpl.arc, from: tpl.label }
  const ps = (refs ?? []).map((r) => r.profile).filter((p): p is NonNullable<typeof p> => !!p)
  const med = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null).sort((a, b) => a - b)
    if (!v.length) return null
    const m = v.length >> 1
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
  }
  const liftLu = med(ps.map((p) => p.lift_lu))
  const breakDepthLu = med(ps.map((p) => p.break_depth_lu))
  return liftLu == null && breakDepthLu == null ? null
    : { liftLu, breakDepthLu, from: ps.length === 1 ? `the reference “${refs!.find((r) => r.profile)!.name}”` : `${ps.length} reference tracks` }
}

export interface BassOptions {
  /** The MIDI library's basslines: what new basslines are learned from (bassline.ts). */
  midis: MidiItem[]
  /** Loop length of new basslines in beats (2, 4, 8); null: as long as the library's really are. */
  beats?: LoopBeats | null
  presets: SerumPreset[]
  /** Starred presets (paths): picked more often. */
  favorites: string[]
  /** Octave per preset (semitones by path), on top of the move into the track key. */
  octaves?: Record<string, number>
  /** Sidechain depth under the kick, 0…1. */
  sidechain: number
}

/**
 * Reverb builds (SCOPE.md §6.6): the loops' reverb send rising into every drop and breakdown
 * (over 2 bars), and if `every` is set also at the end of every 8 or 16 bars (over 1 bar).
 */
export interface VerbOptions {
  tops: boolean
  every: 8 | 16 | null
  /** The send where a build peaks, 0…1. */
  amount: number
}

/** Rides: which lanes take the moves of which part of the reference track, and its name. */
const RIDE_ROLES: [RidePart, Role[], string][] = [
  ['bass', ['bass'], 'bass'], ['top', ['top', 'top2', 'top3', 'top4', 'groove'], 'tops'],
]
/** The mix high-pass into drops leaves the moments alone: risers, fills, impacts, crashes, hits. */
const MIX_HP_ROLES = (r: Role) => !['fills', 'fx', 'fx2', 'fx3', 'hits', 'crash', 'disco', 'disco2', 'bed'].includes(r)

/**
 * Lanes never low-passed while a drop plays (a sudden low-pass on the top loops takes the drop's
 * energy away): the top loops and the groove. Builds and breakdowns filter them as they like.
 */
const NO_DROP_LOWPASS = new Set<Role>([...TOP_ROLES, 'groove'])

/** A seed from a structure's shape (FNV-1a): the same sections, the same rides. */
function structureSeed(sections: Section[]): number {
  let h = 0x811c9dc5
  for (const ch of JSON.stringify(sections.map((s) => [s.kind, s.bars, s.src ?? null]))) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** Bars a reverb build rises over: into drops and breakdowns, and at phrase ends. */
const VERB_INTO_BARS = 2
const VERB_PHRASE_BARS = 1

export interface Keep {
  structure?: Section[]
  key?: string | null
  picks?: Partial<Record<Role, SampleListItem>>
  bassMidi?: MidiItem
  bassPreset?: SerumPreset
  /** The kept bassline's piano-roll edits. */
  bassEdit?: { notes: [number, number, number, number][]; bars: number }
  /** Track rules to keep (a lane re-roll keeps all but that lane's own). */
  rules?: Rules
  /** Samples (paths) not to pick again when there's another. */
  avoid?: string[]
  /**
   * Make the track again as it was made (its `rngAt`), with the kept picks and rules: what
   * doesn't follow from a changed rule comes out the same.
   */
  replay?: number
  /** The arc it is scored against (kept with the structure); undefined: from the template or the references. */
  arc?: Generation['arc']
}

/** The track's rules (see the rules block in generate()), by name. */
export type Rules = Record<string, unknown>

/** The bass of a generation: which bassline through which patch, moved into the track key. */
export interface GenerationBass {
  /** A line written for this track (bassline.ts: generatedMidi), or a file of the MIDI library. */
  midi: MidiItem
  preset: SerumPreset
  /** Semitones to the track key. */
  transpose: number
  /** Edited in the piano roll (this track only): notes at the MIDI's pitch, and the loop length. */
  notes?: [number, number, number, number][]
  bars?: number
  /** The track's feel (16 step offsets), so the bass sits with the loops. */
  groove?: number[]
}

/** What the bass clips render for a generation's bass. */
export function bassRenderOf(b: GenerationBass): BassRender {
  return {
    role: 'bass', keyLabel: b.midi.key_label,
    preset: b.preset.path, presetName: b.preset.name, midiId: b.midi.id, midiName: b.midi.name, transpose: b.transpose,
    // A generated line has no file: its notes always go along.
    ...(b.notes || isGenerated(b.midi) ? { notes: b.notes ?? b.midi.notes, bars: b.bars ?? b.midi.bars } : {}),
    ...(b.groove ? { groove: b.groove } : {}),
  }
}

/**
 * What a bass clip renders for a generation's bass, keeping the clip's own turn (a phrase-end
 * clip stays one when the line, the patch or the key changes).
 */
export function bassClipRender(b: GenerationBass, old?: BassRender): BassRender {
  const r = bassRenderOf(b)
  return old?.turn ? { ...r, turn: old.turn } : r
}

/** Loop length of a generation's bass in bars (edited or the file's). */
export const bassBars = (b: GenerationBass) => b.bars ?? b.midi.bars

export interface Generation {
  seed: number
  /** The RNG's state once structure and key were chosen (a replay goes on from there). */
  rngAt?: number
  project: Project
  sections: Section[]
  key: string | null
  /** Human-readable choices: structure, build styles, kick treatments, pattern variations. */
  choices: string[]
  /** Source codes of the zips the samples come from. */
  zips: string[]
  /** The main sample per lane (for "keep"). */
  picks: Partial<Record<Role, SampleListItem>>
  bass: GenerationBass | null
  rules: Rules
  /** Source code of the real track whose structure this one follows, if any. */
  template?: string | null
  /** The drop's tone against the user's tracks, and what was moved for it (mix.ts); null or absent: not checked. */
  mix?: MixCheck | null
  /** How it scored, and how many candidates it was the best of (score.ts); absent: made as it came. */
  score?: Score | null
  /** The arc it was scored against (a reference's, or the references' median); null or absent: none. */
  arc?: (Arc & { from: string }) | null
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

type Steps = Velocity[]

function steps(hits: number[], v: Velocity = 3): Steps {
  const out: Steps = new Array(STEPS_PER_BAR).fill(0)
  for (const h of hits) out[h] = v
  return out
}

const FOUR = [0, 4, 8, 12]
const TWO_FOUR = [4, 12]
const OFFBEAT = [2, 6, 10, 14]
/** How many tracks gate their intro's top loops. */
const INTRO_GATE_CHANCE = 0.7
/** What doesn't keep the kick company in an intro or outro: the kick with only these is the kick alone. */
const NOT_ALONGSIDE = new Set<Role>(['kick', 'crash', 'fx', 'fx2', 'fx3', 'hits', 'atmos', 'bed'])
const EIGHTHS = [0, 2, 4, 6, 8, 10, 12, 14]
const SIXTEENTHS = Array.from({ length: STEPS_PER_BAR }, (_, i) => i)

/** Pitches (semitones) for a loop layer played a little higher or lower. */
const PITCHES: [number, number][] = [[-1, 3], [1, 2], [-2, 2], [2, 1]]

/** Kick variations at the end of a phrase ("leave a kick out at the end of 8 bars"). */
const KICK_PHRASE_ENDS: [Steps, number][] = [
  [steps([0, 4, 8]), 4],              // last kick out
  [steps([0, 4]), 2],                 // last two out
  [steps([0, 4, 8, 14]), 1.5],        // last kick pushed to the 16th before the one
  [[3, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 3, 0, 2, 3], 1],  // a little kick roll into the one
]

// ---------------------------------------------------------------------------
// Sample pools and picks
// ---------------------------------------------------------------------------

const of = (kind: SampleKind, ...cats: Category[]) => (s: SampleListItem) => s.kind === kind && cats.includes(s.category)
const TONAL: Category[] = ['fx_riser', 'fx_downlifter', 'fx']

const PITCH: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
}

/**
 * Semitones that move a part from one key to another, the nearest way (−6…+5). A major part in
 * a minor track (or the other way) goes to the relative key. Mirror of the engine's
 * midi.transpose_to.
 */
export function transposeTo(from: string | null, to: string | null): number {
  const parse = (k: string) => {
    const m = /^([A-G][#b]?)(m?)$/.exec(k.trim())
    return m && PITCH[m[1]] != null ? { pc: PITCH[m[1]], minor: m[2] === 'm' } : null
  }
  const a = from ? parse(from) : null
  const b = to ? parse(to) : null
  if (!a || !b) return 0
  const pf = a.minor === b.minor ? a.pc : (a.pc + (a.minor ? 3 : -3) + 12) % 12  // to the relative key
  const d = (((b.pc - pf) % 12) + 12) % 12
  return d > 5 ? d - 12 : d
}

/** Bars from an event's start to where its main sound ends (tail excluded). */
export function bodyBars(s: SampleListItem): number {
  if (s.body_bars) return s.body_bars
  const bars = s.bars ?? 1
  return bars > 1 ? bars - 1 : bars  // libraries from before body_bars: assume a one-bar tail
}

// ---- transitions: where events stop before the line they lead into (SCOPE.md §6.6) ----

/** An event stopping this many 16ths (or fewer) before the end of its body runs right up to the line. */
const TO_THE_LINE = 1
/** Events of one transition that stop early stop within this many 16ths of each other. */
const GAP_TOLERANCE = 2
/** An event silent for longer than this before its line doesn't lead into it (a hit on the 1, then a rest). */
const MAX_LEAD_GAP = 8
/** The track's silence before a drop: at most this many 16ths, however early its FX stop. */
const MAX_SILENCE = 8

/** 16ths of silence an event leaves before the end of its body: the producer's own pause before the drop. */
export const gapOf = (s: SampleListItem) => s.shape?.gap ?? 0
const leads = (s: SampleListItem) => gapOf(s) <= MAX_LEAD_GAP

/**
 * Whether an event stopping `gap` 16ths early belongs in a transition stopping `t` early: all
 * run up to the line, or all stop early, about together. Never one riser into the drop and
 * another (or the fill) leaving a beat of silence before it.
 */
export function gapsAgree(gap: number, t: number): boolean {
  return t <= TO_THE_LINE ? gap <= TO_THE_LINE : gap > TO_THE_LINE && Math.abs(gap - t) <= GAP_TOLERANCE
}

const SHAPED_FX: Category[] = ['fx_sweep', 'fx']
/** Builds up to its end: a riser, or a sweep / other FX that measures that way. */
const rising = (s: SampleListItem) => s.category === 'fx_riser' || (SHAPED_FX.includes(s.category) && s.shape?.dir === 'rise')
/** Falls away from its start: a downlifter, or a sweep / other FX that measures that way (unmeasured sweeps too). */
const falling = (s: SampleListItem) => s.category === 'fx_downlifter'
  || (SHAPED_FX.includes(s.category) && (s.shape ? s.shape.dir === 'fall' : s.category === 'fx_sweep'))

/**
 * Whether `b` goes with `a` as a second FX layer into the same line, and how well: another
 * length (a long build with a short lift on top), another texture (noise with a tone), or the
 * same track's. Two of a kind from two tracks don't layer (null).
 */
function complements(a: SampleListItem, b: SampleListItem): number | null {
  const la = bodyBars(a), lb = bodyBars(b)
  const lengths = Math.max(la, lb) / Math.min(la, lb)
  const texture = Math.abs((a.shape?.noise ?? 0.3) - (b.shape?.noise ?? 0.3))
  if (lengths < 1.5 && texture < 0.25 && a.zip_id !== b.zip_id) return null
  return (lengths >= 2 ? 3 : lengths >= 1.5 ? 1.5 : 1) * (1 + 3 * texture) * (a.zip_id === b.zip_id ? 1.5 : 1)
}

/** A loop fits the track's feel from here on (feelFit: 1 the same swing). */
const GOOD_FIT = 0.5
/** Of the samples a pick scores (palette, interlock), those within this share of the best stay; weighted by the score to this power. */
const SCORE_KEEP = 0.7
const SCORE_POW = 2

class Picker {
  private used = new Map<number, number>()
  private keys: Set<string> | null

  constructor(private rng: Rng, private ratings: boolean, key: string | null, private avoid = new Set<string>()) {
    this.keys = key ? new Set(expandCompatible([key])) : null
  }

  private weight(s: SampleListItem): number {
    return this.ratings ? 1 + (s.favorite ? 2 : 0) + (s.rating ?? 0) * 0.4 : 1
  }

  /** Not one of the samples to avoid (a lane re-roll's). */
  fresh(s: SampleListItem): boolean {
    return !this.avoid.has(s.rel_path)
  }

  /** Mark a kept sample's zip as used, so other lanes still spread over other zips. */
  use(s: SampleListItem): SampleListItem {
    this.used.set(s.zip_id, (this.used.get(s.zip_id) ?? 0) + 1)
    return s
  }

  /** Take back a pick another (kept) sample stands in for. */
  unuse(s: SampleListItem): void {
    this.used.set(s.zip_id, Math.max(0, (this.used.get(s.zip_id) ?? 0) - 1))
  }

  /**
   * A sample from `cands`: from the least-used zips (so lanes come from different imports),
   * in the track key's neighbourhood for tonal FX, weighted by favourites/ratings.
   */
  pick(cands: SampleListItem[], opts: {
    tonal?: boolean; weight?: (s: SampleListItem) => number; not?: SampleListItem | null
    /** How well a sample fits the track (its feel): good fits come first, before the zip spread. */
    fit?: (s: SampleListItem) => number
    /**
     * How well it sits with what the track has already (its palette, how it interlocks; 0…1): only
     * those near the best are kept, before the zip spread, and weighted by it.
     */
    score?: (s: SampleListItem) => number
  } = {}): SampleListItem | null {
    let c = opts.not ? cands.filter((s) => s.id !== opts.not!.id) : cands
    if (!c.length) c = cands
    if (!c.length) return null
    if (this.avoid.size) {
      const fresh = c.filter((s) => !this.avoid.has(s.rel_path))
      if (fresh.length) c = fresh
    }
    if (opts.tonal && this.keys) {
      const inKey = c.filter((s) => s.key_label && this.keys!.has(s.key_label))
      if (inKey.length) c = inKey
    }
    if (opts.fit) {
      const good = c.filter((s) => opts.fit!(s) >= GOOD_FIT)
      if (good.length) c = good
    }
    const sc = opts.score ? new Map(c.map((s) => [s.id, opts.score!(s)])) : null
    if (sc) {
      const best = Math.max(...sc.values())
      c = c.filter((s) => sc.get(s.id)! >= best * SCORE_KEEP)
    }
    const least = Math.min(...c.map((s) => this.used.get(s.zip_id) ?? 0))
    c = c.filter((s) => (this.used.get(s.zip_id) ?? 0) === least)
    return this.use(this.rng.pickBy(c, (s) => this.weight(s) * (opts.weight?.(s) ?? 1) * (sc ? sc.get(s.id)! ** SCORE_POW : 1)))
  }
}

function chooseKey(rng: Rng, samples: SampleListItem[]): string | null {
  const tonal = samples.filter((s) => s.kind === 'event' && TONAL.includes(s.category) && s.key_label)
  const pool = tonal.length ? tonal : samples.filter((s) => s.key_label)
  return pool.length ? rng.pick(pool).key_label : null
}

// ---------------------------------------------------------------------------
// Lane contents (bar by bar), then clips
// ---------------------------------------------------------------------------

interface BarPattern {
  sample: SampleListItem
  steps: Steps
  filter?: ClipFilter
  /** Semitones (a disco hit moved into the track key). */
  pitch?: number
  /** A volume ride over the bar (a build-up getting louder): dB at its start, and at its end. */
  gainDb?: number
  gainTo?: number
  /** A stab's: each hit at most this long (beats), its send to the lane's room (0…1), its delay throw (0…1). */
  gate?: number
  room?: number
  echo?: number
  /** A reverb build over the bar (the big build's drums): the send at its start and end (0…1). */
  verb?: ClipReverb
  /** Semitones per step on top of `pitch` (a stab loop's moved hit). */
  bend?: number[]
}

interface Segment {
  sample: SampleListItem
  start: number    // beats
  length: number   // beats
  filter?: ClipFilter
  verb?: ClipReverb
  /** A volume ride (dB at the start and the end); no ride when left out. */
  gainDb?: number
  gainTo?: number
  bass?: BassRender
  /** Fades from the part's edges (beats): a layer that swells in and leaves. */
  fadeIn?: number
  fadeOut?: number
  /** Loop variations: beats into the loop at `start`, only its first bars, semitones. */
  trim?: number
  loopBars?: number
  pitch?: number
  /** A step gate: the 16ths of each bar that play (`AudioClip.chop`). */
  chop?: number[]
}

/** What a segment repeats, in beats. */
function loopLen(s: Segment): number {
  const bars = s.sample.bars ?? 1
  return Math.max(1, (s.loopBars ? Math.min(s.loopBars, bars) : bars) * BEATS_PER_BAR)
}

/** Segments that play the same way (and so join up into one clip where they meet in phase). */
function alike(a: Segment, b: Segment): boolean {
  return a.sample.id === b.sample.id && (a.pitch ?? 0) === (b.pitch ?? 0) && (a.loopBars ?? 0) === (b.loopBars ?? 0)
    && JSON.stringify(a.filter ?? null) === JSON.stringify(b.filter ?? null) && JSON.stringify(a.bass ?? null) === JSON.stringify(b.bass ?? null)
    && JSON.stringify(a.verb ?? null) === JSON.stringify(b.verb ?? null) && JSON.stringify(a.chop ?? null) === JSON.stringify(b.chop ?? null)
    && (a.gainDb ?? 0) === (b.gainDb ?? 0) && a.gainTo === b.gainTo && !a.fadeIn && !a.fadeOut && !b.fadeIn && !b.fadeOut
}

/** Lanes whose one-shot patterns take on the track's feel (the kick and crash stay on the grid). */
// (Not the chord stabs: they sit straight on the grid, where a patch's arp keeps them anyway.)
const GROOVED = new Set<Role>(['clap', 'clap2', 'clap3', 'hats', 'hats2', 'ride', 'perc', 'perc2', 'top', 'top2', 'top3', 'top4'])

const patternKey = (p: BarPattern) => `${p.sample.rel_path}|${p.steps.join('')}|${JSON.stringify(p.filter ?? null)}|${p.pitch ?? 0}|${p.gainDb ?? 0}|${p.gainTo ?? ''}|${p.gate ?? ''}|${p.room ?? ''}|${p.echo ?? ''}|${p.bend?.join(',') ?? ''}|${p.verb ? `${p.verb.from},${p.verb.to}` : ''}`

class Lanes {
  bars = new Map<Role, (BarPattern | null)[]>()
  segs = new Map<Role, Segment[]>()
  /** The track's feel, applied to one-shot patterns on the GROOVED lanes. */
  feel: StepGroove | null = null
  /** The stabs take on the feel too (tracks whose stabs are written for them, rule `stabFit`). */
  stabFeel = false

  constructor(private total: number) {}

  roles(): Role[] {
    return [...new Set([...this.bars.keys(), ...this.segs.keys()])]
  }

  bar(role: Role, bar: number): BarPattern | null {
    return this.bars.get(role)?.[bar] ?? null
  }

  /** The loop segment of `role` playing all through [from, to) beats, if one does. */
  loopOver(role: Role, from: number, to: number): Segment | null {
    return this.segs.get(role)?.find((s) => s.sample.kind === 'loop' && !s.bass && s.start <= from && s.start + s.length >= to) ?? null
  }

  /**
   * What `role` plays in `bar`: its pattern, and each sound in it (which, how, over which beats,
   * and where its loop is anchored: a loop playing on in phase is the same from bar to bar).
   */
  state(role: Role, bar: number): string {
    const p = this.bar(role, bar)
    let out = p ? patternKey(p) : ''
    const a = bar * BEATS_PER_BAR
    for (const s of this.segs.get(role) ?? []) {
      const from = Math.max(s.start, a)
      const to = Math.min(s.start + s.length, a + BEATS_PER_BAR)
      if (to <= from) continue
      const L = loopLen(s)
      const anchor = s.sample.kind === 'loop' ? (((s.start - (s.trim ?? 0)) % L) + L) % L : s.start
      out += `|${s.sample.id}:${s.pitch ?? 0}:${s.loopBars ?? 0}:${JSON.stringify(s.filter ?? null)}:${anchor}:${from - a}-${to - a}`
    }
    return out
  }

  /** Split `role`'s loops that run across `beat` into two that play on seamlessly (`rendered`: bass parts too). */
  splitAt(role: Role, beat: number, rendered = false): void {
    const segs = this.segs.get(role)
    if (!segs) return
    this.segs.set(role, segs.flatMap((s) => {
      if (s.sample.kind !== 'loop' || (s.bass && !rendered) || beat <= s.start || beat >= s.start + s.length) return [s]
      const L = loopLen(s)
      const head = beat - s.start
      // A sweep and a ride go on where they were: the first part ends, the second starts, at their
      // value at the split (the filter evenly in pitch, the level in dB); fades stay at their ends.
      const t = head / s.length
      const f = s.filter
      const hz = f && f.to != null ? Math.round(f.from * (f.to / f.from) ** t) : null
      const db = s.gainTo != null ? Math.round(((s.gainDb ?? 0) + (s.gainTo - (s.gainDb ?? 0)) * t) * 2) / 2 : null
      const { fadeIn, fadeOut, ...plain } = s
      const first: Segment = { ...plain, length: head, ...(fadeIn ? { fadeIn } : {}) }
      const second: Segment = { ...plain, start: beat, length: s.length - head, trim: ((s.trim ?? 0) + head) % L, ...(fadeOut ? { fadeOut } : {}) }
      if (f && hz != null) {
        first.filter = { ...f, to: hz }
        second.filter = { ...f, from: hz }
      }
      if (db != null) {
        first.gainTo = db
        second.gainDb = db
      }
      return [first, second]
    }))
  }

  /** Change how `role`'s loops play within [from, to) beats (only those `which` accepts). */
  vary(role: Role, from: number, to: number, patch: Partial<Segment>, which: (s: Segment) => boolean = () => true): void {
    this.splitAt(role, from)
    this.splitAt(role, to)
    for (const s of this.segs.get(role) ?? []) {
      if (s.sample.kind !== 'loop' || s.bass || s.start < from || s.start + s.length > to || !which(s)) continue
      Object.assign(s, patch)
      if (s.trim) s.trim %= loopLen(s)
    }
  }

  /**
   * A reverb build on `role`'s loops over [from, to) beats: the send rising to
   * `peak` where they stop (at `to`, or earlier when they stop before the line). False when
   * nothing plays there.
   */
  swell(role: Role, from: number, to: number, peak: number): boolean {
    this.splitAt(role, from, true)
    this.splitAt(role, to, true)
    const segs = (this.segs.get(role) ?? []).filter((s) => s.sample.kind === 'loop' && s.start >= from && s.start < to)
    if (!segs.length) return false
    const end = Math.max(...segs.map((s) => s.start + s.length))
    const at = (beat: number) => peak * Math.min(1, (beat - from) / (end - from)) ** 2
    for (const s of segs) s.verb = { from: at(s.start), to: at(s.start + s.length) }
    return true
  }

  /**
   * A ride on `role`'s loops (rendered parts too) over [from, to) beats: a filter sweeping from
   * `filter.from` to `filter.to` Hz and/or the volume from `gainDb` to `gainTo` dB, evenly across
   * [from, to) (a loop covering only part of it gets its share). Loops that have a filter or a ride
   * already (a build's, a breakdown's) keep theirs. False when nothing plays there.
   */
  ride(role: Role, from: number, to: number, r: { filter?: ClipFilter; gainDb: number; gainTo?: number }): boolean {
    this.splitAt(role, from, true)
    this.splitAt(role, to, true)
    const segs = (this.segs.get(role) ?? []).filter((s) => s.sample.kind === 'loop' && s.start >= from && s.start < to
      && !s.filter && s.gainTo == null && !s.gainDb)
    const t = (beat: number) => Math.min(1, (beat - from) / (to - from))
    const hz = (beat: number) => r.filter!.from * ((r.filter!.to ?? r.filter!.from) / r.filter!.from) ** t(beat)
    const db = (beat: number) => r.gainDb + ((r.gainTo ?? r.gainDb) - r.gainDb) * t(beat)
    for (const s of segs) {
      const e = s.start + s.length
      if (r.filter) {
        const [a, z] = [Math.round(hz(s.start)), Math.round(hz(e))]
        s.filter = { ...r.filter, from: a, to: r.filter.to == null || a === z ? null : z }
      }
      const [a, z] = [Math.round(db(s.start) * 2) / 2, Math.round(db(e) * 2) / 2]
      if (a) s.gainDb = a
      if (z !== a) s.gainTo = z
    }
    return segs.length > 0
  }

  /** `role`'s loops (`rendered`: bass parts too) stop for [from, to) beats and play on after it. */
  cut(role: Role, from: number, to: number, rendered = false): void {
    this.splitAt(role, from, rendered)
    this.splitAt(role, to, rendered)
    const segs = this.segs.get(role)
    if (segs) this.segs.set(role, segs.filter((s) => s.sample.kind !== 'loop' || s.start < from || s.start + s.length > to))
  }

  setBar(role: Role, bar: number, p: BarPattern | null): void {
    if (bar < 0 || bar >= this.total) return
    if (!this.bars.has(role)) this.bars.set(role, new Array(this.total).fill(null))
    this.bars.get(role)![bar] = p
  }

  add(role: Role, seg: Segment): void {
    if (seg.length <= 0 || seg.start < 0) return
    if (!this.segs.has(role)) this.segs.set(role, [])
    this.segs.get(role)!.push(seg)
  }

  /**
   * Silence [from, to) beats on every lane but `keep`: pattern steps are cleared, loops end
   * early (a drop's moment of silence); one running on past it (strings all through) play on
   * after it, from where its loop is there.
   */
  silence(from: number, to: number, keep: Set<Role>): void {
    for (const [role, bars] of this.bars) {
      if (keep.has(role)) continue
      for (let b = Math.floor(from / BEATS_PER_BAR); b * BEATS_PER_BAR < to; b++) {
        const p = bars[b]
        if (!p) continue
        const s0 = Math.max(0, Math.round((from - b * BEATS_PER_BAR) * 4))
        const s1 = Math.min(STEPS_PER_BAR, Math.round((to - b * BEATS_PER_BAR) * 4))
        const steps = p.steps.map((v, i) => (i >= s0 && i < s1 ? 0 : v)) as Steps
        bars[b] = steps.some((v) => v) ? { ...p, steps } : null
      }
    }
    for (const role of [...this.segs.keys()]) {
      if (keep.has(role)) continue
      this.splitAt(role, to, true)
      this.segs.set(role, this.segs.get(role)!.flatMap((s) => {
        const end = s.start + s.length
        if (end <= from || s.start >= to) return [s]
        return s.start < from ? [{ ...s, length: from - s.start }] : []
      }))
    }
  }

  /**
   * Bar patterns become pattern clips (runs of identical bars merge; on the stab lanes also runs
   * of a 2-bar rhythm, as 2-bar patterns); segments become audio clips.
   */
  clips(laneIds: Map<Role, string>): Clip[] {
    const out: Clip[] = []
    for (const [role, bars] of this.bars) {
      const laneId = laneIds.get(role)!
      const emit = (start: number, len: number, p: BarPattern, steps: Steps, patternBars: 1 | 2, bend = p.bend) => {
        if (!steps.some(Boolean)) return
        const c: PatternClip = {
          id: uid('c'), laneId, type: 'pattern', start: start * BEATS_PER_BAR, length: len * BEATS_PER_BAR,
          gainDb: p.gainDb ?? 0, sample: sampleRef(p.sample), patternBars, steps: [...steps],
        }
        if (p.gainTo != null) c.gainTo = p.gainTo
        if (p.filter) c.filter = { ...p.filter }
        if (p.pitch) c.pitch = p.pitch
        if (p.gate) c.gate = p.gate
        if (p.room) c.verb = { from: p.room, to: p.room }
        if (p.verb) c.verb = { ...p.verb }
        if (p.echo) c.echo = p.echo
        // (A moved hit cleared since, by the silence before a drop, takes its move with it.)
        const moves = bend?.map((x, i) => (c.steps[i] ? x : 0))
        if (moves?.some(Boolean)) c.bend = moves
        if (this.feel && (GROOVED.has(role) || (this.stabFeel && STAB_ROLES.includes(role)))) c.groove = grooveFor(this.feel, c.steps)
        out.push(c)
      }
      const key = (b: number) => (bars[b] ? patternKey(bars[b]!) : '')
      // (A stab bar's moved hit is part of its rhythm: two bars differing in it still make one 2-bar pattern.)
      const rest = (b: number) => (bars[b] ? patternKey({ ...bars[b]!, steps: [], bend: undefined }) : '')
      const zero = new Array<number>(STEPS_PER_BAR).fill(0)
      for (let b = 0; b < bars.length;) {
        const p = bars[b]
        if (!p) { b++; continue }
        if (STAB_ROLES.includes(role) && key(b + 1) && key(b + 1) !== key(b) && rest(b + 1) === rest(b)) {
          let pairs = 1
          while (key(b + 2 * pairs) === key(b) && key(b + 2 * pairs + 1) === key(b + 1)) pairs++
          if (pairs >= 2) {
            const nb = bars[b + 1]!.bend
            emit(b, 2 * pairs, p, [...p.steps, ...bars[b + 1]!.steps], 2, p.bend || nb ? [...p.bend ?? zero, ...nb ?? zero] : undefined)
            b += 2 * pairs
            continue
          }
        }
        let n = 1
        while (key(b + n) === key(b)) n++
        emit(b, n, p, p.steps, 1)
        b += n
      }
    }
    for (const [role, segs] of this.segs) {
      const laneId = laneIds.get(role)!
      const sorted = [...segs].sort((a, b) => a.start - b.start)
      const merged: Segment[] = []
      for (const s of sorted) {
        const last = merged[merged.length - 1]
        const L = loopLen(s)
        // Joined where it plays on in phase: the next part starts where the last one is in the loop.
        if (last && s.sample.kind === 'loop' && alike(last, s) && last.start + last.length === s.start
            && ((((last.trim ?? 0) + s.start - last.start - (s.trim ?? 0)) % L) + L) % L === 0) {
          last.length += s.length
        } else {
          merged.push({ ...s })
        }
      }
      for (const s of merged) {
        const c: AudioClip = {
          id: uid('c'), laneId, type: 'audio', start: s.start, length: s.length, trimBeats: s.trim ?? 0, gainDb: s.gainDb ?? 0,
          sample: sampleRef(s.sample),
        }
        if (s.gainTo != null) c.gainTo = s.gainTo
        if (s.filter) c.filter = { ...s.filter }
        if (s.verb) c.verb = { ...s.verb }
        if (s.bass) c.bass = { ...s.bass }
        if (s.pitch) c.pitch = s.pitch
        if (s.loopBars && s.loopBars < (s.sample.bars ?? 1)) c.loopBars = s.loopBars
        if (s.chop?.some((v) => !v)) c.chop = [...s.chop]
        // (Fades never meet: each at most half the clip.)
        if (s.fadeIn) c.fadeIn = Math.min(s.fadeIn, s.length / 2)
        if (s.fadeOut) c.fadeOut = Math.min(s.fadeOut, s.length / 2)
        out.push(c)
      }
    }
    return out.sort((a, b) => a.start - b.start)
  }
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

export function generate(all: SampleListItem[], opts: GenerateOptions, seed: number, keep: Keep = {}): Generation {
  const rng = new Rng(seed)
  const samples = opts.zipIds ? all.filter((s) => opts.zipIds!.includes(s.zip_id)) : all
  const bpm = !opts.tempo ? opts.bpm
    : opts.tempo.max > opts.tempo.min ? rng.int(Math.round(opts.tempo.min), Math.round(opts.tempo.max)) : opts.tempo.min
  const minutes = opts.minMinutes + rng.next() * Math.max(0, opts.maxMinutes - opts.minMinutes)
  // Most tracks follow a real track's structure and rules, changed a little; the rest the grammar.
  const readable = (opts.references ?? []).filter((r) => r.profile && readReference(r.profile))
  const tpl = !keep.structure && (opts.templates?.length || readable.length) && rng.chance(TEMPLATE_CHANCE)
    ? pickTemplate(rng, opts.templates ?? [], readable, barsFor(opts.minMinutes, bpm), barsFor(opts.maxMinutes, bpm)) : null
  const sections = keep.structure ? structuredClone(keep.structure) : tpl?.sections ?? makeStructure(rng, barsFor(minutes, bpm))
  const total = sections.reduce((n, s) => n + s.bars, 0)
  const key = keep.key !== undefined ? keep.key : chooseKey(rng, samples)
  // A replay (one of the track's rules changed) goes on from where the track's own RNG was here.
  if (keep.replay != null) rng.restore(keep.replay)
  const rngAt = rng.save()
  const picker = new Picker(rng, opts.useRatings, key, new Set(keep.avoid))
  const choices: string[] = []

  // ---- main samples (one per lane for the whole track, variations for later drops) ----
  const pool = (f: (s: SampleListItem) => boolean) => samples.filter(f)
  /**
   * A lane's kept sample, else `draw()`. In a replay the sample is drawn all the same (and the
   * kept one swapped in), so the RNG and the zip spread go on as they did when the track was made.
   */
  const keptOr = (role: Role, draw: () => SampleListItem | null) => {
    const k = keep.picks?.[role]
    if (!k) return draw()
    if (keep.replay == null) return picker.use(k)
    const d = draw()
    if (d?.id === k.id) return d
    if (d) picker.unuse(d)
    return picker.use(k)
  }
  const loopsOf = (...cats: Category[]) => pool(of('loop', ...cats))
  const preferShort = (s: SampleListItem) => ((s.bars ?? 1) <= 4 ? 2 : 1)

  /** Up to `n` different samples: `first`, then others from `cands`. */
  const layers = (first: SampleListItem | null, cands: SampleListItem[], n: number, fit?: (s: SampleListItem) => number,
                  score?: (s: SampleListItem) => number) => {
    const out = first ? [first] : []
    while (out.length < n) {
      const left = cands.filter((s) => !out.some((o) => o.id === s.id))
      // (Each layer interlocks with the ones before it too.)
      const s = left.length ? picker.pick(left, { fit, score: score && ((x) => score(x) * (x.kind === 'loop' ? interlockFit(x, out) : 1)) }) : null
      if (!s) break
      out.push(s)
    }
    return out
  }

  // ---- the track's character (SCOPE.md §6.6, "Identity"; an RNG of its own), drawn first: it
  // sets where the sound palette leans. A kept or locked value stands; a track made before has none ----
  const crng = new Rng(seed ^ 0x43484152)
  // The arc and the track's variations: RNGs of their own too.
  const hrng = new Rng(seed ^ 0x484f4c44)
  // A track made again (a lane re-rolled, a choice changed: all its rules come along, `dropGaps` among
  // them) from before a rule existed keeps going without it: nothing else in it changes.
  const madeBefore = (rule: string) => !!keep.rules && 'dropGaps' in keep.rules && !(rule in keep.rules)
  const xrng = new Rng(seed ^ 0x47455354)
  const gaterng = new Rng(seed ^ 0x47415445)
  const drawnCharacter = crng.pick(CHARACTERS)
  // (A track made again carries its own, also when it has none: one made before characters.)
  const character = (keep.rules && 'character' in keep.rules ? keep.rules.character : opts.locks?.character ?? drawnCharacter) as Character | null
  const charRules = characterRules(drawnCharacter, crng, KICK_PHRASE_ENDS)

  // ---- picked as a record (SCOPE.md §6.6): the kick is the anchor, the character sets where the
  // palette leans, every other drum sample is picked by how it sits there; the loops as a set that
  // interlocks (each by how little it lands on the 16ths of those chosen before it, in their tone) ----
  const refs = paletteRefs(samples)
  const kick = keptOr('kick', () => picker.pick(pool(of('oneshot', 'kick')), { score: (s) => paletteFit(s, paletteFor(character, null, refs), refs) }))
  const palette: Palette = paletteFor(character, kick, refs)
  const loopSet: SampleListItem[] = []
  const addLoop = <T extends SampleListItem | null>(s: T): T => {
    if (s?.kind === 'loop' && !loopSet.some((x) => x.id === s.id)) loopSet.push(s)
    return s
  }
  /** How a drum sample sits with the track: in its palette, and (a loop) interlocking with the loops it has. */
  const sits = (s: SampleListItem) => paletteFit(s, palette, refs) * (s.kind === 'loop' ? interlockFit(s, loopSet) : 1)
  // The main loops first: the track's feel comes from one of them, the other loops are picked to fit it.
  const topLoops = loopsOf('top')
  const top0 = addLoop(keptOr('top', () => picker.pick(topLoops, { score: sits })))
  const groove = addLoop(keptOr('groove', () => picker.pick(loopsOf('groove'), { score: sits })))
  let feelSrc = [groove, top0].find(hasFeel) ?? null
  const fits = (s: SampleListItem) => feelFit(s.groove, feelSrc?.groove)
  const clapShots = pool(of('oneshot', 'clap', 'snare'))
  const clap = keptOr('clap', () => picker.pick(clapShots, { score: sits }))
  // Layered claps (never a second kick): played together on the backbeat in drops.
  const claps = layers(clap, clapShots, rng.weighted([[1, 2], [2, 3], [3, 2]] as const), undefined, sits)
  const hatLoops = loopsOf('hat', 'hat_closed', 'hat_open', 'shaker')
  const hats = addLoop(keptOr('hats', () => picker.pick(hatLoops, { weight: preferShort, fit: fits, score: sits })
    ?? picker.pick(pool(of('oneshot', 'hat_closed', 'hat', 'hat_open')), { score: sits })))
  const percLoops = loopsOf('perc')
  const perc = addLoop(keptOr('perc', () => picker.pick(percLoops, { weight: preferShort, fit: fits, score: sits })
    ?? picker.pick(pool(of('oneshot', 'perc', 'shaker')), { score: sits })))
  // Top loops fill the track up: two to four of them, layered in drops and builds.
  const tops = layers(top0, topLoops, rng.weighted([[2, 2], [3, 3], [4, 2]] as const), fits, sits)
  tops.forEach(addLoop)
  const top = tops[0] ?? null
  // The layers last, so they interlock with everything above. Rides come in later (drops only),
  // never in intros and outros.
  const hats2 = hats?.kind === 'loop' && rng.chance(0.55) ? addLoop(picker.pick(hatLoops, { not: hats, fit: fits, score: sits })) : null
  const perc2 = perc?.kind === 'loop' && rng.chance(0.6) ? addLoop(picker.pick(percLoops, { not: perc, fit: fits, score: sits })) : null
  const ride = addLoop(picker.pick(loopsOf('ride'), { fit: fits, score: sits }) ?? picker.pick(pool(of('oneshot', 'ride')), { score: sits }))
  const rideSteps = steps(rng.chance(0.5) ? FOUR.map((s) => s + 2) : EIGHTHS, 2)
  const groove2 = groove ? picker.pick(loopsOf('groove'), { not: groove, fit: fits, score: sits }) : null
  feelSrc ??= [perc, hats].find(hasFeel) ?? null
  const picks: Partial<Record<Role, SampleListItem>> = {}
  for (const [role, s] of [['kick', kick], ['clap', clap], ['hats', hats], ['perc', perc], ['top', top], ['groove', groove]] as const) {
    if (s) picks[role] = s
  }

  // ---- bass (SCOPE.md §6.7): a new riff learned from the MIDI page, through a Serum patch, in the
  // track key ----
  const bo = opts.bass
  const model = bo?.midis.length && bo.presets.length ? bassModel(bo.midis) : null
  const bassPreset = model && bo
    ? keep.bassPreset ?? rng.pickBy(bassPool(bo.presets, seed), (p) => 1 + (bo.favorites.includes(p.path) ? 3 : 0)) : null
  // (The line has an RNG of its own: the rest of the track is the same whatever line it writes. It
  // may slide one note into the next on a patch that glides.)
  const bassMidi = model && bassPreset
    ? keep.bassMidi ?? generatedMidi(generateBassline(model, new Rng(seed ^ 0x4c494e45), { key, beats: bo!.beats, glide: !!bassPreset.glide }), key) : null
  const bass: GenerationBass | null = bassMidi && bassPreset
    ? { midi: bassMidi, preset: bassPreset, transpose: transposeTo(bassMidi.key_label, key) + (bo?.octaves?.[bassPreset.path] ?? 0), ...(keep.bassMidi ? keep.bassEdit : undefined) }
    : null

  // ---- chord stabs (SCOPE.md §6.9): the Chord Stabs page's samples, in every track while there
  // are some; an RNG of their own, so the drums and the bass are the same with or without them ----
  const srng = new Rng(seed ^ 0x53544142)
  const stabItems = opts.stabs?.hits ?? []
  const stabPool = stabItems.map(hitSample)
  const stabOf = new Map(stabItems.map((h) => [h.rel_path, h]))
  const keptRule = keep.rules?.stabs as boolean | undefined
  const useStabs = stabPool.length > 0 && (keptRule ?? true)
  // (Known before the rules are: a kept or locked value, else on.)
  const stabFitEarly = ((keep.rules?.stabFit ?? opts.locks?.stabFit ?? true) as boolean) !== false
  // (One loop of them, rule `stabLoop`, likewise: on unless kept or locked off; only with stabs that fit.)
  const stabLoopEarly = stabFitEarly && ((keep.rules?.stabLoop ?? opts.locks?.stabLoop ?? true) as boolean) !== false
  const stabs: SampleListItem[] = []
  if (useStabs) {
    const keptIds = STAB_ROLES.map((r) => keep.picks?.[r]?.id)
    // Stabs that fit the track (rule `stabFit`): near its key, not the tops' tone over again, and a set.
    const topsTone = meanTone(tops.map((t) => t.tone))
    const fitting = (cands: SampleListItem[]) => {
      const chosen = stabs.map((x) => stabOf.get(x.rel_path)!).filter(Boolean)
      return srng.pickBy(cands, (x) => {
        const h = stabOf.get(x.rel_path)
        // (A loop's stabs are its accents: tight hits over sustained, swelling ones.)
        return h ? stabWeight(h, hitPitch(h, key), topsTone, chosen, TONE_BANDS_PER_OCTAVE) * (stabLoopEarly ? focusWeight(h) : 1) : 1
      })
    }
    for (const role of STAB_ROLES) {
      const own = keep.picks?.[role] ? stabPool.find((x) => x.id === keep.picks![role]!.id) : undefined
      const cands = stabPool.filter((x) => !stabs.includes(x) && !keptIds.includes(x.id))
      const fresh = cands.filter((x) => !keep.avoid?.includes(x.rel_path))
      const from = fresh.length ? fresh : cands
      const pick = own ?? (!from.length ? null : stabFitEarly ? fitting(from) : srng.pick(from))
      if (pick) stabs.push(pick)
    }
    stabs.forEach((x, i) => (picks[STAB_ROLES[i]] = x))
  }

  // ---- disco hits (SCOPE.md §6.8): the Disco Hits page's samples, moved into the track key. An
  // RNG of their own keeps the rest of the track the same with or without them ----
  const drng = new Rng(seed ^ 0x44495343)
  const hpRng = new Rng(seed ^ 0x4d495848)
  // The build-ups into drops and their snare: an RNG of their own too.
  const brng = new Rng(seed ^ 0x4255494c)
  // How the track fills up out of its intro (and thins out into its outro): an RNG of its own too.
  const lrng = new Rng(seed ^ 0x4c494654)
  // The bassline's turns at phrase ends: an RNG of their own too.
  const turnRng = new Rng(seed ^ 0x5455524e)
  // The way into drops and the big build into the drops after the long breakdown: an RNG of their own too.
  const bigRng = new Rng(seed ^ 0x42494742)
  // How the groove carries through breakdowns: an RNG of its own too.
  const grng = new Rng(seed ^ 0x474c5545)
  const buildDrawn = {
    buildup: brng.weighted([['none', 3], ['snareRoll', 2], ['snareSteps', 2], ['kickRoll', 1.5], ['claps', 1.5]] as const) as Buildup,
    buildupBars: brng.weighted([[2, 1], [4, 3], [8, 2]] as const) as number,
    buildupCrash: brng.weighted([['none', 4], ['faster', 1.5], ['last4', 1.5]] as const) as 'none' | 'faster' | 'last4',
  }
  const snares = pool(of('oneshot', 'snare')).filter((x) => !claps.some((c) => c.id === x.id))
  const snareCands = snares.length ? snares : clapShots.filter((x) => !claps.some((c) => c.id === x.id))
  const freshSnares = snareCands.filter((x) => !keep.avoid?.includes(x.rel_path))
  const drawnSnare = (freshSnares.length ? freshSnares : snareCands).length ? brng.pick(freshSnares.length ? freshSnares : snareCands) : null
  const keptSnare = keep.picks?.buildup && of('oneshot', 'snare', 'clap')(keep.picks.buildup) ? keep.picks.buildup : null
  const snare = keptSnare ?? drawnSnare ?? clap
  const hitItems = opts.disco?.hits ?? []
  const hitPool = hitItems.map(hitSample)
  // ---- strings (SCOPE.md §6.10): the Strings page's samples close enough to the key. An RNG of
  // their own, like the disco hits ----
  const trng = new Rng(seed ^ 0x53545247)
  const stringHits = (opts.strings?.hits ?? []).filter((h) => stringsShift(h, key) != null)
  // ---- vocals (SCOPE.md §6.11): the Vocals page's takes. An RNG of their own too ----
  const vrng = new Rng(seed ^ 0x564f434c)
  // The ambience bed: an RNG of its own too. Noise, or a tonal bed that moves into the key (one that
  // wouldn't move isn't used: it is never heard as recorded).
  const arng = new Rng(seed ^ 0x414d4249)
  const bedHits = (opts.ambience?.hits ?? []).filter((h) => bedShift(h, key) != null)
  // Splice vocal loops (the Vocal Loops module): some tracks sing one that fits the key and tempo
  // and has never gone out in an export. A take made for this track (ElevenLabs) always sings.
  const loopPool = opts.vocals?.pool
  const takes = (opts.vocals?.takes ?? []).filter((t) => t.analysis.phrases.length && (!loopPool || loopFits(t, key, bpm)))
  const vocalWeights = vocalAtWeights(opts.templates ?? [])
  const hitOf = new Map(hitItems.map((h) => [h.rel_path, h]))

  const fills = pool(of('event', 'fill'))
  const rolls = pool(of('event', 'roll'))
  const risers = pool(of('event', 'fx_riser'))
  /** Sweeps and other FX that build up: second layers into drops, sweeps up into breakdowns. */
  const lifts = pool((s) => s.kind === 'event' && rising(s) && s.category !== 'fx_riser')
  const downs = pool((s) => s.kind === 'event' && falling(s))
  const impacts = pool(of('event', 'fx_impact'))
  const crash = picker.pick(pool(of('oneshot', 'cymbal')), { score: sits })

  // ---- the producer's own FX into a drop ----
  // Events of one track that lead into the same bar (bodies ending there) or start on it (an
  // impact, a downlifter) were layered there by its producer: a riser, the fill, the impact of
  // one drop are sure to go together.
  const sets = new Map<string, SampleListItem[]>()
  for (const s of samples) {
    if (s.kind !== 'event' || s.shape?.boundary == null) continue
    const onTheLine = s.category === 'fx_impact' || falling(s) || (s.shape.dir === 'hit' && s.shape.onset <= 1)
    if (!onTheLine && !leads(s)) continue
    const k = `${s.zip_id}:${onTheLine ? s.shape.boundary - bodyBars(s) : s.shape.boundary}`
    sets.set(k, [...(sets.get(k) ?? []), s])
  }
  const tonalKeys = key ? new Set(expandCompatible([key])) : null
  const setCands = [...sets.entries()].filter(([, xs]) => xs.some(rising) && xs.length >= 2
    && xs.filter(rising).every((r) => !r.key_label || !tonalKeys || tonalKeys.has(r.key_label)))
    .sort(([a], [b]) => a.localeCompare(b))
  const drawnSet = setCands.length && rng.chance(0.5)
    ? rng.pickBy(setCands, ([, xs]) => (tpl && xs[0].source_code === tpl.source ? 4 : 1))[0] : null
  const inSet = (f: (s: SampleListItem) => boolean) => !!drawnSet && sets.get(drawnSet)!.some((s) => f(s) && (falling(s) || s.category === 'fx_impact' || leads(s)))

  // ---- the track's rules ----
  // Decided once per track and applied to every section of the same kind, so a track has its
  // own logic instead of sounding random: if drop 1 has a crash every 16 bars, so does drop 2.
  // Breakdowns are the exception: a break is a break from the rest, so they vary on their own.
  const stabMode = srng.weighted([['answer', 7], ['lock', 3]] as const) as StabBass
  // ---- the track's character and its lead (SCOPE.md §6.6, "Identity"; an RNG of their own): one of
  // a few kinds of club track, which sets the rules that go together, and the one element the track
  // is built around. A kept or locked value stands; a track made before has neither ----
  const hasLead: Lead[] = [...(stabs.length ? ['stab' as const] : []), ...(bass ? ['bass' as const] : []), ...(perc?.kind === 'loop' ? ['perc' as const] : [])]
  const drawnLead = pickLead(character ?? drawnCharacter, crng, hasLead)
  const kept = keep.rules && 'lead' in keep.rules ? keep.rules.lead : opts.locks && 'lead' in opts.locks ? opts.locks.lead : undefined
  const lead = kept !== undefined ? ((kept && hasLead.includes(kept as Lead) ? kept : null) as Lead | null) : character ? drawnLead : null
  // ---- the breakdown layer (§6.7b; an RNG of its own): a pad's chord or a reese's note ----
  const prng = new Rng(seed ^ 0x50414453)
  const padPool = key ? opts.pads?.presets ?? [] : []
  const padDraw = { in: prng.chance(PAD_CHANCE[character ?? drawnCharacter]), preset: padPool.length ? prng.pick(padPool).path : null, hz: prng.int(250, 600) }
  const drawn = {
    fx: rng.weighted([['sparse', 1], ['normal', 3], ['busy', 1.5]] as const),
    // Every 16 bars in drops (crashes also in intro and outro): a crash on the 1, the bar before
    // it without kick ("four kicks out"), and/or a fill into it.
    phraseCrash: rng.chance(0.75),
    // A crash at the other 8-bar phrase starts of drops too.
    crash8: rng.chance(0.25),
    phraseKickOut: rng.chance(0.5),
    phraseFill: fills.length > 0 && rng.chance(0.55),
    // The same kick variation at the other 8-bar phrase ends of every drop (or none).
    kickEnd8: rng.chance(0.55) ? rng.weighted(KICK_PHRASE_ENDS) : null,
    clapGhost: rng.chance(0.3) ? rng.pick([7, 15, 14]) : null,
    clapRolls: rng.weighted([['none', 3], ['16', 2], ['8', 1]] as const),
    // Into every drop: four kicks out (or just the last kick), roll or fill, riser, impact,
    // a beat or two of silence, and always a crash on the 1.
    dropKickOut: rng.chance(0.75),
    dropLastKick: rng.chance(0.5),
    // (With the producer's own FX into a drop: what they layered there.)
    dropFill: inSet((s) => s.category === 'roll') ? 'roll' as const : inSet((s) => s.category === 'fill') ? 'fill' as const
      : rolls.length && rng.chance(0.45) ? 'roll' as const : fills.length && rng.chance(0.85) ? 'fill' as const : null,
    // Or a build-up of the track's own (none when it takes a producer's roll), the bars it runs,
    // and crashes building the drop: faster and faster, or on the last four counts.
    buildup: inSet((s) => s.category === 'roll') ? 'none' as Buildup : buildDrawn.buildup,
    buildupBars: buildDrawn.buildupBars,
    buildupCrash: buildDrawn.buildupCrash,
    dropRiser: !!drawnSet || (risers.length > 0 && rng.chance(0.8)),
    dropImpact: inSet((s) => s.category === 'fx_impact') || (impacts.length > 0 && rng.chance(0.5)),
    // The silence before drops when their FX and fill run right up to it (else theirs).
    dropSilence: rng.weighted([[0, 1], [1, 2], [2, 2]] as const),
    // FX layers into drops (a second riser or sweep that complements the first, not in sparse
    // tracks), a downlifter as the drop hits, the producer's own FX into a drop ("zip:bar").
    fxLayers: drawnSet ? (sets.get(drawnSet)!.filter(rising).length >= 2 ? 2 : 1)
      : risers.length + lifts.length > 1 ? rng.weighted([[1, 2], [2, 3]] as const) as number : 1,
    dropDown: inSet(falling) || (downs.length > 0 && rng.chance(0.3)),
    dropSet: drawnSet,
    /** 16ths each drop's transition stops before it (by drop bar); measured, kept by re-rolls. */
    dropGaps: null as Record<string, number> | null,
    // Into every breakdown.
    breakFill: fills.length > 0 && rng.chance(0.7),
    breakCrash: rng.chance(0.5),
    breakLastKick: rng.chance(0.4),
    breakDownlifter: downs.length > 0 && rng.chance(0.6),
    // A sweep up into the breakdown (the downlifter falls away from its start).
    breakSweep: lifts.length > 0 && rng.chance(0.35),
    loopGap: rng.weighted([[0, 3], [1, 1], [2, 1]] as const),
    // Drops: how many top loops (the last drop one more), groove and second perc from which drop,
    // a later groove variation, a switch of loops halfway.
    dropTops: Math.max(1, Math.min(tops.length, rng.int(2, 3))),
    grooveFrom: rng.chance(0.6) ? 0 : 1,
    grooveSwap: !!groove2 && rng.chance(0.4),
    perc2From: rng.chance(0.4) ? 0 : 1,
    switchHalfway: rng.chance(0.25),
    // Rides: later in the first drop, and/or all through the later ones.
    ride: rng.weighted([['late', 2], ['second', 2], ['both', 3]] as const),
    // Intro and outro mirror each other: tops, claps and perc come in the same way they leave.
    ioTopFirst: rng.chance(0.65) ? 0 : 0.5,
    ioTopSecond: tops.length > 1 && rng.chance(0.75) ? rng.pick([0.5, 0.75]) : null,
    ioClaps: rng.chance(0.3),
    ioPerc: rng.chance(0.6),
    outroFill: fills.length > 0 && rng.chance(0.5),
    outroCrash: rng.chance(0.8),
    // The kick's sub thinned out a little in intro and outro, so it mixes over another track.
    ioKickHp: rng.int(60, 110),
    hatsInBreaks: rng.chance(0.5),
    // Hats in the intro and outro (a choice per track, more often in the outro): none, the half
    // next to the drops, or all through.
    introHats: rng.weighted([['none', 4], ['half', 3], ['all', 3]] as const),
    outroHats: rng.weighted([['none', 2], ['half', 1], ['all', 4]] as const),
    // Breakdowns keep a top loop going, mostly low-passed (as in most real tracks).
    topsBreaks: rng.weighted([['filtered', 5], ['open', 3], ['none', 1]] as const),
    topsBreakHz: rng.int(900, 5000),
    // A breath in the bar before drops: the tops stop there, or the tops and the drums (claps,
    // hats, perc) and the bass, while fills and FX play on.
    dropBreath: rng.weighted([[null, 3], ['tops', 2], ['all', 3]] as const),
    // Bass: full in drops; in breakdowns high-passed (its sub out, as real tracks do) or out; in
    // builds out, high-passed, or a high-pass letting the sub in towards the drop; intro and outro
    // usually without (DJ friendly), sometimes high-passed.
    bassBreaks: rng.weighted([['filtered', 3], ['none', 2]] as const),
    bassBuild: rng.weighted([['filtered', 3], ['sweep', 1], ['none', 2]] as const),
    bassIO: rng.weighted([['none', 3], ['filtered', 1]] as const),
    bassHp: rng.int(BASS_HP_MIN_HZ + 10, 380),
    // The bassline's turn (SCOPE.md §6.7): the loop stays strict through the drop, and the last
    // loop of a phrase plays it changed (a gap, an octave jump or a 16th run into the 1): at the
    // end of each drop, every 16 bars, every 8, or never.
    bassTurn: turnRng.weighted([['drop', 3], ['16', 3], ['8', 2], ['none', 2]] as const) as 'drop' | '16' | '8' | 'none',
    bassTurnKind: turnRng.weighted([['pickup', 3], ['gap', 2], ['octave', 2]] as const) as BassTurn,
    // The way into every drop, the same all through the track (SCOPE.md §6.6): straight in, a gap
    // with the drum fill alone in it, or a gap with only the FX pulling into the 1; the gap's beats.
    dropIn: bigRng.weighted([['straight', 3], ['gap', 3], ['suck', 2]] as const) as DropIn | null,
    dropInBeats: bigRng.weighted([[1, 2], [2, 3], [4, 1]] as const) as number,
    // The big build into every drop after the long breakdown (the biggest drops), or the track's
    // usual build-up there too. Its bars: the track it's built on, else the user's tracks (below).
    bigBuild: bigRng.weighted([['big', 3], ['usual', 2]] as const) as 'big' | 'usual',
    bigBars: null as number | null,
    // Its drums: claps building (on the beat, 8ths, 16ths), a snare (a roll or steps) joining
    // halfway, or one of them; the kick out, back four on the floor (low-passed, opening) over its
    // second half, or rolling over its last quarter.
    bigDrums: bigRng.weighted([['both', 3], ['claps', 1.5], ['snare', 1.5]] as const) as BigDrums,
    bigSnare: bigRng.weighted([['roll', 3], ['steps', 2]] as const) as 'roll' | 'steps',
    bigKick: bigRng.weighted([['out', 2], ['back', 2], ['roll', 1.5]] as const) as BigKick,
    // Risers stacked (a long one over the whole build, a riser over its second half, a short lift
    // into the 1), reverb and delay rising on some of it, the mix high-passed over its last bars,
    // crashes coming faster over its last four.
    bigRisers: bigRng.weighted([[3, 3], [2, 2]] as const) as number,
    bigVerb: bigRng.weighted([['drums', 1], ['stabs', 1], ['drums+stabs', 2], ['drums+tops', 1.5], ['all', 2]] as const) as BigVerb,
    bigHp: bigRng.weighted([[0, 2], [4, 2], [8, 1.5]] as const) as number,
    bigCrash: bigRng.chance(0.6),
    // The whole mix high-passed in the bars before drops (also when the track it's built on does it).
    mixHp: hpRng.chance(0.3) ? hpRng.weighted([[1, 1], [2, 2], [4, 1]] as const) as number : 0,
    // The intro fills up over its last bars with what the drops have and it doesn't yet (hats,
    // perc, a second top, claps), one by one, and the outro lets them go the same way; a first drop
    // straight after the intro starts leaner, its layers coming in over its first half.
    ioLift: lrng.chance(0.8),
    firstDrop: lrng.weighted([['lean', 3], ['full', 1]] as const),
    // Disco hits in some tracks: one or two, on the 1 where each drop starts and halfway through
    // it, or every 16 or 8 bars of the drops, or also where each breakdown starts.
    discoIn: hitPool.length > 0 && drng.chance(0.6),
    discoCount: drng.weighted([[1, 2], [2, 1]] as const) as number,
    discoAt: drng.weighted([['drops', 3], ['16', 2], ['8', 1], ['all', 2]] as const),
    // Strings in some tracks: in the drops, all through, or all but the intro and outro.
    stringsIn: stringHits.length > 0 && trng.chance(STRINGS_CHANCE),
    // (A supporting layer: from the second drop, in the second half of every drop, or in the
    // breakdowns for tension. Tracks made before: in the drops, all through, or all but intro and outro.)
    stringsAt: trng.weighted([['later', 3], ['halves', 3], ['breaks', 2]] as const) as 'later' | 'halves' | 'breaks' | 'drops' | 'all' | 'inner',
    // A vocal where a take is given: its phrase loop (the long or the short one), in the drops, in
    // their second halves, in drops and breakdowns, or in breakdowns (a reverb build on it there).
    vocalIn: takes.length > 0 && (!loopPool || new Rng(seed ^ 0x564c4f50).chance(loopPool.chance)),
    vocalLoop: vrng.weighted([['long', 1], ['short', 1]] as const) as 'long' | 'short',
    // (Where the user's tracks sing, when their vocal stems were measured; else the house weights.)
    vocalAt: vrng.weighted(vocalWeights ?? [['drops', 3], ['halves', 2], ['drops_breaks', 3], ['breaks', 1]]) as 'drops' | 'halves' | 'drops_breaks' | 'breaks',
    // The groove carries through breakdowns (SCOPE.md §6.6, "One groove"): the drop's own drums
    // play on there in a darker state instead of each break drawing its own content. The perc
    // through it low-passed or fading out; how dark (Hz) and how far down (dB) what stays sits;
    // the bars the rest takes to fade out after the line, and the bars it all opens up over into
    // the next part.
    glue: true,
    gluePerc: grng.weighted([['through', 3], ['leave', 2]] as const),
    glueHz: grng.int(500, 1400),
    glueDb: -grng.int(3, 7),
    glueOut: grng.weighted([[4, 2], [8, 3]] as const) as number,
    glueOpen: grng.weighted([[8, 3], [16, 2]] as const) as number,
    character,
    lead,
    // A layer made for the breakdowns: whether, through which patch, and where its filter starts.
    padIn: padPool.length > 0 && padDraw.in,
    padPreset: padDraw.preset,
    padHz: padDraw.hz,
    // A very quiet texture under the track (between the intro and the outro), ducking under the kick.
    bedIn: bedHits.length > 0 && arng.chance(BED_CHANCE),
    // The feel: how much of the main loop's groove the one-shots and the bass take on.
    feel: rng.int(70, 100) / 100,
    // Where the sound palette sits (brightness, compactness; the kick's place and the character's lean).
    palette,
    // The arc: one element held back for the last drop (an RNG of its own).
    hold: (madeBefore('hold') ? 'none' : hrng.weighted(HOLD_LEAN[character ?? 'none'])) as Hold,
    // The track's own variations: two small ones every 8 bars, one at 16, a big one at 32 (an RNG of its own).
    gestures: madeBefore('gestures') ? null as Gestures | null : drawGestures(xrng, character),
    // Loop variations: a top layer (or the second perc / hat loop) a little higher or lower, and
    // in the intro (mirrored in the outro) loops repeating only their first bar or two at first.
    pitchTop: tops.length > 1 && rng.chance(0.35) ? [rng.int(1, tops.length - 1), rng.weighted(PITCHES)] as [number, number] : null,
    pitchPerc2: perc2 && rng.chance(0.25) ? rng.weighted(PITCHES) : null,
    pitchHats2: hats2 && rng.chance(0.2) ? rng.weighted(PITCHES) : null,
    ioShort: rng.chance(0.4) ? rng.weighted([[1, 1], [2, 2]] as const) as number : null,
    // The intro's top loops gated, the gate opening up phrase by phrase (an RNG of its own).
    // Every short fill made anew: pitched, spliced, reworked (an RNG of its own); not in tracks made before.
    fillVariants: !madeBefore('fillVariants'),
    introGate: madeBefore('introGate') || !tops.length ? null : gaterng.chance(INTRO_GATE_CHANCE) ? gaterng.pick(GATE_FAMILIES) : null,
    // Chord stabs and their 2-bar rhythm; in drops only, or also low-passed in breakdowns and
    // builds ('keys': where keys parts played before stabs replaced them).
    stabs: useStabs,
    // The stabs written for the track (SCOPE.md §6.9, "Stabs that fit"): chosen to fit it, their
    // rhythm against its bassline (in its rests, or on its syncopations), with its feel, phrased
    // (accents, a turn at the end of every 8 bars), brought in and taken through the track, in a
    // room, gated, ducked. Off: placed as before (tracks made before).
    stabFit: stabFitEarly,
    stabBass: stabMode,
    stabRhythm: stabRhythm(srng, opts.stabs?.rhythms ?? [], stabFitEarly ? {
      perBar: perBarFor(stabs.map((x) => stabOf.get(x.rel_path)!).filter(Boolean)),
      bass: bass ? bassSteps(bass.notes ?? bass.midi.notes, bassBars(bass)) : null,
      mode: ((keep.rules?.stabBass ?? opts.locks?.stabBass ?? stabMode) as StabBass),
      loop: stabLoopEarly,
    } : undefined),
    // How a phrase's last bar turns; a slow filter opening over the first bars of drop 1 or of every
    // drop; a dark tease at the end of a long intro; drop 1 on the lean rhythm at first (they never
    // rest inside a drop); delay throws on the last bar of every 8 or 16 bars, or only into breakdowns.
    stabTurn: srng.weighted([['none', 2], ['drop', 3], ['push', 3], ['double', 2]] as const) as StabTurn,
    stabsOpen: srng.weighted([['none', 2], ['first', 3], ['each', 2]] as const),
    stabsTease: srng.chance(0.6),
    stabsGrow: srng.chance(0.5),
    stabEcho: srng.weighted([['none', 2], ['8', 2], ['16', 3], ['breaks', 2]] as const),
    stabsIn: srng.weighted([['drops', 1], ['keys', 1]] as const),
    stabsBreaks: srng.weighted([['filtered', 2], ['none', 1]] as const),
    stabsBuild: srng.weighted([['sweep', 2], ['filtered', 1], ['none', 1]] as const),
    stabsCutoff: srng.int(700, 1800),
    // How many stab samples take turns in the rhythm (as many as the page has), and how: a bar
    // each (two of them), or hit by hit.
    stabCount: srng.weighted(stabLoopEarly ? [[1, 3], [2, 5], [3, 2]] as const : [[1, 4], [2, 4], [3, 2]] as const) as number,
    stabTurns: srng.weighted([['bars', 1], ['hits', 1]] as const) as StabTurns,
    // One stab loop (SCOPE.md §6.9): a second stab layered on the main one or playing its pickups;
    // the bars before every drop it announces it over; a roll into its last beat, or none.
    stabLoop: stabLoopEarly,
    stabLayout: srng.weighted([['stack', 3], ['split', 2]] as const) as StabLayout,
    stabAnnounce: srng.weighted([[4, 2], [8, 3]] as const) as number,
    stabRoll: srng.weighted([['none', 2], ['eighths', 2], ['sixteenths', 1]] as const) as StabRoll,
    // Sometimes a hit of the loop moves (the house organ's lift): its last hit a tone up (most
    // often), a fourth, a minor third or a tone down; the loop's last hit, or every bar's.
    ...((mv, at, on) => ({ stabMove: on ? mv : 0, stabMoveAt: at }))(
      srng.weighted([[2, 4], [5, 2], [3, 1.5], [-2, 1.5]] as const) as number,
      srng.weighted([['loop', 3], ['bar', 2]] as const) as 'loop' | 'bar',
      srng.chance(STAB_MOVE_CHANCE)),
  }
  // A loop's drops hit open and whole: the filter opens before them (the announcement), not over them.
  if (stabLoopEarly) Object.assign(drawn, { stabsOpen: 'none', stabsGrow: false })
  // What the track drew, then what its character and its lead make of it; a real track's own
  // decisions, what is kept and what is locked go over those.
  const charOwn = character && stabLoopEarly ? Object.fromEntries(Object.entries(charRules).filter(([k]) => k !== 'stabsOpen')) : charRules
  const rules: typeof drawn = { ...drawn, ...(character ? charOwn as Partial<typeof drawn> : undefined), ...(leadRules(lead) as Partial<typeof drawn>),
    ...(tpl?.rules as Partial<typeof drawn> | undefined), ...(keep.rules as Partial<typeof drawn> | undefined),
    ...(opts.locks as Partial<typeof drawn> | undefined), character, lead }
  // A build-up or a roll sample into drops, not both: a locked roll goes without the build-up,
  // otherwise the build-up takes the roll's place (a fill can still lead in with it).
  if (rules.buildup !== 'none' && rules.dropFill === 'roll') {
    if (opts.locks && 'dropFill' in opts.locks && !('buildup' in opts.locks)) rules.buildup = 'none'
    else rules.dropFill = fills.length ? 'fill' : null
  }
  /** Kept from the track made before, or locked: not the track's own to change. */
  const given = (rule: string) => (!!keep.rules && rule in keep.rules) || (!!opts.locks && rule in opts.locks)
  // A gap before drops has the drum fill in it (unless the fills are locked out).
  if (rules.dropIn === 'gap' && !rules.dropFill && fills.length && !given('dropFill')) rules.dropFill = 'fill'
  // The drops after the long breakdown: the biggest, with the big build into them (rule `bigBuild`).
  const mainDrops = new Set<number>()
  sections.forEach((s, i) => {
    if (s.kind !== 'drop') return
    for (let j = i - 1; j >= 0 && sections[j].kind !== 'drop'; j--) if (sections[j].long) mainDrops.add(s.start)
  })
  const isBig = (drop: Section | undefined) => !!drop && drop.kind === 'drop' && rules.bigBuild === 'big' && mainDrops.has(drop.start)
  // How it builds: as the track it's built on does into that drop (its bars, its kick and claps
  // there), else like one of the user's tracks (their spread of lengths, and as often the kick and
  // the claps back in it), else 8 or 16 bars.
  if (rules.bigBuild === 'big' && (!given('bigBars') || rules.bigBars == null)) {
    const refs = opts.templates ?? []
    const code = sections.find((s) => mainDrops.has(s.start))?.src?.code
    const own = code ? refs.find((r) => r.source_code === code) : undefined
    const mine = own ? mainBuildOf(own) : null
    const theirs = mainBuilds(refs)
    const like = theirs.length >= 3 ? theirs : null
    rules.bigBars = mine?.bars ?? (like ? bigRng.pick(like).bars : bigRng.weighted([[8, 1], [16, 2]] as const))
    const share = (f: (x: typeof theirs[number]) => boolean) => like!.filter(f).length / like!.length
    if (!given('bigKick') && (mine || like)) {
      const back = mine ? mine.kick : bigRng.chance(share((x) => x.kick))
      rules.bigKick = back ? (rules.bigKick === 'roll' ? 'roll' : 'back') : 'out'
    }
    if (!given('bigDrums') && (mine || like)) {
      const claps = mine ? mine.claps : bigRng.chance(share((x) => x.claps))
      rules.bigDrums = claps ? (rules.bigDrums === 'snare' ? 'both' : rules.bigDrums) : 'snare'
    }
  }
  /** What the big build sends to reverb (and its drums to delay). */
  const bigFx = (what: 'drums' | 'stabs' | 'tops' | 'vocals') => rules.bigVerb === 'all' || String(rules.bigVerb ?? '').split('+').includes(what)
  /**
   * Bars the big build runs before the end of `sec` (the part before a big drop): reaching back
   * into the long breakdown when a build between them is shorter, never past the drop before.
   */
  const bigBarsIn = (sec: Section) => {
    let a = sec.start
    for (let j = sections.indexOf(sec) - 1; j >= 0 && sections[j].kind !== 'drop'; j--) a = sections[j].start
    return Math.max(1, Math.min(Number(rules.bigBars) || 16, sec.start + sec.bars - a))
  }
  const fxChance = { sparse: 0.45, normal: 0.75, busy: 0.95 }[rules.fx]
  const keptGaps = rules.dropGaps
  const dropGaps: Record<string, number> = {}
  const set = rules.dropSet ? sets.get(rules.dropSet) ?? null : null

  const lanes = new Lanes(total)
  const feel = feelSrc?.groove ? stepGroove(feelSrc.groove, rules.feel) : null
  lanes.feel = feel && audible(feel) ? feel : null
  if (bass && lanes.feel) bass.groove = lanes.feel.offsets
  const pitchOf = (role: Role) => role === 'perc2' ? rules.pitchPerc2 : role === 'hats2' ? rules.pitchHats2
    : rules.pitchTop && TOP_ROLES[rules.pitchTop[0]] === role ? rules.pitchTop[1] : null
  const loop = (role: Role, s: SampleListItem | null, fromBar: number, toBar: number, filter?: ClipFilter, gapBeats = 0) => {
    const pitch = pitchOf(role)
    if (s && toBar > fromBar) {
      lanes.add(role, { sample: s, start: fromBar * 4, length: (toBar - fromBar) * 4 - gapBeats, filter, ...(pitch ? { pitch } : {}) })
    }
  }
  /** A loop lane that may be a one-shot pattern when no loop was found. */
  const layer = (role: Role, s: SampleListItem | null, fromBar: number, toBar: number, shotSteps: Steps, filter?: ClipFilter, gapBeats = 0) => {
    if (!s) return
    if (s.kind === 'loop') loop(role, s, fromBar, toBar, filter, gapBeats)
    else for (let b = fromBar; b < toBar; b++) lanes.setBar(role, b, { sample: s, steps: shotSteps, filter })
  }
  const place = (role: Role, s: SampleListItem | null, startBeat: number) => {
    if (s) lanes.add(role, { sample: s, start: startBeat, length: (s.bars ?? 1) * 4 })
  }
  /** One sample per job for the whole track (the track's fill, roll, riser, …); another only if it doesn't fit. */
  const chosen = new Map<string, SampleListItem>()
  const trackPick = (job: string, cands: SampleListItem[], tonal = false) => {
    let s = chosen.get(job) ?? null
    if (!s || !cands.some((c) => c.id === s!.id)) {
      s = picker.pick(cands, { tonal })
      if (s && !chosen.has(job)) chosen.set(job, s)
    }
    return s
  }
  /**
   * An event (riser, roll, fill) whose body ends on `endBeat`, if one fits in `room` beats: its
   * own silence before the line comes with it (a riser stopping on beat 7 of 8 leaves the
   * producer's beat of silence). With `gap`, only events stopping that early (gapsAgree).
   */
  const endOn = (job: string, role: Role, cands: SampleListItem[], endBeat: number, room: number, want: number, tonal = false,
                 gap?: number, weight?: (s: SampleListItem) => number) => {
    // Tonal FX in the key when the library has any there, even if that leaves none that fit.
    const inKey = tonal && tonalKeys ? cands.filter((s) => s.key_label && tonalKeys.has(s.key_label)) : []
    const fit = (inKey.length ? inKey : cands)
      .filter((s) => bodyBars(s) * 4 <= room && leads(s) && (gap == null || gapsAgree(gapOf(s), gap)))
    let s = chosen.get(job) ?? null
    if (!s || !fit.some((c) => c.id === s!.id)) {
      s = picker.pick(fit, { tonal, weight: (x) => (weight?.(x) ?? 1) / (1 + Math.abs(bodyBars(x) - want)) })
      if (s && !chosen.has(job)) chosen.set(job, s)
    }
    if (s) place(role, s, endBeat - bodyBars(s) * 4)
    return s
  }
  /** Place on the first of `roles` with nothing playing there yet (FX lanes don't stack sounds). */
  const placeFree = (roles: Role[], s: SampleListItem | null, startBeat: number) => {
    if (!s) return null
    const len = (s.bars ?? 1) * 4
    const role = roles.find((r) => !(lanes.segs.get(r) ?? []).some((x) => x.start < startBeat + len && x.start + x.length > startBeat))
    if (role) place(role, s, startBeat)
    return role ? s : null
  }
  // The producer's own FX into a drop: their riser(s), fill or roll and impact are the track's
  // picks for those jobs (used wherever they fit, as any pick).
  if (set) {
    const seed = (job: string, s: SampleListItem | undefined) => {
      if (s && picker.fresh(s) && !chosen.has(job)) chosen.set(job, picker.use(s))
    }
    const up = set.filter(rising).sort((a, b) => bodyBars(b) - bodyBars(a))
    for (const job of ['riser', 'riser-long']) seed(job, up[0])
    seed('riser2', up[1])
    for (const job of ['roll', 'roll-long']) seed(job, set.find((s) => s.category === 'roll'))
    seed('fill', set.find((s) => s.category === 'fill' && leads(s)))
    seed('impact', set.find((s) => s.category === 'fx_impact'))
    seed('drop-down', set.find(falling))
  }

  // The bass part as a loop "sample" (its file is rendered through Serum for this tempo).
  const bassRender: BassRender | null = bass ? bassRenderOf(bass) : null
  const bassSample: SampleListItem | null = bass && bassRender ? {
    id: bass.midi.id > 0 ? -bass.midi.id : bass.midi.id - 2_000_000_000, rel_path: bassPath(bassRender, bpm), name: `${bass.preset.name} · ${bass.midi.name}`, kind: 'loop',
    category: 'melodic', bpm, bars: bassBars(bass), body_bars: null, key_label: key, key_camelot: null,
    duration_s: (bassBars(bass) * BEATS_PER_BAR * 60) / bpm, channels: 2, favorite: 0, rating: null, tags: null,
    zip_id: -1, source_code: 'Serum',
  } : null
  const bassPart = (from: number, to: number, filter?: ClipFilter, gapBeats = 0) => {
    if (bassSample && bassRender && to > from) {
      lanes.add('bass', { sample: bassSample, start: from * 4, length: (to - from) * 4 - gapBeats, filter, bass: bassRender })
    }
  }
  // The turn (rule `bassTurn`): the loop with its last beat changed, as its own clip in the last
  // loop of a phrase (a line with its notes at hand: written, or edited).
  const bassLoopBars = bass ? bassBars(bass) : 1
  const bassTurnRender: BassRender | null = bassRender?.notes?.length && rules.bassTurn && rules.bassTurn !== 'none'
    ? { ...bassRender, turn: rules.bassTurnKind as BassTurn } : null
  const bassTurnSample: SampleListItem | null = bassTurnRender && bassSample ? { ...bassSample, rel_path: bassPath(bassTurnRender, bpm) } : null
  /** A drop's bassline: the loop all through, turned in the last loop before each phrase line the rule turns on (and the drop's end). */
  const bassDrop = (from: number, to: number, gapBeats: number) => {
    if (!bassTurnRender || !bassTurnSample) return bassPart(from, to, undefined, gapBeats)
    const every = rules.bassTurn === '8' ? 8 : rules.bassTurn === '16' ? 16 : Infinity
    const ends: number[] = []
    for (let p = from + every; p < to; p += every) ends.push(p)
    ends.push(to)
    let at = from
    for (const end of ends) {
      const t = end - bassLoopBars
      if (t < at + bassLoopBars) continue  // (a phrase no longer than the loop: no room for a turn)
      bassPart(at, t)
      lanes.add('bass', { sample: bassTurnSample, start: t * 4, length: bassLoopBars * 4 - (end === to ? gapBeats : 0), bass: bassTurnRender })
      at = end
    }
    if (at < to) bassPart(at, to, undefined, gapBeats)
  }

  /**
   * What each stab lane plays of the track's stab rhythm (their turns in it, or their jobs in one
   * loop: the main sound, a layer on it, the pickups), and its pitch in the track key.
   */
  const two = (r: Velocity[][]) => [r[0], r[1 % r.length]]
  const stabLoop = !!rules.stabFit && !!rules.stabLoop && stabs.length > 0
  const stabJobs: StabJob[] | null = stabLoop
    ? loopJobs(two(rules.stabRhythm), Math.min(Number(rules.stabCount ?? 1), stabs.length), (rules.stabLayout ?? 'stack') as StabLayout) : null
  const stabSteps = !stabs.length ? [] : stabJobs ? loopParts(rules.stabRhythm, stabJobs)
    : stabParts(rules.stabRhythm, Math.min(Number(rules.stabCount ?? 1), stabs.length), rules.stabTurns)
  stabs.splice(stabSteps.length)
  for (const role of STAB_ROLES.slice(stabs.length)) delete picks[role]
  const stabPitch = stabs.map((x) => (stabOf.has(x.rel_path) ? hitPitch(stabOf.get(x.rel_path)!, key) : 0))
  /** The stab rhythm over [from, to) bars, a bar at a time (a sweeping filter moving bar by bar). */
  const stabBars = (from: number, to: number, filter?: ClipFilter) => {
    const hz = (b: number) => Math.round(filter!.from * ((filter!.to ?? filter!.from) / filter!.from) ** ((b - from) / (to - from)))
    stabs.forEach((x, i) => {
      for (let b = from; b < to; b++) {
        const f = filter && (filter.to == null ? filter : { ...filter, from: hz(b), to: hz(b + 1) })
        lanes.setBar(STAB_ROLES[i], b, {
          sample: x, steps: [...stabSteps[i][(b - from) % stabSteps[i].length]], ...(f ? { filter: f } : {}), ...(stabPitch[i] ? { pitch: stabPitch[i] } : {}),
        })
      }
    })
  }

  // ---- stabs that fit (rule `stabFit`): the rhythm with its accents, its lean version and its turn at
  // the end of a phrase, each as the stabs' parts; a gate where a stab would ring into the next.
  // One loop (rule `stabLoop`): every hit full (the accents of the track), the lean version on its
  // anchor, a layer hitting with the main sound ----
  const stabFit = !!rules.stabFit && stabs.length > 0
  lanes.stabFeel = stabFit
  const stabN = stabSteps.length
  const stabFull = stabLoop ? rules.stabRhythm : stabFit ? accented(rules.stabRhythm) : rules.stabRhythm
  const partsOf = (r: Velocity[][]) => (stabJobs ? loopParts(r, stabJobs) : stabParts(r, stabN, rules.stabTurns))
  const stabVariants = stabFit ? {
    full: partsOf(two(stabFull)),
    lean: partsOf(sparse(two(stabFull), stabLoop)),
    // (The last bar of a phrase is always the rhythm's second bar: phrases are 8 bars.)
    turn: partsOf([two(stabFull)[0], turned(two(stabFull)[1], rules.stabTurn as StabTurn)]),
  } : null
  const gapBeats = (closestGap(two(stabFull)) / 4) * STAB_GATE_SHARE
  /** How long each stab rings (beats, at the pitch it plays). */
  const stabRings = stabs.map((x, i) => (x.duration_s / 2 ** ((stabPitch[i] ?? 0) / 12)) * (bpm / 60))
  const gateFor = (i: number, gap: number) => (stabFit && stabRings[i] > gap ? Math.max(STAB_GATE_MIN_BEATS, Math.round(gap * 16) / 16) : undefined)
  const stabGate = stabs.map((_, i) => gateFor(i, gapBeats))
  /** A loop's layer sits under the main sound (dB). */
  const stabLayerDb = stabs.map((_, i) => (stabJobs?.[i] === 'layer' ? STAB_LAYER_DB : 0))
  const stabRollSteps = stabLoop ? rollBar((rules.stabRoll ?? 'none') as StabRoll) : null
  /** The roll's gate: its 16ths (or 8ths) never ringing into each other. */
  const rollGate = stabs.map((_, i) => gateFor(i, ((rules.stabRoll === 'eighths' ? 2 : 1) / 4) * STAB_GATE_SHARE))
  /**
   * A loop's moved hit (rule `stabMove`, the house organ's lift): semitones on the last hit of
   * the loop (its second bar; a 1-bar loop's every bar) or of every bar, per step of the bar
   * (`hits`: what all the stabs play in it; `other`: in the loop's other bar), or undefined where
   * nothing moves. The move answers the loop's own hits: a loop (or, for every bar, a bar) of one
   * hit doesn't move.
   */
  const stabMove = stabLoop ? Number(rules.stabMove ?? 0) : 0
  const loopOf2 = rules.stabMoveAt === 'loop' && rules.stabRhythm.length > 1
  let stabMoved = false
  const moveOf = (hits: Velocity[][], other: Velocity[][], k: number): number[] | undefined => {
    if (!stabMove || (loopOf2 && k % 2 === 0)) return undefined
    const steps = (b: Velocity[][]) => Array.from({ length: STEPS_PER_BAR }, (_, j) => b.some((p) => p[j])).filter(Boolean).length
    const at = Array.from({ length: STEPS_PER_BAR }, (_, j) => hits.some((p) => p[j])).lastIndexOf(true)
    if (at < 0 || steps(hits) + (loopOf2 ? steps(other) : 0) < 2) return undefined
    stabMoved = true
    return Array.from({ length: STEPS_PER_BAR }, (_, j) => (j === at ? stabMove : 0))
  }
  /**
   * One bar of the stabs: `which` version of the rhythm (bar `k` of its two), low-passed from
   * `hz[0]` to `hz[1]` over the bar (resonance `q`), `db` down, no hit louder than `cap`, its send
   * to the room, a delay throw (`echo`: true for the usual one, or how much). A loop's `roll` takes
   * the bar's place (the main sound and its layer), and `dryFrom` leaves the bar empty from that 16th.
   */
  const stabBar = (b: number, k: number, o: { which?: 'full' | 'lean' | 'turn'; hz?: [number, number]; q?: number; db?: number; cap?: Velocity;
    echo?: boolean | number; room?: number; roll?: Velocity[] | null; dryFrom?: number } = {}) => {
    const parts = stabVariants![o.which ?? 'full']
    const bars = stabs.map((_, i) => (o.roll ? (stabJobs?.[i] === 'pickups' ? [] : o.roll) : parts[i]?.[k % 2] ?? [])
      .map((v, j) => (o.dryFrom != null && j >= o.dryFrom ? 0 : Math.min(v, o.cap ?? 3))) as Steps)
    const bend = o.roll ? undefined : moveOf(bars, stabs.map((_, i) => parts[i]?.[(k + 1) % 2] ?? []), k)
    stabs.forEach((x, i) => {
      const s_ = bars[i]
      if (!s_.some(Boolean)) { lanes.setBar(STAB_ROLES[i], b, null); return }
      const filter: ClipFilter | undefined = o.hz && { type: 'lowpass', from: Math.round(o.hz[0]), to: Math.round(o.hz[1]) === Math.round(o.hz[0]) ? null : Math.round(o.hz[1]), q: o.q ?? 0.8 }
      const gate = o.roll ? rollGate[i] : stabGate[i]
      const db = (o.db ?? 0) + stabLayerDb[i]
      const echo = o.echo === true ? STAB_ECHO : o.echo || 0
      lanes.setBar(STAB_ROLES[i], b, {
        sample: x, steps: s_, room: o.room ?? STAB_ROOM, ...(filter ? { filter } : {}), ...(stabPitch[i] ? { pitch: stabPitch[i] } : {}),
        ...(db ? { gainDb: db } : {}), ...(gate ? { gate } : {}), ...(echo ? { echo } : {}), ...(bend && s_.some((v, j) => v && bend[j]) ? { bend } : {}),
      })
    })
  }
  /** The cutoff `t` of the way (0…1) from `f0` to `f1` (evenly in pitch). */
  const sweepHz = (f0: number, f1: number, t: number) => f0 * (f1 / f0) ** Math.max(0, Math.min(1, t))
  /** Where a loop's announcement starts (Hz): darker than the track's cutoff. */
  const announceHz = () => Math.max(STAB_ANNOUNCE_MIN_HZ, Number(rules.stabsCutoff) * STAB_ANNOUNCE_FROM)
  /**
   * A loop announcing the drop at bar `z` over the `n` bars before it: low-passed and opening with
   * its resonance rising, the room and the delay growing, a little down at first; its last bar the
   * roll (by the track's rule) and dry for the last beat, thrown into the delay, so its echoes ring
   * into the silence and the drop comes in dry, open and whole.
   */
  const announce = (z: number, n: number) => {
    const from = announceHz()
    const r2 = (x: number) => Math.round(x * 100) / 100
    for (let j = 0; j < n; j++) {
      const t0 = j / n, t1 = (j + 1) / n
      const last = j === n - 1
      // (Bar k of the rhythm: the bar before the drop is the loop's second.)
      stabBar(z - n + j, j - n + 2 * n, {
        hz: [sweepHz(from, STAB_ANNOUNCE_HZ, t0), sweepHz(from, STAB_ANNOUNCE_HZ, t1)],
        q: Math.round((STAB_ANNOUNCE_Q[0] + (STAB_ANNOUNCE_Q[1] - STAB_ANNOUNCE_Q[0]) * t1 ** 1.5) * 10) / 10,
        room: r2(STAB_ROOM + (STAB_ANNOUNCE_ROOM - STAB_ROOM) * t1),
        echo: last ? STAB_THROW : r2(STAB_ANNOUNCE_ECHO[0] + (STAB_ANNOUNCE_ECHO[1] - STAB_ANNOUNCE_ECHO[0]) * t0),
        db: Math.round(STAB_ANNOUNCE_DB * (1 - t0) * 2) / 2,
        ...(last ? { roll: stabRollSteps, dryFrom: STAB_DRY_FROM } : {}),
      })
    }
  }
  /** Bars a loop announces the drop after `sec` over: the track's (4 or 8), at most a build's length or half a breakdown; in an intro only its tease's. */
  const announceBars = (sec: Section, next: Section | undefined) => {
    if (!stabLoop || next?.kind !== 'drop') return 0
    // (Into a big drop, with the stabs in the big build's effects: over the whole build.)
    if (isBig(next) && bigFx('stabs') && (sec.kind === 'build' || sec.kind === 'break')) return Math.min(bigBarsIn(sec), sec.bars)
    const want = Number(rules.stabAnnounce ?? 8)
    if (sec.kind === 'build') return Math.min(want, sec.bars)
    if (sec.kind === 'break') return Math.min(want, Math.max(2, Math.floor(sec.bars / 2)))
    if (sec.kind === 'intro') return rules.stabsTease && sec.bars >= STAB_TEASE_MIN_INTRO ? Math.min(want, STAB_TEASE_BARS) : 0
    return 0
  }
  /** The stabs through a section, by the track's rules (stabs that fit). `drop`: which drop this is (0 the first). */
  const stabsFit = (sec: Section, next: Section | undefined, drop: number) => {
    const a = sec.start
    const z = sec.start + sec.bars
    const n = sec.bars
    const cut = Number(rules.stabsCutoff)
    const keys = rules.stabsIn === 'keys'
    const phraseEnd = (b: number) => (b - a) % PHRASE === PHRASE - 1
    // A loop announces the drop after this section over its last bars: the rest of it ends there.
    const ann = announceBars(sec, next)
    const end = z - ann
    if (sec.kind === 'drop') {
      const half = a + halfwayBars(n)
      // A slow opening over the drop's first bars: the first drop's, or every drop's.
      const opening = rules.stabsOpen === 'each' || (rules.stabsOpen === 'first' && drop === 0)
        ? Math.min(32, Math.max(PHRASE, Math.floor(n / 2 / PHRASE) * PHRASE)) : 0
      for (let b = a; b < z; b++) {
        const lean = rules.stabsGrow && drop === 0 && b < half
        const echo = rules.stabEcho === '8' ? phraseEnd(b) : rules.stabEcho === '16' ? (b - a) % (2 * PHRASE) === 2 * PHRASE - 1
          : rules.stabEcho === 'breaks' ? b === z - 1 && next?.kind === 'break' : false
        const j = b - a
        stabBar(b, j, {
          which: lean ? 'lean' : phraseEnd(b) && rules.stabTurn !== 'none' ? 'turn' : 'full', echo,
          ...(j < opening ? { hz: [sweepHz(cut, STAB_OPEN_HZ, j / opening), sweepHz(cut, STAB_OPEN_HZ, (j + 1) / opening)] as [number, number] } : {}),
        })
      }
    } else if (sec.kind === 'break' && lead === 'stab') {
      // The track's lead, exposed: by its own rhythm in the clear from the breakdown's second part
      // on (a delay throw at the end of each phrase), after leaving the line darker and softer.
      const from = breakShape(a, n).lead
      for (let j = 0; j < Math.min(2, from - a); j++) stabBar(a + j, j, { hz: [sweepHz(6000, cut, j / 2), sweepHz(6000, cut, (j + 1) / 2)], db: STAB_FADE_DB * (j + 1), cap: j ? 1 : 2 })
      for (let b = from; b < end; b++) stabBar(b, b - a, { which: phraseEnd(b) && rules.stabTurn !== 'none' ? 'turn' : 'full', echo: phraseEnd(b) })
    } else if (sec.kind === 'break') {
      const playing = STAB_ROLES.some((r) => lanes.bar(r, a - 1))
      const opens = !!next && next.kind !== 'outro'
      if (keys && rules.stabsBreaks === 'filtered') {
        // They stay, as the drums do: closing over the first bars, held softer and dark, opening into the next part
        // (a loop's announcement in place of the opening).
        const close = Math.min(GLUE_CLOSE_BARS, Math.max(1, Math.floor(n / 4)))
        const open = ann ? 0 : opens ? Math.min(Number(rules.glueOpen ?? PHRASE), Math.max(2, Math.floor(n / 2))) : 0
        const bare = !!sec.long && end - open - (a + close) >= GLUE_BARE_MIN_BARS
        for (let b = a; b < end; b++) {
          const j = b - a
          if (j < close) stabBar(b, j, { hz: [sweepHz(STAB_OPEN_HZ, cut, j / close), sweepHz(STAB_OPEN_HZ, cut, (j + 1) / close)], db: Math.round(STAB_BREAK_DB * ((j + 1) / close) * 2) / 2, cap: 2 })
          else if (b >= end - open) {
            const t = (b - (end - open)) / open
            stabBar(b, j, { hz: [sweepHz(cut, STAB_OPEN_HZ, t), sweepHz(cut, STAB_OPEN_HZ, t + 1 / open)], db: Math.round(STAB_BREAK_DB * (1 - t) * 2) / 2, cap: 2 })
          } else if (!bare || b < a + close + 4) stabBar(b, j, { hz: [cut, cut], db: STAB_BREAK_DB, cap: 2 })
        }
      } else if (playing) {
        // They leave across the line: two bars darker and softer, not a hard stop.
        for (let j = 0; j < Math.min(2, n - ann); j++) stabBar(a + j, j, { hz: [sweepHz(6000, cut, j / 2), sweepHz(6000, cut, (j + 1) / 2)], db: STAB_FADE_DB * (j + 1), cap: j ? 1 : 2 })
      }
    } else if (sec.kind === 'build') {
      if (stabLoop) {
        // A loop plays the build dark (by the track's rule), then announces the drop.
        if (rules.stabsBuild !== 'none') {
          for (let b = a; b < end; b++) stabBar(b, b - a, { hz: [announceHz(), announceHz()], db: STAB_ANNOUNCE_DB })
        }
      } else if (keys && rules.stabsBuild !== 'none') {
        for (let b = a; b < z; b++) {
          const j = b - a
          stabBar(b, j, { hz: rules.stabsBuild === 'sweep' ? [sweepHz(cut, 8000, j / n), sweepHz(cut, 8000, (j + 1) / n)] : [cut, cut], cap: 2 })
        }
      }
    } else if (sec.kind === 'intro') {
      // A dark tease of the lean rhythm at the end of a long intro (16 bars of it stay clean); a
      // loop going straight into the drop announces it instead.
      if (!ann && rules.stabsTease && n >= STAB_TEASE_MIN_INTRO && (next?.kind === 'drop' || next?.kind === 'build')) {
        for (let b = z - STAB_TEASE_BARS; b < z; b++) {
          const t = (b - (z - STAB_TEASE_BARS)) / STAB_TEASE_BARS
          stabBar(b, b - a, { which: 'lean', hz: [sweepHz(cut * 0.7, cut * 1.6, t), sweepHz(cut * 0.7, cut * 1.6, t + 1 / STAB_TEASE_BARS)], db: STAB_TEASE_DB, cap: 2 })
        }
      }
    }
    if (ann) announce(z, ann)
  }

  const crashAt = new Set<number>()
  const percShotGlue = steps([3, 7, 10, 14], 2)
  // (A track led by its stabs keeps a top loop less: room for them.)
  const tracks = { tops: Math.max(1, Math.min(tops.length, rules.dropTops) - (lead === 'stab' && tops.length > 1 ? 1 : 0)) }
  /**
   * The lift of an intro (rule `ioLift`): what the drops have that it doesn't yet, in the order it
   * joins (hats, perc, a second top loop, claps), each with the bars before the intro's end it
   * comes in at, spread over its last 8 bars (16 in an intro of 32 or more) on 4-bar steps. The
   * outro lets them go the same way, from its start.
   */
  const liftOf = (sec: Section): [LiftRole, number][] => {
    if (!rules.ioLift || (sec.kind !== 'intro' && sec.kind !== 'outro')) return []
    const missing = ([
      ['hats', !!hats && (sec.kind === 'intro' ? rules.introHats : rules.outroHats) === 'none'],
      ['perc', !!perc && !rules.ioPerc],
      ['top2', tops.length > 1 && rules.ioTopSecond == null],
      ['clap', !!clap && !rules.ioClaps],
    ] as const).filter(([, m]) => m).map(([r]) => r)
    const w = liftBars(sec.bars)
    return missing.map((r, k) => [r, w - Math.floor((k * w) / 4 / missing.length) * 4])
  }
  /**
   * The track's build-up over the last bars of `sec`, into the drop after it: bar by bar on the
   * Build-up lane, louder as it goes (a kick roll or claps take the kick or clap lane's place there).
   */
  const buildUp = (sec: Section) => {
    const type = rules.buildup as Buildup
    if (type === 'none') return
    const sample = type === 'kickRoll' ? kick : type === 'claps' ? clap : snare
    if (!sample) return
    const z = sec.start + sec.bars
    // At most half the section, a quarter of an intro (its mix-in half stays the intro's).
    const n = Math.min(rules.buildupBars, Math.max(1, Math.floor(sec.bars / (sec.kind === 'intro' ? 4 : 2))))
    const a = z - n
    const fromDb = BUILDUP_FROM_DB[type]
    const db = (bar: number) => Math.round(fromDb * (1 - (bar - a) / n) * 2) / 2 || 0
    const sweep = (f0: number, f1: number, x0: number, x1: number, type_: ClipFilter['type'], n_: number): ClipFilter => ({
      type: type_, from: Math.round(f0 * (f1 / f0) ** (x0 / n_)), to: Math.round(f0 * (f1 / f0) ** (x1 / n_)), q: 0.7,
    })
    // The snare roll: low-pass opening, then a high-pass thinning it out over its last quarter.
    const hpBars = Math.ceil(n / 4)
    const lpBars = n - hpBars
    for (let b = a; b < z; b++) {
      const j = b - a
      const s_ = new Array(STEPS_PER_BAR).fill(0) as Steps
      for (let k = 0; k < STEPS_PER_BAR; k++) {
        const t = (j * STEPS_PER_BAR + k) / (n * STEPS_PER_BAR)
        const on = type === 'snareRoll' ? true
          : type === 'snareSteps' ? (t < 1 / 3 ? k % 4 === 0 : t < 2 / 3 ? k % 2 === 0 : true)
            : type === 'kickRoll' ? k % 2 === 0 : k % 4 === 0
        if (!on) continue
        s_[k] = (type === 'snareRoll' ? (t < 1 / 3 ? 1 : t < 2 / 3 ? 2 : 3) : type === 'kickRoll' ? 3 : t < 1 / 2 ? 2 : 3) as Velocity
      }
      const filter = type === 'snareRoll'
        ? (j < lpBars ? sweep(ROLL_LP_FROM_HZ, ROLL_LP_TO_HZ, j, j + 1, 'lowpass', lpBars) : sweep(ROLL_HP_FROM_HZ, ROLL_HP_TO_HZ, j - lpBars, j - lpBars + 1, 'highpass', hpBars))
        : type === 'kickRoll' ? sweep(KICK_ROLL_LP_FROM_HZ, KICK_ROLL_LP_TO_HZ, j, j + 1, 'lowpass', n) : undefined
      lanes.setBar('buildup', b, { sample, steps: s_, ...(filter ? { filter } : {}), gainDb: db(b), gainTo: db(b + 1) })
      if (type === 'kickRoll') lanes.setBar('kick', b, null)
      if (type === 'claps') for (const r of CLAP_ROLES) lanes.setBar(r, b, null)
    }
    if (sample === snare) picks.buildup = snare
    built = n
  }
  /** The sections before big drops, their big builds laid after the groove through the breakdowns; the bars the last one ran. */
  const bigBuilds: Section[] = []
  let bigBuilt = 0
  /**
   * The big build (rule `bigBuild`) over the last bars of `sec`, into a drop after the long
   * breakdown: claps building (on the beat, 8ths, 16ths over the last quarter), a snare joining
   * halfway (a roll in 8ths then 16ths, or steps 4ths → 8ths → 16ths), each louder and opening as it
   * goes; the kick out, back four on the floor over the second half, or rolling over the last
   * quarter (the bar before the drop as the track does it); reverb rising on the drums and a delay
   * throw on the last bar of each four (by the build's effects), the drop dry.
   */
  const bigBuildUp = (sec: Section) => {
    const z = sec.start + sec.bars
    const n = bigBarsIn(sec)
    const a = z - n
    // (A roll sample leading into the drop is the snare roll: the claps build under it instead of a snare of its own.)
    const rolled = rules.dropFill === 'roll'
    const useClaps = (rules.bigDrums !== 'snare' || rolled) && !!clap
    const useSnare = !rolled && (rules.bigDrums !== 'claps' || !clap) && !!snare && !(useClaps && snare.id === clap?.id)
    const wet = !!opts.verb && bigFx('drums')
    const throws = bigFx('drums')
    const rise = (x: number) => Math.round(BIG_VERB_PEAK * Math.min(1, Math.max(0, x)) ** 2 * 100) / 100
    const db = (x: number, from: number) => Math.round(from * (1 - x) * 2) / 2 || 0
    const lp = (f0: number, f1: number, x0: number, x1: number): ClipFilter => ({
      type: 'lowpass', from: Math.round(f0 * (f1 / f0) ** x0), to: Math.round(f0 * (f1 / f0) ** x1), q: 0.7,
    })
    const on = (every: number, vel: Velocity) => Array.from({ length: STEPS_PER_BAR }, (_, k) => (k % every === 0 ? vel : 0)) as Steps
    // Over the mix high-pass's bars into the drop the build's drums thin out instead (a clip has one
    // filter: the high-pass there takes the low-pass's place).
    const hpN = Math.min(n, Math.max(Number(rules.mixHp ?? 0), Number(rules.bigHp ?? 0)))
    const thin = (b: number, f: ClipFilter): ClipFilter => {
      if (b < z - hpN) return f
      const hz = (x: number) => Math.round(MIX_HP_FROM_HZ * (MIX_HP_TO_HZ / MIX_HP_FROM_HZ) ** ((x - (z - hpN)) / hpN))
      return { type: 'highpass', from: hz(b), to: hz(b + 1), q: 0.7 }
    }
    const fxOf = (b: number, x0: number, x1: number) => ({
      ...(wet ? { verb: { from: rise(x0), to: rise(x1) } } : {}),
      ...(throws && (b - a + 1) % 4 === 0 ? { echo: b === z - 1 ? BIG_ECHO_LAST : BIG_ECHO } : {}),
    })
    const s0 = useClaps ? Math.floor(n / 2) : 0
    for (let b = a; b < z; b++) {
      const x0 = (b - a) / n
      const x1 = (b - a + 1) / n
      if (useClaps) {
        const every = x0 < 0.5 ? 4 : x0 < 0.75 ? 2 : 1
        lanes.setBar('clap', b, { sample: clap!, steps: on(every, x0 < 0.5 ? 2 : 3), filter: thin(b, lp(BIG_CLAP_LP_FROM_HZ, BIG_OPEN_HZ, x0, x1)),
          gainDb: db(x0, BIG_CLAPS_FROM_DB), gainTo: db(x1, BIG_CLAPS_FROM_DB), ...fxOf(b, x0, x1) })
        for (const r of CLAP_ROLES.slice(1)) lanes.setBar(r, b, null)
      }
      if (useSnare && b - a >= s0) {
        const m = n - s0
        const y0 = (b - a - s0) / m
        const y1 = (b - a - s0 + 1) / m
        const every = rules.bigSnare === 'steps' ? (y0 < 1 / 3 ? 4 : y0 < 2 / 3 ? 2 : 1) : y0 < 0.5 ? 2 : 1
        lanes.setBar('buildup', b, { sample: snare!, steps: on(every, y0 < 0.5 ? 2 : 3), filter: thin(b, lp(ROLL_LP_FROM_HZ, BIG_OPEN_HZ, y0, y1)),
          gainDb: db(y0, BIG_SNARE_FROM_DB), gainTo: db(y1, BIG_SNARE_FROM_DB), ...fxOf(b, x0, x1) })
      }
    }
    if (kick) {
      const k0 = rules.bigKick === 'back' ? a + Math.floor(n / 2) : rules.bigKick === 'roll' ? z - Math.max(2, Math.floor(n / 4)) : a
      for (let b = a; b < z; b++) {
        if (rules.bigKick === 'out') { lanes.setBar('kick', b, null); continue }
        if (b < k0) {
          // (The breakdown's own kick until it comes back: thinning out under the high-pass too.)
          const p = lanes.bar('kick', b)
          if (p && b >= z - hpN) lanes.setBar('kick', b, { ...p, filter: thin(b, p.filter ?? { type: 'highpass', from: MIX_HP_FROM_HZ, to: null, q: 0.7 }) })
          continue
        }
        if (b === z - 1 && rules.dropKickOut) { lanes.setBar('kick', b, null); continue }
        const m = z - k0
        const y0 = (b - k0) / m
        const y1 = (b - k0 + 1) / m
        const s_ = rules.bigKick === 'roll' ? on(b === z - 1 ? 1 : 2, 3)
          : b === z - 1 && rules.dropLastKick ? steps([0, 4, 8]) : on(4, 3)
        lanes.setBar('kick', b, { sample: kick, steps: s_, filter: thin(b, lp(KICK_ROLL_LP_FROM_HZ, KICK_ROLL_LP_TO_HZ, y0, y1)),
          gainDb: db(y0, BIG_KICK_FROM_DB), gainTo: db(y1, BIG_KICK_FROM_DB) })
      }
    }
    if (useSnare) picks.buildup = snare!
    bigBuilt = n
  }
  let built = 0

  let dropIndex = 0
  sections.forEach((sec, i) => {
    const a = sec.start
    const z = sec.start + sec.bars
    const next = sections[i + 1]
    const intoDrop = next?.kind === 'drop'
    const intoBreak = next?.kind === 'break'
    const half = a + halfwayBars(sec.bars)
    // A first drop straight after the intro starts leaner (rule `firstDrop`): the clap layers and
    // the second hat loop join after its first phrase, its last top loop, the groove and the second
    // perc halfway (bars `leanEarly`, `leanLate`; the drop's start otherwise).
    const lean = sec.kind === 'drop' && dropIndex === 0 && sections[i - 1]?.kind === 'intro' && rules.firstDrop === 'lean'
    const leanEarly = lean ? Math.min(z, a + PHRASE) : a
    const leanLate = lean ? (sec.bars >= 2 * PHRASE ? half : z) : a
    /** Bars where a 16-bar part starts inside this section (bar 17, 33, …). */
    const marks: number[] = []
    for (let b = a + 2 * PHRASE; b < z; b += 2 * PHRASE) marks.push(b)

    // ---- kick ----
    const kickBar = (b: number, s: Steps, filter?: ClipFilter) => kick && lanes.setBar('kick', b, { sample: kick, steps: s, filter })
    if (sec.kind === 'break') {
      const mode = sec.kick ?? 'out'
      const filter: ClipFilter | undefined = mode === 'filtered' ? { type: 'lowpass', from: rng.int(150, 400), to: null, q: 0.9 }
        : mode === 'sweep' ? { type: 'lowpass', from: 120, to: 16000, q: 1.2 }
          : mode === 'thin' ? { type: 'highpass', from: rng.int(180, 350), to: null, q: 0.7 } : undefined
      const pat = mode === 'downbeats' ? steps([0]) : steps(FOUR)
      if (mode !== 'out') for (let b = a; b < z; b++) kickBar(b, pat, filter)
      if (mode !== 'out' && intoDrop && rules.dropKickOut) lanes.setBar('kick', z - 1, null)
      else if (mode !== 'out' && mode !== 'sweep' && intoDrop && rules.dropLastKick) kickBar(z - 1, steps([0, 4, 8]), filter)
    } else if (sec.kind === 'intro' || sec.kind === 'outro') {
      // DJ intro/outro: a steady, slightly high-passed kick; crashes follow the track's 16-bar rule.
      for (let b = a; b < z; b++) kickBar(b, steps(FOUR), { type: 'highpass', from: rules.ioKickHp, to: null, q: 0.7 })
      if (rules.phraseCrash) for (const m of marks) crashAt.add(m)
    } else {
      for (let b = a; b < z; b++) kickBar(b, steps(FOUR))
      if (sec.kind === 'drop') {
        for (let b = a + PHRASE; b < z; b += PHRASE) {
          if (marks.includes(b)) {
            if (rules.phraseKickOut) lanes.setBar('kick', b - 1, null)
            if (rules.phraseKickOut || rules.phraseCrash) crashAt.add(b)
          } else {
            if (rules.kickEnd8) kickBar(b - 1, rules.kickEnd8)
            if (rules.crash8) crashAt.add(b)
          }
        }
      }
      if (intoDrop && rules.dropKickOut) lanes.setBar('kick', z - 1, null)
      else if ((intoDrop && rules.dropLastKick) || (intoBreak && rules.breakLastKick)) kickBar(z - 1, steps([0, 4, 8]))
    }

    // ---- clap ----
    const clapBar = (b: number, s: Steps) => clap && lanes.setBar('clap', b, { sample: clap, steps: s })
    /** All clap layers together (drops). */
    const clapsBar = (b: number, s: Steps) => claps.forEach((c, i) => lanes.setBar(CLAP_ROLES[i], b, { sample: c, steps: s }))
    if (sec.kind === 'drop') {
      const s = steps(TWO_FOUR)
      if (rules.clapGhost != null) s[rules.clapGhost] = 1
      for (let b = a; b < z; b++) (b < leanEarly ? clapBar : clapsBar)(b, s)
      const every = rules.clapRolls === '8' ? PHRASE : 2 * PHRASE
      if (rules.clapRolls !== 'none') {
        for (let b = a + every - 1; b < z; b += every) (b < leanEarly ? clapBar : clapsBar)(b, [0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 2, 2, 3, 3])
      }
    } else if (sec.kind === 'build') {
      const style_ = sec.build ?? 'layered'
      for (let b = a; b < z; b++) {
        const t = (b - a) / sec.bars
        if (style_ === 'doubletime') {
          // Density doubles towards the drop: quarters, 8ths, 16ths, louder as it goes.
          clapBar(b, t < 1 / 3 ? steps(FOUR, 2) : t < 2 / 3 ? steps(EIGHTHS, 2) : steps(SIXTEENTHS, b === z - 1 ? 3 : 2))
        } else if (style_ !== 'layered' || b >= a + Math.min(PHRASE, sec.bars / 2)) {
          clapBar(b, steps(TWO_FOUR))
        }
      }
    } else if (sec.kind === 'break') {
      // (With the groove carried through, the breaks' drums are written after the sections: `carry`.)
      if (rng.chance(0.3) && !rules.glue) for (let b = a; b < z; b++) clapBar(b, steps(TWO_FOUR, 2))
    } else if (sec.kind === 'intro' && rules.ioClaps) {
      for (let b = half; b < z; b++) clapBar(b, steps(TWO_FOUR, 2))
    } else if (sec.kind === 'outro' && rules.ioClaps) {
      for (let b = a; b < half; b++) clapBar(b, steps(TWO_FOUR, 2))
    }

    // ---- hats: in intro, outro and breaks by the track's rules ----
    const hatShot = (v: Velocity = 3) => steps(OFFBEAT, v)
    if (sec.kind === 'break') {
      if (rules.hatsInBreaks && !rules.glue) layer('hats', hats, a, z, hatShot(2), { type: 'highpass', from: GLUE_THIN_HZ, to: null, q: 0.7 })
    } else if (sec.kind === 'intro' || sec.kind === 'outro') {
      const how = sec.kind === 'intro' ? rules.introHats : rules.outroHats
      if (how === 'all') layer('hats', hats, a, z, hatShot())
      else if (how === 'half') layer('hats', hats, sec.kind === 'intro' ? half : a, sec.kind === 'intro' ? z : half, hatShot())
    } else {
      layer('hats', hats, a, z, hatShot())
      // A second hat loop on top in drops (and the second half of long builds).
      if (sec.kind === 'drop') loop('hats2', hats2, leanEarly, z)
      else if (sec.kind === 'build' && sec.bars >= 2 * PHRASE) loop('hats2', hats2, z - PHRASE, z)
    }

    // ---- ride: drops only, later in the first one and/or all through the later ones ----
    if (sec.kind === 'drop' && ride) {
      const late = dropIndex === 0 && rules.ride !== 'second'
      const full = dropIndex >= 1 && rules.ride !== 'late'
      const from = late ? a + Math.max(PHRASE, halfwayBars(sec.bars)) : full ? a : z
      if (from < z) layer('ride', ride, from, z, rideSteps)
      if (late && from < z && rules.phraseCrash) crashAt.add(from)  // only if the track crashes on new parts
    }

    // ---- perc ----
    const percShot = steps([3, 7, 10, 14], 2)
    if (sec.kind === 'drop') {
      layer('perc', perc, a, z, percShot)
      if (dropIndex >= rules.perc2From || sec.peak) loop('perc2', perc2, leanLate, z)
    } else if (sec.kind === 'intro') { if (rules.ioPerc) layer('perc', perc, half, z, percShot) }
    else if (sec.kind === 'outro') { if (rules.ioPerc) layer('perc', perc, a, half, percShot) }
    else if (sec.kind === 'build') layer('perc', perc, sec.build === 'layered' ? a + Math.min(PHRASE, sec.bars / 2) : a, z, percShot)
    else if (sec.kind === 'break' && rng.chance(0.6)) {
      const thin = rng.chance(0.5)
      if (!rules.glue) layer('perc', perc, a, z, percShot, thin ? { type: 'highpass', from: 400, to: null, q: 0.7 } : undefined)
    }

    // ---- tops (layered, each top loop on its own lane) and groove ----
    const gap = intoBreak ? rules.loopGap : 0
    const topLayer = (j: number, from: number, to: number, filter?: ClipFilter, gapBeats = 0) =>
      loop(TOP_ROLES[j], tops[j] ?? null, from, to, filter, gapBeats)
    /** The phrase boundary nearest `frac` of the section; strictly inside it for 0 < frac < 1. */
    const phraseAt = (frac: number) => {
      if (frac <= 0) return a
      if (frac >= 1) return z
      const n = sec.bars / PHRASE
      return a + Math.max(1, Math.min(n - 1, Math.round(n * frac))) * PHRASE
    }
    if (sec.kind === 'drop') {
      // The same top loops in every drop; the last drop adds one more.
      const count = Math.min(tops.length, tracks.tops + (sec.peak ? 1 : 0))
      const mid = rules.switchHalfway && sec.bars >= 2 * PHRASE ? a + halfwayBars(sec.bars) : z
      for (let j = 0; j < count; j++) topLayer(j, j > 0 && j === count - 1 ? leanLate : a, z, undefined, gap)
      const g1 = dropIndex >= 1 && rules.grooveSwap ? groove2 : groove
      if (dropIndex >= rules.grooveFrom || sec.peak) {
        if (leanLate < mid) {
          loop('groove', g1, leanLate, mid, undefined, mid === z ? gap : 0)
          if (mid < z) loop('groove', g1 === groove ? groove2 ?? groove : groove, mid, z, undefined, gap)
        } else loop('groove', g1, leanLate, z, undefined, gap)  // a lean drop 1: it comes in halfway
      }
      dropIndex++
    } else if (sec.kind === 'build') {
      if (sec.build === 'filter') {
        for (let j = 0; j < Math.min(2, tops.length); j++) topLayer(j, a, z, { type: 'lowpass', from: 300, to: 18000, q: 1 })
      } else if (sec.build === 'all') {
        for (let j = 0; j < tracks.tops; j++) topLayer(j, a, z)
        loop('groove', groove, Math.max(a, z - PHRASE), z)
      } else {
        // Layered and double-time builds: one more top loop per phrase towards the drop.
        const startAt = sec.build === 'doubletime' && sec.bars >= 2 * PHRASE ? a + halfwayBars(sec.bars) : a
        const phrases = Math.max(1, (z - startAt) / PHRASE)
        for (let j = 0; j < tracks.tops; j++) {
          const from = startAt + Math.floor((j * phrases) / tracks.tops) * PHRASE
          if (from < z) topLayer(j, from, z)
        }
      }
    } else if (sec.kind === 'break') {
      if (rules.topsBreaks !== 'none' && !rules.glue) {
        topLayer(0, a, z, rules.topsBreaks === 'filtered' ? { type: 'lowpass', from: rules.topsBreakHz, to: null, q: 0.7 } : undefined)
      }
    } else if (sec.kind === 'intro') {
      // Mix-in intro: a top loop from the start (or halfway), a second one joining later …
      topLayer(0, phraseAt(rules.ioTopFirst), z)
      if (rules.ioTopSecond != null) topLayer(1, phraseAt(rules.ioTopSecond), z)
    } else if (sec.kind === 'outro') {
      // … and the outro mirrors it: the tops leave the way they came in.
      topLayer(0, a, phraseAt(1 - rules.ioTopFirst))
      if (rules.ioTopSecond != null) topLayer(1, a, phraseAt(1 - rules.ioTopSecond))
    }

    // ---- the lift: what the intro doesn't have yet joins one by one over its last bars, and the
    // outro lets it go the same way, so drops don't come out of (or fall into) nothing ----
    for (const [role, d] of liftOf(sec)) {
      const [from, to] = sec.kind === 'intro' ? [z - d, z] : [a, a + d]
      if (role === 'hats') layer('hats', hats, from, to, hatShot())
      else if (role === 'perc') layer('perc', perc, from, to, percShot)
      else if (role === 'top2') topLayer(1, from, to)
      else for (let b = from; b < to; b++) clapBar(b, steps(TWO_FOUR, 2))
    }

    // ---- chord stabs: the rhythm through every drop; elsewhere nothing, or the same rhythm
    // low-passed in breakdowns and builds (by the track's rules) ----
    if (stabFit) stabsFit(sec, next, dropIndex - 1)
    else if (stabs.length) {
      const lp = (to: number | null = null): ClipFilter => ({ type: 'lowpass', from: rules.stabsCutoff, to, q: 0.8 })
      if (sec.kind === 'drop') stabBars(a, z)
      else if (rules.stabsIn === 'keys' && sec.kind === 'break' && rules.stabsBreaks === 'filtered') stabBars(a, z, lp())
      else if (rules.stabsIn === 'keys' && sec.kind === 'build' && rules.stabsBuild !== 'none') {
        stabBars(a, z, lp(rules.stabsBuild === 'sweep' ? 8000 : null))
      }
    }

    // ---- bass: the bassline repeats in drops; elsewhere high-passed (its sub out) or out, by the
    // track's rules ----
    if (bassSample) {
      const hp = (to: number | null = null): ClipFilter => ({ type: 'highpass', from: rules.bassHp, to, q: 0.7 })
      if (sec.kind === 'drop') bassDrop(a, z, gap)
      else if (sec.kind === 'break' && lead === 'bass') {
        // The track's lead, exposed: the bassline in full from the breakdown's second part on (no kick over it).
        const from = breakShape(a, sec.bars).lead
        if (rules.bassBreaks === 'filtered') bassPart(a, from, hp())
        bassPart(from, z)
      } else if (sec.kind === 'break') { if (rules.bassBreaks === 'filtered') bassPart(a, z, hp()) }
      else if (sec.kind === 'build') {
        if (rules.bassBuild === 'sweep') bassPart(a, z, hp(BASS_SWEEP_TO_HZ))
        else if (rules.bassBuild === 'filtered') bassPart(a, z, hp())
      } else if (sec.kind === 'intro') { if (rules.bassIO === 'filtered') bassPart(phraseAt(0.5), z, hp()) }
      else if (sec.kind === 'outro') { if (rules.bassIO === 'filtered') bassPart(a, phraseAt(0.5), hp()) }
    }

    // (No atmos in breakdowns any more: atmosphere lives on the Ambience page, the bed under the
    // track, SCOPE.md §6.10a. Tracks made before keep their Atmos clips.)

    // ---- transitions: the track's own way into drops, breakdowns and the outro ----
    if (next) {
      const end = z * 4
      const room = sec.bars * 4
      if (intoDrop) {
        // One moment for everything leading into the drop: the riser decides how long before it
        // the sound stops (its producer's choice), the fill or roll and any second FX layer stop
        // with it, and the rest of the track goes silent there too (see the silence below).
        // The track's own way in (rule `dropIn`), the same into every drop: everything up to the
        // line, or the risers stopping with the gap (the drum fill playing on through it, into the 1).
        // Tracks from before: each transition's riser decides.
        const fixed = rules.dropIn != null
        const gap = fixed && rules.dropIn !== 'straight' ? Number(rules.dropInBeats ?? 2) * 4 : 0
        let t: number | undefined = fixed ? (rules.dropIn === 'gap' ? gap : 0) : keptGaps?.[z]
        const big = isBig(next)
        const rollJob = sec.long ? 'roll-long' : 'roll'
        /**
         * A riser for `job` stopping with the gap; in a track's gap one running to the line when none
         * does (the gap cuts it). One the track doesn't play elsewhere first (a lane made again).
         */
        const riseInto = (job: string, role: Role, cands: SampleListItem[], want: number, o: { room?: number; tonal?: boolean } = {}) => {
          const fresh = cands.filter((x) => !keep.avoid?.includes(x.rel_path))
          // (Into a track's gap any riser does, the gap cuts it: one that stops with it, or runs to the line, is better.)
          const gapped = fixed && rules.dropIn === 'gap'
          const w = (x: SampleListItem) => (gapsAgree(gapOf(x), gap) || gapOf(x) <= TO_THE_LINE ? 1 : 0.3)
          for (const xs of fresh.length < cands.length ? [fresh, cands] : [cands]) {
            const s = endOn(job, role, xs, end, o.room ?? room, want, o.tonal ?? true, gapped ? undefined : t, gapped ? w : undefined)
            if (s) return s
          }
          return null
        }
        const leadIns = (rules.dropFill === 'roll' ? [...rolls.filter((s) => bodyBars(s) * 4 <= room), ...fills]
          : rules.dropFill === 'fill' ? fills : []).filter((s) => bodyBars(s) <= 2 || s.category === 'roll').filter(leads)
        let riser: SampleListItem | null = null
        if (big) {
          // The big build's risers, stacked: a long one over the whole build, a riser over its
          // second half, and (rule `bigRisers`) a short lift into the 1.
          // (Each layer long enough for its part of the build when the library has one: in the key, or
          // a noise sweep, which is in any; a long build wants its length more than a fresh import.)
          const n = bigBarsIn(sec)
          const bigRoom = n * BEATS_PER_BAR
          const taken = new Set<number>()
          const all = [...risers, ...lifts]
          const keyed = (x: SampleListItem) => !x.key_label || !tonalKeys || tonalKeys.has(x.key_label)
            || (x.category !== 'fx_riser' && (x.shape?.noise ?? 0) >= BIG_NOISE)
          const layer = (job: string, role: Role, cands: SampleListItem[], want: number, min: number, max = Infinity, strict = false) => {
            const free = cands.filter((x) => !taken.has(x.id))
            const sized = free.filter((x) => keyed(x) && leads(x) && bodyBars(x) >= min && bodyBars(x) <= max && bodyBars(x) * BEATS_PER_BAR <= bigRoom)
            const s = sized.length ? riseInto(job, role, sized, want, { room: bigRoom, tonal: false })
              : strict ? null : riseInto(job, role, free.length ? free : cands, want, { room: bigRoom })
            if (s) taken.add(s.id)
            return s
          }
          riser = layer('riser-main', 'fx', all, n, Math.max(2, n * 0.6))
          layer('riser-main2', 'fx2', risers.length > 1 ? risers : all, Math.max(2, n / 2), Math.max(2, n * 0.3), Math.max(2, n * 0.75))
          // (The lift is short or none.)
          if (Number(rules.bigRisers) >= 3) layer('riser-main3', 'fx3', [...lifts, ...risers], 1, 1, 2, true)
        } else if (rules.dropRiser && fixed) {
          riser = riseInto(sec.long ? 'riser-long' : 'riser', 'fx', risers, sec.long ? 8 : sec.bars >= 16 ? 4 : 2)
        } else if (rules.dropRiser) {
          // A riser the track's fill can stop with (or some fill, when the track has fills into drops).
          const fill = chosen.get(rules.dropFill === 'roll' ? rollJob : 'fill')
          const withFill = fill ? risers.filter((r) => gapsAgree(gapOf(fill), gapOf(r))) : []
          const partnered = withFill.length ? withFill
            : risers.filter((r) => !leadIns.length || leadIns.some((f) => gapsAgree(gapOf(f), gapOf(r))))
          riser = endOn(sec.long ? 'riser-long' : 'riser', 'fx', partnered.length ? partnered : risers, end, room,
                        sec.long ? 8 : sec.bars >= 16 ? 4 : 2, true, t)
          if (riser) t ??= gapOf(riser)
        }
        let lead: SampleListItem | null = null
        // (Through a track's gap the drum fill plays on into the 1; else it stops with the riser.)
        const fillT = fixed ? 0 : t
        if (rules.dropFill === 'roll') lead = endOn(rollJob, 'fills', rolls, end, room, sec.long ? 8 : 4, false, fillT)
        if (!lead && rules.dropFill) lead = endOn('fill', 'fills', fills, end, 8, 1, false, fillT)
        if (lead) t ??= gapOf(lead)
        // A second layer: another length or texture than the riser, stopping with it.
        if (riser && !big && rules.fx !== 'sparse' && rules.fxLayers >= 2) {
          const first = riser
          const want = bodyBars(first) >= 4 ? Math.max(1, bodyBars(first) / 4) : Math.min(sec.bars, bodyBars(first) * 4)
          endOn('riser2', 'fx2', [...risers, ...lifts].filter((s) => s.id !== first.id && complements(first, s) != null),
                end, room, want, true, t, (s) => complements(first, s)!)
        }
        // The impact as the drop hits, unless it's bassy: its boom would fight the kick (it opens
        // the breakdowns and build-ups instead, below).
        const impact = rules.dropImpact ? trackPick('impact', impacts) : null
        if (impact && !bassy(impact)) placeFree(['hits', 'fx2'], impact, end)
        // A downlifter as the drop hits, on a lane that's free there (never a bassy one).
        const down = rules.dropDown && rules.fx !== 'sparse' ? trackPick('drop-down', downs, true) : null
        if (down && !bassy(down)) placeFree(['hits', 'fx2', 'fx'], down, end)
        dropGaps[z] = fixed ? gap : t ?? 0
        crashAt.add(z)  // every drop starts with a crash
        // (The big build goes on after the groove through the breakdown is laid: it has the last word on its bars.)
        if (big) bigBuilds.push(sec)
        else buildUp(sec)
      } else if (intoBreak) {
        const fill = rules.breakFill ? endOn('fill', 'fills', fills, end, 8, 1) : null
        if (rules.breakCrash) crashAt.add(z)
        // A sweep up into the breakdown (stopping with the fill), a downlifter falling away from its start.
        if (rules.breakSweep) endOn('sweep', 'fx', lifts, end, room, 2, false, fill ? gapOf(fill) : undefined)
        if (rules.breakDownlifter && rng.chance(fxChance)) placeFree(['hits', 'fx2', 'fx'], trackPick('downlifter', downs, true), end)
      } else if (next.kind === 'outro') {
        if (rules.outroFill) endOn('fill', 'fills', fills, end, 8, 1)
        if (rules.outroCrash) crashAt.add(z)
      }
    }
    // The track's fill into every 16-bar part of a drop.
    if (sec.kind === 'drop' && rules.phraseFill) for (const m of marks) endOn('fill', 'fills', fills, m * 4, 8, 1)
  })

  // ---- one groove (SCOPE.md §6.6): the drums of the part before a breakdown play on through it
  // in a darker state, each part moving a step at a time and across the lines, never all at once ----
  const carried: string[] = []
  if (rules.glue) {
    /** The loop of `role` playing up to the line at `bar` (or stopping a beat or two before it). */
    const endingAt = (role: Role, bar: number) => (lanes.segs.get(role) ?? [])
      .filter((x) => x.sample.kind === 'loop' && !x.bass && x.start < bar * 4 && x.start + x.length <= bar * 4 && x.start + x.length >= bar * 4 - 2)
      .sort((x, y) => y.start + y.length - (x.start + x.length))[0] ?? null
    const startingAt = (role: Role, bar: number) => (lanes.segs.get(role) ?? [])
      .find((x) => x.sample.kind === 'loop' && !x.bass && x.start === bar * 4) ?? null
    type Key = [bar: number, hz: number | null, db: number]
    type How = 'lowpass' | 'highpass' | 'open'
    /**
     * `src` (a loop as it plays elsewhere, in phase with that; or a one-shot pattern) over the bars
     * of `keys`: from key to key its filter moves from one cutoff to the next and its level from
     * one dB to the next.
     */
    const run = (role: Role, src: { seg?: Segment; pat?: BarPattern }, how: How, keys: Key[]) => {
      const filt = (h0: number | null, h1: number | null): ClipFilter | undefined => (how === 'open' || h0 == null ? undefined
        : { type: how, from: Math.round(h0), to: h1 == null || Math.round(h1) === Math.round(h0) ? null : Math.round(h1), q: 0.7 })
      const half = (v: number) => Math.round(v * 2) / 2 || 0
      for (let k = 0; k + 1 < keys.length; k++) {
        const [b0, h0, d0] = keys[k]
        const [b1, h1, d1] = keys[k + 1]
        if (b1 <= b0) continue
        if (src.seg) {
          const x = src.seg
          const L = loopLen(x)
          const trim = ((((x.trim ?? 0) + b0 * 4 - x.start) % L) + L) % L
          const filter = filt(h0, h1)
          lanes.add(role, {
            sample: x.sample, start: b0 * 4, length: (b1 - b0) * 4, trim, ...(x.pitch ? { pitch: x.pitch } : {}), ...(x.loopBars ? { loopBars: x.loopBars } : {}),
            ...(filter ? { filter } : {}), ...(half(d0) ? { gainDb: half(d0) } : {}), ...(half(d1) !== half(d0) ? { gainTo: half(d1) } : {}),
          })
        } else if (src.pat) {
          // A one-shot pattern: bar by bar, the filter and the level stepping along.
          const at = (b: number): [number | null, number] => {
            const t = (b - b0) / (b1 - b0)
            return [h0 == null || h1 == null ? h0 : h0 * (h1 / h0) ** t, d0 + (d1 - d0) * t]
          }
          for (let b = b0; b < b1; b++) {
            const [ha, da] = at(b)
            const [hb, db] = at(b + 1)
            const filter = filt(ha, hb)
            lanes.setBar(role, b, {
              sample: src.pat.sample, steps: src.pat.steps.map((v) => Math.min(v, 2)) as Steps, ...(src.pat.pitch ? { pitch: src.pat.pitch } : {}),
              ...(filter ? { filter } : {}), ...(half(da) ? { gainDb: half(da) } : {}), ...(half(db) !== half(da) ? { gainTo: half(db) } : {}),
            })
          }
        }
      }
    }
    const names: Partial<Record<Role, string>> = { perc: 'perc', hats: 'hats', top: 'tops' }
    let depth = 0
    sections.forEach((sec, i) => {
      if (sec.kind !== 'break') return
      const a = sec.start
      const z = sec.start + sec.bars
      const n = sec.bars
      const next = sections[i + 1]
      const d = depth++
      // Every later breakdown is the first one taken further: darker, lower, the rest out sooner.
      const deeper = GLUE_DEEPER ** d
      const level = rules.glueDb - GLUE_DEEPER_DB * d
      /**
       * The clip level that puts a part held at `hz` where it belongs: `GLUE_UNDER_DB` under `level`
       * below its loudness in the drop, whatever its filter takes (a bright loop loses far more under
       * a low-pass than a dark one, and would vanish). Unmeasured, or unfiltered: `level` itself.
       */
      const levelAt = (src: { seg?: Segment; pat?: BarPattern }, how: How, hz: number | null): number => {
        const loss = how === 'open' || hz == null ? null : filterLoss((src.seg ?? src.pat)?.sample.tone, how, hz)
        if (loss == null) return level
        return Math.round(Math.max(-GLUE_MAX_CUT_DB, Math.min(GLUE_MAX_MAKEUP_DB, level - GLUE_UNDER_DB - loss)) * 2) / 2
      }
      const dark = Math.max(GLUE_MIN_HZ, rules.glueHz * deeper)
      const opens = !!next && next.kind !== 'outro'
      const close = Math.min(GLUE_CLOSE_BARS, Math.max(1, Math.floor(n / 4)))
      const open = opens ? Math.min(rules.glueOpen, Math.max(2, Math.floor(n / 2))) : 0
      /** What `role` played into the breakdown: its loop (played on in phase), its pattern, else the track's sample. */
      const source = (role: Role, s: SampleListItem | null, shot: Steps): { seg?: Segment; pat?: BarPattern } | null => {
        const seg = endingAt(role, a)
        if (seg) return { seg }
        const pat = lanes.bar(role, a - 1)
        if (pat) return { pat }
        if (!s) return null
        return s.kind === 'loop' ? { seg: { sample: s, start: a * 4, length: n * 4 } } : { pat: { sample: s, steps: shot } }
      }
      // ---- what stays all through (by the track's rules; one part always does: the thread) ----
      const stay: { role: Role; src: { seg?: Segment; pat?: BarPattern }; how: How; hz: number; level?: number }[] = []
      const want = (role: Role, s: SampleListItem | null, shot: Steps, how: How, hz: number, level?: number) => {
        const src = source(role, s, shot)
        if (src) stay.push({ role, src, how, hz, level })
      }
      // (A track led by its percussion keeps it in the clear: open, a little under its drop level.)
      const percStays = () => (lead === 'perc' ? want('perc', perc, percShotGlue, 'open', dark, LEAD_BREAK_DB) : want('perc', perc, percShotGlue, 'lowpass', dark))
      const hatsStay = () => want('hats', hats, steps(OFFBEAT, 2), 'highpass', GLUE_THIN_HZ)
      const topStays = (how: How) => want('top', tops[0] ?? null, [], how, Math.max(GLUE_MIN_HZ, rules.topsBreakHz * deeper))
      if (rules.gluePerc === 'through') percStays()
      if (rules.hatsInBreaks) hatsStay()
      if (rules.topsBreaks !== 'none') topStays(rules.topsBreaks === 'open' ? 'open' : 'lowpass')
      if (!stay.length) { percStays(); if (!stay.length) hatsStay(); if (!stay.length) topStays('lowpass') }
      const staying = new Set(stay.map((x) => x.role))
      // The long breakdown strips down to the thread alone for its middle bars, darker still.
      const bare = !!sec.long && z - open - (a + close) >= GLUE_BARE_MIN_BARS
      stay.forEach((x, k) => {
        const from = x.how === 'highpass' ? GLUE_HP_OPEN_HZ : GLUE_LP_OPEN_HZ
        const hz = x.how === 'open' ? null : x.hz
        const held = x.level ?? levelAt(x.src, x.how, hz)
        const end: Key[] = open ? [[z - open, hz, held], [z, hz == null ? null : from, 0]] : [[z, hz, held]]
        if (!bare) run(x.role, x.src, x.how, [[a, hz == null ? null : from, 0], [a + close, hz, held], ...end])
        else if (k === 0) {
          const low = hz == null ? null : x.how === 'highpass' ? hz : Math.max(GLUE_MIN_HZ, hz * GLUE_DEEPER)
          const lower = levelAt(x.src, x.how, low) - GLUE_DEEPER_DB
          run(x.role, x.src, x.how, [[a, hz == null ? null : from, 0], [a + close, hz, held], [a + close + 4, low, lower],
            ...(open ? [[z - open, low, lower], [z, hz == null ? null : from, 0]] as Key[] : [[z, low, lower]] as Key[])])
        } else {
          run(x.role, x.src, x.how, [[a, hz == null ? null : from, 0], [a + close, hz, held], [a + close + 4, hz, held - GLUE_FADE_DB]])
          if (open) run(x.role, x.src, x.how, [[z - open, hz, held - GLUE_FADE_DB / 2], [z, hz == null ? null : from, 0]])
        }
      })
      // ---- what leaves: every other loop that played into the line goes on past it, darker and
      // fading, one after the other (and closes over the last bars before the line) ----
      const leaving = new Map<Role, number>()
      GLUE_LEAVE_ORDER.filter((r) => !staying.has(r)).map((r) => [r, endingAt(r, a)] as const).filter(([, x]) => !!x).forEach(([role, seg], k) => {
        const bars = Math.min(n, Math.max(2, rules.glueOut - 2 * k - 2 * d))
        run(role, { seg: seg! }, 'lowpass', [[a, GLUE_LEAVE_HZ, 0], [a + bars, dark, -GLUE_FADE_DB]])
        leaving.set(role, a + bars)
        // (Closing before the line: not the top loops and groove, which play full to the end of a drop.)
        if (seg!.length >= 4 * BEATS_PER_BAR && !(NO_DROP_LOWPASS.has(role) && sections.some((s) => s.kind === 'drop' && s.start + s.bars === a))) {
          lanes.ride(role, (a - GLUE_BEFORE_BARS) * 4, a * 4, { filter: { type: 'lowpass', from: GLUE_LP_OPEN_HZ, to: GLUE_LEAVE_HZ, q: 0.7 }, gainDb: 0 })
        }
      })
      // The clap leaves the same way: softer and darker over a few bars.
      const clapWas = lanes.bar('clap', a - 1)
      if (clap && clapWas) {
        const soft = (v: Velocity, hz: number) => ({ sample: clap, steps: steps(TWO_FOUR, v), filter: { type: 'lowpass', from: hz, to: null, q: 0.7 } as ClipFilter })
        for (let b = a; b < Math.min(z, a + 2); b++) lanes.setBar('clap', b, soft(2, GLUE_LEAVE_HZ))
        if (d === 0 && n >= PHRASE) for (let b = a + 2; b < a + 4; b++) lanes.setBar('clap', b, soft(1, Math.max(dark, 1200)))
      }
      // ---- what comes back: the loops the next part starts with open up into it over the last
      // bars, the main ones first (the opening is the build) ----
      if (open) {
        GLUE_RETURN_ORDER.filter((r) => !staying.has(r)).map((r) => [r, startingAt(r, z)] as const).filter(([, x]) => !!x).slice(0, GLUE_RETURNERS)
          .forEach(([role, seg], k) => {
            const from = Math.max(leaving.get(role) ?? a, z - Math.max(2, open - 2 * k))
            if (from < z) run(role, { seg: seg! }, 'lowpass', [[from, dark, -GLUE_FADE_DB], [z, GLUE_LP_OPEN_HZ, 0]])
          })
      }
      if (d === 0) {
        const kept = stay.map((x) => names[x.role]).join(' and ')
        carried.push(`the groove carries through breakdowns: ${kept} ${stay.some((x) => x.how !== 'open') ? 'filtered' : 'quieter'}, the rest fading out over ${rules.glueOut} bars${open ? `, opening up over ${open}` : ''}`)
      }
    })
  }

  // ---- the breakdown layer (SCOPE.md §6.7b): a pad's chord or a reese's note through a Serum patch,
  // coming in once the breakdown has stripped down, its filter opening and its level rising into
  // the next part (the breakdown's shape: strip, the new layer, the build) ----
  const padPatch = rules.padIn && rules.padPreset ? (opts.pads?.presets ?? []).find((x) => x.path === rules.padPreset) ?? null : null
  const padReese = !!padPatch && isReese(padPatch)
  const padLine = padPatch ? padNotes(key, padReese) : null
  let padBreaks = 0
  if (padPatch && padLine) {
    const render: BassRender = {
      role: 'pad', keyLabel: key, preset: padPatch.path, presetName: padPatch.name, midiId: 0, midiName: padReese ? 'Reese' : 'Pad', transpose: 0,
      notes: padLine, bars: PAD_BARS,
    }
    const sample: SampleListItem = {
      id: -2_100_000_000, rel_path: bassPath(render, bpm), name: `${padPatch.name} · ${padReese ? 'reese' : 'pad'}`, kind: 'loop', category: 'melodic', bpm,
      bars: PAD_BARS, body_bars: null, key_label: key, key_camelot: null, duration_s: (PAD_BARS * BEATS_PER_BAR * 60) / bpm, channels: 2, favorite: 0,
      rating: null, tags: null, zip_id: -1, source_code: 'Serum',
    }
    sections.forEach((sec, i) => {
      if (sec.kind !== 'break') return
      const next = sections[i + 1]
      const a = breakShape(sec.start, sec.bars).layer
      const z = sec.start + sec.bars
      if (z <= a) return
      const rises = !!next && next.kind !== 'outro'
      const [from, to] = padReese ? [Math.round(rules.padHz / 2), PAD_REESE_OPEN_HZ] : [rules.padHz, PAD_OPEN_HZ]
      lanes.add('pad', {
        sample, start: a * BEATS_PER_BAR, length: (z - a) * BEATS_PER_BAR, bass: render,
        filter: { type: 'lowpass', from, to: rises ? to : null, q: 0.8 },
        fadeIn: Math.min(PAD_FADE_BARS, (z - a) / 4) * BEATS_PER_BAR, fadeOut: (rises ? 0.5 : Math.min(PAD_FADE_BARS, (z - a) / 4)) * BEATS_PER_BAR,
        ...(rises ? { gainDb: -PAD_RISE_DB, gainTo: 0 } : { gainDb: -PAD_RISE_DB / 2 }),
      })
      padBreaks++
    })
  }

  // ---- a bassy impact opens the breakdowns and build-ups instead of hitting the drops, where no
  // kick plays under its boom (the kick lane, or a kick roll on the Build-up lane) ----
  const boom = rules.dropImpact ? trackPick('impact', impacts) : null
  if (boom && bassy(boom)) {
    const kicks = (b: number) => !!lanes.bar('kick', b)?.steps.some((v) => v > 0)
      || (!!kick && lanes.bar('buildup', b)?.sample.id === kick.id)
    const body = Math.max(1, Math.ceil(bodyBars(boom)))
    for (const sec of sections) {
      if (sec.kind !== 'break' && sec.kind !== 'build') continue
      const under = Array.from({ length: body }, (_, k) => sec.start + k).filter((b) => b < total)
      if (!under.some(kicks)) placeFree(['hits', 'fx2', 'fx'], boom, sec.start * 4)
    }
  }

  // ---- crashes on the 1 of key moments ----
  if (crash) for (const b of crashAt) if (b < total) lanes.setBar('crash', b, { sample: crash, steps: steps([0]) })
  // … and crashes building every drop: coming faster bar by bar (half bars, quarters, 8ths), or
  // on each of the last four counts.
  // (Into a big drop, by its rule: coming faster over the last four bars, every bar, half bars, quarters, 8ths.)
  const bigCrashes = (sec: Section) => !!crash && isBig(sec) && !!rules.bigCrash && sec.start >= BIG_CRASH_FASTER.length
  for (const sec of sections) {
    if (!bigCrashes(sec)) continue
    BIG_CRASH_FASTER.forEach(([every, db], k) => lanes.setBar('crash', sec.start - BIG_CRASH_FASTER.length + k, {
      sample: crash!, steps: steps(Array.from({ length: STEPS_PER_BAR / every }, (_, x) => x * every), k === BIG_CRASH_FASTER.length - 1 ? 3 : 2), ...(db ? { gainDb: db } : {}),
    }))
  }
  if (crash && rules.buildupCrash !== 'none') {
    for (const sec of sections) {
      if (sec.kind !== 'drop' || sec.start < CRASH_FASTER.length || bigCrashes(sec)) continue
      if (rules.buildupCrash === 'last4') lanes.setBar('crash', sec.start - 1, { sample: crash, steps: steps(FOUR) })
      else {
        CRASH_FASTER.forEach(([every, db], k) => lanes.setBar('crash', sec.start - CRASH_FASTER.length + k, {
          sample: crash, steps: steps(Array.from({ length: STEPS_PER_BAR / every }, (_, x) => x * every), k === CRASH_FASTER.length - 1 ? 3 : 2), ...(db ? { gainDb: db } : {}),
        }))
      }
    }
  }

  // ---- the intro's loops repeat only their first bar or two at first (the outro mirrors it) ----
  if (rules.ioShort) {
    const n = rules.ioShort
    for (const sec of sections) {
      if (sec.kind !== 'intro' && sec.kind !== 'outro') continue
      const half = Math.max(PHRASE, halfwayBars(sec.bars))
      const [a, z] = sec.kind === 'intro' ? [sec.start, sec.start + half] : [sec.start + sec.bars - half, sec.start + sec.bars]
      for (const role of [...TOP_ROLES, 'perc'] as Role[]) {
        lanes.vary(role, a * 4, z * 4, { loopBars: n, trim: 0 }, (x) => (x.sample.bars ?? 1) > n)
      }
    }
  }

  // ---- the intro's top loops gated, the gate opening up: a few 16ths at first, more every 8 bars,
  // the plain loop in its last phrase (each top lane in its own pattern, so they interlock) ----
  if (rules.introGate) {
    for (const sec of sections) {
      if (sec.kind !== 'intro') continue
      const gated = gatedPhrases(sec.bars, PHRASE)
      TOP_ROLES.forEach((role, j) => {
        for (let k = 0; k < gated; k++) {
          const a = (sec.start + k * PHRASE) * BEATS_PER_BAR
          lanes.vary(role, a, a + PHRASE * BEATS_PER_BAR, { chop: introGate(rules.introGate as GateFamily, j, k, gated) })
        }
      })
    }
  }

  // ---- the arc (SCOPE.md §6.6): one element held back for the last drop, so the peak has something
  // the track hasn't played yet. It must play there and somewhere before it, else the next one the
  // character leans to is held; none when nothing qualifies ----
  const allDrops = sections.filter((x) => x.kind === 'drop')
  const peakDrop = allDrops.length >= 2 ? allDrops[allDrops.length - 1] : null
  let held: Hold = 'none'
  if (peakDrop && rules.hold && rules.hold !== 'none') {
    const plays = (r: Role, a: number, z: number) => (lanes.segs.get(r) ?? []).some((x) => x.start < z * BEATS_PER_BAR && x.start + x.length > a * BEATS_PER_BAR)
      || Array.from({ length: Math.max(0, z - a) }, (_, k) => lanes.bar(r, a + k)).some(Boolean)
    const ok = (h: Hold) => h !== 'none' && plays(h, peakDrop.start, peakDrop.start + peakDrop.bars) && plays(h, 0, peakDrop.start)
    const lean = [...HOLD_LEAN[character ?? 'none']].sort((x, y) => y[1] - x[1]).map(([h]) => h)
    held = [rules.hold as Hold, ...lean].find(ok) ?? 'none'
    if (held !== 'none') {
      lanes.cut(held, 0, peakDrop.start * BEATS_PER_BAR, true)
      for (let b = 0; b < peakDrop.start; b++) lanes.setBar(held, b, null)
    }
  }
  rules.hold = held

  // ---- something changes every 8 bars: where the arrangement doesn't, a variation from the track's
  // own vocabulary (small every 8 bars, bigger at 16 and 32) ----
  const eight = everyEightBars(lanes, sections, rng, {
    kick, fill: fills.length ? endOn : null, fills, shapedBreaks: !!rules.glue, gestures: (rules.gestures as Gestures | null) ?? null,
  })
  const varied = eight.added

  // ---- disco hits on the 1 of key moments, taking turns when there are two (after the 8-bar
  // variations, so the rest of the track is the same with or without them) ----
  const avoidHits = new Set(keep.avoid)
  const keptHit = (role: Role) => (keep.picks?.[role] ? hitPool.find((s) => s.rel_path === keep.picks![role]!.rel_path) ?? null : null)
  const pickHit = (not: SampleListItem | null) => {
    const cands = hitPool.filter((s) => s.rel_path !== not?.rel_path)
    const fresh = cands.filter((s) => !avoidHits.has(s.rel_path))
    return fresh.length ? drng.pick(fresh) : cands.length ? drng.pick(cands) : null
  }
  const disco1 = keptHit('disco') ?? (rules.discoIn ? pickHit(null) : null)
  const disco2 = disco1 && (keptHit('disco2') ?? (rules.discoCount >= 2 ? pickHit(disco1) : null))
  const discoHits = [disco1, disco2].filter((s): s is SampleListItem => !!s)
  if (discoHits.length) {
    const at: number[] = []
    for (const sec of sections) {
      const z = sec.start + sec.bars
      if (sec.kind === 'drop') {
        if (rules.discoAt === '16' || rules.discoAt === '8') for (let b = sec.start; b < z; b += Number(rules.discoAt)) at.push(b)
        else {
          at.push(sec.start)
          const half = sec.start + halfwayBars(sec.bars)
          if (half > sec.start && half < z) at.push(half)
        }
      } else if (sec.kind === 'break' && rules.discoAt === 'all') at.push(sec.start)
    }
    at.forEach((b, i) => {
      const s = discoHits[i % discoHits.length]
      const pitch = hitPitch(hitOf.get(s.rel_path)!, key)
      lanes.setBar(i % discoHits.length ? 'disco2' : 'disco', b, { sample: s, steps: steps([0]), ...(pitch ? { pitch } : {}) })
    })
    picks.disco = disco1!
    if (disco2) picks.disco2 = disco2
  }

  // ---- strings under the track (after the 8-bar variations, like the disco hits): one sample in
  // the key, starting again on every 8-bar line, in the drops, all through, or between the intro
  // and the outro ----
  const keptStrings = keep.picks?.strings ? stringHits.find((h) => stringsItem(h).id === keep.picks!.strings!.id) ?? null : null
  let stringsWhere = String(rules.stringsAt)
  let stringsEvery = 8
  let strings: HitItem | null = keptStrings
  if (!strings && rules.stringsIn && stringHits.length) {
    const fresh = stringHits.filter((h) => !keep.avoid?.some((a) => a.startsWith(stringsRenderPrefix(h.rel_path))))
    strings = trng.pick(fresh.length ? fresh : stringHits)
  }
  const stringsMove = strings ? stringsShift(strings, key)! : 0
  if (strings) {
    const render = stringsRender(strings, key, stringsMove, bpm)
    stringsEvery = render.bars ?? 8
    const item = stringsItem(strings)
    const sample = stringsSample(item, render, bpm)
    const first = sections[0]
    const last = sections[sections.length - 1]
    const drops = sections.filter((x) => x.kind === 'drop')
    const breaks = sections.filter((x) => x.kind === 'break')
    const whole = (x: Section): [number, number] => [x.start, x.start + x.bars]
    const secondHalf = (x: Section): [number, number] => [x.start + halfwayBars(x.bars), x.start + x.bars]
    const at = rules.stringsAt === 'breaks' && !breaks.length ? 'halves' : rules.stringsAt
    stringsWhere = at
    const spans: [number, number][] = at === 'later' ? (drops.length > 1 ? drops.slice(1).map(whole) : drops.map(secondHalf))
      : at === 'halves' ? drops.map(secondHalf)
        : at === 'breaks' ? breaks.map(whole)
          : at === 'drops' ? drops.map(whole)
            : at === 'all' ? [[0, total]]
              : [[first.kind === 'intro' ? first.start + first.bars : 0, last.kind === 'outro' ? last.start : total]]
    // They come in at once where a part of the track starts (on a drop, a breakdown, the line
    // halfway through a drop: after the fill or the crash, you want to hear them), and swell in only
    // from the very start of a track. They leave over a couple of bars; in a breakdown they rise
    // into the drop and stop with it.
    for (const [a, z] of spans) {
      if (z <= a) continue
      const tension = at === 'breaks'
      lanes.add('strings', {
        sample, start: a * BEATS_PER_BAR, length: (z - a) * BEATS_PER_BAR, bass: render,
        ...(a === 0 ? { fadeIn: Math.min(STRINGS_FADE_IN_BARS, (z - a) / 4) * BEATS_PER_BAR } : {}),
        fadeOut: tension ? BEATS_PER_BAR / 2 : Math.min(STRINGS_FADE_OUT_BARS, (z - a) / 4) * BEATS_PER_BAR,
        ...(tension ? { gainDb: -STRINGS_BREAK_RISE_DB, gainTo: 0 } : {}),
      })
    }
    picks.strings = item
  }

  // ---- the ambience bed (SCOPE.md §6.10a; after the 8-bar variations, like the strings): one
  // texture as a seamless loop from the end of the intro to the start of the outro, constant ----
  const keptBed = keep.picks?.bed ? bedHits.find((h) => bedItem(h).id === keep.picks!.bed!.id) ?? null : null
  let bed: HitItem | null = keptBed
  if (!bed && rules.bedIn && bedHits.length) {
    const fresh = bedHits.filter((h) => !keep.avoid?.some((a) => a.includes(`/${h.rel_path.split('/').pop()}`) || a === h.rel_path))
    bed = arng.pick(fresh.length ? fresh : bedHits)
  }
  if (bed) {
    const render = bedRender(bed, bpm, key, bedShift(bed, key)!)
    const item = bedItem(bed)
    const sample = bedSample(item, render, bpm)
    const first = sections[0]
    const last = sections[sections.length - 1]
    const a = first.kind === 'intro' ? first.start + first.bars : 0
    const z = last.kind === 'outro' ? last.start : total
    if (z > a) {
      lanes.add('bed', {
        sample, start: a * BEATS_PER_BAR, length: (z - a) * BEATS_PER_BAR, bass: render,
        fadeIn: BED_FADE_BARS * BEATS_PER_BAR, fadeOut: BED_FADE_BARS * BEATS_PER_BAR,
      })
    }
    picks.bed = item
  }

  // ---- a vocal (after the 8-bar variations, like the strings): one take, its phrase loop where the
  // track's rule says (no chops: they're out) ----
  const keptTake = keep.picks?.vocal ? takes.find((t) => vocalItem(t).id === keep.picks!.vocal!.id) ?? null : null
  let take: VocalTake | null = keptTake
  if (!take && rules.vocalIn && takes.length) {
    const avoid = new Set(keep.avoid ?? [])
    const fresh = takes.filter((t) => !t.usedIn.length && !t.analysis.phrases.some((p) => avoid.has(p.path))
      && !(keep.avoid ?? []).some((a) => a.startsWith('.drumvault/vocals/') && a.includes(t.id)))
    const unused = takes.filter((t) => !t.usedIn.length)
    take = vrng.pick(fresh.length ? fresh : unused.length ? unused : takes)
  }
  let vocalNote = ''
  if (take) {
    const phrases = [...take.analysis.phrases].sort((a, b) => a.bars - b.bars)
    const drops = sections.filter((x) => x.kind === 'drop')
    const breaks = sections.filter((x) => x.kind === 'break')
    const at = rules.vocalAt === 'breaks' && !breaks.length ? 'drops' : rules.vocalAt as string
    const halfOf = (x: Section) => x.start + (x.bars >= 2 * PHRASE ? halfwayBars(x.bars) : 0)
    const phrase = rules.vocalLoop === 'long' ? phrases[phrases.length - 1] : phrases[0]
    const render = phraseRender(take, phrase, key)
    const sample = phraseSample(take, render, bpm)
    const add = (a: number, z: number, verb?: ClipReverb) => {
      if (z > a) lanes.add('vocal', { sample, start: a * BEATS_PER_BAR, length: (z - a) * BEATS_PER_BAR, bass: render, ...(verb ? { verb } : {}) })
    }
    for (const d of drops) {
      if (at === 'halves') add(halfOf(d), d.start + d.bars)
      else if (at === 'drops' || at === 'drops_breaks') add(d.start, d.start + d.bars)
    }
    // In the last drop too when it's only in the breakdowns: the vocal comes back for the end.
    if (at === 'breaks' && drops.length) add(halfOf(drops[drops.length - 1]), drops[drops.length - 1].start + drops[drops.length - 1].bars)
    if (at === 'drops_breaks' || at === 'breaks') for (const b of breaks) add(b.start, b.start + b.bars, { from: 0.15, to: 0.6 })
    picks.vocal = vocalItem(take)
    // The stabs step back where the phrase is sung: no hit at full strength under it.
    if (stabFit) {
      for (const v of lanes.segs.get('vocal') ?? []) {
        for (let b = Math.floor(v.start / BEATS_PER_BAR); b * BEATS_PER_BAR < v.start + v.length; b++) {
          for (const role of STAB_ROLES) {
            const p = lanes.bar(role, b)
            if (p?.steps.some((x) => x > 2)) lanes.setBar(role, b, { ...p, steps: p.steps.map((x) => Math.min(x, 2)) as Steps })
          }
        }
      }
    }
    vocalNote = `vocal ${vocalItem(take).name} (${takeAbout(take)}): its ${phrase.bars}-bar phrase`
  }

  // ---- the big builds into the drops after the long breakdown (over what the groove through
  // the breakdown laid there) ----
  for (const s of bigBuilds) bigBuildUp(s)

  // ---- intros and outros never the kick alone: where it plays with nothing but FX or a crash (no
  // hats yet, the tops coming in halfway; or the outro's tops gone), the hats play with it (else
  // the first top loop, else the perc). Before the breath and the silence before drops, which stay. ----
  const alongside: [Role, SampleListItem | null] = hats ? ['hats', hats] : tops[0] ? ['top', tops[0]] : ['perc', perc]
  if (alongside[1]) {
    const lone = (b: number) => lanes.state('kick', b) !== '' && !lanes.roles().some((r) => !NOT_ALONGSIDE.has(r) && lanes.state(r, b) !== '')
    for (const s of sections) {
      if (s.kind !== 'intro' && s.kind !== 'outro') continue
      let from = -1
      for (let b = s.start; b <= s.start + s.bars; b++) {
        const alone = b < s.start + s.bars && lone(b)
        if (alone && from < 0) from = b
        if (!alone && from >= 0) {
          layer(alongside[0], alongside[1], from, b, steps(OFFBEAT, 3))
          from = -1
        }
      }
    }
  }

  // ---- the silence before every drop: the track's gap (rule `dropIn`: none, the drum fill alone
  // ringing through it, or the FX), the same before every drop. Tracks from before: where its FX
  // and fill stop (the producer's), or when they run right up to it, the track's beat or two (FX,
  // fills and hits ring through) ----
  rules.dropGaps = dropGaps
  for (const s of sections) {
    if (s.kind !== 'drop' || s.start <= 0) continue
    const t = dropGaps[s.start] ?? 0
    const sixteenths = rules.dropIn != null ? t : t > TO_THE_LINE ? Math.min(t, MAX_SILENCE) : rules.dropSilence * 4
    if (sixteenths) lanes.silence(s.start * 4 - sixteenths / 4, s.start * 4, rules.dropIn === 'gap' ? GAP_THROUGH : THROUGH_SILENCE)
  }

  // ---- a breath before drops: the bar before each one without its tops (and drums and bass),
  // the kick by its own rule, fills and FX playing on ----
  let breaths = 0
  if (rules.dropBreath) {
    const roles: Role[] = [...TOP_ROLES, 'groove', ...(rules.dropBreath === 'all' ? BREATH_DRUMS : [])]
    for (const s of sections) {
      if (s.kind !== 'drop' || s.start < 2) continue
      for (const role of roles) {
        lanes.cut(role, (s.start - 1) * BEATS_PER_BAR, s.start * BEATS_PER_BAR, true)
        lanes.setBar(role, s.start - 1, null)
      }
      breaths++
    }
  }

  // ---- rides (SCOPE.md §6.6): the producer's filter and fader moves on bass and top loops,
  // bar by bar from the track this one is built on (else from a like section of one of them), and
  // the whole mix high-passed into drops. Their own RNG, from the structure: a lane made again
  // rides the same way ----
  const ridden = { parts: new Set<string>(), from: new Set<string>() }
  const sources = rideSources(sections, opts.templates ?? [], new Rng(structureSeed(sections)))
  sections.forEach((sec, i) => {
    const src = sources[i]
    if (!src) return
    for (const [part, roles, name] of RIDE_ROLES) {
      for (const piece of ridePieces(sectionBars(src.arrangement, part, src.from, src.to, sec.bars))) {
        // (No low-pass on the top loops while a drop plays: only the fader part of such a ride.)
        const p = sec.kind === 'drop' && piece.filter?.type === 'lowpass' && roles.every((r) => NO_DROP_LOWPASS.has(r))
          ? { ...piece, filter: undefined } : piece
        if (!p.filter && !p.gainDb && !p.gainTo) continue
        const hit = roles.map((r) => lanes.ride(r, (sec.start + p.from) * BEATS_PER_BAR, (sec.start + p.to) * BEATS_PER_BAR, p)).some(Boolean)
        if (hit) {
          ridden.parts.add(name)
          ridden.from.add(src.arrangement.source_code)
        }
      }
    }
  })
  const hpBars = Number(rules.mixHp ?? 0)
  let hpDrops = 0
  // (Into a big drop the high-pass runs over the big build's last bars, rule `bigHp`, when that is longer.)
  const hpFor = (sec: Section) => (isBig(sec) ? Math.max(hpBars, Number(rules.bigHp ?? 0)) : hpBars)
  if (sections.some((s) => s.kind === 'drop' && hpFor(s))) {
    for (const sec of sections) {
      const hpBars = hpFor(sec)
      if (sec.kind !== 'drop' || !hpBars || sec.start < hpBars) continue
      const a = sec.start - hpBars
      const hz = (b: number) => Math.round(MIX_HP_FROM_HZ * (MIX_HP_TO_HZ / MIX_HP_FROM_HZ) ** ((b - a) / hpBars))
      for (const role of lanes.roles()) {
        if (!MIX_HP_ROLES(role)) continue
        lanes.ride(role, a * BEATS_PER_BAR, sec.start * BEATS_PER_BAR, { filter: { type: 'highpass', from: hz(a), to: hz(sec.start), q: 0.7 }, gainDb: 0 })
        for (let b = a; b < sec.start; b++) {
          const p = lanes.bar(role, b)
          if (p && !p.filter) lanes.setBar(role, b, { ...p, filter: { type: 'highpass', from: hz(b), to: hz(b + 1), q: 0.7 } })
        }
      }
      if (hpBars === Number(rules.mixHp ?? 0)) hpDrops++
    }
  }

  // ---- reverb builds: on the loops still playing into each drop and break (after the silence
  // before drops, so a build peaks where they stop and its tail rings through the gap) ----
  const vo = opts.verb
  const builds = { into: 0, phrase: 0 }
  if (vo?.tops) {
    const roles: Role[] = TOP_ROLES
    const ends = new Map<number, number>()  // bar → bars the build rises over
    sections.forEach((sec, i) => {
      const z = sec.start + sec.bars
      const next = sections[i + 1]?.kind
      if (next === 'drop' || next === 'break') ends.set(z, VERB_INTO_BARS)
      if (vo.every) for (let b = sec.start + vo.every; b <= z && b < total; b += vo.every) if (!ends.has(b)) ends.set(b, VERB_PHRASE_BARS)
    })
    for (const [bar, n] of ends) {
      const hit = roles.map((r) => lanes.swell(r, (bar - n) * BEATS_PER_BAR, bar * BEATS_PER_BAR, vo.amount)).some(Boolean)
      if (hit) builds[n === VERB_INTO_BARS ? 'into' : 'phrase']++
    }
  }
  // The big builds: the top loops (and the groove) and the vocals rising into reverb over the whole
  // build, by its effects (with reverb builds on); the drop comes in dry.
  if (vo) {
    sections.forEach((sec, i) => {
      if (!isBig(sections[i + 1])) return
      const z = sec.start + sec.bars
      const n = bigBarsIn(sec)
      const roles: Role[] = [...(bigFx('tops') ? [...TOP_ROLES, 'groove'] as Role[] : []), ...(bigFx('vocals') ? ['vocal', 'vchop'] as Role[] : [])]
      for (const r of roles) lanes.swell(r, (z - n) * BEATS_PER_BAR, z * BEATS_PER_BAR, Math.max(vo.amount, BIG_VERB_PEAK))
    })
  }

  // ---- the project ----
  const project = newProject('Generated', bpm)
  project.lengthBars = total
  project.lanes = LANES.map((l, i) => ({ ...makeLane(l.name, i), color: l.color }))
  applyMix(project, opts.mix ?? {})
  const bassLane = project.lanes.find((l) => l.name === 'Bass')
  if (bassLane && bo) bassLane.duck = bo.sidechain
  // Kick and bass as one measurement: the sidechain as deep as they collide, as long as the kick rings.
  const fit = bass && bo ? kickBass(kick, bass.notes ?? bass.midi.notes, bass.transpose, bassBars(bass), bpm, bo.sidechain) : null
  if (bassLane && fit) {
    bassLane.duck = fit.duck
    bassLane.duckBeats = fit.beats
  }
  // Stabs that fit: in a room, ducking a little under the kick, and side by side when they take turns.
  if (stabFit) {
    // (A loop's main sound in the middle, its layer just beside it, the pickups the other side.)
    const pans = stabJobs ? stabJobs.map((j) => STAB_JOB_PAN[j])
      : stabs.length === 2 ? [-STAB_PAN, STAB_PAN] : stabs.length >= 3 ? [0, -STAB_PAN, STAB_PAN] : [0]
    STAB_ROLES.forEach((role, i) => {
      const l = project.lanes.find((x) => laneRole(x.name) === role)
      if (!l) return
      l.room = true
      l.duck = stabJobs ? STAB_LOOP_DUCK : STAB_DUCK
      l.duckBeats = STAB_DUCK_BEATS
      l.pan = pans[i] ?? 0
    })
  }
  // The low end in mono: the kick's and the bass's (a kick roll's and the impacts' too).
  for (const l of project.lanes) if (MONO_ROLES.has(laneRole(l.name)!) || (padReese && laneRole(l.name) === 'pad')) l.monoBelow = MONO_BELOW_HZ
  const stringsLane = project.lanes.find((l) => l.name === 'Strings')
  if (stringsLane) stringsLane.duck = opts.strings?.sidechain ?? STRINGS_SIDECHAIN
  const bedLane = project.lanes.find((l) => l.name === 'Ambience')
  if (bedLane) bedLane.duck = BED_DUCK
  const laneIds = new Map(LANES.map((l, i) => [l.role, project.lanes[i].id]))
  project.clips = lanes.clips(laneIds)
  // ---- the fills made anew: a short fill never as it was recorded ----
  const fillWords = rules.fillVariants
    ? varyFills(project.clips, project.lanes.find((l) => l.name === 'Fills')?.id, new Map(all.map((s) => [s.rel_path, s])), fills, new Rng(seed ^ 0x46494c4c))
    : null
  const used = new Set(project.clips.map((c) => c.laneId))
  project.lanes = project.lanes.filter((l) => used.has(l.id))
  project.markers = sections.map((s) => makeMarker(s.label, s.start * 4, (s.start + s.bars) * 4))
  const balance = balanceLanes(project, all, opts, sections, undefined, lead)

  // ---- what was chosen ----
  const n = (k: Section['kind']) => sections.filter((s) => s.kind === k).length
  choices.push(`${n('drop')} drops, ${n('break')} breakdown${n('break') === 1 ? '' : 's'}`)
  for (const s of sections) {
    if (s.kind === 'build') choices.push(BUILD_LABEL[s.build ?? 'layered'])
    if (s.kind === 'break') choices.push(`${s.label}: ${KICK_MODE_LABEL[s.kick ?? 'out']}${s.long ? ' (long)' : ''}`)
  }
  if (bpm !== opts.bpm) choices.push(`${bpm} BPM (library ${opts.bpm})`)
  if (bass) choices.push(`bass in drops, ${rules.bassBreaks === 'filtered' ? `high-passed (${rules.bassHp} Hz)` : 'out'} in breakdowns`)
  if (tops.length && n('break')) choices.push(`tops ${{ filtered: 'low-passed', open: 'open', none: 'out' }[rules.topsBreaks]} in breakdowns`)
  choices.push(...carried)
  if (breaths) choices.push(`${rules.dropBreath === 'all' ? 'tops, drums and bass' : 'tops'} out in the bar before drops`)
  if (hats) {
    const io = { none: 'none', half: 'from halfway', all: 'all through' }
    choices.push(`hats in the intro: ${io[rules.introHats]}, in the outro: ${rules.outroHats === 'half' ? 'the first half' : io[rules.outroHats]}`)
  }
  if (rules.phraseCrash) choices.push(rules.crash8 ? 'crash every 8 bars' : 'crash every 16 bars')
  else if (rules.crash8) choices.push('crash every 8 bars in drops')
  if (rules.phraseKickOut) choices.push('four kicks out every 16 bars')
  if (rules.phraseFill) choices.push('fill every 16 bars')
  if (rules.kickEnd8) choices.push('kick variation every 8 bars')
  if (rules.clapRolls !== 'none') choices.push(`clap rolls every ${rules.clapRolls} bars`)
  if (rules.clapGhost != null) choices.push('ghost claps')
  if (balance.measured) {
    choices.push(balance.tracks ? `mix balanced as in ${balance.tracks} of your tracks` : 'mix balanced on house defaults')
  }
  if (balance.mix) {
    const m = balance.mix
    const k = m.after.reduce((best, v, i) => (Math.abs(v) > Math.abs(m.after[best]) ? i : best), 0)
    const moved = m.moves.map((x) => `${x.lane} ${x.db > 0 ? '+' : ''}${x.db} dB`).join(', ')
    choices.push(`mix checked against ${m.tracks} of your tracks: ${m.off < 0.05 ? 'on it' : `within ${m.off} dB (${REGIONS[k].name} ${m.after[k] > 0 ? '+' : ''}${m.after[k]})`}${moved ? `, after ${moved}` : ''}`)
  }
  if (fit) choices.push(`sidechain ${Math.round(fit.duck * 100)} % over ${fit.beats} beat: the bass ${fit.collision >= 0.5 ? 'sits on' : fit.collision >= 0.2 ? 'partly under' : 'mostly clear of'} the kick (${fit.kickHz} Hz)`)
  if (balance.evened) choices.push(`${balance.evened} sample${balance.evened === 1 ? '' : 's'} levelled to ${balance.evened === 1 ? 'its' : 'their'} lane`)
  if (built) choices.push(`${BUILDUP_NOTE[rules.buildup as typeof BUILDUPS[number]]} into drops (${built} bars)`)
  if (bigBuilt) {
    const drums = { both: 'claps and a snare ' + (rules.bigSnare === 'steps' ? 'in steps' : 'roll'), claps: 'claps', snare: rules.bigSnare === 'steps' ? 'a snare in steps' : 'a snare roll' }[rules.bigDrums as BigDrums]
    const kicks = { out: 'the kick out', back: 'the kick back in its second half', roll: 'a kick roll' }[rules.bigKick as BigKick]
    const fx = (['drums', 'stabs', 'tops', 'vocals'] as const).filter((x) => bigFx(x) && (x === 'drums' || !!opts.verb))
    const more = [`${Number(rules.bigRisers) >= 3 ? 'three' : 'two'} risers`, fx.length ? `reverb${fx.includes('drums') ? ' and delay' : ''} on the ${fx.join(', ')}` : '',
      Number(rules.bigHp) > Number(rules.mixHp ?? 0) ? `the mix high-passed over ${rules.bigHp} bars` : '', rules.bigCrash && crash ? 'crashes coming faster' : ''].filter(Boolean)
    choices.push(`the big build into the drop${mainDrops.size > 1 ? 's' : ''} after the long breakdown: ${bigBuilt} bars, ${drums}, ${kicks}, ${more.join(', ')}`)
  }
  if (crash && rules.buildupCrash !== 'none') choices.push(rules.buildupCrash === 'faster' ? 'crashes coming faster into drops' : 'crashes on the last four counts into drops')
  if (rules.loopGap) choices.push('loops stop before breaks')
  if (tpl) choices.unshift(`structure after ${tpl.label} (${tpl.changes.join(', ')})`)
  if (lanes.feel && feelSrc) {
    const sw = feelSrc.groove?.swing ?? 0
    choices.push(`feel of ${feelSrc.source_code}'s ${feelSrc.category} loop${Math.abs(sw) >= 0.05 ? ` (${Math.round(50 + sw * 50)} % swing)` : ''}`)
  }
  if (rules.pitchTop || rules.pitchPerc2 || rules.pitchHats2) choices.push('a pitched loop layer')
  if (liftOf(sections[0]).length || liftOf(sections[sections.length - 1]).length) choices.push('the intro fills up into the drop, the outro thins out')
  if (rules.firstDrop === 'lean' && sections[1]?.kind === 'drop') choices.push('drop 1 starts leaner')
  if (rules.ioShort) choices.push(`intro loops on their first ${rules.ioShort === 1 ? 'bar' : '2 bars'} at first`)
  if (rules.introGate) choices.push(`intro tops gated, opening up (${GATE_LABEL[rules.introGate as GateFamily]})`)
  if (fillWords) choices.push(fillWords)
  if (varied) {
    const g = rules.gestures as Gestures | null
    choices.push(g ? `${varied} variations of its own: ${g.small.map((t) => TWEAK_LABEL[t]).join(' or ')} every 8 bars, ${TWEAK_LABEL[g.medium]} at 16, ${TWEAK_LABEL[g.big]} at 32`
      : `${varied} small variations at 8-bar marks`)
  }
  if (held !== 'none' && peakDrop) choices.push(`${HOLD_LABEL[held]} held back for the last drop`)
  if (character || kick) {
    const lean = (v: number, lo: string, hi: string) => (Math.abs(v) < 0.25 ? null : `${v < 0 ? lo : hi}`)
    const how = [lean(palette.bright, 'dark', 'bright'), lean(palette.compact, 'soft', 'punchy')].filter(Boolean).join(' and ')
    choices.push(`drums picked as one palette around the kick${how ? ` (${how})` : ''}, loops picked to interlock`)
  }
  if (ridden.parts.size) {
    const own = tpl && ridden.from.size === 1 && ridden.from.has(tpl.source)
    choices.push(`filter and volume rides on ${[...ridden.parts].join(', ')}${own ? ` as in ${tpl!.source}` : ` after ${[...ridden.from].sort().join(', ')}`}`)
  }
  if (hpDrops) choices.push(`the mix high-passed in the ${hpBars === 1 ? 'bar' : `${hpBars} bars`} before drops`)
  if (vocalNote) choices.push(vocalNote)
  if (strings) {
    const at = { later: drops1(sections) ? 'in the second half of the drop' : 'from the second drop', halves: 'in the second half of drops', breaks: 'rising through the breakdowns',
      drops: 'in the drops', all: 'all through', inner: 'between the intro and the outro' }[stringsWhere]
    const moved = stringsMove ? `, moved ${Math.abs(stringsMove)} st ${stringsMove > 0 ? 'up' : 'down'}` : ''
    choices.push(`strings from ${strings.name} ${at}, every ${stringsEvery} bar${stringsEvery === 1 ? '' : 's'}, fading out${moved}`)
  }
  if (discoHits.length) {
    const where = { drops: 'where drops start and halfway', 16: 'every 16 bars of drops', 8: 'every 8 bars of drops', all: 'where drops and breaks start, halfway through drops' }[rules.discoAt]
    choices.push(`disco hit${discoHits.length > 1 ? 's' : ''} ${discoHits.map((s) => s.name).join(' and ')} ${where}`)
  }
  // (After the structure's line, which stays first.)
  if (character) choices.splice(tpl ? 1 : 0, 0, `${CHARACTER_LABEL[character]}${lead ? `, led by ${LEAD_LABEL[lead]}: teased in the intro, in the clear in the breakdowns` : ''}`)
  const bedMove = bed ? bedShift(bed, key)! : 0
  if (bed) choices.push(`ambience bed: ${bed.name}${bedMove ? `, a tonal bed pitched ${bedMove > 0 ? '+' : ''}${bedMove} into ${key}` : ''}, very quiet from the end of the intro to the outro, ducking under the kick`)
  if (padBreaks && padPatch) choices.push(`break layer: ${padReese ? 'a reese' : 'a pad'} (${padPatch.name}) ${padReese ? `on ${key?.replace(/m$/, '')}` : `holding ${key}`}, opening into the next part`)
  if (stabs.length) {
    const where = rules.stabsIn === 'drops' ? 'in drops only'
      : `in drops, ${rules.stabsBreaks === 'filtered' ? 'low-passed' : 'out'} in breakdowns`
    const turns = stabs.length < 2 ? '' : stabJobs ? (stabJobs.includes('layer') ? ' layered' : '') + (stabJobs.includes('pickups') ? `${stabJobs.includes('layer') ? ',' : ''} the last on the pickups` : '')
      : stabs.length === 2 && !stabSteps[0][1].some(Boolean) && !stabSteps[1][0].some(Boolean)
        ? ' taking turns bar by bar' : ' taking turns hit by hit'
    choices.push(`chord stab${stabs.length > 1 ? 's' : ''} ${stabs.map((x) => x.name).join(stabs.length > 2 ? ', ' : ' and ')}${turns}, ${where}`)
    if (stabFit) {
      const moved = stabPitch.filter(Boolean).length ? `, moved ${stabPitch.map((p) => `${p > 0 ? '+' : ''}${p}`).join(' / ')} st into the key` : ''
      const how = [
        bass ? (rules.stabBass === 'lock' ? 'on the bassline\'s syncopations' : 'in the bassline\'s rests') : null,
        rules.stabTurn !== 'none' ? `a turn every 8 bars (${{ drop: 'the last stab left out', push: 'the last stab early', double: 'the last stab twice' }[rules.stabTurn as 'drop' | 'push' | 'double']})` : null,
        rules.stabsOpen !== 'none' ? `a filter opening over ${rules.stabsOpen === 'first' ? 'drop 1' : 'every drop'}` : null,
        rules.stabEcho !== 'none' ? `delay throws ${rules.stabEcho === 'breaks' ? 'into breakdowns' : `every ${rules.stabEcho} bars`}` : null,
        stabGate.some(Boolean) ? 'gated' : null,
        stabMoved ? `the ${rules.stabMoveAt === 'bar' ? 'last hit of every bar' : 'loop\'s last hit'} ${stabMove > 0 ? '+' : ''}${stabMove} st` : null,
        stabLoop ? `announcing drops over ${rules.stabAnnounce} bars (filter and delay rising${rules.stabRoll !== 'none' ? `, a roll in ${rules.stabRoll}` : ''}, thrown into the drop)` : null,
      ].filter(Boolean).join(', ')
      choices.push(`${stabLoop ? 'one stab loop' : 'stabs written for the track'}: ${how || 'with its feel'}${moved}`)
    }
  }
  if (vo && builds.into + builds.phrase) {
    choices.push(`reverb builds on tops${builds.into ? ' into drops and breaks' : ''}${builds.phrase ? `${builds.into ? ',' : ''} every ${vo.every} bars` : ''}`)
  }
  if (tops.length > 1) choices.push(`${Math.min(tops.length, tracks.tops + 1)} top loops`)
  if (claps.length > 1) choices.push(`${claps.length} layered claps`)
  if (ride && held !== 'ride') choices.push({ late: 'ride later in drop 1', second: 'ride from drop 2', both: 'ride late in drop 1, then all through' }[rules.ride])
  if (rules.dropKickOut) choices.push('four kicks out before drops')
  const early = rules.dropIn != null ? [] : Object.values(dropGaps).filter((t) => t > TO_THE_LINE)
  if (rules.dropIn != null && Object.keys(dropGaps).length) {
    const beats = Number(rules.dropInBeats ?? 2)
    choices.push(rules.dropIn === 'straight' ? 'straight into every drop'
      : rules.dropIn === 'gap' ? `${beats} beat${beats === 1 ? '' : 's'} of silence before every drop, the drum fill alone in it`
        : `${beats} beat${beats === 1 ? '' : 's'} before every drop with only the FX pulling in`)
  } else if (early.length) {
    const beats = Math.min(Math.max(...early), MAX_SILENCE) / 4
    choices.push(`FX and fills stop ${beats} beat${beats === 1 ? '' : 's'} before ${early.length < Object.keys(dropGaps).length ? 'a drop' : 'drops'}, the track with them`)
  }
  if (rules.dropIn == null && rules.dropSilence && early.length < Object.keys(dropGaps).length) {
    choices.push(`${rules.dropSilence} beat${rules.dropSilence > 1 ? 's' : ''} of silence before drops`)
  }
  if (set && rules.dropSet) choices.push(`FX into drops as ${set[0].source_code} layered them`)
  if (lanes.segs.get('fx2')?.length) choices.push('two FX layers into drops')
  choices.push(`${rules.fx} FX`)

  const byId = new Map(samples.map((s) => [s.rel_path, s]))
  const zips = [...new Set(project.clips.map((c) => byId.get(c.sample.relPath)?.source_code).filter((x): x is string => !!x))].sort()
  const arc = keep.arc !== undefined ? keep.arc : arcOf(opts.references, tpl)
  return { seed, rngAt, project, sections, key, choices, zips, picks, bass, rules, template: tpl?.source ?? null, mix: balance.mix, arc }
}

/** Places an event whose main sound ends on `endBeat` (generate's endOn). */
type EndOn = (job: string, role: Role, cands: SampleListItem[], endBeat: number, room: number, want: number,
              tonal?: boolean, gap?: number, weight?: (s: SampleListItem) => number) => SampleListItem | null

/** Which way a variation goes. */
export type Tweak = 'kick' | 'hatGap' | 'layerOut' | 'loopVary' | 'clap' | 'fill' | 'lift'
export const TWEAKS: Tweak[] = ['kick', 'hatGap', 'layerOut', 'loopVary', 'clap', 'fill', 'lift']
export const TWEAK_LABEL: Record<Tweak, string> = {
  kick: 'a kick variation', hatGap: 'the hats stopping', layerOut: 'a layer out', loopVary: 'a loop playing another part',
  clap: 'a clap ghost', fill: 'a fill', lift: 'a high-pass lift',
}

/**
 * A track's own variations (rule `gestures`): instead of something new at every 8-bar mark, a small
 * vocabulary used again and again, in a hierarchy: one of two small ones every 8 bars, a medium one
 * at 16, a big one at 32 (there the medium one comes with it). Repetition is the identity.
 */
export interface Gestures { small: Tweak[]; medium: Tweak; big: Tweak }

/** Which variations each character leans to. */
const GESTURE_LEAN: Record<Character | 'none', Record<Tweak, number>> = {
  dub: { kick: 1, hatGap: 1, layerOut: 3, loopVary: 3, clap: 0.5, fill: 0.5, lift: 2 },
  disco: { kick: 1, hatGap: 1, layerOut: 1, loopVary: 1, clap: 3, fill: 3, lift: 2 },
  drums: { kick: 3, hatGap: 3, layerOut: 1, loopVary: 2, clap: 2, fill: 1, lift: 0.5 },
  deep: { kick: 1, hatGap: 1, layerOut: 2, loopVary: 3, clap: 1, fill: 0.5, lift: 2 },
  none: { kick: 1, hatGap: 1, layerOut: 1, loopVary: 1, clap: 1, fill: 1, lift: 1 },
}
/** A variation of the track's vocabulary weighs this much more at its marks; one outside it this much less. */
const VOCAB_BOOST = 6
const VOCAB_OTHER = 0.25

export function drawGestures(rng: Rng, character: Character | null | undefined): Gestures {
  const lean = GESTURE_LEAN[character ?? 'none']
  const left = [...TWEAKS]
  const take = () => {
    const t = rng.pickBy(left, (x) => lean[x])
    left.splice(left.indexOf(t), 1)
    return t
  }
  const small = [take(), take()]
  const medium = take()
  // The big one: the strongest the character has left (a fill or a lift where it can).
  return { small, medium, big: take() }
}

/** What the arc can hold back for the last drop (rule `hold`). */
export type Hold = 'ride' | 'perc2' | 'hats2' | 'groove' | 'none'
export const HOLD_LABEL: Record<Exclude<Hold, 'none'>, string> = { ride: 'the ride', perc2: 'the second perc', hats2: 'the second hat loop', groove: 'the groove loop' }
const HOLD_LEAN: Record<Character | 'none', [Hold, number][]> = {
  dub: [['ride', 3], ['perc2', 2], ['groove', 1], ['hats2', 1], ['none', 1]],
  disco: [['groove', 3], ['ride', 2], ['hats2', 2], ['perc2', 1], ['none', 1]],
  drums: [['perc2', 3], ['groove', 2], ['hats2', 2], ['ride', 1], ['none', 1]],
  deep: [['ride', 3], ['hats2', 2], ['perc2', 1], ['groove', 1], ['none', 1]],
  none: [['ride', 2], ['perc2', 2], ['hats2', 1], ['groove', 1], ['none', 1]],
}

/**
 * Every 8-bar mark inside a section gets a change: where nothing in the arrangement changes
 * there (no new element, no fill, kick variation or crash), one subtle variation is added: a
 * kick variation, the hats stopping for a beat or two, a loop layer out for a bar, a loop playing
 * another part of itself (only its first bars, from another bar) or pitched for the next 8 bars,
 * a clap ghost note, a fill, a high-pass lift on a top loop. The DJ intro and outro keep their
 * steady kick and hats. Returns how many were added.
 */
function everyEightBars(lanes: Lanes, sections: Section[], rng: Rng,
                        ctx: { kick: SampleListItem | null; fill: EndOn | null; fills: SampleListItem[]; shapedBreaks?: boolean; gestures?: Gestures | null }):
  { added: number; used: Partial<Record<Tweak, number>> } {
  // (Not the stabs: their 2-bar rhythm changes every bar, and the drums are the same with or without them.)
  const changed = (b: number) => lanes.roles().filter((r) => !STAB_ROLES.includes(r)).some((r) => {
    const s1 = lanes.state(r, b - 1)
    return lanes.state(r, b) !== s1 || s1 !== lanes.state(r, b - 2)
  })
  const LAYERS: Role[] = ['perc', 'perc2', 'hats2', 'top2', 'top3', 'top4', 'groove']
  const VARY: Role[] = ['top', 'top2', 'top3', 'top4', 'groove', 'perc', 'perc2', 'hats2']
  let last: Tweak | null = null
  let added = 0
  const used: Partial<Record<Tweak, number>> = {}
  const voc = ctx.gestures
  for (const sec of sections) {
    // (A breakdown with the groove carried through has its own shape: nothing is taken out of it here,
    // least of all the one part that keeps time.)
    if (ctx.shapedBreaks && sec.kind === 'break') continue
    const end = sec.start + sec.bars
    const io = sec.kind === 'intro' || sec.kind === 'outro'
    for (let b = sec.start + PHRASE; b < end; b += PHRASE) {
      if (changed(b)) { last = null; continue }
      const B = b * BEATS_PER_BAR
      const cands: [Tweak, number, () => void][] = []
      const kickBar = lanes.bar('kick', b - 1)
      if (!io && ctx.kick && kickBar && kickBar.steps.join('') === steps(FOUR).join('')) {
        cands.push(['kick', sec.kind === 'drop' ? 2 : 1, () => lanes.setBar('kick', b - 1, { ...kickBar, steps: [...rng.weighted(KICK_PHRASE_ENDS)] })])
      }
      if (!io && lanes.loopOver('hats', B - 4, B + 4)) {
        cands.push(['hatGap', 2, () => lanes.cut('hats', B - rng.pick([1, 2]), B)])
      } else if (lanes.bar('hats', b - 1)) {
        // One-shot hats: the last ones out (or, in the intro and outro, a soft 16th more).
        const p = lanes.bar('hats', b - 1)!
        const s = io ? p.steps.map((v, i) => (i === 15 && !v ? 1 : v)) : p.steps.map((v, i) => (i >= 12 ? 0 : v))
        cands.push(['hatGap', 1.5, () => lanes.setBar('hats', b - 1, { ...p, steps: s as Steps })])
      }
      const out = LAYERS.filter((r) => lanes.loopOver(r, B - 4, B + 4))
      if (out.length) {
        cands.push(['layerOut', 2, () => {
          const r = rng.pick(out)
          lanes.cut(r, B - rng.pick([4, 2]), B)
        }])
      }
      const next = Math.min(end, b + PHRASE) * BEATS_PER_BAR
      // The hats too, though never with a gap in the DJ intro and outro.
      const vary = [...VARY, 'hats' as Role].filter((r) => lanes.loopOver(r, B, next))
      if (vary.length) {
        cands.push(['loopVary', 3, () => {
          const r = rng.pick(vary)
          const seg = lanes.loopOver(r, B, next)!
          const L = loopLen(seg)
          const bars = L / BEATS_PER_BAR  // what it repeats now (only the first bars, maybe)
          const how = rng.weighted([['first', bars >= 2 ? 3 : 0], ['rotate', bars >= 2 ? 2 : 0],
            ['pitch', seg.pitch ? 0 : 1], ['half', (seg.sample.bars ?? 1) === 1 || (io && r === 'hats') ? 0 : 0.5]] as const)
          if (how === 'first') lanes.vary(r, B, next, { loopBars: rng.pick([1, 2].filter((n) => n < bars)), trim: 0 })
          else if (how === 'rotate') {
            // From another bar of the loop than where it is now (else it would just play on).
            const now = ((seg.trim ?? 0) + B - seg.start) % L
            lanes.vary(r, B, next, { trim: (now + BEATS_PER_BAR * rng.int(1, bars - 1)) % L })
          }
          else if (how === 'pitch') lanes.vary(r, B, next, { pitch: rng.pick([-1, 1]) })
          else lanes.cut(r, B + 2, B + 4)  // a short break in the loop on the new part's first bar
        }])
      }
      const clapBar = lanes.bar('clap', b - 1)
      if (!io && clapBar) {
        cands.push(['clap', 1.5, () => {
          const ghost = rng.pick([[13, 15], [11, 14], [15]])
          lanes.setBar('clap', b - 1, { ...clapBar, steps: clapBar.steps.map((v, i) => (ghost.includes(i) && !v ? (i === 15 ? 2 : 1) : v)) as Steps })
        }])
      }
      // A fill into it (in the intro and outro only when nothing else plays with the kick).
      const lift = TOP_ROLES.filter((r) => lanes.loopOver(r, B - 4, B) && !lanes.loopOver(r, B - 4, B)!.filter)
      if (ctx.fill && (!io || (!cands.length && !lift.length)) && ![b - 2, b - 1, b].some((x) => lanes.state('fills', x))) {
        const endOn = ctx.fill
        cands.push(['fill', 0.8, () => { endOn('fill', 'fills', ctx.fills, B, 8, 1) }])
      }
      if (lift.length) {
        cands.push(['lift', 1, () => lanes.vary(rng.pick(lift), B - 4, B, { filter: { type: 'highpass', from: 200, to: 2500, q: 0.8 } })])
      }
      // The mark's place in the section: every 8 bars, at 16, at 32 (the track's vocabulary for each).
      const k = (b - sec.start) / PHRASE
      const tier = k % 4 === 0 ? 'big' : k % 2 === 0 ? 'medium' : 'small'
      const vocab: Tweak[] | null = voc ? (tier === 'small' ? voc.small : [voc[tier]]) : null
      const weigh = ([t, w]: [Tweak, number, () => void]) => vocab ? w * (vocab.includes(t) ? VOCAB_BOOST : VOCAB_OTHER) : t === last ? w * 0.3 : w
      // One that really changes something (another if it didn't, say a rotation landing in phase).
      while (cands.length) {
        const pick = rng.pickBy(cands, weigh)
        pick[2]()
        cands.splice(cands.indexOf(pick), 1)
        if (changed(b)) {
          last = pick[0]
          used[pick[0]] = (used[pick[0]] ?? 0) + 1
          added++
          // At 32 bars the medium one comes with it: a bigger change.
          const also = tier === 'big' && voc ? cands.find(([t]) => t === voc.medium) : undefined
          if (also) {
            also[2]()
            used[also[0]] = (used[also[0]] ?? 0) + 1
          }
          break
        }
      }
    }
  }
  return { added, used }
}

/** The track rules each lane owns: re-rolling the lane draws these again, the others stay. */
const LANE_RULES: Partial<Record<Role, string[]>> = {
  kick: ['phraseKickOut', 'kickEnd8', 'dropKickOut', 'dropLastKick', 'breakLastKick', 'ioKickHp'],
  clap: ['clapGhost', 'clapRolls', 'ioClaps'],
  hats: ['hatsInBreaks', 'introHats', 'outroHats'],
  ride: ['ride'],
  perc: ['ioPerc', 'perc2From'],
  top: ['dropTops', 'ioTopFirst', 'ioTopSecond', 'topsBreaks', 'topsBreakHz', 'dropBreath'],
  groove: ['grooveFrom', 'grooveSwap', 'switchHalfway'],
  crash: ['phraseCrash', 'crash8', 'breakCrash', 'outroCrash', 'buildupCrash'],
  buildup: ['buildup', 'buildupBars'],
  fills: ['phraseFill', 'dropFill', 'breakFill', 'outroFill'],
  fx: ['fx', 'dropRiser', 'breakSweep', 'fxLayers', 'dropSet', 'bigRisers'],
  hits: ['dropImpact', 'breakDownlifter', 'dropDown'],
  bass: ['bassBreaks', 'bassBuild', 'bassIO', 'bassHp', 'bassTurn', 'bassTurnKind'],
  disco: ['discoIn', 'discoCount', 'discoAt'],
  // The Strings lane made again: another sample and placement (it stays strings).
  strings: [...STRINGS_RULES],
  // The Pad lane made again: another patch for the breakdown layer.
  pad: ['padPreset', 'padHz'],
  // The Ambience lane made again: another texture.
  bed: [],
  // The vocal lanes made again: another take, and how and where it's sung (it stays a vocal).
  vocal: ['vocalLoop', 'vocalAt'],
  // A stab lane made again: another sample in the same rhythm (the others play their turns in it).
  stab: [],
}
const LAYER_OF: Partial<Record<Role, Role>> = {
  clap2: 'clap', clap3: 'clap', hats2: 'hats', perc2: 'perc', top2: 'top', top3: 'top', top4: 'top', fx2: 'fx', fx3: 'fx', disco2: 'disco', stab2: 'stab', stab3: 'stab', vchop: 'vocal',
}

/**
 * The same track with one lane made again (the Generate view's per-lane button): a new sample
 * and the lane's own rules drawn again (a crash every 8 bars instead of 16, kicks out at other
 * places, fills into other parts, …), over the same structure, key, tempo and track-wide rules
 * (the silence before drops, and where each drop's FX stop). Every other lane stays exactly as
 * it is. Samples already in the track are avoided. On the Bass lane: another bassline and/or
 * patch. Null when nothing new comes out (the library has nothing else: for FX and fills, nothing
 * else in key that stops where the drop's other FX and the track's silence do).
 */
export function rerollLane(all: SampleListItem[], opts: GenerateOptions, g: Generation, laneId: string, seed: number): Generation | null {
  const lane = g.project.lanes.find((l) => l.id === laneId)
  const role = lane && laneRole(lane.name)
  if (!lane || !role) return null
  const own = new Set(LANE_RULES[LAYER_OF[role] ?? role] ?? [])
  if (role === 'buildup') return rerollBuildup(all, opts, g, seed)
  const rules = Object.fromEntries(Object.entries(rulesOf(g)).filter(([k]) => !own.has(k)))
  const picks = Object.fromEntries(Object.entries(g.picks).filter(([r]) => r !== role)) as Generation['picks']
  const sig = (cs: Clip[]) => JSON.stringify(cs.map(({ id: _i, laneId: _l, ...c }) => c))
  const before = g.project.clips.filter((c) => c.laneId === laneId)
  const elsewhere = new Set(g.project.clips.filter((c) => c.laneId !== laneId).map((c) => c.sample.relPath))
  const bpm = g.project.bpm
  for (let i = 0; i < 12; i++) {
    const r = generate(all, { ...opts, tempo: { min: bpm, max: bpm }, bass: role === 'bass' ? opts.bass : null }, seed + i * 7919, {
      structure: g.sections, arc: g.arc ?? null, key: g.key, picks, rules, avoid: g.project.clips.map((c) => c.sample.relPath),
    })
    const rl = r.project.lanes.find((l) => l.name === lane.name)
    const clips = rl ? r.project.clips.filter((c) => c.laneId === rl.id) : []
    if (!clips.length || sig(clips) === sig(before)) continue
    if (role !== 'bass' && clips.every((c) => before.some((b) => b.sample.relPath === c.sample.relPath))) continue
    // (Nor a sound another lane plays already: the FX layers of a drop are three different risers.)
    if (role !== 'bass' && clips.some((c) => elsewhere.has(c.sample.relPath))) continue
    if (role === 'bass' && r.bass && g.bass && r.bass.midi.id === g.bass.midi.id && r.bass.preset.path === g.bass.preset.path) continue
    const project = structuredClone(g.project)
    project.clips = [...project.clips.filter((c) => c.laneId !== laneId), ...clips.map((c) => ({ ...c, laneId }))]
    const kept = project.lanes.find((l) => l.id === laneId)!
    kept.levelDb = rl!.levelDb
    kept.eq = rl!.eq && structuredClone(rl!.eq)
    kept.comp = rl!.comp && { ...rl!.comp }
    // (A new bassline sits differently under the kick: its sidechain with it.)
    if (role === 'bass' && rl!.duckBeats != null) { kept.duck = rl!.duck; kept.duckBeats = rl!.duckBeats }
    const nextPicks = { ...g.picks }
    if (r.picks[role]) nextPicks[role] = r.picks[role]
    const nextRules = { ...g.rules, ...Object.fromEntries(Object.entries(r.rules).filter(([k]) => own.has(k))) }
    const byPath = new Map(all.map((s) => [s.rel_path, s]))
    const zips = [...new Set(project.clips.map((c) => byPath.get(c.sample.relPath)?.source_code).filter((x): x is string => !!x))].sort()
    return { ...g, project, picks: nextPicks, rules: nextRules, zips, bass: role === 'bass' ? r.bass : g.bass }
  }
  return null
}

/**
 * The same track in another key (the Generate view's key menu). The bass part is the same part
 * moved into it the nearest way (its patch octave and any semitones set stay), disco hits and
 * chord stabs are pitched for it, and tonal FX (risers, downlifters, atmos, …) whose key doesn't fit are
 * swapped for ones that do: the same kind, and for those leading into a line the same body length
 * and silence before it, so they still end where they did. The drums stay exactly as they are.
 */
export function changeKey(all: SampleListItem[], opts: GenerateOptions, g: Generation, key: string, seed: number): Generation {
  const rng = new Rng(seed)
  const project = structuredClone(g.project)
  const move = (b: GenerationBass | null): GenerationBass | null => b && {
    ...b, transpose: Math.max(-24, Math.min(24, b.transpose - transposeTo(b.midi.key_label, g.key) + transposeTo(b.midi.key_label, key))),
  }
  const bass = move(g.bass)
  // The strings: their sample moved into the new key when it's close enough, else another one that
  // is (the same places); none is: they go.
  const stringHits = opts.strings?.hits ?? []
  const was = g.picks.strings && stringHits.find((h) => stringsItem(h).id === g.picks.strings!.id)
  const fitting = stringHits.filter((h) => stringsShift(h, key) != null)
  const stringsHit = !g.picks.strings ? null : was && stringsShift(was, key) != null ? was
    : fitting.length ? new Rng(seed ^ 0x53545247).pick(fitting) : null
  const strings = stringsHit && { hit: stringsHit, shift: stringsShift(stringsHit, key)! }
  // The ambience bed: noise stays as it is; a tonal bed is moved into the new key, or another one
  // that moves takes its place (one would be heard as recorded); none does: it goes. (One no longer
  // on the Ambience page stays as it is.)
  const bedHits = opts.ambience?.hits ?? []
  const wasBed = g.picks.bed ? bedHits.find((h) => bedItem(h).id === g.picks.bed!.id) : undefined
  const movingBeds = bedHits.filter((h) => bedShift(h, key) != null)
  const bedHit = !wasBed ? null : bedShift(wasBed, key) != null ? wasBed
    : movingBeds.length ? new Rng(seed ^ 0x414d4249).pick(movingBeds) : null
  const hitOf = new Map([...opts.disco?.hits ?? [], ...opts.stabs?.hits ?? []].map((h) => [h.rel_path, h]))
  const byPath = new Map(all.map((s) => [s.rel_path, s]))
  const fits = new Set(expandCompatible([key]))
  const inProject = new Set(project.clips.map((c) => c.sample.relPath))
  const swaps = new Map<string, SampleListItem | null>()
  const swapFor = (s: SampleListItem, looped: boolean): SampleListItem | null => {
    const id = `${s.rel_path}|${looped}`
    if (!swaps.has(id)) {
      const inKey = all.filter((x) => x.kind === s.kind && x.category === s.category && x.key_label && fits.has(x.key_label))
      // Looped (atmos under a breakdown): any length; leading into a line: ending the same way.
      const same = looped ? inKey : inKey.filter((x) => bodyBars(x) === bodyBars(s) && gapsAgree(gapOf(x), gapOf(s)))
      const fresh = same.filter((x) => !inProject.has(x.rel_path))
      const pick = fresh.length ? rng.pick(fresh) : same.length ? rng.pick(same) : null
      if (pick) inProject.add(pick.rel_path)
      swaps.set(id, pick)
    }
    return swaps.get(id)!
  }
  let swapped = 0
  let kept = 0
  project.clips = project.clips.map((c) => {
    if (c.type === 'audio' && c.bass?.role === 'pad') {
      // The breakdown layer: its chord or note written again in the new key.
      const notes = padNotes(key, c.bass.midiName === 'Reese')
      if (!notes) return c
      const render = { ...c.bass, keyLabel: key, notes }
      return { ...c, bass: render, sample: { ...c.sample, relPath: bassPath(render, project.bpm) } }
    }
    if (c.type === 'audio' && c.bass?.role === 'vocal') {
      // A vocal phrase: from the key it's sung in into the new one.
      const render = { ...c.bass, keyLabel: key, transpose: Math.max(-12, Math.min(12, transposeTo(c.bass.vocal?.key ?? null, key))) }
      return { ...c, bass: render, sample: { ...c.sample, relPath: bassPath(render, project.bpm) } }
    }
    const chop = c.type === 'pattern' && c.sample.relPath.startsWith('Vocals/')
      ? opts.vocals?.takes.flatMap((t) => t.analysis.chops).find((x) => x.path === c.sample.relPath) : undefined
    if (chop) {
      const { pitch: _p, ...rest } = c
      const pitch = chopPitch(chop.note, key)
      return pitch ? { ...rest, pitch } : rest
    }
    if (c.type === 'audio' && c.bass?.role === 'strings' && strings) {
      const render = stringsRender(strings.hit, key, strings.shift, project.bpm)
      return { ...c, bass: render, sample: { ...c.sample, ...sampleRef(stringsSample(stringsItem(strings.hit), render, project.bpm)) } }
    }
    if (c.type === 'audio' && c.bass?.role === 'ambience' && bedHit) {
      const render = bedRender(bedHit, project.bpm, key, bedShift(bedHit, key)!)
      return { ...c, bass: render, sample: { ...c.sample, ...sampleRef(bedSample(bedItem(bedHit), render, project.bpm)) } }
    }
    // (Keys parts, stab patches and drones of older tracks stay as they are.)
    if (c.type === 'audio' && c.bass) {
      if (!bass || (c.bass.role ?? 'bass') !== 'bass') return c
      const render = bassClipRender(bass, c.bass)
      return { ...c, bass: render, sample: { ...c.sample, relPath: bassPath(render, project.bpm) } }
    }
    const hit = c.sample.category === 'disco_hit' || c.sample.category === 'chord_stab' ? hitOf.get(c.sample.relPath) : undefined
    if (hit) {
      const { pitch: _p, ...rest } = c
      const pitch = hitPitch(hit, key)
      return pitch ? { ...rest, pitch } : rest
    }
    const s = byPath.get(c.sample.relPath)
    if (c.type !== 'audio' || !s || !TONAL.includes(s.category) || !s.key_label || fits.has(s.key_label)) return c
    const looped = c.length > (s.bars ?? 1) * BEATS_PER_BAR + 1e-6
    const x = swapFor(s, looped)
    if (!x) {
      kept++
      return c
    }
    swapped++
    const next = replaceSample(c, sampleRef(x))
    // An event plays once: no longer than the new one (a longer clip would repeat it).
    return looped ? next : { ...next, length: Math.min(c.length, (x.bars ?? 1) * BEATS_PER_BAR) }
  })
  const picks = { ...g.picks }
  if (strings) picks.strings = stringsItem(strings.hit)
  else if (g.picks.strings) {
    delete picks.strings
    project.clips = project.clips.filter((c) => !(c.type === 'audio' && c.bass?.role === 'strings'))
    project.lanes = project.lanes.filter((l) => l.name !== 'Strings' || project.clips.some((c) => c.laneId === l.id))
  }
  if (bedHit) picks.bed = bedItem(bedHit)
  else if (wasBed) {
    delete picks.bed
    project.clips = project.clips.filter((c) => !(c.type === 'audio' && c.bass?.role === 'ambience'))
    project.lanes = project.lanes.filter((l) => l.name !== 'Ambience' || project.clips.some((c) => c.laneId === l.id))
  }
  const zips = [...new Set(project.clips.map((c) => byPath.get(c.sample.relPath)?.source_code).filter((z): z is string => !!z))].sort()
  const note = `in ${key} (made in ${g.key ?? 'no key'})${swapped ? `, ${swapped} FX swapped for ones in key` : ''}${kept ? `, ${kept} kept: nothing else in key` : ''}`
  const choices = [...g.choices.filter((c) => !KEY_NOTE.test(c)), note]
  return { ...g, project, key, bass, zips, choices, picks }
}

/**
 * New disco hits for the same track (the Generate view's Disco Hits module): one or two hits and
 * where they land drawn again, over the same structure, key and everything else, which stays
 * exactly as it is. Always some hits (the button asks for them); others than the track has when
 * there are. Null when the Disco Hits page has none, or nothing new comes out.
 */
export function rerollDisco(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number): Generation | null {
  if (!opts.disco?.hits.length) return null
  return rerollGroup(all, opts, g, seed, new Set<Role>(['disco', 'disco2']), new Set(LANE_RULES.disco), { discoIn: true }, 'disco hit')
}

/**
 * New chord stabs for a generation (the Chord Stabs module's button): other stab samples, another
 * rhythm and placement. The rest stays exactly as it is. Null when nothing new comes out.
 */
export function rerollStabs(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number): Generation | null {
  if (!opts.stabs?.hits.length) return null
  return rerollGroup(all, opts, g, seed, new Set<Role>(STAB_ROLES), new Set(STAB_RULES), { stabs: true }, 'chord stab')
}

/** The rules the stab reroll draws again. */
const STAB_RULES = ['stabs', 'stabRhythm', 'stabsIn', 'stabsBreaks', 'stabsBuild', 'stabsCutoff', 'stabCount', 'stabTurns',
  'stabFit', 'stabBass', 'stabTurn', 'stabsOpen', 'stabsTease', 'stabsGrow', 'stabEcho', 'stabLoop', 'stabLayout', 'stabAnnounce', 'stabRoll',
  'stabMove', 'stabMoveAt']

/**
 * The lanes of `roles` made again (with their rules `own`, `force` set), the rest of the track
 * as it is: a lane the result doesn't have goes, one the track didn't have comes in its place.
 */
/**
 * New strings for the same track (the Generate view's Strings module): another sample and
 * placement, or strings in a track that had none; everything else exactly as it is. Null when the
 * Strings page has no sample close enough to the key, or nothing new comes out.
 */
/** Another ambience bed for the same track (the Ambience module's button), or one in a track without; the rest as it is. */
export function rerollBed(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number): Generation | null {
  if (!opts.ambience?.hits.length) return null
  return rerollGroup(all, opts, g, seed, new Set<Role>(['bed']), new Set(), { bedIn: true }, 'ambience bed')
}

/** Another breakdown layer for the same track (the Pads module's button), or one in a track without; the rest as it is. */
export function rerollPad(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number): Generation | null {
  if (!opts.pads?.presets.length || !g.key) return null
  return rerollGroup(all, opts, g, seed, new Set<Role>(['pad']), new Set(LANE_RULES.pad), { padIn: true }, 'break layer')
}

export function rerollStrings(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number): Generation | null {
  if (!opts.strings?.hits.length) return null
  return rerollGroup(all, opts, g, seed, new Set<Role>(['strings']), new Set(LANE_RULES.strings), { stringsIn: true }, 'strings')
}

/**
 * A new vocal for the same track (the Generate view's Vocals module): another take, sung another
 * way (phrase, chops or both, and where), the rest exactly as it is. Null without takes, or when
 * nothing new comes out.
 */
export function rerollVocal(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number): Generation | null {
  if (!opts.vocals?.takes.length) return null
  return rerollGroup(all, opts, g, seed, new Set<Role>(['vocal', 'vchop']), new Set(LANE_RULES.vocal), { vocalIn: true }, 'vocal')
}

/** Another string sample for the same track (the Strings lane's "New sound"): where it plays stays. */
export function newStringsSound(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number): Generation | null {
  if (!g.picks.strings || !opts.strings?.hits.length) return null
  return rerollGroup(all, opts, g, seed, new Set<Role>(['strings']), new Set(), { stringsIn: true }, 'strings')
}

function rerollGroup(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number, roles: Set<Role>,
                     own: Set<string>, force: Rules, choice: string): Generation | null {
  const rules = { ...Object.fromEntries(Object.entries(rulesOf(g)).filter(([k]) => !own.has(k))), ...force }
  const picks = Object.fromEntries(Object.entries(g.picks).filter(([r]) => !roles.has(r as Role))) as Generation['picks']
  const sig = (p: Project) => JSON.stringify(groupClips(p, roles).map(({ id: _i, laneId, ...c }) => [p.lanes.find((l) => l.id === laneId)!.name, c]))
  const bpm = g.project.bpm
  for (let i = 0; i < 12; i++) {
    const r = generate(all, { ...opts, tempo: { min: bpm, max: bpm }, bass: null }, seed + i * 7919, {
      structure: g.sections, arc: g.arc ?? null, key: g.key, picks, rules, avoid: groupClips(g.project, roles).map((c) => c.sample.relPath),
    })
    if (!groupClips(r.project, roles).length || sig(r.project) === sig(g.project)) continue
    return swapGroup(g, r, roles, own, picks, choice)
  }
  return null
}

const groupClips = (p: Project, roles: Set<Role>) => p.clips.filter((c) => roles.has(laneRole(p.lanes.find((l) => l.id === c.laneId)?.name ?? '')!))

/**
 * `g` with the lanes of `roles` (their clips, picks, rules `own` and choices) as `r` has them.
 * `choice`: the choices starting with it are `r`'s; null: all of them are (but a key change).
 */
function swapGroup(g: Generation, r: Generation, roles: Set<Role>, own: Set<string>, picks: Generation['picks'], choice: string | null): Generation {
  const inGroup = (laneName: string) => roles.has(laneRole(laneName)!)
  // The track's own lanes keep their mix (volume, mute, …); a lane it didn't have comes from `r`.
  const project = structuredClone(g.project)
  // (Their level in the mix follows their new samples.)
  const lanes = r.project.lanes.filter((l) => inGroup(l.name)).map((l) => {
    const own = project.lanes.find((x) => x.name === l.name)
    // (A stab lane's room and sidechain follow how its stabs are placed.)
    const stab = STAB_ROLES.includes(laneRole(l.name)!) ? { room: l.room, duck: l.duck, duckBeats: l.duckBeats } : {}
    return own ? { ...own, levelDb: l.levelDb, eq: l.eq && structuredClone(l.eq), comp: l.comp && { ...l.comp }, ...stab } : structuredClone(l)
  })
  const clips = groupClips(r.project, roles).map((c) => ({ ...c, laneId: lanes.find((l) => l.name === r.project.lanes.find((x) => x.id === c.laneId)!.name)!.id }))
  project.lanes = project.lanes.filter((l) => !inGroup(l.name))
  for (const l of lanes) {
    // In the track's lane order: before the first lane that comes after it.
    const at = LANES.findIndex((x) => x.name === l.name)
    const before = project.lanes.findIndex((x) => LANES.findIndex((y) => y.name === x.name) > at)
    project.lanes.splice(before < 0 ? project.lanes.length : before, 0, l)
  }
  project.clips = [...project.clips.filter((c) => !inGroup(g.project.lanes.find((l) => l.id === c.laneId)?.name ?? '')), ...clips]
  const nextPicks: Generation['picks'] = { ...picks }
  for (const role of roles) if (r.picks[role]) nextPicks[role] = r.picks[role]
  const nextRules = { ...g.rules, ...Object.fromEntries(Object.entries(r.rules).filter(([k]) => own.has(k))) }
  const choices = choice == null ? [...r.choices, ...g.choices.filter((c) => KEY_NOTE.test(c))]
    : [...g.choices.filter((c) => !c.startsWith(choice)), ...r.choices.filter((c) => c.startsWith(choice))]
  return { ...g, project, picks: nextPicks, rules: nextRules, choices }
}

/** The note a key change leaves in a track's choices. */
const KEY_NOTE = /^in \S+ \(made in /

/**
 * The current generation's stabs playing another rhythm (edited in the Chord Stabs module's step
 * sequencer): the same stab, where it played, the rest of the track exactly as it is. Null when
 * the track has no stabs.
 */
export function setStabRhythm(all: SampleListItem[], opts: GenerateOptions, g: Generation, rhythm: Velocity[][]): Generation | null {
  const roles = new Set(STAB_ROLES)
  if (!g.rules.stabs) return null
  const bpm = g.project.bpm
  const r = generate(all, { ...opts, tempo: { min: bpm, max: bpm }, bass: null }, g.seed, {
    structure: g.sections, arc: g.arc ?? null, key: g.key, picks: g.picks, rules: { ...rulesOf(g), stabRhythm: rhythm },
  })
  return swapGroup(g, r, roles, new Set(['stabRhythm']), g.picks, 'chord stab')
}

// ---------------------------------------------------------------------------
// Changing a made track: one of its rules, a lane's sound
// ---------------------------------------------------------------------------

/**
 * The bass clips of `project` playing exactly what `g`'s bass does (a bassline or patch changed
 * since, an octave): a remake writes where it plays, not what.
 */
function sameRenders(g: Generation, project: Project): void {
  const bpm = project.bpm
  const b = g.bass
  if (!b) return
  for (const c of project.clips) {
    if (c.type !== 'audio' || !c.bass || (c.bass.role ?? 'bass') !== 'bass') continue
    c.bass = bassClipRender(b, c.bass)
    const bars = bassBars(b)
    c.sample = { ...c.sample, relPath: bassPath(c.bass, bpm), name: `${b.preset.name} · ${b.midi.name}`, bars, durationS: (bars * BEATS_PER_BAR * 60) / bpm }
    c.trimBeats %= bars * BEATS_PER_BAR
  }
}

/**
 * The same track with one of its rules set to `value` (a choice changed in Generate): the lanes
 * it shapes (`roles`) made again with it, over the same structure, key and samples, every other
 * rule as it was; the other lanes stay exactly as they are. Made from where the track's own RNG
 * was, so what doesn't follow from the rule comes out as it did.
 */
export function setTrackRule(all: SampleListItem[], opts: GenerateOptions, g: Generation, rule: string, value: unknown, roles: Role[]): Generation {
  return setTrackRules(all, opts, g, { [rule]: value }, roles)
}

/** Rules that follow when one of them is set: a build-up and a roll sample into drops don't go together. */
const COUPLED: Record<string, string[]> = { dropFill: ['buildup'], buildup: ['dropFill'] }

/** setTrackRule for several rules at once (`picks`: the samples kept, `avoid`: ones not to take again). */
function setTrackRules(all: SampleListItem[], opts: GenerateOptions, g: Generation, values: Rules, roles: Role[],
                       picks: Generation['picks'] = g.picks, avoid?: string[]): Generation {
  const bpm = g.project.bpm
  const rules = { ...rulesOf(g), ...values }
  const r = generate(all, { ...opts, tempo: { min: bpm, max: bpm }, locks: { ...opts.locks, ...values } }, g.seed, {
    structure: g.sections, arc: g.arc ?? null, key: g.key, picks, rules, replay: g.rngAt, avoid,
  })
  // A part the remake can't play again (its module off since, its samples gone) stays as it is.
  const gone = (role: Role) => (role === 'bass' && g.bass && !r.bass)
    || (STAB_ROLES.includes(role) && g.rules.stabs && !r.rules.stabs) || (role === 'strings' && !!g.picks.strings && !r.picks.strings)
  const own = new Set(Object.keys(values).flatMap((k) => [k, ...COUPLED[k] ?? []]))
  const next = swapGroup(g, r, new Set(roles.filter((x) => !gone(x))), own, picks, null)
  sameRenders(g, next.project)
  return { ...next, rules: { ...next.rules, ...values } }
}

/** The lanes a build-up plays on or takes the place of. */
export const BUILDUP_ROLES: Role[] = ['buildup', 'kick', 'clap', 'fills']

/**
 * The Build-up lane made again: another kind of build-up (and how many bars it runs) and another
 * snare, made from where the track's random stream was, so the kick and clap lanes it takes the
 * place of follow and the rest stays exactly as it is.
 */
function rerollBuildup(all: SampleListItem[], opts: GenerateOptions, g: Generation, seed: number): Generation | null {
  const rng = new Rng(seed)
  const was = rulesOf(g).buildup
  const values = { buildup: rng.pick(BUILDUPS.filter((b) => b !== was)), buildupBars: rng.pick([2, 4, 8]) }
  const picks = Object.fromEntries(Object.entries(g.picks).filter(([r]) => r !== 'buildup')) as Generation['picks']
  const lane = g.project.lanes.find((l) => l.name === 'Build-up')
  const r = setTrackRules(all, opts, g, values, BUILDUP_ROLES, picks, g.project.clips.filter((c) => c.laneId === lane?.id).map((c) => c.sample.relPath))
  return r.rules.buildup === 'none' ? null : r
}

/**
 * A lane with other sounds where it plays (Generate's and Arrange's "New sound"): each sample
 * on it swapped for another of the same kind (a clap for a clap, a 4-bar top loop for a top
 * loop), FX for ones that end the same way and fit the key; the clips stay where they are, the
 * rest of the track exactly as it is. Not for rendered parts (the bass: another patch). Null when the library has nothing else.
 * `choose` picks the swap itself (the critic, critic.ts): from a sample on the lane and the ones
 * that could take its place, the one that does, or null to leave that sample where it is.
 */
export function newLaneSound(all: SampleListItem[], opts: GenerateOptions, g: Generation, laneId: string, seed: number,
                             choose?: (s: SampleListItem, cands: SampleListItem[]) => SampleListItem | null): Generation | null {
  const lane = g.project.lanes.find((l) => l.id === laneId)
  const role = lane && laneRole(lane.name)
  if (!lane || !role) return null
  const rng = new Rng(seed)
  const samples = opts.zipIds ? all.filter((s) => opts.zipIds!.includes(s.zip_id)) : all
  const hits = [...opts.disco?.hits ?? [], ...opts.stabs?.hits ?? []]
  const hitOf = new Map(hits.map((h) => [h.rel_path, h]))
  const byPath = new Map([...all, ...hits.map(hitSample)].map((s) => [s.rel_path, s]))
  const fits = g.key ? new Set(expandCompatible([g.key])) : null
  const inProject = new Set(g.project.clips.map((c) => c.sample.relPath))
  const swaps = new Map<string, SampleListItem | null>()
  const swapFor = (s: SampleListItem, looped: boolean): SampleListItem | null => {
    if (!swaps.has(s.rel_path)) {
      const pool = hitOf.has(s.rel_path) ? hits.filter((h) => h.kind === hitOf.get(s.rel_path)!.kind).map(hitSample) : samples
      const same = pool.filter((x) => x.rel_path !== s.rel_path && x.kind === s.kind && x.category === s.category
        && (s.kind !== 'event' || looped || (bodyBars(x) === bodyBars(s) && gapsAgree(gapOf(x), gapOf(s))))
        && (!TONAL.includes(s.category) || !fits || !x.key_label || fits.has(x.key_label)))
      const fresh = same.filter((x) => !inProject.has(x.rel_path))
      const from = fresh.length ? fresh : same
      const pick = !from.length ? null : choose ? choose(s, from) : rng.pick(from)
      if (pick) inProject.add(pick.rel_path)
      swaps.set(s.rel_path, pick)
    }
    return swaps.get(s.rel_path)!
  }
  let swapped = 0
  const project = structuredClone(g.project)
  project.clips = project.clips.map((c) => {
    const s = c.laneId === laneId && !(c.type === 'audio' && c.bass) ? byPath.get(c.sample.relPath) : undefined
    if (!s) return c
    const looped = c.type === 'audio' && c.length > (s.bars ?? 1) * BEATS_PER_BAR + 1e-6
    const x = swapFor(s, looped)
    if (!x) return c
    swapped++
    const next = replaceSample(c, sampleRef(x))
    const hit = hitOf.get(x.rel_path)
    if (hit) {
      const pitch = hitPitch(hit, g.key)
      if (pitch) next.pitch = pitch
      else delete next.pitch
    }
    // An event plays once: no longer than the new one (a longer clip would repeat it).
    return c.type === 'audio' && s.kind === 'event' && !looped ? { ...next, length: Math.min(c.length, (x.bars ?? 1) * BEATS_PER_BAR) } : next
  })
  if (!swapped) return null
  // New fills are made anew too (the old variant was the old fill's).
  let choices = g.choices
  if (role === 'fills' && rulesOf(g).fillVariants) {
    for (const c of project.clips) {
      if (c.laneId === laneId && c.type === 'audio') {
        delete c.remix
        delete c.pitch
      }
    }
    const words = varyFills(project.clips, laneId, byPath, samples.filter((x) => x.kind === 'event' && x.category === 'fill'), new Rng(seed ^ 0x46494c4c))
    choices = [...g.choices.filter((c) => !c.startsWith(FILL_WORDS)), ...(words ? [words] : [])]
  }
  balanceLanes(project, all, opts, g.sections, new Set([laneId]), (g.rules.lead as Lead | null | undefined) ?? null)
  const picks = { ...g.picks }
  const was = picks[role] && swaps.get(picks[role]!.rel_path)
  if (was) picks[role] = was
  const zips = [...new Set(project.clips.map((c) => byPath.get(c.sample.relPath)?.source_code).filter((z): z is string => !!z && z !== 'Serum'))].sort()
  return { ...g, project, picks, zips, choices }
}
