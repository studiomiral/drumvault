import { describe, expect, it } from 'vitest'
import { ALL_KEYS } from '../src/lib/camelot'
import { Rng } from '../src/generate/rng'
import { LYRICS, PHRASES, pickLines } from '../src/vocals/lyrics'
import { compositionPlan, isPhrase, randomVocal, takeSeconds } from '../src/vocals/plan'

describe('vocals', () => {
  const rng = new Rng(5)
  const keys = ALL_KEYS.map((k) => k.label)
  const takes = Array.from({ length: 2000 }, () => randomVocal(124, keys, (n, phrases) => pickLines(n, () => rng.next(), phrases ? PHRASES : LYRICS), () => rng.next()))
  const share = (f: (t: (typeof takes)[number]) => boolean) => takes.filter(f).length / takes.length

  it('draws mostly female, gospel or soulful vocals, the rest with a chance', () => {
    expect(share((t) => t.voice === 'female')).toBeGreaterThan(0.7)
    expect(share((t) => t.voice === 'male')).toBeGreaterThan(0.15)
    expect(share((t) => t.mood === 'gospel' || t.mood === 'soulful')).toBeGreaterThan(0.65)
    for (const m of ['airy', 'deep', 'uplifting', 'dark']) expect(share((t) => t.mood === m)).toBeGreaterThan(0.03)
    expect(share((t) => !!t.key?.endsWith('m'))).toBeGreaterThan(0.6)
    expect(new Set(takes.map((t) => t.key)).size).toBe(24)
  })

  it('makes mostly short takes, long enough for an 8-bar phrase', () => {
    const lengths = new Set(takes.map((t) => t.seconds))
    expect([...lengths].sort((a, b) => a - b)).toEqual([takeSeconds(8, 124), takeSeconds(12, 124), takeSeconds(16, 124)])
    expect(takeSeconds(8, 124)).toBeGreaterThanOrEqual((8 * 4 * 60) / 124)
    expect(share((t) => t.seconds === takeSeconds(16, 124))).toBeLessThan(0.45)
    expect(takes.reduce((n, t) => n + t.seconds, 0) / takes.length).toBeLessThan(28)
  })

  it('sings a chant, a pair, a longer phrase or two phrases of the bank, repeated through the take', () => {
    expect(PHRASES.every(isPhrase)).toBe(true)
    expect(LYRICS.some(isPhrase)).toBe(false)
    const phrased = share((t) => t.lines.some(isPhrase))
    expect(phrased).toBeGreaterThan(0.4)
    expect(phrased).toBeLessThan(0.6)
    expect(share((t) => t.lines.filter(isPhrase).length === 2)).toBeGreaterThan(0.05)
    // Phrases get room: never the shortest takes.
    for (const t of takes.filter((x) => x.lines.some(isPhrase))) expect(t.seconds).toBeGreaterThanOrEqual(takeSeconds(12, 124))
    for (const t of takes.slice(0, 200)) {
      expect(t.lines.length).toBeGreaterThanOrEqual(1)
      expect(t.lines.length).toBeLessThanOrEqual(2)
      expect(new Set(t.lines).size).toBe(t.lines.length)
      for (const l of t.lines) expect([...LYRICS, ...PHRASES]).toContain(l)
      const plan = compositionPlan(t)
      expect(plan.sections[0].lines.length).toBeLessThanOrEqual(30)
      expect(plan.sections[0].lines.every((l) => t.lines.includes(l))).toBe(true)
      expect(plan.positive_global_styles).toContain('124 bpm')
    }
  })
})
