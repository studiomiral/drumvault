import { useState } from 'react'
import { hitIdOf } from '../generate/disco'
import { STAB_ROLES, type Generation } from '../generate/generator'
import { loopJobs, loopParts, stabParts, type StabLayout, type StabTurns } from '../generate/stabs'
import { useApp } from '../store/app'
import { deleteStabRhythm, newChordStabs, saveStabRhythm, setTrackStabRhythm, useGenerate } from '../store/generate'
import { useHits } from '../store/hits'
import type { HitItem } from '../types/api'
import type { Velocity } from '../types/project'
import { HitRow } from './DiscoPanel'
import { Button, cx, inputClass } from './ui'

/** Where a track's stabs play, in words. */
export function stabsWhere(g: Generation): string {
  return g.rules.stabsIn === 'drops' ? 'in the drops only'
    : `in the drops, ${g.rules.stabsBreaks === 'filtered' ? 'low-passed' : 'not'} in breakdowns`
}

/**
 * Chord stabs (SCOPE.md §6.9) in the Chords module: which of the Chord Stabs page's samples this
 * track plays (one to three: one loop, layered or on its pickups, or taking turns in tracks from before), their pitch, the rhythm.
 */
export function StabsPart({ g }: { g: Generation }) {
  useGenerate((s) => s.history)  // re-render after a pitch change
  const all = useHits((s) => s.hits)
  const loaded = useHits((s) => s.loaded)
  const samples = all.filter((h) => h.kind === 'stab')
  const setView = useApp((s) => s.setView)
  const toast = useApp((s) => s.toast)
  // The track's stabs, in lane order.
  const used = STAB_ROLES.flatMap((role) => samples.filter((h) => h.id === hitIdOf(g.picks[role]?.id)))
  const rhythm = stabRhythmOf(g)
  // One loop (rule `stabLoop`): the stabs' jobs in it; else their turns.
  const jobs = g.rules.stabFit && g.rules.stabLoop && rhythm.length
    ? loopJobs([rhythm[0], rhythm[1 % rhythm.length]], used.length, (g.rules.stabLayout ?? 'stack') as StabLayout) : null
  const parts = jobs ? loopParts(rhythm, jobs) : stabParts(rhythm, used.length, (g.rules.stabTurns ?? 'hits') as StabTurns)
  const byBar = parts.length === 2 && !parts[0][1].some(Boolean) && !parts[1][0].some(Boolean)
  const where = stabsWhere(g) + (used.length < 2 ? ''
    : jobs ? `, ${[jobs.includes('layer') ? '1 and 2 layered as one stab' : null, jobs.includes('pickups') ? `${jobs.length} on the pickups` : null].filter(Boolean).join(', ')}`
      : `, ${used.length} stabs taking turns ${byBar ? 'bar by bar' : 'hit by hit'}`)
  const reroll = () => {
    if (!newChordStabs()) toast('info', 'No other chord stab came out: add more on the Chord Stabs page.')
  }
  const newButton = (
    <Button variant="secondary" onClick={reroll}
            title="Another stab and another rhythm for this track; the rest stays (⌘Z goes back)">
      New chord stabs
    </Button>
  )

  return (
    <>
      {!loaded ? <p className="text-muted text-[12.5px]">Loading chord stabs…</p>
        : !samples.length ? (
          <p className="text-muted text-[12.5px]">No chord stabs yet: drop organ, piano, synth and string stabs on the Chord Stabs page.{' '}
            <Button variant="ghost" onClick={() => setView('stabs')}>Open Chord Stabs</Button>
          </p>
        ) : !used.length ? (
          <div className="flex flex-wrap items-center gap-3 text-[12.5px]">
            {newButton}
            <span className="text-muted">This track has no chord stabs.</span>
          </div>
        ) : (
          <div className="space-y-2 text-[12.5px]">
            <div className="flex flex-wrap items-center gap-3">
              {newButton}
              <span className="text-[12px] text-muted">Plays {where}.</span>
            </div>
            {used.map((hit, i) => (
              <div key={hit.id} className="flex items-center gap-2">
                {used.length > 1 && <span className="w-4 text-center text-faint tabular-nums" title={`Stab ${i + 1}: the steps marked ${i + 1} below`}>{i + 1}</span>}
                <div className="flex-1 min-w-0"><HitRow hit={hit} g={g} color="#fcd34d" /></div>
              </div>
            ))}
            <p className="text-faint text-[11.5px]">
              A pitch you set is remembered for the stab sample: the next tracks play it the same way.
            </p>
            <StabSequencer g={g} owners={used.length > 1 ? parts : null} />
          </div>
        )}
    </>
  )
}

/** A track's stab rhythm (bars of 16 velocities). */
const stabRhythmOf = (g: Generation) => (g.rules.stabRhythm as Velocity[][] | undefined) ?? []

/** The names of a track's stabs. */
export function stabNames(g: Generation, hits: HitItem[]): string[] {
  return STAB_ROLES.flatMap((role) => hits.filter((h) => h.kind === 'stab' && h.id === hitIdOf(g.picks[role]?.id)).map((h) => h.name))
}

/**
 * The track's stab rhythm as a step sequencer (1 or 2 bars of 16ths): click a step to change the
 * track at once. Saved rhythms replace
 * the built-in ones: Generate takes one of them as it is for some tracks and learns from them for
 * the rest. Click a saved one to play it in this track.
 */
