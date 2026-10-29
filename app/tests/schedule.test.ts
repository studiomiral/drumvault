import { describe, expect, it } from 'vitest'
import { bassPath, eventsInRange, fadeAt, fadeBreakpoints, kickHits, metronomeTicks, sampleBpm, soundPath, tempoMode, tempoPath } from '../src/audio/schedule'
import { bassNotes, notesMidi } from '../src/lib/midi'
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

describe('clip fades', () => {
  it('ramps the gain linearly from each edge and carries the fade on every event of the clip', () => {
    const clip = { ...audio(4, 16), fadeIn: 4, fadeOut: 2 }
    const ev = eventsInRange(project([clip]), 0, 1000)
    expect(ev.length).toBe(2)
    const f = ev[0].fade!
    expect(ev[1].fade).toEqual(f)
    expect(f.inStart).toBeCloseTo(4 * BEAT)
    expect(f.inEnd).toBeCloseTo(8 * BEAT)
    expect(f.outStart).toBeCloseTo(18 * BEAT)
    expect(f.outEnd).toBeCloseTo(20 * BEAT)
    expect(fadeAt(f, 4 * BEAT)).toBeCloseTo(0)
    expect(fadeAt(f, 6 * BEAT)).toBeCloseTo(0.5)
    expect(fadeAt(f, 12 * BEAT)).toBe(1)
    expect(fadeAt(f, 19 * BEAT)).toBeCloseTo(0.5)
    expect(fadeAt(f, 20 * BEAT)).toBeCloseTo(0)
    // Corner points inside each event, so ramping between them is exact.
    expect(fadeBreakpoints(f, ev[0].start, ev[0].start + ev[0].duration!).map((t) => t / BEAT))
      .toEqual([4, 8, 12].map((b) => expect.closeTo(b, 9)))
    expect(fadeBreakpoints(f, ev[1].start, ev[1].start + ev[1].duration!).map((t) => t / BEAT))
      .toEqual([12, 18, 20].map((b) => expect.closeTo(b, 9)))
  })

  it('fades pattern hits too, and leaves clips without fades untouched', () => {
    const ev = eventsInRange(project([{ ...pattern(0, 4, four()), fadeOut: 4 }]), 0, 1000)
    expect(ev.map((e) => fadeAt(e.fade!, e.start))).toEqual([1, 0.75, 0.5, 0.25].map((v) => expect.closeTo(v, 9)))
    expect(eventsInRange(project([audio(0, 8)]), 0, 1000).every((e) => e.fade === undefined)).toBe(true)
  })
})

describe('projects at another tempo than the library', () => {
  const at = (bpm: number, clips: (AudioClip | PatternClip)[]): Project => ({ ...newProject('t', bpm), clips })
  const fxRef: SampleRef = { relPath: 'FX/Risers/FX_Riser.wav', id: 3, name: 'riser', kind: 'event', category: 'fx_riser', bars: 4, durationS: 16 * BEAT, bpm: 124 }

  it('plays a loop as 16th slices on the faster grid, each with its own piece of the loop', () => {
    const ev = eventsInRange(at(128, [audio(0, 8, 2)]), 0, 1000)
    expect(ev.length).toBe(32)
    ev.forEach((e, j) => {
      expect(e.start).toBeCloseTo((j / 4) * (60 / 128), 9)
      expect(e.offset).toBeCloseTo((j / 4) * BEAT, 9)          // the loop's own 16th j
      expect(e.duration).toBeCloseTo(0.25 * (60 / 128), 9)     // cut to the shorter slot
      expect(e.declick).toBe(true)
      expect(e.relPath).toBe('Loops/Tops/LP_2.wav')
    })
  })

  it('leaves a short gap after each slice when slower, and keeps trims and repeats', () => {
    const ev = eventsInRange(at(120, [audio(0, 16, 2, 2)]), 0, 1000)
    expect(ev.length).toBe(64)
    expect(ev[0].duration).toBeCloseTo(0.25 * BEAT, 9)          // the whole slice, then a gap
    expect(ev[0].offset).toBeCloseTo(2 * BEAT, 9)               // trimmed 2 beats
    expect(ev[24].offset).toBeCloseTo(0, 9)                     // wrapped to the loop start after 6 beats
    expect(ev[24].start).toBeCloseTo(6 * (60 / 120), 9)
  })

  it('plays FX from a stretched copy, and everything as before at the library tempo', () => {
    const riser: AudioClip = { id: 'f', laneId: 'F', type: 'audio', start: 4, length: 16, trimBeats: 0, gainDb: 0, sample: fxRef }
    const [ev] = eventsInRange(at(128, [riser]), 0, 1000)
    expect(ev.relPath).toBe(tempoPath('FX/Risers/FX_Riser.wav', 128))
    expect(ev.relPath).toBe('.drumvault/tempo/128/FX/Risers/FX_Riser.wav')
    expect(ev.start).toBeCloseTo(4 * (60 / 128), 9)
    expect(ev.duration).toBeCloseTo(16 * (60 / 128), 9)
    expect(soundPath(riser, 124)).toBe('FX/Risers/FX_Riser.wav')
    const native = eventsInRange(at(124, [audio(0, 8, 2)]), 0, 1000)
    expect(native.length).toBe(1)
    expect(native[0].declick).toBeUndefined()
    // Pattern hits just land on the new grid.
    const hits = eventsInRange(at(128, [pattern(0, 4, four())]), 0, 1000)
    expect(hits.map((e) => e.start)).toEqual([0, 1, 2, 3].map((b) => expect.closeTo(b * 60 / 128, 9)))
  })

  it('knows a sample\'s tempo from its length when older projects did not store it', () => {
    expect(sampleBpm(loopRef(2))).toBe(124)
    expect(sampleBpm(shotRef)).toBeNull()
  })
})

