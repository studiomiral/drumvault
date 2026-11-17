// The lane compressors' settings (generate/comp.ts) measured on the user's own library (read-only):
// each role's material run through its compressor, for how much it takes off at the loudest hits,
// on average while it plays, and in loudness (what the makeup gives back). Not part of `npm test`:
//   DRUMVAULT_REAL_LIBRARY=/path npx vitest run --config tests/bench/vitest.config.ts comp
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { LibraryReader } from '../../electron/db'
import { COMP_ROLES, RENDER_PUNCH_DB } from '../../src/generate/comp'
import type { Role } from '../../src/generate/generator'
import type { SampleListItem } from '../../src/types/api'
import { col, compress, lay, loudest, out, readWav } from './audio'

const LIB = process.env.DRUMVAULT_REAL_LIBRARY
const BPM = 124

/** Run one role's compressor over `x` (anchored at `anchor` dB): the peak and mean gain reduction while it sounds, and the loudness taken off. */
function measure(role: Role, x: Float32Array[], anchor: number) {
  const s = COMP_ROLES[role]!
  const { peak, mean, loss } = compress(x, {
    thresholdDb: anchor + s.overDb, ratio: s.ratio, kneeDb: s.kneeDb, attackMs: s.attackMs,
    releaseMs: (s.releaseBeats * 60_000) / BPM, makeupDb: 0, detectMs: s.detectMs,
  }, anchor)
  return { peak, mean, loss }
}

describe.runIf(!!LIB)('lane compressors on the real library', () => {
  const r = new LibraryReader(LIB!)
  const samples = LIB ? r.querySamples({ sort: 'name' }) : []
  type Item = { path: string; punch: number | null }
  const of = (kind: string, cats: string[]): Item[] => samples.filter((s: SampleListItem) => s.kind === kind && cats.includes(s.category))
    .map((s) => ({ path: join(LIB!, s.rel_path), punch: s.punch_db ?? null }))
  const renders = (dir: string): Item[] => {
    try {
      return readdirSync(join(LIB!, '.drumvault', dir)).filter((f) => f.endsWith('.wav')).map((f) => ({ path: join(LIB!, '.drumvault', dir, f), punch: null }))
    } catch { return [] }
  }
  // What each role plays, as it plays (one-shots on their usual steps); a render's anchor is its kind's.
  const material: Partial<Record<Role, { items: Item[]; steps: number[] | null; render?: boolean }>> = {
    clap: { items: of('oneshot', ['clap', 'snare']), steps: [4, 12] },
    hats: { items: of('loop', ['hat', 'hat_closed', 'hat_open', 'shaker']), steps: null },
    ride: { items: of('loop', ['ride']), steps: null },
    perc: { items: of('loop', ['perc']), steps: null },
    top: { items: of('loop', ['top', 'groove']), steps: null },
    bass: { items: renders('bass'), steps: null, render: true },
    stab: { items: r.listHits().filter((h) => h.kind === 'stab').map((h) => ({ path: join(LIB!, h.rel_path), punch: h.punch_db ?? null })), steps: [3, 6, 11, 14] },
    strings: { items: renders('strings'), steps: null, render: true },
    bed: { items: renders('ambience'), steps: null, render: true },
    vocal: { items: renders('vocals'), steps: null, render: true },
    pad: { items: renders('pads'), steps: null, render: true },
  }

  it('measures each role', () => {
    out('role      n   loudest 200 ms     peak GR          mean GR          loudness off')
    out('              p10  med  p90     p10  med  p90     p10  med  p90     p10  med  p90')
    for (const [role, m] of Object.entries(material) as [Role, NonNullable<(typeof material)[Role]>][]) {
      if (!COMP_ROLES[role]) { out(`${role.padEnd(8)} no compressor`); continue }
      const rows: { level: number; peak: number; mean: number; loss: number }[] = []
      for (const it of m.items.slice(0, 60)) {
        const x = readWav(it.path)
        const anchor = m.render ? RENDER_PUNCH_DB[role] : it.punch
        if (!x.length || !x[0].length || anchor == null) continue
        const laid = m.render ? x : lay(x, m.steps, BPM)
        rows.push({ level: loudest(laid), ...measure(role, laid, anchor) })
      }
      if (!rows.length) { out(`${role.padEnd(8)} none`); continue }
      const c = (k: keyof (typeof rows)[number]) => col(rows.map((x) => x[k]))
      out(`${role.padEnd(8)}${String(rows.length).padStart(3)}  ${c('level')}   ${c('peak')}   ${c('mean')}   ${c('loss')}`)
    }
  })
})
