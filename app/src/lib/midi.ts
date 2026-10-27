// <Prefix>_markers.mid (SCOPE.md §6.5): tempo, 4/4 and the section markers as a Standard
// MIDI File, so importing it into Logic recreates the tempo and the markers.

import type { Marker } from '../types/project'

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

/**
 * Format-0 MIDI file. Positions are relative to `startBeat` (the export range start), so
 * the file lines up with stems that start there; `endBeat` sets the end of the track.
 */
export function markersMidi(markers: Marker[], bpm: number, startBeat: number, endBeat: number, name: string): Uint8Array {
  const usPerQuarter = Math.round(60_000_000 / bpm)
  const events: { tick: number; bytes: number[] }[] = [
    { tick: 0, bytes: meta(0x03, text(name)) },
    { tick: 0, bytes: meta(0x58, [4, 2, 24, 8]) },                       // 4/4
    { tick: 0, bytes: meta(0x51, [(usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff]) },
  ]
  for (const m of [...markers].sort((a, b) => a.start - b.start)) {
    if (m.start < startBeat || m.start >= endBeat) continue
    events.push({ tick: Math.round((m.start - startBeat) * PPQ), bytes: meta(0x06, text(m.name)) })
  }
  events.push({ tick: Math.round((endBeat - startBeat) * PPQ), bytes: meta(0x2f, []) })

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
