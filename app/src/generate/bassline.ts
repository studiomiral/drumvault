// Basslines made, not picked (SCOPE.md §6.7): the MIDI library's basslines are what the
// generator learns from. A funky house bassline is a short cell, 2 or 4 beats, repeated, and an
// 8-beat line is a 4-beat cell answered by a changed ending. learnBass() cuts every library line
// into the cells it really repeats (whatever its file length) and keeps their rhythms whole, with
// their accents, ghost notes and note lengths, plus which notes go where; generateBassline()
// writes a new loop of 2, 4 or 8 beats on one of those rhythms (sometimes moved a little) with new
// notes in the track key, many times over, and keeps the one that grooves most like the library's
// (a groove check measured on the library itself). Nothing is held across a kick; one note may
// slide into the next on a patch that glides. turnOf() is the loop's changed version for the end
// of a phrase (a gap, an octave jump or a run into the 1): the variation lives in the
// arrangement, the loop stays strict. Pure and seeded: the same seed, model and key give the same line.

import type { MidiItem } from '../types/api'
import type { Rng } from './rng'

export type BassNote = [number, number, number, number]  // start beats, length beats, pitch, velocity
/** Loop lengths new basslines are written in. */
export type LoopBeats = 2 | 4 | 8
export const LOOP_BEATS: LoopBeats[] = [2, 4, 8]

const STEPS = 16
/** The bar's beat positions: the 1, the 3, beats 2 and 4, 8th offbeats, 16ths. */
const CLASSES = 5
const classOf = (step: number) => step === 0 ? 0 : step === 8 ? 1 : step % 4 === 0 ? 2 : step % 2 === 0 ? 3 : 4
/** Intervals a line may use, around the root: an octave below to an octave and a fifth above. */
const LOW = -12
const HIGH = 19
/** Lines written per press; the one that grooves most like the library's is kept. */
const CANDIDATES = 40
/** How often a library rhythm is moved a little (a 16th moved, added or left out). */
const MUTATE_CHANCE = 0.5
/** How often a line on a gliding patch slides one note into the next. */
const SLIDE_CHANCE = 0.5
/** A slide's overlap into the next note (beats: a 32nd). */
const SLIDE_OVERLAP = 0.125
/** An 8-beat loop's answer starts no earlier than this 16th of its second bar (its last two beats). */
const ANSWER_FROM_MIN = 8
/** A library line favourited on the Bass tab counts this many times. */
const FAVORITE_WEIGHT = 3

type Weights = Map<number, number>

/** A note on the 16th grid: its step, its length (16ths) and length as a share of the room to the next note, interval from the root, velocity as a share of the loop's loudest. */
interface Hit { step: number; len: number; share: number; iv: number; vel: number }
/** A rhythm the library plays: 8 (2 beats) or 16 steps (4 beats), as played. */
interface Cell { steps: 8 | 16; hits: Hit[]; weight: number }
/** How an 8-beat line's second bar answers its first: from which 16th, and what it plays from there. */
interface Answer { from: number; hits: Hit[]; weight: number }
type Range = [number, number]

/** What a bar of bassline is like, for the groove check (computed the same for library and new lines). */
interface Feel {
  /** Notes in the bar. */
  n: number
  /** Share of notes off the beat (not on a kick). */
  off: number
  /** Share of notes on the kicks of beats 2, 3 and 4 (the 1 is the line's own). */
  onKick: number
  /** Share of the bar sounding. */
  fill: number
  /** Mean interval jump from note to note (semitones). */
  leap: number
}
const FEELS: (keyof Feel)[] = ['n', 'off', 'onKick', 'fill', 'leap']

