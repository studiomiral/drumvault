// Arrange editing commands (SCOPE.md §6.4): one implementation for the keys, the Edit menu and
// the right-click menu.

import { api } from '../api'
import { playback } from '../audio/engine'
import {
  BEATS_PER_BAR, canReplace, duplicateClips, pasteClips, replaceSample, sampleRef, shiftContent, splitClip, uid,
} from '../lib/project'
import { useApp } from '../store/app'
import { useLibrary } from '../store/library'
import { useProject } from '../store/project'
import type { BassRender, Clip, SampleRef } from '../types/project'
import { bassPath } from '../audio/schedule'
import { loadKeys, useKeys } from '../store/keys'
import { keysModel, generateKeys, generatedKeysMidi } from '../generate/keys'
import { loadBass, useBass } from '../store/bass'
import { bassModel, generatedMidi, isGenerated, keyOfLine, type BassNote } from '../generate/bassline'
import { bassFor, harmonyOf } from '../generate/harmony'
import { Rng, randomSeed } from '../generate/rng'

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

function selectedClips(): Clip[] {
  const st = useProject.getState()
  const ids = new Set(st.selection)
  return st.project.clips.filter((c) => ids.has(c.id))
}

/** Decode new samples right away, so the change is heard while playing. */
function preload(): void {
  void playback.preload(useProject.getState().project)
}

/** New sounds for these clips (bass re-renders): render, load, and swap them in while playing. */
function reload(clipIds: Iterable<string>): void {
  void playback.reloadClips(useProject.getState().project, clipIds)
}

// ---- clipboard (inside the app; clips are not text) ----------------------------------------

let clipboard: Clip[] = []

export function hasClipboard(): boolean {
  return clipboard.length > 0
}

/** The copied sample, if exactly one sample was copied (for "Replace with copied sample"). */
export function clipboardSample(): SampleRef | null {
  const paths = new Set(clipboard.map((c) => c.sample.relPath))
  return paths.size === 1 ? clipboard[0].sample : null
}

export function copySelection(): boolean {
  const sel = selectedClips()
  if (!sel.length) return false
  clipboard = sel.map((c) => structuredClone(c))
  return true
}

export function cutSelection(): void {
  if (copySelection()) deleteSelection()
}

/** Paste the copied clips with the earliest at `beat`, on their own lanes; they become the selection. */
export function pasteAt(beat: number): void {
  const st = useProject.getState()
  if (!clipboard.length || !st.project.lanes.length) return
  const lanes = st.project.lanes.map((l) => l.id)
  const copies = pasteClips(clipboard, beat, lanes, lanes[0])
  st.edit(`Paste ${plural(copies.length, 'clip')}`, (d) => {
    d.clips.push(...copies)
  })
  st.select(copies.map((c) => c.id))
  preload()
}

/** ⌘V: at the playhead's bar. */
export function pasteAtPlayhead(): void {
  pasteAt(Math.floor(playback.position() / BEATS_PER_BAR) * BEATS_PER_BAR)
}

// ---- selection edits -----------------------------------------------------------------------

export function deleteSelection(): void {
  const st = useProject.getState()
  if (st.selection.length) {
    const ids = new Set(st.selection)
    st.edit(`Delete ${plural(ids.size, 'clip')}`, (d) => {
      d.clips = d.clips.filter((c) => !ids.has(c.id))
    })
  } else if (st.selectedMarker) {
    const id = st.selectedMarker
    st.edit('Delete marker', (d) => {
      d.markers = d.markers.filter((m) => m.id !== id)
    })
  }
}

/**
 * ⌘D / R: copies of the selection placed right after it. With a section marker selected the
 * whole section is duplicated: its clips move by the section length and the marker is copied.
 */
export function duplicateSelection(): void {
  const st = useProject.getState()
  const sel = selectedClips()
  const marker = st.project.markers.find((m) => m.id === st.selectedMarker)
  if (!sel.length && !marker) return
  const span = marker ? marker.end - marker.start : undefined
  const copies = duplicateClips(sel, span)
  const markerCopy = marker ? { ...marker, id: uid('m'), start: marker.end, end: marker.end + span! } : null
  st.edit(markerCopy ? `Duplicate section ${marker!.name}` : `Duplicate ${plural(copies.length, 'clip')}`, (d) => {
    d.clips.push(...copies)
    if (markerCopy) d.markers.push(markerCopy)
  })
  st.select(copies.map((c) => c.id))
  if (markerCopy) st.selectMarker(markerCopy.id)
}

/** ⇧← / ⇧→: move the sound of the selected clips a beat earlier/later inside their loop. */
export function shiftSelection(beats: number): void {
  const st = useProject.getState()
  const ids = new Set(st.selection)
  if (!ids.size) return
  st.edit('Move sound in clip', (d) => {
    d.clips = d.clips.map((c) => (ids.has(c.id) ? shiftContent(c, beats) : c))
  }, { coalesce: 'shift-content' })
}

