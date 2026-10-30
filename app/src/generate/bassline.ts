// Basslines made, not picked (SCOPE.md §6.7): the MIDI library's basslines are what the
// generator learns from. learnBass() reads what they have in common (where in the bar notes
// start, which step follows which, the intervals from the root by beat position and from note
// to note, how long notes are held, the register, and what the 2nd, 3rd and 4th bar of a loop
// do differently), generateBassline() writes a new 1-, 2- or 4-bar loop in the track key from
// it. Pure and seeded: the same seed, model and key give the same line.

import type { MidiItem } from '../types/api'
import type { Rng } from './rng'

export type BassNote = [number, number, number, number]  // start beats, length beats, pitch, velocity

const STEPS = 16
/** The bar's beat positions: the 1, the 3, beats 2 and 4, 8th offbeats, 16ths. */
const CLASSES = 5
const classOf = (step: number) => step === 0 ? 0 : step === 8 ? 1 : step % 4 === 0 ? 2 : step % 2 === 0 ? 3 : 4
/** Intervals a line may use, around the root: an octave below to an octave and a fifth above. */
const LOW = -12
const HIGH = 19

type Weights = Map<number, number>

export interface BassModel {
  /** How many loops it learned from (8-bar files count as two 4-bar loops). */
  lines: number
  /** MIDI note of the root on the 1 (median): where basslines sit. */
  register: number
  /** Onsets in the main bar: the usual fewest and most (10th and 90th percentile). */
  density: [number, number]
  /** How many different notes the main bars play (one count per line). */
  colours: number[]
  /** The longest notes are held (90th percentile, 16ths). */
  longest: number
  /** After a note on step i, where the next one starts (16 = none until the next bar). */
  next: number[][]
  /** Where notes start at all (and 16: bar ends), to fall back on after a rare step. */
  onsets: number[]
  /** Intervals from the root (octave included) by beat position class. */
  at: Weights[]
  /** Interval after interval. */
  move: Map<number, Weights>
  /** Note length as a share of the room to the next note, one value per line (legato … staccato). */
  articulation: number[]
  /** Loop lengths (8-bar files count as 4). */
  lengths: Record<1 | 2 | 4, number>
  /** Chance that a later bar differs from bar 1: bar 2 of 2, bars 2–4 of 4. */
  varies: { two: number; four: [number, number, number] }
  /** Where a varied bar starts to differ (step 0: all of it). */
  from: Weights
  /** Intervals of the notes a varied bar plays differently (turnarounds, walks). */
  turn: Weights
  /** Share of whole-bar variations that move the bar to another root, and where to. */
  moveShare: number
  barMove: Weights
  /** Velocity per step, as a share of the line's loudest. */
  velocity: number[]
}

interface Hit { step: number; len: number; iv: number; vel: number }

const add = (m: Weights, k: number, w = 1) => m.set(k, (m.get(k) ?? 0) + w)
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}
const same = (a: Hit[], b: Hit[]) => a.length === b.length && a.every((x, i) => x.step === b[i].step && x.iv === b[i].iv)

