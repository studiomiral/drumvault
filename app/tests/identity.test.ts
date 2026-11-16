import { describe, expect, it } from 'vitest'
import { drawGestures, generate, laneRole, TWEAKS, type GenerateOptions, type Generation } from '../src/generate/generator'
import { brightness, interlockFit, paletteFit, paletteFor, paletteRefs, placeOf } from '../src/generate/palette'
import { bestOf, candidateSeeds, predictedLifts, scoreGeneration, scoreLine, scoreRefs } from '../src/generate/score'
import { refine } from '../src/generate/critic'
import { Rng } from '../src/generate/rng'
import { BAND_HZ } from '../src/generate/eq'
import type { LoopGroove, SampleListItem } from '../src/types/api'
import type { Category, SampleKind } from '../src/types/engine'

const BPM = 124
const OPTS: GenerateOptions = { bpm: BPM, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: false }

/** A tone (24 bands, dB of the whole) leaning `tilt` dB per band up (bright) or down (dark). */
function tone(tilt: number): number[] {
  const raw = BAND_HZ.map((_, i) => tilt * (i - 12))
  const total = raw.reduce((n, v) => n + 10 ** (v / 10), 0)
  return raw.map((v) => Math.round((v - 10 * Math.log10(total)) * 10) / 10)
}

/** A loop's groove hitting `on` (16ths of the bar), straight. */
function groove(on: number[]): LoopGroove {
  return {
    offsets: new Array(16).fill(0), levels: Array.from({ length: 16 }, (_, k) => (on.includes(k) ? 0 : null)),
    hits: Array.from({ length: 16 }, (_, k) => (on.includes(k) ? 4 : 0)), swing: 0, push: 0,
  }
}

const PATTERNS = [[0, 4, 8, 12], [2, 6, 10, 14], [1, 5, 9, 13], [3, 7, 11, 15], [0, 2, 4, 6, 8, 10, 12, 14]]

/**
 * Six zips of drums, measured: every sample's tone tilts its own way (from dark to bright over the
 * zips and within them), one-shots from soft to snappy, loops on one of five 16th patterns.
 */
function library(): SampleListItem[] {
  const out: SampleListItem[] = []
  let id = 1
  const add = (zip: number, kind: SampleKind, category: Category, k: number, bars: number | null = null) => {
    const code = `S${String(zip).padStart(4, '0')}`
    const tilt = -0.6 + ((zip * 3 + k * 5) % 13) * 0.1
    const energy = -20
    out.push({
      id: id++, rel_path: `${kind}/${category}/${code}_${id}.wav`, name: `${category}_${id}`, kind, category,
      bpm: kind === 'oneshot' ? null : BPM, bars, body_bars: null, key_label: 'Am', key_camelot: null,
      duration_s: kind === 'oneshot' ? 0.4 : (bars ?? 1) * 240 / BPM, channels: 2, favorite: 0, rating: null, tags: null, zip_id: zip, source_code: code,
      tone: tone(tilt), energy_db: energy, punch_db: kind === 'oneshot' ? energy - 10 * Math.log10(0.2) - ((zip + k) % 5) * 1.5 : null,
      groove: kind === 'loop' ? groove(PATTERNS[(zip + k) % PATTERNS.length]) : null,
    })
  }
  for (let z = 1; z <= 6; z++) {
    for (let k = 0; k < 3; k++) for (const c of ['kick', 'clap', 'snare', 'hat_closed', 'perc', 'cymbal'] as Category[]) add(z, 'oneshot', c, k)
    for (let k = 0; k < 3; k++) {
      add(z, 'loop', 'hat', k, 1); add(z, 'loop', 'perc', k, 2); add(z, 'loop', 'top', k, 2); add(z, 'loop', 'groove', k, 4)
    }
    add(z, 'loop', 'ride', 0, 2)
  }
  return out
}

const LIB = library()
const REFS = paletteRefs(LIB)
const byPath = new Map(LIB.map((s) => [s.rel_path, s]))
const seeds = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i * 37)
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

/** The samples a generation plays on lanes of `role`. */
function played(g: Generation, test: (role: string) => boolean): SampleListItem[] {
  const lanes = new Map(g.project.lanes.map((l) => [l.id, laneRole(l.name) ?? '']))
  return [...new Set(g.project.clips.filter((c) => test(lanes.get(c.laneId)!)).map((c) => byPath.get(c.sample.relPath)).filter((s): s is SampleListItem => !!s))]
}

