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
/** A rendered bass, strings or vocal part (the engine renders them at −14 LUFS: stereo, so −3 dB in mono). */
const RENDER_LEVEL_DB = -17
/** A lane's level moves at most this far either way (a mismeasured sample can't blow up the mix). */
const MAX_LEVEL_DB = 18
/** A part's reference balance needs this many of the user's tracks; fewer, and the default stands. */
const MIN_REFERENCES = 3

/** The engine's part of each lane (its arrangement parts); lanes without one keep the default. */
export const PART: Partial<Record<Role, string>> = {
  kick: 'kick', clap: 'clap', clap2: 'clap', clap3: 'clap', hats: 'hats', hats2: 'hats', ride: 'ride',
  perc: 'perc', perc2: 'perc', top: 'top', top2: 'top', top3: 'top', top4: 'top', groove: 'top',
  bass: 'bass', stab: 'music', stab2: 'music', stab3: 'music', crash: 'crash', fills: 'fills', fx: 'fx', fx2: 'fx',
}

/** House defaults (dB against the kick, all of a part's lanes together). */
const DEFAULT_DB: Record<string, number> = {
  clap: -4, hats: -10, ride: -12, perc: -10, top: -7, bass: -2, music: -8, crash: -12, fills: -6, fx: -9,
  hits: -8, atmos: -14, disco: -7, buildup: -9, strings: -18, pad: -11, bed: -26, vocal: -3, vchop: -6,
}

