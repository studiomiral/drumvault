// Vocals in a generated track (SCOPE.md §6.11): one take per track, its phrase loop moved into the
// track key (Rubber Band, formants kept: a render like the bass). (Chops are out: tracks from before
// keep theirs, played like a sampler on the key's chord tones.)

import { bassPath } from '../audio/schedule'
import { BEATS_PER_BAR } from '../lib/project'
import type { SampleListItem } from '../types/api'
import type { BassRender } from '../types/project'
import { takeName, type VocalAnalysis, type VocalMeta } from '../vocals/plan'
import { parseKey } from './bassline'
import { hitTranspose } from './disco'

/** A take Generate can play. */
export type VocalTake = VocalMeta & { analysis: VocalAnalysis }

/** Ids for takes and their chops as generator picks (apart from samples, hits and patches). */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h % 100_000_000
}

const sungKey = (t: VocalTake) => t.analysis.key ?? t.key

/** A Splice loop is sung in a track this close to its key (semitones, the nearest way)… */
export const LOOP_MAX_SHIFT = 2
/** …and this close to its tempo (BPM: a voice stretched further sounds processed). */
export const LOOP_MAX_BPM = 4
/** Share of new tracks that sing a Splice loop, when the Vocal Loops module is on and one fits. */
export const LOOP_CHANCE = 0.6

/** A Splice loop a track in `key` at `bpm` can sing: never exported, in or near the key, near its tempo. */
export function loopFits(t: VocalTake, key: string | null, bpm: number): boolean {
  if (t.source !== 'splice' || t.usedIn.length) return false
  const k = sungKey(t)
  if (!k || !key || Math.abs(hitTranspose({ key_label: k }, key)) > LOOP_MAX_SHIFT) return false
  const tempo = t.splice?.bpm
  return tempo == null || Math.abs(tempo - bpm) <= LOOP_MAX_BPM
}

/** A take as the generator's pick (kept by Keep, avoided by a re-roll). */
export function vocalItem(t: VocalTake): SampleListItem {
  return {
    id: -1_500_000_000 - hash(t.id), rel_path: `Vocals/${t.id}/vocal.wav`, name: takeName(t), kind: 'loop',
    category: 'melodic', bpm: t.bpm, bars: null, body_bars: null, key_label: sungKey(t), key_camelot: null,
    duration_s: t.durationS ?? 0, channels: 2, favorite: 0, rating: null, tags: null, zip_id: -1, source_code: 'Vocals',
  }
}

/** What a phrase clip renders: the loop moved from the key it's sung in into `key`. */
export function phraseRender(t: VocalTake, phrase: VocalAnalysis['phrases'][number], key: string | null): BassRender {
  return {
    role: 'vocal', keyLabel: key, preset: phrase.path, presetName: takeName(t), midiId: 0, midiName: 'Vocal',
    transpose: Math.max(-12, Math.min(12, hitTranspose({ key_label: sungKey(t) }, key))), bars: phrase.bars,
    vocal: { key: sungKey(t), take: t.id },
  }
}

/** A phrase render as the loop "sample" its clips play at `bpm`. */
export function phraseSample(t: VocalTake, render: BassRender, bpm: number): SampleListItem {
  const bars = render.bars ?? 1
  return { ...vocalItem(t), rel_path: bassPath(render, bpm), bpm, bars, duration_s: (bars * BEATS_PER_BAR * 60) / bpm, key_label: render.keyLabel ?? null }
}

/** Semitones that put a chop sung on `note` (MIDI) on the nearest root, third or fifth of `key` (within a tritone). */
export function chopPitch(note: number, key: string | null): number {
  const k = parseKey(key)
  if (!k) return 0
  const tones = [0, k.minor ? 3 : 4, 7].map((iv) => (k.root + iv) % 12)
  const pc = ((Math.round(note) % 12) + 12) % 12
  const moves = tones.map((t) => ((t - pc + 18) % 12) - 6)
  return moves.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a), moves[0])
}
