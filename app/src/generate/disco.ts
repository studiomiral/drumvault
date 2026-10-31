// Disco hits in a track (SCOPE.md §6.8): a hit as a one-shot the generator can place, and the
// semitones it plays at: moved into the track key (to the relative key across major and minor,
// the nearest way) plus the hit's own correction, within an octave either way.

import type { HitItem, SampleListItem } from '../types/api'
import { transposeTo } from './generator'

/** Disco hits are never further than this from where they were recorded. */
export const HIT_PITCH_RANGE = 12

/** Sample ids of disco hits: negative, apart from the library's and the rendered parts'. */
const HIT_ID_BASE = -3_000_000_000

export function hitSampleId(hitId: number): number {
  return HIT_ID_BASE - hitId
}

/** The hit id of a disco hit's sample id (null: not a disco hit). */
export function hitIdOf(sampleId: number | null | undefined): number | null {
  return sampleId != null && sampleId <= HIT_ID_BASE ? HIT_ID_BASE - sampleId : null
}

/** The move into the track key alone (0 when either key is unknown). */
export function hitTranspose(h: Pick<HitItem, 'key_label'>, key: string | null): number {
  return transposeTo(h.key_label, key)
}

/** Semitones the hit plays at in a track in `key`. */
export function hitPitch(h: Pick<HitItem, 'key_label' | 'pitch_fix'>, key: string | null): number {
  return Math.max(-HIT_PITCH_RANGE, Math.min(HIT_PITCH_RANGE, hitTranspose(h, key) + (h.pitch_fix ?? 0)))
}

/** A hit (or a chord stab) as a one-shot sample for the generator. */
export function hitSample(h: HitItem): SampleListItem {
  const stab = h.kind === 'stab'
  return {
    id: hitSampleId(h.id), rel_path: h.rel_path, name: h.name, kind: 'oneshot', category: stab ? 'chord_stab' : 'disco_hit',
    bpm: null, bars: null, body_bars: null, key_label: h.key_label, key_camelot: h.key_camelot,
    duration_s: h.duration_s, channels: h.channels, favorite: 0, rating: null, tags: null,
    zip_id: -1, source_code: stab ? 'Chord Stabs' : 'Disco Hits',
  }
}
