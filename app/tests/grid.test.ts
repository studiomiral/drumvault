import { describe, expect, it } from 'vitest'
import { beatsIn, blockPeaks, foldAttack, foldBeats, isDownbeat, roundMs } from '../src/grid/analysis'

const SR = 22050
const BEAT = 60 / 124

/** Clicks (sharp attack, short decay) on every beat from `first` seconds, `seconds` long. */
function hits(first: number, seconds = 30): Float32Array {
  const d = new Float32Array(Math.round(seconds * SR))
  for (let t = first; t < seconds - 0.1; t += BEAT) {
    const i0 = Math.round(t * SR)
    for (let i = 0; i < SR * 0.05; i++) d[i0 + i] = Math.exp(-i / (SR * 0.01)) * (i % 2 ? 1 : -1)
  }
  return d
}

describe('grid view maths', () => {
  it('lists the beats of a grid with bar positions, also before bar 1', () => {
    const b = beatsIn(0, 2.1, 0.5, 0.5)
    expect(b.map((x) => x.time)).toEqual([0, 0.5, 1, 1.5, 2])
    expect(b.map((x) => x.index)).toEqual([-1, 0, 1, 2, 3])
    expect(b.map((x) => isDownbeat(x.index))).toEqual([false, true, false, false, false])
    expect(isDownbeat(-4)).toBe(true)
  })

  it('stacks every beat so hits on the grid pile up on the centre line', () => {
    const data = hits(0.2)
    for (const [guess, late] of [[0.2, 0], [0.188, 0.012], [0.215, -0.015]]) {
      const fold = foldBeats(data, SR, guess, BEAT, 0.05, 400)
      const a = foldAttack(fold, 0.05)!
      expect(Math.abs(a - late)).toBeLessThan(0.0006)
    }
  })

  it('folds coarse peaks for the wide view and finds the hits there too', () => {
    const data = hits(0.31)
    const coarse = blockPeaks(data, 16)
    expect(coarse.length).toBe(Math.ceil(data.length / 16))
    const a = foldAttack(foldBeats(coarse, SR / 16, 0.25, BEAT, BEAT / 4, 240), BEAT / 4)!
    expect(Math.abs(a - 0.06)).toBeLessThan(0.002)
  })

  it('finds no attack in silence and rounds bar 1 to 0.1 ms', () => {
    expect(foldAttack(foldBeats(new Float32Array(SR * 5), SR, 0, BEAT, 0.05, 100), 0.05)).toBeNull()
    expect(roundMs(0.0123456)).toBe(0.0123)
    expect(roundMs(-0.00777)).toBe(-0.0078)
  })
})
