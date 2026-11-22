// A track's character and its lead (SCOPE.md §6.6, "Identity"): instead of every choice being
// drawn on its own (tracks that average out to the same middle), a track is one of a few kinds of
// club track, which sets the rules that go together, and has one element that is its signature:
// teased in the intro, exposed in the breakdowns, given room and a little level. Also the layer
// made for breakdowns (§6.7b): a pad's chord or a reese's one note through a Serum patch.

import type { SerumPreset } from '../types/api'
import { parseKey } from './bassline'
import type { Rng } from './rng'

export type Character = 'dub' | 'disco' | 'drums' | 'deep'
export const CHARACTERS: Character[] = ['dub', 'disco', 'drums', 'deep']
export const CHARACTER_LABEL: Record<Character, string> = {
  dub: 'dark and dubby', disco: 'bright and disco', drums: 'stripped and percussive', deep: 'deep and warm',
}

/** The element a track is built around. */
/** The track's lead; a piano track's is the piano (SCOPE.md §6.9a), never drawn by its character. */
export type Lead = 'stab' | 'bass' | 'perc' | 'piano'
export const LEAD_LABEL: Record<Lead, string> = { stab: 'the stabs', bass: 'the bassline', perc: 'the percussion', piano: 'the piano' }
/** The lead sits this much over where the balance puts it (dB); a stab still never over the kick. */
export const LEAD_DB: Record<Lead, number> = { stab: 1.5, bass: 1, perc: 1.5, piano: 1.5 }

/** Which lead each character leans to (weights), of those the track has. */
const LEADS: Record<Character, [Lead, number][]> = {
  dub: [['stab', 3], ['bass', 3], ['perc', 1]],
  disco: [['stab', 4], ['bass', 1], ['perc', 1]],
  drums: [['perc', 4], ['bass', 2], ['stab', 0.5]],
  deep: [['bass', 3], ['stab', 3], ['perc', 0.5]],
}

/** How often a track of each character gets a layer in its breakdowns, when there are patches for it. */
export const PAD_CHANCE: Record<Character, number> = { dub: 0.9, disco: 0.6, drums: 0.5, deep: 0.9 }

/**
 * A track's lead, by its character's leaning: drawn over all three, and none when the track
 * doesn't have the one drawn (so a track is the same with or without a part it isn't led by, and a
 * track of drums alone is only sometimes led by its percussion).
 */
export function pickLead(c: Character, rng: Rng, has: Lead[]): Lead | null {
  const l = rng.weighted(LEADS[c])
  return has.includes(l) ? l : null
}

/**
 * The rules a character sets (the generator's names), over what the track drew on its own: the
 * ones that make it that kind of track. What a real track's structure says, what is kept and what
 * is locked still go over these.
 */
export function characterRules(c: Character, rng: Rng, kickEnds: readonly (readonly [unknown, number])[]): Record<string, unknown> {
  // (Every draw is made for every character, so a track's other streams don't depend on it.)
  const lowCut = rng.int(650, 1000)
  const midCut = rng.int(900, 1500)
  const darkHz = rng.int(450, 800)
  const deepDb = -rng.int(5, 8)
  const softDb = -rng.int(3, 5)
  const stabs = rng.weighted([[2, 4], [3, 1]] as const)
  const rolls = rng.weighted([['8', 1], ['16', 2]] as const)
  const kickEnd = rng.weighted(kickEnds as [unknown, number][])
  const ghost = rng.pick([7, 15, 14])
  if (c === 'dub') {
    return { fx: 'sparse', stabEcho: '8', stabsOpen: 'each', stabsCutoff: lowCut, glueHz: darkHz, glueDb: deepDb, stringsAt: 'breaks', topsBreaks: 'filtered',
      ride: 'second', crash8: false, clapRolls: 'none', stabsIn: 'keys', stabsBreaks: 'filtered', bassBreaks: 'filtered' }
  }
  if (c === 'disco') {
    return { fx: 'busy', discoIn: true, stabCount: stabs, stabTurn: 'double', stringsIn: true, stringsAt: 'halves', crash8: true, ride: 'both',
      clapRolls: rolls, stabsOpen: 'none', phraseFill: true, phraseCrash: true }
  }
  if (c === 'drums') {
    return { stringsIn: false, discoIn: false, fx: 'sparse', stabCount: 1, stabsGrow: true, perc2From: 0, dropTops: 3, kickEnd8: kickEnd,
      clapGhost: ghost, stabEcho: 'breaks', gluePerc: 'through' }
  }
  return { stringsIn: true, stringsAt: 'later', stabsIn: 'keys', stabsBreaks: 'filtered', bassBreaks: 'filtered', fx: 'normal', ride: 'late', stabsCutoff: midCut,
    stabTurn: 'drop', glueDb: softDb, crash8: false }
}

/** The rules that follow from a lead: it is teased in the intro, and can be heard in the breakdowns. */
export function leadRules(lead: Lead | null): Record<string, unknown> {
  if (lead === 'stab') return { stabsTease: true, stabsIn: 'keys' }
  if (lead === 'bass') return { bassIO: 'filtered', bassBreaks: 'filtered' }
  if (lead === 'perc') return { ioPerc: true, perc2From: 0, gluePerc: 'through' }
  return {}
}

// ---------------------------------------------------------------------------
// The breakdown layer: a pad or a reese
// ---------------------------------------------------------------------------

/** The layer's loop: one held chord or note, 4 bars, starting again seamlessly. */
export const PAD_BARS = 4

/** A patch is a reese (one low note) when its name, folder or tags say so; any other is a pad (a chord). */
export function isReese(p: Pick<SerumPreset, 'name' | 'folder' | 'tags'>): boolean {
  return /rees|\bbass\b|\bsub\b/i.test(`${p.name} ${p.folder} ${(p.tags ?? []).join(' ')}`)
}

/**
 * What the layer holds in `key`, as notes [start beats, length beats, pitch, velocity] over its
 * loop: a reese its root, low (E1 to D#2: one note, no harmony); a pad the key's chord around
 * middle C (root, third, fifth and the root again above). Null without a key.
 */
export function padNotes(key: string | null, reese: boolean): [number, number, number, number][] | null {
  const k = parseKey(key)
  if (!k) return null
  const length = PAD_BARS * 4
  if (reese) {
    const p = 36 + k.root
    return [[0, length, p > 39 ? p - 12 : p, 100]]
  }
  const root = 48 + k.root
  return [root, root + (k.minor ? 3 : 4), root + 7, root + 12].map((p) => [0, length, p, 90] as [number, number, number, number])
}

/** How a breakdown is laid out: the bars it strips down over before the layer comes in, and the bar the lead is exposed from. */
export function breakShape(start: number, bars: number): { layer: number; lead: number } {
  const strip = bars >= 32 ? 8 : bars >= 16 ? 4 : 0
  return { layer: start + strip, lead: start + Math.max(strip, Math.floor(bars / 2 / 4) * 4) }
}
