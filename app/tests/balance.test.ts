import { describe, expect, it } from 'vitest'
import { balanceFrom, dropRanges, HIT_DB, hitSteps, KICK_LEVEL_DB, laneLoudness, levelLanes } from '../src/generate/balance'
import { LANES, laneRole } from '../src/generate/generator'
import type { SampleListItem, TrackArrangement } from '../src/types/api'
import type { AudioClip, Clip, Lane, PatternClip, Project, Velocity } from '../src/types/project'

const BPM = 120  // a bar is 2 s

function sample(relPath: string, kind: SampleListItem['kind'], energy: number | null, duration = 2): SampleListItem {
  return {
    id: 1, rel_path: relPath, name: relPath, kind, category: 'kick', bpm: kind === 'oneshot' ? null : BPM, bars: 1, body_bars: null,
    key_label: null, key_camelot: null, duration_s: duration, channels: 2, favorite: 0, rating: null, tags: null, zip_id: 1,
    source_code: 'S0001', energy_db: energy,
  }
}

const ref = (s: SampleListItem) => ({ relPath: s.rel_path, id: s.id, name: s.name, kind: s.kind, category: s.category, bars: s.bars, durationS: s.duration_s })

function pattern(laneId: string, s: SampleListItem, hits: number[], v: Velocity = 3, start = 0, bars = 1): PatternClip {
  const steps = new Array(16).fill(0) as Velocity[]
  for (const h of hits) steps[h] = v
  return { id: `c${Math.random()}`, laneId, type: 'pattern', start, length: bars * 4, gainDb: 0, sample: ref(s), patternBars: 1, steps }
}

function loop(laneId: string, s: SampleListItem, start = 0, bars = 1, gainDb = 0): AudioClip {
  return { id: `c${Math.random()}`, laneId, type: 'audio', start, length: bars * 4, trimBeats: 0, gainDb, sample: ref(s) }
}

function arrangement(parts: Record<string, number>, normalized = false): TrackArrangement {
  return { zip_id: 1, source_code: 'S0001', bpm: 124, bars: 64, parts: {}, levels: { parts, normalized } }
}