/** The lanes that sound together as one part: their sum sits where the part does. */
export const GROUP: Partial<Record<Role, Role>> = {
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

/** The window the engine measures a sample's punch over (seconds; config.py `punch_window_ms`). */
const PUNCH_WINDOW_S = 0.2
/**
 * How much of a hit's punch counts in the balance: loudness is measured as the references' is (the
 * average over the bar), and a hit that is snappier than is usual for its kind sounds louder than
 * that says, a washier one quieter. Half of the difference is taken (a nudge: the average still leads).
 */
const PUNCH_WEIGHT = 0.5
/** The most a hit's punch moves its level either way (dB). */
const MAX_PUNCH_DB = 4
/** A kind of one-shot's usual compactness needs this many measured samples. */
const MIN_PUNCH_SAMPLES = 4

/**
 * How compact a sample is (dB, 0 at most): its punch against its whole energy played within the
 * punch window. 0: all of it within 200 ms (a snappy hit); −6: spread over four times that.
 * Null when not measured.
 */
export function compactness(s: Pick<SampleListItem, 'energy_db' | 'punch_db'> | undefined): number | null {
  if (s?.energy_db == null || s.punch_db == null || s.energy_db <= -200 || s.punch_db <= -200) return null
  return Math.min(0, s.punch_db - (s.energy_db - 10 * Math.log10(PUNCH_WINDOW_S)))
}

/** What is usual for each kind of one-shot in the library: the median compactness per category. */
export type PunchRefs = Map<string, number>

export function punchRefs(samples: Iterable<SampleListItem>): PunchRefs {
  const by = new Map<string, number[]>()
  for (const s of samples) {
    const c = s.kind === 'oneshot' ? compactness(s) : null
    if (c == null) continue
    if (!by.has(s.category)) by.set(s.category, [])
    by.get(s.category)!.push(c)
  }
  const out: PunchRefs = new Map()
  for (const [cat, xs] of by) if (xs.length >= MIN_PUNCH_SAMPLES) out.set(cat, median(xs))
  return out
}

/** dB a one-shot counts louder (snappier than usual for its kind) or quieter (washier) than its average says. */
export function punchDb(s: SampleListItem | undefined, refs?: PunchRefs): number {
  const c = compactness(s)
  const ref = s && refs?.get(s.category)
  if (c == null || ref == null) return 0
  return Math.max(-MAX_PUNCH_DB, Math.min(MAX_PUNCH_DB, PUNCH_WEIGHT * (c - ref)))
}

/**
 * Mean square (linear) of a clip while it plays, before the lane; null when its sample isn't
 * measured. With `punch`, a one-shot pattern counts for how hard its sample hits too.
 */
export function clipPower(c: Clip, s: SampleListItem | undefined, bpm: number, punch?: PunchRefs): number | null {
  const gain = 10 ** (((c.gainDb ?? 0) + (c.gainTo ?? c.gainDb ?? 0)) / 20)
  if (c.type === 'audio' && c.bass) return 10 ** (RENDER_LEVEL_DB / 10) * gain
  const e = s?.energy_db
  if (e == null || e <= -200) return null
  const energy = 10 ** (e / 10)
  if (c.type === 'pattern') {
    const hits = c.steps.reduce<number>((n, v) => n + VELOCITY_GAIN[v] ** 2, 0)
    return (energy * hits) / beatToSec(c.patternBars * BEATS_PER_BAR, bpm) * gain * 10 ** (punchDb(s, punch) / 10)
  }
  const seconds = Math.max(0.05, s!.duration_s)
  // A loop plays its energy every time round; an event or a one-shot once, over what of it is heard.
  if (s!.kind === 'loop') return (energy / seconds) * gain
  return (energy / Math.min(seconds, Math.max(0.05, beatToSec(c.length, bpm)))) * gain
}

/** A lane's loudness (dB) where it plays in [ranges] beats (else wherever it plays); null when nothing on it is measured. */
export function laneLoudness(clips: Clip[], samples: Map<string, SampleListItem>, bpm: number, ranges: [number, number][], punch?: PunchRefs): number | null {
  const over = (c: Clip) => ranges.reduce((n, [a, z]) => n + Math.max(0, Math.min(z, c.start + c.length) - Math.max(a, c.start)), 0)
  const inRanges = clips.some((c) => over(c) > 0)
  let acc = 0
  let dur = 0
  for (const c of clips) {
    const d = inRanges ? over(c) : c.length
    if (d <= 0) continue
    const p = clipPower(c, samples.get(c.sample.relPath), bpm, punch)
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
 * these lanes (the rest keep theirs). `hitsOnly`: just the lanes levelled hit for hit, against the
 * clap and kick as they are now (after the mix check moved them). The number of lanes levelled
 * from their measured samples.
 */
export function levelLanes(project: Project, samples: Map<string, SampleListItem>, balance: Balance, drops: [number, number][],
                           roleOf: (laneName: string) => Role | undefined, starting: (role: Role) => number, only?: Set<string>, punch?: PunchRefs,
                           hitsOnly = false): number {
  const roles = new Map(project.lanes.map((l) => [l.id, roleOf(l.name)]))
  const present = new Set([...roles.values()].filter((r): r is Role => !!r))
  const partOf = (r: Role) => PART[r] ?? (GROUP[r] ?? r)
  // Layers sound together: each sits its starting step under the lane it layers, all of them
  // together where the part does.
  let measured = 0
  const together = (head: Role) => 10 * Math.log10([...present].filter((r) => (GROUP[r] ?? r) === head)
    .reduce((n, r) => n + 10 ** ((starting(r) - starting(head)) / 10), 0) || 1)
  /** A lane's main sample (the one on most of its clips), and one hit of it as the lane plays it (its level on top). */
  const mainOf = (laneId: string) => {
    const n = new Map<string, number>()
    for (const c of project.clips) {
      if (c.laneId === laneId && !(c.type === 'audio' && c.bass)) n.set(c.sample.relPath, (n.get(c.sample.relPath) ?? 0) + c.length)
    }
    const path = [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    return path ? samples.get(path) : undefined
  }
  const laneOf = (r: Role) => project.lanes.find((l) => roles.get(l.id) === r)
  const hitOf = (r: Role) => {
    const lane = laneOf(r)
    const loud = lane && hitLoudness(mainOf(lane.id))
    return lane && loud != null ? loud + (lane.levelDb ?? 0) : null
  }
  for (const lane of hitsOnly ? [] : project.lanes) {
    if (only && !only.has(lane.id)) continue
    const role = roles.get(lane.id)
    if (!role || HIT_DB[role] != null) continue
    const loud = laneLoudness(project.clips.filter((c) => c.laneId === lane.id), samples, project.bpm, drops, punch)
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
  // Hit for hit (after the lanes they go by): stabs, and the moments (disco hits, fills, impacts,
  // crashes, FX). Each hit as loud as the clap's hits less its part's step (else under the kick's),
  // and never above the kick; how many hits a bar has doesn't come into it. A lane that plays
  // several samples (the fills, the FX) gets each one trimmed on its clips to the main one's hits.
  const clap = hitOf('clap')
  const kick = hitOf('kick')
  const ceiling = (laneOf('kick')?.levelDb ?? MAX_LEVEL_DB) - STAB_UNDER_KICK_DB
  for (const lane of project.lanes) {
    if (only && !only.has(lane.id)) continue
    const role = roles.get(lane.id)
    const step = role && HIT_DB[role]
    if (!role || step == null) continue
    const main = mainOf(lane.id)
    const own = hitLoudness(main)
    const want = clap != null ? clap + step : kick != null ? kick + step + (STAB_VS_KICK_DB - STAB_VS_CLAP_DB) : null
    if (own == null || want == null) {
      lane.levelDb = starting(role)
      continue
    }
    measured++
    // Fills: never louder than the kick's hits (a fill sample is often much quieter than a kick
    // sample, so it may take more gain than the kick's lane); the others never past the kick's gain.
    const loudCap = role === 'fills' && kick != null
    const cap = loudCap ? kick! - FILL_UNDER_KICK_DB - own : ceiling
    lane.levelDb = Math.round(Math.max(-MAX_LEVEL_DB, Math.min(MAX_LEVEL_DB, cap, want - own)) * 2) / 2
    if (!TRIMMED.has(role)) continue
    for (const c of project.clips) {
      if (c.laneId !== lane.id || c.type !== 'audio' || c.bass) continue
      const h = hitLoudness(samples.get(c.sample.relPath))
      // Its own hits at the main sample's level, and with that never above the kick either.
      const over = h == null ? 0 : loudCap ? kick! - FILL_UNDER_KICK_DB - h - lane.levelDb : ceiling - lane.levelDb
      const trim = h == null ? 0 : Math.max(-MAX_TRIM_DB, Math.min(MAX_TRIM_DB, own - h, over))
      const was = c.gainDb
      c.gainDb = Math.round(trim * 2) / 2 || 0
      if (c.gainTo != null) c.gainTo += c.gainDb - was
    }
  }
  return measured
}

/**
 * A stab hits as hard as the clap's hits (dB; the accents of the track); without a measured clap,
 * this much under the kick's. Never past the kick's own gain less this.
 */
export const STAB_VS_CLAP_DB = 0
export const STAB_VS_KICK_DB = -6
export const STAB_UNDER_KICK_DB = 1
/** A fill's hits stay this far under the kick's hits (dB): loudness against loudness, not gain against gain. */
export const FILL_UNDER_KICK_DB = 1
/**
 * The lanes levelled hit for hit, and how far under the clap's hits one of theirs sits (dB): the
 * stabs and the moments. Few, short sounds: an average over the bar (how the references' parts are
 * measured) says nothing of how loud each one is, and turned a lone disco hit or a short fill far up.
 */
export const HIT_DB: Partial<Record<Role, number>> = {
  stab: STAB_VS_CLAP_DB, stab2: STAB_VS_CLAP_DB, stab3: STAB_VS_CLAP_DB,
  disco: -1, disco2: -1, fills: -1, hits: -2, crash: -6, fx: -5, fx2: -7,
}
/** The lanes whose clips play different samples, each trimmed to the lane's main one (dB at most). */
const TRIMMED = new Set<Role>(['fills', 'hits', 'fx', 'fx2'])
const MAX_TRIM_DB = 9

/**
 * How loud one hit of a sample is (dB, as LUFS): its punch (the loudest 200 ms); before that is
 * measured, its energy over its length (200 ms at least). Null when not measured at all.
 */
export function hitLoudness(s: Pick<SampleListItem, 'energy_db' | 'punch_db' | 'duration_s'> | undefined): number | null {
  if (!s) return null
  if (s.punch_db != null && s.punch_db > -200) return s.punch_db
  if (s.energy_db == null || s.energy_db <= -200) return null
  return s.energy_db - 10 * Math.log10(Math.max(PUNCH_WINDOW_S, s.duration_s))
}

/** The lanes whose samples are evened out: the drums (FX, fills and hits are moments, each its own sound). */
const EVEN_ROLES = new Set<Role>(['kick', 'clap', 'clap2', 'clap3', 'hats', 'hats2', 'ride', 'perc', 'perc2', 'top', 'top2', 'top3', 'top4', 'groove'])
/** The most a sample is trimmed to its lane's main one (dB), and the least worth doing. */
const MAX_EVEN_DB = 6
const MIN_EVEN_DB = 0.5

/**
 * Even levels within a lane (SCOPE.md §6.6): a drum lane that plays more than one sample (the
 * groove swapped in a later drop, a loop switched halfway) gets each other sample trimmed, on its
 * clips, to the loudness of the lane's main one (the one that plays longest in the drops), so the
 * change of sample isn't a jump in level. Measured on clips playing plainly (no ride, no filter).
 * Doing it again changes nothing. The number of samples trimmed.
 */
export function evenClips(project: Project, samples: Map<string, SampleListItem>, drops: [number, number][],
                          roleOf: (laneName: string) => Role | undefined, only?: Set<string>, punch?: PunchRefs): number {
  const over = (c: Clip) => drops.reduce((n, [a, z]) => n + Math.max(0, Math.min(z, c.start + c.length) - Math.max(a, c.start)), 0)
  let trimmed = 0
  for (const lane of project.lanes) {
    const role = roleOf(lane.name)
    if (!role || !EVEN_ROLES.has(role) || (only && !only.has(lane.id))) continue
    const clips = project.clips.filter((c) => c.laneId === lane.id && !(c.type === 'audio' && c.bass))
    const by = new Map<string, { clips: Clip[]; loud: number | null; inDrops: number; type: string }>()
    for (const c of clips) {
      const id = `${c.type}|${c.sample.relPath}`
      if (!by.has(id)) by.set(id, { clips: [], loud: null, inDrops: 0, type: c.type })
      const x = by.get(id)!
      x.clips.push(c)
      x.inDrops += over(c)
    }
    for (const x of by.values()) {
      const plain = x.clips.filter((c) => c.gainTo == null && !c.filter)
      x.loud = laneLoudness(plain, samples, project.bpm, [], punch)
    }
    const measured = [...by.values()].filter((x) => x.loud != null)
    if (measured.length < 2) continue
    const main = measured.reduce((a, b) => (b.inDrops > a.inDrops ? b : a))
    for (const x of measured) {
      // One-shot patterns and loops aren't compared with each other: a pattern's loudness is its steps'.
      if (x === main || x.type !== main.type) continue
      const d = Math.round(Math.max(-MAX_EVEN_DB, Math.min(MAX_EVEN_DB, main.loud! - x.loud!)) * 2) / 2
      if (Math.abs(d) < MIN_EVEN_DB) continue
      for (const c of x.clips) {
        c.gainDb += d
        if (c.gainTo != null) c.gainTo += d
      }
      trimmed++
    }
  }
  return trimmed
}

/** The drops of a structure, in beats. */
export function dropRanges(sections: { kind: string; start: number; bars: number }[]): [number, number][] {
  return sections.filter((s) => s.kind === 'drop').map((s) => [s.start * BEATS_PER_BAR, (s.start + s.bars) * BEATS_PER_BAR])
}
