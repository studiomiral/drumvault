import { describe, expect, it } from 'vitest'
import {
  generatedMidi, generateBassline, isGenerated, keyOfLine, learnBass, loopBeatsOf, playedNotes, turnOf, type BassNote, type LoopBeats,
} from '../src/generate/bassline'
import { Rng } from '../src/generate/rng'
import type { MidiItem } from '../src/types/api'

/** A bar of [16th step, 16ths held, semitones from the root] on `root`, from bar `bar` on. */
function bar(hits: [number, number, number][], root: number, at = 0, vel = 100): BassNote[] {
  return hits.map(([s, l, iv]) => [at * 4 + s / 4, l / 4, root + iv, vel])
}
const line = (id: number, bars: number, notes: BassNote[], key: string, favorite = 0): MidiItem => ({
  id, file_name: `${id}.mid`, name: `Line ${id}`, rel_path: `MIDI/Bass/${id}.mid`, role: 'bass', bars, key_label: key,
  key_camelot: null, notes, favorite, source: null, source_code: null,
})

// Funky house lines the way the library's are built: the root on the 1, the dotted 8ths (steps
// 0, 3, 6) and the offbeats 10 and 14, octave jumps and the b7; an 8-beat line answering its first
// bar from its second half; a 2-beat cell saved as a 4-bar file; a line that only repeats after 16 beats.
const A = 45, F = 53, D = 50, G = 55
const groove: [number, number, number][] = [[0, 2, 0], [3, 1, 12], [6, 2, 10], [8, 2, 0], [11, 1, 12], [14, 2, 10]]
const cell2: [number, number, number][] = [[0, 2, 0], [3, 1, 12], [6, 1, 10]]
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
  line(6, 4, [0, 1, 2, 3].flatMap((b) => [...bar(cell2, D, b), ...bar(cell2.map(([s, l, iv]) => [s + 8, l, iv]), D, b)]), 'Dm'),
]

const model = learnBass(CORPUS)!
const MINOR = [0, 2, 3, 5, 7, 8, 10, 11]  // with the approach a semitone under the root
const pc = (n: number) => ((n % 12) + 12) % 12
const step = (s: number) => Math.round(s * 4)
/** A bar's notes as [16th, pitch]. */
const barOf = (notes: BassNote[], b: number) => JSON.stringify(notes.filter(([s]) => s >= b * 4 && s < b * 4 + 4).map(([s, , p]) => [step(s) - b * 16, p]))

describe('bassline: what the library has in common', () => {
  it('learns how long the lines really are before they repeat, whatever their file length', () => {
    expect(model.periods).toEqual({ 2: 1, 4: 1, 8: 3 })                       // the 4-bar file of a 2-beat cell is a 2-beat loop
    expect(model.long).toBe(1)                                                // the 16-beat line, learned as two 8-beat loops
    expect(model.lines).toBe(7)
    expect(loopBeatsOf(CORPUS[5].notes, 4)).toBe(2)
    expect(loopBeatsOf(CORPUS[0].notes, 2)).toBe(8)
    expect(loopBeatsOf(CORPUS[1].notes, 4)).toBe(16)
  })

  it('keeps the rhythms whole: 2- and 4-beat cells, the dotted 8ths most of all', () => {
    const top = [...model.cells[8]].sort((a, b) => b.weight - a.weight)[0]
    expect(top.hits.map((h) => h.step)).toEqual([0, 3, 6])
    expect(model.cells[16].every((c) => c.hits.every((h) => h.step < 16))).toBe(true)
    expect(model.cells[8].every((c) => c.hits.every((h) => h.step < 8))).toBe(true)
  })

  it('learns how an 8-beat loop answers its first bar, the notes on the 1, and where lines sit', () => {
    // The 8-beat lines answer from their second halves (the 16-beat line's bar on the VI from its 1:
    // learned as it is, but a new line only ever answers in its last two beats).
    expect(model.answers.filter((a) => a.from >= 8).length).toBeGreaterThanOrEqual(3)
    expect(model.at[0].get(0)).toBeGreaterThan(([...model.at[0].values()].reduce((a, b) => a + b, 0)) / 2)  // the 1: the root, mostly
    expect(model.register).toBe(D)
    for (const k of ['n', 'off', 'onKick', 'fill', 'leap'] as const) expect(model.feel[k][0]).toBeLessThanOrEqual(model.feel[k][1])
  })

  it('counts a favourite line more', () => {
    const fav = learnBass(CORPUS.map((m) => (m.id === 5 ? { ...m, favorite: 1 } : m)))!
    const of5 = (m: typeof model) => m.cells[16].find((c) => c.hits.map((h) => h.step).join() === '0,4,7,14')!.weight
    expect(of5(fav)).toBe(3 * of5(model))
  })

  it('has nothing to learn from without basslines', () => {
    expect(learnBass([])).toBeNull()
    expect(learnBass(CORPUS.map((m) => ({ ...m, role: 'other' as const })))).toBeNull()
  })
})

