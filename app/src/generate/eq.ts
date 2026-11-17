// The generated mix's EQ (SCOPE.md §6.6): every lane but the kick and the bass gets a low cut
// (house practice: the low end is theirs), and each part a few broad bands that move its tone part
// of the way to how that part sounds in the user's tracks (the engine's `levels.spectra`, measured
// in the same 24 bands as the samples' `tone`). A makeup gain keeps each lane as loud as it was, so
// the balance stays where balance.ts puts it. Web Audio biquads, in playback and in the stems.

import type { SampleListItem, TrackArrangement } from '../types/api'
import type { Clip, EqBand, Project } from '../types/project'
import { clipPower, GROUP, PART } from './balance'
import type { Role } from './generator'

const BANDS = 24
const LO_HZ = 40
const HI_HZ = 16000
/** The engine's band edges (arrangement.py) and their centres. */
const EDGES = Array.from({ length: BANDS + 1 }, (_, i) => LO_HZ * (HI_HZ / LO_HZ) ** (i / BANDS))
export const BAND_HZ = EDGES.slice(0, -1).map((e, i) => Math.sqrt(e * EDGES[i + 1]))

/** The low end a hit's boom fights the kick in: the bands under this (Hz). */
const BOOM_HZ = 100
/** A hit with this share of its power in that low end or more is bassy (the library's impacts: 0.55–1, the rest ≤ 0.05). */
const BASSY_SHARE = 0.3

/**
 * Whether a hit or impact has a lot of bass: its boom would clash with a kick, so it never plays
 * on a drop (SCOPE.md §6.6). An impact not measured yet counts as bassy (sub drops, booms).
 */
export function bassy(s: Pick<SampleListItem, 'category' | 'tone'>): boolean {
  if (!s.tone || s.tone.length !== BANDS) return s.category === 'fx_impact'
  const p = s.tone.map((v) => 10 ** (v / 10))
  const low = p.reduce((n, v, i) => n + (BAND_HZ[i] < BOOM_HZ ? v : 0), 0)
  return low / p.reduce((n, v) => n + v, 0) >= BASSY_SHARE
}

/** Each lane's low cut (Hz); none on the kick and the bass. */
const LOW_CUT_HZ: Partial<Record<Role, number>> = {
  clap: 150, clap2: 150, clap3: 150, buildup: 120, hats: 250, hats2: 250, ride: 250, perc: 180, perc2: 180,
  top: 150, top2: 150, top3: 150, top4: 150, groove: 120, stab: 120, stab2: 120, stab3: 120, strings: 150, pad: 150, bed: 200, vocal: 150, vchop: 200, disco: 120, disco2: 120,
  fills: 120, fx: 120, fx2: 120, fx3: 120, crash: 250, atmos: 120,
}
/**
 * The parts matched to the user's tracks. FX, fills and crashes are moments, each its own sound
 * (a riser isn't a sweep), so an average of them is no target: they get the low cut alone; hits
 * (impacts, downlifters: their boom is the point) not even that. Nor the stabs: the references'
 * "music" is mostly pads and chords holding, whose tone dulled a stab's attack, its accent.
 */
const MATCHED = new Set(['kick', 'clap', 'hats', 'ride', 'perc', 'top'])
/** A high-pass with a flat top (Butterworth): Web Audio takes its Q in dB. */
const FLAT_Q_DB = -3.01
/** How much of the difference to the reference the EQ makes up (it nudges, it doesn't copy). */
const MATCH = 0.5
/** The most a shelf / a bell moves (dB), and the least a bell is worth. */
const MAX_SHELF_DB = 4
const MAX_BELL_DB = 3
const MIN_BELL_DB = 2
/** The most the makeup gain moves (a lane that was mostly lows doesn't get its highs pushed far up). */
const MAX_MAKEUP_DB = 3
/** The shelves' corners and the bells' range (Hz), and how wide a bell is. */
const LOW_SHELF_HZ = 250
const HIGH_SHELF_HZ = 6000
const BELL_FROM_HZ = 300
const BELL_TO_HZ = 5000
const BELL_Q = 1
/** The bands compared: an octave above the low cut (the references' stems aren't cut as hard), up to here. */
const MATCH_TO_HZ = 14000
/** A part's reference tone needs this many of the user's tracks. */
const MIN_REFERENCES = 3
const SR = 48000

