// The moments' and stabs' hits against the kick's (tests/bench): in tracks made from the user's
// library, each lane rendered whole as it plays (mixLanes: gains, velocities, compressors; no
// filters, fades or sidechain), its loudest 200 ms and 1 s against the kick lane's; the same as the
// user's own tracks measure. Not part of `npm test`. Theirs are measured first (read-only):
//   cd engine && uv run python -I ../app/tests/bench/hit_levels.py <library> > <hits.json>
//   DRUMVAULT_REAL_LIBRARY=<library> HIT_REFS=<hits.json> npx vitest run --config tests/bench/vitest.config.ts levels
import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { LibraryReader } from '../../electron/db'
import { refine } from '../../src/generate/critic'
import { generate, laneRole, type GenerateOptions, type Role } from '../../src/generate/generator'
import { beatToSec } from '../../src/lib/project'
import { boxes, db10, maxOf, median, mixLanes, out } from './audio'

const LIB = process.env.DRUMVAULT_REAL_LIBRARY
const REFS = process.env.HIT_REFS
const GROUPS: Record<string, Role[]> = {
  clap: ['clap', 'clap2', 'clap3'], crash: ['crash'], fills: ['fills'], stab: ['stab', 'stab2', 'stab3'],
}
const f = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '-').padStart(6)

describe.runIf(!!LIB)('the moments\' and stabs\' hits against the kick', () => {
  const r = new LibraryReader(LIB!)
  const samples = r.querySamples({ sort: 'name' })
  const hits = r.listHits()
  const opts: GenerateOptions = { bpm: 124, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true, templates: r.arrangements(),
    stabs: { hits: hits.filter((h) => h.kind === 'stab') }, disco: { hits: hits.filter((h) => h.kind === 'disco') } }

  it('measures', () => {
    const made: Record<string, [number, number][]> = { clap: [], crash: [], fills: [], stab: [] }
    for (let i = 0; i < 12; i++) {
      const g = refine(samples, opts, generate(samples, opts, 700 + i))
      const end = beatToSec(g.project.lengthBars * 4, g.project.bpm)
      // The loudest 200 ms and 1 s of a set of lanes (the loudest lane of them, as the references' loudest stem).
      const loud = (roles: Role[]) => {
        let a = -Infinity
        let b = -Infinity
        for (const l of g.project.lanes.filter((x) => roles.includes(laneRole(x.name)!))) {
          const y = mixLanes(g.project, [l.id], 0, end, LIB!)
          a = Math.max(a, maxOf(boxes(y, 0.2, 0.02).map(db10)))
          b = Math.max(b, maxOf(boxes(y, 1, 0.05).map(db10)))
        }
        return [a, b] as [number, number]
      }
      const kick = loud(['kick'])
      for (const [k, roles] of Object.entries(GROUPS)) {
        const v = loud(roles)
        if (Number.isFinite(v[0])) made[k].push([v[0] - kick[0], v[1] - kick[1]])
      }
    }
    const refs = REFS ? JSON.parse(readFileSync(REFS, 'utf8')) as Record<string, [number, number]>[] : []
    out('part     made: 200 ms   1 s    (n)    your tracks: 200 ms   1 s    (n)    made − yours (200 ms)')
    for (const k of Object.keys(GROUPS)) {
      const m = made[k]
      const y = refs.flatMap((x) => (x[k] ? [x[k]] : []))
      const m0 = median(m.map((x) => x[0]))
      const y0 = median(y.map((x) => x[0]))
      out(`${k.padEnd(8)} ${f(m0)} ${f(median(m.map((x) => x[1])))}  (${m.length})        ${f(y0)} ${f(median(y.map((x) => x[1])))}  (${y.length})     ${f(m0 - y0)}`)
    }
  })
})
