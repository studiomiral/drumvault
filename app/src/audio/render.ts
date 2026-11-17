// Offline rendering for stem export (SCOPE.md §6.5): one OfflineAudioContext per stem, using
// the same scheduler (schedule.ts) and node graph (graph.ts) as live playback. Reverb builds
// are baked into their lane's stem, tails and all; so are the lane's EQ and compressor, and the
// drum bus's gain on a bus lane (rendered once from all of them: the stems add up to the bus).

import { beatToSec, dbToGain } from '../lib/project'
import type { Project } from '../types/project'
import { buffers } from './context'
import { createBusDetector, createLaneNodes, duckAt, laneCompParams, laneEqBands, laneGainDb, loadComp, onBus, playEvent, setBusDetector, setLaneBus, setLaneComp, setLaneEq, setLaneMono, setLaneRoom, type LaneNodes } from './graph'
import { duckRelease, eventsInRange, kickHits } from './schedule'
import { ensureTempo } from './tempo'

export interface RenderRange {
  startBeat: number
  endBeat: number
}

/** Frames of a stem: identical for every stem of one export. */
export function rangeFrames(project: Project, range: RenderRange, sampleRate: number): number {
  return Math.round(beatToSec(range.endBeat - range.startBeat, project.bpm) * sampleRate)
}

/** Lanes `ids` of `project` made in `ctx` into `dest`, their sounds and sidechain scheduled over `range`. */
async function playLanes(ctx: OfflineAudioContext, project: Project, ids: Set<string>, range: RenderRange,
                         dest: AudioNode): Promise<Map<string, LaneNodes>> {
  const nodes = new Map<string, LaneNodes>()
  for (const lane of project.lanes) {
    if (!ids.has(lane.id)) continue
    const n = createLaneNodes(ctx, dest)
    // Fixed values, not the live ramps, so the level is exact from the first sample.
    n.gain.gain.value = lane.mute ? 0 : dbToGain(laneGainDb(lane))
    setLaneEq(ctx, n, laneEqBands(lane))
    setLaneComp(ctx, n, laneCompParams(lane, project.bpm))
    setLaneMono(ctx, n, lane.monoBelow)
    setLaneRoom(n, !!lane.room)
    n.pan.pan.value = Math.max(-1, Math.min(1, lane.pan))
    nodes.set(lane.id, n)
  }
  const from = beatToSec(range.startBeat, project.bpm)
  const to = beatToSec(range.endBeat, project.bpm)
  const events = eventsInRange(project, from, to, { includeOngoing: true, laneIds: ids })
  await ensureTempo(project)
  await buffers.loadAll(events.map((e) => e.relPath))
  for (const ev of events) {
    const buf = buffers.get(ev.relPath)
    const lane = nodes.get(ev.laneId)
    if (buf && lane) playEvent(ctx, ev, buf, lane, ev.start - from)
  }
  // Sidechain, from all kicks (also when the kick lane isn't part of this render).
  const hits = kickHits(project, from, to)
  for (const lane of project.lanes) {
    const n = nodes.get(lane.id)
    if (n && lane.duck) for (const t of hits) duckAt(n, t - from, lane.duck, duckRelease(project.bpm, lane.duckBeats))
  }
  return nodes
}

/** The compressor worklet in `ctx`, or the export fails: a stem without its compressors isn't the lane as it plays. */
async function needComp(ctx: BaseAudioContext): Promise<void> {
  if (!(await loadComp(ctx))) throw new Error('the lane compressor could not be loaded')
}

/** Drum bus gains rendered for one export: by project (as exported) and range. */
const busCurves = new WeakMap<Project, Map<string, Promise<Float32Array>>>()

/**
 * The drum bus's gain over `range`, sample by sample: every bus lane (muted ones silent) played
 * into the bus's detector. Rendered once per export and range: every bus lane's stem (and the
 * mixdown) plays the same gain, so the stems add up to the bus.
 */
export function busGain(project: Project, range: RenderRange, sampleRate: number): Promise<Float32Array> {
  const key = `${range.startBeat}:${range.endBeat}:${sampleRate}`
  let byRange = busCurves.get(project)
  if (!byRange) busCurves.set(project, (byRange = new Map()))
  let p = byRange.get(key)
  if (!p) {
    p = (async () => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: Math.max(1, rangeFrames(project, range, sampleRate)), sampleRate })
      await needComp(ctx)
      const detector = createBusDetector(ctx)!
      setBusDetector(detector, project)
      detector.connect(ctx.destination)
      await playLanes(ctx, project, new Set(project.lanes.filter((l) => onBus(l, project)).map((l) => l.id)), range, detector)
      return (await ctx.startRendering()).getChannelData(0)
    })()
    p.catch(() => byRange!.delete(key))
    byRange.set(key, p)
  }
  return p
}

/**
 * Render the given lanes (one lane for a stem, all unmuted lanes for the master) from the
 * range start. Lane volume and pan apply; muted lanes are silent; solo is ignored. Bus lanes
 * play through the drum bus's gain, as all the bus lanes make it together.
 */
export async function renderLanes(project: Project, laneIds: string[], range: RenderRange,
                                  sampleRate: number): Promise<AudioBuffer> {
  const frames = rangeFrames(project, range, sampleRate)
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.max(1, frames), sampleRate })
  const wanted = new Set(laneIds)
  const bussed = project.lanes.filter((l) => wanted.has(l.id) && onBus(l, project))
  if (bussed.length || project.lanes.some((l) => wanted.has(l.id) && laneCompParams(l, project.bpm))) await needComp(ctx)
  const nodes = await playLanes(ctx, project, wanted, range, ctx.destination)
  if (bussed.length) {
    const curve = await busGain(project, range, sampleRate)
    const buf = ctx.createBuffer(1, curve.length, sampleRate)
    buf.copyToChannel(curve as Float32Array<ArrayBuffer>, 0)
    const src = ctx.createBufferSource()
    src.buffer = buf
    for (const l of bussed) setLaneBus(nodes.get(l.id)!, { drive: src })
    src.start(0)
  }
  return ctx.startRendering()
}
