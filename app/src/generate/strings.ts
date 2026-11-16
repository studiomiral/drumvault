// Strings (SCOPE.md §6.10): a long string sample from the Strings page under the track, heard as
// it was recorded: moved into the track key with its length kept (the engine, Rubber Band), and
// started again on every line of its own length (a 4-bar sample every 4 bars, 8 at most). Only
// samples close to the track key are used. Strings are a supporting layer: in the later drops, the
// second half of drops, or the breakdowns; there at once where the part starts, leaving with a fade.

import { bassPath } from '../audio/schedule'
import { BEATS_PER_BAR } from '../lib/project'
import type { HitItem, SampleListItem } from '../types/api'
import type { BassRender } from '../types/project'
import { hitPitch, hitSample } from './disco'

/** Share of tracks with strings, when the module is on and a Strings page sample fits the key. */
export const STRINGS_CHANCE = 0.65
/** A strings part's longest length: the sample starts again on every 8-bar line, or sooner when it is shorter. */
export const STRINGS_BARS = 8
/** A part is as many bars (8, 4, 2 or 1) as the sample fills by at least this share: no bars of silence after a short sample. */
export const STRINGS_FILL = 0.9
/** The strings leave over `STRINGS_FADE_OUT_BARS`; they come in at once, and swell in over `STRINGS_FADE_IN_BARS` only from the very start of a track; in a breakdown they rise by this much (dB) into the drop. */
export const STRINGS_FADE_IN_BARS = 2
export const STRINGS_FADE_OUT_BARS = 2
export const STRINGS_BREAK_RISE_DB = 6

/** The bars a strings part of sample `h` runs before it starts again, at `bpm`: the most of 8, 4, 2, 1 the sample fills. */
export function stringsBars(h: Pick<HitItem, 'duration_s'>, bpm: number): number {
  const bars = (h.duration_s * bpm) / 60 / BEATS_PER_BAR
  return [8, 4, 2].find((b) => b <= STRINGS_BARS && bars >= b * STRINGS_FILL) ?? 1
}
/** A sample is moved at most this many semitones into the key (else it isn't used in that track). */
export const STRINGS_MAX_SHIFT = 3

/** A string sample as the generator's pick (kept by Keep, avoided by a re-roll). */
export function stringsItem(h: HitItem): SampleListItem {
  return { ...hitSample(h), category: 'melodic', source_code: 'Strings' }
}

/**
 * Semitones a string sample moves to play in `key` (the nearest way, plus its pitch fix), or null
 * when it can't: no key of its own, or further than STRINGS_MAX_SHIFT.
 */
export function stringsShift(h: HitItem, key: string | null): number | null {
  if (!h.key_label || !key) return null
  const shift = hitPitch(h, key)
  return Math.abs(shift) <= STRINGS_MAX_SHIFT ? shift : null
}

/** What a strings part's clips render: the sample moved `shift` semitones, from its start, as many bars as it fills at `bpm`. */
export function stringsRender(h: HitItem, key: string | null, shift: number, bpm: number): BassRender {
  return {
    role: 'strings', keyLabel: key, midiId: 0, midiName: 'Strings', bars: stringsBars(h, bpm), preset: h.rel_path, presetName: h.name,
    transpose: shift,
  }
}

/** A strings part's render as the loop "sample" its clips play at `bpm` (it starts again on every line of its length). */
export function stringsSample(item: SampleListItem, render: BassRender, bpm: number): SampleListItem {
  const bars = render.bars ?? STRINGS_BARS
  return {
    ...item, rel_path: bassPath(render, bpm), kind: 'loop', bpm, bars,
    duration_s: (bars * BEATS_PER_BAR * 60) / bpm, key_label: render.keyLabel ?? null,
  }
}
