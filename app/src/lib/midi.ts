// MIDI files for the stem export (SCOPE.md §6.5): <Prefix>_markers.mid (tempo, 4/4 and the
// section markers, so importing it into Logic recreates them) and <Prefix>_Bass.mid (the bass
// parts as notes, to play with the real Serum patch in Logic, §6.7).

import type { MidiItem } from '../types/api'
import type { Clip, Marker, Project } from '../types/project'

export const PPQ = 480

function vlq(n: number): number[] {
  const out = [n & 0x7f]
  while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80)
  return out
}

function text(s: string): number[] {
  return [...new TextEncoder().encode(s)]
}

function meta(type: number, data: number[]): number[] {
  return [0xff, type, ...vlq(data.length), ...data]
}

type MidiEvent = { tick: number; bytes: number[] }

function header(bpm: number, name: string): MidiEvent[] {
  const usPerQuarter = Math.round(60_000_000 / bpm)
  return [
    { tick: 0, bytes: meta(0x03, text(name)) },
    { tick: 0, bytes: meta(0x58, [4, 2, 24, 8]) },                       // 4/4
    { tick: 0, bytes: meta(0x51, [(usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff]) },
  ]
}

/**
 * Format-0 MIDI file. Positions are relative to `startBeat` (the export range start), so
 * the file lines up with stems that start there; `endBeat` sets the end of the track.
 */
export function markersMidi(markers: Marker[], bpm: number, startBeat: number, endBeat: number, name: string): Uint8Array {
  const events = header(bpm, name)
  for (const m of [...markers].sort((a, b) => a.start - b.start)) {
    if (m.start < startBeat || m.start >= endBeat) continue
    events.push({ tick: Math.round((m.start - startBeat) * PPQ), bytes: meta(0x06, text(m.name)) })
  }
  return smf(events, endBeat - startBeat)
}

export interface PlacedNote {
  start: number      // beats (project)
  length: number     // beats
  pitch: number
  velocity: number
}

/** The notes the project's bass clips play: each clip's MIDI looped from its trim, transposed, cut at the clip end. */
export function bassNotes(project: Project, midis: MidiItem[], role: 'bass' | 'keys' = 'bass'): PlacedNote[] {
  const out: PlacedNote[] = []
  for (const c of project.clips as Clip[]) {
    if (c.type !== 'audio' || !c.bass || (c.bass.role ?? 'bass') !== role) continue
    const midi = midis.find((m) => m.id === c.bass!.midiId)
    const source = c.bass.notes ?? midi?.notes
    if (!source) continue
    const L = (c.bass.bars ?? midi?.bars ?? 1) * 4
    const end = c.start + c.length
    for (let rep = c.start - (c.trimBeats % L); rep < end; rep += L) {
      for (const [s, len, pitch, vel] of source) {
        const at = rep + s
        if (at < c.start - 1e-9 || at >= end - 1e-9) continue
        out.push({ start: at, length: Math.min(len, end - at), pitch: Math.max(0, Math.min(127, pitch + c.bass.transpose)), velocity: vel })
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
}

/** A MIDI file of notes (one track, channel 1), relative to `startBeat`. */
export function notesMidi(notes: PlacedNote[], bpm: number, startBeat: number, endBeat: number, name: string): Uint8Array {
  const events = header(bpm, name)
  const body: MidiEvent[] = []
  for (const n of notes) {
    if (n.start < startBeat || n.start >= endBeat) continue
    const on = Math.round((n.start - startBeat) * PPQ)
    const off = Math.round((Math.min(n.start + n.length, endBeat) - startBeat) * PPQ)
    body.push({ tick: on, bytes: [0x90, n.pitch, Math.max(1, Math.min(127, n.velocity))] })
    body.push({ tick: Math.max(on + 1, off), bytes: [0x80, n.pitch, 0] })
  }
  // Note-offs before note-ons at the same tick, so repeated notes retrigger.
  body.sort((a, b) => a.tick - b.tick || (a.bytes[0] === 0x80 ? -1 : 1) - (b.bytes[0] === 0x80 ? -1 : 1))
  return smf([...events, ...body], endBeat - startBeat)
}

function smf(events: MidiEvent[], lengthBeats: number): Uint8Array {
  events = [...events, { tick: Math.round(lengthBeats * PPQ), bytes: meta(0x2f, []) }]
  const track: number[] = []
  let last = 0
  for (const e of events) {
    track.push(...vlq(e.tick - last), ...e.bytes)
    last = e.tick
  }
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  return new Uint8Array([
    ...text('MThd'), ...u32(6), 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff,
    ...text('MTrk'), ...u32(track.length), ...track,
  ])
}
