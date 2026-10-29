// Piano roll for a bass clip (SCOPE.md §6.7): edits apply to every clip of this bassline in the
// project; "Save as new bassline" adds the edited loop to the MIDI library.

import { useEffect, useState } from 'react'
import { api } from '../api'
import { playback } from '../audio/engine'
import { PianoRoll, type RollNote } from '../components/PianoRoll'
import { Button, cx, inputClass } from '../components/ui'
import { attempt, useApp } from '../store/app'
import { loadBass, useBass } from '../store/bass'
import { useProject } from '../store/project'
import type { AudioClip } from '../types/project'
import { editBassNotes, switchBassline } from './commands'
import { isGenerated, keyOfLine } from '../generate/bassline'

export function BassEditor({ clip, onClose }: { clip: AudioClip; onClose: () => void }) {
  const { basslines, loaded } = useBass()
  const clips = useProject((s) => s.project.clips)
  useEffect(() => {
    if (!loaded) void loadBass()
  }, [loaded])
  const b = clip.bass!
  const midi = basslines.find((m) => m.id === b.midiId)
  const source: RollNote[] = b.notes ?? midi?.notes ?? []
  const bars = b.bars ?? midi?.bars ?? clip.sample.bars ?? 1
  const shown = source.map(([s, l, p, v]) => [s, l, p + b.transpose, v] as RollNote)
  const same = clips.filter((c): c is AudioClip => c.type === 'audio' && c.bass?.midiId === b.midiId)
  // A tweak in Serum goes to every bass clip that plays this patch.
  const [name, setName] = useState(`${b.midiName} edit`)
  useEffect(() => setName(`${b.midiName} edit`), [b.midiName])

  /** Where the playhead is inside the loop, when it's in one of this bassline's clips. */
  const playhead = () => {
    if (!playback.playing) return null
    const pos = playback.position()
    const c = same.find((k) => pos >= k.start && pos < k.start + k.length)
    if (!c) return null
    const L = bars * 4
    return (((pos - c.start + c.trimBeats) % L) + L) % L
  }

  const save = async () => {
    const id = await attempt(() => api.saveMidi({ name: name.trim() || 'Bassline', notes: source, bars, keyLabel: midi?.key_label ?? keyOfLine(source) }))
    if (id == null) return
    await loadBass()
    switchBassline(b.midiId, { id, name: name.trim() || 'Bassline' })
    useApp.getState().toast('info', `Saved "${name.trim()}" to your basslines.`)
  }

  return (
    <div className="shrink-0 border-t border-line bg-panel px-4 py-3">
      <div className="flex items-center gap-3 mb-2 text-[12px]">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Bass notes</span>
        <span className="font-medium truncate max-w-[280px]">{b.midiName}</span>
        <span className="text-muted truncate">through {b.presetName}{b.transpose ? ` · ${b.transpose > 0 ? '+' : ''}${b.transpose} st` : ''}</span>
        <span className={cx('text-faint', b.notes && !isGenerated(b.midiId) && 'text-accent')}>
          {b.notes && !isGenerated(b.midiId) ? 'Edited · ' : ''}changes apply to {same.length === 1 ? 'this clip' : `all ${same.length} clips of this bassline`}
        </span>
        <div className="flex-1" />
        {b.notes && !isGenerated(b.midiId) && <Button variant="ghost" title="Back to the imported MIDI" onClick={() => editBassNotes(b.midiId, null, null)}>Revert</Button>}
        <input className={cx(inputClass, 'w-44 h-6 text-[12px]')} value={name} onChange={(e) => setName(e.target.value)} />
        <Button disabled={!source.length} onClick={() => void save()} title="Add this loop to your MIDI library as a new bassline">
          Save as new bassline
        </Button>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>
      {!midi && !b.notes ? <p className="text-faint text-[12px]">Loading the bassline…</p> : (
        <PianoRoll notes={shown} bars={bars} playhead={playhead}
                   onChange={(notes, nextBars) => editBassNotes(b.midiId, notes.map(([s, l, p, v]) => [s, l, p - b.transpose, v]), nextBars)} />
      )}
    </div>
  )
}