/** Power gain (linear) of a Web Audio biquad at `f` Hz (the Audio EQ Cookbook, as the spec has it; shelves at S = 1). */
export function bandPower(b: EqBand, f: number, sr = SR): number {
  const w0 = (2 * Math.PI * b.freq) / sr
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  const A = 10 ** (b.gainDb / 40)
  let c: [number, number, number, number, number, number]
  if (b.type === 'highpass') {
    const alpha = sin / (2 * 10 ** (b.q / 20))
    c = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha]
  } else if (b.type === 'peaking') {
    const alpha = sin / (2 * b.q)
    c = [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A]
  } else {
    const alpha = (sin / 2) * Math.SQRT2
    const s = 2 * Math.sqrt(A) * alpha
    c = b.type === 'lowshelf'
      ? [A * ((A + 1) - (A - 1) * cos + s), 2 * A * ((A - 1) - (A + 1) * cos), A * ((A + 1) - (A - 1) * cos - s),
        (A + 1) + (A - 1) * cos + s, -2 * ((A - 1) + (A + 1) * cos), (A + 1) + (A - 1) * cos - s]
      : [A * ((A + 1) + (A - 1) * cos + s), -2 * A * ((A - 1) + (A + 1) * cos), A * ((A + 1) + (A - 1) * cos - s),
        (A + 1) - (A - 1) * cos + s, 2 * ((A - 1) - (A + 1) * cos), (A + 1) - (A - 1) * cos - s]
  }
  const w = (2 * Math.PI * f) / sr
  const mag2 = (x0: number, x1: number, x2: number) => {
    const re = x0 + x1 * Math.cos(w) + x2 * Math.cos(2 * w)
    const im = -x1 * Math.sin(w) - x2 * Math.sin(2 * w)
    return re * re + im * im
  }
  return mag2(c[0], c[1], c[2]) / mag2(c[3], c[4], c[5])
}

/** Power gain (linear) of a clip filter (a Web Audio low- or high-pass, its Q in dB) at `f` Hz. */
export function filterPower(type: 'lowpass' | 'highpass', hz: number, qDb: number, f: number, sr = SR): number {
  const w0 = (2 * Math.PI * Math.min(hz, sr / 2 - 1)) / sr
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * 10 ** (qDb / 20))
  const b = type === 'lowpass' ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
  const a = [1 + alpha, -2 * cos, 1 - alpha]
  const w = (2 * Math.PI * f) / sr
  const mag2 = (x: number[]) => (x[0] + x[1] * Math.cos(w) + x[2] * Math.cos(2 * w)) ** 2 + (x[1] * Math.sin(w) + x[2] * Math.sin(2 * w)) ** 2
  return mag2(b) / mag2(a)
}

/**
 * What a clip filter takes from a sound of `tone`'s loudness (dB, K-weighted as the balance
 * measures it; 0 or less). Null when the tone isn't measured.
 */
export function filterLoss(tone: number[] | null | undefined, type: 'lowpass' | 'highpass', hz: number, qDb = 0.7): number | null {
  if (!tone || tone.length !== BANDS) return null
  const p = lin(tone)
  const before = p.reduce((n, v, i) => n + v * K_AT[i], 0)
  const after = p.reduce((n, v, i) => n + v * K_AT[i] * filterPower(type, hz, qDb, BAND_HZ[i]), 0)
  return before > 0 && after > 0 ? Math.min(0, 10 * Math.log10(after / before)) : null
}

/** An EQ's response at `f` (dB). */
export function eqDb(bands: EqBand[], f: number): number {
  return bands.reduce((n, b) => n + 10 * Math.log10(bandPower(b, f)), 0)
}

/** The K-weighting (as the engine measures loudness) at `f`, as power. */
const K_BANDS: EqBand[] = [
  { type: 'highshelf', freq: 1500, gainDb: 4, q: 0 },
  { type: 'highpass', freq: 38, gainDb: 0, q: 20 * Math.log10(0.5) },
]
const K_AT = BAND_HZ.map((f) => K_BANDS.reduce((n, b) => n * bandPower(b, f), 1))

/** dB values (against their total) as linear shares, and back. */
const lin = (db: number[]) => db.map((v) => 10 ** (v / 10))
const toDb = (p: number[]) => {
  const total = p.reduce((a, b) => a + b, 0)
  return total > 0 ? p.map((v) => 10 * Math.log10(Math.max(v / total, 1e-9))) : null
}

/** The tone of some clips where they play in `ranges` (else wherever): their samples' tones, weighted by how loud each plays. */
export function clipsTone(clips: Clip[], samples: Map<string, SampleListItem>, bpm: number, ranges: [number, number][]): number[] | null {
  const over = (c: Clip) => ranges.reduce((n, [a, z]) => n + Math.max(0, Math.min(z, c.start + c.length) - Math.max(a, c.start)), 0)
  const inRanges = clips.some((c) => over(c) > 0)
  const acc = new Array(BANDS).fill(0)
  for (const c of clips) {
    const s = samples.get(c.sample.relPath)
    if (!s?.tone || s.tone.length !== BANDS) continue
    const d = inRanges ? over(c) : c.length
    const p = clipPower(c, s, bpm)
    if (d <= 0 || p == null) continue
    lin(s.tone).forEach((v, i) => { acc[i] += v * p * d })
  }
  return toDb(acc)
}

