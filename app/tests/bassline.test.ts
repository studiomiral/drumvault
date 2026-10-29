import { describe, expect, it } from 'vitest'
import { generatedMidi, generateBassline, isGenerated, keyOfLine, learnBass, type BassNote } from '../src/generate/bassline'
import { Rng } from '../src/generate/rng'
import type { MidiItem } from '../src/types/api'

/** A bar of [16th step, 16ths held, semitones from the root] on `root`, from bar `bar` on. */
function bar(hits: [number, number, number][], root: number, at = 0): BassNote[] {
  return hits.map(([s, l, iv]) => [at * 4 + s / 4, l / 4, root + iv, 100])
}
const line = (id: number, bars: number, notes: BassNote[], key: string): MidiItem => ({
  id, file_name: `${id}.mid`, name: `Line ${id}`, rel_path: `MIDI/Bass/${id}.mid`, role: 'bass', bars, key_label: key,
  key_camelot: null, notes, favorite: 0, source: null, source_code: null,
})

// Funky house lines the way the library's are built: the root on the 1, the dotted 8ths (steps
// 0, 3, 6) and the offbeats 10 and 14, octave jumps and the b7, a second bar turning its second
// half around, a 4-bar line moving to the VI in bar 3.
const A = 45, F = 53, D = 50, G = 55
const groove: [number, number, number][] = [[0, 2, 0], [3, 1, 12], [6, 2, 10], [8, 2, 0], [11, 1, 12], [14, 2, 10]]
const CORPUS: MidiItem[] = [
  line(1, 2, [...bar(groove, A), ...bar([[0, 2, 0], [3, 1, 12], [6, 2, 10], [8, 1, 0], [10, 2, 0], [12, 1, 15], [14, 2, 19]], A, 1)], 'Am'),
  line(2, 4, [0, 1, 2, 3].flatMap((b) => bar(b === 2
    ? [[0, 2, -4], [3, 1, -4], [6, 2, -4], [10, 2, -4], [14, 2, -4]]
    : b === 3 ? [[0, 2, 0], [3, 1, 0], [6, 2, 0], [8, 1, 3], [10, 1, 5], [12, 2, 7], [14, 2, 10]]
      : [[0, 2, 0], [3, 1, 0], [6, 2, 0], [10, 2, 0], [14, 2, 0]], F, b)), 'Fm'),
  line(3, 1, bar([[0, 2, 0], [3, 2, 0], [6, 1, 10], [7, 1, 0], [8, 2, 12], [10, 2, 0], [12, 2, 0], [14, 2, 10]], D), 'Dm'),
  line(4, 2, [...bar([[0, 2, 0], [3, 1, 0], [6, 2, 3], [8, 2, 7], [10, 2, 7], [14, 2, 7]], G),
    ...bar([[0, 2, 0], [3, 1, 0], [6, 2, 3], [8, 2, 10], [10, 2, 7], [12, 3, 10]], G, 1)], 'Gm'),
  line(5, 2, [...bar([[0, 3, 0], [4, 2, 2], [7, 1, 3], [14, 2, 0]], A), ...bar([[0, 3, 0], [4, 2, 2], [7, 1, 3], [10, 1, 7], [14, 2, -2]], A, 1)], 'Am'),
]

const model = learnBass(CORPUS)!
const MINOR = [0, 2, 3, 5, 7, 8, 10, 11]  // with the approach a semitone under the root
const pc = (n: number) => ((n % 12) + 12) % 12

describe('bassline: what the library has in common', () => {
  it('learns the root on the 1, the favourite steps, the register and how later bars vary', () => {
    expect(model.lines).toBe(5)
    expect([...model.at[0].keys()]).toEqual([0])                              // the 1 is the root
    const fromOne = model.next[0]
    expect(fromOne.indexOf(Math.max(...fromOne))).toBe(3)                     // the dotted 8th after it
    expect(model.register).toBe(D)                                            // the median root: A, A, D, F, G
    expect(model.varies.two).toBe(1)                                          // every 2-bar line varies its bar 2
    expect(model.varies.four).toEqual([0, 1, 1])
    expect(model.from.get(8)).toBeGreaterThan(0)                              // second halves turned around
    expect(model.barMove.get(-4)).toBe(1)                                     // the move to the VI
    expect(model.lengths).toEqual({ 1: 1, 2: 3, 4: 1 })
    expect(Math.min(...model.articulation)).toBeGreaterThan(0.4)
  })

  it('has nothing to learn from without basslines', () => {
    expect(learnBass([])).toBeNull()
    expect(learnBass(CORPUS.map((m) => ({ ...m, role: 'other' as const })))).toBeNull()
  })
})

