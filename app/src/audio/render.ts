// Offline rendering for stem export (SCOPE.md §6.5): one OfflineAudioContext per stem, using
// the same scheduler (schedule.ts) and node graph (graph.ts) as live playback.

import { beatToSec, dbToGain } from '../lib/project'
import type { Project } from '../types/project'
import { buffers } from './context'
import { createLaneNodes, playEvent } from './graph'
import { eventsInRange } from './schedule'

export interface RenderRange {
  startBeat: number
  endBeat: number
}

/** Frames of a stem: identical for every stem of one export. */
export function rangeFrames(project: Project, range: RenderRange, sampleRate: number): number {
  return Math.round(beatToSec(range.endBeat - range.startBeat, project.bpm) * sampleRate)
}

/**
 * Render the given lanes (one lane for a stem, all unmuted lanes for the master) from the
 * range start. Lane volume and pan apply; muted lanes are silent; solo is ignored.
 */
export async function renderLanes(project: Project, laneIds: string[], range: RenderRange,
                                  sampleRate: number): Promise<AudioBuffer> {
  const frames = rangeFrames(project, range, sampleRate)
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.max(1, frames), sampleRate })
  const wanted = new Set(laneIds)
  const nodes = new Map<string, ReturnType<typeof createLaneNodes>>()
  for (const lane of project.lanes) {
    if (!wanted.has(lane.id)) continue
    const n = createLaneNodes(ctx, ctx.destination)
    // Fixed values, not the live ramps, so the level is exact from the first sample.
    n.gain.gain.value = lane.mute ? 0 : dbToGain(lane.volumeDb)
    n.pan.pan.value = Math.max(-1, Math.min(1, lane.pan))
    nodes.set(lane.id, n)
  }
  const from = beatToSec(range.startBeat, project.bpm)
  const to = beatToSec(range.endBeat, project.bpm)
  const events = eventsInRange(project, from, to, { includeOngoing: true, laneIds: wanted })
  await buffers.loadAll(events.map((e) => e.relPath))
  for (const ev of events) {
    const buf = buffers.get(ev.relPath)
    const lane = nodes.get(ev.laneId)
    if (buf && lane) playEvent(ctx, ev, buf, lane.gain, ev.start - from)
  }
  return ctx.startRendering()
}
