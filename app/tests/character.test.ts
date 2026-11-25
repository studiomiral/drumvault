import { describe, expect, it } from 'vitest'
import { bassPath } from '../src/audio/schedule'
import { breakShape, CHARACTERS, isReese, PAD_BARS, padNotes, pickLead } from '../src/generate/character'
import { changeKey, generate, rerollPad, setTrackRule, type GenerateOptions, type Generation } from '../src/generate/generator'
import { CHOICES } from '../src/generate/choices'
import { Rng } from '../src/generate/rng'
import type { HitItem, MidiItem, SampleListItem, SerumPreset } from '../src/types/api'
import type { Category, SampleKind } from '../src/types/engine'
import type { AudioClip } from '../src/types/project'

const BPM = 124
function library(): SampleListItem[] {
  const out: SampleListItem[] = []
  let id = 1
  for (let z = 1; z <= 6; z++) {
    const add = (kind: SampleKind, category: Category, bars: number | null = null) => out.push({
      id: id++, rel_path: `${kind}/${category}/${z}_${id}.wav`, name: `${category}_${id}`, kind, category, bpm: kind === 'oneshot' ? null : BPM, bars,
      body_bars: null, key_label: 'Am', key_camelot: null, duration_s: 1, channels: 2, favorite: 0, rating: null, tags: null, zip_id: z, source_code: `S000${z}`,
      groove: null, shape: null,
    })
    for (const c of ['kick', 'clap', 'snare', 'hat_closed', 'perc', 'cymbal'] as Category[]) add('oneshot', c)
    add('loop', 'hat', 2); add('loop', 'perc', 2); add('loop', 'top', 2); add('loop', 'top', 4); add('loop', 'groove', 4)
  }
  return out
}
const stab = (id: number): HitItem => ({ id, kind: 'stab', file_name: `s${id}.wav`, name: `s${id}`, rel_path: `Chord Stabs/s${id}.wav`, key_label: 'Am', key_camelot: null,
  key_source: 'name', pitch_fix: 0, duration_s: 0.4, channels: 2 })
const midi: MidiItem = { id: 1, file_name: 'B.mid', name: 'B', rel_path: 'MIDI/Bass/b.mid', role: 'bass', bars: 2, key_label: 'Am', key_camelot: null,
  notes: [[0, 0.5, 33, 100], [1.5, 0.5, 33, 100], [4, 0.5, 36, 100]], favorite: 0, source: null, source_code: null }
