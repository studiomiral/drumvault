// The ambience bed (SCOPE.md §6.10a): a long texture from the Ambience page (vinyl crackle, tape
// hiss, room tone, a field recording) under the track from the end of the intro to the start of
// the outro: constant, very quiet, ducking under the kick. The engine makes it a seamless loop.

import { bassPath } from '../audio/schedule'
import { BEATS_PER_BAR } from '../lib/project'
import type { HitItem, SampleListItem } from '../types/api'
import type { BassRender } from '../types/project'
import { hitSample } from './disco'

/** Share of tracks with a bed, when the module is on and the Ambience page has samples. */
export const BED_CHANCE = 0.85
/** How far the bed ducks under each kick (0…1), and its edges' fades (bars). */
export const BED_DUCK = 0.5
export const BED_FADE_BARS = 1

/** A texture as the generator's pick (kept by Keep, avoided by a re-roll). */
export function bedItem(h: HitItem): SampleListItem {
  return { ...hitSample(h), category: 'fx_atmos', source_code: 'Ambience' }
}

/** The bars the bed's loop runs before it repeats: 16, 8 or 4, the most the sample fills (a shorter one is laid end to end). */
export function bedBars(h: Pick<HitItem, 'duration_s'>, bpm: number): number {
  const bars = (h.duration_s * bpm) / 60 / BEATS_PER_BAR
  return bars >= 16 ? 16 : bars >= 8 ? 8 : 4
}

/** What the bed's clips render: the texture as a seamless loop at the track tempo (no key, no pitch). */
export function bedRender(h: HitItem, bpm: number): BassRender {
  return { role: 'ambience', keyLabel: null, preset: h.rel_path, presetName: h.name, midiId: 0, midiName: 'Ambience', transpose: 0, bars: bedBars(h, bpm) }
}

/** The bed's render as the loop "sample" its clips play at `bpm`. */
export function bedSample(item: SampleListItem, render: BassRender, bpm: number): SampleListItem {
  const bars = render.bars ?? 8
  return { ...item, rel_path: bassPath(render, bpm), kind: 'loop', bpm, bars, duration_s: (bars * BEATS_PER_BAR * 60) / bpm, key_label: null }
}
