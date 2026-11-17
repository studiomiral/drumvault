// The lane compressors' settings (generate/comp.ts) measured on the user's own library (read-only):
// each role's material run through its compressor, for how much it takes off at the loudest hits,
// on average while it plays, and in loudness (what the makeup gives back). Not part of `npm test`:
//   DRUMVAULT_REAL_LIBRARY=/path npx vitest run --config tests/bench/vitest.config.ts comp
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { LibraryReader } from '../../electron/db'
import { Compressor } from '../../src/audio/compressor'
import { COMP_ROLES, RENDER_PUNCH_DB } from '../../src/generate/comp'
import type { Role } from '../../src/generate/generator'
import type { SampleListItem } from '../../src/types/api'

const LIB = process.env.DRUMVAULT_REAL_LIBRARY
const out = (s: string) => process.stderr.write(`${s}\n`)
const BPM = 124
const SR = 44100

/** A PCM 16/24-bit or float WAV, as channels. */
function readWav(path: string): Float32Array[] {
  const b = readFileSync(path)
  let at = 12
  let fmt = { ch: 2, bits: 24, float: false }
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4)
    const size = b.readUInt32LE(at + 4)
    if (id === 'fmt ') fmt = { float: b.readUInt16LE(at + 8) === 3, ch: b.readUInt16LE(at + 10), bits: b.readUInt16LE(at + 22) }
    if (id === 'data') {
      const bps = fmt.bits / 8
      const n = Math.floor(size / (bps * fmt.ch))
      const chans = Array.from({ length: fmt.ch }, () => new Float32Array(n))
      for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) {
        const o = at + 8 + (i * fmt.ch + c) * bps
        chans[c][i] = fmt.float ? b.readFloatLE(o) : fmt.bits === 16 ? b.readInt16LE(o) / 32768 : b.readIntLE(o, 3) / 8388608
      }
      return chans.length === 1 ? [chans[0], chans[0]] : chans.slice(0, 2)
    }
    at += 8 + size + (size & 1)
  }
  return []
}

/** `bars` bars of a one-shot on `steps` (16ths of a bar), or of a loop played over and over. */
function lay(x: Float32Array[], steps: number[] | null, bars = 4): Float32Array[] {
  const sixteenth = Math.round((60 / BPM / 4) * SR)
  const n = bars * 16 * sixteenth
  const o = [new Float32Array(n), new Float32Array(n)]
  const starts = steps ? Array.from({ length: bars }, (_, b) => steps.map((s) => (b * 16 + s) * sixteenth)).flat()
    : Array.from({ length: Math.ceil(n / Math.max(1, x[0].length)) }, (_, k) => k * x[0].length)
  for (const s of starts) for (let c = 0; c < 2; c++) for (let i = 0; i < x[c].length && s + i < n; i++) o[c][s + i] += x[c][i]
  return o
}

const powerDb = (x: Float32Array[]) => {
  let p = 0
  for (const c of x) for (const v of c) p += v * v
  return 10 * Math.log10(Math.max(1e-12, p / (x.length * x[0].length)))
}
/** The loudest 200 ms (power of both sides, dB; unweighted, so a little off `punch_db` on bass). */
const loudest = (x: Float32Array[]) => {
  const w = Math.round(0.2 * SR)
  const sq = new Float64Array(x[0].length + 1)
  for (let i = 0; i < x[0].length; i++) sq[i + 1] = sq[i] + 0.5 * (x[0][i] ** 2 + x[1][i] ** 2)
  let best = 0
  for (let i = w; i < sq.length; i += 64) best = Math.max(best, (sq[i] - sq[i - w]) / w)
  return 10 * Math.log10(Math.max(1e-12, best))
}
const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]
const f1 = (v: number) => v.toFixed(1).padStart(5)

/** Run one role's compressor over `x` (anchored at `anchor` dB): the peak and mean gain reduction while it sounds, and the loudness taken off. */
function measure(role: Role, x: Float32Array[], anchor: number) {
  const s = COMP_ROLES[role]!
  const c = new Compressor()
  const y = [new Float32Array(x[0].length), new Float32Array(x[0].length)]
  const block = 128
  let max = 0
  let sum = 0
  let sounding = 0
  for (let at = 0; at < x[0].length; at += block) {
    const end = Math.min(x[0].length, at + block)
    const xi = x.map((ch) => ch.subarray(at, end))
    c.process(xi, y.map((ch) => ch.subarray(at, end)), {
      thresholdDb: anchor + s.overDb, ratio: s.ratio, kneeDb: s.kneeDb, attackMs: s.attackMs,
      releaseMs: (s.releaseBeats * 60_000) / BPM, makeupDb: 0,
    }, SR)
    max = Math.min(max, c.gr)
    if (powerDb(xi) > anchor - 20) { sum += c.gr; sounding++ }
  }
  return { peak: -max, mean: sounding ? -sum / sounding : 0, loss: powerDb(x) - powerDb(y) }
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
        const laid = m.render ? x : lay(x, m.steps)
        rows.push({ level: loudest(laid), ...measure(role, laid, anchor) })
      }
      if (!rows.length) { out(`${role.padEnd(8)} none`); continue }
      const col = (k: keyof (typeof rows)[number]) => [0.1, 0.5, 0.9].map((q) => f1(pct(rows.map((x) => x[k]), q))).join('')
      out(`${role.padEnd(8)}${String(rows.length).padStart(3)}  ${col('level')}   ${col('peak')}   ${col('mean')}   ${col('loss')}`)
    }
  })
})
