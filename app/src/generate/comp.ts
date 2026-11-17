// The generated mix's compressors (SCOPE.md §6.6): almost every lane gets one, set as a producer
// would for its part. The kick is what everything else ducks to, and FX, fills, crashes, hits and
// build-ups are moments whose shape is the point, so they get none. Thresholds go from how loud the
// lane's sound is where it is loudest: a sample's `punch_db` (its loudest 200 ms) at its clip gain;
// the renders (bass, strings, ambience, vocals, pads) aren't measured, so they go from what their
// kind measures on the user's library. Settings measured there too (tests/bench/comp.test.ts): how
// much each takes off at the loudest hits, on average and in loudness, which the makeup gives
// back, so the balance stays where balance.ts puts it.

import type { SampleListItem } from '../types/api'
import type { Clip, LaneComp, Project } from '../types/project'
import { GROUP } from './balance'
import type { Role } from './generator'

/** What a part's compressor does. */
export interface RoleComp {
  /** The threshold against the lane's punch (its loudest 200 ms, dB). */
  overDb: number
  ratio: number
  kneeDb: number
  attackMs: number
  releaseBeats: number
  /** The loudness it takes off, given back (dB; measured on the user's library). */
  makeupDb: number
  /** What it is for, in a few words (the lane panel). */
  what: string
}

/**
 * Per part (a layer goes as its part: Clap 2 as the clap). A slow attack lets a hit's crack
 * through and brings its body up; a release of a 16th breathes with the groove.
 */
export const COMP_ROLES: Partial<Record<Role, RoleComp>> = {
  clap: { overDb: -5, ratio: 4, kneeDb: 6, attackMs: 20, releaseBeats: 0.15, makeupDb: 3, what: 'punch: the crack through, the body up' },
  hats: { overDb: -3, ratio: 2, kneeDb: 6, attackMs: 5, releaseBeats: 0.25, makeupDb: 2.5, what: 'levelled, breathing on the 16ths' },
  ride: { overDb: -5, ratio: 2, kneeDb: 6, attackMs: 8, releaseBeats: 0.25, makeupDb: 2, what: 'levelled, breathing on the 16ths' },
  perc: { overDb: -3, ratio: 2.5, kneeDb: 6, attackMs: 8, releaseBeats: 0.25, makeupDb: 3, what: 'levelled, breathing on the 16ths' },
  top: { overDb: -3.5, ratio: 2, kneeDb: 6, attackMs: 8, releaseBeats: 0.25, makeupDb: 2.5, what: 'levelled, breathing on the 16ths' },
  bass: { overDb: -4.5, ratio: 3, kneeDb: 6, attackMs: 10, releaseBeats: 0.25, makeupDb: 3, what: 'the notes evened out, so the line rolls' },
  stab: { overDb: -2, ratio: 2.5, kneeDb: 6, attackMs: 25, releaseBeats: 0.5, makeupDb: 2.5, what: 'steadier, the attack kept' },
  disco: { overDb: -2, ratio: 2.5, kneeDb: 6, attackMs: 25, releaseBeats: 0.5, makeupDb: 2.5, what: 'steadier, the attack kept' },
  strings: { overDb: -4, ratio: 3, kneeDb: 8, attackMs: 30, releaseBeats: 0.6, makeupDb: 2, what: 'levelled slowly: a bed' },
  vocal: { overDb: -7.5, ratio: 3, kneeDb: 6, attackMs: 10, releaseBeats: 0.2, makeupDb: 4, what: 'the phrase held at one level' },
}

/**
 * The renders' punch (dB as `punch_db`, at clip gain 0): what their kind measures on the user's
 * library (the bench), as they aren't measured one by one.
 */
export const RENDER_PUNCH_DB: Partial<Record<Role, number>> = { bass: -11, strings: -16.5, vocal: -13.5 }
/** A library sample not measured yet: its peak (as the library normalises it) less a usual crest (dB). */
const UNMEASURED_PUNCH_DB = { oneshot: -0.3 - 17.5, loop: -1 - 17.5, event: -1 - 17.5 }

/** How loud a clip's sound is where it is loudest, before its clip gain (dB as `punch_db`; null when nothing says). */
function clipPunchDb(c: Clip, s: SampleListItem | undefined, role: Role): number | null {
  if (c.sample.relPath.startsWith('.drumvault/') || (c.type === 'audio' && c.bass)) return RENDER_PUNCH_DB[GROUP[role] ?? role] ?? null
  return s?.punch_db ?? UNMEASURED_PUNCH_DB[c.sample.kind]
}

/**
 * How loud a lane's sound is where it is loudest, before its volume (dB as `punch_db`): its clips'
 * punch at their clip gain, the value most of its time in `ranges` (the drops) has, or most of its
 * time anywhere when it doesn't play there. Null without clips.
 */
export function laneLevelDb(clips: Clip[], samples: Map<string, SampleListItem>, ranges: [number, number][], role: Role): number | null {
  const weigh = (inRanges: boolean) => {
    const w = new Map<number, number>()
    for (const c of clips) {
      const d = inRanges ? ranges.reduce((n, [a, z]) => n + Math.max(0, Math.min(z, c.start + c.length) - Math.max(a, c.start)), 0) : c.length
      const punch = d > 0 ? clipPunchDb(c, samples.get(c.sample.relPath), role) : null
      if (punch == null) continue
      const db = Math.round((punch + c.gainDb) * 2) / 2
      w.set(db, (w.get(db) ?? 0) + d)
    }
    return w
  }
  let w = weigh(true)
  if (!w.size) w = weigh(false)
  let best: number | null = null
  for (const [db, d] of w) if (best == null || d > w.get(best)! || (d === w.get(best)! && db > best)) best = db
  return best
}

/** The compressor a lane of `role` gets over clips this loud (`laneLevelDb`); null for a part that gets none. */
export function roleComp(role: Role, levelDb: number): LaneComp | null {
  const s = COMP_ROLES[GROUP[role] ?? role]
  if (!s) return null
  return {
    thresholdDb: Math.round((levelDb + s.overDb) * 10) / 10, ratio: s.ratio, kneeDb: s.kneeDb,
    attackMs: s.attackMs, releaseBeats: s.releaseBeats, makeupDb: s.makeupDb,
  }
}

/**
 * Every generated lane's compressor (`Lane.comp`), or `only` these lanes': its part's settings,
 * its threshold from how loud its clips are. A lane whose part gets none, or with no clips, has none.
 */
export function compLanes(project: Project, samples: Map<string, SampleListItem>, drops: [number, number][],
                          roleOf: (laneName: string) => Role | undefined, only?: Set<string>): void {
  for (const lane of project.lanes) {
    if (only && !only.has(lane.id)) continue
    const role = roleOf(lane.name)
    const level = role ? laneLevelDb(project.clips.filter((c) => c.laneId === lane.id), samples, drops, role) : null
    const comp = role && level != null ? roleComp(role, level) : null
    if (comp) lane.comp = comp
    else delete lane.comp
  }
}

/** A lane compressor in a few words (tooltips, the lane panel). */
export function compSummary(c: LaneComp, role?: Role): string {
  const what = role ? COMP_ROLES[GROUP[role] ?? role]?.what : undefined
  const ms = Math.round(c.attackMs)
  return `${c.ratio}:1, ${ms} ms attack, ${c.releaseBeats} beat release${what ? ` (${what})` : ''}`
}
