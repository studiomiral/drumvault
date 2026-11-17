// Vocals (SCOPE.md §6.11): what a vocal take asks ElevenLabs for. One short hook, sung over and
// over by one voice, nearly a cappella, at the library tempo and in a key, long enough for an
// 8-bar phrase and many chops; its vocal is split from it afterwards.

export type VocalVoice = 'female' | 'male'
export const VOCAL_MOODS = ['soulful', 'airy', 'deep', 'uplifting', 'dark', 'gospel'] as const
export type VocalMood = (typeof VOCAL_MOODS)[number]

export interface VocalRequest {
  /** The lines it sings (1–3, from the lyric bank or edited), repeated through the take. */
  lines: string[]
  voice: VocalVoice
  mood: VocalMood
  bpm: number
  /** The key it's sung in ("Am", "F#"); null: any. */
  key: string | null
  /** Length of the take (s). */
  seconds: number
}

/** Where a Splice vocal loop or phrase came from (SCOPE.md §6.11a): what the export's info.txt credits. */
export interface SpliceVocal {
  /** Its file name, and where it is in the Splice folder. */
  file: string
  original: string
  sha1: string
  /** The pack and its label (Splice's own record), and the pack's page on splice.com when found. */
  pack: string | null
  label: string | null
  url: string | null
  /** Its tempo (null: a phrase without one) and whether it is a loop. */
  bpm: number | null
  loop: boolean
  key_source: 'name' | 'splice' | 'sung' | 'none'
  tags: string[]
}

/** A vocal, as its folder's meta.json keeps it (<Library>/Vocals/<id>/): made with ElevenLabs, or a Splice loop. */
export interface VocalMeta extends Omit<VocalRequest, 'voice' | 'mood'> {
  id: string
  createdAt: string
  /** House of Tracks wants it said: AI-generated (lyrics written for this app), or a Splice sample. */
  source: 'elevenlabs' | 'splice'
  /** An ElevenLabs take's voice and mood (a Splice loop has none). */
  voice?: VocalVoice
  mood?: VocalMood
  /** A Splice loop's origin. */
  splice?: SpliceVocal
  model: string
  format: string
  /** ElevenLabs' response headers for the take (its song id among them). */
  headers: Record<string, string>
  /** Credits the take and its split used (from the account before and after), when known. */
  credits: number | null
  /** Library-relative: the full take, and its vocal as the engine wrote it (24-bit WAV at the library rate). */
  take: string
  vocal: string | null
  stems: string[]
  durationS: number | null
  /** The key the engine hears in the vocal (to check against `key`). */
  keyHeard: string | null
  /** The tracks it was exported in: House of Tracks takes each vocal only once. */
  usedIn: string[]
  /** What the engine found in it (vocal.py): the key sung, its phrase loops and chops (library-relative). */
  analysis?: VocalAnalysis
}

export interface VocalAnalysis {
  key: string | null
  /** One loop per repetition length (a line, both lines), cut to whole bars at the library tempo. */
  phrases: { path: string; bars: number; period_s: number; stretch: number }[]
  /** Syllables with the note they're sung on (MIDI) and how loud they play. */
  chops: { path: string; note: number; seconds: number; energy_db: number | null }[]
  bpm: number
}

/** A take's name as the app shows it: the lines an ElevenLabs take sings, a Splice loop's file. */
export function takeName(t: Pick<VocalMeta, 'source' | 'lines' | 'splice'>): string {
  return t.source === 'splice' ? (t.splice?.file ?? 'Splice vocal').replace(/\.(wav|aiff?|flac)$/i, '') : `“${t.lines.join(' / ')}”`
}

/** What a take is, in a few words: its voice and mood, or its Splice pack. */
export function takeAbout(t: Pick<VocalMeta, 'source' | 'voice' | 'mood' | 'splice'>): string {
  return t.source === 'splice' ? `Splice: ${t.splice?.pack ?? 'unknown pack'}` : `${t.voice}, ${t.mood}`
}

/** Seconds a take of `bars` lasts at `bpm`, with a second to start in (an 8-bar phrase needs at least 8 bars). */
export const takeSeconds = (bars: number, bpm: number) => Math.ceil((bars * 4 * 60) / bpm) + 1

