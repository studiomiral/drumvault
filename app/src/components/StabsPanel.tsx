import { useState } from 'react'
import { hitIdOf } from '../generate/disco'
import { STAB_ROLES, type Generation } from '../generate/generator'
import { stabOneKey, stabPresetId } from '../generate/stabs'
import { useApp } from '../store/app'
import {
  deleteStabRhythm, newChordStabs, saveStabRhythm, setStabChord, setTrackStabRhythm, shiftStabOctave, useGenerate,
} from '../store/generate'
import { useHits } from '../store/hits'
import { playsChord, useStabPresets } from '../store/stabs'
import type { HitItem, SerumPreset } from '../types/api'
import type { AudioClip, Velocity } from '../types/project'
import { HitRow } from './DiscoPanel'
import { PatchOctave } from './PatchOctave'
import { Button, cx, inputClass } from './ui'

/** Where a track's stabs play, in words. */
export function stabsWhere(g: Generation): string {
  return g.rules.stabsIn === 'drops' ? 'in the drops only'
    : `in the drops, ${g.rules.stabsBreaks === 'filtered' ? 'low-passed' : 'not'} in breakdowns`
}

/**
 * Chord stabs (SCOPE.md §6.9) in the Chords module: which stab this track plays instead of the
 * keys (a sample of the Chord Stabs page or a Serum patch), its pitch or octave, its rhythm.
 */
