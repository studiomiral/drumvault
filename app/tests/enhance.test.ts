import { describe, expect, it } from 'vitest'
import { gainComputer } from '../src/audio/compressor'
import { beefBands, echoDuckParams, echoFeedback, echoSeconds, enhancedComp, ENHANCE_DEFAULTS, enhanceLevels, satCurve, satDrive, satMix } from '../src/audio/enhance'
import { laneCompParams, laneNeedsWorklet } from '../src/audio/graph'
import { COMP_ROLES, RENDER_PUNCH_DB, roleComp } from '../src/generate/comp'
import type { Lane, LaneComp } from '../src/types/project'

const lane = (patch: Partial<Lane> = {}): Lane => ({ id: 'v', name: 'Vocal', color: '#fff', volumeDb: 0, pan: 0, mute: false, solo: false, height: 60, ...patch })
const VOCAL_COMP: LaneComp = roleComp('vocal', RENDER_PUNCH_DB.vocal!)!

describe('Vocal Enhance', () => {
  it('scales every part by the amount, nothing when off or not on the lane', () => {
    expect(enhanceLevels(undefined)).toBeNull()
    expect(enhanceLevels({ ...ENHANCE_DEFAULTS, off: true })).toBeNull()
    const lv = enhanceLevels({ ...ENHANCE_DEFAULTS, amount: 1.5, beef: 1, comp: 0.4 })!
    expect(lv.beef).toBeCloseTo(1.5)
    expect(lv.comp).toBeCloseTo(0.6)
    expect(enhanceLevels({ ...ENHANCE_DEFAULTS, amount: 0 })).toEqual({ beef: 0, comp: 0, saturation: 0, reverb: 0, delay: 0 })
    // (Out of range: held in it.)
    expect(enhanceLevels({ ...ENHANCE_DEFAULTS, amount: 9, beef: 3 })!.beef).toBeCloseTo(1.5)
  })

  it('beefs up the body and the top, takes out some box, flat at nothing', () => {
    const flat = beefBands(0)
    expect(flat.every((b) => b.gainDb === 0)).toBe(true)
    const b = beefBands(1)
    expect(b.map((x) => x.type)).toEqual(flat.map((x) => x.type))  // the same nodes, only their gains move
    expect(b[0].freq).toBeLessThan(300)
    expect(b[0].gainDb).toBeGreaterThan(0)
    expect(b[1].gainDb).toBeLessThan(0)
    expect(b.at(-1)!.type).toBe('highshelf')
    expect(b.at(-1)!.gainDb).toBeGreaterThan(0)
  })

  it("pushes the vocal's compressor harder and gives back what it takes off", () => {
    expect(enhancedComp(VOCAL_COMP, 0)).toBe(VOCAL_COMP)
    const c = enhancedComp(VOCAL_COMP, 1)!
    expect(c.thresholdDb).toBeLessThan(VOCAL_COMP.thresholdDb)
    expect(c.ratio).toBeGreaterThan(VOCAL_COMP.ratio)
    expect(c.makeupDb).toBeGreaterThan(VOCAL_COMP.makeupDb)
    // At the phrase's loudest, it ends up about as loud as before (most of the extra given back).
    const punch = VOCAL_COMP.thresholdDb - COMP_ROLES.vocal!.overDb
    const before = punch + gainComputer(punch, VOCAL_COMP.thresholdDb, VOCAL_COMP.ratio, VOCAL_COMP.kneeDb) + VOCAL_COMP.makeupDb
    const after = punch + gainComputer(punch, c.thresholdDb, c.ratio, c.kneeDb) + c.makeupDb
    expect(Math.abs(after - before)).toBeLessThan(3)
    // A compressor switched off (or none): one of its own, from the vocal's threshold.
    const own = enhancedComp({ ...VOCAL_COMP, off: true }, 0.5)!
    expect(own.off).toBeUndefined()
    expect(own.ratio).toBeGreaterThan(1)
    expect(enhancedComp(undefined, 0.5)!.thresholdDb).toBeCloseTo(own.thresholdDb, 0)
    expect(enhancedComp({ ...VOCAL_COMP, off: true }, 0)!.off).toBe(true)
  })

  it('works through the lane compressor, only while it is on', () => {
    const bare = laneCompParams(lane({ comp: VOCAL_COMP }), 124)!
    const pushed = laneCompParams(lane({ comp: VOCAL_COMP, enhance: { ...ENHANCE_DEFAULTS } }), 124)!
    expect(pushed.thresholdDb).toBeLessThan(bare.thresholdDb)
    expect(laneCompParams(lane({ comp: VOCAL_COMP, enhance: { ...ENHANCE_DEFAULTS, off: true } }), 124)).toEqual(bare)
    expect(laneCompParams(lane({ enhance: { ...ENHANCE_DEFAULTS } }), 124)).not.toBeNull()
    expect(laneNeedsWorklet(lane({ enhance: { ...ENHANCE_DEFAULTS, comp: 0 } }), 124)).toBe(true)  // (the delay's ducker)
    expect(laneNeedsWorklet(lane(), 124)).toBe(false)
  })

  it('saturates softly: silence stays silent, a sung level as loud, the peaks rounded, a little lopsided', () => {
    for (const s of [0.2, 0.5, 1.5]) {
      const curve = satCurve(satDrive(s))
      const at = (x: number) => curve[Math.round(((x + 1) / 2) * (curve.length - 1))]
      expect(at(0)).toBeCloseTo(0, 6)
      expect(at(0.25)).toBeCloseTo(0.25, 2)
      for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1])
      expect(at(1)).toBeLessThan(1)
      expect(Math.abs(at(1))).not.toBeCloseTo(Math.abs(at(-1)), 2)
    }
    expect(satMix(0)).toBe(0)
    expect(satMix(1.5)).toBeLessThan(1)  // the dry sound always under it
  })

  it('repeats in time, ducked under the vocal while it sings', () => {
    expect(echoSeconds('1/8d', 120)).toBeCloseTo(0.375)
    expect(echoSeconds('1/4', 120)).toBeCloseTo(0.5)
    expect(echoFeedback(1.5)).toBeLessThanOrEqual(0.5)
    const d = echoDuckParams(VOCAL_COMP, -3)
    const punch = VOCAL_COMP.thresholdDb - COMP_ROLES.vocal!.overDb - 3
    expect(d.thresholdDb).toBeLessThan(punch)
    expect(gainComputer(punch, d.thresholdDb, d.ratio, d.kneeDb)).toBeLessThan(-4)       // sung: well down
    expect(gainComputer(punch - 25, d.thresholdDb, d.ratio, d.kneeDb)).toBe(0)           // a gap: all there
  })
})
