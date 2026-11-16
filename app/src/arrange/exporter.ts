// Stem export (SCOPE.md §6.5): one project folder ("Generated 08 - 124 BPM - E minor") with
// `masters/` (the mixdown, and mastered.wav: the mixdown through Ozone 11 in the engine), `stems/`
// (one full-length WAV per lane, named as the lane) and `midi/` (the bass part, named as its
// lane). Every WAV has the same length and starts at the range start.
//
// One render pass in the common case. In 24-bit mode a stem that would clip is not written;
// the caller then decides (32-bit float, auto-gain, export clipped, cancel) and calls again.

import { api } from '../api'
import { renderLanes, type RenderRange } from '../audio/render'
import { encodeWav, peakOf, type WavFormat } from '../audio/wav'
import { formatBpm } from '../lib/format'
import { bassNotes, notesMidi } from '../lib/midi'
import type { MasterResult } from '../types/engine'
import type { Project } from '../types/project'

export interface ExportOptions {
  /** The folder the project folder goes in. */
  dir: string
  /** The project folder's name. */
  folder: string
  range: RenderRange
  format: WavFormat
  sampleRate: number
  laneIds: string[]
  /** The masters: the mixdown, and mastered.wav made from it. */
  master: boolean
  /** The bass part as MIDI. */
  midi: boolean
  /** Linear gain applied to every stem (auto-gain); 1 = none. */
  gain: number
  /** Write 24-bit stems even if they clip. */
  allowClipping: boolean
}

export type ExportSub = 'masters' | 'stems' | 'midi'

export interface ExportTarget {
  key: string          // lane id or "master"
  label: string
  sub: ExportSub
  file: string
}

export interface ExportResult {
  written: string[]
  /** Stems that would clip in 24-bit (not written), with their peak (linear). */
  clipped: { target: ExportTarget; peak: number }[]
  /** Highest peak of all stems (linear, before gain). */
  maxPeak: number
  /** How mastered.wav came out, or why it wasn't made. */
  mastered?: MasterResult
  masterError?: string
}

export const MIXDOWN_FILE = 'mixdown.wav'
export const MASTERED_FILE = 'mastered.wav'
/** With vocals, House of Tracks also wants the masters without them. */
export const MIXDOWN_INSTRUMENTAL_FILE = 'mixdown instrumental.wav'
export const MASTERED_INSTRUMENTAL_FILE = 'mastered instrumental.wav'

/** The vocal lanes (SCOPE.md §6.11): what the instrumental masters leave out. */
export const VOCAL_LANES = new Set(['Vocal', 'Vocal Chops'])

/** The vocal takes a project sings (their ids), from its phrase renders and chops. */
export function vocalTakes(project: Project): string[] {
  const ids = project.clips.flatMap((c) => {
    if (c.type === 'audio' && c.bass?.role === 'vocal' && c.bass.vocal) return [c.bass.vocal.take]
    const m = /^Vocals\/([\w-]+)\//.exec(c.sample.relPath)
    return m ? [m[1]] : []
  })
  return [...new Set(ids)]
}

/** Whether the project sings: a vocal lane with clips that plays (unmuted). */
export function hasVocals(project: Project): boolean {
  return project.lanes.some((l) => VOCAL_LANES.has(l.name) && !l.mute && project.clips.some((c) => c.laneId === l.id))
}

