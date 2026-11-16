// The mix checked as a whole (SCOPE.md §6.6): how the kick and the bass sit together (the
// sidechain's depth and length from what is measured of both), and the tone of the finished drop
// against the user's own tracks, with the lane furthest off nudged. Pure: the same track gets the
// same result.

import { BEATS_PER_BAR } from '../lib/project'
import type { SampleListItem, TrackArrangement } from '../types/api'
import type { Clip, Project } from '../types/project'
import { clipPower, GROUP, PART, type PunchRefs } from './balance'
import { BAND_HZ, bandPower } from './eq'
import type { Role } from './generator'

// ---------------------------------------------------------------------------
// Kick and bass
// ---------------------------------------------------------------------------

/** The kick's fundamental is looked for under this (Hz). */
const KICK_MAX_HZ = 200
/** A duck moves this far around the user's sidechain amount: by `DUCK_SPAN` × (collision − `DUCK_MID`). */
const DUCK_SPAN = 0.5
const DUCK_MID = 0.35
const DUCK_MIN = 0.15
const DUCK_MAX = 0.95
/** The duck recovers over this much of the kick's length, between these (beats). */
const DUCK_KICK_SHARE = 0.8
const DUCK_MIN_BEATS = 0.35
const DUCK_MAX_BEATS = 0.8
/** A bass note an octave from the kick's fundamental doesn't fight it; its second harmonic counts half. */
const CLOSE_OCTAVES = 1
const HARMONIC_WEIGHT = 0.5

export interface KickBass {
  /** The sidechain's depth (0…1) and how long each duck takes to recover (beats). */
  duck: number
  beats: number
  /** How much the bass plays under the kick in the kick's own register (0…1). */
  collision: number
  kickHz: number
}

/** The centre of a kick's strongest low band (Hz); null when its tone isn't measured. */
export function kickHz(kick: Pick<SampleListItem, 'tone'> | null | undefined): number | null {
  if (!kick?.tone || kick.tone.length !== BAND_HZ.length) return null
  let best = -1
  kick.tone.forEach((v, i) => { if (BAND_HZ[i] < KICK_MAX_HZ && (best < 0 || v > kick.tone![best])) best = i })
  return best < 0 ? null : BAND_HZ[best]
}

const noteHz = (pitch: number) => 440 * 2 ** ((pitch - 69) / 12)

/**
 * Kick and bass as one measurement: where the kick's weight is (its strongest low band), how long
 * it rings, and how much of that time the bassline (its notes as they sound, in the track key)
 * plays in the same register, on a four-to-the-floor kick. The more they collide, the deeper the
 * sidechain around the user's `amount`; it recovers as fast as the kick is short. Null when the
 * kick isn't measured (the amount stands, with the usual release).
 */
export function kickBass(kick: SampleListItem | null | undefined, notes: [number, number, number, number][], transpose: number,
                         bars: number, bpm: number, amount: number): KickBass | null {
  const hz = kickHz(kick)
  if (!kick || hz == null || !notes.length || bars <= 0) return null
  const beat = 60 / bpm
  const ring = Math.max(0.05, kick.duration_s) / beat   // the kick's length in beats
  const window = Math.min(1, ring)
  const close = (f: number) => Math.max(0, 1 - Math.abs(Math.log2(f / hz)) / CLOSE_OCTAVES)
  let under = 0
  const total = bars * BEATS_PER_BAR
  for (let k = 0; k < total; k++) {
    for (const [start, length, pitch] of notes) {
      // The loop wraps: a note is also heard a loop earlier and later.
      for (const shift of [-total, 0, total]) {
        const over = Math.min(k + window, start + shift + length) - Math.max(k, start + shift)
        if (over <= 0) continue
        const f = noteHz(pitch + transpose)
        under += over * Math.max(close(f), HARMONIC_WEIGHT * close(2 * f))
      }
    }
  }
  const collision = Math.max(0, Math.min(1, under / (total * window)))
  const duck = Math.round(Math.max(DUCK_MIN, Math.min(DUCK_MAX, amount + DUCK_SPAN * (collision - DUCK_MID))) * 100) / 100
  const beats = Math.round(Math.max(DUCK_MIN_BEATS, Math.min(DUCK_MAX_BEATS, DUCK_KICK_SHARE * ring)) * 100) / 100
  return { duck, beats, collision: Math.round(collision * 100) / 100, kickHz: Math.round(hz) }
}

// ---------------------------------------------------------------------------
// The drop's tone against the user's tracks
// ---------------------------------------------------------------------------

