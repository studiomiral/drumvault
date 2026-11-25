// The "About the track" part of an export's info.txt (SCOPE.md §6.5): a short description in DJ
// terms, read from the project as it is exported (its lanes that play, its sections, its rules):
// what kind of house it is and what drives it, what it's made of, how it's laid out for a DJ, and
// labels whose sound it would sit with. Plain text, nothing measured again.

import { LEAD_LABEL, type Character, type Lead } from '../generate/character'
import type { Project } from '../types/project'
import type { VocalMeta } from '../vocals/plan'

/** Labels whose sound each character sits with (well-known house labels; the first three are named). */
export const LABELS: Record<Character | 'none', string[]> = {
  disco: ['Glitterbox', 'Defected', 'Toolroom'],
  deep: ['Defected', 'Freerange', 'Classic Music Company'],
  dub: ['Hot Creations', 'Moon Harbour', 'Fuse London'],
  drums: ['Toolroom', 'Solid Grooves', 'Repopulate Mars'],
  none: ['Toolroom', 'Defected', 'Hot Creations'],
}

const KIND: Record<Character, string> = {
  dub: 'Dark, dubby house', disco: 'Bright disco house', drums: 'Stripped, percussive tech house', deep: 'Deep, warm house',
}
const WHERE: Record<string, string> = {
  drops: 'in the drops', halves: 'in the second half of each drop', drops_breaks: 'in the drops and breakdowns', breaks: 'in the breakdowns and the last drop',
}
const STRINGS: Record<string, string> = {
  later: 'strings from the second drop on', halves: 'strings in the second half of each drop', breaks: 'strings building tension in the breakdowns',
  drops: 'strings in the drops', all: 'strings all through', inner: 'strings between intro and outro',
}
const COUNT = ['no', 'one', 'two', 'three', 'four', 'five', 'six']
const count = (n: number) => COUNT[n] ?? String(n)
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** The lanes that play: unmuted, with clips. */
function playing(project: Project): Set<string> {
  return new Set(project.lanes.filter((l) => !l.mute && project.clips.some((c) => c.laneId === l.id)).map((l) => l.name))
}

/** The short description: a few lines of plain text. */
export function describeTrack(project: Project, sung: VocalMeta[], bars: number): string[] {
  const g = project.generation
  const on = playing(project)
  const has = (name: string) => on.has(name)
  const n = (prefix: string) => [...on].filter((x) => x === prefix || x.startsWith(`${prefix} `)).length
  const character = (g?.rules?.character ?? null) as Character | null
  const lead = (g?.rules?.lead ?? null) as Lead | null
  const key = g?.key ?? null
  const kind = character ? KIND[character] : key?.endsWith('m') ? 'Club house in a minor key' : 'Club house'

  // What drives it, and what it's made of.
  const parts: string[] = []
  if (has('Bass')) {
    const bass = project.clips.find((c) => c.type === 'audio' && c.bass && (c.bass.role ?? 'bass') === 'bass')
    const sampled = bass?.type === 'audio' && bass.bass?.preset.startsWith('Bass Samples/')
    parts.push(sampled ? 'a sampled bassline' : 'a Serum bassline')
  }
  const stabs = n('Stab')
  if (stabs) parts.push(stabs > 1 ? `${count(stabs)} chord stabs taking turns` : 'a chord stab')
  if (has('Music Loop')) parts.push('a music loop carrying the chords')
  const tops = n('Tops') + (has('Groove') ? 1 : 0)
  const perc = n('Perc')
  parts.push(tops + perc >= 4 ? 'layered tops and percussion' : tops + perc ? 'tight, stripped-back drums' : 'just kick, clap and hats')
  if (has('Ride')) parts.push('a ride lifting the drops')
  if (n('Drop Hit')) parts.push('drop hits as accents')
  if (has('Strings')) parts.push(STRINGS[String(g?.rules?.stringsAt)] ?? 'strings underneath')
  if (has('Pad')) {
    const pad = project.clips.find((c) => c.type === 'audio' && c.bass?.role === 'pad')
    parts.push(pad?.type === 'audio' && pad.bass?.midiName === 'Reese' ? 'a reese swelling through the breakdowns' : 'a pad swelling through the breakdowns')
  }
  if (has('Ambience')) {
    const bed = project.clips.find((c) => c.type === 'audio' && c.bass?.role === 'ambience')
    parts.push(bed?.type === 'audio' && bed.bass?.transpose ? 'a quiet tonal bed underneath' : 'a quiet layer of air underneath')
  }
  const vocal = sung[0]
  if (vocal && (has('Vocal') || has('Vocal Chops'))) {
    const what = vocal.source === 'splice' ? 'a vocal hook' : `a ${vocal.mood ?? ''} ${vocal.voice ?? ''} vocal`.replace(/\s+/g, ' ')
    parts.push(`${what}${has('Vocal') ? '' : ' in chops'} ${WHERE[String(g?.rules?.vocalAt)] ?? 'in the drops'}`)
  }
  const first = `${kind} at ${Math.round(project.bpm)} BPM${key ? ` in ${keyWords(key)}` : ''}${lead && LEAD_LABEL[lead] ? `, built around ${LEAD_LABEL[lead]}` : ''}`
  const lines = [`${first}: ${list(parts)}.`]

  // How it's laid out for a DJ.
  const s = g?.sections ?? []
  if (s.length) {
    const intro = s[0].kind === 'intro' ? s[0].bars : 0
    const outro = s[s.length - 1].kind === 'outro' ? s[s.length - 1].bars : 0
    const drops = s.filter((x) => x.kind === 'drop').length
    const breaks = s.filter((x) => x.kind === 'break')
    const longest = Math.max(0, ...breaks.map((x) => x.bars))
    const layout = [
      intro && outro ? `a ${intro}-bar intro and a ${outro}-bar outro to mix in and out of` : intro ? `a ${intro}-bar intro to mix in on` : '',
      `${count(drops)} ${drops === 1 ? 'drop' : 'drops'}`,
      breaks.length === 1 ? `a ${longest}-bar breakdown` : breaks.length ? `${count(breaks.length)} breakdowns (the longest ${longest} bars)` : 'no breakdown',
    ].filter(Boolean)
    lines.push(`Arrangement: ${bars} bars; ${list(layout)}.`)
  }

  // Labels it would sit with: a soulful sung vocal leans to Defected.
  let labels = LABELS[character ?? 'none']
  if (vocal?.source === 'elevenlabs' && (vocal.mood === 'gospel' || vocal.mood === 'soulful') && character !== 'drums') {
    labels = ['Defected', ...labels.filter((l) => l !== 'Defected')]
  }
  lines.push(`Would sit well on labels like ${list(labels.slice(0, 3))}.`)
  return lines
}