export interface BassModel {
  /** How many loops it learned from (a line repeating only after 16 or 32 beats counts once per 8 beats). */
  lines: number
  /** MIDI note of the root on the 1 (median): where basslines sit. */
  register: number
  /** How long the library's lines really are before they repeat (lines longer than 8 beats left out). */
  periods: Record<LoopBeats, number>
  /** Lines that repeat only after 16 or 32 beats (cut into 8-beat loops to learn from). */
  long: number
  /** The library's rhythms: 2-beat cells and 4-beat cells. */
  cells: { 8: Cell[]; 16: Cell[] }
  /** How the library's 8-beat loops answer their first bar. */
  answers: Answer[]
  /** How many different notes the main bars play (one count per loop). */
  colours: number[]
  /** Where notes start at all (and 16: bar ends): the Bass tab's view, and where an added 16th goes. */
  onsets: number[]
  /** Intervals from the root (octave included) by beat position class. */
  at: Weights[]
  /** Interval after interval. */
  move: Map<number, Weights>
  /** Intervals of the notes an answer plays (turnarounds, walks). */
  turn: Weights
  /** Note length as a share of the room to the next note, and velocity as a share of the loudest, by beat position class (for an added 16th). */
  share: number[]
  accent: number[]
  /** The groove check's ranges: the library's main bars from their 10th to their 90th percentile. */
  feel: Record<keyof Feel, Range>
  /** The library's main bars (steps and intervals): a new line is never one of them. */
  known: Set<string>
}

const add = (m: Weights, k: number, w = 1) => m.set(k, (m.get(k) ?? 0) + w)
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]
const pc = (iv: number) => ((iv % 12) + 12) % 12
const sig = (hits: { step: number; iv: number }[]) => hits.map((h) => `${h.step}:${h.iv}`).join(' ')

/** Each note's length as a share of the room to the next onset (the loop of `total` steps wraps). */
function withShares(hits: Omit<Hit, 'share'>[], total: number): Hit[] {
  return hits.map((h, i) => {
    const next = hits[(i + 1) % hits.length].step
    const room = ((next - h.step + total - 1) % total) + 1
    return { ...h, share: Math.min(1, h.len / room) }
  })
}

/** The smallest repeat (16ths) a line of `total` steps has: 8, 16, 32 or longer. */
function periodOf(hits: { step: number; iv: number }[], total: number): number {
  const at = new Map(hits.map((h) => [h.step, h.iv]))
  for (const p of [8, 16, 32, 64, 128]) {
    if (p >= total) return total
    if (total % p) continue
    if (hits.every((h) => at.get((h.step + p) % total) === h.iv) && [...at.keys()].every((s) => at.has((s + p) % total))) return p
  }
  return total
}

/**
 * A file's notes on the 16th grid relative to the root on its 1 (the key label is often wrong),
 * one note per step (the lowest), a major line's 3rd and 6th as the minor ones (so a move to its VI
 * is the minor VI), and its real repeat.
 */
