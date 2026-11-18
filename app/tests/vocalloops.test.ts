import { describe, expect, it, vi } from 'vitest'

// The exporter talks to the app through `window.drumvault`; info.txt needs none of it.
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window = { drumvault: {} }
})

import { describeTrack, HOT_TAGS, houseTags, LABELS } from '../src/arrange/describe'
import { infoText, INFO_FILE } from '../src/arrange/exporter'
import { balanceFrom } from '../src/generate/balance'
import { generate, rerollVocal, type GenerateOptions, type Generation } from '../src/generate/generator'
import { Rng } from '../src/generate/rng'
import { templateFrom, vocalAtWeights, vocalRuleOf } from '../src/generate/template'
import { folderLoopFits, LOOP_MAX_BPM, LOOP_MAX_SHIFT, loopFits, type VocalTake } from '../src/generate/vocals'
import type { SampleListItem, TrackArrangement } from '../src/types/api'
import type { Category, SampleKind } from '../src/types/engine'
import type { Project } from '../src/types/project'
import type { VocalMeta } from '../src/vocals/plan'

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
const LIB = library()

/** A Splice loop: sung in `key`, at `bpm` (null: a phrase), used in `used`. */
const loop = (id: string, key: string, bpm: number | null = 124, used: string[] = []): VocalTake => ({
  id, lines: [], bpm: bpm ?? 124, key, seconds: 16, createdAt: '2026-11-17T00:00:00Z', source: 'splice', model: '', format: 'wav', headers: {},
  credits: null, take: `Vocals/${id}/vocal.wav`, vocal: `Vocals/${id}/vocal.wav`, stems: [], durationS: 16, keyHeard: key, usedIn: used,
  splice: { file: `T_VA_124_vocal_hook_${id}_${key}.wav`, original: `/Splice/${id}.wav`, sha1: id, pack: 'Vocal Allstars', label: 'Toolroom',
    url: 'https://splice.com/sounds/packs/toolroom-records/toolroom-vocal-all-stars/samples', bpm, loop: bpm != null, key_source: 'name', tags: [] },
  analysis: {
    key, bpm: 124,
    phrases: [{ path: `Vocals/${id}/phrases/phrase-8bars.wav`, bars: 8, period_s: 15.5, stretch: 1 }],
    chops: [{ path: `Vocals/${id}/chops/chop-01.wav`, note: 64, seconds: 0.3, energy_db: -20 }, { path: `Vocals/${id}/chops/chop-02.wav`, note: 67, seconds: 0.25, energy_db: -22 }],
  },
})
const sings = (g: Generation) => g.picks.vocal?.rel_path.split('/')[1] ?? null

