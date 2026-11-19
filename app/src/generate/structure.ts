// Arrangement structure (SCOPE.md §6.6): a sequence of sections drawn from weighted rules,
// then fitted to the target length. Every section is a whole number of 8-bar phrases. The
// only hard rules are the DJ ones: a mix-in intro and a mix-out outro of at least 16 bars.

import type { Rng } from './rng'

export type SectionKind = 'intro' | 'build' | 'drop' | 'break' | 'outro'

/** What the kick does in a breakdown. */
export type KickMode = 'out' | 'filtered' | 'sweep' | 'thin' | 'downbeats' | 'kept'

/** How a build brings the elements in. */
export type BuildStyle = 'layered' | 'all' | 'doubletime' | 'filter'

export interface Section {
  kind: SectionKind
  label: string
  start: number          // bars from the start of the track
  bars: number
  kick?: KickMode        // breaks
  build?: BuildStyle     // builds
  long?: boolean         // the longer breakdown
  switchHalfway?: boolean // drops: tops/groove change in the middle
  peak?: boolean         // the last drop
  /** From a real track: its source code and the bars [from, to) of it this section stands for (its rides). */
  src?: { code: string; from: number; to: number }
}

export const PHRASE = 8
/** A round: what a section is counted in (16 bars, two phrases). */
export const ROUND = 16

/**
 * Where a section of `bars` changes halfway (bars from its start): on a round's line where one falls
 * inside it (the nearest its middle; of two as near, the earlier: a 48-bar drop changes after 16 and
 * goes on for 32, never 24 and 24), else on a phrase's line (the nearest its middle), else its
 * middle.
 */
export function halfwayBars(bars: number): number {
  for (const step of [ROUND, PHRASE]) {
    let best = 0
    for (let at = step; at < bars; at += step) if (!best || Math.abs(at - bars / 2) < Math.abs(best - bars / 2)) best = at
    if (best) return best
  }
  return bars / 2
}
const MIN_DJ = 16

export const LIMITS: Record<SectionKind, [number, number]> = {
  intro: [16, 32], outro: [16, 32], build: [8, 32], drop: [16, 48], break: [8, 32],
}

export const KICK_MODE_LABEL: Record<KickMode, string> = {
  out: 'no kick', filtered: 'filtered kick', sweep: 'kick filter sweep', thin: 'high-passed kick',
  downbeats: 'kick on the one', kept: 'kick kept',
}

export const BUILD_LABEL: Record<BuildStyle, string> = {
  layered: 'layered build', all: 'everything at once', doubletime: 'double-time build', filter: 'filter build',
}

export function pickKickMode(rng: Rng): KickMode {
  // Low-passed kicks are kept rare; a thin high-passed kick is the more common filtered one. A kick
  // plays four to the floor or not at all: never only on the 1 of each bar ('downbeats' is no
  // longer drawn; tracks made with it keep it).
  return rng.weighted([['out', 6.5], ['thin', 2.5], ['filtered', 1], ['sweep', 1], ['kept', 1]])
}

/** The big breakdown's kick: a break from the track, a real cooldown, so mostly out. */
export function pickLongKickMode(rng: Rng): KickMode {
  return rng.weighted([['out', 8], ['sweep', 1], ['thin', 1]])
}

/** The short breakdowns' kick (one for all of them): more drums, the groove kept going. */
export function pickShortKickMode(rng: Rng): KickMode {
  return rng.weighted([['thin', 4], ['out', 3], ['kept', 2], ['filtered', 1], ['sweep', 1]])
}

export function pickBuildStyle(rng: Rng): BuildStyle {
  return rng.weighted([['layered', 4], ['all', 1.5], ['doubletime', 3], ['filter', 2]])
}

/** Bars for a length in minutes at `bpm`, in whole phrases. */
export function barsFor(minutes: number, bpm: number): number {
  return Math.max(PHRASE * 8, Math.round((minutes * bpm) / 4 / PHRASE) * PHRASE)
}