describe('bass clips and the sidechain', () => {
  const render = { preset: '/p/Wub.SerumPreset', presetName: 'Wub', midiId: 4, midiName: 'Roll', transpose: -3 }
  const bassClip = (start: number, length: number, trim = 0): AudioClip => ({
    id: 'b', laneId: 'B', type: 'audio', start, length, trimBeats: trim, gainDb: 0, bass: render,
    sample: { relPath: bassPath(render, BPM), id: -4, name: 'Wub · Roll', kind: 'loop', category: 'melodic', bars: 2, durationS: 8 * BEAT, bpm: BPM },
  })

  it('plays the render made for the project tempo, never sliced', () => {
    const c = bassClip(0, 16)
    expect(tempoMode(c, 128)).toBe('rendered')
    expect(soundPath(c, 128)).toBe(bassPath(render, 128))
    expect(bassPath(render, 128)).toMatch(/^\.drumvault\/bass\/[0-9a-f]{8}-4--3-128\.wav$/)
    const ev = eventsInRange({ ...newProject('t', 128), clips: [c] }, 0, 1000)
    expect(ev.length).toBe(2)                                   // two 8-beat repetitions
    expect(ev.every((e) => e.relPath === bassPath(render, 128) && !e.declick)).toBe(true)
  })

  it("names an edited bassline's render after its notes, and exports the edited notes", () => {
    const edited = { ...render, notes: [[0, 2, 40, 90]] as [number, number, number, number][], bars: 1 }
    expect(bassPath(edited, BPM)).not.toBe(bassPath(render, BPM))
    expect(bassPath(edited, BPM)).toBe(bassPath({ ...edited, notes: [[0, 2, 40, 90]] }, BPM))
    expect(bassPath({ ...edited, notes: [[0, 2, 41, 90]] }, BPM)).not.toBe(bassPath(edited, BPM))
    const c = { ...bassClip(0, 8), bass: edited }
    const notes = bassNotes({ ...newProject('t', BPM), clips: [c] }, [])
    expect(notes.map((n) => [n.start, n.pitch])).toEqual([[0, 37], [4, 37]])   // 1-bar loop, transposed -3
  })

  it('finds the kick hits the bass ducks under', () => {
    const p = project([pattern(0, 8, four()), audio(0, 8)])
    expect(kickHits(p, 0, 1000).map((t) => t / BEAT)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((b) => expect.closeTo(b, 9)))
    expect(kickHits(project([audio(0, 8)]), 0, 1000)).toEqual([])
  })

  it('exports the bass parts as notes: looped from the trim, transposed, cut at the clip end', () => {
    const midis = [{ id: 4, file_name: 'Roll.mid', name: 'Roll', rel_path: 'MIDI/Bass/Roll.mid', role: 'bass' as const, bars: 2,
      key_label: 'Am', key_camelot: '8A', notes: [[0, 1, 45, 100], [6, 4, 48, 90]] as [number, number, number, number][], favorite: 0, source: null, source_code: null }]
    const notes = bassNotes({ ...newProject('t', BPM), clips: [bassClip(4, 18, 2)] }, midis)
    // Trim 2: the loop starts 2 beats in (the note at 6 sounds at 8), repeats every 8 beats, ends at 22.
    expect(notes.map((n) => [n.start, n.length, n.pitch])).toEqual([[8, 4, 45], [10, 1, 42], [16, 4, 45], [18, 1, 42]])
    const file = notesMidi(notes, BPM, 0, 32, 'Bass')
    expect(String.fromCharCode(...file.slice(0, 4))).toBe('MThd')
    expect([...file].filter((b, i) => b === 0x90 && file[i + 1] === 42).length).toBe(2)
  })
})

