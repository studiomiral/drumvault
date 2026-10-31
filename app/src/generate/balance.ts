// The generated mix's balance (SCOPE.md §6.6): every lane brought to its place against the kick,
// whatever its samples' own levels (the library normalises peaks, not loudness). How loud each
// part sits is the producers' balance in the user's own tracks (the engine's `levels`: each
// part's loudness in its full bars), else a house default. A lane's loudness is worked out from
// its clips where it plays in drops (else wherever it plays): the samples' measured energy, the
// steps and velocities of its patterns, its clip gains. Measured on the mono mix, K-weighted
// (as LUFS, ungated), the same way the engine measures the references.

import type { SampleListItem, TrackArrangement } from '../types/api'
import type { Clip, Project } from '../types/project'
import { BEATS_PER_BAR, beatToSec, VELOCITY_GAIN } from '../lib/project'
import type { Role } from './generator'

/**
 * Where the kick sits (dB, the mono measure): the level the rest is balanced against. Set so a
 * balanced mix is as loud overall as the starting mix was before balancing (median over the
 * user's library), so only the balance changes, not the headroom.
 */
export const KICK_LEVEL_DB = -17.5
/** A rendered bass, keys or stab part (the engine renders them at −14 LUFS: stereo, so −3 dB in mono). */
const RENDER_LEVEL_DB = -17
/** A lane's level moves at most this far either way (a mismeasured sample can't blow up the mix). */
const MAX_LEVEL_DB = 18
/** A part's reference balance needs this many of the user's tracks; fewer, and the default stands. */
const MIN_REFERENCES = 3

/** The engine's part of each lane (its arrangement parts); lanes without one keep the default. */
const PART: Partial<Record<Role, string>> = {
  kick: 'kick', clap: 'clap', clap2: 'clap', clap3: 'clap', hats: 'hats', hats2: 'hats', ride: 'ride',
  perc: 'perc', perc2: 'perc', top: 'top', top2: 'top', top3: 'top', top4: 'top', groove: 'top',
  bass: 'bass', keys: 'music', stab: 'music', crash: 'crash', fills: 'fills', fx: 'fx', fx2: 'fx',
}

/** House defaults (dB against the kick, all of a part's lanes together). */
const DEFAULT_DB: Record<string, number> = {
  clap: -4, hats: -10, ride: -12, perc: -10, top: -7, bass: -2, music: -8, crash: -12, fills: -6, fx: -9,
  hits: -8, atmos: -14, disco: -7, buildup: -9,
}

/** The lanes that sound together as one part: their sum sits where the part does. */
const GROUP: Partial<Record<Role, Role>> = {
  clap2: 'clap', clap3: 'clap', hats2: 'hats', perc2: 'perc', top2: 'top', top3: 'top', top4: 'top', groove: 'top',
  fx2: 'fx', disco2: 'disco',
}

/** A balance: dB against the kick per part, and how many of the user's tracks it comes from. */
export interface Balance {
  db: Record<string, number>
  tracks: number
}

/**
 * The producers' balance from the user's tracks: per part, the median of its level against the
 * kick's (tracks whose stems were normalised one by one don't count), over the house defaults.
 */
