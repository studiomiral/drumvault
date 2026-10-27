import { describe, expect, it } from 'vitest'
import { eventsInRange, metronomeTicks } from '../src/audio/schedule'
import { newProject } from '../src/lib/project'
import type { AudioClip, PatternClip, Project, SampleRef, Velocity } from '../src/types/project'

const BPM = 124
const BEAT = 60 / BPM
const loopRef = (bars: number): SampleRef => ({ relPath: `Loops/Tops/LP_${bars}.wav`, id: 1, name: 'loop', kind: 'loop', category: 'top', bars, durationS: bars * 4 * BEAT })
const shotRef: SampleRef = { relPath: 'One-Shots/Kicks/OS_Kick.wav', id: 2, name: 'kick', kind: 'oneshot', category: 'kick', bars: null, durationS: 0.5 }

function project(clips: (AudioClip | PatternClip)[]): Project {
  return { ...newProject('t', BPM), clips }
}
const audio = (start: number, length: number, bars = 2, trimBeats = 0, gainDb = 0): AudioClip =>
  ({ id: 'a', laneId: 'L', type: 'audio', start, length, trimBeats, gainDb, sample: loopRef(bars) })
const pattern = (start: number, length: number, steps: Velocity[], gainDb = 0): PatternClip =>
  ({ id: 'p', laneId: 'K', type: 'pattern', start, length, patternBars: 1, steps, gainDb, sample: shotRef })
const four = (): Velocity[] => Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 3 : 0)) as Velocity[]

/** Run the scheduler the way the live engine does: consecutive windows. */
function windowed(p: Project, from: number, to: number, step = 0.025) {
  const out = []
  for (let t = from; t < to; t += step) out.push(...eventsInRange(p, t, Math.min(to, t + step)))
  return out
}

describe('audio clips', () => {
  it('repeats the loop, anchored to the grid, ending mid-loop', () => {
    // 2-bar loop (8 beats) in a clip of 20 beats: 8 + 8 + 4
    const ev = eventsInRange(project([audio(4, 20)]), 0, 1000)
    expect(ev.map((e) => [e.start / BEAT, e.offset, e.duration! / BEAT])).toEqual([[4, 0, 8], [12, 0, 8], [20, 0, 4]])
  })

  it('applies the left trim to the first repetition only', () => {
    const ev = eventsInRange(project([audio(0, 16, 2, 3)]), 0, 1000)
    const want = [[0, 3, 5], [5, 0, 8], [13, 0, 3]]
    expect(ev).toHaveLength(3)
    ev.forEach((e, i) => {
      expect(e.start / BEAT).toBeCloseTo(want[i][0], 9)
      expect(e.offset / BEAT).toBeCloseTo(want[i][1], 9)
      expect(e.duration! / BEAT).toBeCloseTo(want[i][2], 9)
    })
  })

  it('applies clip gain', () => {
    const [e] = eventsInRange(project([audio(0, 8, 2, 0, -6)]), 0, 10)
    expect(e.gain).toBeCloseTo(0.501, 3)
  })
})

describe('pattern clips', () => {
  it('fires active steps with velocity gains, repeating the pattern', () => {
    const steps = four()
    steps[2] = 1
    const ev = eventsInRange(project([pattern(8, 8, steps)]), 0, 1000)
    // 2 bars: 4 kicks + 1 soft 16th per bar
    expect(ev).toHaveLength(10)
    expect(ev[0]).toMatchObject({ start: 8 * BEAT, offset: 0, duration: null, gain: 1 })
    expect(ev[1].start).toBeCloseTo(8.5 * BEAT, 12)
    expect(ev[1].gain).toBe(0.35)
    expect(ev.at(-1)!.start).toBeCloseTo(15 * BEAT, 12)
  })

  it('stops at the clip end even mid-pattern', () => {
    const ev = eventsInRange(project([pattern(0, 6, four())]), 0, 1000)
    expect(ev.map((e) => Math.round(e.start / BEAT))).toEqual([0, 1, 2, 3, 4, 5])
  })
})