describe('feel and loop variations', () => {
  it("plays a pattern with a loop's groove: each step late or early by its offset, at its accent", () => {
    const steps = Array.from({ length: 16 }, () => 3) as Velocity[]
    const offsets = Array.from({ length: 16 }, (_, k) => (k % 2 ? 0.25 : 0))
    const gains = Array.from({ length: 16 }, (_, k) => (k % 2 ? -6 : 0))
    const clip: PatternClip = { ...pattern(4, 4, steps), groove: { offsets, gains } }
    const ev = eventsInRange(project([clip]), 0, 1000)
    expect(ev).toHaveLength(16)
    expect(ev[0].start).toBeCloseTo(4 * BEAT, 12)
    expect(ev[1].start).toBeCloseTo((4 + 1.25 / 4) * BEAT, 12)
    expect(ev[1].gain).toBeCloseTo(0.501, 3)
    expect(ev[2].gain).toBe(1)
    // The groove follows the bar, not the clip: a clip starting on beat 2 plays step 4 on its first hit.
    const late: PatternClip = { ...pattern(1, 1, steps), groove: { offsets: offsets.map((_, k) => (k === 4 ? 0.2 : 0)), gains } }
    expect(eventsInRange(project([late]), 0, 1000)[0].start).toBeCloseTo((1 + 0.2 / 4) * BEAT, 12)
  })

  it('plays a pitched loop as slices on the grid at the faster rate, and a pitched one-shot at its rate', () => {
    const clip: AudioClip = { ...audio(0, 8, 2), pitch: 12 }
    expect(tempoMode(clip, BPM)).toBe('sliced')
    const ev = eventsInRange(project([clip]), 0, 1000)
    expect(ev).toHaveLength(32)
    ev.forEach((e, j) => {
      expect(e.start).toBeCloseTo(j * BEAT / 4, 12)
      expect(e.offset).toBeCloseTo(j * BEAT / 4, 12)
      expect(e.rate).toBeCloseTo(2, 12)
      expect(e.duration).toBeCloseTo(BEAT / 8, 12)  // an octave up: half a slice of output per 16th
    })
    const down: AudioClip = { ...audio(0, 4, 2), pitch: -2 }
    for (const e of eventsInRange(project([down]), 0, 1000)) expect(e.duration).toBeCloseTo(BEAT / 4, 12)  // cut at the next
    const shot: PatternClip = { ...pattern(0, 4, four()), pitch: -12 }
    expect(eventsInRange(project([shot]), 0, 1000).every((e) => e.rate === 0.5)).toBe(true)
    expect(eventsInRange(project([audio(0, 8, 2)]), 0, 1000).every((e) => e.rate == null)).toBe(true)
  })

  it('repeats only the first bars of a loop when asked', () => {
    const clip: AudioClip = { ...audio(0, 12, 4), loopBars: 1 }
    const ev = eventsInRange(project([clip]), 0, 1000)
    expect(ev.map((e) => [e.start / BEAT, e.offset, e.duration! / BEAT])).toEqual([[0, 0, 4], [4, 0, 4], [8, 0, 4]])
  })

  it('names a bass render after its groove, so a new feel renders again', () => {
    const b = { preset: '/p/A.SerumPreset', presetName: 'A', midiId: 3, midiName: 'm', transpose: 0 }
    expect(bassPath({ ...b, groove: new Array(16).fill(0) }, BPM)).toBe(bassPath(b, BPM))
    const g = bassPath({ ...b, groove: [0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2, 0, 0.2] }, BPM)
    expect(g).not.toBe(bassPath(b, BPM))
    expect(g).toMatch(/-g[0-9a-f]{8}-0-124\.wav$/)
  })
})