/** Right-click: pitch the selected clips (not bass) a semitone up or down, or back to the original (null). */
export function pitchSelection(semitones: 1 | -1 | null): void {
  const st = useProject.getState()
  const ids = new Set(st.selection)
  if (!ids.size) return
  st.edit(semitones == null ? 'Original pitch' : 'Pitch', (d) => {
    for (const c of d.clips) {
      if (!ids.has(c.id) || (c.type === 'audio' && c.bass)) continue
      const p = semitones == null ? 0 : Math.max(-12, Math.min(12, (c.pitch ?? 0) + semitones))
      if (p) c.pitch = p
      else delete c.pitch
    }
  }, { coalesce: 'pitch' })
}

/** S / right-click: split the selected clips that contain `beat` there. */
export function splitSelectionAt(beat: number): void {
  const st = useProject.getState()
  const parts = selectedClips().map((c) => [c.id, splitClip(c, beat)] as const).filter(([, p]) => p)
  if (!parts.length) return
  const byId = new Map(parts)
  st.edit(`Split ${plural(parts.length, 'clip')}`, (d) => {
    d.clips = d.clips.flatMap((c) => byId.get(c.id) ?? [c])
  })
  st.select(parts.flatMap(([, p]) => p!.map((c) => c.id)))
}

export function removeFades(): void {
  const st = useProject.getState()
  const ids = new Set(st.selection)
  st.edit('Remove fades', (d) => {
    for (const c of d.clips) {
      if (!ids.has(c.id)) continue
      delete c.fadeIn
      delete c.fadeOut
    }
  })
}

/** Give the selected clips (that can take it) another sample, keeping place, length and pattern. */
export function replaceWith(sample: SampleRef, label = 'Replace sample'): number {
  const st = useProject.getState()
  const ids = new Set(selectedClips().filter((c) => canReplace(c, sample)).map((c) => c.id))
  if (!ids.size) return 0
  st.edit(label, (d) => {
    d.clips = d.clips.map((c) => (ids.has(c.id) ? replaceSample(c, sample) : c))
  })
  preload()
  return ids.size
}

/** Samples a clip was already swapped through, so swapping again goes further down the list. */
const swapped = new Map<string, Set<string>>()

/** Swap each selected clip's sample for the most similar one it hasn't had yet. */
export async function swapForSimilar(): Promise<void> {
  const st = useProject.getState()
  const sel = selectedClips()
  const next = new Map<string, SampleRef>()
  for (const c of sel) {
    const [cur] = await api.samplesByPath([c.sample.relPath])
    if (!cur) continue
    const seen = swapped.get(c.id) ?? new Set([c.sample.relPath])
    const cands = (await api.similarSamples(cur.id, 40)).filter((s) => !seen.has(s.rel_path))
    const pick = cands.find((s) => canReplace(c, sampleRef(s)))
    if (!pick) continue
    seen.add(pick.rel_path)
    next.set(c.id, sampleRef(pick))
  }
  if (!next.size) {
    useApp.getState().toast('info', 'No other similar sound found.')
    return
  }
  st.edit('Swap for a similar sound', (d) => {
    d.clips = d.clips.map((c) => {
      const s = next.get(c.id)
      if (!s) return c
      swapped.set(c.id, swapped.get(c.id) ?? new Set([c.sample.relPath]))
      swapped.get(c.id)!.add(s.relPath)
      return replaceSample(c, s)
    })
  })
  preload()
}

// ---- bass clips (Serum 2 renders, SCOPE.md §6.7) -------------------------------------------

export function hasBass(clips: Clip[], role: 'bass' | 'keys' = 'bass'): boolean {
  return clips.some((c) => c.type === 'audio' && c.bass && (c.bass.role ?? 'bass') === role)
}

/** Change the selected bass clips' render (patch, bassline, transpose); they re-render and play on. */
export async function changeBass(label: string, change: (b: BassRender) => BassRender, role?: 'bass' | 'keys'): Promise<void> {
  const st = useProject.getState()
  const ids = new Set(selectedClips().filter((c) => c.type === 'audio' && c.bass && (!role || (c.bass.role ?? 'bass') === role)).map((c) => c.id))
  if (!ids.size) return
  const bpm = st.project.bpm
  st.edit(label, (d) => {
    for (const c of d.clips) {
      if (!ids.has(c.id) || c.type !== 'audio' || !c.bass) continue
      const b = change({ ...c.bass })
      if (b.midiId !== c.bass.midiId && !isGenerated(b.midiId)) {  // another bassline: the old one's edits don't apply
        delete b.notes
        delete b.bars
      }
      const midi = (b.role === 'keys' ? useKeys.getState().parts : useBass.getState().basslines).find((m) => m.id === b.midiId)
      c.bass = b
      c.sample.relPath = bassPath(b, bpm)
      c.sample.name = `${b.presetName} · ${b.midiName}`
      const bars = b.bars ?? midi?.bars
      if (bars) {
        c.sample.bars = bars
        c.sample.durationS = (bars * BEATS_PER_BAR * 60) / bpm
        c.trimBeats %= bars * BEATS_PER_BAR
      }
    }
  })
  reload(ids)
}

