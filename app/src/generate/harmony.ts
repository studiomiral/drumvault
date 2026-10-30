// Bass and Keys that agree (SCOPE.md §6.7), the club house way: each part is its own learned
// loop (the bass a riff, mostly on one chord; the keys a chord or loop with its own rhythm), and
// nothing is rewritten to match. What this does is listen to the pair: the keys loop that goes
// with the bass riff is chosen from a few candidates (or the riff that goes with kept keys).

import { generateBassline, parseKey, type BassModel, type BassNote, type GeneratedLine } from './bassline'
import type { Rng } from './rng'

export interface Harmony {
  bars: number
  /** Pitch class of the track key's root, and its mode. */
  tonic: number
  minor: boolean
  /** Per half bar: the chord's root in semitones from the tonic, the nearest way (−6…5). */
  roots: number[]
  /** The keys notes (beats in the loop): what sounds when. */
  notes: BassNote[]
}

export interface Line {
  notes: BassNote[]
  bars: number
}

/** How many candidates a part is chosen from. */
const CANDIDATES = 12

const pc = (n: number) => ((n % 12) + 12) % 12
const nearest = (iv: number) => (pc(iv) > 5 ? pc(iv) - 12 : pc(iv))
const NAT_MINOR = [0, 2, 3, 5, 7, 8, 10]
const IONIAN = [0, 2, 4, 5, 7, 9, 11]

/** The root of the pitch classes sounding (weights: how long each sounds), by how chord-like it makes them. */
function chordRoot(w: Map<number, number>, lowest: number, scale: number[]): number | null {
  const most = Math.max(0, ...w.values())
  if (!most) return null
  const has = (p: number) => (w.get(pc(p)) ?? 0) > 0.15 * most
  let best: number | null = null
  let score = -Infinity
  for (const r of w.keys()) {
    const s = 1 + (has(r + 7) ? 1 : 0) + (has(r + 3) || has(r + 4) ? 1 : 0) + (has(r + 10) || has(r + 11) ? 0.25 : 0)
      + (r === lowest ? 0.75 : 0) + (scale.includes(r) ? 0.25 : 0)
    if (s > score || (s === score && best != null && (w.get(r) ?? 0) > (w.get(best) ?? 0))) {
      best = r
      score = s
    }
  }
  return best
}

/** The chords of a keys part in `key` (its notes in beats from the loop start), half a bar at a time. */
export function harmonyOf(notes: BassNote[], bars: number, key: string | null): Harmony {
  const k = parseKey(key)
  const tonic = k?.root ?? 0
  const minor = k?.minor ?? true
  const scale = (minor ? NAT_MINOR : IONIAN).map((x) => pc(x + tonic))
  const roots: (number | null)[] = []
  for (let slot = 0; slot < bars * 2; slot++) {
    const a = slot * 2
    const w = new Map<number, number>()
    let lowest = Infinity
    for (const [s, l, p] of notes) {
      const overlap = Math.min(s + l, a + 2) - Math.max(s, a)
      if (overlap <= 0) continue
      w.set(pc(p), (w.get(pc(p)) ?? 0) + overlap)
      lowest = Math.min(lowest, p)
    }
    const r = chordRoot(w, pc(lowest), scale)
    roots.push(r == null ? null : nearest(r - tonic))
  }
  // A half bar without chords keeps the one before it (the first: the next one, else the tonic).
  let last = roots.find((r) => r != null) ?? 0
  return { bars, tonic, minor, roots: roots.map((r) => (last = r ?? last)), notes }
}

/** Does the harmony change at all (a progression, not one chord)? */
export function moves(h: Harmony): boolean {
  return h.roots.some((r) => r !== h.roots[0])
}

/** The pitch classes sounding at `beat` (in the harmony's loop). */
export function soundingAt(h: Harmony, beat: number): Set<number> {
  const t = ((beat % (h.bars * 4)) + h.bars * 4) % (h.bars * 4)
  return new Set(h.notes.filter(([s, l]) => s <= t + 1e-6 && t < s + l - 1e-6).map(([, , p]) => pc(p)))
}

