// The ambience bed (SCOPE.md §6.10a): a long texture from the Ambience page under the track from
// the end of the intro to the start of the outro: constant, very quiet, ducking under the kick. The
// engine makes it a seamless loop. Noise (vinyl crackle, tape hiss, a crowd, a field recording) is
// never pitched. A tonal bed (a drone, a soft pad) is always pitched into the track key and never
// heard as recorded: a track it wouldn't move in (its own key or the relative one) takes another.

import { bassPath } from '../audio/schedule'
import { BEATS_PER_BAR } from '../lib/project'
import type { HitItem, SampleListItem } from '../types/api'
import type { BassRender } from '../types/project'
import { hitSample } from './disco'
import { transposeTo } from './generator'

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

/** A tonal bed (the engine heard a held tone, or a key was set by hand): pitched into the key. Else noise. */
export function bedTonal(h: Pick<HitItem, 'tonal' | 'key_label'>): boolean {
  return h.tonal === 1 || (h.tonal == null && !!h.key_label)
}

/**
 * Semitones a texture moves in a track in `key`, or null when it can't be used there. Noise: 0,
 * in any track. A tonal bed: the nearest way into the key (to the relative key across major and
 * minor), plus its pitch fix, within a tritone; null without a key of its own or the track's, and
 * when that comes to 0 (it would be heard as recorded).
 */
export function bedShift(h: Pick<HitItem, 'tonal' | 'key_label' | 'pitch_fix'>, key: string | null): number | null {
  if (!bedTonal(h)) return 0
  if (!h.key_label || !key) return null
  const s = ((((transposeTo(h.key_label, key) + (h.pitch_fix ?? 0) + 6) % 12) + 12) % 12) - 6
  return s === 0 ? null : s
}

/** What the bed's clips render: the texture as a seamless loop at the track tempo, moved `shift` semitones (bedShift). */
export function bedRender(h: HitItem, bpm: number, key: string | null, shift: number): BassRender {
  return {
    role: 'ambience', keyLabel: shift ? key : null, preset: h.rel_path, presetName: h.name, midiId: 0, midiName: 'Ambience',
    transpose: shift, bars: bedBars(h, bpm),
  }
}

/** The bed's render as the loop "sample" its clips play at `bpm`. */
export function bedSample(item: SampleListItem, render: BassRender, bpm: number): SampleListItem {
  const bars = render.bars ?? 8
  return { ...item, rel_path: bassPath(render, bpm), kind: 'loop', bpm, bars, duration_s: (bars * BEATS_PER_BAR * 60) / bpm, key_label: null }
}