describe('windowed scheduling', () => {
  it('returns every event exactly once across consecutive windows', () => {
    const p = project([audio(0, 64, 1, 1), pattern(0, 64, four()), { ...pattern(2, 30, four()), id: 'p2' }])
    const whole = eventsInRange(p, 0, 64 * BEAT)
    const parts = windowed(p, 0, 64 * BEAT, 0.025)
    expect(parts.map((e) => [e.clipId, e.start])).toEqual(whole.map((e) => [e.clipId, e.start]))
    const parts2 = windowed(p, 0, 64 * BEAT, 0.1234)
    expect(parts2.length).toBe(whole.length)
  })

  it('picks up sounds already playing when starting mid-way', () => {
    const p = project([audio(0, 16, 2), pattern(0, 16, four())])
    const from = 5.5 * BEAT
    const ev = eventsInRange(p, from, from + 0.01, { includeOngoing: true })
    const loop = ev.find((e) => e.clipId === 'a')!
    expect(loop.start).toBe(from)
    expect(loop.offset / BEAT).toBeCloseTo(5.5, 9)
    expect(loop.duration! / BEAT).toBeCloseTo(2.5, 9)
    // The kick at beat 5 is still ringing, but one-shot tails are not restarted mid-sound.
    expect(ev.find((e) => e.clipId === 'p')).toBeUndefined()
    expect(eventsInRange(p, from, from + 0.01)).toHaveLength(0)
  })

  it('filters lanes', () => {
    const p = project([audio(0, 8), pattern(0, 8, four())])
    expect(eventsInRange(p, 0, 100, { laneIds: new Set(['K']) }).every((e) => e.laneId === 'K')).toBe(true)
  })
})

describe('no drift over 192 bars', () => {
  it('places the last bar exactly on the grid', () => {
    const bars = 192
    const p = project([pattern(0, bars * 4, four()), audio(0, bars * 4, 4)])
    const ev = eventsInRange(p, 0, bars * 4 * BEAT + 1)
    const kicks = ev.filter((e) => e.clipId === 'p')
    expect(kicks).toHaveLength(bars * 4)
    const lastKick = kicks.at(-1)!
    expect(Math.abs(lastKick.start - (bars * 4 - 1) * BEAT)).toBeLessThan(1e-9)
    const loops = ev.filter((e) => e.clipId === 'a')
    expect(loops).toHaveLength(bars / 4)
    loops.forEach((e, i) => expect(Math.abs(e.start - i * 16 * BEAT)).toBeLessThan(1e-9))
    // At 44.1 kHz the last loop start is within a quarter sample of the exact grid time.
    expect(Math.abs(loops.at(-1)!.start * 44100 - Math.round(loops.at(-1)!.start * 44100))).toBeLessThan(0.5)
  })
})

describe('metronome', () => {
  it('ticks every beat, accenting bar starts', () => {
    const t = metronomeTicks(BPM, 0, 8 * BEAT)
    expect(t.map((x) => x.downbeat)).toEqual([true, false, false, false, true, false, false, false])
    expect(metronomeTicks(BPM, 0.001, 2 * BEAT).map((x) => Math.round(x.start / BEAT))).toEqual([1])
  })
})

describe('clip filter', () => {
  it('sweeps a loop clip exponentially from start to end, segment by segment', () => {
    // 16 beats sweeping 200 Hz -> 3200 Hz: each 8-beat repetition covers half the sweep.
    const clip = { ...audio(0, 16, 2), filter: { type: 'lowpass' as const, from: 200, to: 3200, q: 0.7 } }
    const ev = eventsInRange(project([clip]), 0, 1000)
    expect(ev.map((e) => [e.filter!.type, e.filter!.f0, Math.round(e.filter!.f1)])).toEqual([
      ['lowpass', 200, 800], ['lowpass', 800, 3200],
    ])
  })

  it('gives each one-shot hit the cutoff at its position, and is absent without a filter', () => {
    const clip = { ...pattern(0, 4, four()), filter: { type: 'highpass' as const, from: 1000, to: 100, q: 1 } }
    const ev = eventsInRange(project([clip]), 0, 1000)
    expect(ev.map((e) => Math.round(e.filter!.f0))).toEqual([1000, 562, 316, 178])
    expect(ev.every((e) => e.filter!.f0 === e.filter!.f1)).toBe(true)
    expect(eventsInRange(project([pattern(0, 4, four())]), 0, 1000)[0].filter).toBeUndefined()
  })
})