export function balanceFrom(arrangements: TrackArrangement[]): Balance {
  const refs = arrangements.filter((a) => a.levels && !a.levels.normalized && a.levels.parts.kick != null)
  const db = { ...DEFAULT_DB }
  for (const part of new Set(Object.values(PART))) {
    if (part === 'kick') continue
    const rel = refs.map((a) => a.levels!.parts[part]).flatMap((v, i) => (v == null ? [] : [v - refs[i].levels!.parts.kick]))
    if (rel.length >= MIN_REFERENCES) db[part] = Math.round(median(rel) * 2) / 2
  }
  return { db, tracks: refs.length }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Mean square (linear) of a clip while it plays, before the lane; null when its sample isn't measured. */
function clipPower(c: Clip, s: SampleListItem | undefined, bpm: number): number | null {
  const gain = 10 ** (((c.gainDb ?? 0) + (c.gainTo ?? c.gainDb ?? 0)) / 20)
  if (c.type === 'audio' && c.bass) return 10 ** (RENDER_LEVEL_DB / 10) * gain
  const e = s?.energy_db
  if (e == null || e <= -200) return null
  const energy = 10 ** (e / 10)
  if (c.type === 'pattern') {
    const hits = c.steps.reduce<number>((n, v) => n + VELOCITY_GAIN[v] ** 2, 0)
    return (energy * hits) / beatToSec(c.patternBars * BEATS_PER_BAR, bpm) * gain
  }
  const seconds = Math.max(0.05, s!.duration_s)
  // A loop plays its energy every time round; an event or a one-shot once, over what of it is heard.
  if (s!.kind === 'loop') return (energy / seconds) * gain
  return (energy / Math.min(seconds, Math.max(0.05, beatToSec(c.length, bpm)))) * gain
}

/** A lane's loudness (dB) where it plays in [ranges] beats (else wherever it plays); null when nothing on it is measured. */
export function laneLoudness(clips: Clip[], samples: Map<string, SampleListItem>, bpm: number, ranges: [number, number][]): number | null {
  const over = (c: Clip) => ranges.reduce((n, [a, z]) => n + Math.max(0, Math.min(z, c.start + c.length) - Math.max(a, c.start)), 0)
  const inRanges = clips.some((c) => over(c) > 0)
  let acc = 0
  let dur = 0
  for (const c of clips) {
    const d = inRanges ? over(c) : c.length
    if (d <= 0) continue
    const p = clipPower(c, samples.get(c.sample.relPath), bpm)
    if (p == null) continue
    acc += p * d
    dur += d
  }
  return dur > 0 && acc > 0 ? 10 * Math.log10(acc / dur) : null
}

/**
 * Each generated lane's level (`Lane.levelDb`): what brings it, with its slider at 0 dB, to its
 * place against the kick. `starting`: each lane's step in the starting mix (layers sit that much
 * under the lane they layer), and the level of a lane nothing on is measured for. `only`: just
 * these lanes (the rest keep theirs). The number of lanes levelled from their measured samples.
 */
export function levelLanes(project: Project, samples: Map<string, SampleListItem>, balance: Balance, drops: [number, number][],
                           roleOf: (laneName: string) => Role | undefined, starting: (role: Role) => number, only?: Set<string>): number {
  const roles = new Map(project.lanes.map((l) => [l.id, roleOf(l.name)]))
  const present = new Set([...roles.values()].filter((r): r is Role => !!r))
  const partOf = (r: Role) => PART[r] ?? (GROUP[r] ?? r)
  // Layers sound together: each sits its starting step under the lane it layers, all of them
  // together where the part does.
  let measured = 0
  const together = (head: Role) => 10 * Math.log10([...present].filter((r) => (GROUP[r] ?? r) === head)
    .reduce((n, r) => n + 10 ** ((starting(r) - starting(head)) / 10), 0) || 1)
  for (const lane of project.lanes) {
    if (only && !only.has(lane.id)) continue
    const role = roles.get(lane.id)
    if (!role) continue
    const loud = laneLoudness(project.clips.filter((c) => c.laneId === lane.id), samples, project.bpm, drops)
    if (loud == null) {
      lane.levelDb = starting(role)
      continue
    }
    measured++
    const head = GROUP[role] ?? role
    const part = partOf(role)
    const target = KICK_LEVEL_DB + (part === 'kick' ? 0 : balance.db[part] ?? 0) + (starting(role) - starting(head)) - together(head)
    const level = Math.max(-MAX_LEVEL_DB, Math.min(MAX_LEVEL_DB, target - loud))
    lane.levelDb = Math.round(level * 2) / 2
  }
  return measured
}

/** The drops of a structure, in beats. */
export function dropRanges(sections: { kind: string; start: number; bars: number }[]): [number, number][] {
  return sections.filter((s) => s.kind === 'drop').map((s) => [s.start * BEATS_PER_BAR, (s.start + s.bars) * BEATS_PER_BAR])
}
