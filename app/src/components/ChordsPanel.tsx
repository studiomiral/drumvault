import { useEffect, useState } from 'react'
import { onBassRendering } from '../audio/tempo'
import type { Generation } from '../generate/generator'
import { useApp } from '../store/app'
import { keysInstead, newChordStabs, setChordsMode, useGenerate, type ChordsMode } from '../store/generate'
import { useHits } from '../store/hits'
import { useKeys } from '../store/keys'
import { useStabPresets } from '../store/stabs'
import { KeysPart, keysMissing, keysSummary } from './KeysPanel'
import { Module } from './Module'
import { stabNames, StabsPart, stabsWhere } from './StabsPanel'
import { Segmented } from './ui'

const MODES: { value: ChordsMode; label: string }[] = [
  { value: 'keys', label: 'Keys' }, { value: 'both', label: 'Keys or stabs' }, { value: 'stabs', label: 'Stabs' },
]

/**
 * Chords (SCOPE.md §6.7, §6.9): every track plays a keys part (MIDI through a Serum patch) or
 * chord stabs (a sample or a patch in a rhythm): which one this track plays, switched in place,
 * and what new tracks get.
 */
export function ChordsPanel({ g, fixed }: { g: Generation; fixed?: boolean }) {
  const keysOn = useGenerate((s) => s.settings.keys.enabled)
  const stabsOn = useGenerate((s) => s.settings.stabs.enabled)
  const keep = useGenerate((s) => s.keep)
  useGenerate((s) => s.history)  // re-render after a change
  const { parts, presets, error } = useKeys()
  const hits = useHits((s) => s.hits)
  const stabPatches = useStabPresets((s) => s.presets.length)
  const toast = useApp((s) => s.toast)
  const [keysRendering, setKeysRendering] = useState(false)
  const [stabsRendering, setStabsRendering] = useState(false)
  useEffect(() => onBassRendering(setKeysRendering, 'keys'), [])
  useEffect(() => onBassRendering(setStabsRendering, 'stab'), [])

  const plays = g.keys ? 'keys' : g.rules.stabs && g.picks.stab ? 'stabs' : null
  const mode: ChordsMode = keysOn && stabsOn ? 'both' : stabsOn ? 'stabs' : keysOn ? 'keys' : 'off'
  const stabPool = hits.filter((h) => h.kind === 'stab').length + stabPatches
  const switchTo = (to: 'keys' | 'stabs') => {
    if (to === plays) return
    if (to === 'keys' ? keysInstead() : newChordStabs()) return
    toast('info', to === 'keys' ? keysMissing(parts.length, presets.length) ?? 'No keys part came out.'
      : stabPool ? 'No chord stab came out.' : 'No chord stabs yet: add samples or patches on the Chord Stabs page.')
  }
  const kept = plays === 'keys' ? keep.keysPart && keep.keysPatch : keep.lanes.includes('stab')
  const summary = mode === 'off' ? 'Off: G generates without keys or stabs'
    : <>
        {plays === 'keys' ? <><span className="text-text">Keys</span> · {keysSummary(g)}</>
          : plays === 'stabs' ? <><span className="text-text">Stabs</span> · {stabNames(g, hits).join(', ')} · {stabsWhere(g)}</>
            : 'No chords in this track'}
        {kept && <span className="text-accent"> · kept</span>}
      </>

  return (
    <Module id="chords" title="Chords" fixed={fixed} enabled={mode !== 'off'} onEnabled={(on) => setChordsMode(on ? 'both' : 'off')}
            enabledTitle={mode !== 'off' ? 'On: G writes keys or chord stabs for every new generation' : 'Off: new generations have no keys or stabs'}
            summary={summary}
            status={<>
              {(keysRendering || stabsRendering) && <span className="text-[11.5px] text-accent">Rendering with Serum 2…</span>}
              {error && <span className="text-[11.5px] text-bad" title={error}>Engine: {error.slice(0, 80)}</span>}
            </>}>
      <div className="grid grid-cols-[86px_1fr] gap-y-2 items-center text-[12.5px] mb-3">
        <span className="text-muted">This track</span>
        <span className="flex flex-wrap items-center gap-2">
          <Segmented<string> value={plays ?? ''} onChange={(v) => switchTo(v as 'keys' | 'stabs')}
                             options={[{ value: 'keys', label: 'Keys' }, { value: 'stabs', label: 'Chord stabs' }]} />
          <span className="text-faint text-[11.5px]">the rest of the track stays (← goes back)</span>
        </span>
        <span className="text-muted">New tracks</span>
        <span className="flex flex-wrap items-center gap-2">
          <Segmented<ChordsMode> value={mode === 'off' ? 'both' : mode} options={MODES} onChange={setChordsMode} />
          <span className="text-faint text-[11.5px]">{mode === 'both' ? 'about 2 in 3 play stabs' : mode === 'off' ? 'off' : ''}</span>
        </span>
      </div>
      <div className="pt-3 border-t border-line">
        {plays === 'keys' ? <KeysPart g={g} /> : plays === 'stabs' ? <StabsPart g={g} />
          : <p className="text-muted text-[12.5px]">This track plays no chords: pick Keys or Chord stabs above.</p>}
      </div>
    </Module>
  )
}