/** The regions the mix is compared in (Hz). */
export const REGIONS: { name: string; from: number; to: number }[] = [
  { name: 'lows', from: 40, to: 150 }, { name: 'low mids', from: 150, to: 500 }, { name: 'mids', from: 500, to: 2000 },
  { name: 'high mids', from: 2000, to: 6000 }, { name: 'highs', from: 6000, to: 16000 },
]
/** The reference needs this many of the user's tracks. */
const MIN_REFERENCES = 3
/** A region is off from this (dB); a lane moves this much a step, this much in all, in at most this many steps. */
export const MIX_OFF_DB = 2.5
const MIX_STEP_DB = 1
const MIX_MAX_DB = 3
const MIX_STEPS = 6
/**
 * The parts compared: the drums and the sampled music. The bass and the other rendered parts
 * (strings, vocals) aren't measured before they are rendered, so they are left out on both sides.
 */
const REF_PARTS = ['kick', 'clap', 'hats', 'ride', 'perc', 'top', 'music']
/** The K-weighting per band (as power), to turn a K-weighted loudness into power per band. */
const K_AT = BAND_HZ.map((f) => bandPower({ type: 'highshelf', freq: 1500, gainDb: 4, q: 0 }, f)
  * bandPower({ type: 'highpass', freq: 38, gainDb: 0, q: 20 * Math.log10(0.5) }, f))

/** A sound of K-weighted power `p` and `tone` as power per band (null when the tone isn't measured). */
function bandsOf(p: number, tone: number[] | null | undefined): number[] | null {
  if (!tone || tone.length !== BAND_HZ.length) return null
  const share = tone.map((v) => 10 ** (v / 10))
  const k = share.reduce((n, v, i) => n + v * K_AT[i], 0)
  return k > 0 ? share.map((v) => (p * v) / k) : null
}

