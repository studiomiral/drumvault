// Polyphonic Keys learning. Rhythm and harmony are learned separately, then recombined:
// entire voicings stay together, including inversions, extensions and per-voice articulation.
import type { MidiItem } from '../types/api'
import { generatedMidi, keyOfLine, type BassNote, type GeneratedLine } from './bassline'
import type { Rng } from './rng'

interface Event {
  start: number
  voices: { interval: number; length: number; velocity: number }[]
}
interface Phrase { bars: number; events: Event[]; tonic: number }
export interface KeysModel {
  parts: number
  phrases: Phrase[]
  register: number
  polyphony: number
  onsets: number[]
  lengths: (1 | 2 | 4)[]
}
const PITCH: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 }
const pc = (n: number) => ((n % 12) + 12) % 12
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
function parseKey(label: string | null) {
  const m = label && /^([A-G][#b]?)(m?)$/.exec(label)
  return m && PITCH[m[1]] != null ? { root: PITCH[m[1]], minor: m[2] === 'm' } : null
}
// Canonical minor: the diatonic 3rd, 6th and 7th move together on a mode change.
function toMinor(interval: number, minor: boolean): number {
  return !minor && [4, 9, 11].includes(pc(interval)) ? interval - 1 : interval
}
function fromMinor(interval: number, minor: boolean): number {
  return !minor && [3, 8, 10].includes(pc(interval)) ? interval + 1 : interval
}

export function learnKeys(midis: MidiItem[]): KeysModel | null {
  const items = midis.filter((m) => m.role === 'keys' && m.notes.length)
  const phrases: Phrase[] = []
  const roots: number[] = []
  const onsets = new Array<number>(16).fill(0)
  const sizes: number[] = []
  const lengths: (1 | 2 | 4)[] = []
  for (const m of items) {
    const key = parseKey(m.key_label) ?? parseKey(keyOfLine(m.notes))
    if (!key) continue
    const register = median(m.notes.map((n) => n[2]))
    const tonic = key.root + 12 * Math.round((register - key.root) / 12)
    roots.push(tonic)
    const bars = m.bars <= 1 ? 1 : m.bars <= 2 ? 2 : 4
    lengths.push(bars)
    for (let offset = 0; offset < m.bars; offset += bars) {
      const groups = new Map<number, Event>()
      for (const [s, l, p, v] of m.notes) {
        const start = Math.round((s - offset * 4) * 4) / 4
        if (start < 0 || start >= bars * 4 || l <= 0 || v <= 0) continue
        const event = groups.get(start) ?? { start, voices: [] }
        const interval = toMinor(p - tonic, key.minor)
        if (!event.voices.some((n) => n.interval === interval)) {
          event.voices.push({ interval, length: Math.min(l, bars * 4 - start), velocity: v })
        }
        groups.set(start, event)
      }
      const events = [...groups.values()].sort((a, b) => a.start - b.start)
      if (!events.length) continue
      for (const e of events) {
        e.voices.sort((a, b) => a.interval - b.interval)
        onsets[Math.round(e.start * 4) % 16]++
        sizes.push(e.voices.length)
      }
      phrases.push({ bars, events, tonic })
    }
  }
  return phrases.length ? { parts: items.length, phrases, register: median(roots), polyphony: median(sizes), onsets, lengths } : null
}

/** A new loop combining a learned rhythm with a learned harmonic phrase in the track key. */
export function generateKeys(model: KeysModel, rng: Rng, opts: { key: string | null; bars?: 1 | 2 | 4 | null }): GeneratedLine {
  const bars = opts.bars ?? rng.pick(model.lengths)
  const matching = model.phrases.filter((p) => p.bars === bars)
  const pool = matching.length ? matching : model.phrases
  const rhythm = rng.pick(pool)
  const harmony = rng.pick(model.phrases)
  const key = parseKey(opts.key)
  const rootPc = key?.root ?? pc(harmony.tonic)
  const tonic = rootPc + 12 * Math.round((model.register - rootPc) / 12)
  const notes: BassNote[] = []
  for (let offset = 0; offset < bars * 4; offset += rhythm.bars * 4) {
    for (const e of rhythm.events) {
      const start = offset + e.start
      if (start >= bars * 4) continue
      const phase = (start % (harmony.bars * 4))
      // Hold the harmony until its next learned change, including syncopated stabs.
      const chord = harmony.events.findLast((h) => h.start <= phase) ?? harmony.events[0]
      chord.voices.forEach((voice, i) => {
        const articulation = e.voices[i % e.voices.length]
        const pitch = Math.max(0, Math.min(127, tonic + fromMinor(voice.interval, key?.minor ?? true)))
        notes.push([start, Math.max(1 / 16, Math.min(articulation.length, bars * 4 - start)), pitch,
          Math.max(1, Math.min(127, Math.round(articulation.velocity)))])
      })
    }
  }
  return { bars, notes: notes.sort((a, b) => a[0] - b[0] || a[2] - b[2]) }
}

export function generatedKeysMidi(line: GeneratedLine, key: string | null): MidiItem {
  const midi = generatedMidi(line, key)
  return { ...midi, role: 'keys', name: midi.name.replace('Bassline', 'Keys') }
}
const memo = new WeakMap<MidiItem[], KeysModel | null>()
export function keysModel(midis: MidiItem[]): KeysModel | null {
  if (!memo.has(midis)) memo.set(midis, learnKeys(midis))
  return memo.get(midis)!
}
