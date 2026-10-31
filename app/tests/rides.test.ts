import { describe, expect, it } from 'vitest'
import { mixHighpassOf, rideBar, ridePieces } from '../src/generate/rides'
import type { TrackArrangement } from '../src/types/api'

describe('rides: what a bar measured means', () => {
  it('reads darker as a low-pass, thinner and quieter as a high-pass, quieter as the fader', () => {
    expect(rideBar(0, 0)).toBeNull()
    expect(rideBar(-1, 0.1)).toBeNull()                       // the music, not a ride
    expect(rideBar(null, null)).toBeNull()                    // silent
    const lp = rideBar(-6, -2)!
    expect(lp.type).toBe('lowpass')
    expect(lp.hz).toBeGreaterThan(400)
    expect(lp.hz).toBeLessThan(1200)
    expect(lp.db).toBe(-3)                                    // half of it is the filter's
    expect(rideBar(-4, -1)!.hz).toBeGreaterThan(lp.hz)        // less dark: a higher cutoff
    const hp = rideBar(-8, 0.5)!
    expect(hp.type).toBe('highpass')
    expect(hp.hz).toBeGreaterThan(200)
    expect(rideBar(-1, 0.5)).toBeNull()                       // brighter but not quieter: the sound itself
    expect(rideBar(-9, 0)).toEqual({ type: null, hz: 0, db: -9 })
    expect(rideBar(-40, 0)!.db).toBe(-18)
  })

  it('rides a filter opening evenly as one piece, and leaves single bars alone', () => {
    const opening = Array.from({ length: 8 }, (_, i) => rideBar(-6 + i * 0.6, -2 + i * 0.22))
    const pieces = ridePieces([null, ...opening, rideBar(-6, -2), null, null])
    expect(pieces[0]).toMatchObject({ from: 1, filter: { type: 'lowpass' } })
    const p = pieces[0]
    expect(p.filter!.to).toBeGreaterThan(p.filter!.from)      // opening up
    expect(p.to).toBeGreaterThanOrEqual(8)
    expect(ridePieces([null, rideBar(-6, -2), null, rideBar(-9, 0), null])).toEqual([])
    const fader = ridePieces([rideBar(-9, 0), rideBar(-9, 0), rideBar(-9, 0)])
    expect(fader).toEqual([{ from: 0, to: 3, gainDb: -9 }])
  })
})

describe('rides: the mix high-pass into drops', () => {
  const arr = (thin: number[]): TrackArrangement => {
    const n = 48
    const part = (bright: (b: number) => number) => ({ db: Array.from({ length: n }, () => 0), bright: Array.from({ length: n }, (_, b) => bright(b)) })
    const at = (b: number) => (thin.includes(b) ? 0.6 : 0)
    return { zip_id: 1, source_code: 'S1', bpm: 124, bars: n, parts: {},
      detail: { kick: part(at), bass: part(at), top: part(at), music: part(() => 0) } }
  }
  it('finds how many bars before the drops the whole mix gets thinner', () => {
    expect(mixHighpassOf(arr([14, 15, 30, 31]), [{ from: 16 }, { from: 32 }])).toBe(2)
    expect(mixHighpassOf(arr([15, 31]), [{ from: 16 }, { from: 32 }])).toBe(1)
    expect(mixHighpassOf(arr([15]), [{ from: 16 }, { from: 32 }, { from: 40 }])).toBeNull()
    expect(mixHighpassOf(arr([]), [{ from: 16 }])).toBeNull()
  })
})