describe('bassline: writing new ones', () => {
  const lines = Array.from({ length: 300 }, (_, i) => generateBassline(model, new Rng(100 + i), { key: 'Fm' }))

  it('starts on the root of the track key, in the register of the library', () => {
    for (const l of lines) {
      const [first] = l.notes
      expect(pc(first[2])).toBe(5)                                            // F
      expect(Math.abs(first[2] - model.register)).toBeLessThanOrEqual(6)
      if (l.beats > 2) expect(first[0]).toBe(0)                               // every 4-beat rhythm here starts on the 1
    }
  })

  it('stays in the scale, inside the loop, one note at a time, never held across a kick', () => {
    for (const l of lines) {
      expect(l.bars).toBe(l.beats === 8 ? 2 : 1)
      l.notes.forEach(([s, len, p], i) => {
        expect(MINOR).toContain(pc(p - 5))
        expect(s).toBeGreaterThanOrEqual(0)
        expect(s + len).toBeLessThanOrEqual(l.bars * 4 + 1e-9)
        expect(len).toBeGreaterThan(0)
        expect(s + len).toBeLessThanOrEqual(Math.floor(s) + 1 + 1e-9)          // ends by the next beat
        const next = l.notes[i + 1]
        if (next) expect(s + len).toBeLessThanOrEqual(next[0] + 1e-9)        // (no slide without a gliding patch)
      })
    }
  })

  it('is a strict loop: a 2-beat cell played twice, an 8-beat loop answering only in its last beats', () => {
    const by = (n: LoopBeats) => lines.filter((l) => l.beats === n)
    for (const n of [2, 4, 8] as const) expect(by(n).length).toBeGreaterThan(30)
    for (const l of by(2)) {
      const half = (h: number) => JSON.stringify(l.notes.filter(([s]) => s >= h * 2 && s < h * 2 + 2).map(([s, , p]) => [step(s) - h * 8, p]))
      expect(half(1)).toBe(half(0))
    }
    for (const l of by(8)) {
      expect(barOf(l.notes, 1)).not.toBe(barOf(l.notes, 0))
      const early = (b: number) => JSON.stringify(l.notes.filter(([s]) => s >= b * 4 && s < b * 4 + 2).map(([s, , p]) => [step(s) - b * 16, p]))
      expect(early(1)).toBe(early(0))                                         // the first two beats as bar 1
    }
  })

  it('plays the rhythms it learned, mostly as they are, and never a library line as it is', () => {
    const used = new Set(CORPUS.flatMap((m) => m.notes.map(([s]) => step(s) % 16)))
    const steps = lines.flatMap((l) => l.notes.map(([s]) => step(s) % 16))
    expect(steps.filter((s) => used.has(s)).length / steps.length).toBeGreaterThan(0.9)
    const dotted = lines.filter((l) => l.notes.some(([s]) => s === 0.75)).length  // the dotted 8th after the 1
    expect(dotted / lines.length).toBeGreaterThan(0.5)
    const library = new Set(CORPUS.flatMap((m) => {
      const root = m.notes[0][2]
      return [0, 1, 2, 3].map((b) => barOf(m.notes.map(([s, l, p, v]): BassNote => [s, l, p - root + 53, v]), b))
    }))
    expect(lines.filter((l) => library.has(barOf(l.notes, 0))).length).toBe(0)
  })

  it('grooves like the library: as many notes per bar, off the beat as much, a few different notes', () => {
    const [lo, hi] = model.feel.n
    const inRange = lines.filter((l) => {
      const n = l.notes.filter(([s]) => s < 4).length
      return n >= lo - 1 && n <= hi + 1
    })
    expect(inRange.length / lines.length).toBeGreaterThan(0.9)
    for (const l of lines) {
      const pitches = new Set(l.notes.filter(([s]) => s < 4).map(([, , p]) => p))
      expect(pitches.size).toBeLessThanOrEqual(5)
    }
  })

  it('keeps the accents and ghost notes of the rhythm it plays', () => {
    const ghosts = learnBass([line(1, 1, [...bar([[0, 2, 0], [6, 2, 12], [10, 1, 10], [14, 2, 0]], A), ...bar([[3, 1, 0], [11, 1, 0]], A, 0, 50)]
      .sort((a, b) => a[0] - b[0]), 'Am')])!
    const l = generateBassline(ghosts, new Rng(3), { key: 'Am', beats: 4 })
    const vel = (st: number) => l.notes.find(([s]) => step(s) === st)?.[3]
    if (vel(3) != null) expect(vel(3)).toBeLessThan(70)
    expect(vel(0)).toBe(100)
  })

  it('slides one note into the next on a patch that glides: within a beat, by a 32nd', () => {
    let slid = 0
    for (let i = 0; i < 200; i++) {
      const l = generateBassline(model, new Rng(500 + i), { key: 'Am', glide: true })
      const over = l.notes.slice(0, -1).filter(([s, len], j) => s + len > l.notes[j + 1][0] + 1e-9)
      expect(over.length).toBeLessThanOrEqual(1)
      for (const [s, len] of over) {
        const next = l.notes.find(([t]) => t > s)!
        expect(s + len - next[0]).toBeCloseTo(0.125)
        expect(Math.floor(next[0])).toBe(Math.floor(s))
        expect(step(next[0]) % 4).not.toBe(0)
      }
      slid += over.length
    }
    expect(slid).toBeGreaterThan(30)
  })

  it('writes the length asked for, the same line for the same seed, and major lines in major', () => {
    for (const n of [2, 4, 8] as const) {
      const l = generateBassline(model, new Rng(7), { key: 'Am', beats: n })
      expect([l.beats, loopBeatsOf(l.notes, l.bars)]).toEqual([n, n])
    }
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
    expect(m.name).toMatch(new RegExp(`\\(${l.beats} beats\\)$`))
    expect(generatedMidi(l, 'Fm').id).toBe(m.id)                              // named after its notes
    expect(keyOfLine(l.notes)).toMatch(/^Fm?$/)
    expect(keyOfLine(bar([[0, 2, 0], [6, 2, 4], [10, 2, 7]], 48))).toBe('C')
  })
})

