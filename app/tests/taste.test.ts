import { describe, expect, it } from 'vitest'
import { generate, roleOfLane, setTrackRule, type GenerateOptions, type Generation } from '../src/generate/generator'
import { CHOICES, choicesFor } from '../src/generate/choices'
import {
  applyCuts, learnTaste, originOf, presenceOf, recordOf, sectionKey, tasteRules, type ExportRecord, type Taste,
} from '../src/generate/taste'
import { Rng } from '../src/generate/rng'
import type { SampleListItem } from '../src/types/api'
import type { Category, SampleKind } from '../src/types/engine'

const BPM = 124
const OPTS: GenerateOptions = { bpm: BPM, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true }
const KEYS = ['Am', 'Fm', 'Gm', 'Dm', 'C', 'F']

/** Six zips with the loops and one-shots a track is made of (no event shapes: what's learned doesn't need them). */
function library(): SampleListItem[] {
  const out: SampleListItem[] = []
  let id = 1
  const add = (zip: number, kind: SampleKind, category: Category, bars: number | null = null, body: number | null = null) => {
    const code = `S${String(zip).padStart(4, '0')}`
    out.push({
      id: id++, rel_path: `${kind}/${category}/${code}_${id}.wav`, name: `${category}_${id}`, kind, category,
      bpm: kind === 'oneshot' ? null : BPM, bars, body_bars: body, key_label: KEYS[zip - 1], key_camelot: null,
      duration_s: 1, channels: 2, favorite: 0, rating: null, tags: null, zip_id: zip, source_code: code, groove: null, shape: null,
    })
  }
  for (let z = 1; z <= 6; z++) {
    for (const c of ['kick', 'clap', 'snare', 'hat_closed', 'hat_open', 'perc', 'cymbal'] as Category[]) add(z, 'oneshot', c)
    add(z, 'loop', 'hat', 1); add(z, 'loop', 'hat', 2); add(z, 'loop', 'perc', 2); add(z, 'loop', 'top', 2)
    add(z, 'loop', 'top', 4); add(z, 'loop', 'groove', 4)
    add(z, 'event', 'fill', 2, 1); add(z, 'event', 'roll', 5, 4); add(z, 'event', 'fx_riser', 5, 4)
    add(z, 'event', 'fx_impact', 2, 1); add(z, 'event', 'fx_atmos', 8, 8)
  }
  return out
}

const LIB = library()
const strip = (g: Generation) => JSON.stringify(g.project.clips.map(({ id: _i, laneId: _l, ...c }) => c))
/** Tracks with a breakdown the perc plays in, and a tops rule to change. */
const withBreakPerc = (g: Generation) => {
  const p = presenceOf(g.project, g.sections, roleOfLane).perc ?? []
  return g.sections.some((s, i) => s.kind === 'break' && (p[i] ?? 0) >= 0.25)
}
const tracks = Array.from({ length: 60 }, (_, i) => generate(LIB, OPTS, 7000 + i)).filter(withBreakPerc)

/** A track as the user exports it: the tops another way in breakdowns, the perc out of every breakdown. */
function edited(g: Generation, tops: string): Generation {
  const e: Generation = structuredClone(g)
  e.rules = { ...e.rules, topsBreaks: tops }
  e.project.name = 'Generated 01'
  applyCuts(e.project, e.sections.filter((s) => s.kind === 'break'), [['perc', 'break'], ['perc', 'longbreak']], roleOfLane)
  return e
}

function recordFor(g: Generation, tops: string): ExportRecord {
  const origin = originOf(g, roleOfLane, 1)
  const e = edited(g, tops)
  return recordOf(e, origin, choicesFor(e), CHOICES, roleOfLane)
}

