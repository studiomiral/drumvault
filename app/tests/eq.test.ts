import { describe, expect, it } from 'vitest'
import { BAND_HZ, bandPower, clipsTone, eqDb, eqLanes, eqSummary, loudnessChange, matchBands, referenceTones } from '../src/generate/eq'
import { laneRole } from '../src/generate/generator'
import type { SampleListItem, TrackArrangement } from '../src/types/api'
import type { EqBand, Lane, PatternClip, Project, Velocity } from '../src/types/project'

const db = (p: number) => 10 * Math.log10(p)
/** A tone tilted by `slope` dB per band (from the bottom band), against its total. */
function tilt(slope: number): number[] {
  const raw = BAND_HZ.map((_, i) => slope * i)
  const total = db(raw.reduce((n, v) => n + 10 ** (v / 10), 0))
  return raw.map((v) => v - total)
}

describe('eq: the bands', () => {
  it('answers like Web Audio\'s biquads', () => {
    const bell: EqBand = { type: 'peaking', freq: 1000, gainDb: 4, q: 1 }
    expect(db(bandPower(bell, 1000))).toBeCloseTo(4, 2)
    expect(db(bandPower(bell, 50))).toBeCloseTo(0, 1)
    const cut: EqBand = { type: 'highpass', freq: 200, gainDb: 0, q: -3.01 }
    expect(db(bandPower(cut, 200))).toBeCloseTo(-3, 1)       // a flat (Butterworth) high-pass
    expect(db(bandPower(cut, 2000))).toBeCloseTo(0, 1)
    expect(db(bandPower(cut, 50))).toBeLessThan(-20)
    const highs: EqBand = { type: 'highshelf', freq: 6000, gainDb: 3, q: 0 }
    expect(db(bandPower(highs, 18000))).toBeCloseTo(3, 0)
    expect(db(bandPower(highs, 300))).toBeCloseTo(0, 1)
    expect(eqDb([bell, highs], 1000)).toBeCloseTo(4 + db(bandPower(highs, 1000)), 5)
  })

  it('moves a tone part of the way to the reference with broad bands, and leaves a match alone', () => {
    const dark = tilt(-1)
    const ref = tilt(0)
    const bands = matchBands(dark, ref, 150)
    const high = bands.find((b) => b.type === 'highshelf')!
    const low = bands.find((b) => b.type === 'lowshelf')
    expect(high.gainDb).toBeGreaterThan(1)
    expect(high.gainDb).toBeLessThanOrEqual(4)
    if (low) expect(low.gainDb).toBeLessThan(0)
    expect(bands.length).toBeLessThanOrEqual(4)
    expect(matchBands(ref, ref, 150)).toEqual([])
    // A bump of the reference's in the mids: a bell there.
    const bump = ref.map((v, i) => v + (Math.abs(BAND_HZ[i] - 1000) < 300 ? 8 : 0))
    const bell = matchBands(ref, bump, 150).find((b) => b.type === 'peaking')!
    expect(bell.freq).toBeGreaterThan(700)
    expect(bell.freq).toBeLessThan(1400)
    expect(bell.gainDb).toBeGreaterThan(0)
  })

  it('knows what the bands do to a sound\'s loudness, for the makeup gain', () => {
    const lows = tilt(-2)
    const cut: EqBand[] = [{ type: 'highpass', freq: 300, gainDb: 0, q: -3.01 }]
    expect(loudnessChange(cut, lows)).toBeLessThan(-1)       // a sound mostly below 300 Hz loses a lot
    expect(loudnessChange(cut, tilt(2))).toBeGreaterThan(-0.2)  // a bright one hardly anything
    expect(loudnessChange([], lows)).toBe(0)
  })

  it('takes each part\'s tone from at least three of the user\'s tracks', () => {
    const a = (t: number[]): TrackArrangement => ({ zip_id: 1, source_code: 'S', bpm: 124, bars: 8, parts: {}, levels: { parts: {}, normalized: false, spectra: { hats: t } } })
    expect(referenceTones([a(tilt(1)), a(tilt(1))]).hats).toBeUndefined()
    // Per band, the median: two tracks alike outvote the odd one.
    const r = referenceTones([a(tilt(1)), a(tilt(3)), a(tilt(1))])
    r.hats.forEach((v, i) => expect(v).toBeCloseTo(tilt(1)[i], 5))
  })
})

describe('eq: the lanes of a generated track', () => {
  const sample = (rel: string, category: SampleListItem['category'], tone: number[]): SampleListItem => ({
    id: 1, rel_path: rel, name: rel, kind: 'oneshot', category, bpm: null, bars: null, body_bars: null, key_label: null, key_camelot: null,
    duration_s: 0.3, channels: 2, favorite: 0, rating: null, tags: null, zip_id: 1, source_code: 'S', energy_db: -10, tone,
  })
  const kick = sample('kick.wav', 'kick', tilt(-2))
  const hat = sample('hat.wav', 'hat', tilt(-0.5))   // darker than the reference hats
  const by = new Map([kick, hat].map((s) => [s.rel_path, s]))
  const pat = (laneId: string, s: SampleListItem): PatternClip => ({
    id: laneId + 'c', laneId, type: 'pattern', start: 0, length: 32, gainDb: 0, patternBars: 1,
    sample: { relPath: s.rel_path, id: 1, name: s.name, kind: 'oneshot', category: s.category, bars: null, durationS: 0.3 },
    steps: [3, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0] as Velocity[],
  })
  const lane = (id: string, name: string): Lane => ({ id, name, color: '#fff', volumeDb: 0, pan: 0, mute: false, solo: false, height: 60 })
  const refs: TrackArrangement[] = [0, 1, 2].map(() => ({ zip_id: 1, source_code: 'S', bpm: 124, bars: 8, parts: {},
    levels: { parts: {}, normalized: false, spectra: { hats: tilt(0.3) } } }))

  it('cuts the lows of all but the kick and the bass, brightens a dark hat towards the references, and makes up the level', () => {
    const project = { bpm: 120, lanes: [lane('k', 'Kick'), lane('h', 'Hats')], clips: [pat('k', kick), pat('h', hat)] } as unknown as Project
    eqLanes(project, by, refs, [[0, 32]], laneRole)
    const [k, h] = project.lanes
    expect(k.eq).toBeUndefined()
    expect(h.eq!.bands[0]).toMatchObject({ type: 'highpass', freq: 250 })
    expect(h.eq!.bands.some((b) => b.type === 'highshelf' && b.gainDb > 0)).toBe(true)
    // The makeup: as loud with the EQ as without it (to the half dB).
    const tone = clipsTone(project.clips.filter((c) => c.laneId === 'h'), by, 120, [[0, 32]])
    expect(Math.abs(loudnessChange(h.eq!.bands, tone) + h.eq!.gainDb)).toBeLessThanOrEqual(0.25)
    expect(eqSummary(h.eq!.bands)).toMatch(/^low cut 250 Hz, .*highs \+/)
    // Without references: the low cut alone.
    const bare = { bpm: 120, lanes: [lane('h', 'Hats')], clips: [pat('h', hat)] } as unknown as Project
    eqLanes(bare, by, [], [[0, 32]], laneRole)
    expect(bare.lanes[0].eq!.bands.map((b) => b.type)).toEqual(['highpass'])
  })
})