function StabSequencer({ g, owners }: { g: Generation; owners: Velocity[][][] | null }) {
  const saved = useApp((s) => s.settings?.stabs?.rhythms) ?? []
  const toast = useApp((s) => s.toast)
  const on = stabRhythmOf(g).map((b) => b.map((v) => (v ? 1 : 0)))
  /** Which stabs play a step (1, 2, 3; "12" when layered), when there are several. */
  const owner = (b: number, i: number) => (owners ? owners.map((p, k) => (p[b]?.[i] ? k + 1 : '')).join('') || null : null)
  /** A loop's moved hit (rule `stabMove`): the last of the loop or of every bar, in a bar of two hits or more. */
  const move = g.rules.stabLoop ? Number(g.rules.stabMove ?? 0) : 0
  const moved = (b: number, i: number) => {
    const loop = g.rules.stabMoveAt === 'loop' && on.length > 1
    if (!move || (loop && b === 0)) return false
    const hits = on[b].flatMap((v, j) => (v ? [j] : []))
    const all = hits.length + (loop ? on[0].filter(Boolean).length : 0)
    return all > 1 && hits[hits.length - 1] === i
  }
  const [name, setName] = useState('')
  if (!on.length) return null
  const play = (steps: number[][]) => setTrackStabRhythm(steps.map((b) => b.map((v) => (v ? 3 : 0)) as Velocity[]))
  const toggle = (bar: number, i: number) => play(on.map((b, k) => (k === bar ? b.map((v, j) => (j === i ? 1 - v : v)) : b)))
  const setBars = (n: 1 | 2) => n !== on.length && play(n === 1 ? [on[0]] : [on[0], [...on[0]]])
  const same = (a: number[][], b: number[][]) => JSON.stringify(a) === JSON.stringify(b)
  const perBar = Math.round((on.flat().filter(Boolean).length / on.length) * 10) / 10
  const current = saved.find((r) => same(r.steps, on))
  const save = async () => {
    const n = name.trim() || `Rhythm ${saved.length + 1}`
    await saveStabRhythm({ name: n, steps: on })
    setName('')
    toast('info', `Saved "${n}": ${saved.length ? '' : 'from now on '}new tracks learn their stab rhythm from your ${saved.length + (saved.some((r) => r.name === n) ? 0 : 1)} saved.`)
  }
  const seg = 'h-6 px-2 rounded-md text-[11.5px]'
  return (
    <div className="mt-3 pt-3 border-t border-line space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium mr-1">Rhythm</span>
        {([1, 2] as const).map((n) => (
          <button key={n} className={cx(seg, on.length === n ? 'bg-accent-soft text-accent' : 'bg-raised hover:bg-[#3a3b3f] text-muted')}
                  onClick={() => setBars(n)}>{n} bar{n === 1 ? '' : 's'}</button>
        ))}
        <span className="text-faint text-[11.5px]">
          {perBar} stab{perBar === 1 ? '' : 's'} a bar{on.length > 1 ? ' on average' : ''}
          {current ? ` · saved as "${current.name}"` : ''}
        </span>
      </div>
      <div className="flex gap-3">
        {on.map((bar, b) => (
          <div key={b} className="flex gap-[3px]">
            {bar.map((v, i) => (
              <button key={i} title={`Bar ${b + 1}, beat ${Math.floor(i / 4) + 1}${i % 4 ? `, 16th ${(i % 4) + 1}` : ''}${moved(b, i) ? `: moved ${move > 0 ? '+' : ''}${move} st` : ''}`}
                      className={cx('w-[18px] h-7 rounded-[4px] transition-colors text-[10px] font-semibold text-[#3a2f0b]', i % 4 === 0 && i > 0 && 'ml-1.5',
                        moved(b, i) && 'ring-2 ring-[#a78bfa] ring-inset',
                        v ? 'bg-[#fcd34d] hover:bg-[#fde68a]' : i % 4 === 0 ? 'bg-[#3a3b40] hover:bg-[#46474d]' : 'bg-raised hover:bg-[#3a3b3f]')}
                      onClick={() => toggle(b, i)}>
                {v ? owner(b, i) : null}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input className={cx(inputClass, 'w-44 h-7 text-[12px]')} placeholder={`Rhythm ${saved.length + 1}`} value={name}
               onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
        <Button variant="secondary" disabled={!on.flat().some(Boolean)} onClick={() => void save()}
                title="Save this rhythm: new tracks take saved rhythms as they are or learn from them (instead of the built-in ones)">
          Save rhythm
        </Button>
        {saved.length > 0 && <span className="text-faint text-[11.5px] ml-1">Saved:</span>}
        {saved.map((r) => (
          <span key={r.name} className={cx('h-6 pl-2 pr-1 rounded-md text-[11.5px] flex items-center gap-1',
            same(r.steps, on) ? 'bg-accent-soft text-accent' : 'bg-raised text-muted')}>
            <button className="hover:text-text" title="Play this rhythm in the track" onClick={() => play(r.steps)}>{r.name}</button>
            <button className="text-faint hover:text-bad px-0.5" title="Delete this saved rhythm"
                    onClick={() => window.confirm(`Delete the stab rhythm "${r.name}"?`) && void deleteStabRhythm(r.name)}>×</button>
          </span>
        ))}
      </div>
      <p className="text-faint text-[11.5px]">
        {saved.length ? `New tracks take one of your ${saved.length} saved rhythm${saved.length === 1 ? '' : 's'} as it is (about 1 in 3) or learn a new one from them.`
          : 'Built-in rhythms until you save your own: then new tracks take yours as they are (about 1 in 3) or learn new ones from them.'}
      </p>
    </div>
  )
}