describe('bassline: writing new ones', () => {
  const lines = Array.from({ length: 300 }, (_, i) => generateBassline(model, new Rng(100 + i), { key: 'Fm' }))

  it('starts on the root of the track key on the 1, in the register of the library', () => {
    for (const l of lines) {
      const [first] = l.notes
      expect(first[0]).toBe(0)
      expect(pc(first[2])).toBe(5)                                            // F
      expect(Math.abs(first[2] - model.register)).toBeLessThanOrEqual(6)
    }
  })

  it('stays in the scale, inside the loop, one note at a time', () => {
    for (const l of lines) {
      expect([1, 2, 4]).toContain(l.bars)
      l.notes.forEach(([s, len, p], i) => {
        expect(MINOR).toContain(pc(p - 5))
        expect(s).toBeGreaterThanOrEqual(0)
        expect(s + len).toBeLessThanOrEqual(l.bars * 4 + 1e-9)
        expect(len).toBeGreaterThan(0)
        const next = l.notes[i + 1]
        if (next) expect(s + len).toBeLessThanOrEqual(next[0] + 1e-9)
      })
    }
  })

  it('plays the rhythms it learned: mostly on the steps the library uses', () => {
    const used = new Set(CORPUS.flatMap((m) => m.notes.map(([s]) => Math.round(s * 4) % 16)))
    const steps = lines.flatMap((l) => l.notes.map(([s]) => Math.round(s * 4) % 16))
    expect(steps.filter((s) => used.has(s)).length / steps.length).toBeGreaterThan(0.95)
    const dotted = lines.filter((l) => l.notes.some(([s]) => s === 0.75)).length  // the dotted 8th after the 1
    expect(dotted / lines.length).toBeGreaterThan(0.5)
  })

  it('makes a longer loop vary: a turned-around second half or the bar on another root', () => {
    const long = lines.filter((l) => l.bars > 1)
    expect(long.length).toBeGreaterThan(150)
    for (const l of long) {
      const bars = Array.from({ length: l.bars }, (_, b) => JSON.stringify(l.notes.filter(([s]) => s >= b * 4 && s < b * 4 + 4)
        .map(([s, , p]) => [s - b * 4, p])))
      expect(new Set(bars).size).toBeGreaterThan(1)
    }
  })

  it('writes the length asked for, the same line for the same seed, and major lines in major', () => {
    for (const n of [1, 2, 4] as const) expect(generateBassline(model, new Rng(7), { key: 'Am', bars: n }).bars).toBe(n)
    expect(generateBassline(model, new Rng(7), { key: 'Am' })).toEqual(generateBassline(model, new Rng(7), { key: 'Am' }))
    for (let i = 0; i < 100; i++) {
      for (const [, , p] of generateBassline(model, new Rng(i), { key: 'C' }).notes) expect([0, 2, 4, 5, 7, 9, 10, 11]).toContain(pc(p))
    }
  })

  it('becomes a bassline the app plays like an imported one', () => {
    const l = lines[0]
    const m = generatedMidi(l, 'Fm')
    expect(isGenerated(m)).toBe(true)
    expect(isGenerated(CORPUS[0])).toBe(false)
    expect(m).toMatchObject({ role: 'bass', bars: l.bars, key_label: 'Fm', notes: l.notes, source: 'generated' })
    expect(generatedMidi(l, 'Fm').id).toBe(m.id)                              // named after its notes
    expect(keyOfLine(l.notes)).toMatch(/^Fm?$/)
    expect(keyOfLine(bar([[0, 2, 0], [6, 2, 4], [10, 2, 7]], 48))).toBe('C')
  })
})