describe('balance: how loud each part sits', () => {
  it('takes the median of the producers\' balance, skipping tracks with stems normalised one by one', () => {
    const b = balanceFrom([
      arrangement({ kick: -16, hats: -22, top: -18 }),
      arrangement({ kick: -20, hats: -28, top: -21 }),
      arrangement({ kick: -15, hats: -19, top: -19 }),
      arrangement({ kick: -10, hats: -10, top: -10 }, true),
    ])
    expect(b.tracks).toBe(3)
    expect(b.db.hats).toBe(-6)                 // −6, −8, −4
    expect(b.db.top).toBe(-2)                  // −2, −1, −4
    expect(b.db.bass).toBe(-2)                 // no reference: the house default
    expect(balanceFrom([]).db.hats).toBe(-10)
  })

  it('takes how hard the stabs and the moments hit from the user\'s tracks: against the clap\'s hits', () => {
    const withHits = (hits: Record<string, number>) => ({ ...arrangement({ kick: -16 }), levels: { parts: { kick: -16 }, normalized: false, hits } })
    const refs = [
      withHits({ kick: -5, clap: -15, crash: -13, fills: -9, fx: -14 }),
      withHits({ kick: -6, clap: -16, crash: -15, fills: -10, fx: -15 }),
      withHits({ kick: -4, clap: -14, crash: -14, fills: -6 }),
      withHits({ kick: -5, crash: -2, fills: -1 }),          // no clap: says nothing
    ]
    const h = hitSteps(refs)
    expect(h.crash).toBe(1)                    // +2, +1, 0
    expect(h.fills).toBe(6)                    // +6, +6, +8
    // FX in only two tracks: the house step stands (not in the set); the layers go with their main lane.
    expect(h.fx).toBeUndefined()
    expect(h.stab2).toBeUndefined()
    const more = hitSteps([...refs, withHits({ kick: -5, clap: -15, fx: -13 })])
    expect(more.fx).toBe(1)                    // +1, +1, +2: the median
    expect(more.fx2! - more.fx!).toBe(HIT_DB.fx2! - HIT_DB.fx!)
    expect(balanceFrom(refs).hits?.crash).toBe(1)
  })

  it('works out a lane\'s loudness from its samples\' energy, its steps and velocities, and its clip gains', () => {
    const kick = sample('kick.wav', 'oneshot', -10, 0.3)
    const top = sample('top.wav', 'loop', -20, 2)
    const by = new Map([kick, top].map((s) => [s.rel_path, s]))
    // Four kicks a bar (2 s): 4 × energy over 2 s.
    expect(laneLoudness([pattern('k', kick, [0, 4, 8, 12])], by, BPM, [])).toBeCloseTo(-10 + 10 * Math.log10(4 / 2), 5)
    // Half the velocity's gain squared per step.
    const soft = laneLoudness([pattern('k', kick, [0, 4, 8, 12], 2)], by, BPM, [])!
    expect(soft - laneLoudness([pattern('k', kick, [0, 4, 8, 12])], by, BPM, [])!).toBeCloseTo(20 * Math.log10(0.65), 5)
    // A loop: its energy every time round (2 s); 6 dB down by its clip gain.
    expect(laneLoudness([loop('t', top)], by, BPM, [])).toBeCloseTo(-20 - 10 * Math.log10(2), 5)
    expect(laneLoudness([loop('t', top, 0, 1, -6)], by, BPM, [])).toBeCloseTo(-26 - 10 * Math.log10(2), 5)
    // Only where it plays in drops when it plays there: a quiet intro doesn't pull it down.
    const lane = [loop('t', top, 0, 4, -12), loop('t', top, 16, 4)]
    expect(laneLoudness(lane, by, BPM, [[16, 32]])).toBeCloseTo(-20 - 10 * Math.log10(2), 5)
    expect(laneLoudness([pattern('k', sample('x.wav', 'oneshot', null), [0])], by, BPM, [])).toBeNull()
  })

  it('brings each lane to its place against the kick, whatever its samples\' own level, with layers together', () => {
    const lanes: Lane[] = ['Kick', 'Hats', 'Tops', 'Tops 2'].map((name, i) => ({
      id: `l${i}`, name, color: '#fff', volumeDb: 0, pan: 0, mute: false, solo: false, height: 60,
    }))
    const kick = sample('kick.wav', 'oneshot', -8, 0.3)
    const hats = sample('hats.wav', 'loop', -28, 2)     // a quiet hat loop …
    const top = sample('top.wav', 'loop', -6, 2)        // … and a loud top loop
    const by = new Map([kick, hats, top].map((s) => [s.rel_path, s]))
    const clips: Clip[] = [pattern('l0', kick, [0, 4, 8, 12], 3, 0, 8), loop('l1', hats, 0, 8), loop('l2', top, 0, 8), loop('l3', top, 0, 8)]
    const project = { bpm: BPM, lanes, clips } as unknown as Project
    const balance = balanceFrom([arrangement({ kick: -16, hats: -22, top: -18 }), arrangement({ kick: -16, hats: -22, top: -18 }),
      arrangement({ kick: -16, hats: -22, top: -18 })])
    const starting = (r: string) => LANES.find((l) => l.role === r)!.startDb
    levelLanes(project, by, balance, dropRanges([{ kind: 'drop', start: 0, bars: 8 }]), laneRole, starting as never)
    const heard = (i: number) => laneLoudness(clips.filter((c) => c.laneId === `l${i}`), by, BPM, [[0, 32]])! + lanes[i].volumeDb + lanes[i].levelDb!
    expect(heard(0)).toBeCloseTo(KICK_LEVEL_DB, 0)
    expect(heard(1) - heard(0)).toBeCloseTo(-6, 0)
    // The two top lanes together sit where the tops do, the second its starting step under the first.
    const together = 10 * Math.log10(10 ** (heard(2) / 10) + 10 ** (heard(3) / 10))
    expect(together - heard(0)).toBeCloseTo(-2, 0)
    expect(heard(3) - heard(2)).toBeCloseTo(starting('top2') - starting('top'), 0)
  })
})
