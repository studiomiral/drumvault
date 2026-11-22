import { useEffect, useState } from 'react'
import { onBassRendering } from '../audio/tempo'
import type { Generation } from '../generate/generator'
import { useApp } from '../store/app'
import { pianoPatches, useBass } from '../store/bass'
import { rerollPiano, setChoice, setPianoOptions, useGenerate } from '../store/generate'
import type { BassSource } from '../generate/basspatch'
import { Module } from './Module'
import { Button, Segmented } from './ui'

/**
 * Piano (SCOPE.md §6.9a): a house track plays chord stabs or a piano part, the piano a quarter of
 * the time when it could play either. The part is written for the track from the Piano tab's MIDI:
 * a loop on the key (the bass as it is) or a progression (the bass follows its chords).
 */
export function PianoPanel({ g, fixed }: { g: Generation; fixed?: boolean }) {
  const opts = useGenerate((s) => s.settings.piano)
  const parts = useBass((s) => s.pianoParts.length)
  const patches = pianoPatches(opts.source).length
  const setView = useApp((s) => s.setView)
  const toast = useApp((s) => s.toast)
  const [rendering, setRendering] = useState(false)
  useEffect(() => onBassRendering(setRendering, 'piano'), [])
  const p = g.piano
  const missing = !parts ? 'No piano MIDI to learn from yet: add your piano loops on the Piano tab.'
    : !patches ? (opts.source === 'samples' ? 'No piano samples with a note yet: add one-shots on the Piano tab, or set Source to Serum.'
      : 'No piano patches yet: tick their Serum 2 folders on the Piano tab, or add one-shots there.') : null
  const what = p ? (p.kind === 'progression' ? `a progression, ${p.names.join(' – ')} (${p.midi.bars} bars)` : `a loop on ${p.names[0] ?? g.key ?? 'the key'}`) : ''
  const summary = !opts.enabled ? 'Off: G generates without piano'
    : missing ? missing.split(':')[0]
      : p ? <><span className="text-text">{p.preset.name}</span> · {what}</>
        : g.rules.keys === 'stabs' ? 'On: this track plays chord stabs (a quarter of house tracks get a piano)' : 'On: no piano in this track'
  const reroll = (w: 'part' | 'sound') => {
    if (!rerollPiano(w)) toast('info', w === 'sound' ? 'No other piano sound to play it with.' : 'No other piano part came out.')
  }

  return (
    <Module id="piano" title="Piano" fixed={fixed} enabled={opts.enabled} onEnabled={(enabled) => setPianoOptions({ enabled })}
            enabledTitle={opts.enabled ? 'On: a quarter of new house tracks play a piano part instead of chord stabs' : 'Off: new generations have no piano'}
            summary={summary}>
      {missing ? (
        <p className="text-muted text-[12.5px]">{missing}{' '}
          <Button variant="ghost" onClick={() => setView('piano')}>Open Piano</Button>
        </p>
      ) : (
        <div className="space-y-2.5 text-[12.5px]">
          <div className="flex flex-wrap items-center gap-3">
            {p ? (
              <>
                <Button variant="secondary" onClick={() => reroll('part')} title="Another piano part for this track (under a progression the bass follows it); ⌘Z goes back">New piano</Button>
                <Button variant="ghost" onClick={() => reroll('sound')} title="The same part through another patch or one-shot">New sound</Button>
                <span className="text-muted">
                  <span className="text-text">{p.preset.name}</span>: {what}{p.kind === 'progression' ? ', the bassline follows it' : ''}
                  {rendering && <span className="text-faint"> · rendering…</span>}
                </span>
              </>
            ) : g.rules.keys === 'stabs' ? (
              <Button variant="secondary" onClick={() => setChoice('keys', 'piano')} title="This track with a piano part instead of its chord stabs (⌘Z goes back)">Play piano instead of stabs</Button>
            ) : (
              <span className="text-muted">{g.key ? 'No piano in this track.' : 'This track has no key: a piano part needs one.'}</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-muted w-14">Source</span>
            <Segmented<BassSource> value={opts.source} onChange={(source) => setPianoOptions({ source })} options={[
              { value: 'both', label: 'Either' }, { value: 'serum', label: 'Serum' }, { value: 'samples', label: 'Samples' },
            ]} />
          </div>
          <p className="text-faint text-[11.5px]">
            Written for the track from your piano MIDI ({parts} part{parts === 1 ? '' : 's'}): a loop on the key, with the bassline as it is, or a
            progression, with the bassline following its chords and no pad. Whole in the drops, carrying the big breakdown, announcing the drops.
            Lock Chords or Piano in the track's choices to have every next track play it.
          </p>
        </div>
      )}
    </Module>
  )
}
