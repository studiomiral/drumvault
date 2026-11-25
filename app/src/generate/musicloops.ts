// Music loops in a generated track (SCOPE.md §6.11b): a loop from the Music Loops page played by
// some house tracks in place of the chord stabs, as the track's lead (placed like the piano). It is
// never heard as recorded: always moved 1 to 3 semitones into the track key (so a track in its
// own key, or the relative one, doesn't get it) and coloured by an EQ and a soft saturation drawn
// for the track, both baked into its render (the engine's musicloop.render).

import { bassPath } from '../audio/schedule'
import { BEATS_PER_BAR } from '../lib/project'
import type { MusicLoopMeta, SampleListItem } from '../types/api'
import type { BassRender } from '../types/project'
import { hitTranspose } from './disco'
import type { Rng } from './rng'

/** Share of house tracks that play a music loop when one fits and the track plays no piano. */
export const MUSIC_CHANCE = 1 / 3
/** A loop moves at most this far into the track key (semitones, the nearest way)… */
export const MUSIC_MAX_SHIFT = 3
/** …and is stretched at most this far to the track tempo (BPM). */
export const MUSIC_MAX_BPM = 6

/**
 * Semitones a loop moves in a track in `key`: the nearest way into it (the relative key counts as
 * the key), within MUSIC_MAX_SHIFT. Null when it can't play there: no key (its own or the track's),
 * too far, or 0 (it would be heard at its recorded pitch).
 */
export function musicShift(l: Pick<MusicLoopMeta, 'key'>, key: string | null): number | null {
  if (!l.key || !key) return null
  const s = hitTranspose({ key_label: l.key }, key)
  return s === 0 || Math.abs(s) > MUSIC_MAX_SHIFT ? null : s
}

/** A loop a track in `key` at `bpm` can play: never exported, moved by musicShift, near its tempo. */
export function musicFits(l: MusicLoopMeta, key: string | null, bpm: number): boolean {
  return !l.usedIn.length && Math.abs(l.bpm - bpm) <= MUSIC_MAX_BPM && musicShift(l, key) != null
}

/**
 * The loop's colour in a track, so it never sounds as the sample does: a low cut (120–250 Hz), a
 * broad bell of 2–4 dB up or down somewhere between 300 Hz and 3 kHz, a high shelf of 2–3 dB up
 * or down, and a light saturation (2–6 dB of drive into a soft clip, gain matched). As BassRender.color.
 */
export function drawColor(rng: Rng): number[] {
  const sign = () => (rng.chance(0.5) ? 1 : -1)
  const lowCut = rng.int(120, 250)
  const bellHz = Math.round(300 * 10 ** (rng.next() * Math.log10(3000 / 300)))
  const bellDb = sign() * (2 + Math.round(rng.next() * 20) / 10)
  const q = 0.7 + Math.round(rng.next() * 5) / 10
  const shelfDb = sign() * (2 + Math.round(rng.next() * 10) / 10)
  const drive = 2 + Math.round(rng.next() * 40) / 10
  return [lowCut, bellHz, bellDb, q, shelfDb, drive]
}

/** The colour in words, for the track's choices and the module. */
export function colorAbout(c: number[]): string {
  const [lo, hz, bell, , shelf, drive] = c
  const f = (x: number) => (x >= 1000 ? `${Math.round(x / 100) / 10} kHz` : `${Math.round(x)} Hz`)
  const db = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(1)} dB`
  return `low cut ${f(lo)}, ${db(bell)} at ${f(hz)}, highs ${db(shelf)}, ${drive.toFixed(1)} dB of drive`
}

/** Ids for loops as generator picks (apart from samples, hits, patches and vocal takes). */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h % 100_000_000
}

/** A loop's name on screen: its file without the extension. */
export const loopName = (l: Pick<MusicLoopMeta, 'file'>) => l.file.replace(/\.[^.]+$/, '')

/** A loop as the generator's pick (kept by Keep, avoided by a remake). */
export function musicItem(l: MusicLoopMeta): SampleListItem {
  return {
    id: -1_600_000_000 - hash(l.id), rel_path: l.loop, name: loopName(l), kind: 'loop', category: 'melodic', bpm: l.bpm, bars: l.bars,
    body_bars: null, key_label: l.key, key_camelot: null, duration_s: (l.bars * BEATS_PER_BAR * 60) / l.bpm, channels: 2,
    favorite: 0, rating: null, tags: null, zip_id: -1, source_code: 'Music Loops',
  }
}

/** What a music loop's clips render: the loop moved `shift` into `key`, coloured, its own bars. */
export function musicRender(l: MusicLoopMeta, key: string | null, shift: number, color: number[]): BassRender {
  return {
    role: 'music', keyLabel: key, preset: l.loop, presetName: loopName(l), midiId: 0, midiName: 'Music Loop',
    transpose: shift, bars: l.bars, color, music: { key: l.key, loop: l.id },
  }
}

/** The render as the loop "sample" its clips play at `bpm`. */
export function musicSample(l: MusicLoopMeta, render: BassRender, bpm: number): SampleListItem {
  const bars = render.bars ?? l.bars
  return { ...musicItem(l), rel_path: bassPath(render, bpm), bpm, bars, duration_s: (bars * BEATS_PER_BAR * 60) / bpm, key_label: render.keyLabel ?? null }
}