/**
 * Piano roll (SCOPE.md §6.7): new notes / loop length for a bassline, applied to every bass clip
 * in the project that plays it (`notes` null: back to the imported file).
 */
export function editBassNotes(midiId: number, notes: [number, number, number, number][] | null, bars: number | null, role: 'bass' | 'keys' = 'bass'): void {
  if (!notes && isGenerated(midiId)) return  // a generated line is its notes: nothing to go back to
  const st = useProject.getState()
  const bpm = st.project.bpm
  const midi = (role === 'keys' ? useKeys.getState().parts : useBass.getState().basslines).find((m) => m.id === midiId)
  st.edit(role === 'keys' ? 'Edit keys notes' : 'Edit bass notes', (d) => {
    for (const c of d.clips) {
      if (c.type !== 'audio' || c.bass?.midiId !== midiId || (c.bass.role ?? 'bass') !== role) continue
      if (notes) {
        c.bass.notes = notes
        c.bass.bars = bars ?? c.bass.bars ?? midi?.bars
      } else {
        delete c.bass.notes
        delete c.bass.bars
      }
      const loop = c.bass.bars ?? midi?.bars ?? c.sample.bars ?? 1
      c.sample.relPath = bassPath(c.bass, bpm)
      c.sample.bars = loop
      c.sample.durationS = (loop * BEATS_PER_BAR * 60) / bpm
      c.trimBeats %= loop * BEATS_PER_BAR
    }
  }, { coalesce: `${role}-notes-${midiId}` })
  reload(useProject.getState().project.clips.filter((c) => c.type === 'audio' && c.bass?.midiId === midiId && (c.bass.role ?? 'bass') === role).map((c) => c.id))
}

/** Point every clip of one bassline at another (a just-saved edit), without the edits. */
export function switchBassline(fromMidiId: number, to: { id: number; name: string }, role: 'bass' | 'keys' = 'bass'): void {
  const st = useProject.getState()
  const bpm = st.project.bpm
  st.edit(role === 'keys' ? 'Use saved keys part' : 'Use saved bassline', (d) => {
    for (const c of d.clips) {
      if (c.type !== 'audio' || c.bass?.midiId !== fromMidiId || (c.bass.role ?? 'bass') !== role) continue
      c.bass = { ...c.bass, midiId: to.id, midiName: to.name }
      delete c.bass.notes
      delete c.bass.bars
      c.sample.relPath = bassPath(c.bass, bpm)
      c.sample.name = `${c.bass.presetName} · ${to.name}`
    }
  })
  reload(useProject.getState().project.clips.filter((c) => c.type === 'audio' && c.bass?.midiId === to.id && (c.bass.role ?? 'bass') === role).map((c) => c.id))
}

/**
 * A new bassline for the selected bass clips (one line for all of them), written from what the
 * MIDI library's basslines have in common, in the key the clips play now.
 */
/** What the project's first bass or keys clip plays, in pitch (transposed), for the other part to fit. */
function projectPart(role: 'bass' | 'keys'): { notes: BassNote[]; bars: number } | null {
  const c = useProject.getState().project.clips.find((k) => k.type === 'audio' && k.bass && (k.bass.role ?? 'bass') === role)
  if (c?.type !== 'audio' || !c.bass) return null
  const b = c.bass
  const midi = (role === 'keys' ? useKeys.getState().parts : useBass.getState().basslines).find((m) => m.id === b.midiId)
  const notes = b.notes ?? midi?.notes
  return notes ? { notes: notes.map(([s, l, p, v]): BassNote => [s, l, p + b.transpose, v]), bars: b.bars ?? midi?.bars ?? 1 } : null
}

