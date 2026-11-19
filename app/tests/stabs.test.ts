import { describe, expect, it } from 'vitest'
import { createEcho } from '../src/audio/reverb'
import { ECHO_BEATS, eventsInRange } from '../src/audio/schedule'
import { CLAP_VS_KICK_DB, hitLoudness, levelLanes, STAB_UNDER_KICK_DB, STAB_VS_CLAP_DB, STAB_VS_KICK_DB, type Balance } from '../src/generate/balance'
import { refine, STAB_SHIFT } from '../src/generate/critic'
import { hitPitch, hitSample } from '../src/generate/disco'
import { generate, laneRole, setTrackRule, type GenerateOptions, type Generation } from '../src/generate/generator'
import { CHOICES } from '../src/generate/choices'
import { Rng } from '../src/generate/rng'
import { accented, bassSteps, closestGap, focusWeight, hitFocus, isChord, loopJobs, loopParts, perBarFor, rollBar, shiftWeight, sparse, stabRhythm, stabWeight, turned, type StabLayout } from '../src/generate/stabs'
import type { HitItem, LoopGroove, MidiItem, SampleListItem, SerumPreset } from '../src/types/api'
import type { Category, SampleKind } from '../src/types/engine'
import type { Clip, Lane, PatternClip, Project, Velocity } from '../src/types/project'

const BPM = 124
const tone = (hz: number) => Array.from({ length: 24 }, (_, i) => -6 * Math.log2((40 * 400 ** ((i + 0.5) / 24)) / hz) ** 2 - 3)
const on = (...h: number[]) => Array.from({ length: 16 }, (_, i) => (h.includes(i) ? 3 : 0)) as Velocity[]
const hitsOf = (b: number[]) => b.flatMap((v, i) => (v ? [i] : []))
let nextHit = 1
const hit = (extra: Partial<HitItem> = {}): HitItem => {
  const id = nextHit++
  return { id, kind: 'stab', file_name: `stab${id}.wav`, name: `stab${id}`, rel_path: `Chord Stabs/stab${id}.wav`, key_label: 'Am', key_camelot: null,
    key_source: 'name', pitch_fix: 0, duration_s: 0.4, channels: 2, energy_db: -21, tone: tone(1500), punch_db: -14, voices: 3, ...extra }
}