describe('Splice vocal loops', () => {
  it('fit a track within two semitones of its key and four BPM of its tempo, never once exported', () => {
    expect([LOOP_MAX_SHIFT, LOOP_MAX_BPM]).toEqual([2, 4])
    expect(loopFits(loop('a', 'Am'), 'Am', 124)).toBe(true)
    expect(loopFits(loop('a', 'C'), 'Am', 124)).toBe(true)          // the relative key: the same notes
    expect(loopFits(loop('a', 'Bm'), 'Am', 124)).toBe(true)         // 2 down
    expect(loopFits(loop('a', 'Gm'), 'Am', 124)).toBe(true)         // 2 up
    expect(loopFits(loop('a', 'Cm'), 'Am', 124)).toBe(false)        // 3 away
    expect(loopFits(loop('a', 'Am', 128), 'Am', 124)).toBe(true)
    expect(loopFits(loop('a', 'Am', 129), 'Am', 124)).toBe(false)
    expect(loopFits(loop('a', 'Am', null), 'Am', 131)).toBe(true)   // a phrase has no tempo of its own
    expect(loopFits(loop('a', 'Am', 124, ['Generated 03']), 'Am', 124)).toBe(false)
    expect(loopFits(loop('a', 'Am'), null, 124)).toBe(false)
    const made = { ...loop('a', 'Am'), source: 'elevenlabs' as const, splice: undefined }
    expect(loopFits(made, 'Am', 124)).toBe(false)                   // a made vocal isn't one of the loops
  })

  it('in the Splice folder, fit by their names until imported (no key or tempo in the name: maybe)', () => {
    const file = (key_label: string | null, bpm: number | null = 124, key_source: 'name' | 'root' | null = key_label ? 'name' : null,
      imported: 'vocal' | null = null) => ({ kind: 'vocal' as const, imported, key_label, key_source, bpm })
    expect(folderLoopFits(file('Am'), 'Am', 124)).toBe(true)
    expect(folderLoopFits(file('C'), 'Am', 124)).toBe(true)          // the relative key
    expect(folderLoopFits(file('Cm'), 'Am', 124)).toBe(false)        // 3 away
    expect(folderLoopFits(file('Am', 129), 'Am', 124)).toBe(false)   // too fast
    expect(folderLoopFits(file('Am', null), 'Am', 124)).toBe(true)   // a phrase
    expect(folderLoopFits(file(null), 'Am', 124)).toBe(true)         // its key is read on import
    expect(folderLoopFits(file('Eb', 124, 'root'), 'Cm', 124)).toBe(true)   // a bare root: Eb major is Cm's relative
    expect(folderLoopFits(file('A', 124, 'root'), 'Am', 124)).toBe(true)    // …or A minor
    expect(folderLoopFits(file('Am', 124, 'name', 'vocal'), 'Am', 124)).toBe(false)  // imported: a take now
    expect(folderLoopFits({ ...file('Am'), kind: 'stab' as const }, 'Am', 124)).toBe(false)
    expect(folderLoopFits(file('Am'), null, 124)).toBe(false)
  })

  const POOL = [loop('fits', 'Am'), loop('far', 'Ebm'), loop('fast', 'Am', 132), loop('used', 'Am', 124, ['Generated 01'])]
  const opts: GenerateOptions = { bpm: BPM, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true, vocals: { takes: POOL, pool: { chance: 0.6 } } }
  const gs = Array.from({ length: 60 }, (_, i) => generate(LIB, opts, 9100 + i))

  it('are sung in some new tracks, only one that fits, the rest of the track as without', () => {
    const inAm = gs.filter((g) => g.key === 'Am')
    expect(inAm.length).toBeGreaterThan(20)
    const sang = inAm.filter((g) => sings(g))
    expect(sang.length).toBeGreaterThan(inAm.length * 0.4)
    expect(sang.length).toBeLessThan(inAm.length * 0.8)
    // Never the one too far from the key, too fast or exported; and only in a key it fits.
    for (const g of gs) if (sings(g)) expect([sings(g), loopFits(POOL[0], g.key, BPM)]).toEqual(['fits', true])
    // The rest of the track is drawn as without the loops.
    const voc = (c: { sample: { relPath: string } }) => c.sample.relPath.startsWith('Vocals/') || c.sample.relPath.startsWith('.drumvault/vocals/')
    for (const g of sang.slice(0, 5)) {
      const bare = generate(LIB, { ...opts, vocals: null }, g.seed)
      const rest = (x: Generation) => JSON.stringify(x.project.clips.filter((c) => !voc(c)).map(({ id: _i, laneId: _l, ...c }) => c))
      expect(rest(g)).toBe(rest(bare))
    }
  })

  it('sing the loop moved into the key, and another loop replaces it (one vocal per track)', () => {
    const g = gs.find((x) => sings(x) === 'fits')!
    const phrase = g.project.clips.find((c) => c.type === 'audio' && c.bass?.role === 'vocal')
    if (phrase && phrase.type === 'audio') expect([phrase.bass!.vocal!.take, phrase.bass!.transpose]).toEqual(['fits', 0])
    const other = loop('other', 'Gm')
    const r = rerollVocal(LIB, { ...opts, vocals: { takes: [other] } }, g, 3)!
    expect(sings(r)).toBe('other')
    const moved = r.project.clips.find((c) => c.type === 'audio' && c.bass?.role === 'vocal')
    if (moved && moved.type === 'audio') expect(moved.bass!.transpose).toBe(2)
    expect(r.project.clips.some((c) => c.sample.relPath.startsWith('Vocals/fits/'))).toBe(false)
  })
})

