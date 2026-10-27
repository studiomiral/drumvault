import { describe, expect, it } from 'vitest'
import { markersMidi, PPQ } from '../src/lib/midi'

/** Minimal SMF reader: header + meta events of the first track. */
function parse(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const s = (o: number, n: number) => String.fromCharCode(...bytes.subarray(o, o + n))
  expect(s(0, 4)).toBe('MThd')
  const header = { format: v.getUint16(8), tracks: v.getUint16(10), ppq: v.getUint16(12) }
  expect(s(14, 4)).toBe('MTrk')
  const end = 22 + v.getUint32(18)
  expect(end).toBe(bytes.length)
  const events: { tick: number; type: number; data: Uint8Array }[] = []
  let o = 22
  let tick = 0
  const vlq = () => {
    let n = 0
    for (;;) {
      const b = bytes[o++]
      n = (n << 7) | (b & 0x7f)
      if (!(b & 0x80)) return n
    }
  }
  while (o < end) {
    tick += vlq()
    expect(bytes[o++]).toBe(0xff)
    const type = bytes[o++]
    const len = vlq()
    events.push({ tick, type, data: bytes.subarray(o, o + len) })
    o += len
  }
  return { header, events }
}

describe('markersMidi', () => {
  const markers = [
    { id: 'b', name: 'Drop', start: 64, end: 128, color: '' },
    { id: 'a', name: 'Intro', start: 0, end: 32, color: '' },
    { id: 'c', name: 'Outro', start: 700, end: 768, color: '' },
  ]

  it('writes tempo, 4/4 and the markers at their beats', () => {
    const { header, events } = parse(markersMidi(markers, 124, 0, 768, 'My Song'))
    expect(header).toEqual({ format: 0, tracks: 1, ppq: PPQ })
    const tempo = events.find((e) => e.type === 0x51)!
    expect((tempo.data[0] << 16) | (tempo.data[1] << 8) | tempo.data[2]).toBe(Math.round(60e6 / 124))
    expect([...events.find((e) => e.type === 0x58)!.data.slice(0, 2)]).toEqual([4, 2])
    const m = events.filter((e) => e.type === 0x06).map((e) => [e.tick / PPQ, new TextDecoder().decode(e.data)])
    expect(m).toEqual([[0, 'Intro'], [64, 'Drop'], [700, 'Outro']])
    expect(events.at(-1)).toMatchObject({ type: 0x2f, tick: 768 * PPQ })
    expect(new TextDecoder().decode(events[0].data)).toBe('My Song')
  })

  it('is relative to the export range', () => {
    const { events } = parse(markersMidi(markers, 124, 64, 128, 'x'))
    const m = events.filter((e) => e.type === 0x06).map((e) => [e.tick, new TextDecoder().decode(e.data)])
    expect(m).toEqual([[0, 'Drop']])
    expect(events.at(-1)!.tick).toBe(64 * PPQ)
  })
})