export async function newClipBassline(): Promise<void> {
  if (!useBass.getState().loaded) await loadBass()
  const { basslines } = useBass.getState()
  const model = bassModel(basslines)
  if (!model) {
    useApp.getState().toast('info', 'No bass MIDI to learn from yet: add your MIDI zips on the MIDI page.')
    return
  }
  const first = selectedClips().find((c) => c.type === 'audio' && c.bass && c.bass.role !== 'keys')
  if (first?.type !== 'audio' || !first.bass) return
  const old = first.bass
  // A generated line's transpose (an octave up, say) carries over; an imported one's moved it into the key.
  const keepTranspose = isGenerated(old.midiId)
  const notes = old.notes ?? basslines.find((m) => m.id === old.midiId)?.notes ?? []
  const key = keyOfLine(notes.map(([s, l, p, v]) => [s, l, p + (keepTranspose ? 0 : old.transpose), v]))
  const keys = projectPart('keys')   // a riff that goes with the project's keys
  const m = generatedMidi(bassFor(model, new Rng(randomSeed()), { key, bars: null }, keys ? harmonyOf(keys.notes, keys.bars, key) : null), key)
  await changeBass('New bassline', (b) => ({
    ...b, midiId: m.id, midiName: m.name, notes: m.notes, bars: m.bars, keyLabel: key, transpose: keepTranspose ? b.transpose : 0,
  }), 'bass')
}

function transposeKey(key: string, semitones: number): string {
  const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
  const enharmonic: Record<string, number> = { Db: 1, 'D#': 3, Gb: 6, 'G#': 8, 'A#': 10 }
  const base = key.replace(/m$/, '')
  const root = enharmonic[base] ?? names.indexOf(base)
  return `${names[((root + semitones) % 12 + 12) % 12]}${key.endsWith('m') ? 'm' : ''}`
}

export async function newClipKeysPart(): Promise<void> {
  if (!useKeys.getState().loaded) await loadKeys()
  const { parts } = useKeys.getState()
  const model = keysModel(parts)
  if (!model) {
    useApp.getState().toast('info', 'No keys, piano or organ MIDI to learn from yet: add your MIDI zips on the MIDI page.')
    return
  }
  const first = selectedClips().find((c) => c.type === 'audio' && c.bass && c.bass.role === 'keys')
  if (first?.type !== 'audio' || !first.bass) return
  const old = first.bass
  // A generated line's transpose (an octave up, say) carries over; an imported one's moved it into the key.
  const keepTranspose = isGenerated(old.midiId)
  const notes = old.notes ?? parts.find((m) => m.id === old.midiId)?.notes ?? []
  const key = old.keyLabel ? (keepTranspose ? old.keyLabel : transposeKey(old.keyLabel, old.transpose)) : keyOfLine(notes.map(([s, l, p, v]) => [s, l, p + (keepTranspose ? 0 : old.transpose), v]))
  // A keys loop that goes with the project's bass riff.
  const m = generatedKeysMidi(generateKeys(model, new Rng(randomSeed()), { key, bars: null, bass: projectPart('bass') }), key)
  await changeBass('New keys part', (b) => ({
    ...b, midiId: m.id, midiName: m.name, notes: m.notes, bars: m.bars, keyLabel: key, transpose: keepTranspose ? b.transpose : 0,
  }), 'keys')
}

/** Next / previous / a random patch or bassline from the pool, for the selected bass clips. */
export async function stepBass(what: 'patch' | 'bassline', dir: 1 | -1 | 'random', role: 'bass' | 'keys' = 'bass'): Promise<void> {
  if (!useBass.getState().loaded) await loadBass()
  if (role === 'keys' && !useKeys.getState().loaded) await loadKeys()
  const presets = role === 'keys' ? useKeys.getState().presets : useBass.getState().presets
  const basslines = role === 'keys' ? useKeys.getState().parts : useBass.getState().basslines
  const pickFrom = <T,>(list: T[], i: number) => {
    if (!list.length) return null
    if (dir === 'random') return list[Math.floor(Math.random() * list.length)]
    return list[(((i + dir) % list.length) + list.length) % list.length]
  }
  if (what === 'patch') {
    if (!presets.length) {
      useApp.getState().toast('info', 'No Serum 2 patches: choose the matching preset folders in Settings.')
      return
    }
    await changeBass('Change bass patch', (b) => {
      const p = pickFrom(presets, presets.findIndex((x) => x.path === b.preset))!
      return { ...b, preset: p.path, presetName: p.name }
    }, role)
  } else {
    if (!basslines.length) return
    await changeBass('Change bassline', (b) => {
      const m = pickFrom(basslines, basslines.findIndex((x) => x.id === b.midiId))!
      return { ...b, midiId: m.id, midiName: m.name }
    }, role)
  }
}

// ---- the sample behind a clip --------------------------------------------------------------

/** Open the Library on this clip's sample. */
export async function showInLibrary(clip: Clip): Promise<void> {
  const [s] = await api.samplesByPath([clip.sample.relPath])
  if (!s) {
    useApp.getState().toast('info', 'This sample is no longer in the library (see Library → Deleted).')
    return
  }
  const lib = useLibrary.getState()
  lib.resetFilter()
  lib.setFilter({ search: s.name })
  lib.select(s.id)
  useApp.getState().setView('library')
}

export function revealInFinder(clip: Clip): void {
  void api.revealSample(clip.sample.relPath)
}
