// Timeline layout: shared by drawing and hit testing.

import type { Lane } from '../types/project'

export const MARKER_H = 28
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

/** Snap divisions in beats: 16th, 8th, beat, then 1, 2, 4, 8 and 16 bars. */
const SNAP_UNITS = [0.25, 0.5, 1, 4, 8, 16, 32, 64]
/** A snap step is never narrower than this on screen (16ths appear with the 16th grid lines). */
export const SNAP_MIN_PX = 14
/** The finest snap step, and the shortest a clip can be made. */
export const MIN_SNAP_BEATS = SNAP_UNITS[0]

/**
 * Snap step for dragging at this zoom: the finest division at least SNAP_MIN_PX wide, so
 * zoomed in close edits land on 16ths and zoomed out on whole bars or more. ⌥ (`fine`) snaps
 * four times finer, down to 16ths.
 */
export function snapUnit(pxPerBeat: number, fine = false): number {
  const u = SNAP_UNITS.find((v) => v * pxPerBeat >= SNAP_MIN_PX) ?? SNAP_UNITS[SNAP_UNITS.length - 1]
  return fine ? Math.max(MIN_SNAP_BEATS, u / 4) : u
}

/** Spacing (in bars) between ruler labels so they stay readable. */
export function rulerStep(pxPerBeat: number): number {
  const barPx = pxPerBeat * 4
  for (const n of [1, 2, 4, 8, 16, 32]) if (barPx * n >= 44) return n
  return 64
}
