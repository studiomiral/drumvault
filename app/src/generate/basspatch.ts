// What a bass plays through (SCOPE.md §6.7a): a Serum 2 patch, or a Bass Samples page one-shot
// the engine plays the bassline with like a sampler. Pure: the stores hand in their lists.

import type { HitItem, SerumPreset } from '../types/api'

/** What plays the bass: Serum 2 patches, Bass Samples page one-shots, or either. */
export type BassSource = 'serum' | 'samples' | 'both'

/** A Bass (or Piano) tab one-shot as a "patch": its `path` is its library-relative file. */
export function samplePatch(h: HitItem): SerumPreset {
  return { path: h.rel_path, name: h.name, folder: h.kind === 'piano' ? 'Piano Samples' : 'Bass Samples', tags: [], sample: true }
}

/**
 * The patches a bass can play through, by `source`: the Serum patch pool, the Bass Samples page's
 * one-shots (those with a note: one without can't be played in key), or both.
 */
export function patchPool(source: BassSource, presets: SerumPreset[], hits: HitItem[], kind: 'bass' | 'piano' = 'bass'): SerumPreset[] {
  const samples = hits.filter((h) => h.kind === kind && h.key_label).map(samplePatch)
  return source === 'serum' ? presets : source === 'samples' ? samples : [...presets, ...samples]
}