describe('vocals from the examples (the user\'s tracks)', () => {
  function track(code: string, runs: Record<string, [number, number][]>, vocal?: [number, number][], lufs: number | null = null, kick = -17): TrackArrangement {
    const str = (rs: [number, number][]) => rs.map(([v, n]) => String(v).repeat(n)).join('')
    const parts = Object.fromEntries(Object.entries(runs).map(([p, rs]) => [p, str(rs)]))
    return {
      zip_id: 1, source_code: code, bpm: 124, bars: Math.max(...Object.values(parts).map((x) => x.length)), parts,
      levels: { parts: { kick }, normalized: false, vocals_measured: true, ...(vocal ? { vocal: { bars: str(vocal), lufs } } : {}) },
    }
  }
  // Intro 32, drop 32, break 16, drop 32, outro 32.
  const RUNS: Record<string, [number, number][]> = {
    kick: [[2, 31], [0, 1], [2, 32], [0, 16], [2, 32], [2, 32]],
    hats: [[2, 32], [2, 32], [2, 16], [2, 32], [2, 32]],
    clap: [[0, 32], [2, 32], [0, 16], [2, 32], [0, 32]],
    bass: [[0, 32], [2, 32], [1, 16], [2, 32], [0, 32]],
  }
  const inBreak = track('S1', RUNS, [[0, 64], [2, 16], [0, 64]], -26)
  const inHalves = track('S2', RUNS, [[0, 48], [2, 16], [0, 32], [2, 16], [0, 32]], -24)
  const inDrops = track('S3', RUNS, [[0, 32], [2, 32], [0, 16], [2, 32], [0, 32]], -22)
  const silent = track('S4', RUNS)

  it('read where a track sings: its breakdown, its drops\' second halves, its drops', () => {
    expect(vocalRuleOf(inBreak)?.vocalAt).toBe('breaks')
    expect(vocalRuleOf(inHalves)?.vocalAt).toBe('halves')
    expect(vocalRuleOf(inDrops)?.vocalAt).toBe('drops')
    expect(vocalRuleOf(silent)).toBeNull()
    expect(vocalAtWeights([inBreak, inHalves, inDrops, inDrops, silent])).toEqual([['drops', 2], ['halves', 1], ['breaks', 1]])
    expect(vocalAtWeights([silent])).toBeNull()
  })

  it('a track built on one sings where that one does', () => {
    const t = templateFrom(inHalves, new Rng(4), 64, 400)!
    expect(t.rules.vocalAt).toBe('halves')
    expect(templateFrom(silent, new Rng(4), 64, 400)!.rules.vocalAt).toBeUndefined()
  })

  it('a vocal sits as far under the kick as in the user\'s tracks', () => {
    const b = balanceFrom([inBreak, inHalves, inDrops])
    expect(b.db.vocal).toBe(-7)            // median of -9, -7, -5 against a -17 kick
    expect(b.db.vchop).toBe(-10)           // its chops 3 dB under it, as by default
    expect(balanceFrom([inBreak, inHalves]).db.vocal).toBe(-3)   // fewer than three tracks: the default
  })
})

describe('info.txt', () => {
  const project = (clips: Project['clips']): Project => ({
    name: 'Generated 08', bpm: 124, lengthBars: 160, lanes: [], clips, createdAt: '', generation: { key: 'Em' },
  } as unknown as Project)
  const sungBy = (id: string) => [{ id: 'c', laneId: 'l', type: 'audio', start: 0, length: 32, sample: { relPath: `.drumvault/vocals/x.wav` },
    bass: { role: 'vocal', vocal: { key: 'Em', take: id } } }] as unknown as Project['clips']
  const o = { folder: 'Generated 08 - 124 BPM - E minor', range: { startBeat: 0, endBeat: 640 } }

  it('says the track\'s tempo, key and length, and where a Splice vocal is from', () => {
    const t = loop('v1', 'Em') as VocalMeta
    expect(INFO_FILE).toBe('info.txt')
    expect(infoText(project(sungBy('v1')), o, [t])).toBe([
      'Title: Generated 08 - 124 BPM - E minor', 'BPM: 124', 'Key: E minor', 'Length: 5:10 (160 bars)', '',
      'About the track', 'Club house in a minor key at 124 BPM in E minor: just kick, clap and hats.',
      'Would sit well on labels like Toolroom, Defected and Hot Creations.', 'Tags: Club, Groovy, Dark', '',
      'Vocals', '- T_VA_124_vocal_hook_v1_Em.wav', '  Splice pack: Vocal Allstars (Toolroom)',
      '  https://splice.com/sounds/packs/toolroom-records/toolroom-vocal-all-stars/samples', '',
    ].join('\n'))
  })

  it('credits a made vocal to ElevenLabs, and says when a track sings none', () => {
    const made = { ...loop('m1', 'Em'), source: 'elevenlabs', lines: ['Hold on'], voice: 'female', mood: 'gospel', splice: undefined } as VocalMeta
    expect(infoText(project(sungBy('m1')), o, [made])).toContain('- “Hold on”\n  AI-generated with ElevenLabs (female, gospel); lyrics written for this app')
    expect(infoText(project([]), o, [made])).toContain('\nVocals: none\n')
  })
})

