// The Upload page's values (SCOPE.md §6.5b): what goes into House of Tracks' upload form for an
// export, from its info.txt and the choices made on the page, and what keeps it from going.

import { lengthSeconds, trackNameOf, type TrackInfo } from '../arrange/exporter'
import type { HotFields, UploadCheck, UploadRecord } from '../types/api'

/** The prices a track is offered at (euros; House of Tracks' price list goes higher). */
export const PRICES = [299, 349, 399, 449, 499] as const
export const DEFAULT_PRICE: number = PRICES[0]

/** The form's genres (its "Music Genre" list). */
export const GENRES = [
  'Afro House', 'Bass House', 'Deep House', 'Downtempo', 'Drum and Bass', 'Dubstep', 'Electro House', 'Electronica', 'Future Bass',
  'Future House', 'Hard Dance', 'Hard Techno', 'Hardstyle', 'House', 'Indie Dance', 'Indie Tech', 'Mainstage', 'Melodic House & Techno',
  'Minimal', 'Nu Disco', 'Organic House', 'Pop', 'Progressive House', 'Psy Trance', 'Reggaeton', 'Slap House', 'Synthwave', 'Tech House',
  'Techno', 'Trance', 'Trap', 'UK Garage',
] as const
export const DEFAULT_GENRE = 'House'

/** The form's "Main Instrument" list. */
export const INSTRUMENTS = ['Brass & Woodwinds', 'Guitar', 'Keys', 'Strings', 'World', 'Drums & Percussion', 'Synth', 'Bass'] as const
export const DEFAULT_INSTRUMENT = 'Drums & Percussion'

/** The form's "Vocal Category" for a track that sings (one that doesn't is Instrumental). */
export const VOCAL_CATEGORIES = ['Female', 'Male', 'Other'] as const
export const DEFAULT_VOCAL_CATEGORY = 'Female'

/** House of Tracks takes tracks from 2:30 to 8:00. */
export const MIN_LENGTH_S = 150
export const MAX_LENGTH_S = 480

/** Whether the track sings (info.txt's Vocals block has credits). */
export const sings = (info: TrackInfo) => !!info.vocals.trim()

/** "This Track Contains": a made vocal is AI-generated, a Splice loop royalty free. */
export function vocalKind(info: TrackInfo): HotFields['vocal'] {
  if (!sings(info)) return 'None'
  return /AI-generated with ElevenLabs/i.test(info.vocals) ? 'AI Generated' : 'Royalty Free'
}

/** A made vocal's lines (the credits' “…” lines), one per line; '' for Splice loops. */
export function lyricsOf(info: TrackInfo): string {
  return info.vocals.split('\n').map((l) => /^- “(.*)”$/.exec(l.trim())?.[1]).filter((x): x is string => !!x)
    .flatMap((x) => x.split(' / ')).join('\n')
}

/**
 * The sample packs of the Splice loops it sings (the credits' "Splice pack:" lines and the links
 * under them), each once; unknown ones left out.
 */
export function vocalPacks(info: TrackInfo): { names: string[]; urls: string[] } {
  const names: string[] = []
  const urls: string[] = []
  const lines = info.vocals.split('\n').map((l) => l.trim())
  lines.forEach((l, i) => {
    const name = /^Splice pack: (.+)$/.exec(l)?.[1]
    if (!name) return
    if (name !== 'unknown' && !names.includes(name)) names.push(name)
    const url = lines[i + 1] ?? ''
    if (/^https?:\/\//.test(url) && !urls.includes(url)) urls.push(url)
  })
  return { names, urls }
}

/** The form's values for a track: info.txt, and the page's choices (or their defaults). */
export function hotFields(info: TrackInfo, rec: UploadRecord | undefined): HotFields {
  const vocal = vocalKind(info)
  return {
    trackName: trackNameOf(info.title),
    bpm: info.bpm,
    key: info.key,
    genre: rec?.genre ?? DEFAULT_GENRE,
    description: info.description,
    tags: info.tags,
    price: rec?.price ?? DEFAULT_PRICE,
    instrument: rec?.instrument ?? DEFAULT_INSTRUMENT,
    vocal,
    vocalCategory: vocal === 'None' ? 'Instrumental' : rec?.vocalCategory ?? DEFAULT_VOCAL_CATEGORY,
    lyrics: lyricsOf(info),
    // The form asks a Royalty Free vocal's pack and its link (one of each: the first link).
    vocalPack: vocal === 'Royalty Free' ? vocalPacks(info).names.join(', ') : '',
    vocalPackUrl: vocal === 'Royalty Free' ? vocalPacks(info).urls[0] ?? '' : '',
  }
}

export interface UploadProblems {
  /** What keeps the track from going up: fix it first. */
  blocking: string[]
  /** Those of them that aren't a missing file (its length, its BPM). */
  track: string[]
  /** What the form can't be filled with: set it there by hand. */
  warnings: string[]
}

/** What the export misses for House of Tracks (its upload requirements). */
export function uploadProblems(check: UploadCheck, info: TrackInfo): UploadProblems {
  const blocking: string[] = []
  const warnings: string[] = []
  if (!check.info) blocking.push('info.txt is missing')
  if (!check.master) blocking.push('No master: masters/mastered.wav (or "… mastered.wav")')
  if (!check.mixdown) blocking.push('No mixdown: masters/mixdown.wav')
  if (!check.stems) blocking.push('No stems: stems/ has no WAVs, and there is no stems.zip')
  if (!check.midi) blocking.push('midi/ has no MIDI files')
  if (sings(info)) {
    // A track with a vocal goes with its instrumental masters too.
    if (!check.masterInstrumental) blocking.push('It sings, but there is no instrumental master: masters/"… mastered instrumental.wav"')
    if (!check.mixdownInstrumental) blocking.push('It sings, but there is no instrumental mixdown: masters/mixdown instrumental.wav')
  }
  const track: string[] = []
  const s = lengthSeconds(info.length)
  if (s == null) track.push('info.txt has no length')
  else if (s < MIN_LENGTH_S || s > MAX_LENGTH_S) track.push(`${info.length.split(' ')[0]} long: House of Tracks takes 2:30 to 8:00`)
  if (!info.bpm || !Number.isFinite(Number(info.bpm))) track.push('info.txt has no BPM')
  else if (!Number.isInteger(Number(info.bpm))) warnings.push(`BPM ${info.bpm} goes in as ${Math.round(Number(info.bpm))} (the form takes whole numbers)`)
  if (!/^[A-G][#b]? (major|minor)$/.test(info.key)) warnings.push('No key in info.txt: choose it in the form')
  if (info.tags.length !== 3) warnings.push(`${info.tags.length || 'No'} tags in info.txt: the form gets ${info.tags.length ? 'those' : 'none'}`)
  if (!info.description.trim()) warnings.push('No description in info.txt')
  if (vocalKind(info) === 'Royalty Free') {
    const { names, urls } = vocalPacks(info)
    if (!names.length) warnings.push('The vocal\'s sample pack is unknown: type it in the form')
    if (!urls.length) warnings.push('The vocal\'s sample pack has no link: paste it in the form')
    else if (urls.length > 1) warnings.push(`It sings loops from ${urls.length} packs; the form takes one link: ${urls[0]}`)
  }
  return { blocking: [...blocking, ...track], track, warnings }
}

/** "660 MB". */
export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`
  return `${bytes} B`
}