describe('the palette', () => {
  it('measures brightness from a tone, and a sample against its kind', () => {
    expect(brightness(tone(0.5))!).toBeGreaterThan(brightness(tone(0))!)
    expect(brightness(tone(-0.5))!).toBeLessThan(brightness(tone(0))!)
    expect(brightness(null)).toBeNull()
    const hats = LIB.filter((s) => s.category === 'hat_closed')
    const z = hats.map((s) => placeOf(s, REFS).bright!)
    expect(Math.min(...z)).toBeLessThan(-0.5)
    expect(Math.max(...z)).toBeGreaterThan(0.5)
  })

  it('leans by the character and is pulled to the kick', () => {
    expect(paletteFor('dub', null, REFS).bright).toBeLessThan(0)
    expect(paletteFor('disco', null, REFS).bright).toBeGreaterThan(0)
    expect(paletteFor('drums', null, REFS).compact).toBeGreaterThan(0.5)
    const kicks = LIB.filter((s) => s.category === 'kick').sort((a, b) => placeOf(a, REFS).bright! - placeOf(b, REFS).bright!)
    const dark = paletteFor('disco', kicks[0], REFS)
    const bright = paletteFor('disco', kicks[kicks.length - 1], REFS)
    expect(dark.bright).toBeLessThan(bright.bright)
    // A sample on the palette fits better than one far from it; one not measured is neutral.
    const p = { bright: 1, compact: 0 }
    const hats = LIB.filter((s) => s.category === 'hat_closed').sort((a, b) => placeOf(a, REFS).bright! - placeOf(b, REFS).bright!)
    expect(paletteFit(hats[hats.length - 1], p, REFS)).toBeGreaterThan(paletteFit(hats[0], p, REFS))
    expect(paletteFit({ ...hats[0], tone: null, energy_db: null, punch_db: null }, p, REFS)).toBe(0.5)
  })

  it('picks darker drums for a dub track than for a disco one', () => {
    const z = (character: string) => mean(seeds(30).map((s) => {
      const g = generate(LIB, { ...OPTS, locks: { character } }, s)
      const drums = played(g, (r) => /^(clap|hats|perc|top|groove)/.test(r))
      return mean(drums.map((x) => placeOf(x, REFS).bright ?? 0))
    }))
    const [dub, disco] = [z('dub'), z('disco')]
    process.stderr.write(`palette: dub ${dub.toFixed(2)}, disco ${disco.toFixed(2)}\n`)
    expect(dub).toBeLessThan(disco - 0.4)
  })

  it('says so in the choices, and keeps the zip spread', () => {
    const g = generate(LIB, { ...OPTS, locks: { character: 'dub' } }, 5)
    expect(g.choices.some((c) => c.startsWith('drums picked as one palette around the kick'))).toBe(true)
    expect(g.zips.length).toBeGreaterThanOrEqual(3)
    expect(g.rules.palette).toEqual(expect.objectContaining({ bright: expect.any(Number), compact: expect.any(Number) }))
  })
})

describe('loops that interlock', () => {
  it('scores a loop on other 16ths over one on the same', () => {
    const loops = LIB.filter((s) => s.kind === 'loop' && s.category === 'perc')
    const on = (pat: number[]) => loops.find((s) => s.groove!.hits.every((h, k) => (h > 0) === pat.includes(k)))!
    const quarters = on(PATTERNS[0])
    const offbeats = on(PATTERNS[1])
    const eighths = on(PATTERNS[4])   // on every quarter too
    expect(interlockFit(offbeats, [quarters])).toBeGreaterThan(0.95)
    expect(interlockFit(eighths, [quarters])).toBeLessThan(0.7)
    expect(interlockFit(quarters, [])).toBe(0.5)
  })

  it('picks the loops of a drop to land on fewer of the same 16ths than chance', () => {
    const picked: number[] = []
    const chance: number[] = []
    const rng = new Rng(9)
    const loops = LIB.filter((s) => s.kind === 'loop' && s.category !== 'ride')
    for (const s of seeds(30)) {
      const g = generate(LIB, OPTS, s)
      const set = [g.picks.hats, g.picks.perc, g.picks.top, g.picks.groove].filter((x): x is SampleListItem => x?.kind === 'loop')
      for (let i = 1; i < set.length; i++) picked.push(interlockFit(set[i], set.slice(0, i)))
      for (let i = 1; i < set.length; i++) chance.push(interlockFit(rng.pick(loops), set.slice(0, i)))
    }
    process.stderr.write(`interlock: picked ${mean(picked).toFixed(2)}, chance ${mean(chance).toFixed(2)}\n`)
    expect(mean(picked)).toBeGreaterThan(mean(chance) + 0.05)
  })
})

