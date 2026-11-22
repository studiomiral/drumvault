// Piano (SCOPE.md §6.9a): a house track plays chord stabs or a piano part, never both. The piano
// is written, not picked: learnPiano() reads the Piano tab's MIDI (chords, the rhythm they are
// played in, how they are voiced, the register) and generatePiano() writes a new part from it in
// the track key. Two kinds, as the library has them:
//   - a loop: every bar starts on the same chord (it may move within the bar). It sits on the
//     key's own chord of its kind (a minor one on the minor tonic, a major one on the relative
//     major), so the bassline Generate writes anyway pairs with it;
//   - a progression: the chords change across the bars (2, 4 or 8 of them). The bass then
//     follows the piano (followBass): the bassline's loop played on each chord's root.
// A part takes one example's chords (sometimes one of them swapped for a chord the library plays
// after the one before) and one example's rhythm (sometimes moved a little), voiced the way the
// library voices that kind of chord, each chord led to the next by the smallest move. A hit just
// before a chord change plays the coming chord (the house push). Pure and seeded.

import type { MidiItem } from '../types/api'
import { parseKey, type BassNote } from './bassline'
import type { Rng } from './rng'

export type PianoKind = 'loop' | 'progression'

/** A chord's kind: what its notes are above its root. */
export type Quality = 'maj' | 'min' | 'dom7' | 'min7' | 'maj7' | 'min9' | 'maj9' | 'sus4' | 'sus2' | 'dim' | 'm7b5' | 'six'

const TEMPLATES: Record<Quality, number[]> = {
  maj: [0, 4, 7], min: [0, 3, 7], dom7: [0, 4, 7, 10], min7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], min9: [0, 2, 3, 7, 10], maj9: [0, 2, 4, 7, 11],
  sus4: [0, 5, 7], sus2: [0, 2, 7], dim: [0, 3, 6], m7b5: [0, 3, 6, 10], six: [0, 4, 7, 9],
}
const QUALITIES = Object.keys(TEMPLATES) as Quality[]
const SUFFIX: Record<Quality, string> = { maj: '', min: 'm', dom7: '7', min7: 'm7', maj7: 'maj7', min9: 'm9', maj9: 'maj9', sus4: 'sus4', sus2: 'sus2', dim: 'dim', m7b5: 'm7b5', six: '6' }
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

/** A chord of a part: from `at` for `beats`, its root in semitones above the minor tonic (0–11: a major key counts from its relative minor). */
export interface PianoChord { at: number; beats: number; root: number; quality: Quality }

const STEPS = 16
/** Notes starting within this of a hit's first (beats) are one chord. */
const CLUSTER_BEATS = 0.125
/** A hit this many 16ths or fewer before a chord change plays the coming chord. */
const PUSH_STEPS = 2
/** How often a progression has one of its chords swapped for one the library plays after the chord before it. */
const VARY_CHANCE = 0.4
/** How often the part plays its chords in their own example's rhythm (else another example's of its kind). */
const OWN_RHYTHM_CHANCE = 0.5
/** How often a rhythm is moved a little (a hit a 16th earlier or later, or one left out). */
const MUTATE_CHANCE = 0.35
/** A piano part favourited on the Piano tab counts this many times. */
const FAVORITE_WEIGHT = 3
/** Where a voicing's lowest note sits when the library doesn't say (MIDI note: around G3). */
const REGISTER = 55
/** Harmony periods looked for (bars). */
const PERIODS = [1, 2, 4, 8]

const pc = (x: number) => ((x % 12) + 12) % 12

interface Note { s: number; l: number; p: number; v: number }
/** One chord as played: its 16th, length (beats), loudness (share of the file's loudest) and how many notes. */
export interface PianoHit { step: number; len: number; vel: number; voices: number }
/** A rhythm the library plays: 1 or 2 bars of hits. */
export interface PianoRhythm { bars: 1 | 2; hits: PianoHit[]; weight: number; kind: PianoKind }
/** An example's chords over its repeat (bars), and its rhythm. */
export interface PianoExample { kind: PianoKind; bars: number; chords: PianoChord[]; rhythm: PianoRhythm; weight: number; name: string }

export interface PianoModel {
  examples: PianoExample[]
  rhythms: PianoRhythm[]
  /** How the library voices each kind of chord: semitones above the root's note at or under the lowest, and how often. */
  shapes: Map<Quality, { shape: number[]; weight: number }[]>
  /** The lowest note of its chords (median MIDI note). */
  register: number
  /** Which chord follows which (by root and quality) in the progressions, and how often. */
  next: Map<string, Map<string, number>>
}

