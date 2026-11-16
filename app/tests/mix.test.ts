import { describe, expect, it } from 'vitest'
import { clipPower, compactness, evenClips, laneLoudness, punchDb, punchRefs } from '../src/generate/balance'
import { BAND_HZ, CARVE_DB, carveBand, filterLoss, filterPower } from '../src/generate/eq'
import { generate, laneRole, type GenerateOptions } from '../src/generate/generator'
import { checkMix, kickBass, kickHz, MIX_OFF_DB, referenceMix, REGIONS } from '../src/generate/mix'
import { setLaneMono, type LaneNodes } from '../src/audio/graph'
import type { MidiItem, SampleListItem, SerumPreset, TrackArrangement } from '../src/types/api'
import type { Category, SampleKind } from '../src/types/engine'
import type { AudioClip, Clip, Lane, PatternClip, Project } from '../src/types/project'

const BPM = 124
/** A tone: most of the power around `hz`. */
const tone = (hz: number) => BAND_HZ.map((f) => -6 * Math.log2(f / hz) ** 2 - 3)
let nextId = 1
function sample(kind: SampleKind, category: Category, extra: Partial<SampleListItem> = {}): SampleListItem {
  const id = nextId++
  return {
    id, rel_path: `${kind}/${category}/${id}.wav`, name: `${category}_${id}`, kind, category, bpm: kind === 'oneshot' ? null : BPM,
    bars: kind === 'oneshot' ? null : 2, body_bars: null, key_label: 'Am', key_camelot: null, duration_s: kind === 'oneshot' ? 0.3 : (2 * 4 * 60) / BPM,
    channels: 2, favorite: 0, rating: null, tags: null, zip_id: 1 + (id % 6), source_code: `S000${1 + (id % 6)}`, groove: null, shape: null,
    energy_db: -20, tone: tone(4000), ...extra,
  }
}
const ref = (s: SampleListItem) => ({ id: s.id, relPath: s.rel_path, name: s.name, kind: s.kind, category: s.category, bars: s.bars, durationS: s.duration_s })
const lane = (name: string, extra: Partial<Lane> = {}): Lane => ({ id: name, name, color: '#fff', volumeDb: 0, pan: 0, mute: false, solo: false, height: 40, ...extra })
const audio = (laneId: string, s: SampleListItem, start: number, length: number, extra: Partial<AudioClip> = {}): AudioClip =>
  ({ id: `${laneId}-${start}`, laneId, type: 'audio', start, length, trimBeats: 0, gainDb: 0, sample: ref(s) as AudioClip['sample'], ...extra })
const pattern = (laneId: string, s: SampleListItem, start: number, length: number, hits: number[]): PatternClip =>
  ({ id: `${laneId}-${start}`, laneId, type: 'pattern', start, length, gainDb: 0, sample: ref(s) as PatternClip['sample'], patternBars: 1,
    steps: Array.from({ length: 16 }, (_, k) => (hits.includes(k) ? 3 : 0)) as PatternClip['steps'] })
const project = (lanes: Lane[], clips: Clip[]): Project => ({ bpm: BPM, lanes, clips } as unknown as Project)
const byPath = (...xs: SampleListItem[]) => new Map(xs.map((s) => [s.rel_path, s]))
const DROP: [number, number][] = [[0, 128]]