/** A file's loops as bars of hits on the 16th grid, relative to the root on its 1. */
function loopsOf(m: MidiItem): { bars: Hit[][]; root: number }[] {
  const notes = [...m.notes].sort((a, b) => a[0] - b[0] || a[2] - b[2])
  if (!notes.length) return []
  // The root: the note on the very first 1 (the key label is often wrong), else the pitch held longest.
  const first = notes.find(([s]) => Math.round(s * 4) === 0)
  let root = first?.[2]
  if (root == null) {
    const held = new Map<number, number>()
    for (const [, l, p] of notes) held.set(p, (held.get(p) ?? 0) + l)
    root = [...held.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }
  const total = Math.max(1, m.bars)
  const bars: Hit[][] = Array.from({ length: total }, () => [])
  for (const [s, l, p, v] of notes) {
    const step = Math.round(s * 4)
    const bar = Math.floor(step / STEPS)
    if (bar >= total) continue
    const hits = bars[bar]
    if (hits.some((h) => h.step === step % STEPS)) continue  // one note per step (the lowest)
    hits.push({ step: step % STEPS, len: l * 4, iv: p - root, vel: v })
  }
  // Learned as minor (most of the library is): a major line's 3rd and 6th as the minor ones, so a
  // move to its VI is a move to the minor VI. Major keys get them back when a line is written.
  const ivs = new Set(bars.flat().map((h) => ((h.iv % 12) + 12) % 12))
  if (ivs.has(4) && !ivs.has(3)) {
    for (const h of bars.flat()) if ([4, 9].includes(((h.iv % 12) + 12) % 12)) h.iv -= 1
  }
  const loops = total === 8 ? [bars.slice(0, 4), bars.slice(4)] : [bars]
  return loops.map((b) => ({ bars: b, root }))
}

/** What the MIDI library's basslines have in common. Null without any. */
export function learnBass(midis: MidiItem[]): BassModel | null {
  const lines = midis.filter((m) => m.role === 'bass' && m.notes.length)
  if (!lines.length) return null
  const next = Array.from({ length: STEPS }, () => new Array<number>(STEPS + 1).fill(0))
  const at = Array.from({ length: CLASSES }, () => new Map<number, number>())
  const move = new Map<number, Weights>()
  const articulation: number[] = []
  const lengths = { 1: 0, 2: 0, 4: 0 }
  const varied = { two: [0, 0], four: [[0, 0], [0, 0], [0, 0]] }
  const from = new Map<number, number>()
  const turn = new Map<number, number>()
  const barMove = new Map<number, number>()
  let whole = 0, moved = 0, n = 0
  const roots: number[] = []
  const counts: number[] = []
  const colours: number[] = []
  const held: number[] = []
  const onsets = new Array<number>(STEPS + 1).fill(0)
  const vel = Array.from({ length: STEPS }, () => [] as number[])

  for (const m of lines) {
    lengths[m.bars <= 1 ? 1 : m.bars <= 2 ? 2 : 4]++
    for (const { bars, root } of loopsOf(m)) {
      const main = bars[0]
      if (!main.length) continue
      n++
      roots.push(root)
      counts.push(main.length)
      colours.push(new Set(main.map((h) => h.iv)).size)
      for (const h of main) onsets[h.step]++
      onsets[STEPS]++
      const loud = Math.max(...main.map((h) => h.vel))
      for (const h of main) {
        add(at[classOf(h.step)], h.iv)
        vel[h.step].push(h.vel / loud)
      }
      main.forEach((h, i) => next[h.step][main[i + 1]?.step ?? STEPS]++)
      const seq = bars.flat()
      for (let i = 1; i < seq.length; i++) {
        if (!move.has(seq[i - 1].iv)) move.set(seq[i - 1].iv, new Map())
        add(move.get(seq[i - 1].iv)!, seq[i].iv)
      }
      // Articulation: each note's length against the room to the next onset (the loop wraps).
      const starts = bars.flatMap((b, bi) => b.map((h) => bi * STEPS + h.step))
      const loopLen = bars.length * STEPS
      held.push(...bars.flat().map((h) => h.len))
      articulation.push(median(bars.flat().map((h, i) => {
        const room = ((starts[(i + 1) % starts.length] - starts[i] + loopLen - 1) % loopLen) + 1
        return Math.min(1, h.len / room)
      })))
      // What the later bars do differently.
      bars.slice(1).forEach((bar, k) => {
        const diff = !same(bar, main)
        if (bars.length === 2) { varied.two[0] += +diff; varied.two[1]++ }
        else if (bars.length === 4) { varied.four[k][0] += +diff; varied.four[k][1]++ }
        if (!diff) return
        const key = (h: Hit) => `${h.step}:${h.iv}`
        const mainKeys = new Set(main.map(key))
        const barKeys = new Set(bar.map(key))
        const changed = [...bar.filter((h) => !mainKeys.has(key(h))), ...main.filter((h) => !barKeys.has(key(h)))]
        const start = Math.min(...changed.map((h) => h.step))
        add(from, start)
        for (const h of bar) if (h.step >= start && !mainKeys.has(key(h))) add(turn, h.iv)
        if (start === 0) {
          whole++
          const one = bar.find((h) => h.step === 0)
          if (one && one.iv !== 0 && bar.every((h) => main.some((x) => x.step === h.step))) { moved++; add(barMove, one.iv) }
        }
      })
    }
  }
  if (!n) return null
  const share = ([d, t]: number[]) => (t ? d / t : 0.5)
  const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]
  return {
    lines: n,
    register: median(roots),
    density: [Math.max(2, pct(counts, 0.1)), Math.max(2, pct(counts, 0.9))],
    colours, longest: Math.max(2, pct(held, 0.9)),
    next, onsets, at, move, articulation, lengths,
    varies: { two: share(varied.two), four: [share(varied.four[0]), share(varied.four[1]), share(varied.four[2])] },
    from, turn, moveShare: whole ? moved / whole : 0, barMove,
    velocity: vel.map((v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 1)),
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
const pc = (iv: number) => ((iv % 12) + 12) % 12

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
  bars: 1 | 2 | 4
}

/**
 * A new bassline from the model: a main bar (its rhythm a walk over the learned step-to-step
 * moves, its notes from the intervals learned for each beat position and after each other), the
 * later bars the same or varied the way the library's are (their second half turned around, or
 * the whole bar on another root), note lengths in one of the learned articulations, the root on
 * the 1 in the track key at the learned register.
 */
export function generateBassline(model: BassModel, rng: Rng, opts: { key: string | null; bars?: 1 | 2 | 4 | null }): GeneratedLine {
  const bars = opts.bars ?? rng.weighted([[1, model.lengths[1] + 0.5], [2, model.lengths[2] + 1], [4, model.lengths[4] + 1]] as const)
  const k = parseKey(opts.key)
  const minor = k?.minor ?? true
  const scale = minor ? MINOR : MAJOR
  const rootPc = k?.root ?? pc(model.register)
  const root = rootPc + 12 * Math.round((model.register - rootPc) / 12)
  const art = rng.pick(model.articulation.length ? model.articulation : [0.8])

  /** Onsets from `start` (which plays) to the bar end, walking the learned moves. */
  const rhythm = (start: number): number[] => {
    const out = [start]
    let s = start
    const all = model.onsets.reduce((a, x) => a + x, 0) || 1
    while (out.length < 24) {
      // The learned move from this step, falling back on where notes start at all after a rare one.
      const row = model.next[s]
      const seen = row.reduce((a, x) => a + x, 0)
      const cand: [number, number][] = []
      for (let t = s + 1; t <= STEPS; t++) cand.push([t, row[t] + (2 / (1 + seen)) * (model.onsets[t] / all) + 0.002])
      s = rng.weighted(cand)
      if (s >= STEPS) break
      out.push(s)
    }
    return out
  }
  /** An interval for a note on `step` after `prev`, from `pool` (or the beat position's own). */
  const interval = (step: number, prev: number | null, pool?: Weights): number => {
    const own = model.at[classOf(step)]
    const after = prev == null ? null : model.move.get(prev)
    const w = new Map<number, number>()
    for (const iv of new Set([...own.keys(), ...(pool?.keys() ?? []), ...(after?.keys() ?? [])])) {
      if (iv < LOW || iv > HIGH) continue
      const base = pool ? (pool.get(iv) ?? 0) + 0.3 * (own.get(iv) ?? 0) : (own.get(iv) ?? 0) + 0.05
      // Note to note tempered: the library repeats notes a lot, but its bars still move.
      const flow = after ? Math.sqrt((after.get(iv) ?? 0) + 0.5) : 1
      add(w, iv, base * flow)
    }
    return pickW(rng, w) ?? 0
  }

  // ---- the main bar ----
  let main: number[] = [0]
  for (let tries = 0; tries < 30; tries++) {
    main = rhythm(0)
    if (main.length >= model.density[0] && main.length <= Math.max(model.density[1], model.density[0])) break
  }
  // As many different notes as the library's main bars play (one, the root, is rare; two to four common).
  const colours = Math.min(main.length, rng.pick(model.colours.length ? model.colours : [3]))
  let bar0: { step: number; iv: number }[] = []
  for (let tries = 0; tries < 40; tries++) {
    bar0 = []
    for (const step of main) bar0.push({ step, iv: step === 0 ? 0 : interval(step, bar0.at(-1)?.iv ?? null) })
    if (new Set(bar0.map((h) => h.iv)).size === colours) break
  }

  // ---- the later bars: the same, or varied like the library's ----
  const chance = (b: number) => bars === 2 ? model.varies.two : bars === 4 ? model.varies.four[b - 1] : 0
  const plan = Array.from({ length: bars }, (_, b) => b > 0 && rng.chance(chance(b)))
  if (bars > 1 && !plan.some(Boolean)) plan[bars - 1] = true  // a longer loop is longer for a reason
  const all: { step: number; iv: number; bar: number }[] = []
  for (let b = 0; b < bars; b++) {
    let bar = bar0
    if (plan[b]) {
      for (let tries = 0; tries < 12; tries++) {
        const start = Math.min(12, pickW(rng, model.from) ?? 8)
        if (start === 0 && model.barMove.size && rng.chance(model.moveShare)) {
          // The same bar on another root (a move to the VI, the IV, …).
          const shift = inScale(pickW(rng, model.barMove) ?? 0, scale)
          bar = bar0.map((h) => ({ step: h.step, iv: h.iv + shift }))
        } else {
          const keep = bar0.filter((h) => h.step < start)
          let tail = rhythm(start)
          for (let t = 0; t < 10 && keep.length + tail.length < model.density[0]; t++) tail = rhythm(start)
          const out = [...keep]
          for (const step of tail) {
            out.push({ step, iv: step === 0 ? 0 : interval(step, out.at(-1)?.iv ?? null, model.turn.size ? model.turn : undefined) })
          }
          bar = out
        }
        if (bar.length !== bar0.length || bar.some((h, i) => h.step !== bar0[i].step || h.iv !== bar0[i].iv)) break
      }
    }
    for (const h of bar) all.push({ ...h, bar: b })
  }

  // ---- lengths, velocity, pitch ----
  const loop = bars * STEPS
  const at = all.map((h) => h.bar * STEPS + h.step)
  const notes: BassNote[] = all.map((h, i) => {
    const room = (i + 1 < at.length ? at[i + 1] : loop) - at[i]
    const len = Math.max(0.75, Math.min(room, model.longest, Math.round(room * art * 4) / 4))
    const iv = inScale(inMode(Math.max(LOW, Math.min(HIGH, h.iv)), minor), scale)
    const vel = Math.max(1, Math.min(127, Math.round(100 * (model.velocity[h.step] ?? 1))))
    return [at[i] / 4, len / 4, root + iv, vel]
  })
  return { notes, bars }
}

/** A generated line as a bassline the rest of the app plays, renders and exports like an imported one. */
export function generatedMidi(line: GeneratedLine, key: string | null): MidiItem {
  let h = 0
  for (const ch of JSON.stringify(line.notes)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0
  const tag = (h >>> 0).toString(16).slice(0, 5)
  return {
    id: -1 - ((h >>> 0) % 2_000_000_000), file_name: '', rel_path: '', role: 'bass', bars: line.bars,
    name: `Bassline ${tag} (${line.bars} bar${line.bars === 1 ? '' : 's'})`,
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
