// Best of several (SCOPE.md §6.6, "Best of N"): a new track is made a few times from seeds of its
// own, each one listened back to (the critic), scored, and the best is the one you hear. A
// generation takes about 10 ms, so a dozen fit well inside a second.
//
// The score, 0…100, from what is measured before anything is rendered:
// - clashes: the critic's penalty (loops covering each other, a kick inside a loop), after its fixes;
// - interlock: how little the loops that play together in the drops land on the same 16ths;
// - palette: how well the drum samples sit in the track's palette (palette.ts);
// - the drops landing, predicted: every lane's loudness (its clips' measured energy, its level and
//   volume) over each drop's first 8 bars against the 8 before; a drop lands from 1 LU up, and a
//   lift of 3 LU or more counts in full (the pre-flight's check, made on the plan instead of the render).
// Unmeasured parts count as halfway. The same seed and library give the same candidates and the
// same pick; the generation keeps its own seed, so typing that seed makes exactly it again.

import type { SampleListItem } from '../types/api'
import type { Clip, Project } from '../types/project'
import { clipPower, punchRefs, type PunchRefs } from './balance'
import { critique, penalty } from './critic'
import type { Generation } from './generator'
import { NEUTRAL, paletteFit, paletteRefs, type Palette, type PaletteRefs } from './palette'

/** Candidates per new track. */
export const CANDIDATES = 12
/** A drop lands from this lift (LU); this much counts in full. */
export const LANDS_LU = 1
const FULL_LIFT_LU = 3
/** Bars of a drop's start, and before it, that are compared. */
const LIFT_BARS = 8
/** The parts' weights in the score. */
const W = { clash: 0.35, interlock: 0.2, palette: 0.2, drops: 0.25 }
/** Drum picks whose palette is scored. */
const PALETTE_ROLES = ['kick', 'clap', 'hats', 'perc', 'top', 'groove'] as const

export interface Score {
  /** 0…100. */
  total: number
  /** The critic's penalty (0: nothing wrong). */
  clash: number
  /** 0…1, null with fewer than two measured loops playing together. */
  interlock: number | null
  /** 0…1, null with nothing measured. */
  palette: number | null
  /** Each drop's predicted lift over the 8 bars before it (LU), by its bar. */
  lifts: { bar: number; lu: number }[]
  /** How many tracks it was the best of (1: made as it came). */
  of: number
}

/** Mean square of a lane's clips over [from, to) beats (silence counts as silence); null when nothing there is measured. */
function windowPower(clips: Clip[], samples: Map<string, SampleListItem>, bpm: number, from: number, to: number, punch: PunchRefs): number | null {
  let acc = 0
  let measured = false
  for (const c of clips) {
    const d = Math.max(0, Math.min(to, c.start + c.length) - Math.max(from, c.start))
    if (d <= 0) continue
    const p = clipPower(c, samples.get(c.sample.relPath), bpm, punch)
    if (p == null) continue
    measured = true
    acc += p * d
  }
  return measured ? acc / (to - from) : null
}

/** The drops' lifts as planned: every audible lane's power over a drop's first bars against the bars before. */
export function predictedLifts(project: Project, sections: Generation['sections'], samples: Map<string, SampleListItem>, punch: PunchRefs): { bar: number; lu: number }[] {
  const byLane = new Map<string, Clip[]>()
  for (const c of project.clips) byLane.set(c.laneId, [...(byLane.get(c.laneId) ?? []), c])
  const out: { bar: number; lu: number }[] = []
  for (const s of sections) {
    if (s.kind !== 'drop' || s.start < LIFT_BARS) continue
    const n = Math.min(LIFT_BARS, s.bars)
    const at = (a: number, z: number) => project.lanes.reduce((sum, l) => {
      if (l.mute) return sum
      const p = windowPower(byLane.get(l.id) ?? [], samples, project.bpm, a * 4, z * 4, punch)
      return sum + (p ?? 0) * 10 ** (((l.levelDb ?? 0) + l.volumeDb) / 10)
    }, 0)
    const before = at(s.start - n, s.start)
    const after = at(s.start, s.start + n)
    if (before > 0 && after > 0) out.push({ bar: s.start, lu: Math.round(10 * Math.log10(after / before) * 10) / 10 })
  }
  return out
}

