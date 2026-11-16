// Timing and scores on the user's own library (read-only). Not part of `npm test`: run by hand with
//   DRUMVAULT_REAL_LIBRARY=/path npx vitest run --config tests/bench/vitest.config.ts
import { describe, expect, it } from 'vitest'
import { LibraryReader } from '../../electron/db'
import { generate, laneRole, type GenerateOptions, type Generation } from '../../src/generate/generator'
import { refine } from '../../src/generate/critic'
import { bestOf, scoreGeneration, scoreRefs } from '../../src/generate/score'
import { interlockFit, paletteRefs, placeOf } from '../../src/generate/palette'
import type { SampleListItem } from '../../src/types/api'

const LIB = process.env.DRUMVAULT_REAL_LIBRARY
const out = (s: string) => process.stderr.write(`${s}\n`)
const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN)
const med = (x: number[]) => [...x].sort((a, b) => a - b)[x.length >> 1]

describe.runIf(!!LIB)('real library', () => {
  const r = new LibraryReader(LIB!)
  const samples = LIB ? r.querySamples({ sort: 'name' }) : []
  const templates = LIB ? r.arrangements() : []
  const hits = LIB ? r.listHits() : []
  const stabs = hits.filter((h) => h.kind === 'stab')
  const opts: GenerateOptions = { bpm: 124, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true, templates,
    stabs: stabs.length ? { hits: stabs } : null, disco: { hits: hits.filter((h) => h.kind === 'disco') } }
  const one = (s: number) => refine(samples, opts, generate(samples, opts, s))
  const byPath = new Map(samples.map((s) => [s.rel_path, s]))
  const refs = paletteRefs(samples)

  it('measures what the changes do', () => {
    const measured = (f: (s: SampleListItem) => boolean) => samples.filter((s) => f(s) && s.tone).length
    out(`samples ${samples.length} (tone on ${measured(() => true)}, loops with groove ${samples.filter((s) => s.kind === 'loop' && s.groove).length}), templates ${templates.length}`)

    // Timing.
    const t: number[] = []
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now()
      one(1000 + i)
      t.push(performance.now() - t0)
    }
    out(`one track (generate + critic): median ${med(t).toFixed(0)} ms, max ${Math.max(...t).toFixed(0)}`)
    const t0 = performance.now()
    bestOf(samples, 4242, 12, one)
    out(`best of 12: ${(performance.now() - t0).toFixed(0)} ms`)

    // The palette per character: the drums' brightness against their kind.
    const drumsOf = (g: Generation) => {
      const lanes = new Map(g.project.lanes.map((l) => [l.id, laneRole(l.name) ?? '']))
      return [...new Set(g.project.clips.filter((c) => /^(clap|hats|perc|top|groove)/.test(lanes.get(c.laneId)!)).map((c) => byPath.get(c.sample.relPath)))]
        .filter((s): s is SampleListItem => !!s)
    }
    for (const character of ['dub', 'deep', 'drums', 'disco']) {
      const z = Array.from({ length: 40 }, (_, i) => mean(drumsOf(generate(samples, { ...opts, locks: { character } }, 500 + i))
        .map((s) => placeOf(s, refs).bright).filter((v): v is number => v != null)))
      out(`palette ${character}: drums' brightness ${mean(z).toFixed(2)} (z against their kind)`)
    }

    // Interlock of the main loops, against a random loop of the library.
    const loops = samples.filter((s) => s.kind === 'loop' && s.groove && s.category !== 'ride')
    const picked: number[] = [], chance: number[] = []
    for (let i = 0; i < 60; i++) {
      const g = generate(samples, opts, 700 + i)
      const set = [g.picks.top, g.picks.groove, g.picks.hats, g.picks.perc].filter((x): x is SampleListItem => x?.kind === 'loop')
      for (let k = 1; k < set.length; k++) {
        picked.push(interlockFit(set[k], set.slice(0, k)))
        chance.push(interlockFit(loops[(i * 31 + k * 7) % loops.length], set.slice(0, k)))
      }
    }
    out(`interlock: picked ${mean(picked).toFixed(2)}, a random loop ${mean(chance).toFixed(2)}`)

    // Holds, vocabularies.
    const gs = Array.from({ length: 60 }, (_, i) => generate(samples, opts, 900 + i))
    const holds = gs.map((g) => String(g.rules.hold))
    out(`held for the last drop: ${['ride', 'perc2', 'hats2', 'groove', 'none'].map((h) => `${h} ${holds.filter((x) => x === h).length}`).join(', ')}`)

    // Best of 12 against taking the first.
    const sr = scoreRefs(samples)
    const first: number[] = [], best: number[] = [], landFirst: number[] = [], landBest: number[] = []
    for (let i = 0; i < 15; i++) {
      const a = one(3000 + i * 101)
      const sa = scoreGeneration(samples, a, sr)
      const b = bestOf(samples, 3000 + i * 101, 12, one)
      first.push(sa.total)
      best.push(b.score!.total)
      const landed = (l: { lu: number }[]) => (l.length ? l.filter((x) => x.lu >= 1).length / l.length : 1)
      landFirst.push(landed(sa.lifts))
      landBest.push(landed(b.score!.lifts))
    }
    out(`score: first candidate median ${med(first).toFixed(1)} (min ${Math.min(...first).toFixed(1)}), best of 12 median ${med(best).toFixed(1)} (min ${Math.min(...best).toFixed(1)})`)
    out(`drops landing (predicted): first ${(mean(landFirst) * 100).toFixed(0)} %, best of 12 ${(mean(landBest) * 100).toFixed(0)} %`)
    out(`example: ${bestOf(samples, 77, 12, one).choices.slice(0, 4).join(' | ')}`)
    expect(t.length).toBe(12)
  })
})
