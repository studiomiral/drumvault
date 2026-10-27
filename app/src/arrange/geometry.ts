// Timeline layout: shared by drawing and hit testing.

import type { Lane } from '../types/project'

export const MARKER_H = 22
export const RULER_H = 24
export const TOP = MARKER_H + RULER_H
export const HEADER_W = 236
export const EDGE_PX = 6

export interface LaneBox {
  lane: Lane
  index: number
  y: number    // top, in canvas px (scroll applied)
  h: number
}

export function laneBoxes(lanes: Lane[], scrollY: number): LaneBox[] {
  let y = TOP - scrollY
  return lanes.map((lane, index) => {
    const box = { lane, index, y, h: lane.height }
    y += lane.height
    return box
  })
}

export function lanesHeight(lanes: Lane[]): number {
  return lanes.reduce((h, l) => h + l.height, 0)
}

export function laneAt(boxes: LaneBox[], y: number): LaneBox | null {
  return boxes.find((b) => y >= b.y && y < b.y + b.h) ?? null
}

export function beatToX(beat: number, pxPerBeat: number, scrollX: number): number {
  return beat * pxPerBeat - scrollX
}

export function xToBeat(x: number, pxPerBeat: number, scrollX: number): number {
  return (x + scrollX) / pxPerBeat
}

/** Spacing (in bars) between ruler labels so they stay readable. */
export function rulerStep(pxPerBeat: number): number {
  const barPx = pxPerBeat * 4
  for (const n of [1, 2, 4, 8, 16, 32]) if (barPx * n >= 44) return n
  return 64
}