describe('bassline: the turn at the end of a phrase', () => {
  const loop: BassNote[] = bar([[0, 2, 0], [3, 1, 12], [6, 2, 10], [8, 2, 0], [12, 3, 0], [14, 1, 12]], A)

  it('changes only the last beat: left out, an octave up, or a 16th run into the 1', () => {
    const early = (n: BassNote[]) => n.filter(([s]) => s < 3)
    const gap = turnOf(loop, 1, 'gap')
    expect(gap.every(([s, l]) => s + l <= 3 + 1e-9)).toBe(true)
    expect(early(gap)).toEqual(early(loop))
    const oct = turnOf(loop, 1, 'octave')
    expect(oct.filter(([s]) => s >= 3).map(([, , p]) => p)).toEqual([A + 12, A])  // down where it is high already
    const run = turnOf(loop, 1, 'pickup')
    const last = run.filter(([s]) => s >= 3)
    expect(last.map(([s]) => s)).toEqual([3.25, 3.5, 3.75])
    expect(last.every(([s, l]) => s + l <= 4)).toBe(true)
    expect(last.every(([, , p]) => MINOR.includes(pc(p - A)))).toBe(true)
    expect(turnOf(loop, 1, 'pickup')).toEqual(run)                            // the same notes, the same turn
    // An 8-beat loop turns its last beat only.
    const two = [...loop, ...bar([[0, 2, 0], [6, 2, 7], [12, 2, 10]], A, 1)]
    expect(turnOf(two, 2, 'gap').filter(([s]) => s < 7)).toEqual(two.filter(([s]) => s < 7))
  })

  it('is what a turned clip renders and exports; a plain one plays its notes', () => {
    expect(playedNotes({ notes: loop, bars: 1, turn: 'gap' })).toEqual(turnOf(loop, 1, 'gap'))
    expect(playedNotes({ notes: loop, bars: 1 })).toBe(loop)
    expect(playedNotes({ turn: 'gap' })).toBeUndefined()
  })
})