/** House of Tracks' tags (its upload form): an export names the three that fit the track best. */
export const HOT_TAGS = [
  'Aggressive', 'Analog', 'Background', 'Calm', 'Cinematic', 'Club', 'Commercial', 'Dark', 'Dub', 'Euphoric', 'Experimental',
  'Festival', 'Funky', 'Gaming', 'Groovy', 'Happy', 'Heavy Bass', 'Industrial', 'Inspirational', 'Lo-Fi', 'Melodic', 'Mid-Tempo',
  'Motivational', 'Old School', 'Powerful', 'Raw', 'Romantic', 'Soulful', 'Summer', 'Uplifting', 'Work out',
] as const
export type HotTag = (typeof HOT_TAGS)[number]

/**
 * The three House of Tracks tags that fit the track best: scored from its character, what leads it,
 * its key, its layers and its vocal (ties: the form's order). Every track is a club track and has a
 * groove; what sets it apart (dub, disco, stripped drums, a soulful vocal, strings) outscores that.
 */
export function houseTags(project: Project, sung: VocalMeta[]): HotTag[] {
  const g = project.generation
  const on = playing(project)
  const n = (prefix: string) => [...on].filter((x) => x === prefix || x.startsWith(`${prefix} `)).length
  const character = (g?.rules?.character ?? null) as Character | null
  const lead = (g?.rules?.lead ?? null) as Lead | null
  const minor = !!g?.key?.endsWith('m')
  const score: Partial<Record<HotTag, number>> = { Club: 3, Groovy: 2.5 }
  const add = (tag: HotTag, v: number) => { score[tag] = (score[tag] ?? 0) + v }
  if (character === 'dub') { add('Dub', 4); add('Dark', 2.5) }
  if (character === 'disco') { add('Funky', 4); add('Happy', 2); add('Summer', 2) }
  if (character === 'drums') { add('Raw', 3); add('Groovy', 1.5) }
  if (character === 'deep') { add('Soulful', 2); add('Melodic', 1.5) }
  if (lead === 'perc' || lead === 'bass') add('Groovy', 0.5)
  if (minor && character !== 'disco') add('Dark', 1)
  if (!minor && g?.key) { add('Happy', 1); add('Uplifting', 1) }
  if (n('Stab') >= 2 || on.has('Music Loop')) add('Melodic', 1)
  if (on.has('Strings')) { add('Melodic', 1.5); add('Euphoric', 1) }
  if (n('Drop Hit')) add('Funky', 1.5)
  const pad = project.clips.find((c) => c.type === 'audio' && c.bass?.role === 'pad')
  if (on.has('Pad') && pad?.type === 'audio' && pad.bass?.midiName === 'Reese') add('Heavy Bass', 1.5)
  const vocal = (on.has('Vocal') || on.has('Vocal Chops')) ? sung[0] : undefined
  if (vocal?.mood === 'gospel' || vocal?.mood === 'soulful') add('Soulful', 3.5)
  if (vocal?.mood === 'uplifting') add('Uplifting', 3)
  if (vocal?.mood === 'dark' || vocal?.mood === 'deep') add('Dark', 1.5)
  if (vocal?.mood === 'airy') add('Euphoric', 1.5)
  if (vocal?.source === 'splice') add('Soulful', 1)
  return HOT_TAGS.filter((t) => score[t]).sort((a, b) => score[b]! - score[a]! || HOT_TAGS.indexOf(a) - HOT_TAGS.indexOf(b)).slice(0, 3)
}

/** "E minor" for "Em", "F# major" for "F#". */
export function keyWords(label: string): string {
  return label.endsWith('m') ? `${label.slice(0, -1)} minor` : `${label} major`
}
