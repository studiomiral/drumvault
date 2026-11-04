import type { Generation } from '../generate/generator'
import { setStabOptions, useGenerate } from '../store/generate'
import { useHits } from '../store/hits'
import { Module } from './Module'
import { stabNames, StabsPart, stabsWhere } from './StabsPanel'

/**
 * Chords (SCOPE.md §6.9): every track plays chord stabs, one of the Chord Stabs page's samples in
 * a rhythm; on or off for new tracks.
 */
export function ChordsPanel({ g, fixed }: { g: Generation; fixed?: boolean }) {
  const on = useGenerate((s) => s.settings.stabs.enabled)
  const keep = useGenerate((s) => s.keep)
  useGenerate((s) => s.history)  // re-render after a change
  const hits = useHits((s) => s.hits)

  const plays = !!(g.rules.stabs && g.picks.stab)
  const summary = !on ? 'Off: G generates without chord stabs'
    : <>
        {plays ? <><span className="text-text">Stabs</span> · {stabNames(g, hits).join(', ')} · {stabsWhere(g)}</> : 'No chord stabs in this track'}
        {plays && keep.lanes.includes('stab') && <span className="text-accent"> · kept</span>}
      </>

  return (
    <Module id="chords" title="Chords" fixed={fixed} enabled={on} onEnabled={(enabled) => setStabOptions({ enabled })}
            enabledTitle={on ? 'On: G writes chord stabs for every new generation' : 'Off: new generations have no chord stabs'}
            summary={summary}>
      <StabsPart g={g} />
    </Module>
  )
}