describe('the arc: one element held for the last drop', () => {
  it('keeps it out until the last drop and plays it there', () => {
    let held = 0
    for (const s of seeds(40)) {
      const g = generate(LIB, OPTS, s)
      const drops = g.sections.filter((x) => x.kind === 'drop')
      const hold = g.rules.hold as string
      if (drops.length < 2) {
        expect(hold).toBe('none')
        continue
      }
      if (hold === 'none') continue
      held++
      const peak = drops[drops.length - 1].start * 4
      const lanes = g.project.lanes.filter((l) => laneRole(l.name) === hold).map((l) => l.id)
      const clips = g.project.clips.filter((c) => lanes.includes(c.laneId))
      expect(clips.every((c) => c.start >= peak), `${hold} before the last drop (seed ${s})`).toBe(true)
      expect(clips.some((c) => c.start < peak + drops[drops.length - 1].bars * 4)).toBe(true)
      expect(g.choices.some((c) => c.endsWith('held back for the last drop'))).toBe(true)
    }
    process.stderr.write(`held in ${held} of 40\n`)
    expect(held).toBeGreaterThan(10)
  })

  it('leaves a track made before it as it was when a lane of it is made again', () => {
    const g = generate(LIB, OPTS, 41)
    const { hold: _h, gestures: _g, ...before } = g.rules
    const again = generate(LIB, OPTS, 41, { structure: g.sections, key: g.key, picks: g.picks, rules: before, replay: g.rngAt })
    expect(again.rules.hold).toBe('none')
    expect(again.rules.gestures).toBeNull()
    expect(again.choices.some((c) => c.includes('variations of its own'))).toBe(false)
  })

  it('holds nothing when the choice says so', () => {
    for (const s of seeds(10)) expect(generate(LIB, { ...OPTS, locks: { hold: 'none' } }, s).rules.hold).toBe('none')
  })
})

describe("the track's own variations", () => {
  it('draws two small ones, a medium and a big one, all different, by the character', () => {
    for (let i = 0; i < 20; i++) {
      const g = drawGestures(new Rng(i), 'drums')
      const all = [...g.small, g.medium, g.big]
      expect(new Set(all).size).toBe(4)
      expect(all.every((t) => TWEAKS.includes(t))).toBe(true)
    }
    const drums = Array.from({ length: 200 }, (_, i) => drawGestures(new Rng(i), 'drums').small).flat()
    const disco = Array.from({ length: 200 }, (_, i) => drawGestures(new Rng(i), 'disco').small).flat()
    const n = (xs: string[], t: string) => xs.filter((x) => x === t).length
    expect(n(drums, 'kick')).toBeGreaterThan(n(disco, 'kick'))
    expect(n(disco, 'fill')).toBeGreaterThan(n(drums, 'fill'))
  })

  it('names them in the choices and makes the same track for the same seed', () => {
    const a = generate(LIB, OPTS, 77)
    const b = generate(LIB, OPTS, 77)
    expect(JSON.stringify(a.project.clips.map((c) => [c.start, c.length, c.sample.relPath]))).toBe(JSON.stringify(b.project.clips.map((c) => [c.start, c.length, c.sample.relPath])))
    expect(a.choices.some((c) => / variations of its own: .* every 8 bars, .* at 16, .* at 32$/.test(c))).toBe(true)
  })
})

describe('best of several', () => {
  const one = (s: number) => refine(LIB, OPTS, generate(LIB, OPTS, s))

  it('predicts each drop coming up over the bars before it', () => {
    const g = generate(LIB, OPTS, 3)
    const lifts = predictedLifts(g.project, g.sections, byPath, scoreRefs(LIB).punch)
    const drops = g.sections.filter((x) => x.kind === 'drop' && x.start >= 8)
    expect(lifts.map((l) => l.bar)).toEqual(drops.map((d) => d.start))
    expect(lifts.every((l) => Number.isFinite(l.lu))).toBe(true)
    expect(Math.max(...lifts.map((l) => l.lu))).toBeGreaterThan(0)
  })

  it('scores a track from its clashes, interlock, palette and drops', () => {
    const s = scoreGeneration(LIB, one(3))
    expect(s.total).toBeGreaterThan(0)
    expect(s.total).toBeLessThanOrEqual(100)
    expect(s.palette).not.toBeNull()
    expect(s.interlock).not.toBeNull()
    expect(scoreLine({ ...s, of: 12 })).toMatch(/^best of 12 \(score \d+\): /)
  })

  it('plays the best of the candidates, the same for the same seed, and keeps its own seed', () => {
    const g = bestOf(LIB, 1234, 6, one)
    const all = candidateSeeds(1234, 6).map((s) => scoreGeneration(LIB, one(s)).total)
    expect(candidateSeeds(1234, 6)[0]).toBe(1234)
    expect(new Set(candidateSeeds(1234, 6)).size).toBe(6)
    expect(g.score!.total).toBe(Math.max(...all))
    expect(g.score!.of).toBe(6)
    expect(g.choices[0]).toMatch(/^best of 6 /)
    expect(bestOf(LIB, 1234, 6, one).seed).toBe(g.seed)
    // Its own seed makes exactly it again.
    expect(one(g.seed).project.clips.map((c) => c.sample.relPath)).toEqual(g.project.clips.map((c) => c.sample.relPath))
  })

  it('makes a dozen in well under three seconds', () => {
    const t0 = performance.now()
    bestOf(LIB, 99, 12, one)
    expect(performance.now() - t0).toBeLessThan(3000)
  })
})
