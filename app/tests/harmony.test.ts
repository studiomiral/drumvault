import { describe, expect, it } from 'vitest'
import { generateBassline, learnBass, type BassNote } from '../src/generate/bassline'
import { bassFor, clashShare, harmonyOf, moves, pairScore, progressionName } from '../src/generate/harmony'
import { generateKeys, learnKeys } from '../src/generate/keys'
import { Rng } from '../src/generate/rng'
import type { MidiItem } from '../src/types/api'

const item = (id: number, role: 'bass' | 'keys', bars: number, notes: BassNote[], key = 'Cm'): MidiItem => ({
  id, file_name: `${id}.mid`, name: `Part ${id}`, rel_path: '', role, bars, key_label: key, key_camelot: null, notes,
  favorite: 0, source: null, source_code: null,
})
/** A chord held for `beats` from `at`, its notes at these pitches. */
const chord = (at: number, beats: number, pitches: number[], vel = 96): BassNote[] => pitches.map((p) => [at, beats, p, vel])

// C minor, i – VI – VII – i, voiced the way house chords are (inversions, a 7th on top).
const Cm7 = [60, 63, 67, 70]
const Ab = [60, 63, 68]        // Ab major over its 3rd (first inversion)
const Bb = [62, 65, 70]        // Bb major over its 3rd
const PADS: BassNote[] = [...chord(0, 4, Cm7), ...chord(4, 4, Ab), ...chord(8, 4, Bb), ...chord(12, 4, Cm7)]
// The same progression as offbeat stabs.
const STABS: BassNote[] = [Cm7, Ab, Bb, Cm7].flatMap((c, b) => [0.5, 1.5, 2.5, 3.5].flatMap((s) => chord(b * 4 + s, 0.25, c)))

describe('harmony: what a keys part plays', () => {
  it('finds the chord roots half a bar at a time, inversions too', () => {
    const h = harmonyOf(PADS, 4, 'Cm')
    expect(h.roots).toEqual([0, 0, -4, -4, -2, -2, 0, 0])
    expect(progressionName(h)).toBe('i – VI – VII – i')
    expect(moves(h)).toBe(true)
    expect(progressionName(harmonyOf(chord(0, 4, [60, 64, 67]), 1, 'C'))).toBe('I')
    // A club loop on one chord, stabbed in its own rhythm, is that chord.
    const vamp = harmonyOf(STABS.filter(([s]) => s < 4).flatMap(([s, l, p, v]) => [0, 4].map((o): BassNote => [s + o, l, p, v])), 2, 'Cm')
    expect(moves(vamp)).toBe(false)
    expect(progressionName(vamp)).toBe('i')
  })

  it('hears a bass note rub a semitone against a chord tone', () => {
    const cm = harmonyOf(chord(0, 4, Cm7), 1, 'Cm')
    expect(clashShare(cm, { notes: [[0, 1, 36, 100], [2, 1, 43, 100]], bars: 1 })).toBe(0)       // C and G
    expect(clashShare(cm, { notes: [[0, 1, 36, 100], [2, 1, 47, 100]], bars: 1 })).toBe(0.5)     // B against C
  })
})

// Two-bar funky lines on the root, the octave and the b7, in two rhythms (dotted 8ths, and
// offbeats): what the bass model learns from.
const RHYTHMS = [[0, 3, 6, 8, 11, 14], [0, 2, 6, 8, 10, 14]]
const LINES: MidiItem[] = [36, 41, 43, 38, 40, 45].map((root, i) => item(10 + i, 'bass', 2, [0, 1].flatMap((b) =>
  RHYTHMS[i % 2].map((step, j): BassNote => [b * 4 + step / 4, 0.25, root + [0, 12, 10, 0, 12, b ? 7 : 10][j], 100])),
['Cm', 'Fm', 'Gm', 'Dm', 'Em', 'Am'][i]))
const bassModel = learnBass(LINES)!

// Keys to learn from: a one-chord Cm7 loop in its own offbeat rhythm, and i – VI – VII – i pads.
const keysModel = learnKeys([item(1, 'keys', 1, STABS.filter(([s]) => s < 4)), item(2, 'keys', 4, PADS)])!

describe('a bass riff and keys that go together, neither rewritten', () => {
  it('writes the riff as it would alone, at the length asked, when nothing else is kept', () => {
    expect(bassFor(bassModel, new Rng(3), { key: 'Cm', bars: 1 }, null)).toEqual(generateBassline(bassModel, new Rng(3), { key: 'Cm', bars: 1 }))
    const keys = harmonyOf(PADS, 4, 'Cm')
    for (let i = 0; i < 20; i++) expect(bassFor(bassModel, new Rng(i), { key: 'Cm', bars: 1 }, keys).bars).toBe(1)
  })

  it('picks the keys loop that goes with the riff', () => {
    let fit = 0
    let free = 0
    let oneChord = 0
    for (let i = 0; i < 40; i++) {
      const riff = generateBassline(bassModel, new Rng(200 + i), { key: 'Cm', bars: 1 })
      const picked = generateKeys(keysModel, new Rng(i), { key: 'Cm', bass: riff })
      const any = generateKeys(keysModel, new Rng(i), { key: 'Cm' })
      fit += pairScore(harmonyOf(picked.notes, picked.bars, 'Cm'), riff)
      free += pairScore(harmonyOf(any.notes, any.bars, 'Cm'), riff)
      if (!moves(harmonyOf(picked.notes, picked.bars, 'Cm'))) oneChord++
    }
    expect(fit).toBeGreaterThan(free)
    expect(oneChord).toBeGreaterThan(30)        // a riff on one chord gets keys on that chord
  })

  it('under kept keys, picks the riff that rubs least against them', () => {
    const keys = harmonyOf(PADS, 4, 'Cm')
    let fit = 0
    let free = 0
    for (let i = 0; i < 30; i++) {
      fit += pairScore(keys, bassFor(bassModel, new Rng(i), { key: 'Cm', bars: 2 }, keys))
      free += pairScore(keys, generateBassline(bassModel, new Rng(i), { key: 'Cm', bars: 2 }))
    }
    expect(fit).toBeGreaterThan(free)
  })
})

describe('keys parts', () => {
  it('stays above the bass and never holds a note into its own next hit', () => {
    const low = learnKeys([item(3, 'keys', 1, [...chord(0, 3, [36, 39, 43]), ...chord(2, 2, [36, 39, 43])])])!
    for (let i = 0; i < 20; i++) {
      const l = generateKeys(low, new Rng(i), { key: 'Cm', bars: 1 })
      expect(Math.min(...l.notes.map((n) => n[2]))).toBeGreaterThanOrEqual(48)
      for (const [s, len, p] of l.notes) {
        expect(l.notes.some(([s2, , p2]) => p2 === p && s2 > s && s2 < s + len - 1e-9)).toBe(false)
      }
    }
  })
})
