import { describe, expect, it } from 'vitest'
import { chordAt, chordName, chordOf, followBass, generatePiano, learnPiano, minorTonic, pianoMidi, type PianoPart } from '../src/generate/piano'
import { Rng } from '../src/generate/rng'
import type { MidiItem } from '../src/types/api'

type N = [number, number, number, number]
const midi = (id: number, name: string, bars: number, notes: N[], key: string | null = null): MidiItem => ({
  id, file_name: `${name}.mid`, name, rel_path: `MIDI/Piano/${name}.mid`, role: 'piano', bars, key_label: key, key_camelot: null,
  notes, favorite: 0, source: null, source_code: null,
})
const chord = (at: number, len: number, pitches: number[], v = 100): N[] => pitches.map((p) => [at, len, p, v])

// A house piano loop: Am7 on the offbeats of every bar (A C E G), a pickup single note.
const LOOP = midi(1, 'Organ Loop', 2, [0, 1].flatMap((b) => [
  ...chord(b * 4 + 0.5, 0.4, [57, 60, 64, 67]), ...chord(b * 4 + 1.5, 0.4, [57, 60, 64, 67]),
  ...chord(b * 4 + 2.5, 0.4, [57, 60, 64, 67]), ...chord(b * 4 + 3.5, 0.25, [57, 60, 64, 67]),
]), 'Am')
// A progression: Am, F, C, G (a bar each), on the 1 and the "and" of 2.
const TRIADS = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]]
const PROG = midi(2, 'Piano Chords', 4, TRIADS.flatMap((t, b) => [...chord(b * 4, 1.25, t), ...chord(b * 4 + 1.5, 2, t)]))

describe('Piano (SCOPE.md §6.9a)', () => {
  it('reads chords from their notes, rootless and inverted too', () => {
    expect(chordOf([57, 60, 64, 67])).toEqual({ root: 9, quality: 'min7' })
    expect(chordOf([53, 57, 60])).toEqual({ root: 5, quality: 'maj' })
    expect(chordOf([52, 55, 60])).toEqual({ root: 0, quality: 'maj' })       // C, first inversion
    expect(chordOf([60])).toBeNull()
    // The key from the notes (a major key counts from its relative minor): A minor's notes.
    expect(minorTonic(PROG.notes.map(([s, l, p, v]) => ({ s, l, p, v })), null)).toBe(9)
  })

  it('learns loops and progressions apart, with their chords relative to the key', () => {
    const m = learnPiano([LOOP, PROG])!
    const loop = m.examples.find((e) => e.kind === 'loop')!
    const prog = m.examples.find((e) => e.kind === 'progression')!
    expect(loop.bars).toBe(1)
    expect(loop.chords.map((c) => [c.root, c.quality])).toEqual([[0, 'min7']])
    expect(loop.rhythm.bars).toBe(1)
    expect(loop.rhythm.hits.map((h) => h.step)).toEqual([2, 6, 10, 14])
    expect(prog.bars).toBe(4)
    // i, VI, III, VII of A minor.
    expect(prog.chords.map((c) => [c.root, c.quality])).toEqual([[0, 'min'], [8, 'maj'], [3, 'maj'], [10, 'maj']])
    expect(m.shapes.get('min7')?.[0].shape).toEqual([0, 3, 7, 10])
    // Only the Piano tab's parts.
    expect(learnPiano([{ ...PROG, role: 'bass' }])).toBeNull()
  })

  it('writes a progression in the track key, each hit a chord of it, the same for the same seed', () => {
    const m = learnPiano([LOOP, PROG])!
    const p = generatePiano(m, new Rng(7), { key: 'Dm', kind: 'progression' })!
    expect(p.kind).toBe('progression')
    expect(p.bars % 4).toBe(0)
    expect(p.chords[0].root).toBe(0)
    expect(chordName(p.chords[0], 'Dm')).toBe('Dm')
    // Every note is a tone of the chord sounding there (or of the one it pushes into).
    const tones = (c: { root: number; quality: string }) => {
      const t = { min: [0, 3, 7], maj: [0, 4, 7], min7: [0, 3, 7, 10], dom7: [0, 4, 7, 10], maj7: [0, 4, 7, 11] }[c.quality] ?? [0, 4, 7]
      return t.map((i) => (2 + c.root + i) % 12)
    }
    for (const [s, , pitch] of p.notes) {
      const ok = [chordAt(p.chords, p.bars, s), chordAt(p.chords, p.bars, s + 0.5)].some((c) => tones(c).includes(pitch % 12))
      expect(ok).toBe(true)
    }
    expect(generatePiano(m, new Rng(7), { key: 'Dm', kind: 'progression' })).toEqual(p)
    // No key: no piano.
    expect(generatePiano(m, new Rng(7), { key: null })).toBeNull()
  })

  it('keeps a loop on the key: a minor chord on the minor tonic, in any key', () => {
    const m = learnPiano([LOOP])!
    const minor = generatePiano(m, new Rng(3), { key: 'Fm' })!
    expect(minor.kind).toBe('loop')
    expect(chordName(minor.chords[0], 'Fm')).toBe('Fm7')
    const major = generatePiano(m, new Rng(3), { key: 'C' })!
    expect(chordName(major.chords[0], 'C')).toBe('Am7')
    expect(pianoMidi(major, 'C').role).toBe('piano')
  })

  it('moves the bassline onto the chords of a progression, and fits a loop\'s third', () => {
    // A 1-bar line on A: root, octave, 5th.
    const line: N[] = [[0, 0.5, 45, 100], [1.5, 0.25, 57, 90], [3, 0.5, 52, 100]]
    const part: PianoPart = {
      kind: 'progression', bars: 4, notes: [],
      chords: [{ at: 0, beats: 4, root: 0, quality: 'min' }, { at: 4, beats: 4, root: 8, quality: 'maj' },
        { at: 8, beats: 4, root: 3, quality: 'maj' }, { at: 12, beats: 4, root: 10, quality: 'maj' }],
    }
    const b = followBass(line, 1, part, 'Am')
    expect(b.bars).toBe(4)
    const firsts = [0, 4, 8, 12].map((t) => b.notes.find((n) => n[0] === t)![2])
    expect(firsts).toEqual([45, 41, 48, 43])        // A, F (down), C (up), G (down)
    // Bar 2's octave and fifth are F's.
    expect(b.notes.filter((n) => n[0] >= 4 && n[0] < 8).map((n) => n[2])).toEqual([41, 53, 48])
    // Under a loop of a major chord the line keeps its notes, its minor third made major.
    const loop: PianoPart = { kind: 'loop', bars: 1, notes: [], chords: [{ at: 0, beats: 4, root: 3, quality: 'maj' }] }
    const minorThird: N[] = [[0, 0.5, 48, 100], [1, 0.5, 51, 100]]
    expect(followBass(minorThird, 1, loop, 'Am').notes.map((n) => n[2])).toEqual([48, 52])
  })
})
