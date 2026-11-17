import { describe, expect, it } from 'vitest'
import { Compressor, gainComputer, type CompParams } from '../src/audio/compressor'
import { busParams, laneCompParams, onBus } from '../src/audio/graph'
import { busLanes, busLevelDb, compLanes, DRUM_BUS, laneLevelDb, RENDER_PUNCH_DB, roleComp } from '../src/generate/comp'
import { laneRole } from '../src/generate/generator'
import { newProject } from '../src/lib/project'
import type { SampleListItem } from '../src/types/api'
import type { AudioClip, Lane, PatternClip, Project } from '../src/types/project'

const SR = 44100
const P: CompParams = { thresholdDb: -20, ratio: 4, kneeDb: 0, attackMs: 5, releaseMs: 50, makeupDb: 0 }
const db = (x: number) => 20 * Math.log10(x)

/** A sine at `amp` for `s` seconds, both sides alike. */
const sine = (amp: number, s: number, hz = 1000) => {
  const x = Float32Array.from({ length: Math.round(s * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR))
  return [x, Float32Array.from(x)]
}
const run = (x: Float32Array[], p: CompParams, block = 128) => {
  const c = new Compressor()
  const y = x.map((ch) => new Float32Array(ch.length))
  for (let at = 0; at < x[0].length; at += block) {
    const end = Math.min(x[0].length, at + block)
    c.process(x.map((ch) => ch.subarray(at, end)), y.map((ch) => ch.subarray(at, end)), p, SR)
  }
  return y
}
const rmsDb = (x: Float32Array, from = 0) => {
  let p = 0
  for (let i = from; i < x.length; i++) p += x[i] * x[i]
  return 10 * Math.log10(p / (x.length - from))
}

describe('the lane compressor', () => {
  it('works out the gain over the threshold by the ratio, easing in over its knee', () => {
    expect(gainComputer(-30, -20, 4, 0)).toBe(0)
    expect(gainComputer(-8, -20, 4, 0)).toBeCloseTo(-9)        // 12 over: 3 through
    expect(gainComputer(-20, -20, 4, 6)).toBeLessThan(0)       // in the knee: a little already
    expect(gainComputer(-23.5, -20, 4, 6)).toBe(0)             // under the knee
    expect(gainComputer(-8, -20, 4, 6)).toBeCloseTo(-9)        // over it: as without
  })

  it('takes a steady sound over the threshold down by the ratio', () => {
    // A sine at −6 dB RMS (peaks at 0.707): 14 over a −20 dB threshold at 4:1 comes out 3.5 over.
    const x = sine(Math.SQRT1_2, 1)
    const y = run(x, P)
    const tail = Math.round(0.5 * SR)
    expect(rmsDb(x[0], tail)).toBeCloseTo(-6, 0)
    expect(rmsDb(y[0], tail)).toBeCloseTo(-16.5, 0)
    // Under it: as it was.
    const q = sine(0.01, 0.5)
    expect(run(q, P)[0]).toEqual(q[0])
  })

  it('adds no delay: a click comes out on its own sample', () => {
    const x = [new Float32Array(1024), new Float32Array(1024)]
    x[0][300] = x[1][300] = 0.5
    const y = run(x, P)
    expect(y[0].findIndex((v) => v !== 0)).toBe(300)
  })

  it('gives both sides one gain (the image stays), and a mono input to both', () => {
    const x = sine(0.9, 0.3)
    x[1] = x[1].map((v) => v * 0.25)
    const y = run(x, P)
    for (const i of [2000, 8000, 12000]) if (x[0][i] !== 0) expect(y[1][i] / y[0][i]).toBeCloseTo(0.25, 5)
    const c = new Compressor()
    const out = [new Float32Array(256), new Float32Array(256)]
    c.process([sine(0.9, 256 / SR)[0]], out, P, SR)
    expect(out[1]).toEqual(out[0])
  })

  it('sounds the same however it is cut into blocks (playback and export alike)', () => {
    const x = sine(0.8, 0.4, 220)
    expect(run(x, P, 128)).toEqual(run(x, P, 4096))
  })

  it('puts out the gain it applies (the drum bus\'s detector)', () => {
    const x = sine(0.8, 0.2, 220)
    const y = run(x, P)
    const g = new Float32Array(x[0].length)
    const c = new Compressor()
    for (let at = 0; at < g.length; at += 128) {
      const end = Math.min(g.length, at + 128)
      c.gains(x.map((ch) => ch.subarray(at, end)), g.subarray(at, end), end - at, P, SR)
    }
    for (const i of [1000, 5000, 8000]) expect(y[0][i]).toBeCloseTo(x[0][i] * g[i], 6)
    // A short detector catches a click a long one doesn't.
    const click = [new Float32Array(2048), new Float32Array(2048)]
    for (let i = 500; i < 520; i++) click[0][i] = click[1][i] = 0.9
    const short = new Compressor()
    const o = click.map((ch) => new Float32Array(ch.length))
    short.process(click.map((ch) => ch.subarray(0, 520)), o.map((ch) => ch.subarray(0, 520)), { ...P, attackMs: 0.2, detectMs: 0.5 }, SR)
    const long = new Compressor()
    long.process(click.map((ch) => ch.subarray(0, 520)), o.map((ch) => ch.subarray(0, 520)), { ...P, attackMs: 0.2, detectMs: 5 }, SR)
    expect(short.gr).toBeLessThan(long.gr - 3)
  })

  it('adds its makeup gain', () => {
    const q = sine(0.01, 0.1)
    const y = run(q, { ...P, makeupDb: 6 })
    expect(db(Math.abs(y[0][100] / q[0][100]))).toBeCloseTo(6, 3)
  })
})

describe('the generated mix\'s compressors', () => {
  const sample = (punch: number | null, kind: SampleListItem['kind'] = 'loop'): SampleListItem => ({
    id: 1, rel_path: `Loops/x${punch}.wav`, name: 'x', kind, category: 'hat', bpm: 124, bars: 1, body_bars: null, key_label: null,
    key_camelot: null, duration_s: 2, channels: 2, favorite: 0, rating: null, tags: null, zip_id: 1, source_code: 'S0001', punch_db: punch,
  })
  const clip = (s: SampleListItem, start: number, length: number, gainDb = 0): AudioClip => ({
    id: `c${start}`, type: 'audio', laneId: 'l', start, length, gainDb, trimBeats: 0,
    sample: { relPath: s.rel_path, id: s.id, name: s.name, kind: s.kind, category: s.category, bars: s.bars, durationS: s.duration_s, bpm: s.bpm },
  })

  it('gives every part its own, and none to the kick, the ride, the FX and the moments', () => {
    for (const r of ['kick', 'ride', 'fx', 'fx2', 'fills', 'crash', 'hits', 'buildup', 'atmos', 'bed', 'pad'] as const) expect(roleComp(r, -18)).toBeNull()
    const clap = roleComp('clap', -18)!
    expect(clap.ratio).toBe(4)
    // Caught at the hit (a slow attack moved the drums away from the user's tracks).
    expect(clap.attackMs).toBeLessThanOrEqual(1)
    expect(clap.detectMs).toBeLessThanOrEqual(1)
    expect(roleComp('hats', -20)!.attackMs).toBeLessThan(1)
    // The stabs keep their attack: they're accents.
    expect(roleComp('stab', -14)!.attackMs).toBeGreaterThanOrEqual(20)
    expect(roleComp('clap2', -18)).toEqual(clap)      // a layer as its part
    expect(roleComp('hats', -20)!.thresholdDb).toBe(-19)
  })

  it('puts the threshold where the lane is loud: its samples\' punch at their clip gain, as most of the drops play it', () => {
    const a = sample(-18)
    const b = sample(-14)
    const samples = new Map([a, b].map((s) => [s.rel_path, s]))
    // a plays the drop (beats 32–96) at −2 dB; b the intro, longer.
    const clips = [clip(b, 0, 32), clip(a, 32, 64, -2), clip(b, 96, 64)]
    expect(laneLevelDb(clips, samples, [[32, 96]], 'hats')).toBe(-20)
    // Not playing in the drops: what it plays most.
    expect(laneLevelDb(clips, samples, [[400, 500]], 'hats')).toBe(-14)
    // Not measured yet: the library's peak less a usual crest.
    expect(laneLevelDb([clip(sample(null), 0, 16)], new Map(), [], 'hats')).toBe(-18.5)
    // A render goes by its kind.
    const bass: AudioClip = { ...clip(a, 0, 16), bass: { role: 'bass', preset: '/p.SerumPreset', presetName: 'p', midiId: 1, midiName: 'm', transpose: 0 } }
    expect(laneLevelDb([bass], samples, [[0, 16]], 'bass')).toBe(RENDER_PUNCH_DB.bass)
    expect(laneLevelDb([], samples, [[0, 16]], 'hats')).toBeNull()
  })

  it('sets them on the lanes, and takes them off a lane whose part gets none', () => {
    const p = newProject('t', 124)
    const lane = (name: string): Lane => ({ ...p.lanes[0], id: name, name })
    p.lanes = [lane('Kick'), lane('Hats'), lane('Clap')]
    p.lanes[0].comp = { thresholdDb: -20, ratio: 2, kneeDb: 6, attackMs: 5, releaseBeats: 0.25, makeupDb: 1 }
    const s = sample(-20, 'oneshot')
    const hit = (laneId: string): PatternClip => ({ ...clip(s, 0, 16), laneId, type: 'pattern', patternBars: 1, steps: Array(16).fill(3) })
    p.clips = [hit('Kick'), hit('Hats'), hit('Clap')]
    compLanes(p, new Map([[s.rel_path, s]]), [[0, 16]], laneRole)
    expect(p.lanes[0].comp).toBeUndefined()
    expect(p.lanes[1].comp?.thresholdDb).toBe(-19)
    expect(p.lanes[2].comp?.ratio).toBe(4)
  })

  it('keeps the threshold on the lane\'s sound when its volume moves, and its release in time', () => {
    const lane: Lane = { ...newProject('t', 124).lanes[0], volumeDb: -4, levelDb: -6,
      comp: { thresholdDb: -20, ratio: 2, kneeDb: 6, attackMs: 5, releaseBeats: 0.25, makeupDb: 2 } }
    const at124 = laneCompParams(lane, 124)!
    expect(at124.thresholdDb).toBe(-30)
    expect(at124.releaseMs).toBeCloseTo(15000 / 124)
    expect(laneCompParams(lane, 248)!.releaseMs).toBeCloseTo(at124.releaseMs / 2)
    expect(laneCompParams({ ...lane, comp: { ...lane.comp!, off: true } }, 124)).toBeNull()
    expect(laneCompParams({ ...lane, comp: undefined }, 124)).toBeNull()
  })
})

describe('the drum bus', () => {
  const sample = (punch: number): SampleListItem => ({
    id: 1, rel_path: `One-Shots/x${punch}.wav`, name: 'x', kind: 'oneshot', category: 'kick', bpm: null, bars: null, body_bars: null, key_label: null,
    key_camelot: null, duration_s: 0.4, channels: 2, favorite: 0, rating: null, tags: null, zip_id: 1, source_code: 'S0001', punch_db: punch,
  })
  const track = (): { p: Project; samples: Map<string, SampleListItem> } => {
    const p = newProject('t', 124)
    const lane = (name: string, levelDb: number): Lane => ({ ...p.lanes[0], id: name, name, levelDb })
    p.lanes = [lane('Kick', 0), lane('Clap 2', -6), lane('Hats', -10), lane('Bass', -2), lane('FX', -9), lane('Stab', -8)]
    const s = sample(-10)
    p.clips = p.lanes.map((l): PatternClip => ({
      id: l.id, type: 'pattern', laneId: l.id, start: 0, length: 16, gainDb: 0, patternBars: 1, steps: Array(16).fill(3),
      sample: { relPath: s.rel_path, id: 1, name: 'x', kind: 'oneshot', category: 'kick', bars: null, durationS: 0.4, bpm: null },
    }))
    return { p, samples: new Map([[s.rel_path, s]]) }
  }

  it('takes the drums that play the groove, layers and all', () => {
    const { p, samples } = track()
    busLanes(p, samples, [[0, 16]], laneRole)
    expect(p.lanes.filter((l) => l.bus).map((l) => l.name)).toEqual(['Kick', 'Clap 2', 'Hats'])
    expect(p.drumBus!.ratio).toBe(DRUM_BUS.ratio)
  })

  it('sets its threshold from the drums\' level together, after their mix levels', () => {
    const { p, samples } = track()
    // Kick at −10, clap at −16, hats at −20: their power added.
    const level = 10 * Math.log10(10 ** -1 + 10 ** -1.6 + 10 ** -2)
    expect(busLevelDb(p, samples, [[0, 16]], laneRole)).toBeCloseTo(level, 5)
    busLanes(p, samples, [[0, 16]], laneRole)
    expect(p.drumBus!.thresholdDb).toBeCloseTo(level + DRUM_BUS.overDb, 1)
  })

  it('stays off when switched off, and works only on its lanes while on', () => {
    const { p, samples } = track()
    busLanes(p, samples, [[0, 16]], laneRole)
    expect(onBus(p.lanes[0], p)).toBe(true)
    expect(onBus(p.lanes[3], p)).toBe(false)
    expect(busParams(p)!.releaseMs).toBeCloseTo((DRUM_BUS.releaseBeats * 60_000) / 124)
    p.drumBus!.off = true
    busLanes(p, samples, [[0, 16]], laneRole)
    expect(p.drumBus!.off).toBe(true)
    expect(busParams(p)).toBeNull()
    expect(onBus(p.lanes[0], p)).toBe(false)
  })
})