/** Where a bassline's roots are, per half bar (the note on or nearest after each half bar's start). */
export function bassRoots(notes: BassNote[], bars: number, tonic: number): number[] {
  const sorted = [...notes].sort((a, b) => a[0] - b[0])
  const out: number[] = []
  for (let slot = 0; slot < bars * 2; slot++) {
    const n = sorted.find(([s]) => s >= slot * 2 - 1e-6 && s < slot * 2 + 2) ?? sorted.findLast(([s]) => s < slot * 2)
    out.push(n ? nearest(n[2] - tonic) : out.at(-1) ?? 0)
  }
  return out
}

/**
 * How well a keys part's chords fit a bassline's roots: per half bar, the bass on the chord's
 * root counts most, on another chord tone a little, off the chord against it.
 */
export function fitScore(h: Harmony, bass: number[]): number {
  const n = Math.max(h.roots.length, bass.length)
  let score = 0
  for (let i = 0; i < n; i++) {
    const b = bass[i % bass.length]
    const r = h.roots[i % h.roots.length]
    if (b === r) score += 2
    else if (soundingAt(h, i * 2 + 0.01).has(pc(h.tonic + b))) score += 0.5
    else score -= 2
  }
  return score / n
}

/**
 * The share of bass notes that rub a semitone against a chord tone sounding with them (the bass
 * note itself not in the chord), over both loops played together.
 */
export function clashShare(h: Harmony, bass: Line): number {
  const span = Math.max(h.bars, bass.bars) * 4
  let n = 0
  let rubs = 0
  for (let at = 0; at < span; at += bass.bars * 4) {
    for (const [s, , p] of bass.notes) {
      const sounding = soundingAt(h, at + s)
      n++
      if (sounding.size && !sounding.has(pc(p)) && (sounding.has(pc(p + 1)) || sounding.has(pc(p - 1)))) rubs++
    }
  }
  return n ? rubs / n : 0
}

/** How well a keys loop and a bass loop go together: the bass on the chords' roots, without rubs. */
export function pairScore(h: Harmony, bass: Line): number {
  return fitScore(h, bassRoots(bass.notes, bass.bars, h.tonic)) - 4 * clashShare(h, bass)
}

/** The best of a few candidates by `score` (the first on a tie: the same seed, the same pick). */
export function bestOf<T>(make: () => T, score: (x: T) => number, n = CANDIDATES): T {
  let best = make()
  let top = score(best)
  for (let i = 1; i < n; i++) {
    const x = make()
    const s = score(x)
    if (s > top) [best, top] = [x, s]
  }
  return best
}

/** A bass riff for keys that stay (kept, or the riff renewed under them): the one that fits them best. */
export function bassFor(model: BassModel, rng: Rng, opts: { key: string | null; bars?: 1 | 2 | 4 | null },
                        keys: Harmony | null): GeneratedLine {
  if (!keys) return generateBassline(model, rng, opts)
  return bestOf(() => generateBassline(model, rng, opts), (l) => pairScore(keys, l))
}

const MINOR_NAMES: Record<number, string> = { 0: 'i', 2: 'ii°', 3: 'III', 5: 'iv', 7: 'v', 8: 'VI', 10: 'VII', 11: 'vii°' }
const MAJOR_NAMES: Record<number, string> = { 0: 'I', 2: 'ii', 4: 'iii', 5: 'IV', 7: 'V', 9: 'vi', 10: 'bVII', 11: 'vii°' }

/** "i", "i – iv", "i – VI – VII – i": the chords bar by bar (a bar that changes halfway shows both, "VI/VII"). */
export function progressionName(h: Harmony): string {
  const names = h.minor ? MINOR_NAMES : MAJOR_NAMES
  const name = (r: number) => names[pc(r)] ?? `${pc(r)}`
  const bars: string[] = []
  for (let b = 0; b < h.bars; b++) {
    const [x, y] = [h.roots[b * 2], h.roots[b * 2 + 1]]
    bars.push(x === y ? name(x) : `${name(x)}/${name(y)}`)
  }
  // A loop on one chord is that chord, however many bars it lasts.
  return bars.every((b) => b === bars[0]) ? bars[0] : bars.join(' – ')
}
