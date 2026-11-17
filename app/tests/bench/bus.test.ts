// The drum bus (generate/comp.ts) measured on tracks made from the user's own library (read-only):
// the first drop's drum lanes mixed as they play, the bus over them, against the drums of the
// user's own tracks summed where kick, clap and hats all play full. Not part of `npm test`. Those
// are cut first (read-only, into a folder of your choosing):
//   cd engine && uv run python -I ../app/tests/bench/cut_bus.py <library> <folder>
//   DRUMVAULT_REAL_LIBRARY=<library> BUS_REFS=<folder> npx vitest run --config tests/bench/vitest.config.ts bus
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { LibraryReader } from '../../electron/db'
import { refine } from '../../src/generate/critic'
import { dropRanges } from '../../src/generate/balance'
import { DRUM_BUS } from '../../src/generate/comp'
import { generate, type GenerateOptions } from '../../src/generate/generator'
import { beatToSec } from '../../src/lib/project'
import { col, compress, median, metrics, mixLanes, out, readWav } from './audio'

const LIB = process.env.DRUMVAULT_REAL_LIBRARY
const REFS = process.env.BUS_REFS
const f = (v: number) => v.toFixed(1).padStart(5)

describe.runIf(!!LIB)('the drum bus on tracks from the real library', () => {
  const r = new LibraryReader(LIB!)
  const samples = r.querySamples({ sort: 'name' })
  const hits = r.listHits()
  const opts: GenerateOptions = { bpm: 124, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true, templates: r.arrangements(),
    stabs: { hits: hits.filter((h) => h.kind === 'stab') }, disco: { hits: hits.filter((h) => h.kind === 'disco') } }

  it('measures the bus', () => {
    // The first drop's first 8 bars of each track, its bus lanes mixed (before the bus) and the bus's threshold.
    const drops = Array.from({ length: 10 }, (_, i) => refine(samples, opts, generate(samples, opts, 500 + i))).map((g) => {
      const [a] = dropRanges(g.sections)[0]
      const from = beatToSec(a, g.project.bpm)
      const to = beatToSec(a + 32, g.project.bpm)
      const ids = g.project.lanes.filter((l) => l.bus).map((l) => l.id)
      return { sum: mixLanes(g.project, ids, from, to, LIB!), threshold: g.project.drumBus!.thresholdDb, bpm: g.project.bpm }
    })
    const refs = REFS ? (JSON.parse(readFileSync(join(REFS, 'index.json'), 'utf8')) as { file: string; bpm: number }[])
      .map((i) => metrics(readWav(join(REFS, i.file)), i.bpm)) : []
    const raw = drops.map((d) => metrics(d.sum, d.bpm))
    out(`tracks ${drops.length}, your tracks ${refs.length}`)
    out('                                      transient          tail/head          peak/avg           mean GR   peak GR  score  loss')
    out(`made, before the bus                 ${col(raw.map((x) => x.tr))}  ${col(raw.map((x) => x.tail))}  ${col(raw.map((x) => x.par))}`)
    if (refs.length) out(`YOUR TRACKS                          ${col(refs.map((x) => x.tr))}  ${col(refs.map((x) => x.tail))}  ${col(refs.map((x) => x.par))}`)
    const refTr = refs.length ? median(refs.map((x) => x.tr)) : NaN
    const refTail = refs.length ? median(refs.map((x) => x.tail)) : NaN
    // `over`: the threshold against the drums' level (the table's is −3).
    for (const attack of [1, 10, 30]) for (const release of [0.25, 0.5]) for (const over of [0, -3, -6]) {
      const res = drops.map((d) => compress(d.sum, { thresholdDb: d.threshold - DRUM_BUS.overDb + over, ratio: DRUM_BUS.ratio, kneeDb: DRUM_BUS.kneeDb,
        attackMs: attack, releaseMs: (release * 60_000) / d.bpm, makeupDb: 0, detectMs: attack < 5 ? 1 : 5 }, d.threshold))
      const m = res.map((x, i) => metrics(x.y, drops[i].bpm))
      const score = Math.abs(median(m.map((x) => x.tr)) - refTr) + Math.abs(median(m.map((x) => x.tail)) - refTail)
      out(`atk ${f(attack)} rel ${f(release)} over ${f(over)}    ${col(m.map((x) => x.tr))}  ${col(m.map((x) => x.tail))}  ${col(m.map((x) => x.par))}  ${f(median(res.map((x) => x.mean)))}   ${f(median(res.map((x) => x.peak)))}  ${f(score)}  ${f(median(res.map((x) => x.loss)))}`)
    }
  })
})
