import { describe, expect, it } from 'vitest'
import { bleedOf, BLEED_SHARE, CLASH, clashOf, critique, maskOf, penalty, refine, stackOf } from '../src/generate/critic'
import { generate, laneRole, type GenerateOptions, type Generation, type Role } from '../src/generate/generator'
import type { LoopGroove, SampleListItem } from '../src/types/api'
import type { Category, SampleKind } from '../src/types/engine'

const BPM = 124
const OPTS: GenerateOptions = { bpm: BPM, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true }

/** A tone: most of the power around band `centre` of the engine's 24 (dB against the total, near enough). */
const tone = (centre: number) => Array.from({ length: 24 }, (_, i) => -1.5 * (i - centre) ** 2 - 3)
/** A straight groove hitting `steps` of the bar. */
function groove(steps: number[]): LoopGroove {
  const on = (k: number) => steps.includes(k)
  return {
    offsets: Array.from({ length: 16 }, (_, k) => (on(k) ? 0 : null)),
    levels: Array.from({ length: 16 }, (_, k) => (on(k) ? 0 : null)),
    hits: Array.from({ length: 16 }, (_, k) => (on(k) ? 4 : 0)), swing: 0, push: 0,
  }
}
const OFFBEATS = [2, 6, 10, 14]
const RHYTHMS = [OFFBEATS, [0, 3, 6, 8, 11, 14], [1, 5, 9, 13], [0, 4, 7, 12, 15], Array.from({ length: 16 }, (_, k) => k)]
const TONES = [20, 12, 16, 8]

let nextId = 1
function sample(zip: number, kind: SampleKind, category: Category, bars: number | null, extra: Partial<SampleListItem> = {}): SampleListItem {
  const id = nextId++
  const code = `S${String(zip).padStart(4, '0')}`
  return {
    id, rel_path: `${kind}/${category}/${code}_${id}.wav`, name: `${category}_${id}`, kind, category, bpm: kind === 'oneshot' ? null : BPM,
    bars, body_bars: null, key_label: 'Am', key_camelot: null, duration_s: 1, channels: 2, favorite: 0, rating: null, tags: null,
    zip_id: zip, source_code: code, groove: null, shape: null, ...extra,
  }
}

/**
 * Eight zips of drums. Every loop is measured; most hat and top loops are the same loop over and
 * over (bright, on the offbeats), a few of each kind are different, and one top loop has a kick in it.
 */
function library(): SampleListItem[] {
  const out: SampleListItem[] = []
  for (let z = 1; z <= 8; z++) {
    for (const c of ['kick', 'clap', 'snare', 'hat_closed', 'perc', 'cymbal'] as Category[]) out.push(sample(z, 'oneshot', c, null))
    for (const c of ['hat', 'top', 'top', 'perc', 'groove'] as Category[]) {
      // Zips 1–5: the same bright offbeat loop. Zips 6–8: other tones on other 16ths.
      const same = z <= 5
      const v = out.length
      out.push(sample(z, 'loop', c, 2, { tone: tone(same ? 20 : TONES[v % 4]), groove: groove(same ? OFFBEATS : RHYTHMS[1 + (v % 4)]) }))
    }
  }
  out.push(sample(9, 'loop', 'top', 2, { tone: tone(1), groove: groove([0, 4, 8, 12]), name: 'kick in it' }))
  return out
}

const LIB = library()
const gens = Array.from({ length: 40 }, (_, i) => generate(LIB, OPTS, 500 + i))
const refined = gens.map((g) => refine(LIB, OPTS, g))
const shape = (g: Generation) => JSON.stringify(g.project.clips.map((c) => [c.id, c.laneId, c.start, c.length]))
const sounds = (g: Generation, keep: (role: Role | undefined) => boolean) => JSON.stringify(g.project.clips
  .filter((c) => keep(laneRole(g.project.lanes.find((l) => l.id === c.laneId)!.name))).map((c) => [c.id, c.sample.relPath]))

describe('critic: what it measures', () => {
  it('two loops with the same tone on the same 16ths clash; other 16ths or another tone do not', () => {
    const a = sample(1, 'loop', 'hat', 1, { tone: tone(20), groove: groove(OFFBEATS) })
    const same = sample(2, 'loop', 'hat', 1, { tone: tone(20), groove: groove(OFFBEATS) })
    const between = sample(2, 'loop', 'hat', 1, { tone: tone(20), groove: groove([1, 5, 9, 13]) })
    const dark = sample(2, 'loop', 'perc', 1, { tone: tone(6), groove: groove(OFFBEATS) })
    expect(clashOf(a, same)).toBeCloseTo(1)
    expect(maskOf(a, between)).toBeCloseTo(1)
    expect(stackOf(a, between)).toBe(0)
    expect(clashOf(a, between)).toBe(0)
    expect(stackOf(a, dark)).toBeCloseTo(1)
    expect(clashOf(a, dark)!).toBeLessThan(0.1)
  })

  it('a loop that is not measured clashes with nothing', () => {
    const a = sample(1, 'loop', 'hat', 1, { tone: tone(20), groove: groove(OFFBEATS) })
    expect(clashOf(a, sample(2, 'loop', 'hat', 1))).toBeNull()
    expect(bleedOf(sample(2, 'loop', 'hat', 1))).toBe(0)
  })

  it('a loop with its power in the low end has a kick in it', () => {
    expect(bleedOf(sample(1, 'loop', 'top', 2, { tone: tone(1) }))).toBeGreaterThan(0.5)
    expect(bleedOf(sample(1, 'loop', 'top', 2, { tone: tone(20) }))).toBeLessThan(BLEED_SHARE)
  })
})