/** Shared per library: what the palette and the punch are measured against. */
export interface ScoreRefs { palette: PaletteRefs; punch: PunchRefs; byPath: Map<string, SampleListItem> }

export function scoreRefs(all: SampleListItem[]): ScoreRefs {
  return { palette: paletteRefs(all), punch: punchRefs(all), byPath: new Map(all.map((s) => [s.rel_path, s])) }
}

export function scoreGeneration(all: SampleListItem[], g: Generation, refs: ScoreRefs = scoreRefs(all), of = 1): Score {
  const c = critique(all, g)
  const clash = Math.round(penalty(c) * 100) / 100
  const interlock = c.pairs.length ? 1 - c.pairs.reduce((n, p) => n + p.stack, 0) / c.pairs.length : null
  const pal = g.rules.palette as Palette | undefined
  const fits = pal ? PALETTE_ROLES.map((r) => g.picks[r]).filter((s): s is SampleListItem => !!s)
    .map((s) => paletteFit(s, pal, refs.palette)).filter((f) => f !== NEUTRAL) : []
  const palette = fits.length ? fits.reduce((a, b) => a + b, 0) / fits.length : null
  const lifts = predictedLifts(g.project, g.sections, refs.byPath, refs.punch)
  const drops = lifts.length
    ? lifts.reduce((n, l) => n + (l.lu < LANDS_LU ? 0 : 0.5 + 0.5 * Math.min(1, l.lu / FULL_LIFT_LU)), 0) / lifts.length : NEUTRAL
  const total = 100 * (W.clash / (1 + clash) + W.interlock * (interlock ?? NEUTRAL) + W.palette * (palette ?? NEUTRAL) + W.drops * drops)
  const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100)
  return { total: Math.round(total * 10) / 10, clash, interlock: r2(interlock), palette: r2(palette), lifts, of }
}

/** The seeds of a new track's candidates: its own first, then ones derived from it. */
export function candidateSeeds(seed: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i === 0 ? seed : (Math.imul(seed ^ (i * 0x9e3779b1), 0x85ebca6b) >>> 1) % 2 ** 31))
}

/**
 * The best of `n` candidates, one step at a time (a step makes and scores one candidate), so a
 * caller can give the screen and the audio a moment between them. `make(seed)` makes a candidate
 * (the generator and the critic). The winner carries its score and the line saying so.
 */
export function* bestOfSteps(all: SampleListItem[], seed: number, n: number, make: (seed: number) => Generation): Generator<void, Generation> {
  const refs = scoreRefs(all)
  let best: { g: Generation; s: Score } | null = null
  for (const s of candidateSeeds(seed, Math.max(1, n))) {
    const g = make(s)
    const sc = scoreGeneration(all, g, refs, n)
    if (!best || sc.total > best.s.total) best = { g, s: sc }
    yield
  }
  const { g, s } = best!
  g.score = s
  if (n > 1) g.choices.splice(g.template ? 1 : 0, 0, scoreLine(s))
  return g
}

/** The best of `n` at once. */
export function bestOf(all: SampleListItem[], seed: number, n: number, make: (seed: number) => Generation): Generation {
  const it = bestOfSteps(all, seed, n, make)
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
  }
}

/** "best of 12 (score 78): no clashes, loops interlock 0.81, palette 0.74, every drop lands (+3.2 LU)". */
export function scoreLine(s: Score): string {
  const landed = s.lifts.filter((l) => l.lu >= LANDS_LU).length
  const lift = s.lifts.length ? Math.min(...s.lifts.map((l) => l.lu)) : null
  const parts = [
    s.clash ? `clashes ${s.clash}` : 'no clashes',
    s.interlock != null ? `loops interlock ${s.interlock.toFixed(2)}` : null,
    s.palette != null ? `palette ${s.palette.toFixed(2)}` : null,
    s.lifts.length ? (landed === s.lifts.length ? `every drop lands (+${lift!.toFixed(1)} LU at least)` : `${landed} of ${s.lifts.length} drops land`) : null,
  ].filter(Boolean)
  return `best of ${s.of} (score ${Math.round(s.total)}): ${parts.join(', ')}`
}
