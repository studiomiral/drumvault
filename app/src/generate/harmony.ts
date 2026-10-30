// Harmony shared by Bass and Keys (SCOPE.md §6.7): the chords a keys part plays, half a bar at a
// time, so the bassline follows them the way it does in a real track, and the other way round
// (a keys part chosen to fit a bassline that is kept).

import { parseKey, type BassNote } from './bassline'

export interface Harmony {
  bars: number
  /** Pitch class of the track key's root, and its mode. */
  tonic: number
  minor: boolean
  /** Per half bar: the chord's root in semitones from the tonic, the nearest way (−6…5). */
  roots: number[]
  /** The keys notes (beats in the loop): what sounds when, to keep the bass off a semitone clash. */
  notes: BassNote[]
  /** 16th steps of the bar where short chords (stabs) start: the bass plays around them. */
  stabs: number[]
}

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

/** The harmony of a keys part in `key` (its notes in beats from the loop start). */
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
  const first = roots.find((r) => r != null) ?? 0
  let last = first
  const filled = roots.map((r) => (last = r ?? last))
  const starts = new Map<number, number>()
  for (const [s, l] of notes) starts.set(s, Math.max(starts.get(s) ?? 0, l))
  const stabs = [...new Set([...starts].filter(([, l]) => l < 1).map(([s]) => Math.round(s * 4) % 16))].sort((a, b) => a - b)
  return { bars, tonic, minor, roots: filled, notes, stabs }
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

/**
 * `iv` (semitones above the tonic) moved to the chord on `shift` by scale steps, so a bar's root,
 * 3rd, 5th and 7th stay its root, 3rd, 5th and 7th: in C minor the minor 3rd over C becomes the
 * major 3rd over Ab. A chromatic root moves everything by semitones.
 */
export function diatonic(iv: number, shift: number, minor: boolean): number {
  const s = minor ? NAT_MINOR : IONIAN
  const degree = (p: number) => {
    const d = s.findLastIndex((x) => x <= p)
    return { d, c: p - s[d] }
  }
  const sh = degree(pc(shift))
  if (sh.c) return iv + shift
  const o = Math.floor(iv / 12)
  const { d, c } = degree(pc(iv))
  const n = d + sh.d
  return (o + Math.floor(n / 7) + (shift < 0 ? -1 : 0)) * 12 + s[n % 7] + c
}

/**
 * A bass pitch kept off a semitone clash with the chord sounding: moved (two semitones at most)
 * to a chord tone, the chord's root first.
 */
export function fitPitch(h: Harmony, pitch: number, beat: number, root: number): number {
  const sounding = soundingAt(h, beat)
  if (!sounding.size || sounding.has(pc(pitch))) return pitch
  if (!sounding.has(pc(pitch + 1)) && !sounding.has(pc(pitch - 1))) return pitch
  const options = [0, -1, 1, -2, 2].map((d) => pitch + d).filter((p) => sounding.has(pc(p)))
  return options.find((p) => pc(p) === pc(root)) ?? options[0] ?? pitch
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
 * How well a keys part's harmony fits a bassline's roots: per half bar, the bass on the chord's
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

const MINOR_NAMES: Record<number, string> = { 0: 'i', 2: 'ii°', 3: 'III', 5: 'iv', 7: 'v', 8: 'VI', 10: 'VII', 11: 'vii°' }
const MAJOR_NAMES: Record<number, string> = { 0: 'I', 2: 'ii', 4: 'iii', 5: 'IV', 7: 'V', 9: 'vi', 10: 'bVII', 11: 'vii°' }

/** "i – VI – VII – i": the chords bar by bar (a bar that changes halfway shows both, "VI/VII"). */
export function progressionName(h: Harmony): string {
  const names = h.minor ? MINOR_NAMES : MAJOR_NAMES
  const name = (r: number) => names[pc(r)] ?? `${pc(r)}`
  const bars: string[] = []
  for (let b = 0; b < h.bars; b++) {
    const [x, y] = [h.roots[b * 2], h.roots[b * 2 + 1]]
    bars.push(x === y ? name(x) : `${name(x)}/${name(y)}`)
  }
  return bars.join(' – ')
}