describe('critic: listening back to a track', () => {
  it('finds clashes in tracks made from a library full of the same loop', () => {
    expect(gens.filter((g) => critique(LIB, g).clashes.length > 0).length).toBeGreaterThan(20)
  })

  it('leaves no track worse, and most of what clashed fixed', () => {
    let before = 0
    let after = 0
    gens.forEach((g, i) => {
      const b = penalty(critique(LIB, g))
      const a = penalty(critique(LIB, refined[i]))
      expect(a).toBeLessThanOrEqual(b)
      before += b
      after += a
    })
    expect(after).toBeLessThan(before * 0.5)
  })

  it('swaps only loops: every clip stays where it is, the other lanes as they are', () => {
    const loops = new Set<Role | undefined>(['hats', 'hats2', 'ride', 'perc', 'perc2', 'top', 'top2', 'top3', 'top4', 'groove'])
    gens.forEach((g, i) => {
      expect(shape(refined[i])).toBe(shape(g))
      expect(sounds(refined[i], (r) => !loops.has(r))).toBe(sounds(g, (r) => !loops.has(r)))
    })
  })

  it('never leaves a kick in a loop it may swap', () => {
    const withKick = gens.map((g, i) => [g, refined[i]] as const).filter(([g]) => critique(LIB, g).bleeds.length > 0)
    for (const [g, r] of withKick) {
      const feel = [g.picks.groove, g.picks.top].find((s) => s?.groove)
      for (const b of critique(LIB, r).bleeds) expect(b.part.sample.rel_path).toBe(feel?.rel_path)
    }
  })

  it('says what it did, and gives the same track back when nothing clashes', () => {
    gens.forEach((g, i) => {
      const changed = sounds(refined[i], () => true) !== sounds(g, () => true)
      expect(refined[i].choices.some((c) => c.startsWith('listened back: '))).toBe(changed)
      if (!changed) expect(refined[i]).toBe(g)
    })
    const clean = refined.find((r) => penalty(critique(LIB, r)) === 0)!
    expect(refine(LIB, OPTS, clean)).toBe(clean)
  })

  it('is the same every time', () => {
    for (const g of gens.slice(0, 10)) expect(JSON.stringify(refine(LIB, OPTS, g).project)).toBe(JSON.stringify(refine(LIB, OPTS, g).project))
  })

  it('keeps a locked lane\'s main loop, and the loop the feel comes from', () => {
    for (const g of gens) {
      const r = refine(LIB, OPTS, g, { locked: ['hats', 'perc', 'top', 'groove'] })
      for (const role of ['hats', 'perc', 'top', 'groove'] as Role[]) expect(r.picks[role]?.rel_path).toBe(g.picks[role]?.rel_path)
    }
    gens.forEach((g, i) => {
      const feel = (['groove', 'top'] as Role[]).find((role) => g.picks[role]?.groove)!
      expect(refined[i].picks[feel]?.rel_path).toBe(g.picks[feel]?.rel_path)
    })
  })

  it('with `only`, swaps loops on those lanes alone', () => {
    for (const g of gens) {
      const r = refine(LIB, OPTS, g, { only: ['top2', 'top3', 'top4'] })
      const others = (role: Role | undefined) => !['top2', 'top3', 'top4'].includes(role as string)
      expect(sounds(r, others)).toBe(sounds(g, others))
    }
  })

  it('takes a loop that clears every loop it plays with', () => {
    gens.forEach((g, i) => {
      const was = new Map(g.project.clips.map((c) => [c.id, c.sample.relPath]))
      const c = critique(LIB, refined[i])
      const swapped = new Set(refined[i].project.clips.filter((x) => was.get(x.id) !== x.sample.relPath).map((x) => x.sample.relPath))
      // A swapped-in loop only clashes when the library had nothing clear (then with less than before).
      for (const p of c.clashes) {
        if (swapped.has(p.a.sample.rel_path) || swapped.has(p.b.sample.rel_path)) expect(p.clash).toBeGreaterThanOrEqual(CLASH)
      }
    })
  })
})