export function safeName(s: string): string {
  return s.replace(/[/\\:*?"<>|\x00-\x1f]/g, '-').trim() || 'Untitled'
}

/** "E minor" for "Em", "F# major" for "F#". */
function keyName(label: string): string {
  return label.endsWith('m') ? `${label.slice(0, -1)} minor` : `${label} major`
}

/** The project folder's default name: the project, its tempo and (a generated track's) key. */
export function exportFolderName(project: Project): string {
  const key = project.generation?.key
  return [project.name, `${formatBpm(project.bpm)} BPM`, ...(key ? [keyName(key)] : [])].join(' - ')
}

export function exportTargets(project: Project, o: Pick<ExportOptions, 'laneIds' | 'master'>): ExportTarget[] {
  const lanes = project.lanes.filter((l) => o.laneIds.includes(l.id) && !l.mute)
  const targets: ExportTarget[] = lanes.map((l) => ({ key: l.id, label: l.name, sub: 'stems', file: `${safeName(l.name)}.wav` }))
  // Two lanes with the same name must not overwrite each other.
  const seen = new Map<string, number>()
  for (const t of targets) {
    const n = (seen.get(t.file) ?? 0) + 1
    seen.set(t.file, n)
    if (n > 1) t.file = t.file.replace(/\.wav$/, ` ${n}.wav`)
  }
  if (o.master) {
    targets.push({ key: 'master', label: 'Mixdown', sub: 'masters', file: MIXDOWN_FILE })
    if (hasVocals(project)) targets.push({ key: 'instrumental', label: 'Mixdown (instrumental)', sub: 'masters', file: MIXDOWN_INSTRUMENTAL_FILE })
  }
  return targets
}

/** The melodic part written as MIDI: the bass, named as its lane. */
export function midiParts(project: Project): { role: 'bass'; file: string }[] {
  const clip = project.clips.find((c) => c.type === 'audio' && c.bass && (c.bass.role ?? 'bass') === 'bass')
  if (!clip) return []
  const lane = project.lanes.find((l) => l.id === clip.laneId)
  return [{ role: 'bass', file: `${safeName(lane?.name ?? 'Bass')}.mid` }]
}

/** Absolute path of a subfolder of the export. */
export const exportDir = (o: Pick<ExportOptions, 'dir' | 'folder'>, sub: ExportSub) => `${o.dir}/${safeName(o.folder)}/${sub}`

export async function exportStems(project: Project, o: ExportOptions,
                                  onProgress: (message: string, pct: number) => void,
                                  isCancelled: () => boolean = () => false): Promise<ExportResult> {
  const targets = exportTargets(project, o)
  const result: ExportResult = { written: [], clipped: [], maxPeak: 0 }
  const unmuted = project.lanes.filter((l) => !l.mute).map((l) => l.id)
  const instrumental = project.lanes.filter((l) => !l.mute && !VOCAL_LANES.has(l.name)).map((l) => l.id)
  for (let i = 0; i < targets.length; i++) {
    if (isCancelled()) break
    const t = targets[i]
    onProgress(`Rendering ${t.label}`, i / targets.length)
    const audio = await renderLanes(project, t.key === 'master' ? unmuted : t.key === 'instrumental' ? instrumental : [t.key], o.range, o.sampleRate)
    const channels = [audio.getChannelData(0), audio.getChannelData(1)]
    const peak = peakOf(channels)
    result.maxPeak = Math.max(result.maxPeak, peak)
    if (o.format === 'pcm24' && peak * o.gain > 1 && !o.allowClipping) {
      result.clipped.push({ target: t, peak })
      continue
    }
    onProgress(`Writing ${t.file}`, (i + 0.8) / targets.length)
    await api.writeExportFile(exportDir(o, t.sub), t.file, encodeWav(channels, o.sampleRate, o.format, o.gain))
    result.written.push(`${t.sub}/${t.file}`)
    if ((t.key === 'master' || t.key === 'instrumental') && !isCancelled()) {
      // The master is made from the mixdown as written; the rest of the export stands if it fails.
      const out = t.key === 'master' ? MASTERED_FILE : MASTERED_INSTRUMENTAL_FILE
      onProgress(`Mastering ${t.key === 'master' ? '' : 'the instrumental '}with Ozone 11`, (i + 0.9) / targets.length)
      try {
        const m = await api.masterMixdown(exportDir(o, 'masters'), t.file, out, o.format)
        if (t.key === 'master') result.mastered = m
        result.written.push(`masters/${out}`)
      } catch (e) {
        result.masterError = (e as Error).message
      }
    }
  }
  const parts = o.midi ? midiParts(project) : []
  if (parts.length && !isCancelled()) {
    const midis = await api.listMidi()
    for (const { file } of parts) {
      const notes = bassNotes(project, midis)
      const data = notesMidi(notes, project.bpm, o.range.startBeat, o.range.endBeat, file.replace(/\.mid$/, ''))
      await api.writeExportFile(exportDir(o, 'midi'), file, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
      result.written.push(`midi/${file}`)
    }
  }
  // House of Tracks takes each vocal once: the takes this track sings are used now.
  const sung = vocalTakes(project)
  if (sung.length && !isCancelled() && result.written.length) await api.markVocalsUsed(sung, safeName(o.folder))
  onProgress('Done', 1)
  return result
}