const serum = (name: string, folder = 'Pads'): SerumPreset => ({ path: `/presets/${folder}/${name}.SerumPreset`, name, folder, tags: [] })
const PADS = [serum('Warm Pad'), serum('Glass Pad'), serum('Dark Reese', 'Reese')]
const OPTS: GenerateOptions = {
  bpm: BPM, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true, stabs: { hits: [stab(1), stab(2), stab(3)] },
  bass: { midis: [midi], presets: [serum('Bass', 'Bass')], favorites: [], sidechain: 0.6 }, pads: { presets: PADS },
}
const LIB = library()
const gens = Array.from({ length: 80 }, (_, i) => generate(LIB, OPTS, 900 + i))
const laneOf = (g: Generation, name: string) => g.project.lanes.find((l) => l.name === name)
const padClips = (g: Generation) => g.project.clips.filter((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'pad')

describe('a track\'s character and its lead', () => {
  it('gives every new track one of the characters, and most a lead, said first in its choices', () => {
    const seen = new Set(gens.map((g) => g.rules.character))
    expect([...seen].sort()).toEqual([...CHARACTERS].sort())
    expect(gens.filter((g) => g.rules.lead).length).toBeGreaterThan(gens.length * 0.6)
    for (const g of gens) expect(g.choices[g.template ? 1 : 0]).toMatch(/^(dark and dubby|bright and disco|stripped and percussive|deep and warm)/)
  })

  it('makes tracks of a character alike in the rules that make it', () => {
    for (const g of gens.filter((x) => x.rules.character === 'dub')) {
      // (A stab loop's drops hit open: its filter opens before them, so dub's opening over every drop is left out.)
      expect([g.rules.fx, g.rules.stabEcho, g.rules.stabsOpen]).toEqual(['sparse', '8', g.rules.stabLoop ? 'none' : 'each'])
      expect(g.rules.glueHz).toBeLessThanOrEqual(800)
    }
    for (const g of gens.filter((x) => x.rules.character === 'disco')) expect([g.rules.fx, g.rules.crash8]).toEqual(['busy', true])
    for (const g of gens.filter((x) => x.rules.character === 'drums')) expect([g.rules.stringsIn, g.rules.discoIn, g.rules.stabCount]).toEqual([false, false, 1])
  })

  it('draws the lead by the character\'s leaning, and none when the track lacks the part drawn', () => {
    const count = (c: typeof CHARACTERS[number]) => {
      const n = { stab: 0, bass: 0, perc: 0, piano: 0, music: 0 }
      for (let s = 1; s <= 600; s++) n[pickLead(c, new Rng(s), ['stab', 'bass', 'perc'])!]++
      return n
    }
    expect(count('drums').perc).toBeGreaterThan(count('disco').perc * 2)
    expect(count('disco').stab).toBeGreaterThan(count('drums').stab * 4)
    for (let s = 1; s <= 50; s++) expect(['bass', null]).toContain(pickLead('disco', new Rng(s), ['bass']))
  })

  it('teases a stab lead in the intro and keeps a top loop less for it; a bass lead is in the intro too', () => {
    for (const g of gens.filter((x) => x.rules.lead === 'stab')) expect(g.rules.stabsTease).toBe(true)
    for (const g of gens.filter((x) => x.rules.lead === 'bass')) expect(g.rules.bassIO).toBe('filtered')
    for (const g of gens.filter((x) => x.rules.lead === 'perc')) expect([g.rules.ioPerc, g.rules.gluePerc]).toEqual([true, 'through'])
  })

  it('puts the lead in the clear in the breakdowns, from their second part', () => {
    let checked = 0
    for (const g of gens) {
      for (const s of g.sections.filter((x) => x.kind === 'break')) {
        const from = breakShape(s.start, s.bars).lead
        // (A stab loop announces the drop over the breakdown's last bars: low-passed and opening.)
        // (Into the drop after the long breakdown, with the stabs in the big build's effects: over the whole build.)
        const big = g.rules.bigBuild === 'big' && s.long && ['stabs', 'drums+stabs', 'all'].includes(String(g.rules.bigVerb))
          && g.sections[g.sections.indexOf(s) + 1]?.kind === 'drop'
        const ann = g.rules.lead === 'stab' && g.rules.stabLoop
          ? big ? Math.min(Number(g.rules.bigBars), s.bars) : Math.min(Number(g.rules.stabAnnounce), Math.max(2, Math.floor(s.bars / 2))) : 0
        // (The big build's mix high-pass may ride the breakdown's last bars.)
        const hp = big || (g.rules.bigBuild === 'big' && s.long) ? Number(g.rules.bigHp ?? 0) : 0
        const to = s.start + s.bars - Math.max(1, ann, hp)
        if (to <= from) continue
        const at = (name: string) => g.project.clips.filter((c) => laneOf(g, name)?.id === c.laneId && c.start >= from * 4 && c.start < to * 4)
        if (g.rules.lead === 'bass') {
          expect(at('Bass').some((c) => !c.filter)).toBe(true)
          checked++
        }
        if (g.rules.lead === 'stab') {
          expect(at('Stab').filter((c) => c.filter?.type === 'lowpass')).toEqual([])
          expect(at('Stab').length).toBeGreaterThan(0)
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(20)
  })

  it('can be changed or turned off per track; a track made before has neither', () => {
    const choice = CHOICES.find((c) => c.rule === 'lead')!
    const g = gens.find((x) => x.rules.lead === 'stab')!
    expect(setTrackRule(LIB, OPTS, g, 'lead', null, choice.roles).rules.lead).toBeNull()
    const old = generate(LIB, OPTS, 900, { rules: { character: null, lead: null } })
    expect([old.rules.character, old.rules.lead]).toEqual([null, null])
    expect(old.choices.some((c) => /led by|dark and dubby|bright and disco|stripped|deep and warm/.test(c))).toBe(false)
  })
})

describe('the breakdown layer: a pad or a reese', () => {
  it('holds the key\'s chord on a pad, its root low on a reese', () => {
    expect(padNotes('Am', false)!.map((n) => n[2])).toEqual([57, 60, 64, 69])
    expect(padNotes('C', false)!.map((n) => n[2])).toEqual([48, 52, 55, 60])
    expect(padNotes('Am', true)!.map((n) => n[2])).toEqual([33])
    expect(padNotes('F#m', true)!.map((n) => n[2])).toEqual([30])
    expect(padNotes('Am', false)!.every((n) => n[0] === 0 && n[1] === PAD_BARS * 4)).toBe(true)
    expect(padNotes(null, false)).toBeNull()
    expect(isReese(serum('Dark Reese', 'Reese'))).toBe(true)
    expect(isReese(serum('Wide Sub', 'Basses'))).toBe(true)
    expect(isReese(serum('Warm Pad'))).toBe(false)
  })

  it('lays a breakdown out: stripped first, then the layer, the lead from halfway', () => {
    expect(breakShape(40, 32)).toEqual({ layer: 48, lead: 56 })
    expect(breakShape(40, 16)).toEqual({ layer: 44, lead: 48 })
    expect(breakShape(40, 8)).toEqual({ layer: 40, lead: 44 })
  })

  it('brings it in once the breakdown has stripped down, opening and rising into the drop, never outside breakdowns', () => {
    const withPad = gens.filter((g) => padClips(g).length)
    expect(withPad.length).toBeGreaterThan(gens.length * 0.4)
    for (const g of withPad) {
      const breaks = g.sections.filter((s) => s.kind === 'break')
      for (const s of breaks) {
        // (Split where the mix high-pass into the drop rides its last bars.)
        const cs = padClips(g).filter((c) => c.start >= s.start * 4 && c.start < (s.start + s.bars) * 4)
        if (!cs.length) continue
        // (The big breakdown has it once stripped; a short one, its shorter copy, from its second part.)
        const short = breaks.some((x) => x.long) && !s.long
        expect(Math.min(...cs.map((c) => c.start))).toBe(breakShape(s.start, s.bars)[short ? 'lead' : 'layer'] * 4)
        // To the end of the breakdown (less the beat or two of silence before a drop).
        const end = Math.max(...cs.map((c) => c.start + c.length))
        // (The track's gap before drops may be a bar.)
        const gap = g.sections[g.sections.indexOf(s) + 1]?.kind === 'drop' && g.rules.dropIn != null && g.rules.dropIn !== 'straight' ? Number(g.rules.dropInBeats) : 2
        expect(end).toBeGreaterThanOrEqual((s.start + s.bars) * 4 - Math.max(2, gap))
        expect(end).toBeLessThanOrEqual((s.start + s.bars) * 4)
        expect(cs[0].fadeIn).toBeGreaterThan(0)
      }
      for (const c of padClips(g)) {
        expect(g.sections.some((x) => x.kind === 'break' && c.start >= x.start * 4 && c.start < (x.start + x.bars) * 4)).toBe(true)
        expect(c.filter?.type).toMatch(/lowpass|highpass/)
        expect(c.bass!.notes).toEqual(padNotes(g.key, c.bass!.midiName === 'Reese'))
        expect(c.sample.relPath).toBe(bassPath(c.bass!, g.project.bpm))
        expect(c.sample.relPath.startsWith('.drumvault/pads/')).toBe(true)
      }
      // A reese is a low note: mono low end, no low cut.
      const lane = laneOf(g, 'Pad')!
      const reese = padClips(g)[0].bass!.midiName === 'Reese'
      expect(lane.monoBelow).toBe(reese ? 120 : undefined)
      expect(lane.eq?.bands.some((b) => b.type === 'highpass') ?? false).toBe(!reese)
      expect(g.choices.some((c) => c.startsWith('break layer: '))).toBe(true)
    }
    expect(withPad.some((g) => padClips(g)[0].bass!.midiName === 'Reese')).toBe(true)
    expect(withPad.some((g) => padClips(g)[0].bass!.midiName === 'Pad')).toBe(true)
    // No patches: none; the rest of the track is the same with or without it.
    const g = withPad[0]
    const bare = generate(LIB, { ...OPTS, pads: null }, g.seed)
    expect(padClips(bare)).toEqual([])
    const rest = (x: Generation) => JSON.stringify(x.project.clips.filter((c) => !(c.type === 'audio' && c.bass?.role === 'pad')).map(({ id: _i, laneId: _l, ...c }) => c))
    expect(rest(bare)).toBe(rest(g))
  })

  it('is made again with another patch, or moved into another key with the rest', () => {
    const g = gens.find((x) => padClips(x).length)!
    const r = rerollPad(LIB, OPTS, g, 5)!
    expect(r).not.toBeNull()
    const other = changeKey(LIB, OPTS, g, g.key === 'Cm' ? 'Dm' : 'Cm', 1)
    for (const c of padClips(other)) expect(c.bass!.notes).toEqual(padNotes(other.key, c.bass!.midiName === 'Reese'))
  })
})

describe('a split clip goes on where it was', () => {
  it('continues a filter sweep and a volume ride across the split, fades at their ends', () => {
    let checked = 0
    for (const g of gens) {
      const byLane = new Map<string, AudioClip[]>()
      for (const c of g.project.clips) if (c.type === 'audio') byLane.set(c.laneId, [...byLane.get(c.laneId) ?? [], c])
      for (const cs of byLane.values()) {
        const sorted = cs.sort((a, b) => a.start - b.start)
        for (let i = 1; i < sorted.length; i++) {
          const [a, b] = [sorted[i - 1], sorted[i]]
          // Two parts of one sweep: back to back, the same sample, the first ending where the second starts.
          if (a.start + a.length !== b.start || a.sample.relPath !== b.sample.relPath || !a.filter?.to || !b.filter || a.filter.type !== b.filter.type) continue
          if (a.filter.to !== b.filter.from) continue
          expect(b.filter.from).not.toBe(a.filter.from)
          if (a.gainTo != null && b.gainDb !== 0) expect(b.gainDb).toBe(a.gainTo)
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(5)
  })
})