describe('learning from exports', () => {
  it('has tracks to learn from', () => {
    expect(tracks.length).toBeGreaterThan(5)
  })

  it('records what an export changed from how the track was made', () => {
    const g = tracks.find((t) => t.rules.topsBreaks !== 'open')!
    const r = recordFor(g, 'open')
    expect(r.rules.topsBreaks).toEqual([g.rules.topsBreaks, 'open'])
    const keys = new Set(g.sections.filter((s) => s.kind === 'break').map(sectionKey))
    for (const k of keys) {
      const p = presenceOf(g.project, g.sections, roleOfLane).perc!
      const played = g.sections.some((s, i) => sectionKey(s) === k && p[i] >= 0.25)
      if (played) expect(r.sections.perc?.[k]).toBe('out')
    }
    // The kick wasn't touched: kept in its drops.
    expect(r.sections.kick?.drop).toBe('kept')
    // A choice kept as made is recorded as such.
    const kept = Object.entries(r.rules).find(([rule]) => rule !== 'topsBreaks')!
    expect(kept[1][0]).toEqual(kept[1][1])
  })

  it('learns the values changed to and the lanes taken out, once they say so', () => {
    const recs = tracks.slice(0, 4).map((g) => recordFor(g, 'open'))
    const t = learnTaste(recs, 'house', CHOICES)!
    expect(t.tracks).toBe(4)
    const tops = t.rules.topsBreaks
    expect(tops.changed).toBeGreaterThan(0)
    const best = [...tops.weights].sort((a, b) => b[1] - a[1])[0][0]
    expect(best).toBe('open')
    expect(t.cuts.perc?.break ?? t.cuts.perc?.longbreak).toBeGreaterThan(0.5)
    // Choices nobody changed aren't learned: the generator's own odds stand.
    expect(t.rules.introHats).toBeUndefined()
    // Another genre's exports say nothing here.
    expect(learnTaste(recs, 'organic', CHOICES)).toBeNull()
    // One export taking a lane out isn't enough to leave it out of new tracks.
    expect(learnTaste(recs.slice(0, 1), 'house', CHOICES)!.cuts.perc).toBeUndefined()
  })

  it('weighs sounds swapped in and out, and never learns the kick out of drops', () => {
    const g = tracks[0]
    const origin = originOf(g, roleOfLane, 1)
    const e: Generation = structuredClone(g)
    const kickLanes = new Set(e.project.lanes.filter((l) => roleOfLane(l.name) === 'kick').map((l) => l.id))
    e.project.clips = e.project.clips.filter((c) => !kickLanes.has(c.laneId))
    const topLane = e.project.lanes.find((l) => roleOfLane(l.name) === 'top')!
    for (const c of e.project.clips) if (c.laneId === topLane.id) c.sample = { ...c.sample, relPath: 'loop/top/mine.wav' }
    const r = recordOf(e, origin, choicesFor(e), CHOICES, roleOfLane)
    expect(r.samples.top).toEqual([origin.samples.top, 'loop/top/mine.wav'])
    const t = learnTaste([r, { ...r, id: 'b' }, { ...r, id: 'c' }], 'house', CHOICES)!
    expect(t.samples['loop/top/mine.wav']).toBeGreaterThan(1)
    expect(t.samples[origin.samples.top]).toBeLessThan(1)
    expect(t.cuts.kick?.drop).toBeUndefined()
  })

  it('makes new tracks lean that way, and leaves them as they were without it', () => {
    const recs = tracks.slice(0, 6).map((g) => recordFor(g, 'open'))
    const taste = learnTaste(recs, 'house', CHOICES)!
    const seeds = Array.from({ length: 40 }, (_, i) => 9000 + i)
    const plain = seeds.map((s) => generate(LIB, OPTS, s))
    const leaning = seeds.map((s) => generate(LIB, { ...OPTS, taste }, s))
    const open = (gs: Generation[]) => gs.filter((g) => g.rules.topsBreaks === 'open').length
    expect(open(leaning)).toBeGreaterThan(open(plain))
    // A track with the perc cut: none of it in its breakdowns.
    const cut = leaning.filter((g) => (g.rules.learnedCuts as [string, string][] | undefined)?.some(([r]) => r === 'perc'))
    expect(cut.length).toBeGreaterThan(0)
    for (const g of cut) {
      const cuts = g.rules.learnedCuts as [string, string][]
      const p = presenceOf(g.project, g.sections, roleOfLane).perc ?? []
      g.sections.forEach((s, i) => {
        if (cuts.some(([r, k]) => r === 'perc' && k === sectionKey(s))) expect(p[i] ?? 0).toBe(0)
      })
    }
    // The user's own locks go over what's learned.
    const locked = generate(LIB, { ...OPTS, taste, locks: { topsBreaks: 'none' } }, seeds[0])
    expect(locked.rules.topsBreaks).toBe('none')
    // An empty taste changes nothing.
    const empty: Taste = { tracks: 1, rules: {}, samples: {}, presets: {}, tempo: null, cuts: {}, adds: {} }
    for (const s of seeds.slice(0, 5)) expect(strip(generate(LIB, { ...OPTS, taste: empty }, s))).toBe(strip(generate(LIB, OPTS, s)))
  })

  it('keeps a track\'s learned cuts when one of its choices changes', () => {
    const recs = tracks.slice(0, 6).map((g) => recordFor(g, 'open'))
    const taste = learnTaste(recs, 'house', CHOICES)!
    const g = Array.from({ length: 40 }, (_, i) => generate(LIB, { ...OPTS, taste }, 9100 + i))
      .find((x) => (x.rules.learnedCuts as unknown[] | undefined)?.length)!
    const next = setTrackRule(LIB, OPTS, g, 'introHats', g.rules.introHats === 'all' ? 'none' : 'all', ['hats'])
    expect(next.rules.learnedCuts).toEqual(g.rules.learnedCuts)
  })

  it('takes a learned tempo now and then, only inside the range', () => {
    const r = recordFor(tracks[0], 'open')
    const recs = [{ ...r, bpm: [124, 126] as [number, number] }, { ...r, id: 'b', bpm: [123, 126] as [number, number] }]
    const taste = learnTaste(recs, 'house', CHOICES)!
    expect(taste.tempo!.bpms).toEqual([126, 126])
    const bpms = Array.from({ length: 30 }, (_, i) => generate(LIB, { ...OPTS, taste, tempo: { min: 120, max: 128 } }, 500 + i).project.bpm)
    expect(bpms.filter((b) => b === 126).length).toBeGreaterThan(8)
    const outside = Array.from({ length: 10 }, (_, i) => generate(LIB, { ...OPTS, taste, tempo: { min: 120, max: 124 } }, 500 + i).project.bpm)
    expect(outside.every((b) => b <= 124)).toBe(true)
  })

  it('draws the learned choices from its own RNG, the same for the same seed', () => {
    const taste = learnTaste(tracks.slice(0, 4).map((g) => recordFor(g, 'open')), 'house', CHOICES)!
    expect(tasteRules(taste, new Rng(5))).toEqual(tasteRules(taste, new Rng(5)))
  })
})
