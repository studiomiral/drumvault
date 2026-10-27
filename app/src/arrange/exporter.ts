// Stem export (SCOPE.md §6.5): one full-length WAV per lane (+ optional master), all the
// same length and starting at the range start, plus an optional MIDI markers file.
//
// One render pass in the common case. In 24-bit mode a stem that would clip is not written;
// the caller then decides (32-bit float, auto-gain, export clipped, cancel) and calls again.

import { api } from '../api'
import { renderLanes, type RenderRange } from '../audio/render'
import { encodeWav, peakOf, type WavFormat } from '../audio/wav'
import { formatBpm } from '../lib/format'
import { markersMidi } from '../lib/midi'
import type { Project } from '../types/project'

export interface ExportOptions {
  dir: string
  prefix: string
  range: RenderRange
  format: WavFormat
  sampleRate: number
  laneIds: string[]
  master: boolean
  midi: boolean
  /** Linear gain applied to every stem (auto-gain); 1 = none. */
  gain: number
  /** Write 24-bit stems even if they clip. */
  allowClipping: boolean
}

export interface ExportTarget {
  key: string          // lane id or "master"
  label: string
  file: string
}

export interface ExportResult {
  written: string[]
  /** Stems that would clip in 24-bit (not written), with their peak (linear). */
  clipped: { target: ExportTarget; peak: number }[]
  /** Highest peak of all stems (linear, before gain). */
  maxPeak: number
}

export function safeName(s: string): string {
  return s.replace(/[/\\:*?"<>|\x00-\x1f]/g, '-').trim() || 'Untitled'
}

export function exportTargets(project: Project, o: Pick<ExportOptions, 'prefix' | 'laneIds' | 'master'>): ExportTarget[] {
  const bpm = `${formatBpm(project.bpm)}bpm`
  const prefix = safeName(o.prefix)
  const lanes = project.lanes.filter((l) => o.laneIds.includes(l.id) && !l.mute)
  const targets = lanes.map((l) => ({ key: l.id, label: l.name, file: `${prefix}_${safeName(l.name)}_${bpm}.wav` }))
  // Two lanes with the same name must not overwrite each other.
  const seen = new Map<string, number>()
  for (const t of targets) {
    const n = (seen.get(t.file) ?? 0) + 1
    seen.set(t.file, n)
    if (n > 1) t.file = t.file.replace(/_(\d+(?:\.\d+)?bpm)\.wav$/, ` ${n}_$1.wav`)
  }
  if (o.master) targets.push({ key: 'master', label: 'Master', file: `${prefix}_Master_${bpm}.wav` })
  return targets
}

export function midiFileName(prefix: string): string {
  return `${safeName(prefix)}_markers.mid`
}

export async function exportStems(project: Project, o: ExportOptions,
                                  onProgress: (message: string, pct: number) => void,
                                  isCancelled: () => boolean = () => false): Promise<ExportResult> {
  const targets = exportTargets(project, o)
  const result: ExportResult = { written: [], clipped: [], maxPeak: 0 }
  const unmuted = project.lanes.filter((l) => !l.mute).map((l) => l.id)
  for (let i = 0; i < targets.length; i++) {
    if (isCancelled()) break
    const t = targets[i]
    onProgress(`Rendering ${t.label}`, i / targets.length)
    const audio = await renderLanes(project, t.key === 'master' ? unmuted : [t.key], o.range, o.sampleRate)
    const channels = [audio.getChannelData(0), audio.getChannelData(1)]
    const peak = peakOf(channels)
    result.maxPeak = Math.max(result.maxPeak, peak)
    if (o.format === 'pcm24' && peak * o.gain > 1 && !o.allowClipping) {
      result.clipped.push({ target: t, peak })
      continue
    }
    onProgress(`Writing ${t.file}`, (i + 0.8) / targets.length)
    await api.writeExportFile(o.dir, t.file, encodeWav(channels, o.sampleRate, o.format, o.gain))
    result.written.push(t.file)
  }
  if (o.midi && !isCancelled()) {
    const file = midiFileName(o.prefix)
    const data = markersMidi(project.markers, project.bpm, o.range.startBeat, o.range.endBeat, project.name)
    await api.writeExportFile(o.dir, file, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
    result.written.push(file)
  }
  onProgress('Done', 1)
  return result
}