describe('the track described in info.txt', () => {
  const gs = Array.from({ length: 12 }, (_, i) => generate(LIB, { bpm: BPM, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true }, 9300 + i))
  const about = (g: Generation, sung: VocalMeta[] = []) =>
    describeTrack({ ...g.project, generation: g } as Project, sung, g.sections.reduce((n, x) => n + x.bars, 0))

  it('says what kind of house it is, what it\'s made of, its DJ layout and labels it would sit with', () => {
    for (const g of gs) {
      const [what, layout, labels] = about(g)
      const c = g.rules.character as keyof typeof LABELS | null
      expect(what).toMatch(new RegExp(`^.+ at 124 BPM in [A-G][#b]? (minor|major)(, built around .+)?: .+\\.$`))
      if (c) expect(what.toLowerCase()).toContain(c === 'drums' ? 'percussive' : c === 'disco' ? 'disco' : c === 'dub' ? 'dubby' : 'deep')
      const drops = g.sections.filter((x) => x.kind === 'drop').length
      expect(layout).toContain(`${g.sections.reduce((n, x) => n + x.bars, 0)} bars`)
      expect(layout).toContain(`${['no', 'one', 'two', 'three', 'four'][drops]} drop`)
      expect(labels).toBe(`Would sit well on labels like ${LABELS[c ?? 'none'][0]}, ${LABELS[c ?? 'none'][1]} and ${LABELS[c ?? 'none'][2]}.`)
    }
  })

  it('names the vocal and where it sings; a soulful made vocal leans to Defected', () => {
    const g = gs.find((x) => x.rules.character === 'dub') ?? gs[0]
    const lanes = [...g.project.lanes, { id: 'v', name: 'Vocal', mute: false } as Project['lanes'][number]]
    const clips = [...g.project.clips, { id: 'vc', laneId: 'v', type: 'audio', start: 0, length: 4, sample: { relPath: 'x' } } as unknown as Project['clips'][number]]
    const made = { ...loop('m', 'Am'), source: 'elevenlabs', voice: 'female', mood: 'gospel', lines: ['Hold on'], splice: undefined } as VocalMeta
    const [what, , labels] = describeTrack({ ...g.project, lanes, clips, generation: { ...g, rules: { ...g.rules, vocalAt: 'halves' } } } as Project, [made], 160)
    expect(what).toContain('a gospel female vocal in the second half of each drop')
    expect(labels.startsWith('Would sit well on labels like Defected')).toBe(true)
  })

  it('picks three House of Tracks tags that fit: its character\'s, a soulful vocal\'s', () => {
    const want: Record<string, string> = { dub: 'Dub', disco: 'Funky', drums: 'Raw' }
    for (const g of gs) {
      const tags = houseTags({ ...g.project, generation: g } as Project, [])
      expect(tags.length).toBe(3)
      expect(new Set(tags).size).toBe(3)
      for (const t of tags) expect(HOT_TAGS).toContain(t)
      const c = String(g.rules.character)
      if (want[c]) expect(tags).toContain(want[c])
      else expect(tags).toContain('Club')
    }
    const g = gs.find((x) => x.rules.character === 'deep') ?? gs[0]
    const lanes = [...g.project.lanes, { id: 'v', name: 'Vocal', mute: false } as Project['lanes'][number]]
    const clips = [...g.project.clips, { id: 'vc', laneId: 'v', type: 'audio', start: 0, length: 4, sample: { relPath: 'x' } } as unknown as Project['clips'][number]]
    const made = { ...loop('m', 'Am'), source: 'elevenlabs', voice: 'female', mood: 'gospel', lines: ['Hold on'], splice: undefined } as VocalMeta
    expect(houseTags({ ...g.project, lanes, clips, generation: g } as Project, [made])).toContain('Soulful')
  })
})