// ---------------------------------------------------------------------------
// Reading the library
// ---------------------------------------------------------------------------

const KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KRUMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

function correlate(a: number[], b: number[]): number {
  const ma = a.reduce((x, y) => x + y, 0) / 12, mb = b.reduce((x, y) => x + y, 0) / 12
  let n = 0, da = 0, db = 0
  for (let i = 0; i < 12; i++) {
    n += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return da && db ? n / Math.sqrt(da * db) : 0
}

/**
 * The minor tonic of a part (a major key's relative minor), from its notes (the label is a tie-break:
 * the library's labels are often wrong). Null without notes.
 */
export function minorTonic(notes: Note[], label: string | null): number | null {
  if (!notes.length) return null
  const hist = new Array(12).fill(0)
  for (const n of notes) hist[pc(n.p)] += n.l
  const scores: { tonic: number; score: number }[] = []
  for (let r = 0; r < 12; r++) {
    const rot = (prof: number[]) => prof.map((_, i) => prof[pc(i - r)])
    scores.push({ tonic: pc(r - 3), score: correlate(hist, rot(KRUMHANSL_MAJOR)) })   // major r: its relative minor
    scores.push({ tonic: r, score: correlate(hist, rot(KRUMHANSL_MINOR)) })
  }
  scores.sort((a, b) => b.score - a.score)
  const k = parseKey(label)
  if (k) {
    const own = k.minor ? k.root : pc(k.root - 3)
    const mine = scores.find((x) => x.tonic === own)
    if (mine && mine.score >= scores[0].score - 0.05) return own
  }
  return scores[0].tonic
}

/** The chord a set of pitches makes (its root as a pitch class), or null for fewer than two notes. */
export function chordOf(pitches: number[]): { root: number; quality: Quality } | null {
  const pcs = [...new Set(pitches.map(pc))]
  if (pcs.length < 2) return null
  const low = pc(Math.min(...pitches))
  let best: { root: number; quality: Quality; score: number } | null = null
  for (let r = 0; r < 12; r++) {
    for (const q of QUALITIES) {
      const t = new Set(TEMPLATES[q].map((i) => pc(r + i)))
      const hit = pcs.filter((x) => t.has(x)).length
      const extra = pcs.length - hit
      const missing = t.size - hit
      // The root itself may be left out (a rootless voicing) but counts for a lot when there, more in the bass.
      const score = hit - extra * 1.2 - missing * 0.55 + (pcs.includes(r) ? 0.6 : -0.4) + (low === r ? 0.5 : 0) - (TEMPLATES[q].length > 3 ? 0.1 : 0)
      if (!best || score > best.score + 1e-9) best = { root: r, quality: q, score }
    }
  }
  return best ? { root: best.root, quality: best.quality } : null
}

/** Chord-sized groups of notes: the notes starting together (within CLUSTER_BEATS). */
function clusters(notes: Note[]): Note[][] {
  const out: Note[][] = []
  for (const n of [...notes].sort((a, b) => a.s - b.s || a.p - b.p)) {
    const last = out.at(-1)
    if (last && n.s - last[0].s <= CLUSTER_BEATS) last.push(n)
    else out.push([n])
  }
  return out
}

const sameChord = (a: PianoChord | null, b: PianoChord | null) => !!a && !!b && a.root === b.root && a.quality === b.quality
const chordKey = (c: Pick<PianoChord, 'root' | 'quality'>) => `${c.root}:${c.quality}`

/** The chord sounding at each 8th of `bars` bars (the last one played that had two notes or more), relative to `tonic`. */
function chordsBy8th(groups: Note[][], tonic: number, bars: number): (PianoChord | null)[] {
  const at = new Array<PianoChord | null>(bars * 8).fill(null)
  let cur: PianoChord | null = null
  let gi = 0
  const sorted = [...groups].sort((a, b) => a[0].s - b[0].s)
  for (let e = 0; e < bars * 8; e++) {
    const t = e / 2
    while (gi < sorted.length && sorted[gi][0].s < t + 0.5 - 1e-9) {
      const c = chordOf(sorted[gi].map((n) => n.p))
      if (c) cur = { at: 0, beats: 0, root: pc(c.root - tonic), quality: c.quality }
      gi++
    }
    at[e] = cur
  }
  // Before the first chord: the first chord (a pickup into it).
  const first = at.find(Boolean) ?? null
  return at.map((c) => c ?? first)
}

/** The chords of an 8th-grid as segments. */
function segments(grid: (PianoChord | null)[]): PianoChord[] {
  const out: PianoChord[] = []
  grid.forEach((c, e) => {
    if (!c) return
    const last = out.at(-1)
    if (last && sameChord(last, c) && Math.abs(last.at + last.beats - e / 2) < 1e-9) last.beats += 0.5
    else out.push({ at: e / 2, beats: 0.5, root: c.root, quality: c.quality })
  })
  return out
}

/** A file's hits on the 16th grid over `bars` bars (a longer file folded onto them). */
function hitsOf(groups: Note[][], bars: number): PianoHit[] {
  const loud = Math.max(1, ...groups.flat().map((n) => n.v))
  const total = bars * STEPS
  const byStep = new Map<number, PianoHit>()
  for (const g of groups) {
    const step = Math.round(g[0].s * 4)
    if (step >= total) continue
    const hit: PianoHit = { step, len: Math.max(...g.map((n) => n.l)), vel: Math.max(...g.map((n) => n.v)) / loud, voices: new Set(g.map((n) => n.p)).size }
    const was = byStep.get(step)
    if (!was || hit.voices > was.voices) byStep.set(step, hit)
  }
  return [...byStep.values()].sort((a, b) => a.step - b.step)
}

const rhythmSig = (hits: PianoHit[]) => hits.map((h) => `${h.step}.${h.voices > 1 ? 'c' : 'n'}`).join(',')

/** What the Piano tab's parts have in common. Null without any that play chords. */
export function learnPiano(midis: MidiItem[]): PianoModel | null {
  const examples: PianoExample[] = []
  const rhythms: PianoRhythm[] = []
  const shapes = new Map<Quality, Map<string, { shape: number[]; weight: number }>>()
  const lows: number[] = []
  const next = new Map<string, Map<string, number>>()

  for (const m of midis) {
    if (m.role !== 'piano' || !m.notes.length) continue
    const notes: Note[] = m.notes.map(([s, l, p, v]) => ({ s, l, p, v }))
    const tonic = minorTonic(notes, m.key_label)
    if (tonic == null) continue
    const weight = m.favorite ? FAVORITE_WEIGHT : 1
    const groups = clusters(notes)
    const fileBars = Math.max(1, Math.round(m.bars))
    const grid = chordsBy8th(groups, tonic, fileBars)
    if (!grid.some(Boolean)) continue
    // The harmony's repeat: the shortest period it plays again and again.
    const period = PERIODS.find((p) => p <= fileBars && fileBars % p === 0
      && grid.every((c, e) => sameChord(c, grid[e % (p * 8)]))) ?? fileBars
    const own = grid.slice(0, period * 8)
    const chords = segments(own)
    // A loop: every bar starts on the same chord; it is then on the track's root (its first chord moved there).
    const downbeats = Array.from({ length: period }, (_, b) => own[b * 8])
    const kind: PianoKind = downbeats.every((c) => sameChord(c, downbeats[0])) ? 'loop' : 'progression'
    const shift = kind === 'loop' ? chords[0].root : 0
    const rel = chords.map((c) => ({ ...c, root: pc(c.root - shift) }))
    // Its rhythm: the onsets over 1 or 2 bars (two the same: one).
    const rb: 1 | 2 = fileBars >= 2 ? 2 : 1
    let hits = hitsOf(groups.filter((g) => g[0].s < rb * 4), rb)
    let bars: 1 | 2 = rb
    if (rb === 2) {
      const b1 = hits.filter((h) => h.step < STEPS), b2 = hits.filter((h) => h.step >= STEPS).map((h) => ({ ...h, step: h.step - STEPS }))
      if (rhythmSig(b1) === rhythmSig(b2)) {
        hits = b1
        bars = 1
      }
    }
    if (!hits.length) continue
    const rhythm: PianoRhythm = { bars, hits, weight, kind }
    const same = rhythms.find((r) => r.kind === kind && r.bars === bars && rhythmSig(r.hits) === rhythmSig(hits))
    if (same) same.weight += weight
    else rhythms.push(rhythm)
    examples.push({ kind, bars: period, chords: rel, rhythm, weight, name: m.name })
    // How it voices its chords.
    for (const g of groups) {
      const ps = [...new Set(g.map((n) => n.p))].sort((a, b) => a - b)
      const c = chordOf(ps)
      if (!c) continue
      lows.push(ps[0])
      const base = ps[0] - pc(ps[0] - c.root)
      const shape = ps.map((p) => p - base)
      const byQ = shapes.get(c.quality) ?? new Map()
      const k = shape.join(',')
      byQ.set(k, { shape, weight: (byQ.get(k)?.weight ?? 0) + weight })
      shapes.set(c.quality, byQ)
    }
    if (kind === 'progression') {
      for (let i = 0; i < rel.length; i++) {
        const a = chordKey(rel[i]), b = chordKey(rel[(i + 1) % rel.length])
        if (a === b) continue
        const row = next.get(a) ?? new Map<string, number>()
        row.set(b, (row.get(b) ?? 0) + weight)
        next.set(a, row)
      }
    }
  }
  if (!examples.length) return null
  const sorted = [...lows].sort((a, b) => a - b)
  return {
    examples, rhythms, next,
    shapes: new Map([...shapes].map(([q, m]) => [q, [...m.values()]])),
    register: sorted.length ? sorted[sorted.length >> 1] : REGISTER,
  }
}

const memo = new WeakMap<MidiItem[], PianoModel | null>()
/** learnPiano, once per list of parts. */
export function pianoModel(midis: MidiItem[]): PianoModel | null {
  if (!memo.has(midis)) memo.set(midis, learnPiano(midis))
  return memo.get(midis)!
}

/** The kinds of part the library has (what a track can be given). */
export function pianoKinds(model: PianoModel): PianoKind[] {
  return (['loop', 'progression'] as const).filter((k) => model.examples.some((e) => e.kind === k))
}

// ---------------------------------------------------------------------------
// Writing a part
// ---------------------------------------------------------------------------

export interface PianoPart {
  kind: PianoKind
  /** The notes (start beats, length beats, pitch, velocity) of one loop of `bars` bars, in the track key. */
  notes: BassNote[]
  bars: number
  chords: PianoChord[]
}

/** The minor tonic of a track key (a major key's relative minor), or null without a key. */
export function tonicOf(key: string | null): number | null {
  const k = parseKey(key)
  return k ? (k.minor ? k.root : pc(k.root - 3)) : null
}

/** A chord's name in a track key ("Am7"). */
export function chordName(c: Pick<PianoChord, 'root' | 'quality'>, key: string | null): string {
  const t = tonicOf(key) ?? 9
  return NAMES[pc(t + c.root)] + SUFFIX[c.quality]
}

/** The chord at `beat` of a part (its loop wrapped). */
export function chordAt(chords: PianoChord[], bars: number, beat: number): PianoChord {
  const L = bars * 4
  const t = ((beat % L) + L) % L
  return chords.find((c) => t >= c.at - 1e-9 && t < c.at + c.beats - 1e-9) ?? chords[0]
}

/** One chord swapped for one the library plays after the chord before it (not the first, never the same as its neighbours). */
function varied(rng: Rng, chords: PianoChord[], model: PianoModel): PianoChord[] {
  if (chords.length < 3) return chords
  const i = rng.int(1, chords.length - 1)
  const row = model.next.get(chordKey(chords[i - 1]))
  if (!row) return chords
  const after = chords[(i + 1) % chords.length]
  const cands = [...row.entries()].filter(([k]) => k !== chordKey(chords[i - 1]) && k !== chordKey(after) && k !== chordKey(chords[i]))
  if (!cands.length) return chords
  const [root, quality] = rng.weighted(cands).split(':')
  return chords.map((c, j) => (j === i ? { ...c, root: Number(root), quality: quality as Quality } : c))
}

/** A rhythm moved a little: a hit (not the first) a 16th earlier or later, or left out. */
function mutated(rng: Rng, r: PianoRhythm): PianoRhythm {
  if (r.hits.length < 2) return r
  const hits = r.hits.map((h) => ({ ...h }))
  const i = rng.int(1, hits.length - 1)
  const total = r.bars * STEPS
  if (rng.chance(0.35) && hits.length >= 3) hits.splice(i, 1)
  else {
    const to = hits[i].step + (rng.chance(0.5) ? 1 : -1)
    if (to > 0 && to < total && !hits.some((h) => h.step === to)) hits[i].step = to
  }
  return { ...r, hits: hits.sort((a, b) => a.step - b.step) }
}

/** The track's way of voicing a kind of chord: one of the library's shapes for it, else its plain chord. */
function shapeFor(rng: Rng, model: PianoModel, q: Quality, chosen: Map<Quality, number[]>): number[] {
  if (!chosen.has(q)) {
    const own = model.shapes.get(q)
    chosen.set(q, own?.length ? rng.pickBy(own, (x) => x.weight).shape : TEMPLATES[q].map((i, k) => (k && i < TEMPLATES[q][k - 1] ? i + 12 : i)))
  }
  return chosen.get(q)!
}

/** The placing of a shape on a root nearest the register and the voicing before (the smallest move), inversions included. */
function voiced(shape: number[], root: number, register: number, prev: number[] | null): number[] {
  const cands: number[][] = []
  const sorted = [...shape].sort((a, b) => a - b)
  for (let inv = 0; inv < Math.min(3, sorted.length); inv++) {
    // The lowest `inv` notes an octave up.
    const s = [...sorted.slice(inv), ...sorted.slice(0, inv).map((x) => x + 12)]
    for (let o = -2; o <= 2; o++) {
      const base = register - pc(register - root) + 12 * o
      cands.push(s.map((x) => base + x).sort((a, b) => a - b))
    }
  }
  const cost = (ps: number[]) => {
    const low = Math.abs(ps[0] - register) * 0.6
    const move = prev ? ps.reduce((a, p) => a + Math.min(...prev.map((q) => Math.abs(p - q))), 0) : 0
    const top = prev ? Math.abs(ps.at(-1)! - prev.at(-1)!) * 0.3 : 0
    return low + move + top
  }
  return cands.reduce((a, b) => (cost(b) < cost(a) - 1e-9 ? b : a))
}

/**
 * A new piano part of `kind` (else as the library's are, by how many there are of each) in the
 * track key: one example's chords (a progression sometimes with one swapped) on one example's
 * rhythm, voiced the library's way. Null without a key or a part of that kind.
 */
export function generatePiano(model: PianoModel, rng: Rng, opts: { key: string | null; kind?: PianoKind | null }): PianoPart | null {
  const tonic = tonicOf(opts.key)
  if (tonic == null) return null
  const kinds = pianoKinds(model)
  const kind = opts.kind && kinds.includes(opts.kind) ? opts.kind
    : rng.weighted(kinds.map((k) => [k, model.examples.filter((e) => e.kind === k).reduce((a, e) => a + e.weight, 0)] as const))
  const ofKind = model.examples.filter((e) => e.kind === kind)
  if (!ofKind.length) return null
  const ex = rng.pickBy(ofKind, (e) => e.weight)
  // A loop stays in the key: a minor chord's on the minor tonic, a major chord's on the relative major
  // (the root of a major key; a minor key's III).
  const keyShift = kind === 'loop' && TEMPLATES[ex.chords[0].quality].includes(4) ? 3 : 0
  let chords = ex.chords.map((c) => ({ ...c, root: pc(c.root + keyShift) }))
  if (kind === 'progression' && rng.chance(VARY_CHANCE)) chords = varied(rng, chords, model)
  const rhythms = model.rhythms.filter((r) => r.kind === kind)
  let rhythm = rng.chance(OWN_RHYTHM_CHANCE) || !rhythms.length ? ex.rhythm : rng.pickBy(rhythms, (r) => r.weight)
  if (rng.chance(MUTATE_CHANCE)) rhythm = mutated(rng, rhythm)
  const bars = Math.max(ex.bars, rhythm.bars) % rhythm.bars === 0 ? Math.max(ex.bars, rhythm.bars) : ex.bars * rhythm.bars
  // Harmony repeated over the part (a 1-bar loop's chords under a 2-bar rhythm).
  const all: PianoChord[] = []
  for (let rep = 0; rep * ex.bars < bars; rep++) for (const c of chords) all.push({ ...c, at: c.at + rep * ex.bars * 4 })
  const total = bars * STEPS
  const hits: PianoHit[] = []
  for (let rep = 0; rep * rhythm.bars < bars; rep++) for (const h of rhythm.hits) hits.push({ ...h, step: h.step + rep * rhythm.bars * STEPS })
  const chosen = new Map<Quality, number[]>()
  const voicingOf = new Map<string, number[]>()
  let prev: number[] | null = null
  const notes: BassNote[] = []
  hits.forEach((h, i) => {
    // The push: a hit just before a change plays the coming chord.
    const ahead = chordAt(all, bars, (h.step + PUSH_STEPS) / 4)
    const here = chordAt(all, bars, h.step / 4)
    const c = !sameChord(ahead, here) && Math.round(ahead.at * 4) - h.step <= PUSH_STEPS && Math.round(ahead.at * 4) > h.step ? ahead : here
    const tag = `${c.at}`
    const v = voicingOf.get(tag) ?? voiced(shapeFor(rng, model, c.quality, chosen), pc(tonic + c.root), model.register, prev)
    voicingOf.set(tag, v)
    prev = v
    const room = (i + 1 < hits.length ? hits[i + 1].step : total + hits[0].step) - h.step
    const len = Math.max(0.25, Math.min(h.len, room / 4 - 0.02))
    const vel = Math.max(30, Math.min(120, Math.round(105 * h.vel)))
    const played = h.voices > 1 ? v : [v.at(-1)!]
    for (const p of played) notes.push([h.step / 4, Math.min(len, (total - h.step) / 4), p, vel])
  })
  return { kind, notes, bars, chords: all }
}

/** A written part as a MIDI item the rest of the app renders and exports like a file (negative id). */
export function pianoMidi(part: PianoPart, key: string | null): MidiItem {
  let h = 0
  for (const ch of JSON.stringify(part.notes)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0
  const tag = (h >>> 0).toString(16).slice(0, 5)
  return {
    id: -1 - ((h >>> 0) % 2_000_000_000), file_name: '', rel_path: '', role: 'piano', bars: part.bars,
    name: `Piano ${tag} (${part.bars} bar${part.bars === 1 ? '' : 's'}, ${part.kind})`,
    key_label: key, key_camelot: null, notes: part.notes, favorite: 0, source: 'generated', source_code: null,
  }
}

// ---------------------------------------------------------------------------
// The bass under a piano
// ---------------------------------------------------------------------------

/** A pitch moved onto the chord: a chord tone stays, else a note of the key's scale, else the nearest chord tone. */
function fitted(p: number, root: number, q: Quality, scale: Set<number>, tonic: number): number {
  const tones = new Set(TEMPLATES[q].map((i) => pc(root + i)))
  if (tones.has(pc(p))) return p
  // A third the chord doesn't have: the one it has.
  const iv = pc(p - root)
  if ((iv === 3 || iv === 4) && (tones.has(pc(root + 3)) || tones.has(pc(root + 4)))) return p + (tones.has(pc(root + 3)) ? 3 - iv : 4 - iv)
  if (scale.has(pc(p - tonic))) return p
  for (const d of [-1, 1, -2, 2]) if (tones.has(pc(p + d))) return p + d
  return p
}

const MINOR_SCALE = new Set([0, 2, 3, 5, 7, 8, 10, 11])

/**
 * The bassline under a piano part. Under a progression it follows the piano: its loop played
 * again and again over the part, each note moved onto the root of the chord sounding there (the
 * smaller way, up to a fifth up or down), its notes fitted to that chord. Under a loop it stays as
 * it is, only its third made the loop's (a major loop has a major third). The line's first note is
 * its root (as generateBassline writes it).
 */
export function followBass(line: BassNote[], lineBars: number, part: PianoPart, key: string | null): { notes: BassNote[]; bars: number } {
  const tonic = tonicOf(key)
  const sorted = [...line].sort((a, b) => a[0] - b[0])
  if (tonic == null || !sorted.length) return { notes: line, bars: lineBars }
  const lineRoot = sorted[0][2]
  if (part.kind === 'loop') {
    const c = chordAt(part.chords, part.bars, 0)
    return { notes: line.map(([s, l, p, v]): BassNote => [s, l, fitted(p, pc(tonic + c.root), c.quality, MINOR_SCALE, tonic), v]), bars: lineBars }
  }
  const bars = part.bars % lineBars === 0 ? part.bars : part.bars * lineBars
  const out: BassNote[] = []
  for (let rep = 0; rep * lineBars < bars; rep++) {
    for (const [s, l, p, v] of line) {
      const at = rep * lineBars * 4 + s
      const c = chordAt(part.chords, part.bars, at)
      // From the line's root to the chord's, the smaller way (a fifth up at most, a fourth down at most).
      const d = pc(tonic + c.root - lineRoot)
      const shift = d > 7 ? d - 12 : d
      out.push([at, l, fitted(p + shift, pc(lineRoot + shift), c.quality, MINOR_SCALE, tonic), v])
    }
  }
  return { notes: out, bars }
}
