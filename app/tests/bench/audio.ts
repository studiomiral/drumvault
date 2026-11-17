// Audio helpers for the benches on the user's library (read-only): WAV files in, sounds laid out on
// the grid, the lane compressor run over them, and what it did.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Compressor, type CompParams } from '../../src/audio/compressor'
import { laneCompParams } from '../../src/audio/graph'
import { eventsInRange } from '../../src/audio/schedule'
import type { Project } from '../../src/types/project'

export const SR = 44100
export const out = (s: string) => process.stderr.write(`${s}\n`)

/** A PCM 16/24-bit or float WAV, as two channels (a mono file on both). */
export function readWav(path: string): Float32Array[] {
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
export function lay(x: Float32Array[], steps: number[] | null, bpm: number, bars = 4): Float32Array[] {
  const sixteenth = Math.round((60 / bpm / 4) * SR)
  const n = bars * 16 * sixteenth
  const o = [new Float32Array(n), new Float32Array(n)]
  const starts = steps ? Array.from({ length: bars }, (_, b) => steps.map((s) => (b * 16 + s) * sixteenth)).flat()
    : Array.from({ length: Math.ceil(n / Math.max(1, x[0].length)) }, (_, k) => k * x[0].length)
  for (const s of starts) for (let c = 0; c < 2; c++) for (let i = 0; i < x[c].length && s + i < n; i++) o[c][s + i] += x[c][i]
  return o
}

/** Mean power of both sides (dB). */
export const powerDb = (x: Float32Array[]) => {
  let p = 0
  for (const c of x) for (const v of c) p += v * v
  return 10 * Math.log10(Math.max(1e-12, p / (x.length * x[0].length)))
}

/** The loudest 200 ms (power of both sides, dB; unweighted, so a little off `punch_db` on bass). */
export const loudest = (x: Float32Array[]) => {
  const w = Math.round(0.2 * SR)
  const sq = new Float64Array(x[0].length + 1)
  for (let i = 0; i < x[0].length; i++) sq[i + 1] = sq[i] + 0.5 * (x[0][i] ** 2 + x[1][i] ** 2)
  let best = 0
  for (let i = w; i < sq.length; i += 64) best = Math.max(best, (sq[i] - sq[i - w]) / w)
  return 10 * Math.log10(Math.max(1e-12, best))
}

export const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]
export const f1 = (v: number) => v.toFixed(1).padStart(5)
/** p10, median and p90 of `xs`, as a table column. */
export const col = (xs: number[]) => [0.1, 0.5, 0.9].map((q) => f1(pct(xs, q))).join('')

/**
 * `x` through the lane compressor in blocks of 128 (as the worklet runs): what comes out, and the
 * gain reduction at its deepest and on average while `x` sounds (within 20 dB of `soundingDb`).
 */
export function compress(x: Float32Array[], p: CompParams, soundingDb: number) {
  const c = new Compressor()
  const y = [new Float32Array(x[0].length), new Float32Array(x[0].length)]
  let max = 0
  let sum = 0
  let sounding = 0
  for (let at = 0; at < x[0].length; at += 128) {
    const end = Math.min(x[0].length, at + 128)
    const xi = x.map((ch) => ch.subarray(at, end))
    c.process(xi, y.map((ch) => ch.subarray(at, end)), p, SR)
    max = Math.min(max, c.gr)
    if (powerDb(xi) > soundingDb - 20) { sum += c.gr; sounding++ }
  }
  return { y, peak: -max, mean: sounding ? -sum / sounding : 0, loss: powerDb(x) - powerDb(y) }
}

export const db10 = (p: number) => 10 * Math.log10(Math.max(1e-12, p))
export const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }

/** Box power (mean of both sides' squares) over `win` s, every `hop` s. */
export function boxes(x: Float32Array[], win: number, hop: number): number[] {
  const w = Math.max(1, Math.round(win * SR))
  const h = Math.max(1, Math.round(hop * SR))
  const c = new Float64Array(x[0].length + 1)
  for (let i = 0; i < x[0].length; i++) c[i + 1] = c[i] + 0.5 * (x[0][i] ** 2 + x[1][i] ** 2)
  const o: number[] = []
  for (let i = w; i < c.length; i += h) o.push((c[i] - c[i - w]) / w)
  return o
}

