// Drones (SCOPE.md §6.10): an ambience in the track key under the track, from a Drones page
// sample: moved into the key like a sampler would (sometimes an octave down or up), warped its own
// way per track (slowed down or reversed, from another part of the sound) and washed in reverb by
// the engine into a loop, sometimes with a rhythm.

import { bassPath } from '../audio/schedule'
import { BEATS_PER_BAR } from '../lib/project'
import type { HitItem, SampleListItem } from '../types/api'
import type { BassRender, DroneRhythm, DroneWarp } from '../types/project'
import { parseKey, type BassNote } from './bassline'
import { hitPitch, hitSample } from './disco'

/** Share of tracks with a drone, when the module is on and the Drones page has samples. */
export const DRONE_CHANCE = 0.65
/** A drone loop's length: its rhythm repeats every bar, its wash moves slower. */
export const DRONE_BARS = 4
/** Where an older track's held Serum pad had its root: C3 (MIDI 48) up to B3. */
const ROOT_FROM = 48

/** A drone sample as the generator's pick (kept by Keep, avoided by a re-roll). */
export function droneItem(h: HitItem): SampleListItem {
  return { ...hitSample(h), category: 'melodic', source_code: 'Drones' }
}

/** How a track plays its drone sample: the rhythm, the warp, an octave on the move into the key, and where in it the loop starts (0…1). */
export interface DroneLook {
  rhythm: DroneRhythm
  warp: DroneWarp
  octave: number
  start: number
}

/** What a drone's clips render: the sample in the key, warped, with the track's rhythm. */
export function droneRender(h: HitItem, key: string | null, look: DroneLook): BassRender {
  return {
    role: 'drone', keyLabel: key, midiId: 0, midiName: 'Drone', bars: DRONE_BARS, preset: h.rel_path, presetName: h.name,
    transpose: Math.max(-24, Math.min(24, hitPitch(h, key) + look.octave)),
    drone: { rhythm: look.rhythm, warp: look.warp, start: look.start },
  }
}

/** A drone's render in another key: a sample moves into it (its octave stays); an older track's held pad moves its notes. */
export function droneInKey(render: BassRender, key: string | null, hits: HitItem[]): BassRender {
  if (render.preset.startsWith('/')) {
    const root = ROOT_FROM + (parseKey(key)?.root ?? 9)
    const from = Math.min(...(render.notes ?? [[0, 0, ROOT_FROM, 0]]).map(([, , p]) => p))
    const notes = (render.notes ?? []).map(([s, l, p, v]): BassNote => [s, l, p - from + root, v])
    return { ...render, keyLabel: key, notes }
  }
  const hit = hits.find((h) => h.rel_path === render.preset)
  if (!hit) return { ...render, keyLabel: key }
  const octave = render.transpose - hitPitch(hit, render.keyLabel ?? null)
  return { ...render, keyLabel: key, transpose: Math.max(-24, Math.min(24, hitPitch(hit, key) + octave)) }
}

/** A drone's render as the loop "sample" its clips play at `bpm`. */
export function droneSample(item: SampleListItem, render: BassRender, bpm: number): SampleListItem {
  return {
    ...item, rel_path: bassPath(render, bpm), kind: 'loop', bpm, bars: DRONE_BARS,
    duration_s: (DRONE_BARS * BEATS_PER_BAR * 60) / bpm, key_label: render.keyLabel ?? null,
  }
}