/** Power per band as dB per region against the whole (null when silent). */
function regionsOf(bands: number[]): number[] | null {
  const total = bands.reduce((a, b) => a + b, 0)
  if (!(total > 0)) return null
  return REGIONS.map((r) => 10 * Math.log10(Math.max(1e-9, bands.reduce((n, v, i) => n + (BAND_HZ[i] >= r.from && BAND_HZ[i] < r.to ? v : 0), 0) / total)))
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * The tone of the user's tracks where they are full: per region, the median over the tracks of
 * what their drum and music parts add up to (each part at its measured level, with its measured
 * tone). Only `parts` are added up (the parts the mix it is compared with has: a track without
 * stabs isn't held against tracks with their chords in). Tracks whose stems were normalised one by
 * one don't count. Null with too few.
 */
export function referenceMix(arrangements: TrackArrangement[], parts: readonly string[] = REF_PARTS): { regions: number[]; tracks: number } | null {
  const per: number[][] = []
  for (const a of arrangements) {
    const lv = a.levels
    if (!lv || lv.normalized || !lv.spectra || lv.parts.kick == null) continue
    const acc = new Array(BAND_HZ.length).fill(0)
    for (const part of parts) {
      if (!REF_PARTS.includes(part)) continue
      const b = lv.parts[part] == null ? null : bandsOf(10 ** (lv.parts[part] / 10), lv.spectra[part])
      if (b) b.forEach((v, i) => { acc[i] += v })
    }
    const r = regionsOf(acc)
    if (r) per.push(r)
  }
  if (per.length < MIN_REFERENCES) return null
  return { regions: REGIONS.map((_, k) => median(per.map((r) => r[k]))), tracks: per.length }
}

export interface MixCheck {
  /** How many of the user's tracks the reference comes from. */
  tracks: number
  /** Per region (REGIONS): dB against the reference as the mix was made, and as it was left. */
  before: number[]
  after: number[]
  /** The largest difference left (dB): how far the mix is from the user's tracks. */
  off: number
  /** What was moved: lane names and dB. */
  moves: { lane: string; db: number }[]
}

/**
 * The finished drop against the user's tracks: every measured drum and sampled-music lane as it
 * plays in the drops (its clips' loudness and tone, its level and its EQ) added up, per region
 * against the reference. While a region is off by `MIX_OFF_DB` or more, the lane that weighs most
 * there moves a step: down when there is too much (never the kick: the mix is balanced against it),
 * up when there is too little, at most `MIX_MAX_DB` in all; a step is kept only when the mix as a
 * whole gets closer. The lanes' levels are changed in place. Null without a reference, or when
 * nothing measured plays.
 */
export function checkMix(project: Project, samples: Map<string, SampleListItem>, arrangements: TrackArrangement[], drops: [number, number][],
                         roleOf: (laneName: string) => Role | undefined, punch?: PunchRefs): MixCheck | null {
  const over = (c: Clip) => drops.reduce((n, [a, z]) => n + Math.max(0, Math.min(z, c.start + c.length) - Math.max(a, c.start)), 0)
  const dropBeats = drops.reduce((n, [a, z]) => n + z - a, 0)
  if (!(dropBeats > 0)) return null
  // Each lane's power per band in the drops, before its level and EQ.
  const lanes: { id: string; name: string; role: Role; raw: number[]; moved: number }[] = []
  for (const lane of project.lanes) {
    const role = roleOf(lane.name)
    const part = role && (PART[role] ?? PART[GROUP[role] ?? role])
    if (!role || !part || !REF_PARTS.includes(part)) continue
    const acc = new Array(BAND_HZ.length).fill(0)
    let any = false
    for (const c of project.clips) {
      if (c.laneId !== lane.id || (c.type === 'audio' && c.bass)) continue
      const d = over(c)
      const s = samples.get(c.sample.relPath)
      const p = d > 0 ? clipPower(c, s, project.bpm, punch) : null
      const b = p == null ? null : bandsOf((p * d) / dropBeats, s?.tone)
      if (!b) continue
      b.forEach((v, i) => { acc[i] += v })
      any = true
    }
    if (any) lanes.push({ id: lane.id, name: lane.name, role, raw: acc, moved: 0 })
  }
  if (!lanes.length) return null
  // Like with like: the references' parts this track has too.
  const ref = referenceMix(arrangements, [...new Set(lanes.map((x) => PART[x.role] ?? PART[GROUP[x.role] ?? x.role]!))])
  if (!ref) return null
  const byId = new Map(project.lanes.map((l) => [l.id, l]))
  /** A lane's bands as it plays: its level, its EQ and its makeup on top. */
  const played = (x: typeof lanes[number]) => {
    const lane = byId.get(x.id)!
    const eq = lane.eq && !lane.eq.off ? lane.eq : null
    const gain = 10 ** (((lane.levelDb ?? 0) + (eq?.gainDb ?? 0)) / 10)
    return x.raw.map((v, i) => v * gain * (eq ? eq.bands.reduce((m, b) => m * bandPower(b, BAND_HZ[i]), 1) : 1))
  }
  const measure = () => {
    const acc = new Array(BAND_HZ.length).fill(0)
    for (const x of lanes) played(x).forEach((v, i) => { acc[i] += v })
    const r = regionsOf(acc)
    return r ? r.map((v, k) => v - ref.regions[k]) : null
  }
  const worstOf = (d: number[]) => Math.max(...d.map(Math.abs))
  const rms = (d: number[]) => Math.sqrt(d.reduce((n, v) => n + v * v, 0) / d.length)
  const before = measure()
  if (!before) return null
  let now = before
  for (let step = 0; step < MIX_STEPS && worstOf(now) >= MIX_OFF_DB; step++) {
    const k = now.reduce((best, v, i) => (Math.abs(v) > Math.abs(now[best]) ? i : best), 0)
    const up = now[k] < 0
    const r = REGIONS[k]
    const inRegion = (b: number[]) => b.reduce((n, v, i) => n + (BAND_HZ[i] >= r.from && BAND_HZ[i] < r.to ? v : 0), 0)
    // Too much: the lane with the most power there. Too little: the lane that lives there most (the largest share of its own power).
    // (Never the kick: the mix is balanced against it. Never the stabs: they are levelled hit for hit.)
    const cands = lanes.filter((x) => x.role !== 'kick' && !x.role.startsWith('stab') && Math.abs(x.moved + (up ? MIX_STEP_DB : -MIX_STEP_DB)) <= MIX_MAX_DB)
      .map((x) => { const b = played(x); return { x, w: up ? inRegion(b) / (b.reduce((p, q) => p + q, 0) || 1) : inRegion(b) } })
      .filter((c) => c.w > 0).sort((p, q) => q.w - p.w)
    let moved = false
    for (const { x } of cands.slice(0, 3)) {
      const lane = byId.get(x.id)!
      const was = lane.levelDb ?? 0
      lane.levelDb = was + (up ? MIX_STEP_DB : -MIX_STEP_DB)
      const next = measure()!
      if (rms(next) < rms(now) - 1e-6) {
        x.moved += up ? MIX_STEP_DB : -MIX_STEP_DB
        now = next
        moved = true
        break
      }
      lane.levelDb = was
    }
    if (!moved) break
  }
  const round = (v: number) => Math.round(v * 10) / 10
  return {
    tracks: ref.tracks, before: before.map(round), after: now.map(round), off: round(worstOf(now)),
    moves: lanes.filter((x) => x.moved).map((x) => ({ lane: x.name, db: x.moved })),
  }
}