function readLine(m: MidiItem): { hits: Hit[]; total: number; period: number; root: number } | null {
  const notes = [...m.notes].sort((a, b) => a[0] - b[0] || a[2] - b[2])
  if (!notes.length) return null
  const first = notes.find(([s]) => Math.round(s * 4) === 0)
  let root = first?.[2]
  if (root == null) {
    const held = new Map<number, number>()
    for (const [, l, p] of notes) held.set(p, (held.get(p) ?? 0) + l)
    root = [...held.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }
  const total = Math.max(1, m.bars) * STEPS
  const raw: Omit<Hit, 'share'>[] = []
  for (const [s, l, p, v] of notes) {
    const step = Math.round(s * 4)
    if (step >= total || raw.some((h) => h.step === step)) continue
    raw.push({ step, len: Math.max(0.5, l * 4), iv: p - root, vel: v })
  }
  if (!raw.length) return null
  const ivs = new Set(raw.map((h) => pc(h.iv)))
  if (ivs.has(4) && !ivs.has(3)) for (const h of raw) if ([4, 9].includes(pc(h.iv))) h.iv -= 1
  return { hits: withShares(raw, total), total, period: periodOf(raw, total), root }
}

/** The hits of [from, from + n) steps, moved to start at 0, velocities against their loudest. */
function window(hits: Hit[], from: number, n: number): Hit[] {
  const out = hits.filter((h) => h.step >= from && h.step < from + n).map((h) => ({ ...h, step: h.step - from }))
  const loud = Math.max(1, ...out.map((h) => h.vel))
  return out.map((h) => ({ ...h, vel: h.vel / loud }))
}

/** A bar of 16 steps (a 2-beat cell played twice), for the groove check. */
const asBar = (hits: Hit[], steps: number): Hit[] => (steps === 8 ? [...hits, ...hits.map((h) => ({ ...h, step: h.step + 8 }))] : hits)

function feelOf(bar: { step: number; len: number; iv: number }[]): Feel {
  const n = bar.length
  const leaps = bar.slice(1).map((h, i) => Math.abs(h.iv - bar[i].iv))
  return {
    n,
    off: n ? bar.filter((h) => h.step % 4 !== 0).length / n : 0,
    onKick: n ? bar.filter((h) => h.step % 4 === 0 && h.step !== 0).length / n : 0,
    fill: Math.min(1, bar.reduce((a, h) => a + h.len, 0) / STEPS),
    leap: mean(leaps),
  }
}

/** What the MIDI library's basslines have in common. Null without any. */
export function learnBass(midis: MidiItem[]): BassModel | null {
  const files = midis.filter((m) => m.role === 'bass' && m.notes.length)
  if (!files.length) return null
  const periods: Record<LoopBeats, number> = { 2: 0, 4: 0, 8: 0 }
  const cells: BassModel['cells'] = { 8: [], 16: [] }
  const answers: Answer[] = []
  const at = Array.from({ length: CLASSES }, () => new Map<number, number>())
  const move = new Map<number, Weights>()
  const turn = new Map<number, number>()
  const roots: number[] = []
  const colours: number[] = []
  const onsets = new Array<number>(STEPS + 1).fill(0)
  const shares = Array.from({ length: CLASSES }, () => [] as number[])
  const accents = Array.from({ length: CLASSES }, () => [] as number[])
  const feels: Feel[] = []
  const known = new Set<string>()
  let n = 0, long = 0

  const addCell = (steps: 8 | 16, hits: Hit[], weight: number) => {
    if (!hits.length) return
    const same = cells[steps].find((c) => sig(c.hits) === sig(hits))
    if (same) same.weight += weight
    else cells[steps].push({ steps, hits, weight })
  }

  for (const m of files) {
    const line = readLine(m)
    if (!line) continue
    const weight = m.favorite ? FAVORITE_WEIGHT : 1
    const { hits, total, period } = line
    if (period <= 32) periods[(period / 4) as LoopBeats] += weight
    else long++
    // The loops it plays: its repeat, or (a line longer than 8 beats) each of its 8-beat stretches.
    const loopLen = Math.min(period, 32)
    for (let from = 0; from < (period <= 32 ? loopLen : total); from += loopLen) {
      const loop = window(hits, from, loopLen)
      if (!loop.length) continue
      n++
      roots.push(line.root)
      const main = asBar(loopLen === 8 ? loop : window(loop, 0, STEPS), loopLen === 8 ? 8 : 16)
      if (!main.length) continue
      known.add(sig(main))
      feels.push(feelOf(main))
      colours.push(new Set(main.map((h) => h.iv)).size)
      for (const h of main) {
        onsets[h.step] += weight
        add(at[classOf(h.step)], h.iv, weight)
        shares[classOf(h.step)].push(h.share)
        accents[classOf(h.step)].push(h.vel)
      }
      onsets[STEPS] += weight
      for (let i = 1; i < loop.length; i++) {
        if (!move.has(loop[i - 1].iv)) move.set(loop[i - 1].iv, new Map())
        add(move.get(loop[i - 1].iv)!, loop[i].iv, weight)
      }
      // Its cells: a 2-beat loop is its own; a bar gives its two halves, too.
      if (loopLen === 8) {
        addCell(8, loop, weight)
        addCell(16, asBar(loop, 8), weight)
      } else {
        const bar1 = window(loop, 0, STEPS)
        addCell(16, bar1, weight)
        addCell(8, window(bar1, 0, 8), weight)
        addCell(8, window(bar1, 8, 8), weight)
      }
      // An 8-beat loop: how its second bar answers the first.
      if (loopLen === 32) {
        const bar1 = window(loop, 0, STEPS), bar2 = window(loop, STEPS, STEPS)
        const keys1 = new Set(bar1.map((h) => `${h.step}:${h.iv}`)), keys2 = new Set(bar2.map((h) => `${h.step}:${h.iv}`))
        const changed = [...bar2.filter((h) => !keys1.has(`${h.step}:${h.iv}`)), ...bar1.filter((h) => !keys2.has(`${h.step}:${h.iv}`))]
        if (changed.length) {
          const start = Math.min(...changed.map((h) => h.step))
          const tail = bar2.filter((h) => h.step >= start)
          answers.push({ from: start, hits: tail, weight })
          for (const h of tail) add(turn, h.iv, weight)
        }
      }
    }
  }
  if (!n || !cells[16].length) return null
  const range = (k: keyof Feel): Range => {
    const xs = feels.map((f) => f[k])
    return [pct(xs, 0.1), pct(xs, 0.9)]
  }
  return {
    lines: n, register: median(roots), periods, long, cells, answers, colours, onsets, at, move, turn,
    share: shares.map((s) => (s.length ? median(s) : 0.7)),
    accent: accents.map((a) => (a.length ? mean(a) : 0.85)),
    feel: Object.fromEntries(FEELS.map((k) => [k, range(k)])) as Record<keyof Feel, Range>,
    known,
  }
}

// ---------------------------------------------------------------------------
// Writing a new line
// ---------------------------------------------------------------------------

const PITCH: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
}
// With the note a semitone under the root: the approach the library's turnarounds love.
const MINOR = new Set([0, 2, 3, 5, 7, 8, 10, 11])
const MAJOR = new Set([0, 2, 4, 5, 7, 9, 10, 11])  // and the b7: funky house's major is mixolydian