/** Each part's tone in the user's tracks: per band, the median over the tracks that have it. */
export function referenceTones(arrangements: TrackArrangement[]): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  const parts = new Set(arrangements.flatMap((a) => Object.keys(a.levels?.spectra ?? {})))
  for (const part of parts) {
    const xs = arrangements.map((a) => a.levels?.spectra?.[part]).filter((t): t is number[] => t?.length === BANDS)
    if (xs.length < MIN_REFERENCES) continue
    out[part] = Array.from({ length: BANDS }, (_, i) => median(xs.map((t) => t[i])))
  }
  return out
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v))
const round = (v: number, step: number) => Math.round(v / step) * step

/**
 * Broad bands moving `tone` part of the way to `ref` above `fromHz`: a low and a high shelf, then
 * up to two bells where the rest still differs most (an octave apart).
 */
export function matchBands(tone: number[], ref: number[], fromHz: number): EqBand[] {
  const use = BAND_HZ.map((f, i) => [f, i] as const).filter(([f]) => f >= fromHz && f <= MATCH_TO_HZ).map(([, i]) => i)
  if (use.length < 6) return []
  // Both against their total over the bands compared.
  const norm = (t: number[]) => {
    const total = 10 * Math.log10(use.reduce((n, i) => n + 10 ** (t[i] / 10), 0))
    return use.map((i) => t[i] - total)
  }
  const a = norm(tone)
  const b = norm(ref)
  const raw = use.map((_, k) => b[k] - a[k])
  const d = raw.map((_, k) => (raw[Math.max(0, k - 1)] + raw[k] + raw[Math.min(raw.length - 1, k + 1)]) / 3)
  const hz = use.map((i) => BAND_HZ[i])
  const mean = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0)
  const bands: EqBand[] = []
  const low = round(clamp(MATCH * mean(d.filter((_, k) => hz[k] < LOW_SHELF_HZ)), MAX_SHELF_DB), 0.5)
  const high = round(clamp(MATCH * mean(d.filter((_, k) => hz[k] >= HIGH_SHELF_HZ)), MAX_SHELF_DB), 0.5)
  if (Math.abs(low) >= 0.5) bands.push({ type: 'lowshelf', freq: LOW_SHELF_HZ, gainDb: low, q: 0 })
  if (Math.abs(high) >= 0.5) bands.push({ type: 'highshelf', freq: HIGH_SHELF_HZ, gainDb: high, q: 0 })
  const rest = d.map((v, k) => MATCH * v - eqDb(bands, hz[k]))
  const bells: number[] = []
  for (let n = 0; n < 2; n++) {
    let best = -1
    rest.forEach((v, k) => {
      if (hz[k] < BELL_FROM_HZ || hz[k] > BELL_TO_HZ || bells.some((j) => Math.abs(Math.log2(hz[k] / hz[j])) < 1)) return
      if (Math.abs(v) >= MIN_BELL_DB && (best < 0 || Math.abs(v) > Math.abs(rest[best]))) best = k
    })
    if (best < 0) break
    bells.push(best)
    bands.push({ type: 'peaking', freq: Math.round(hz[best]), gainDb: round(clamp(rest[best], MAX_BELL_DB), 0.5), q: BELL_Q })
  }
  return bands
}

/** What `bands` do to a sound of `tone`'s loudness (dB, K-weighted as the balance measures it). */
export function loudnessChange(bands: EqBand[], tone: number[] | null): number {
  const p = tone ? lin(tone) : new Array(BANDS).fill(1)
  const before = p.reduce((n, v, i) => n + v * K_AT[i], 0)
  const after = p.reduce((n, v, i) => n + v * K_AT[i] * bands.reduce((m, b) => m * bandPower(b, BAND_HZ[i]), 1), 0)
  return before > 0 && after > 0 ? 10 * Math.log10(after / before) : 0
}

/** Layers carved for the lane they layer: a second hat, perc or top loop, the groove under the tops (clap layers are one sound). */
const CARVED = new Set<Role>(['hats2', 'perc2', 'top2', 'top3', 'top4', 'groove'])
/** A layer is carved when its tone is this much its main lane's (what they share, 0…1), by this much, this wide, between these. */
export const CARVE_MASK = 0.6
export const CARVE_DB = -2.5
const CARVE_Q = 1
const CARVE_FROM_HZ = 300
const CARVE_TO_HZ = 8000

/** What two tones share (0…1; 1 the same). */
function shared(a: number[], b: number[]): number {
  const pa = lin(a), pb = lin(b)
  const ta = pa.reduce((x, y) => x + y, 0), tb = pb.reduce((x, y) => x + y, 0)
  return ta > 0 && tb > 0 ? pa.reduce((n, v, i) => n + Math.min(v / ta, pb[i] / tb), 0) : 0
}