export const maxOf = (xs: number[]) => xs.reduce((m, v) => (v > m ? v : m), -Infinity)

/** A sound's dynamics: its transient (5 ms against 200 ms, dB), peak against average, hit-to-hit spread, and tail against head per 16th. */
export function metrics(x: Float32Array[], bpm: number) {
  const s5 = boxes(x, 0.005, 0.001).map(db10)
  const s200 = boxes(x, 0.2, 0.01).map(db10)
  const top200 = maxOf(s200)
  const top5 = maxOf(s5)
  const loud200 = s200.filter((v) => v > top200 - 30)
  const loud5 = s5.filter((v) => v > top5 - 40)
  const p = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]
  const tr = p(loud5, 0.99) - p(loud200, 0.99)
  const meanLoud = db10(loud200.reduce((n, v) => n + 10 ** (v / 10), 0) / loud200.length)
  const par = p(loud5, 0.99) - meanLoud
  // Per 16th: its peak (5 ms) and its tail against its head (the first quarter of the 16th).
  const per = Math.round((60 / bpm / 4) / 0.001)
  const q = Math.round(per / 4)
  const peaks: number[] = []
  const tails: number[] = []
  for (let k = 0; (k + 1) * per <= s5.length; k++) {
    let pk = -Infinity
    let head = 0
    let tail = 0
    for (let i = 0; i < per; i++) {
      const v = s5[k * per + i]
      if (v > pk) pk = v
      if (i < q) head += 10 ** (v / 10)
      else tail += 10 ** (v / 10)
    }
    if (pk < top5 - 25) continue
    peaks.push(pk)
    tails.push(db10(tail / (per - q)) - db10(head / q))
  }
  const m = peaks.reduce((a, b) => a + b, 0) / Math.max(1, peaks.length)
  const hv = Math.sqrt(peaks.reduce((n, v) => n + (v - m) ** 2, 0) / Math.max(1, peaks.length))
  return { tr, par, hv, tail: tails.length ? median(tails) : 0 }
}


/**
 * Lanes of `project` from `from` to `to` (seconds) mixed as they play, in plain code: their events
 * from the shared scheduler at their gain (fades, filters and sends left out), each lane at its
 * volume and level in the mix and through its compressor (its EQ left out: its makeup with it).
 * Files from `lib`; missing ones are left out.
 */
export function mixLanes(project: Project, laneIds: string[], from: number, to: number, lib: string): Float32Array[] {
  const n = Math.round((to - from) * SR)
  const sum = [new Float32Array(n), new Float32Array(n)]
  for (const id of laneIds) {
    const lane = project.lanes.find((l) => l.id === id)!
    if (lane.mute) continue
    const x = [new Float32Array(n), new Float32Array(n)]
    for (const ev of eventsInRange(project, from, to, { includeOngoing: true, laneIds: new Set([id]) })) {
      const f = wavCache.get(ev.relPath) ?? (existsSync(join(lib, ev.relPath)) ? readWav(join(lib, ev.relPath)) : [])
      wavCache.set(ev.relPath, f)
      if (!f.length) continue
      const rate = ev.rate ?? 1
      const start = Math.round((ev.start - from) * SR)
      const off = ev.offset * SR
      const len = ev.duration == null ? Math.floor((f[0].length - off) / rate) : Math.round(ev.duration * SR)
      for (let i = Math.max(0, -start); i < len && start + i < n; i++) {
        const t = off + i * rate
        const k = Math.floor(t)
        if (k + 1 >= f[0].length) break
        const w = t - k
        for (let c = 0; c < 2; c++) x[c][start + i] += ev.gain * (f[c][k] * (1 - w) + f[c][k + 1] * w)
      }
    }
    const g = 10 ** ((lane.volumeDb + (lane.levelDb ?? 0)) / 20)
    for (const c of x) for (let i = 0; i < n; i++) c[i] *= g
    const p = laneCompParams(lane, project.bpm)
    const y = p ? compress(x, p, -30).y : x
    for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) sum[c][i] += y[c][i]
  }
  return sum
}
const wavCache = new Map<string, Float32Array[]>()
