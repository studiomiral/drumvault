import { describe, expect, it } from 'vitest'
import { generateBassline, learnBass, type BassNote } from '../src/generate/bassline'
import { bassRoots, diatonic, fitScore, harmonyOf, moves, progressionName, soundingAt } from '../src/generate/harmony'
import { generateKeys, learnKeys } from '../src/generate/keys'
import { Rng } from '../src/generate/rng'
import type { MidiItem } from '../src/types/api'

const pc = (n: number) => ((n % 12) + 12) % 12
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
    expect(h.stabs).toEqual([])
    expect(harmonyOf(STABS, 4, 'Cm').stabs).toEqual([2, 6, 10, 14])
    expect(progressionName(harmonyOf(chord(0, 4, [60, 64, 67]), 1, 'C'))).toBe('I')
    expect(moves(harmonyOf(chord(0, 4, Cm7), 1, 'Cm'))).toBe(false)
  })

  it('moves a bass interval by scale steps onto another chord', () => {
    // Over Ab (the VI of C minor): the root, the minor 3rd and the 5th of C become Ab, C and Eb.
    expect([0, 3, 7, 10, 12].map((iv) => diatonic(iv, -4, true))).toEqual([-4, 0, 3, 7, 8])
    expect(diatonic(0, -2, true)).toBe(-2)              // Bb, the VII
    expect(diatonic(4, 5, false)).toBe(9)               // in C major, E over F is A: the IV's 3rd
  })
})

// Two-bar funky lines on the root, the octave and the b7, in two rhythms (dotted 8ths, and
// offbeats): what the bass model learns from.
const RHYTHMS = [[0, 3, 6, 8, 11, 14], [0, 2, 6, 8, 10, 14]]
const LINES: MidiItem[] = [36, 41, 43, 38, 40, 45].map((root, i) => item(10 + i, 'bass', 2, [0, 1].flatMap((b) =>
  RHYTHMS[i % 2].map((step, j): BassNote => [b * 4 + step / 4, 0.25, root + [0, 12, 10, 0, 12, b ? 7 : 10][j], 100])),
['Cm', 'Fm', 'Gm', 'Dm', 'Em', 'Am'][i]))
const bassModel = learnBass(LINES)!

describe('bass on the keys\' chords', () => {
  const h = harmonyOf(PADS, 4, 'Cm')
  const lines = Array.from({ length: 60 }, (_, i) => generateBassline(bassModel, new Rng(500 + i), { key: 'Cm', bars: 1, harmony: h }))

  it('is as long as the progression and plays each chord\'s root on its 1', () => {
    for (const l of lines) {
      expect(l.bars).toBe(4)
      for (let bar = 0; bar < 4; bar++) {
        const one = l.notes.find(([s]) => s === bar * 4)!
        expect(pc(one[2])).toBe(pc([0, 8, 10, 0][bar]))   // C, Ab, Bb, C
      }
    }
  })

  it('never rubs a semitone against a chord tone that sounds', () => {
    for (const l of lines) {
      for (const [s, , p] of l.notes) {
        const sounding = soundingAt(h, s)
        if (!sounding.has(pc(p))) expect(sounding.has(pc(p + 1)) || sounding.has(pc(p - 1))).toBe(false)
      }
    }
  })

  it('plays around offbeat chord stabs', () => {
    const stabs = harmonyOf(STABS, 4, 'Cm')
    const onStabs = (withHarmony: boolean) => {
      let hits = 0
      for (let i = 0; i < 80; i++) {
        const l = generateBassline(bassModel, new Rng(900 + i), { key: 'Cm', bars: 1, harmony: withHarmony ? stabs : null })
        hits += l.notes.filter(([s]) => s < 4 && s > 0 && stabs.stabs.includes(Math.round(s * 4))).length
      }
      return hits
    }
    expect(onStabs(true)).toBeLessThan(onStabs(false))
  })

  it('writes the same line as before when the track has no keys', () => {
    expect(generateBassline(bassModel, new Rng(3), { key: 'Cm', harmony: null }))
      .toEqual(generateBassline(bassModel, new Rng(3), { key: 'Cm' }))
  })
})

describe('keys fitting a bassline that stays', () => {
  // Two progressions to learn from: i – VI – VII – i and i – iv – v – i.
  const iv = [60, 65, 68]
  const v = [62, 67, 70]
  const keysModel = learnKeys([
    item(1, 'keys', 4, PADS),
    item(2, 'keys', 4, [...chord(0, 4, Cm7), ...chord(4, 4, iv), ...chord(8, 4, v), ...chord(12, 4, Cm7)]),
  ])!
  // A bass on C, Ab, Bb, C.
  const bass = { notes: [0, 8, 10, 0].map((r, b): BassNote => [b * 4, 1, 36 + r - (r > 5 ? 12 : 0), 100]), bars: 4 }
  const roots = bassRoots(bass.notes, 4, 0)

  it('picks the chords the bass plays roots of', () => {
    expect(roots).toEqual([0, 0, -4, -4, -2, -2, 0, 0])
    let fit = 0
    let free = 0
    for (let i = 0; i < 40; i++) {
      fit += fitScore(harmonyOf(generateKeys(keysModel, new Rng(i), { key: 'Cm', bars: 4, bass }).notes, 4, 'Cm'), roots)
      free += fitScore(harmonyOf(generateKeys(keysModel, new Rng(i), { key: 'Cm', bars: 4 }).notes, 4, 'Cm'), roots)
    }
    expect(fit).toBeGreaterThan(free)
    expect(fit / 40).toBeGreaterThan(1.5)
  })

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