/** What a vocal sings: a chant (one short line), a pair of short lines, a longer phrase, or two phrases. */
export type VocalShape = 'chant' | 'pair' | 'phrase' | 'phrases'

/** A line long enough to be a sung phrase rather than a chant. */
export const isPhrase = (line: string) => line.trim().split(/\s+/).length >= 7

/**
 * A vocal drawn at random (the Vocals page's Random vocal): a chant, a pair of short lines, a
 * longer phrase or two phrases (from the chants and phrases of the bank, `lines(n, phrases)`),
 * mostly a female voice and gospel or soulful (the rest have a chance), a key (minor twice as
 * often). Chants are mostly short takes (8 or 12 bars, sometimes 16: credits go by the second);
 * phrases get 12 or 16 bars to breathe.
 */
export function randomVocal(bpm: number, keys: string[], lines: (n: number, phrases: boolean) => string[],
                            random: () => number = Math.random): VocalRequest {
  const pick = <T>(items: [T, number][]): T => {
    let r = random() * items.reduce((n, [, w]) => n + w, 0)
    for (const [v, w] of items) if ((r -= w) < 0) return v
    return items[items.length - 1][0]
  }
  const voice = pick<VocalVoice>([['female', 3], ['male', 1]])
  const mood = pick<VocalMood>([['gospel', 35], ['soulful', 35], ['airy', 8], ['deep', 8], ['uplifting', 8], ['dark', 6]])
  const key = pick(keys.map((k): [string, number] => [k, k.endsWith('m') ? 2 : 1]))
  const shape = pick<VocalShape>([['chant', 3], ['pair', 2], ['phrase', 3], ['phrases', 2]])
  const sung = shape === 'chant' ? lines(1, false) : shape === 'pair' ? lines(2, false) : shape === 'phrase' ? lines(1, true)
    : random() < 0.5 ? [...lines(1, true), ...lines(1, false)] : lines(2, true)
  const bars = shape === 'chant' || shape === 'pair' ? pick([[8, 2], [12, 2], [16, 1]]) : pick([[12, 1], [16, 2]])
  return { lines: sung, voice, mood, bpm, key, seconds: takeSeconds(bars, bpm) }
}

/** Credits a take of `seconds` costs, its 2-stem split included (≈ 900 a minute, the split half again). */
export const vocalCredits = (seconds: number) => Math.round((seconds / 60) * 900 * 1.5)

function keyName(key: string | null): string | null {
  if (!key) return null
  return key.endsWith('m') ? `${key.slice(0, -1)} minor` : `${key} major`
}

/** The composition plan (music_v1) for a take: one hook section, its lines repeated to fill it. */
export function compositionPlan(r: VocalRequest) {
  const key = keyName(r.key)
  // A sung phrase takes a bar or two: fewer of them fill the take than of chants.
  const phrased = r.lines.some(isPhrase)
  const repeats = Math.max(phrased ? 2 : 4, Math.min(30, Math.round(r.seconds / (phrased ? 5 : 3))))
  const lines = Array.from({ length: repeats }, (_, i) => r.lines[i % r.lines.length])
  return {
    positive_global_styles: [
      'house music vocal', `${r.bpm} bpm`, ...(key ? [`key of ${key}`] : []), `solo ${r.voice} vocalist`, `${r.mood} voice`,
      'a cappella', 'dry vocal, close mic',
      ...(phrased ? ['melodic sung phrases', 'soulful phrasing', 'repeating vocal hook'] : ['sustained sung notes', 'repetitive hook', 'club chant']),
    ],
    negative_global_styles: ['drums', 'percussion', 'bass', 'verse', 'chorus', 'bridge', 'rap', 'spoken word', 'choir', 'pop song structure'],
    sections: [{
      section_name: 'Hook',
      positive_local_styles: phrased ? ['the same phrases again and again', 'sparse', 'clear words', 'room to breathe between phrases']
        : ['the same short line over and over', 'sparse', 'clear words', 'long notes'],
      negative_local_styles: ['new lyrics', 'build-up', 'drum fill'],
      duration_ms: Math.round(r.seconds * 1000),
      lines,
    }],
  }
}