describe('stab rhythms written against the bassline', () => {
  // A bass on the 1 and the "and" of 2 of every bar, each held for an 8th.
  const notes: [number, number, number, number][] = [[0, 0.5, 33, 100], [1.5, 0.5, 33, 100]]
  const bass = bassSteps(notes, 1)

  it('reads where the bass starts and sounds, a 1-bar loop in both bars, a 4-bar loop folded onto two', () => {
    expect(hitsOf(bass.onset.map(Number))).toEqual([0, 6, 16, 22])
    expect(hitsOf(bass.sounding.map(Number))).toEqual([0, 1, 6, 7, 16, 17, 22, 23])
    const four = bassSteps([[0, 0.25, 33, 100], [9, 0.25, 33, 100]], 4)   // bar 1 beat 1, bar 3 beat 2
    expect(hitsOf(four.onset.map(Number))).toEqual([0, 4])
  })

  it('answers the bass in its rests, or locks onto its syncopations', () => {
    const count = (mode: 'answer' | 'lock') => {
      let onBass = 0, all = 0
      for (let seed = 1; seed <= 300; seed++) {
        for (const [k, b] of stabRhythm(new Rng(seed), [], { bass, mode }).entries()) {
          for (const i of hitsOf(b)) { all++; if (bass.onset[k * 16 + i]) onBass++ }
        }
      }
      return onBass / all
    }
    expect(count('answer')).toBeLessThan(0.05)
    expect(count('lock')).toBeGreaterThan(0.25)
  })

  it('leaves a saved rhythm taken as it is alone, and draws as many stabs a bar as asked', () => {
    const saved = [{ name: 'mine', steps: [on(0, 6), on(0, 6)] }]
    const exact = Array.from({ length: 200 }, (_, i) => stabRhythm(new Rng(i + 1), saved, { bass, mode: 'answer' }))
    expect(exact.some((r) => r.every((b) => hitsOf(b).join() === '0,6'))).toBe(true)
    for (let seed = 1; seed <= 50; seed++) {
      for (const b of stabRhythm(new Rng(seed), [], { perBar: [[4, 1]] })) expect(hitsOf(b).length).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('phrasing', () => {
  const r = [on(2, 10), on(6, 14)]
  it('accents the first stab of each bar, and has a lean version', () => {
    expect(accented(r)).toEqual([[0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 2, 0]])
    expect(sparse(r).map(hitsOf)).toEqual([[2], [6]])
  })
  it('turns a phrase\'s last bar: the last stab out, early, or twice', () => {
    expect(hitsOf(turned(on(6, 12), 'drop'))).toEqual([6])
    expect(hitsOf(turned(on(6, 12), 'push'))).toEqual([6, 11])
    expect(hitsOf(turned(on(6, 12), 'double'))).toEqual([6, 12, 14])
    expect(hitsOf(turned(on(6, 12), 'none'))).toEqual([6, 12])
    // A bar's only stab is never dropped; one right behind another isn't pushed into it.
    expect(hitsOf(turned(on(6), 'drop'))).toEqual([6])
    expect(hitsOf(turned(on(6, 8), 'push'))).toEqual([6, 8])
  })
  it('knows the closest two stabs of a rhythm, round the loop', () => {
    expect(closestGap([on(2, 10), on(6)])).toBe(8)
    expect(closestGap([on(2, 5)])).toBe(3)
    expect(closestGap([on(4)])).toBe(16)
  })
})

describe('which stabs', () => {
  it('prefers a stab near the key, and one that doesn\'t pile onto the tops', () => {
    expect(shiftWeight(0)).toBe(1)
    expect(shiftWeight(-2)).toBe(1)
    expect(shiftWeight(3)).toBeLessThan(1)
    expect(shiftWeight(7)).toBeLessThan(shiftWeight(4))
    const tops = tone(5000)
    expect(stabWeight(hit({ tone: tone(800) }), 0, tops, [], 2.78)).toBeGreaterThan(stabWeight(hit({ tone: tone(5000) }), 0, tops, [], 2.78) * 1.5)
  })
  it('makes a set: the first one\'s kind, another register, never the same sound twice', () => {
    const first = hit({ tone: tone(1500), voices: 4 })
    const w = (h: HitItem) => stabWeight(h, 0, null, [first], 2.78)
    expect(w(hit({ tone: tone(4000), voices: 3 }))).toBeGreaterThan(w(hit({ tone: tone(4000), voices: 1 })))
    expect(w(hit({ tone: tone(4000), voices: 3 }))).toBeGreaterThan(w(hit({ tone: tone(1500), voices: 3 })) * 3)
    expect(isChord(hit({ voices: 1 }))).toBe(false)
    expect(isChord(hit({ voices: null }))).toBeNull()
  })
  it('gives single notes a busier rhythm, long or chordal stabs a sparser one', () => {
    const most = (per: [number, number][]) => per.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
    expect(most(perBarFor([hit({ voices: 1 }), hit({ voices: 2 })]))).toBe(3)
    expect(perBarFor([hit({ duration_s: 1.5 })]).find(([n]) => n === 1)![1]).toBeGreaterThan(perBarFor([hit()]).find(([n]) => n === 1)![1])
  })
})

describe('stab levels: hit for hit', () => {
  const sample = (kind: SampleKind, category: Category, extra: Partial<SampleListItem>): SampleListItem => ({
    id: nextHit++, rel_path: `${category}${nextHit}.wav`, name: category, kind, category, bpm: null, bars: null, body_bars: null, key_label: null, key_camelot: null,
    duration_s: 0.3, channels: 2, favorite: 0, rating: null, tags: null, zip_id: 1, source_code: 'S0001', energy_db: -15, tone: tone(100), ...extra,
  })
  // (The kick's hits harder than the clap's, as in the user's tracks: about 10 dB.)
  const kick = sample('oneshot', 'kick', { energy_db: -22, punch_db: -5 })
  const clap = sample('oneshot', 'clap', { energy_db: -18, punch_db: -11 })
  const stab = hitSample(hit({ energy_db: -19, punch_db: -12, duration_s: 0.25 }))
  const lane = (name: string): Lane => ({ id: name, name, color: '#fff', volumeDb: 0, pan: 0, mute: false, solo: false, height: 40 })
  const pat = (laneId: string, s: SampleListItem, hits: number[], bars: 1 | 2 = 1): PatternClip => ({
    id: laneId, laneId, type: 'pattern', start: 0, length: 64, gainDb: 0, patternBars: bars,
    sample: { id: s.id, relPath: s.rel_path, name: s.name, kind: s.kind, category: s.category } as PatternClip['sample'],
    steps: Array.from({ length: 16 * bars }, (_, k) => (hits.includes(k) ? 3 : 0)) as Velocity[],
  })
  const level = (stabHits: number[], bars: 1 | 2, withClap = true) => {
    const p = { bpm: BPM, lanes: [lane('Kick'), ...(withClap ? [lane('Clap')] : []), lane('Stab')],
      clips: [pat('Kick', kick, [0, 4, 8, 12]), ...(withClap ? [pat('Clap', clap, [4, 12])] : []), pat('Stab', stab, stabHits, bars)] as Clip[] } as unknown as Project
    levelLanes(p, new Map([kick, clap, stab].map((s) => [s.rel_path, s])), { db: { clap: -4 }, tracks: 0 }, [[0, 64]], laneRole, () => 0)
    return Object.fromEntries(p.lanes.map((l) => [l.name, l.levelDb!]))
  }

  it('takes a hit\'s loudness from its punch, else from its energy over its length', () => {
    expect(hitLoudness({ energy_db: -20, punch_db: -12, duration_s: 1 })).toBe(-12)
    expect(hitLoudness({ energy_db: -20, punch_db: null, duration_s: 0.5 })).toBeCloseTo(-17, 1)
    expect(hitLoudness({ energy_db: -20, punch_db: null, duration_s: 0.05 })).toBeCloseTo(-13, 1)
    expect(hitLoudness({ energy_db: null, punch_db: null, duration_s: 1 })).toBeNull()
  })

  it('sets a stab the same however many hits its rhythm has: a little under the clap\'s hits', () => {
    const busy = level([2, 6, 10], 1)
    const lone = level([2], 2)
    expect(lone.Stab).toBe(busy.Stab)
    // One stab hit = one clap hit and its step.
    expect(Math.abs(-12 + busy.Stab - (-11 + busy.Clap + STAB_VS_CLAP_DB))).toBeLessThanOrEqual(0.5)
    expect(-12 + busy.Stab).toBeLessThan(-5 + busy.Kick - STAB_UNDER_KICK_DB)   // (not held down by the ceiling here)
  })

  it('keeps a stab\'s hits under the kick\'s, loudness against loudness, and goes by the kick without a clap', () => {
    const with_ = (s: SampleListItem, clapDb: number) => {
      const p = { bpm: BPM, lanes: [lane('Kick'), lane('Clap'), lane('Stab')],
        clips: [pat('Kick', kick, [0, 4, 8, 12]), pat('Clap', clap, [4, 12]), pat('Stab', s, [2])] as Clip[] } as unknown as Project
      levelLanes(p, new Map([kick, clap, s].map((x) => [x.rel_path, x])), { db: { clap: clapDb }, tracks: 0 }, [[0, 64]], laneRole, () => 0)
      return Object.fromEntries(p.lanes.map((l) => [l.name, l.levelDb!]))
    }
    // A quiet stab sample takes the gain it needs, more than the kick's lane (it used to be held at the kick's gain).
    const quiet = hitSample(hit({ energy_db: -30, punch_db: -24 }))
    const q = with_(quiet, -4)
    expect(q.Stab).toBeGreaterThan(q.Kick)
    expect(Math.abs(-24 + q.Stab - (-11 + q.Clap + STAB_VS_CLAP_DB))).toBeLessThanOrEqual(0.5)
    // A clap pushed up to the kick: the stab's hits stay 3 dB under the kick's.
    const by = with_(stab, 6)
    expect(-12 + by.Stab).toBeCloseTo(-5 + by.Kick - STAB_UNDER_KICK_DB, 0)
    const noClap = level([2, 10], 1, false)
    expect(Math.abs(-12 + noClap.Stab - (-5 + noClap.Kick + STAB_VS_KICK_DB))).toBeLessThanOrEqual(0.5)
  })
})

describe('moments are levelled hit for hit too: drop hits, fills, impacts, crashes, FX', () => {
  const sample = (kind: SampleKind, category: Category, extra: Partial<SampleListItem>): SampleListItem => ({
    id: nextHit++, rel_path: `${category}${nextHit}.wav`, name: category, kind, category, bpm: null, bars: null, body_bars: null, key_label: null, key_camelot: null,
    duration_s: 0.3, channels: 2, favorite: 0, rating: null, tags: null, zip_id: 1, source_code: 'S0001', energy_db: -15, tone: tone(100), ...extra,
  })
  const kick = sample('oneshot', 'kick', { energy_db: -22, punch_db: -15 })
  const clap = sample('oneshot', 'clap', { energy_db: -18, punch_db: -11 })
  const disco = sample('oneshot', 'disco_hit', { energy_db: -20, punch_db: -13 })
  const fillA = sample('event', 'fill', { energy_db: -10, punch_db: -12, duration_s: 2 })
  const fillLoud = sample('event', 'fill', { energy_db: -4, punch_db: -6, duration_s: 2 })
  const fillQuiet = sample('event', 'fill', { energy_db: -16, punch_db: -18, duration_s: 2 })
  const lane = (name: string): Lane => ({ id: name, name, color: '#fff', volumeDb: 0, pan: 0, mute: false, solo: false, height: 40 })
  const ref = (x: SampleListItem) => ({ id: x.id, relPath: x.rel_path, name: x.name, kind: x.kind, category: x.category })
  const pat = (laneId: string, x: SampleListItem, hits: number[], start = 0, length = 64): PatternClip => ({
    id: `${laneId}${start}`, laneId, type: 'pattern', start, length, gainDb: 0, patternBars: 1, sample: ref(x) as PatternClip['sample'],
    steps: Array.from({ length: 16 }, (_, k) => (hits.includes(k) ? 3 : 0)) as Velocity[],
  })
  const ev = (laneId: string, x: SampleListItem, start: number): Clip => ({ id: `${laneId}${start}`, laneId, type: 'audio', start, length: 8, trimBeats: 0, gainDb: 0, sample: ref(x) } as Clip)
  const all = new Map([kick, clap, disco, fillA, fillLoud, fillQuiet].map((x) => [x.rel_path, x]))
  const run = (clips: Clip[], lanes: string[], hits?: Balance['hits']) => {
    const p = { bpm: BPM, lanes: ['Kick', 'Clap', ...lanes].map(lane), clips: [pat('Kick', kick, [0, 4, 8, 12]), pat('Clap', clap, [4, 12]), ...clips] } as unknown as Project
    levelLanes(p, all, { db: { clap: -4 }, tracks: 0, hits }, [[0, 64]], laneRole, () => 0)
    return p
  }
  const levelOf = (p: Project, name: string) => p.lanes.find((l) => l.name === name)!.levelDb!

  it('sets a lone drop hit by its own loudness, not by how rarely it plays', () => {
    const rare = run([pat('Drop Hit', disco, [0], 0, 4)], ['Drop Hit'])
    const often = run([pat('Drop Hit', disco, [0, 8], 0, 64)], ['Drop Hit'])
    expect(levelOf(rare, 'Drop Hit')).toBe(levelOf(often, 'Drop Hit'))
    // One drop hit = one clap hit less 1 dB, and under the kick's gain.
    expect(Math.abs(-13 + levelOf(rare, 'Drop Hit') - (-11 + levelOf(rare, 'Clap') - 1))).toBeLessThanOrEqual(0.5)
    expect(levelOf(rare, 'Drop Hit')).toBeLessThanOrEqual(levelOf(rare, 'Kick') - 1)
  })

  it('brings every fill on the lane to the same hit level: a loud one down, a quiet one up', () => {
    const p = run([ev('Fills', fillA, 0), ev('Fills', fillA, 16), ev('Fills', fillLoud, 32), ev('Fills', fillQuiet, 48)], ['Fills'])
    const [a, , loud, quiet] = p.clips.filter((c) => c.laneId === 'Fills')
    expect(a.gainDb).toBe(0)
    expect(loud.gainDb).toBe(-6)
    expect(quiet.gainDb).toBeGreaterThan(0)
    // No fill's hits above the kick's, however quiet its sample (loudness, not gain: a quiet fill may take more gain than the kick).
    const hitAt = (c: Clip, name: string) => hitLoudness(all.get(c.sample.relPath))! + levelOf(p, name) + c.gainDb
    const kickHit = hitAt(p.clips.find((c) => c.laneId === 'Kick')!, 'Kick')
    for (const c of [a, loud, quiet]) expect(hitAt(c, 'Fills')).toBeLessThanOrEqual(kickHit - 1 + 0.25)
    // Doing it again changes nothing.
    const was = p.clips.map((c) => c.gainDb)
    levelLanes(p, all, { db: { clap: -4 }, tracks: 0 }, [[0, 64]], laneRole, () => 0)
    expect(p.clips.map((c) => c.gainDb)).toEqual(was)
  })

  it('without a clap (most organic tracks), sets the moments by the kick as far under it as a clap would put them', () => {
    const hit = (p: Project, name: string, x: SampleListItem) => hitLoudness(x)! + levelOf(p, name)
    // Without one: by the user's tracks' fills against their kick, else as a clap sits under the kick (CLAP_VS_KICK_DB) and the step.
    const noClap = (hitsVsKick?: Balance['hitsVsKick']) => {
      const p = { bpm: BPM, lanes: ['Kick', 'Fills'].map(lane), clips: [pat('Kick', kick, [0, 4, 8, 12]), ev('Fills', fillQuiet, 0)] } as unknown as Project
      levelLanes(p, all, { db: { clap: -4 }, tracks: 0, hits: { fills: -1 }, hitsVsKick }, [[0, 64]], laneRole, () => 0)
      return hit(p, 'Fills', fillQuiet) - hit(p, 'Kick', kick)
    }
    expect(noClap({ fills: -9 })).toBeCloseTo(-9, 0)
    expect(noClap()).toBeCloseTo(-1 + CLAP_VS_KICK_DB, 0)
    // With a clap, by the kick too when the tracks say the step against it and not against the clap.
    const p = run([ev('Fills', fillQuiet, 0)], ['Fills'])
    levelLanes(p, all, { db: { clap: -4 }, tracks: 0, hitsVsKick: { fills: -9 } }, [[0, 64]], laneRole, () => 0)
    expect(hit(p, 'Fills', fillQuiet) - hit(p, 'Kick', kick)).toBeCloseTo(-9, 0)
  })

  it('follows the clap when the mix check moves it afterwards (hit lanes only)', () => {
    // (Fills 1 dB under the clap's hits, so they're not at the kick's ceiling and follow the clap.)
    const p = run([ev('Fills', fillA, 0), pat('Drop Hit', disco, [0], 0, 4)], ['Fills', 'Drop Hit'], { fills: -1 })
    const before = { fills: levelOf(p, 'Fills'), kick: levelOf(p, 'Kick'), clap: levelOf(p, 'Clap') }
    p.lanes.find((l) => l.name === 'Clap')!.levelDb! -= 3      // what checkMix may do to the clap
    levelLanes(p, all, { db: { clap: -4 }, tracks: 0, hits: { fills: -1 } }, [[0, 64]], laneRole, () => 0, undefined, undefined, true)
    expect(levelOf(p, 'Fills')).toBe(before.fills - 3)       // still 1 dB under the clap's hits
    expect([levelOf(p, 'Kick'), levelOf(p, 'Clap')]).toEqual([before.kick, before.clap - 3])  // the other lanes as they are
  })
})

describe('gated hits and delay throws', () => {
  const clip = (extra: Partial<PatternClip>): PatternClip => ({
    id: 'c', laneId: 'Stab', type: 'pattern', start: 0, length: 4, gainDb: 0, patternBars: 1, steps: on(0, 8),
    sample: { id: 1, relPath: 'stab.wav', name: 'stab', kind: 'oneshot', category: 'chord_stab' } as PatternClip['sample'], ...extra,
  })
  const events = (c: PatternClip) => eventsInRange({ bpm: 120, clips: [c] } as unknown as Project, 0, 2)

  it('plays a gated hit its gate\'s length and fades it out at the end', () => {
    const [a] = events(clip({ gate: 1.5 }))
    expect(a.duration).toBeCloseTo(0.75, 5)
    expect(a.release).toBeGreaterThan(0.02)
    expect(a.release).toBeLessThanOrEqual(0.06)
    expect(events(clip({}))[0].duration).toBeNull()
  })

  it('throws a clip to the lane\'s delay, a dotted 8th later at the project tempo', () => {
    const [a] = events(clip({ echo: 0.5 }))
    expect(a.echo).toMatchObject({ send: 0.5, time: (ECHO_BEATS * 60) / 120 })
    expect(a.echo!.feedback).toBeLessThan(0.6)
    expect(events(clip({}))[0].echo).toBeUndefined()
  })

  it('wires the delay as a loop that loses lows and highs each time round, into the lane', () => {
    const node = (extra: object = {}) => {
      const n = { to: [] as unknown[], connect(x: unknown) { n.to.push(x); return x }, disconnect() { n.to = [] }, ...extra }
      return n
    }
    const param = () => ({ value: 0 })
    const ctx = {
      createGain: () => node({ gain: param(), kind: 'gain' }), createDelay: () => node({ delayTime: param(), kind: 'delay' }),
      createBiquadFilter: () => node({ type: '', frequency: param(), Q: param(), kind: 'filter' }),
    } as unknown as BaseAudioContext
    const dest = node()
    const e = createEcho(ctx, dest as unknown as AudioNode) as unknown as { input: ReturnType<typeof node>; delay: ReturnType<typeof node>; feedback: ReturnType<typeof node>; output: ReturnType<typeof node> }
    expect(e.input.to).toEqual([e.delay])
    const hp = e.delay.to[0] as ReturnType<typeof node> & { type: string }
    const lp = hp.to[0] as ReturnType<typeof node> & { type: string }
    expect([hp.type, lp.type]).toEqual(['highpass', 'lowpass'])
    expect(lp.to).toEqual([e.output, e.feedback])
    expect(e.feedback.to).toEqual([e.delay])
    expect(e.output.to).toEqual([dest])
  })
})

// ---------------------------------------------------------------------------
// In a generated track
// ---------------------------------------------------------------------------

const OPTS: GenerateOptions = { bpm: BPM, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true }
const groove = (swing: number): LoopGroove => ({
  offsets: Array.from({ length: 16 }, (_, k) => (k % 2 ? swing : 0)), levels: Array.from({ length: 16 }, (_, k) => (k % 4 === 2 ? 0 : -6)),
  hits: new Array(16).fill(2), swing, push: 0,
})
function library(): SampleListItem[] {
  const out: SampleListItem[] = []
  let id = 1000
  for (let z = 1; z <= 6; z++) {
    const add = (kind: SampleKind, category: Category, extra: Partial<SampleListItem> = {}) => out.push({
      id: id++, rel_path: `${kind}/${category}/${z}_${id}.wav`, name: `${category}_${id}`, kind, category, bpm: kind === 'oneshot' ? null : BPM, bars: kind === 'oneshot' ? null : 2,
      body_bars: null, key_label: 'Am', key_camelot: null, duration_s: kind === 'oneshot' ? 0.3 : 3.87, channels: 2, favorite: 0, rating: null, tags: null,
      zip_id: z, source_code: `S000${z}`, groove: kind === 'loop' ? groove(0.2) : null, shape: null, energy_db: -20, tone: tone(4000), punch_db: -12, ...extra,
    })
    add('oneshot', 'kick', { tone: tone(55), energy_db: -20, punch_db: -13 })
    add('oneshot', 'clap', { energy_db: -18, punch_db: -11 })
    for (const c of ['snare', 'hat_closed', 'perc', 'cymbal'] as Category[]) add('oneshot', c)
    for (const c of ['hat', 'perc', 'top', 'top', 'groove'] as Category[]) add('loop', c)
  }
  return out
}
// Stabs in and far from A minor, some chords and some single notes, one with the tops' tone.
const STABS: HitItem[] = [
  hit({ key_label: 'Am', tone: tone(900), voices: 4 }), hit({ key_label: 'Gm', tone: tone(1400), voices: 3 }), hit({ key_label: 'Bm', tone: tone(2200), voices: 3 }),
  hit({ key_label: 'Am', tone: tone(700), voices: 1, duration_s: 0.25 }), hit({ key_label: 'Ebm', tone: tone(1100), voices: 3 }), hit({ key_label: 'Dm', tone: tone(1000), voices: 3, duration_s: 1.6 }),
  hit({ key_label: 'Am', tone: tone(4000), voices: 3 }), hit({ key_label: 'F#m', tone: tone(1300), voices: 3 }),
]
const midi: MidiItem = { id: 1, file_name: 'B.mid', name: 'B', rel_path: 'MIDI/Bass/b.mid', role: 'bass', bars: 2, key_label: 'Am', key_camelot: null,
  notes: [[0, 0.5, 33, 100], [1.5, 0.5, 33, 100], [4, 0.5, 33, 100], [6.5, 0.25, 36, 90]], favorite: 0, source: null, source_code: null }
const preset: SerumPreset = { path: '/presets/Bass/P.SerumPreset', name: 'P', folder: 'Bass', tags: [] }
// (The big build's stabs, announcing over the whole build, are tested with the big build.)
const opts: GenerateOptions = { ...OPTS, stabs: { hits: STABS }, bass: { midis: [midi], presets: [preset], favorites: [], sidechain: 0.6 }, locks: { bigBuild: 'usual' } }
const LIB = library()
const gens = Array.from({ length: 60 }, (_, i) => generate(LIB, opts, 5000 + i))
const stabLanes = (g: Generation) => g.project.lanes.filter((l) => /^Stab/.test(l.name))
const stabClips = (g: Generation) => g.project.clips.filter((c) => stabLanes(g).some((l) => l.id === c.laneId)) as PatternClip[]
const hitOfClip = (c: Clip) => STABS.find((h) => h.rel_path === c.sample.relPath)!
/** One of the kick's hits as the track plays it (its sample's punch at its level). */
const kickHitOf = (g: Generation) => {
  const k = g.project.lanes.find((l) => l.name === 'Kick')!
  return LIB.find((s) => s.rel_path === g.project.clips.find((c) => c.laneId === k.id)!.sample.relPath)!.punch_db! + k.levelDb!
}
const two = (r: Velocity[][]) => [r[0], r[1 % r.length]]
/** The bars a loop announces each drop over: drop start → the bars before it. */
const announced = (g: Generation): Map<number, number> => {
  const out = new Map<number, number>()
  if (!g.rules.stabLoop) return out
  const want = Number(g.rules.stabAnnounce)
  g.sections.forEach((s, i) => {
    if (g.sections[i + 1]?.kind !== 'drop') return
    const n = s.kind === 'build' ? Math.min(want, s.bars) : s.kind === 'break' ? Math.min(want, Math.max(2, Math.floor(s.bars / 2)))
      : s.kind === 'intro' && g.rules.stabsTease && s.bars >= 24 ? Math.min(want, 8) : 0
    if (n) out.set(s.start + s.bars, n)
  })
  return out
}
const inAnnouncement = (g: Generation, c: Clip) => [...announced(g)].some(([z, n]) => c.start >= (z - n) * 4 && c.start < z * 4)

describe('stabs written for the track', () => {
  it('picks stabs near the key: far fewer need a big move than a blind draw would', () => {
    const shifts = gens.flatMap((g) => stabLanes(g).map((l) => Math.abs(stabClips(g).find((c) => c.laneId === l.id)!.pitch ?? 0)))
    const blind = STABS.map((h) => Math.abs(hitPitch(h, 'Am')))
    const far = (xs: number[]) => xs.filter((x) => x >= STAB_SHIFT).length / xs.length
    expect(far(blind)).toBeGreaterThan(0.2)
    expect(far(shifts)).toBeLessThan(far(blind) / 3)
  })

  it('puts them in a room, ducking a little under the kick, each in its place in the loop, with the track\'s feel', () => {
    for (const g of gens) {
      const lanes = stabLanes(g)
      expect(g.rules.stabFit).toBe(true)
      expect(g.rules.stabLoop).toBe(true)
      for (const l of lanes) expect([l.room, l.duck, l.duckBeats]).toEqual([true, 0.1, 0.4])
      // The main sound in the middle, a layer just beside it, the pickups the other side.
      const jobs = loopJobs(two(g.rules.stabRhythm as Velocity[][]), lanes.length, g.rules.stabLayout as StabLayout)
      expect(jobs.length).toBe(lanes.length)
      expect(lanes.map((l) => l.pan)).toEqual(jobs.map((j) => ({ main: 0, layer: 0.15, pickups: -0.25 })[j]))
      // (A loop's announcements open the room up: below.)
      for (const c of stabClips(g).filter((x) => !inAnnouncement(g, x))) {
        expect(c.verb).toEqual({ from: 0.18, to: 0.18 })
        expect(c.groove).toBeDefined()   // the loops swing, and so do the stabs
      }
    }
  })

  it('levels every stab under the kick, the same whatever its rhythm', () => {
    for (const g of gens) {
      for (const l of stabLanes(g)) expect(hitOfClip(stabClips(g).find((c) => c.laneId === l.id)!).punch_db! + l.levelDb!).toBeLessThanOrEqual(kickHitOf(g) - STAB_UNDER_KICK_DB + 0.25)
    }
    // The same stab in two tracks with different rhythms sits at the same level against the clap.
    const by = new Map<string, Set<number>>()
    for (const g of gens) {
      const clap = g.project.lanes.find((l) => l.name === 'Clap')
      const clapSample = clap && LIB.find((s) => s.rel_path === g.project.clips.find((c) => c.laneId === clap.id)!.sample.relPath)
      if (!clap || !clapSample) continue
      for (const l of stabLanes(g)) {
        const h = hitOfClip(stabClips(g).find((c) => c.laneId === l.id)!)
        if (!by.has(h.rel_path)) by.set(h.rel_path, new Set())
        // (Held 3 dB under the kick's hits: under the ceiling, not where the clap puts it. A track led
        // by its stabs has them 1.5 dB over that.)
        if (h.punch_db! + l.levelDb! >= kickHitOf(g) - STAB_UNDER_KICK_DB - 0.25) continue
        const lead = g.rules.lead === 'stab' ? 1.5 : 0
        by.get(h.rel_path)!.add(Math.round(((h.punch_db! + l.levelDb! - lead) - (clapSample.punch_db! + clap.levelDb!)) * 2) / 2)
      }
    }
    // (As hard as the clap's hits: the accents of the track.)
    for (const xs of by.values()) for (const x of xs) expect(Math.abs(x - STAB_VS_CLAP_DB)).toBeLessThanOrEqual(0.5)
  })

  it('leans into the bassline\'s rests: fewer stabs where a bass note starts than the loop alone would', () => {
    let onBass = 0, all = 0, blindOn = 0, blindAll = 0
    for (const g of gens.filter((x) => x.rules.stabBass === 'answer' && x.bass)) {
      // (The track's own bassline: written for it, not the MIDI file's.)
      const bass = bassSteps(g.bass!.notes ?? g.bass!.midi.notes, g.bass!.bars ?? g.bass!.midi.bars)
      const count = (r: number[][], add: (on: boolean) => void) => r.forEach((b, k) => hitsOf(b).forEach((i) => add(bass.onset[(k % 2) * 16 + i])))
      count(g.rules.stabRhythm as number[][], (x) => { all++; if (x) onBass++ })
      // The same loops drawn without the bassline.
      for (let k = 0; k < 4; k++) count(stabRhythm(new Rng(g.seed * 7 + k), [], { loop: true }), (x) => { blindAll++; if (x) blindOn++ })
    }
    expect(all).toBeGreaterThan(40)
    expect(onBass / all).toBeLessThan((blindOn / blindAll) * 0.85)
  })

  it('throws a delay on the last bar of a phrase, by the track\'s rule, and gates a stab that would ring into the next', () => {
    const seen = new Set<string>()
    for (const g of gens) {
      // (A loop's announcements have their own delay: below.)
      const echoes = stabClips(g).filter((c) => c.echo && !inAnnouncement(g, c))
      seen.add(String(g.rules.stabEcho))
      if (g.rules.stabEcho === 'none' && g.rules.lead !== 'stab') expect(echoes).toEqual([])
      for (const c of echoes) {
        expect(c.length).toBe(4)
        const brk = g.sections.find((s) => s.kind === 'break' && c.start >= s.start * 4 && c.start < (s.start + s.bars) * 4)
        if (brk) {
          // A track led by its stabs throws them at the end of each phrase of its breakdowns.
          expect(g.rules.lead).toBe('stab')
          expect((c.start / 4 - brk.start) % 8).toBe(7)
          continue
        }
        const drop = g.sections.find((s) => s.kind === 'drop' && c.start >= s.start * 4 && c.start < (s.start + s.bars) * 4)!
        const bar = c.start / 4 - drop.start
        if (g.rules.stabEcho === '8') expect(bar % 8).toBe(7)
        if (g.rules.stabEcho === '16') expect(bar % 16).toBe(15)
        if (g.rules.stabEcho === 'breaks') expect(bar).toBe(drop.bars - 1)
      }
      for (const c of stabClips(g).filter((x) => !inAnnouncement(g, x))) {
        const rings = (hitOfClip(c).duration_s / 2 ** ((c.pitch ?? 0) / 12)) * (BPM / 60)
        const gap = (closestGap(g.rules.stabRhythm as Velocity[][]) / 4) * 0.92
        expect(c.gate != null).toBe(rings > gap)
      }
    }
    expect(seen.size).toBe(4)
  })

  it('opens the filter over the first bars of a drop, by the track\'s rule', () => {
    for (const g of gens) {
      g.sections.filter((s) => s.kind === 'drop').forEach((d, k) => {
        const first = stabClips(g).filter((c) => c.start >= d.start * 4 && c.start < (d.start + 1) * 4)
        const opens = g.rules.stabsOpen === 'each' || (g.rules.stabsOpen === 'first' && k === 0)
        for (const c of first) {
          if (opens) expect(c.filter).toMatchObject({ type: 'lowpass', from: g.rules.stabsCutoff })
          else expect(c.filter).toBeUndefined()
        }
        // Open again by the drop's last bar.
        for (const c of stabClips(g).filter((x) => x.start === (d.start + d.bars - 1) * 4)) expect(c.filter).toBeUndefined()
      })
    }
  })

  it('can be switched back per track: placed as before, no room, no feel', () => {
    const choice = CHOICES.find((c) => c.rule === 'stabFit')!
    const g = gens.find((x) => stabLanes(x).length)!
    const r = setTrackRule(LIB, opts, g, 'stabFit', false, choice.roles)
    expect(r.rules.stabFit).toBe(false)
    for (const c of stabClips(r)) {
      expect(c.verb).toBeUndefined()
      expect(c.gate).toBeUndefined()
      expect(c.echo).toBeUndefined()
    }
    const rest = (x: Generation) => JSON.stringify(x.project.clips.filter((c) => !stabLanes(x).some((l) => l.id === c.laneId)).map(({ id: _i, laneId: _l, ...c }) => c))
    expect(rest(r)).toBe(rest(g))
  })

  it('is listened back to: a stab moved far into the key is swapped for one that isn\'t', () => {
    // Only far stabs to pick from, then the whole page for the listening back.
    const far = STABS.filter((h) => Math.abs(hitPitch(h, 'Am')) >= STAB_SHIFT)
    const made = Array.from({ length: 12 }, (_, i) => generate(LIB, { ...opts, stabs: { hits: far } }, 5200 + i)).filter((g) => g.key === 'Am' && stabLanes(g).length)
    expect(made.length).toBeGreaterThan(3)
    for (const g of made) {
      const r = refine(LIB, opts, g)
      for (const c of stabClips(r)) expect(Math.abs(c.pitch ?? 0)).toBeLessThan(STAB_SHIFT)
      expect(r.choices.some((c) => c.includes('another stab on'))).toBe(true)
      // Where it plays stays.
      expect(stabClips(r).map((c) => [c.start, c.length, c.steps.join('')])).toEqual(stabClips(g).map((c) => [c.start, c.length, c.steps.join('')]))
      // A kept stab stays.
      expect(refine(LIB, opts, g, { locked: ['stab'] })).toBe(g)
    }
  })
})

// ---------------------------------------------------------------------------
// One stab loop
// ---------------------------------------------------------------------------

describe('one stab loop: its parts', () => {
  const r = [on(2, 7, 10), on(2, 10, 13)]
  it('gives a second stab a layer on the main one or the pickups, a third the pickups under a pair', () => {
    expect(loopJobs(r, 1, 'stack')).toEqual(['main'])
    expect(loopJobs(r, 2, 'stack')).toEqual(['main', 'layer'])
    expect(loopJobs(r, 2, 'split')).toEqual(['main', 'pickups'])
    expect(loopJobs(r, 3, 'split')).toEqual(['main', 'layer', 'pickups'])
    // Without pickups a second stab stacks, and there is no third.
    const plain = [on(2, 10), on(2, 10)]
    expect(loopJobs(plain, 2, 'split')).toEqual(['main', 'layer'])
    expect(loopJobs(plain, 3, 'split')).toEqual(['main', 'layer'])
    // A bar of 16ths alone (no 8th to be the pickups of) is the main stab's.
    expect(loopJobs([on(3, 11)], 2, 'split')).toEqual(['main', 'layer'])
  })

  it('stacks the main sound and its layer on the same hits; the pickups on their own; together the whole loop', () => {
    const [main, layer, pickups] = loopParts(r, ['main', 'layer', 'pickups'])
    expect(main.map(hitsOf)).toEqual([[2, 10], [2, 10]])
    expect(layer).toEqual(main)
    expect(pickups.map(hitsOf)).toEqual([[7], [13]])
    const [a, b] = loopParts(r, ['main', 'layer'])
    expect(a).toEqual(r)
    expect(b).toEqual(r)
  })

  it('keeps the anchor in its lean version, and rolls into a drop in 8ths or 8ths then 16ths, the last beat dry', () => {
    expect(sparse([on(3, 6, 14)], true).map(hitsOf)).toEqual([[6]])
    expect(sparse([on(3, 11)], true).map(hitsOf)).toEqual([[3]])
    expect(rollBar('none')).toBeNull()
    expect(hitsOf(rollBar('eighths')!)).toEqual([0, 2, 4, 6, 8, 10])
    expect(hitsOf(rollBar('sixteenths')!)).toEqual([0, 2, 4, 6, 8, 9, 10, 11])
    expect(rollBar('sixteenths')!.slice(0, 2)).toEqual([2, 0])   // building up
  })

  it('draws a loop with a hit in every bar, more of the classics, and the saved rhythms as they are more often', () => {
    for (let i = 0; i < 40; i++) {
      const loop = stabRhythm(new Rng(i), [], { loop: true })
      expect(loop.length).toBe(2)
      for (const b of loop) expect(b.some(Boolean)).toBe(true)
    }
    const saved = [{ name: 'A', steps: [[0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0]] }]
    const exact = (loop: boolean) => Array.from({ length: 200 }, (_, i) => stabRhythm(new Rng(i), saved, loop ? { loop } : undefined))
      .filter((x) => x.length === 1 && hitsOf(x[0]).join() === '2,7,10').length
    expect(exact(true)).toBeGreaterThan(exact(false))
  })

  it('prefers tight hits: a stab whose energy is in its first 200 ms over a sustained one', () => {
    const tight = hit({ duration_s: 0.3, energy_db: -21, punch_db: -14 })     // all of it in its loudest 200 ms
    const pad = hit({ duration_s: 1.6, energy_db: -12, punch_db: -14 })       // spread over 1.6 s
    expect(hitFocus(tight)).toBeCloseTo(1, 1)
    expect(hitFocus(pad)!).toBeLessThan(0.2)
    expect(focusWeight(tight)).toBe(1)
    expect(focusWeight(pad)).toBeLessThan(0.4)
    expect(focusWeight(hit({ energy_db: null, punch_db: null }))).toBe(1)
  })
})

describe('pattern clips moving a hit', () => {
  it('plays a step\'s bend on top of the clip\'s pitch, like a sampler', () => {
    const c: PatternClip = {
      id: 'c', laneId: 'Stab', type: 'pattern', start: 0, length: 4, gainDb: 0, patternBars: 1, steps: on(2, 10), pitch: -1,
      bend: Array.from({ length: 16 }, (_, i) => (i === 10 ? 2 : 0)),
      sample: { id: 1, relPath: 'stab.wav', name: 'stab', kind: 'oneshot', category: 'chord_stab' } as PatternClip['sample'],
    }
    const [a, b] = eventsInRange({ bpm: 120, clips: [c] } as unknown as Project, 0, 2)
    expect(a.rate).toBeCloseTo(2 ** (-1 / 12), 6)
    expect(b.rate).toBeCloseTo(2 ** (1 / 12), 6)
  })
})

describe('one stab loop in a generated track', () => {
  const bar = (g: Generation, l: Lane, b: number): PatternClip | undefined =>
    stabClips(g).find((c) => c.laneId === l.id && c.start <= b * 4 && c.start + c.length > b * 4)
  const stepsAt = (c: PatternClip | undefined, b: number) => {
    if (!c) return new Array(16).fill(0)
    const from = ((b * 4 - c.start) * 4) % c.steps.length
    return c.steps.slice(from, from + 16)
  }

  it('never rests inside a drop: some stab plays in every bar of every drop', () => {
    let long = 0
    for (const g of gens.filter((x) => x.rules.stabs && stabLanes(x).length)) {
      for (const d of g.sections.filter((s) => s.kind === 'drop')) {
        if (d.bars >= 32) long++
        for (let b = d.start; b < d.start + d.bars; b++) {
          const any = stabLanes(g).some((l) => stepsAt(bar(g, l, b), b).some(Boolean))
          expect(any, `seed ${g.seed}: no stab in bar ${b} (drop ${d.start}–${d.start + d.bars})`).toBe(true)
        }
      }
    }
    expect(long).toBeGreaterThan(10)
  })

  it('plays the whole loop in the drops, every hit full: a layer with the main sound, a little under it; the pickups on their own', () => {
    const seen = new Set<string>()
    for (const g of gens) {
      const lanes = stabLanes(g)
      const jobs = loopJobs(two(g.rules.stabRhythm as Velocity[][]), lanes.length, g.rules.stabLayout as StabLayout)
      jobs.forEach((j) => seen.add(j))
      const drops = g.sections.filter((s) => s.kind === 'drop')
      const d = drops[drops.length - 1]
      for (let b = d.start; b < d.start + 4; b++) {
        const parts = lanes.map((l) => stepsAt(bar(g, l, b), b))
        const want = (g.rules.stabRhythm as number[][])[(b - d.start) % (g.rules.stabRhythm as number[][]).length]
        expect(parts.reduce((n, p) => n.map((v, i) => Math.max(v, p[i])), new Array(16).fill(0)).map(Boolean)).toEqual(want.map(Boolean))
        for (const p of parts) for (const v of p) if (v) expect(v).toBe(3)   // the accents: no softer answers
        const li = jobs.indexOf('layer')
        if (li > 0) {
          expect(parts[li].map(Boolean)).toEqual(parts[0].map(Boolean))
          expect(bar(g, lanes[li], b)!.gainDb - (bar(g, lanes[0], b)!.gainDb)).toBe(-4)
        }
        const pi = jobs.indexOf('pickups')
        if (pi > 0) for (const i of hitsOf(parts[pi])) expect(i % 2).toBe(1)
      }
    }
    expect(seen).toEqual(new Set(['main', 'layer', 'pickups']))
  })

  it('hits the drops open and whole: no filter opening over them, nor a lean first drop', () => {
    for (const g of gens) {
      expect(g.rules.stabsOpen).toBe('none')
      if (g.rules.character !== 'drums') expect(g.rules.stabsGrow).toBe(false)
      for (const d of g.sections.filter((s) => s.kind === 'drop')) {
        for (const c of stabClips(g).filter((x) => x.start === d.start * 4)) {
          expect(c.filter).toBeUndefined()
          expect(c.echo).toBeUndefined()
        }
      }
    }
  })

  it('announces every drop: low-passed and opening, the resonance, room and delay rising, its last beat dry and thrown into the drop', () => {
    let builds = 0, breaks = 0, rolls = 0
    for (const g of gens) {
      const main = stabLanes(g)[0]
      for (const [z, n] of announced(g)) {
        const sec = g.sections.find((s) => s.start + s.bars === z)!
        if (sec.kind === 'build') builds++
        if (sec.kind === 'break') breaks++
        expect([4, 8]).toContain(Number(g.rules.stabAnnounce))
        const clips = Array.from({ length: n }, (_, j) => bar(g, main, z - n + j))
        // The silence before the drop may take the whole last bar, its hits being in its last beat only.
        const playing = clips.filter((c): c is PatternClip => !!c)
        expect(playing.length).toBeGreaterThanOrEqual(n - 1)
        for (const c of playing) {
          expect(c.length).toBe(4)
          expect(c.filter).toMatchObject({ type: 'lowpass' })
          expect(c.echo).toBeGreaterThan(0)
        }
        for (let j = 1; j < playing.length; j++) {
          expect(playing[j].filter!.from).toBeGreaterThan(playing[j - 1].filter!.from)
          expect(playing[j].filter!.q).toBeGreaterThanOrEqual(playing[j - 1].filter!.q)
          expect(playing[j].verb!.to).toBeGreaterThanOrEqual(playing[j - 1].verb!.to)
          expect(playing[j].echo!).toBeGreaterThanOrEqual(playing[j - 1].echo!)
        }
        const last = bar(g, main, z - 1)
        if (last) {
          expect(last.echo).toBe(0.9)
          expect(last.steps.slice(12).some(Boolean)).toBe(false)
          // (The silence before the drop takes at most its last two beats: the roll's first two stay.)
          if (g.rules.stabRoll !== 'none') {
            rolls++
            expect(hitsOf(last.steps.slice(0, 8))).toEqual([0, 2, 4, 6])
          }
        }
      }
    }
    expect(builds).toBeGreaterThan(10)
    expect(breaks).toBeGreaterThan(20)
    expect(rolls).toBeGreaterThan(5)
  })

  it('sometimes moves the loop\'s last hit: a tone up most often, on all the stabs playing it', () => {
    const moved = gens.filter((g) => g.rules.stabMove)
    expect(moved.length).toBeGreaterThan(10)
    expect(moved.length).toBeLessThan(gens.length * 0.7)
    let any = 0
    for (const g of moved) {
      const bent = stabClips(g).filter((c) => c.bend)
      // (A loop of one hit has nothing to answer: it doesn't move, and the choices don't say it does.)
      expect(bent.length > 0).toBe(g.choices.some((c) => / st, announcing|last hit [+-]\d+ st/.test(c)))
      if (bent.length) any++
      for (const c of bent) {
        expect(c.bend!.length).toBe(c.steps.length)
        const at = c.bend!.flatMap((v, i) => (v ? [i] : []))
        for (const i of at) {
          expect(c.bend![i]).toBe(g.rules.stabMove)
          expect(c.steps[i]).toBeGreaterThan(0)
          // The last hit of its bar.
          expect(c.steps.slice(i + 1, (Math.floor(i / 16) + 1) * 16).some(Boolean)).toBe(false)
        }
        if (g.rules.stabMoveAt === 'loop' && c.patternBars === 2) expect(at.every((i) => i >= 16)).toBe(true)
      }
    }
    expect(any).toBeGreaterThan(moved.length * 0.6)
    for (const g of gens.filter((x) => !x.rules.stabMove)) expect(stabClips(g).some((c) => c.bend)).toBe(false)
    expect(gens.some((g) => g.choices.some((c) => /loop's last hit \+2 st|last hit of every bar \+2 st/.test(c)))).toBe(true)
  })

  it('keeps the stabs\' own tone: a low cut, no bands moving it to the references\' pads', () => {
    for (const g of gens) for (const l of stabLanes(g)) for (const b of l.eq?.bands ?? []) expect(b.type).toBe('highpass')
  })

  it('leaves a track made before the loop as it was: its stabs taking turns, no announcement', () => {
    const g = generate(LIB, { ...opts, locks: { stabLoop: false } }, 5003)
    expect(g.rules.stabLoop).toBe(false)
    const before = { ...g, rules: Object.fromEntries(Object.entries(g.rules).filter(([k]) => !['stabLoop', 'stabLayout', 'stabAnnounce', 'stabRoll', 'stabMove', 'stabMoveAt'].includes(k))) }
    const r = setTrackRule(LIB, opts, before as Generation, 'stabEcho', '16', CHOICES.find((c) => c.rule === 'stabEcho')!.roles)
    expect(r.rules.stabLoop).toBeFalsy()
    for (const l of stabLanes(r)) expect(l.duck).toBe(0.25)
    expect(stabClips(r).some((c) => c.bend || c.echo === 0.9)).toBe(false)
  })
})