export function StabsPart({ g }: { g: Generation }) {
  useGenerate((s) => s.history)  // re-render after a pitch change
  const all = useHits((s) => s.hits)
  const loaded = useHits((s) => s.loaded)
  const samples = all.filter((h) => h.kind === 'stab')
  const presets = useStabPresets((s) => s.presets)
  const pool = samples.length + presets.length
  const setView = useApp((s) => s.setView)
  const toast = useApp((s) => s.toast)
  // The track's stabs, in lane order: a sample of the Chord Stabs page, or a Serum patch.
  const used = STAB_ROLES.flatMap((role): ({ hit: HitItem } | { preset: Pick<SerumPreset, 'path' | 'name'> })[] => {
    const id = g.picks[role]?.id
    const hit = samples.find((h) => h.id === hitIdOf(id))
    if (hit) return [{ hit }]
    const clip = g.project.clips.find((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'stab' && stabPresetId(c.bass.preset) === id)
    return clip ? [{ preset: { path: clip.bass!.preset, name: clip.bass!.presetName } }] : []
  })
  const where = stabsWhere(g)
  const reroll = () => {
    if (!newChordStabs()) toast('info', 'No other chord stab came out: add more on the Chord Stabs page.')
  }
  const newButton = (
    <Button variant="secondary" onClick={reroll}
            title="Another stab and another rhythm for this track; the rest stays (← goes back)">
      New chord stabs
    </Button>
  )

  return (
    <>
      {!loaded ? <p className="text-muted text-[12.5px]">Loading chord stabs…</p>
        : !pool ? (
          <p className="text-muted text-[12.5px]">No chord stabs yet: drop organ, piano and synth stabs on the Chord Stabs page, or tick
            stab patch folders there.{' '}
            <Button variant="ghost" onClick={() => setView('stabs')}>Open Chord Stabs</Button>
          </p>
        ) : !used.length ? (
          <p className="text-[12.5px] text-muted">This track has no chord stabs.</p>
        ) : (
          <div className="space-y-2 text-[12.5px]">
            <div className="flex flex-wrap items-center gap-3">
              {newButton}
              <span className="text-[12px] text-muted">Plays {where}.</span>
            </div>
            {used.map((u) => ('hit' in u ? <HitRow key={u.hit.id} hit={u.hit} g={g} color="#fcd34d" />
              : <PresetRow key={u.preset.path} preset={u.preset} g={g} />))}
            <p className="text-faint text-[11.5px]">
              A pitch you set is remembered for the stab sample, an octave for the patch: the next tracks play it the same way.
            </p>
            <StabSequencer g={g} />
          </div>
        )}
    </>
  )
}

/** The names of a track's stabs (sample or patch). */
export function stabNames(g: Generation, hits: HitItem[]): string[] {
  return STAB_ROLES.flatMap((role) => {
    const id = g.picks[role]?.id
    const hit = hits.find((h) => h.kind === 'stab' && h.id === hitIdOf(id))
    if (hit) return [hit.name]
    const clip = g.project.clips.find((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'stab' && stabPresetId(c.bass.preset) === id)
    return clip ? [clip.bass!.presetName] : []
  })
}

/** A Serum patch playing stabs: the track key's seventh chord rendered through it, and its octave (saved on the patch). */
function PresetRow({ preset, g }: { preset: Pick<SerumPreset, 'path' | 'name'>; g: Generation }) {
  const clip = g.project.clips.find((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'stab' && c.bass.preset === preset.path)
  const t = clip?.bass?.transpose ?? 0
  useApp((s) => s.settings?.stabs?.chords)  // re-render when set
  useStabPresets((s) => s.measured)          // … or measured
  // What this track's part plays (the patch's setting may have been measured since it was made).
  const st = clip?.bass?.stab ?? (clip?.bass?.notes ? { oneKey: stabOneKey(clip.bass.notes) } : { oneKey: playsChord(preset) })
  const oneKey = !!st.oneKey
  const key = g.key ?? 'the key'
  const what = st.voicing ? `its own chord (from the preset's clip), from ${key}'s root, on your steps`
    : oneKey ? `${key}'s root: the patch stacks its own chord`
      : `${key}'s ${/m$/.test(g.key ?? 'm') ? 'minor' : 'major'} 7th chord`
  const btn = 'h-7 min-w-7 px-2 rounded-md bg-raised hover:bg-[#3a3b3f] text-[12px] disabled:opacity-40'
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)_auto] gap-3 items-center">
      <span className="w-7 h-7 rounded-full bg-raised flex items-center justify-center text-[10px] text-accent shrink-0" title="Serum 2 patch">S2</span>
      <span className="min-w-0">
        <span className="block truncate font-medium">{preset.name}<PatchOctave role="stabs" path={preset.path} /></span>
        <span className="block truncate text-faint text-[11.5px]">
          Serum patch · {what}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <label className="flex items-center gap-1.5 text-[12px] text-muted mr-2 cursor-pointer"
               title="On: the patch stacks a chord from one key, so it gets the root alone. Off: its own chord from the preset's clip, else the key's seventh chord. Remembered for the patch.">
          <input type="checkbox" className="accent-[#e2c35f]" checked={oneKey} onChange={(e) => void setStabChord(preset, e.target.checked)} />
          chord from one key
        </label>
        <button className={btn} disabled={t <= -24} title="An octave down (remembered for the patch)" onClick={() => void shiftStabOctave(preset.path, -12)}>−12</button>
        <button className={btn} disabled={t >= 24} title="An octave up (remembered for the patch)" onClick={() => void shiftStabOctave(preset.path, 12)}>+12</button>
      </span>
    </div>
  )
}

/**
 * The track's stab rhythm as a step sequencer (1 or 2 bars of 16ths): click a step to change the
 * track at once (when the sample plays, or when the patch gets its chord). Saved rhythms replace
 * the built-in ones: Generate takes one of them as it is for some tracks and learns from them for
 * the rest. Click a saved one to play it in this track.
 */
function StabSequencer({ g }: { g: Generation }) {
  const saved = useApp((s) => s.settings?.stabs?.rhythms) ?? []
  const toast = useApp((s) => s.toast)
  const on = ((g.rules.stabRhythm as number[][] | undefined) ?? []).map((b) => b.map((v) => (v ? 1 : 0)))
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
              <button key={i} title={`Bar ${b + 1}, beat ${Math.floor(i / 4) + 1}${i % 4 ? `, 16th ${(i % 4) + 1}` : ''}`}
                      className={cx('w-[18px] h-7 rounded-[4px] transition-colors', i % 4 === 0 && i > 0 && 'ml-1.5',
                        v ? 'bg-[#fcd34d] hover:bg-[#fde68a]' : i % 4 === 0 ? 'bg-[#3a3b40] hover:bg-[#46474d]' : 'bg-raised hover:bg-[#3a3b3f]')}
                      onClick={() => toggle(b, i)} />
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