describe('punch: a snappy hit counts louder than its average says', () => {
  // The same energy, all of it within the window (punch 7 dB over the energy) or spread out.
  const snappy = sample('oneshot', 'clap', { energy_db: -20, punch_db: -13 })
  const washy = sample('oneshot', 'clap', { energy_db: -20, punch_db: -19 })
  const usual = Array.from({ length: 5 }, () => sample('oneshot', 'clap', { energy_db: -20, punch_db: -16 }))
  const refs = punchRefs([snappy, washy, ...usual])

  it('measures how compact a sample is', () => {
    expect(compactness(snappy)).toBeCloseTo(0, 1)
    expect(compactness(washy)).toBeCloseTo(-6, 1)
    expect(compactness(sample('oneshot', 'clap'))).toBeNull()
    expect(refs.get('clap')).toBeCloseTo(-3, 1)
  })

  it('moves a hit half of what it differs from the usual for its kind, within 4 dB', () => {
    expect(punchDb(snappy, refs)).toBeCloseTo(1.5, 1)
    expect(punchDb(washy, refs)).toBeCloseTo(-1.5, 1)
    expect(punchDb(usual[0], refs)).toBeCloseTo(0, 5)
    expect(punchDb(sample('oneshot', 'clap', { energy_db: -20, punch_db: -40 }), refs)).toBe(-4)
    // A kind with too few measured samples, or an unmeasured sample: nothing.
    expect(punchDb(sample('oneshot', 'snare', { energy_db: -20, punch_db: -13 }), refs)).toBe(0)
    expect(punchDb(sample('oneshot', 'clap'), refs)).toBe(0)
  })

  it('counts in a pattern\'s loudness, not in a loop\'s', () => {
    const a = pattern('Clap', snappy, 0, 16, [4, 12])
    const b = pattern('Clap', washy, 0, 16, [4, 12])
    const pa = 10 * Math.log10(clipPower(a, snappy, BPM, refs)! / clipPower(a, snappy, BPM)!)
    const pb = 10 * Math.log10(clipPower(b, washy, BPM, refs)! / clipPower(b, washy, BPM)!)
    expect(pa).toBeCloseTo(1.5, 1)
    expect(pb).toBeCloseTo(-1.5, 1)
    const loop = sample('loop', 'top', { punch_db: -5 })
    expect(clipPower(audio('Tops', loop, 0, 16), loop, BPM, refs)).toBe(clipPower(audio('Tops', loop, 0, 16), loop, BPM))
  })
})

describe('even levels within a lane', () => {
  it('trims a lane\'s other sample to its main one, once', () => {
    const main = sample('loop', 'groove', { energy_db: -20 })
    const other = sample('loop', 'groove', { energy_db: -15 })
    const p = project([lane('Groove')], [audio('Groove', main, 0, 96), audio('Groove', other, 96, 32), audio('Groove', other, 160, 16, { gainDb: -3, gainTo: -10 })])
    const s = byPath(main, other)
    expect(evenClips(p, s, DROP, laneRole)).toBe(1)
    expect(p.clips[0].gainDb).toBe(0)
    expect(p.clips[1].gainDb).toBe(-5)
    // A riding clip of the same sample moves with it, its ride as it was.
    expect([p.clips[2].gainDb, p.clips[2].gainTo]).toEqual([-8, -15])
    expect(laneLoudness([p.clips[1]], s, BPM, [])).toBeCloseTo(laneLoudness([p.clips[0]], s, BPM, [])!, 1)
    expect(evenClips(p, s, DROP, laneRole)).toBe(0)
  })

  it('moves a sample 6 dB at most, and leaves FX lanes and one-sample lanes alone', () => {
    const main = sample('loop', 'groove', { energy_db: -20 })
    const far = sample('loop', 'groove', { energy_db: -40 })
    const p = project([lane('Groove'), lane('FX'), lane('Hats')],
      [audio('Groove', main, 0, 96), audio('Groove', far, 96, 32), audio('FX', main, 0, 8), audio('FX', far, 32, 8), audio('Hats', main, 0, 128)])
    expect(evenClips(p, byPath(main, far), DROP, laneRole)).toBe(1)
    expect(p.clips[1].gainDb).toBe(6)
    expect(p.clips.slice(2).every((c) => c.gainDb === 0)).toBe(true)
  })
})

