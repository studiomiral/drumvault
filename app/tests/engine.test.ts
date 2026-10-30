// The live transport against a fake AudioContext and clock: every sound must be scheduled
// exactly once, at the exact grid time, over a whole 192-bar arrangement and across loop wraps.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject } from '../src/lib/project'
import type { AudioClip, PatternClip, Project, Velocity } from '../src/types/project'

interface Start { when: number; offset: number; duration: number | undefined; tag: string }
const starts: Start[] = []
const clock = { t: 100 }

function param() {
  return { value: 1, setTargetAtTime() {}, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} }
}
function node<T extends object>(extra: T = {} as T) {
  return { connect(n: unknown) { return n }, disconnect() {}, ...extra }
}
const SR = 44100
const stops: string[] = []
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
      stop() { stops.push(src.buffer?.tag ?? '') },
    })
    return src
  },
}

/** Sounds not decoded yet; loadAll / renderBass wait for `release()` when set. */
const unloaded = new Set<string>()
let gate: Promise<void> = Promise.resolve()
let release = () => {}
function hold() {
  gate = new Promise((r) => { release = r })
}

// The app bridge (window.drumvault) doesn't exist here; nothing in these projects needs stretching.
vi.mock('../src/api', () => ({ api: { renderBass: async () => { await gate } } }))

vi.mock('../src/audio/context', () => ({
  audioContext: () => fakeCtx,
  buffers: {
    get: (p: string) => (unloaded.has(p) ? undefined : { duration: p.includes('Kick') ? 0.5 : 100, sampleRate: SR, tag: p }),
    loadAll: async (paths: Iterable<string>) => {
      const list = [...paths]
      if (list.some((p) => unloaded.has(p))) await gate
      for (const p of list) if (!p.includes('missing')) unloaded.delete(p)
      return []
    },
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
  stops.length = 0
  clock.t = 100
  unloaded.clear()
  gate = Promise.resolve()
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

  it('swaps a clip\'s new sound in right away while playing, from the playhead', async () => {
    project = build(16)
    playback.connect(() => project)
    await playback.play(0)
    run(3 * BEAT)                                     // into the first 4-bar repetition of the loop
    const loop = project.clips.find((c) => c.id === 'l')!
    loop.sample = { ...loop.sample, relPath: 'Loops/Tops/Top-new.wav' }
    const before = starts.length
    await playback.reloadClips(project, ['l'])
    expect(stops).toContain('Loops/Tops/Top.wav')     // the old sound stops
    const swapped = starts.slice(before).filter((s) => s.tag === 'Loops/Tops/Top-new.wav')
    expect(swapped).toHaveLength(1)                   // the new one starts now, mid-loop
    expect(swapped[0].offset).toBeGreaterThan(2.5 * BEAT)
    expect(swapped[0].when).toBeLessThan(clock.t + 0.1)
  })

  it('a stop while loading cancels the play', async () => {
    project = build(8)
    playback.connect(() => project)
    unloaded.add('Loops/Tops/Top.wav')
    hold()
    const p = playback.play(0)
    await Promise.resolve()
    expect(playback.loading).toBe(true)
    playback.toggle()                                 // pressing stop while it loads
    expect(playback.loading).toBe(false)
    release()
    await p
    run(1)
    expect(playback.playing).toBe(false)
    expect(starts).toHaveLength(0)
  })

  it('pressing play twice while loading starts one transport, not two', async () => {
    project = build(8)
    playback.connect(() => project)
    unloaded.add('Loops/Tops/Top.wav')
    hold()
    const a = playback.play(0)
    const b = playback.play(0)
    release()
    await Promise.all([a, b])
    run(3 * BEAT)                                     // beats 0–3 (beat 4 is past the lookahead)
    expect(starts.filter((s) => s.tag.includes('Kick'))).toHaveLength(4)
    playback.stop()
    run(1)
    expect(playback.playing).toBe(false)
    const n = starts.length
    run(1)
    expect(starts).toHaveLength(n)                    // nothing keeps scheduling after stop
  })

  it("doesn't wait for a bass render to start; the bass comes in when it's ready", async () => {
    project = build(16)
    const bass: AudioClip = {
      id: 'b', laneId: project.lanes[6].id, type: 'audio', start: 0, length: 64, trimBeats: 0, gainDb: 0,
      sample: { relPath: 'MIDI/bass.mid', id: 0, name: 'b', kind: 'loop', category: 'melodic', bars: 4, durationS: 16 * BEAT },
      bass: { preset: '/p/Bass.SerumPreset', presetName: 'Bass', midiId: 1, midiName: 'b', transpose: 0 },
    }
    project.clips.push(bass)
    playback.connect(() => project)
    const { bassPath } = await import('../src/audio/schedule')
    const path = bassPath(bass.bass!, BPM)
    unloaded.add(path)
    hold()
    await playback.play(0)
    expect(playback.playing).toBe(true)              // drums play at once
    run(2 * BEAT)
    expect(starts.some((s) => s.tag === path)).toBe(false)
    release()
    await vi.waitFor(() => expect(starts.some((s) => s.tag === path)).toBe(true))
    const b = starts.find((s) => s.tag === path)!
    expect(b.offset).toBeGreaterThan(1.5 * BEAT)     // from the playhead, not the clip start
  })
})