export function parseKey(key: string | null): { root: number; minor: boolean } | null {
  const m = key ? /^([A-G][#b]?)(m?)$/.exec(key.trim()) : null
  return m && PITCH[m[1]] != null ? { root: PITCH[m[1]], minor: m[2] === 'm' } : null
}

/** The learned intervals (mostly minor lines) in the key's mode: in major, the 3rd and 6th go up. */
function inMode(iv: number, minor: boolean): number {
  if (minor) return iv
  const p = pc(iv)
  return p === 3 || p === 8 ? iv + 1 : iv
}

/** The nearest interval in the scale (a learned one outside it moves a semitone). */
function inScale(iv: number, scale: Set<number>): number {
  if (scale.has(pc(iv))) return iv
  return scale.has(pc(iv - 1)) ? iv - 1 : iv + 1
}

function pickW(rng: Rng, w: Weights): number | null {
  const items = [...w.entries()].filter(([, x]) => x > 0)
  return items.length ? rng.weighted(items) : null
}

export interface GeneratedLine {
  notes: BassNote[]
  /** Loop length in bars (a 2-beat loop is written as a bar of it, twice). */
  bars: 1 | 2
  beats: LoopBeats
}

/** How far a bar is from grooving like the library's (0: right in the middle of it). */
function grooveCheck(model: BassModel, bar: Hit[]): number {
  const f = feelOf(bar)
  let bad = 0
  for (const k of FEELS) {
    const [lo, hi] = model.feel[k]
    const width = Math.max(k === 'n' ? 1 : k === 'leap' ? 1.5 : 0.08, hi - lo)
    if (f[k] < lo) bad += (lo - f[k]) / width
    if (f[k] > hi) bad += (f[k] - hi) / width
  }
  const colours = new Set(bar.map((h) => h.iv)).size
  if (colours < 2 || colours > 4) bad += 1
  bar.forEach((h, i) => {
    const jump = i ? Math.abs(h.iv - bar[i - 1].iv) : 0
    if (jump > 12) bad += 1                                // past an octave: a line falls apart
    if (jump >= 10 && h.step % 4 === 0) bad += 0.5         // octave jumps belong on the weak 16ths, not on a kick
  })
  // Back to the 1: the loop's last note leads home (the root, its octave, the 5th, the b7, or a step under it).
  const last = bar.at(-1)
  if (last) {
    if (Math.abs(last.iv - bar[0].iv) > 12) bad += 0.5
    if ([0, 12, 7, -5, 10, -2, -1, 11].includes(last.iv)) bad -= 0.2
  }
  if (model.known.has(sig(bar))) bad += 5                  // a library line as it is: never
  return bad
}

/**
 * A new bassline: a loop of 2, 4 or 8 beats (the length asked for, else as long as the library's
 * lines really are). Each of CANDIDATES tries takes one of the library's rhythms whole (a 2-beat
 * cell, or a 4-beat one), with its accents and note lengths, sometimes a 16th moved, added or
 * left out; writes new notes on it (the root first, then by beat position and after each other,
 * as many different ones as a library line plays); an 8-beat loop plays it twice, the second time
 * answering from its last beat or two the way the library's do. No note is held across a kick.
 * The try that grooves most like the library's is kept; on a patch that glides (`glide`) one note
 * may slide into the next.
 */
export function generateBassline(model: BassModel, rng: Rng, opts: { key: string | null; beats?: LoopBeats | null; glide?: boolean }): GeneratedLine {
  const beats = opts.beats ?? rng.weighted(LOOP_BEATS.map((b) => [b, model.periods[b] + 0.5] as [LoopBeats, number]))
  const k = parseKey(opts.key)
  const minor = k?.minor ?? true
  const scale = minor ? MINOR : MAJOR
  const rootPc = k?.root ?? pc(model.register)
  const root = rootPc + 12 * Math.round((model.register - rootPc) / 12)
  const size: 8 | 16 = beats === 2 ? 8 : 16
  const pool = model.cells[size].length ? model.cells[size] : model.cells[16]

  /** An interval for a note on `step` after `prev`, from `turnPool` (or the beat position's own). */
  const interval = (step: number, prev: number | null, turnPool?: Weights): number => {
    const own = model.at[classOf(step)]
    const after = prev == null ? null : model.move.get(prev)
    const w = new Map<number, number>()
    for (const iv of new Set([...own.keys(), ...(turnPool?.keys() ?? []), ...(after?.keys() ?? [])])) {
      if (iv < LOW || iv > HIGH) continue
      const base = turnPool ? (turnPool.get(iv) ?? 0) + 0.3 * (own.get(iv) ?? 0) : (own.get(iv) ?? 0) + 0.05
      // Note to note tempered: the library repeats notes a lot, but its bars still move.
      const flow = after ? Math.sqrt((after.get(iv) ?? 0) + 0.5) : 1
      add(w, iv, base * flow)
    }
    return pickW(rng, w) ?? 0
  }
  const fresh = (step: number): Hit => ({ step, len: 1, share: model.share[classOf(step)], iv: 0, vel: model.accent[classOf(step)] })

  /** A library rhythm (`steps` long), sometimes moved a little. */
  const rhythm = (): Hit[] => {
    const cell = rng.pickBy(pool, (c) => c.weight)
    let hits = (cell.steps === size ? cell.hits : window(cell.hits, 0, 8)).map((h) => ({ ...h }))
    if (rng.chance(MUTATE_CHANCE)) {
      const taken = new Set(hits.map((h) => h.step))
      const op = rng.weighted([['move', 2], ['add', 1], ['drop', 1]] as const)
      if (op === 'move') {
        const h = rng.pick(hits.filter((x) => x.step !== 0).length ? hits.filter((x) => x.step !== 0) : hits)
        const to = h.step + (rng.chance(0.5) ? 1 : -1)
        if (h.step !== 0 && to > 0 && to < size && !taken.has(to)) h.step = to
      } else if (op === 'add') {
        const free = Array.from({ length: size }, (_, s) => s).filter((s) => !taken.has(s))
        const wOf = (s: number) => model.onsets[s] + (size === 8 ? model.onsets[s + 8] : 0) + 0.01
        if (free.length) hits.push(fresh(rng.pickBy(free, wOf)))
      } else if (hits.length >= 3) {
        const cand = hits.filter((x) => x.step !== 0)
        if (cand.length) hits = hits.filter((x) => x !== rng.pick(cand))
      }
      hits.sort((a, b) => a.step - b.step)
    }
    return hits
  }

  /** New notes on a rhythm: the root first, then as many different notes as a library line plays. */
  const notesOn = (hits: Hit[]): Hit[] => {
    const want = Math.min(hits.length, Math.max(2, rng.pick(model.colours.length ? model.colours : [3])))
    let out: Hit[] = hits
    for (let tries = 0; tries < 20; tries++) {
      out = []
      for (const h of hits) out.push({ ...h, iv: out.length === 0 ? 0 : interval(h.step, out.at(-1)!.iv) })
      // (In a 2-beat cell played twice, its notes count twice: as many colours as fit in half.)
      if (new Set(out.map((h) => h.iv)).size >= Math.min(want, size === 8 ? 3 : want)) break
    }
    return out
  }

  /** An 8-beat loop's second bar: the first, answered from its last beat or two. */
  const answer = (bar1: Hit[]): Hit[] => {
    const a = model.answers.length ? rng.pickBy(model.answers, (x) => x.weight) : null
    const from = Math.max(ANSWER_FROM_MIN, Math.min(14, a?.from ?? 12))
    const keep = bar1.filter((h) => h.step < from).map((h) => ({ ...h }))
    let tail = (a?.hits ?? bar1).filter((h) => h.step >= from).map((h) => ({ ...h }))
    if (!tail.length) tail = [fresh(Math.min(15, from + 2))]
    const out = [...keep]
    for (const h of tail) out.push({ ...h, iv: interval(h.step, out.at(-1)?.iv ?? null, model.turn.size ? model.turn : undefined) })
    if (sig(out) === sig(bar1)) {
      const last = out.at(-1)!
      last.iv = last.iv >= 12 ? last.iv - 12 : last.iv + 12
    }
    return out
  }

  // ---- many tries, the one that grooves most like the library's kept ----
  let best: { bars: Hit[][]; bad: number } | null = null
  for (let t = 0; t < CANDIDATES; t++) {
    const cell = notesOn(rhythm())
    const bar1 = asBar(cell, size)
    const bars = beats === 8 ? [bar1, answer(bar1)] : [bar1]
    const bad = grooveCheck(model, bar1) + (bars[1] ? 0.5 * Math.max(0, grooveCheck(model, bars[1])) : 0)
    if (!best || bad < best.bad) best = { bars, bad }
  }

  // ---- lengths (as played, never across the next kick), velocity, pitch ----
  const bars = best!.bars
  const loop = bars.length * STEPS
  const all = bars.flatMap((b, i) => b.map((h) => ({ ...h, at: i * STEPS + h.step })))
  const notes: BassNote[] = all.map((h, i) => {
    const room = (i + 1 < all.length ? all[i + 1].at : loop + all[0].at) - h.at
    const kick = (Math.floor(h.at / 4) + 1) * 4 - h.at
    const len = Math.max(0.75, Math.min(room, kick, Math.round(room * h.share * 4) / 4))
    const iv = inScale(inMode(Math.max(LOW, Math.min(HIGH, h.iv)), minor), scale)
    const vel = Math.max(1, Math.min(127, Math.round(100 * h.vel)))
    return [h.at / 4, Math.min(len, loop - h.at) / 4, root + iv, vel]
  })

  // ---- a slide into a weak 16th, within the beat, on a patch that glides ----
  if (opts.glide && rng.chance(SLIDE_CHANCE)) {
    const pairs = notes.slice(0, -1).map((_, i) => i).filter((i) => {
      const [s, l, p] = notes[i], [s2, , p2] = notes[i + 1]
      const step2 = Math.round(s2 * 4)
      return step2 % 4 !== 0 && Math.floor(s) === Math.floor(s2) && p !== p2 && Math.abs(p - p2) <= 12 && s2 - (s + l) <= 0.25 + 1e-9
    })
    if (pairs.length) {
      const i = rng.pick(pairs)
      notes[i][1] = notes[i + 1][0] - notes[i][0] + SLIDE_OVERLAP
    }
  }
  return { notes, bars: beats === 8 ? 2 : 1, beats }
}

// ---------------------------------------------------------------------------
// The phrase-end turn
// ---------------------------------------------------------------------------

/** The loop's changed version for the end of a phrase: its last beat left out, up an octave, or a 16th run into the 1. */
export type BassTurn = 'gap' | 'octave' | 'pickup'

/**
 * The loop with its last beat changed (the bassline's turn at the end of a phrase; the clip
 * playing it carries `turn`): `gap` leaves the beat out (the notes before it stop there), `octave`
 * plays it an octave up (down where it is high already), `pickup` plays three 16ths leading into
 * the 1 (down from the octave over the b7 and the 5th, or up from the 5th under the root over the
 * b7 and the note under it). Deterministic: the same notes give the same turn.
 */
export function turnOf(notes: BassNote[], bars: number, kind: BassTurn): BassNote[] {
  const sorted = [...notes].sort((a, b) => a[0] - b[0])
  if (!sorted.length) return []
  const L = bars * 4
  const from = L - 1
  const root = sorted[0][2]
  const before: BassNote[] = sorted.filter((n) => n[0] < from - 1e-9).map((n) => (n[0] + n[1] > from ? [n[0], from - n[0], n[2], n[3]] : [...n]))
  const last = sorted.filter((n) => n[0] >= from - 1e-9)
  if (kind === 'gap') return before
  if (kind === 'octave' && last.length) return [...before, ...last.map(([s, l, p, v]): BassNote => [s, l, p - root >= 7 ? p - 12 : p + 12, v])]
  const down = sorted.reduce((a, n) => a + n[2], 0) % 2 === 0
  const run = down ? [12, 10, 7] : [-5, -2, -1]
  const vel = Math.max(...sorted.map((n) => n[3]))
  return [...before, ...run.map((iv, i): BassNote => [from + 0.25 * (i + 1), 0.1875, root + iv, Math.round(vel * (0.75 + 0.1 * i))])]
}

/** The notes a bass part renders and exports: its notes, with its turn when it has one. */
export function playedNotes(b: { notes?: BassNote[]; bars?: number; turn?: BassTurn }): BassNote[] | undefined {
  return b.turn && b.notes?.length ? turnOf(b.notes, b.bars ?? 1, b.turn) : b.notes
}

// ---------------------------------------------------------------------------

/** How long a line really is before it repeats (beats): 2, 4, 8, or its whole length. */
export function loopBeatsOf(notes: BassNote[], bars: number): number {
  const total = Math.max(1, bars) * STEPS
  const hits = notes.map(([s, , p]) => ({ step: Math.round(s * 4), iv: p })).filter((h) => h.step < total)
  return periodOf(hits, total) / 4
}

/** A generated line as a bassline the rest of the app plays, renders and exports like an imported one. */
export function generatedMidi(line: Pick<GeneratedLine, 'notes' | 'bars'> & { beats?: number }, key: string | null): MidiItem {
  let h = 0
  for (const ch of JSON.stringify(line.notes)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0
  const tag = (h >>> 0).toString(16).slice(0, 5)
  const beats = line.beats ?? line.bars * 4
  return {
    id: -1 - ((h >>> 0) % 2_000_000_000), file_name: '', rel_path: '', role: 'bass', bars: line.bars,
    name: `Bassline ${tag} (${beats} beats)`,
    key_label: key, key_camelot: null, notes: line.notes, favorite: 0, source: 'generated', source_code: null,
  }
}

/** Made by the generator (not a file in the MIDI library). */
export const isGenerated = (m: { id: number } | number) => (typeof m === 'number' ? m : m.id) < 0

/** The key a line is in, from its notes: the root on its 1, minor unless it plays a major 3rd and no minor one. */
export function keyOfLine(notes: BassNote[]): string | null {
  const one = [...notes].sort((a, b) => a[0] - b[0])[0]
  if (!one) return null
  const r = pc(one[2])
  const ivs = new Set(notes.map((n) => pc(n[2] - one[2])))
  const name = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][r]
  return ivs.has(4) && !ivs.has(3) ? name : `${name}m`
}

const memo = new WeakMap<MidiItem[], BassModel | null>()
/** learnBass, once per list of basslines. */
export function bassModel(midis: MidiItem[]): BassModel | null {
  if (!memo.has(midis)) memo.set(midis, learnBass(midis))
  return memo.get(midis)!
}