describe('what a filter takes, and room for the main lane', () => {
  it('a low-pass takes far more from a bright sound than from a dark one', () => {
    const bright = filterLoss(tone(8000), 'lowpass', 800)!
    const dark = filterLoss(tone(300), 'lowpass', 800)!
    expect(bright).toBeLessThan(-15)
    expect(dark).toBeGreaterThan(-3)
    expect(filterLoss(tone(8000), 'highpass', 900)!).toBeGreaterThan(-1)
    expect(filterLoss(null, 'lowpass', 800)).toBeNull()
    // The filter itself: flat in its pass band, 12 dB an octave beyond it.
    expect(10 * Math.log10(filterPower('lowpass', 1000, 0.7, 100))).toBeCloseTo(0, 0)
    expect(10 * Math.log10(filterPower('lowpass', 1000, 0.7, 4000))).toBeCloseTo(-24, 0)
    expect(10 * Math.log10(filterPower('highpass', 1000, 0.7, 250))).toBeCloseTo(-24, 0)
  })

  it('dips a layer where the lane it layers is strongest, only when their tones are much the same', () => {
    const dip = carveBand(tone(3000), tone(3400))!
    expect(dip).toMatchObject({ type: 'peaking', gainDb: CARVE_DB })
    expect(Math.abs(Math.log2(dip.freq / 3000))).toBeLessThan(0.3)
    expect(carveBand(tone(3000), tone(300))).toBeNull()
    expect(carveBand(tone(3000), null)).toBeNull()
  })

  it('puts the dip on the layer lane of a generated mix, not on the main one', () => {
    const lib = library()
    const g = Array.from({ length: 30 }, (_, i) => generate(lib, OPTS, 100 + i)).find((x) => x.project.lanes.some((l) => l.name === 'Tops 2'))!
    const eq = (name: string) => g.project.lanes.find((l) => l.name === name)?.eq?.bands ?? []
    expect(eq('Tops 2').some((b) => b.type === 'peaking' && b.gainDb === CARVE_DB)).toBe(true)
    expect(eq('Tops').some((b) => b.type === 'peaking' && b.gainDb === CARVE_DB)).toBe(false)
  })
})

describe('kick and bass as one measurement', () => {
  const kick = sample('oneshot', 'kick', { tone: tone(55), duration_s: 0.25 })
  // A1 = 55 Hz (MIDI 33): on every beat, or between the beats; or two octaves up on the beats.
  const onBeats: [number, number, number, number][] = [0, 1, 2, 3].map((b) => [b, 0.5, 33, 100])
  const offBeats: [number, number, number, number][] = [0, 1, 2, 3].map((b) => [b + 0.5, 0.5, 33, 100])
  const high: [number, number, number, number][] = [0, 1, 2, 3].map((b) => [b, 0.5, 57, 100])

  it('finds where the kick\'s weight is', () => {
    expect(Math.abs(Math.log2(kickHz(kick)! / 55))).toBeLessThan(0.3)
    expect(kickHz(sample('oneshot', 'kick', { tone: null }))).toBeNull()
  })

  it('ducks deeper the more the bass plays under the kick in its register', () => {
    const on = kickBass(kick, onBeats, 0, 1, BPM, 0.6)!
    const off = kickBass(kick, offBeats, 0, 1, BPM, 0.6)!
    const up = kickBass(kick, high, 0, 1, BPM, 0.6)!
    expect(on.collision).toBeGreaterThan(0.8)
    expect(off.collision).toBeLessThan(0.1)
    expect(up.collision).toBeLessThan(0.1)
    expect(on.duck).toBeGreaterThan(0.8)
    expect(off.duck).toBeLessThan(0.5)
    expect(on.duck).toBeLessThanOrEqual(0.95)
    // The same line moved an octave by the track key's transpose sits clear of the kick.
    expect(kickBass(kick, onBeats, 24, 1, BPM, 0.6)!.collision).toBeLessThan(0.1)
  })

  it('recovers as fast as the kick is short, and stands back without a measured kick', () => {
    const short = kickBass({ ...kick, duration_s: 0.15 }, onBeats, 0, 1, BPM, 0.6)!
    const long = kickBass({ ...kick, duration_s: 0.6 }, onBeats, 0, 1, BPM, 0.6)!
    expect(short.beats).toBeLessThan(long.beats)
    expect(short.beats).toBeGreaterThanOrEqual(0.35)
    expect(long.beats).toBeLessThanOrEqual(0.8)
    expect(kickBass({ ...kick, tone: null }, onBeats, 0, 1, BPM, 0.6)).toBeNull()
  })
})

