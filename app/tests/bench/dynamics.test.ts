// The lane compressors' timing held against the user's own tracks (generate/comp.ts): each drum
// part's material compressed with fast attacks and releases, at amounts around the table's, for
// its transient and its tail against those of the user's stems where that part plays full. Not part
// of `npm test`. The stems are cut first (read-only, into a folder of your choosing):
//   cd engine && uv run python -I ../app/tests/bench/cut_refs.py <library> <refs folder>
//   DRUMVAULT_REAL_LIBRARY=<library> DRUMVAULT_REFS=<refs folder> npx vitest run --config tests/bench/vitest.config.ts dynamics
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { LibraryReader } from '../../electron/db'
import { COMP_ROLES, RENDER_PUNCH_DB } from '../../src/generate/comp'
import type { Role } from '../../src/generate/generator'
import { compress, f1 as f, lay, median, metrics, out, readWav } from './audio'

const LIB = process.env.DRUMVAULT_REAL_LIBRARY
const REFS = process.env.DRUMVAULT_REFS
const BPM = 124

describe.runIf(!!LIB && !!REFS)('dynamics: the library compressed, against the user\'s tracks', () => {
  const r = new LibraryReader(LIB!)
  const samples = r.querySamples({ sort: 'name' })
  const of = (kind: string, cats: string[]) => samples.filter((s) => s.kind === kind && cats.includes(s.category)).slice(0, 40)
  const renders = (dir: string) => readdirSync(join(LIB!, '.drumvault', dir)).filter((f) => f.endsWith('.wav')).slice(0, 40)
    .map((f) => ({ path: join(LIB!, '.drumvault', dir, f), punch: null as number | null }))
  const lib: Partial<Record<Role, { items: { path: string; punch: number | null }[]; steps: number[] | null }>> = {
    clap: { items: of('oneshot', ['clap', 'snare']).map((s) => ({ path: join(LIB!, s.rel_path), punch: s.punch_db ?? null })), steps: [4, 12] },
    hats: { items: of('loop', ['hat', 'hat_closed', 'hat_open', 'shaker']).map((s) => ({ path: join(LIB!, s.rel_path), punch: s.punch_db ?? null })), steps: null },
    perc: { items: of('loop', ['perc']).map((s) => ({ path: join(LIB!, s.rel_path), punch: s.punch_db ?? null })), steps: null },
    top: { items: of('loop', ['top', 'groove']).map((s) => ({ path: join(LIB!, s.rel_path), punch: s.punch_db ?? null })), steps: null },
    ride: { items: of('loop', ['ride']).map((s) => ({ path: join(LIB!, s.rel_path), punch: s.punch_db ?? null })), steps: null },
    bass: { items: renders('bass'), steps: null },
  }
  const index = JSON.parse(readFileSync(join(REFS!, 'index.json'), 'utf8')) as { file: string; part: string; bpm: number }[]

  // Candidates: attack, detector, release (beats); each at the threshold that takes the table's mean gain reduction off.
  const CANDIDATES = [{ a: 0.2, d: 0.5, r: 0.25 }, { a: 0.2, d: 0.5, r: 0.1 }, { a: 1, d: 1, r: 0.1 }]

  it('searches each part\'s attack, detector and release for the user\'s tracks', () => {
    out('part   attack det release  over   transient   tail/head    mean GR   loss    score  (yours: transient, tail)')
    for (const [role, m] of Object.entries(lib) as [Role, NonNullable<(typeof lib)[Role]>][]) {
      const s = COMP_ROLES[role]!
      const refs = index.filter((i) => i.part === role).map((i) => metrics(readWav(join(REFS!, i.file)), i.bpm))
      const refTr = median(refs.map((x) => x.tr))
      const refTail = median(refs.map((x) => x.tail))
      const items = m.items.map((it) => {
        const x = readWav(it.path)
        const anchor = it.punch ?? RENDER_PUNCH_DB[role]
        return x.length && anchor != null ? { laid: role === 'bass' ? x : lay(x, m.steps, BPM, 4), anchor } : null
      }).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 25)
      const raw = items.map((it) => metrics(it.laid, BPM))
      out(`${role.padEnd(6)} raw                          ${f(median(raw.map((x) => x.tr)))}  ${f(median(raw.map((x) => x.tail)))}                       (${f(refTr)} ${f(refTail)})`)
      for (const c of CANDIDATES) for (const over of [s.overDb + 16, s.overDb + 12, s.overDb + 8, s.overDb + 4, s.overDb]) {
        const res = items.map((it) => compress(it.laid, { thresholdDb: it.anchor + over, ratio: s.ratio, kneeDb: s.kneeDb, attackMs: c.a,
          releaseMs: (c.r * 60_000) / BPM, makeupDb: 0, detectMs: c.d }, it.anchor))
        const mm = res.map((x) => metrics(x.y, BPM))
        const tr = median(mm.map((x) => x.tr))
        const tail = median(mm.map((x) => x.tail))
        const score = Math.abs(tr - refTr) + Math.abs(tail - refTail)
        out(`${role.padEnd(6)} ${f(c.a)} ${f(c.d)} ${f(c.r)}  ${f(over)}   ${f(tr)}       ${f(tail)}      ${f(median(res.map((x) => x.mean)))}  ${f(median(res.map((x) => x.loss)))}   ${f(score)}`)
      }
    }
  })
})