/**
 * Room for the main lane (SCOPE.md §6.6): a layer whose tone is much the same as the lane it
 * layers gets a broad dip where that lane is strongest, so the two don't pile up in one place.
 * Null when they differ enough, or either isn't measured.
 */
export function carveBand(main: number[] | null, layer: number[] | null): EqBand | null {
  if (!main || !layer || main.length !== BANDS || layer.length !== BANDS || shared(main, layer) < CARVE_MASK) return null
  let best = -1
  main.forEach((v, i) => {
    if (BAND_HZ[i] >= CARVE_FROM_HZ && BAND_HZ[i] <= CARVE_TO_HZ && (best < 0 || v > main[best])) best = i
  })
  return best < 0 ? null : { type: 'peaking', freq: Math.round(BAND_HZ[best]), gainDb: CARVE_DB, q: CARVE_Q }
}

/**
 * Every generated lane's EQ (`Lane.eq`), or `only` these lanes': its low cut, its part's bands
 * towards the user's tracks (one set for all the lanes of a part, from their tone together), a
 * layer's dip for the lane it layers, and the makeup gain. A lane with nothing to do gets none.
 */
export function eqLanes(project: Project, samples: Map<string, SampleListItem>, arrangements: TrackArrangement[],
                        drops: [number, number][], roleOf: (laneName: string) => Role | undefined, only?: Set<string>): void {
  const refs = referenceTones(arrangements)
  const roles = new Map(project.lanes.map((l) => [l.id, roleOf(l.name)]))
  const clipsOf = (laneId: string) => project.clips.filter((c) => c.laneId === laneId)
  const groupBands = new Map<Role, EqBand[]>()
  const bandsFor = (head: Role): EqBand[] => {
    if (!groupBands.has(head)) {
      const part = PART[head]
      const ids = project.lanes.filter((l) => { const r = roles.get(l.id); return r && (GROUP[r] ?? r) === head }).map((l) => l.id)
      const tone = clipsTone(ids.flatMap(clipsOf), samples, project.bpm, drops)
      const cut = LOW_CUT_HZ[head]
      groupBands.set(head, part && MATCHED.has(part) && refs[part] && tone ? matchBands(tone, refs[part], Math.max(LO_HZ, (cut ?? 0) * 2)) : [])
    }
    return groupBands.get(head)!
  }
  for (const lane of project.lanes) {
    if (only && !only.has(lane.id)) continue
    const role = roles.get(lane.id)
    if (!role) continue
    const clips = clipsOf(lane.id)
    // A build-up playing the kick (a kick roll) keeps its low end; so does a breakdown layer that is a reese (a low note).
    const low = role === 'pad' && clips.some((c) => c.type === 'audio' && c.bass?.notes?.some((n) => n[2] < 48))
    const cut = low || (role === 'buildup' && clips.some((c) => c.sample.category === 'kick')) ? undefined : LOW_CUT_HZ[role]
    const bands: EqBand[] = [
      ...(cut ? [{ type: 'highpass' as const, freq: cut, gainDb: 0, q: FLAT_Q_DB }] : []),
      ...bandsFor(GROUP[role] ?? role),
    ]
    if (CARVED.has(role)) {
      const main = project.lanes.find((l) => roles.get(l.id) === GROUP[role])
      const dip = main ? carveBand(clipsTone(clipsOf(main.id), samples, project.bpm, drops), clipsTone(clips, samples, project.bpm, drops)) : null
      // (Not on top of a bell the part's own match already put there.)
      if (dip && !bands.some((b) => b.type === 'peaking' && Math.abs(Math.log2(b.freq / dip.freq)) < 0.5)) bands.push(dip)
    }
    if (!bands.length) {
      delete lane.eq
      continue
    }
    const tone = clipsTone(clips, samples, project.bpm, drops)
    lane.eq = { bands, gainDb: round(clamp(-loudnessChange(bands, tone), MAX_MAKEUP_DB), 0.5) || 0 }
  }
}

/** A lane EQ in a few words (tooltips, the lane panel). */
export function eqSummary(bands: EqBand[]): string {
  const hz = (f: number) => (f >= 1000 ? `${+(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`)
  const db = (g: number) => `${g > 0 ? '+' : ''}${g} dB`
  return bands.map((b) => b.type === 'highpass' ? `low cut ${hz(b.freq)}`
    : b.type === 'lowshelf' ? `lows ${db(b.gainDb)}` : b.type === 'highshelf' ? `highs ${db(b.gainDb)}` : `${db(b.gainDb)} at ${hz(b.freq)}`).join(', ')
}