/** A reference track whose full parts add up dark: its tops around 1.5 kHz. */
function arrangement(i: number, topHz = 1500): TrackArrangement {
  return {
    zip_id: i, source_code: `S00${i}`, bpm: BPM, bars: 64, parts: {},
    levels: { parts: { kick: -18, clap: -22, hats: -28, top: -25 }, normalized: false, spectra: { kick: tone(60), clap: tone(2000), hats: tone(9000), top: tone(topHz) } },
  }
}
const REFS = [1, 2, 3, 4].map((i) => arrangement(i))

describe('the drop against the user\'s tracks', () => {
  const kick = sample('oneshot', 'kick', { tone: tone(60), energy_db: -12 })
  const clap = sample('oneshot', 'clap', { tone: tone(2000), energy_db: -18 })
  const hats = sample('loop', 'hat', { tone: tone(9000), energy_db: -24 })
  const top = sample('loop', 'top', { tone: tone(1500), energy_db: -21 })
  const brightTop = sample('loop', 'top', { tone: tone(4500), energy_db: -15 })
  const samples = byPath(kick, clap, hats, top, brightTop)
  /** A drop with every lane as loud as that part is in the references; the top loop `t`. */
  const mix = (t: SampleListItem) => {
    const p = project([lane('Kick'), lane('Clap'), lane('Hats'), lane('Tops')],
      [pattern('Kick', kick, 0, 128, [0, 4, 8, 12]), pattern('Clap', clap, 0, 128, [4, 12]), audio('Hats', hats, 0, 128), audio('Tops', t, 0, 128)])
    const at: Record<string, number> = { Kick: -18, Clap: -22, Hats: -28, Tops: -25 }
    for (const l of p.lanes) l.levelDb = at[l.name] - laneLoudness(p.clips.filter((c) => c.laneId === l.id), samples, BPM, [])!
    return p
  }

  it('reads the reference from the tracks whose balance is the producer\'s', () => {
    expect(referenceMix(REFS)!.tracks).toBe(4)
    expect(referenceMix(REFS.slice(0, 2))).toBeNull()
    expect(referenceMix(REFS.map((a) => ({ ...a, levels: { ...a.levels!, normalized: true } })))).toBeNull()
    expect(referenceMix(REFS)!.regions).toHaveLength(REGIONS.length)
  })

  it('moves the lane that is furthest off, a step at a time, and never the kick', () => {
    // The top loop 8 dB too loud: too much where it lives.
    const p = mix(top)
    p.lanes.find((l) => l.name === 'Tops')!.levelDb! += 8
    const was = Object.fromEntries(p.lanes.map((l) => [l.name, l.levelDb!]))
    const m = checkMix(p, samples, REFS, DROP, laneRole)!
    const worst = m.before.reduce((k, v, i) => (Math.abs(v) > Math.abs(m.before[k]) ? i : k), 0)
    expect(Math.abs(m.before[worst])).toBeGreaterThan(MIX_OFF_DB)
    expect(Math.abs(m.after[worst])).toBeLessThan(Math.abs(m.before[worst]))
    expect(m.moves.find((x) => x.lane === 'Tops')!.db).toBe(-3)
    expect(m.moves.every((x) => x.lane !== 'Kick' && Math.abs(x.db) <= 3)).toBe(true)
    expect(p.lanes.find((l) => l.name === 'Tops')!.levelDb).toBe(was.Tops - 3)
    expect(p.lanes.find((l) => l.name === 'Kick')!.levelDb).toBe(was.Kick)
    expect(m.off).toBeLessThan(Math.max(...m.before.map(Math.abs)))
  })

  it('brings up what there is too little of, by the lane that lives there', () => {
    const p = mix(top)
    p.lanes.find((l) => l.name === 'Hats')!.levelDb! -= 10   // the highs are thin
    const m = checkMix(p, samples, REFS, DROP, laneRole)!
    const highs = REGIONS.findIndex((r) => r.name === 'highs')
    expect(m.before[highs]).toBeLessThan(-MIX_OFF_DB)
    expect(m.moves.find((x) => x.lane === 'Hats')!.db).toBeGreaterThan(0)
    expect(m.after[highs]).toBeGreaterThan(m.before[highs])
  })

  it('leaves a mix that sits like the references alone, and says nothing without references', () => {
    const p = mix(top)
    const m = checkMix(p, samples, REFS, DROP, laneRole)!
    expect(m.moves).toEqual([])
    expect(m.after).toEqual(m.before)
    expect(checkMix(mix(top), samples, [], DROP, laneRole)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// In a generated track
// ---------------------------------------------------------------------------

const OPTS: GenerateOptions = { bpm: BPM, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true }
function library(): SampleListItem[] {
  const out: SampleListItem[] = []
  for (let z = 1; z <= 6; z++) {
    const add = (kind: SampleKind, category: Category, extra: Partial<SampleListItem>) =>
      out.push(sample(kind, category, { zip_id: z, source_code: `S000${z}`, punch_db: -14 - z, ...extra }))
    add('oneshot', 'kick', { tone: tone(50 + 4 * z), energy_db: -12, duration_s: 0.2 + 0.05 * z })
    for (const c of ['clap', 'snare', 'hat_closed', 'perc', 'cymbal'] as Category[]) add('oneshot', c, { tone: tone(3000) })
    for (const c of ['hat', 'hat', 'perc', 'top', 'top', 'top', 'groove', 'groove'] as Category[]) add('loop', c, { tone: tone(2500 + 300 * z), energy_db: -22 + z })
  }
  return out
}

describe('the mix in a generated track', () => {
  const midi: MidiItem = { id: 1, file_name: 'B.mid', name: 'B', rel_path: 'MIDI/Bass/b.mid', role: 'bass', bars: 2, key_label: 'Am', key_camelot: null,
    notes: [[0, 0.5, 33, 100], [1, 0.5, 33, 100], [2.5, 0.25, 36, 90], [4, 0.5, 33, 100], [5, 0.5, 33, 100]], favorite: 0, source: null, source_code: null }
  const preset: SerumPreset = { path: '/presets/Bass/P.SerumPreset', name: 'P', folder: 'Bass', tags: [] }
  const opts: GenerateOptions = { ...OPTS, templates: REFS, bass: { midis: [midi], presets: [preset], favorites: [], sidechain: 0.6 } }
  const lib = library()
  const gens = Array.from({ length: 20 }, (_, i) => generate(lib, opts, 4000 + i))

  it('keeps the low end mono on the kick and the bass, and nowhere else', () => {
    for (const g of gens) {
      for (const l of g.project.lanes) expect(l.monoBelow).toBe(['Kick', 'Bass', 'Build-up', 'Hits'].includes(l.name) ? 120 : undefined)
    }
  })

  it('sets the bass\'s sidechain from the kick and the bassline, and says so', () => {
    for (const g of gens) {
      const bass = g.project.lanes.find((l) => l.name === 'Bass')!
      expect(bass.duck).toBeGreaterThanOrEqual(0.15)
      expect(bass.duck).toBeLessThanOrEqual(0.95)
      expect(bass.duckBeats).toBeGreaterThanOrEqual(0.35)
      expect(bass.duckBeats).toBeLessThanOrEqual(0.8)
      expect(g.choices.some((c) => c.startsWith('sidechain '))).toBe(true)
    }
    expect(new Set(gens.map((g) => g.project.lanes.find((l) => l.name === 'Bass')!.duckBeats)).size).toBeGreaterThan(1)
  })

  it('checks every track against the references, and is the same every time', () => {
    for (const g of gens) {
      expect(g.mix!.tracks).toBe(4)
      expect(g.mix!.off).toBeLessThanOrEqual(Math.max(...g.mix!.before.map(Math.abs)))
      expect(g.choices.some((c) => c.startsWith('mix checked against 4 of your tracks'))).toBe(true)
    }
    expect(JSON.stringify(generate(lib, opts, 4001).mix)).toBe(JSON.stringify(gens[1].mix))
    expect(generate(lib, OPTS, 4001).mix).toBeNull()
  })

  it('holds what stays in a breakdown at one loudness under its drop, whatever its filter takes', () => {
    // A dark perc loop and a bright one, both low-passed: the bright one gets more level back.
    const g = gens.find((x) => x.sections.some((s) => s.kind === 'break') && x.rules.gluePerc === 'through')
    expect(g).toBeDefined()
    const s = g!.sections.find((x) => x.kind === 'break')!
    const at = (s.start + Math.min(4, Math.max(1, Math.floor(s.bars / 4)))) * 4 + 1
    const perc = g!.project.clips.find((c) => g!.project.lanes.find((l) => l.id === c.laneId)!.name === 'Perc' && c.start <= at && c.start + c.length > at)!
    const src = lib.find((x) => x.rel_path === perc.sample.relPath)!
    const loss = filterLoss(src.tone, 'lowpass', perc.filter!.from)!
    const want = Math.max(-12, Math.min(6, Number(g!.rules.glueDb) - 4 - loss))
    expect(perc.gainDb).toBeCloseTo(Math.round(want * 2) / 2, 5)
  })
})

describe('the mono low end in the audio graph', () => {
  /** A stand-in audio node that records what it is connected to. */
  const node = (extra: object = {}) => {
    const n = { to: [] as unknown[], connect(x: unknown) { n.to.push(x); return x }, disconnect() { n.to = [] }, ...extra }
    return n
  }
  const param = () => ({ value: 0 })
  const ctx = {
    createBiquadFilter: () => node({ type: '', frequency: param(), Q: param(), gain: param() }),
    createGain: () => node({ gain: param(), channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers' }),
  } as unknown as BaseAudioContext

  it('splits the lane after its pan: the lows through two low-passes into one channel, the highs through two high-passes', () => {
    const out = node()
    const pan = node()
    pan.connect(out)
    const nodes = { pan, out, gain: node(), duck: node(), eq: [], eqShape: '' } as unknown as LaneNodes
    setLaneMono(ctx, nodes, 120)
    const m = nodes.mono!
    expect(pan.to).toEqual([m.low[0], m.high[0]])
    expect(m.low.map((f) => [f.type, f.frequency.value])).toEqual([['lowpass', 120], ['lowpass', 120]])
    expect(m.high.map((f) => [f.type, f.frequency.value])).toEqual([['highpass', 120], ['highpass', 120]])
    expect((m.low[1] as unknown as { to: unknown[] }).to).toEqual([m.sum])
    expect([m.sum.channelCount, m.sum.channelCountMode]).toEqual([1, 'explicit'])
    expect((m.sum as unknown as { to: unknown[] }).to).toEqual([out])
    expect((m.high[1] as unknown as { to: unknown[] }).to).toEqual([out])
    // Another frequency: the same nodes. Off: straight to the master again.
    setLaneMono(ctx, nodes, 100)
    expect(nodes.mono).toBe(m)
    expect(m.low[0].frequency.value).toBe(100)
    setLaneMono(ctx, nodes, undefined)
    expect(nodes.mono).toBeUndefined()
    expect(pan.to).toEqual([out])
  })
})