export function makeStructure(rng: Rng, targetBars: number): Section[] {
  const intro = rng.weighted([[16, 3], [24, 1], [32, 3]] as const)
  const outro = rng.chance(0.6) ? intro : rng.weighted([[16, 1], [24, 1], [32, 1]] as const)
  const drops = rng.weighted([[2, 3], [3, 5], [4, 1]] as const)
  const s: Omit<Section, 'start' | 'label'>[] = [{ kind: 'intro', bars: intro }]
  if (rng.chance(0.85)) {
    s.push({ kind: 'build', bars: rng.weighted([[8, 1], [16, 3], [24, 1], [32, 1]] as const), build: pickBuildStyle(rng) })
  }
  for (let i = 0; i < drops; i++) {
    s.push({ kind: 'drop', bars: rng.weighted([[16, 2], [24, 1], [32, 4], [48, 1]] as const), switchHalfway: rng.chance(0.3) })
    if (i === drops - 1) break
    s.push({ kind: 'break', bars: rng.weighted([[8, 2], [16, 4], [24, 1]] as const), kick: pickKickMode(rng) })
  }
  s[s.length - 1].peak = true
  s.push({ kind: 'outro', bars: outro })

  // One breakdown is the big one (SCOPE.md §6.6): a break from the track, the pad and a real
  // cooldown; usually the last (the classic shape), sometimes another. The others are shorter
  // copies of it with more drums, the groove kept going: one kick treatment for all of them.
  const breaks = s.filter((x) => x.kind === 'break')
  if (breaks.length) {
    const long = rng.chance(0.8) ? breaks[breaks.length - 1] : rng.pick(breaks)
    const short = pickShortKickMode(rng)
    for (const b of breaks) if (b !== long) { b.bars = rng.weighted([[8, 3], [16, 2]] as const); b.kick = short }
    long.long = true
    long.kick = pickLongKickMode(rng)
    long.bars = Math.min(32, Math.max(16, ...breaks.filter((b) => b !== long).map((b) => b.bars + PHRASE), long.bars))
  }
  fit(rng, s, targetBars)
  return layout(s)
}

/** Sections in order with their start bars and names ("Drop 2"). */
export function layout(s: Omit<Section, 'start' | 'label'>[]): Section[] {
  let start = 0
  const counts: Partial<Record<SectionKind, number>> = {}
  return s.map((x) => {
    counts[x.kind] = (counts[x.kind] ?? 0) + 1
    const out = { ...x, start, label: label(x.kind, counts[x.kind]!, s.filter((y) => y.kind === x.kind).length) }
    start += x.bars
    return out
  })
}

function label(kind: SectionKind, n: number, total: number): string {
  const name = { intro: 'Intro', build: 'Build', drop: 'Drop', break: 'Break', outro: 'Outro' }[kind]
  return total > 1 ? `${name} ${n}` : name
}

/** Stretch or shrink flexible sections by whole phrases until the total is `target` bars. */
export function fit(rng: Rng, s: Omit<Section, 'start' | 'label'>[], target: number): void {
  const total = () => s.reduce((n, x) => n + x.bars, 0)
  const longBreak = s.find((x) => x.long)
  const otherBreakMax = () => Math.max(0, ...s.filter((x) => x.kind === 'break' && x !== longBreak).map((x) => x.bars))
  for (let guard = 0; guard < 200 && total() !== target; guard++) {
    const grow = total() < target
    const cands = s.filter((x) => {
      const [lo, hi] = LIMITS[x.kind]
      if (x.kind === 'intro' || x.kind === 'outro') return false
      if (!grow && x === longBreak && x.bars - PHRASE <= otherBreakMax()) return false  // stays the longest
      if (grow && x.kind === 'break' && x !== longBreak && longBreak && x.bars + PHRASE >= longBreak.bars) return false
      return grow ? x.bars + PHRASE <= hi : x.bars - PHRASE >= lo
    })
    if (!cands.length) {
      if (!grow) {
        // Too long even at minimum lengths: drop the last break + drop pair.
        // (A short one, so the big breakdown stays.)
        const kinds = s.map((x) => (x.kind === 'break' && !x.long ? 'short' : x.kind))
        const i = kinds.lastIndexOf('short') > 0 ? kinds.lastIndexOf('short') : kinds.lastIndexOf('break')
        if (i <= 0 || s.filter((x) => x.kind === 'drop').length <= 2) break
        s.splice(i, 2)
        s.filter((x) => x.kind === 'drop').at(-1)!.peak = true
        continue
      }
      // Too short at maximum lengths: let the intro/outro run longer (still DJ friendly).
      const io = s.filter((x) => (x.kind === 'intro' || x.kind === 'outro') && x.bars < 48)
      if (!io.length) break
      rng.pick(io).bars += PHRASE
      continue
    }
    const x = rng.pickBy(cands, (c) => (c.kind === 'drop' ? 3 : c.kind === 'build' ? 1.2 : 1))
    x.bars += grow ? PHRASE : -PHRASE
  }
  for (const x of s) if ((x.kind === 'intro' || x.kind === 'outro') && x.bars < MIN_DJ) x.bars = MIN_DJ
}
