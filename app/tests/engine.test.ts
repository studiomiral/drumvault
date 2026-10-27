// The live transport against a fake AudioContext and clock: every sound must be scheduled
// exactly once, at the exact grid time, over a whole 192-bar arrangement and across loop wraps.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject } from '../src/lib/project'
import type { AudioClip, PatternClip, Project, Velocity } from '../src/types/project'

interface Start { when: number; offset: number; duration: number | undefined; tag: string }
const starts: Start[] = []
const clock = { t: 100 }

function param() {
  return { value: 1, setTargetAtTime() {}, setValueAtTime() {}, exponentialRampToValueAtTime() {} }
}
function node<T extends object>(extra: T = {} as T) {
  return { connect(n: unknown) { return n }, disconnect() {}, ...extra }
}
const SR = 44100
const fakeCtx = {
  sampleRate: SR,
  get currentTime() { return clock.t },
  state: 'running',
  destination: node(),
  resume: async () => {},
  createGain: () => node({ gain: param() }),
  createStereoPanner: () => node({ pan: param() }),
  createOscillator: () => node({ frequency: param(), start(when: number) { starts.push({ when, offset: 0, duration: undefined, tag: 'click' }) }, stop() {} }),
  createBufferSource() {
    const src = node({
      buffer: null as null | { duration: number; tag: string },
      onended: null,
      start(when: number, offset: number, duration?: number) { starts.push({ when, offset, duration, tag: src.buffer!.tag }) },
      stop() {},
    })
    return src
  },
}

// The app bridge (window.drumvault) doesn't exist here; nothing in these projects needs stretching.
vi.mock('../src/api', () => ({ api: {} }))

vi.mock('../src/audio/context', () => ({
  audioContext: () => fakeCtx,
  buffers: {
    get: (p: string) => ({ duration: p.includes('Kick') ? 0.5 : 100, sampleRate: SR, tag: p }),
    loadAll: async () => [],
    load: async (p: string) => ({ duration: 1, tag: p }),
  },
}))

const { playback } = await import('../src/audio/engine')

const BPM = 124
const BEAT = 60 / BPM
let project: Project

function build(bars: number): Project {
  const p = newProject('t', BPM)
  p.lengthBars = bars
  const steps = Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 3 : 0)) as Velocity[]
  const kick: PatternClip = {
    id: 'k', laneId: p.lanes[0].id, type: 'pattern', start: 0, length: bars * 4, patternBars: 1, steps, gainDb: 0,
    sample: { relPath: 'One-Shots/Kicks/Kick.wav', id: 1, name: 'k', kind: 'oneshot', category: 'kick', bars: null, durationS: 0.5 },
  }
  const loop: AudioClip = {
    id: 'l', laneId: p.lanes[5].id, type: 'audio', start: 0, length: bars * 4, trimBeats: 0, gainDb: 0,
    sample: { relPath: 'Loops/Tops/Top.wav', id: 2, name: 't', kind: 'loop', category: 'top', bars: 4, durationS: 16 * BEAT },
  }
  p.clips = [kick, loop]
  return p
}

/** Start times are snapped to whole sample frames (at most half a frame from the grid). */
const HALF = 0.5 / SR + 1e-9
const onFrame = (t: number) => Math.abs(t * SR - Math.round(t * SR)) < 1e-6

/** Advance the fake clock in 25 ms steps, firing the engine's timer each time. */
function run(seconds: number) {
  for (let t = 0; t < seconds; t += 0.025) {
    clock.t += 0.025
    vi.advanceTimersByTime(25)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  starts.length = 0
  clock.t = 100
})
afterEach(() => {
  playback.stop()
  vi.useRealTimers()
})

describe('live transport', () => {
  it('plays 192 bars with every hit exactly on the grid, once', async () => {
    project = build(192)
    playback.connect(() => project)
    await playback.play(0)
    const t0 = clock.t + 0.03
    run(192 * 4 * BEAT + 1)
    const kicks = starts.filter((s) => s.tag.includes('Kick'))
    expect(kicks).toHaveLength(192 * 4)
    kicks.forEach((k, i) => {
      expect(Math.abs(k.when - (t0 + i * BEAT))).toBeLessThanOrEqual(HALF)
      expect(onFrame(k.when)).toBe(true)
    })
    const loops = starts.filter((s) => s.tag.includes('Top'))
    expect(loops).toHaveLength(192 / 4)
    loops.forEach((l, i) => {
      expect(Math.abs(l.when - (t0 + i * 16 * BEAT))).toBeLessThanOrEqual(HALF)
      expect(l.offset).toBe(0)
      expect(Math.abs(l.duration! - 16 * BEAT)).toBeLessThan(1e-9)
    })
    expect(playback.playing).toBe(false)  // stopped at the project end
  })

  it('starts mid-clip with the right offset', async () => {
    project = build(16)
    playback.connect(() => project)
    await playback.play(6)               // beat 6: inside the first 4-bar loop
    run(0.2)
    const loop = starts.find((s) => s.tag.includes('Top'))!
    expect(Math.abs(loop.offset - 6 * BEAT)).toBeLessThanOrEqual(HALF)
    expect(loop.duration).toBeCloseTo(10 * BEAT, 9)
  })

  it('wraps at the loop region, cutting sounds at the loop end', async () => {
    project = build(32)
    project.loop = { start: 4, end: 12, enabled: true }  // 2 bars, starting mid-loop-clip
    playback.connect(() => project)
    await playback.play(4)
    const t0 = clock.t + 0.03
    const cycle = 8 * BEAT
    run(3 * cycle + 0.05)
    const loops = starts.filter((s) => s.tag.includes('Top'))
    // Each cycle: the 4-bar loop clip enters at beat 4 (offset 4 beats) and plays to the loop end.
    for (let c = 0; c < 3; c++) {
      const l = loops[c]
      expect(Math.abs(l.when - (t0 + c * cycle))).toBeLessThanOrEqual(HALF)
      expect(Math.abs(l.offset - 4 * BEAT)).toBeLessThanOrEqual(HALF)
      expect(Math.abs(l.duration! - 8 * BEAT)).toBeLessThanOrEqual(2 * HALF)
    }
    const kicks = starts.filter((s) => s.tag.includes('Kick'))
    expect(kicks.slice(0, 24).map((k) => Math.round((k.when - t0) / BEAT))).toEqual(
      Array.from({ length: 24 }, (_, i) => i))
  })

  it('reports the playhead position', async () => {
    project = build(8)
    playback.connect(() => project)
    await playback.play(2)
    run(1)
    expect(playback.position()).toBeCloseTo(2 + (1 - 0.03) / BEAT, 1)
    playback.stop()
    const at = playback.position()
    run(1)
    expect(playback.position()).toBe(at)
  })
})
