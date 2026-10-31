import { useEffect, useState } from 'react'
import { audition } from '../audio/audition'
import { choicesOfRole, optionKey, type Choice } from '../generate/choices'
import { laneRole, type Generation, type Role } from '../generate/generator'
import { useApp } from '../store/app'
import type { Panel } from '../store/arrange'
import { laneKept, LOCKABLE, newSound, rerollLane, setChoice, toggleLaneKeep, toggleLock, useGenerate } from '../store/generate'
import { BassPanel } from './BassPanel'
import { ChordsPanel } from './ChordsPanel'
import { DiscoPanel } from './DiscoPanel'
import { IconLock, IconPlay, IconShuffle, IconSparkle, IconStop } from './icons'
import { VerbPanel } from './VerbPanel'
import { cx } from './ui'


/** The lanes a module plays on. */
const MODULE_LANES: Record<string, (g: Generation) => string[]> = {
  bass: () => ['Bass'],
  chords: (g) => (g.keys ? ['Keys'] : ['Stab']),
  disco: () => ['Disco Hit', 'Disco Hit 2'],
  verb: () => [],
}

const PILLS: { module: 'bass' | 'chords' | 'disco' | 'verb'; label: string }[] = [
  { module: 'bass', label: 'Bass' }, { module: 'chords', label: 'Chords' }, { module: 'disco', label: 'Disco Hits' }, { module: 'verb', label: 'Reverb' },
]

/**
 * The lane panel (SCOPE.md §6.6): the modules of the track (Bass, Chords, Disco Hits, Reverb
 * builds), one at a time, or a lane's sounds and the choices that shape it. Each lane on it can
 * get a new sound where it plays, be made again, and (in Generate) be kept for the next track.
 * In Generate it acts on the generation on screen, in Arrange on the open project.
 */
export function LanePanel({ g, panel, onPanel, where }: {
  g: Generation
  panel: Panel
  onPanel: (p: Panel) => void
  where: 'generate' | 'arrange'
}) {
  const lanes = 'lane' in panel ? [panel.lane] : MODULE_LANES[panel.module](g)
  const shown = lanes.filter((name) => g.project.lanes.some((l) => l.name === name))
  const role = 'lane' in panel ? laneRole(panel.lane) : null
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {PILLS.filter((p) => where === 'generate' || p.module !== 'verb').map((p) => (
          <button key={p.module} onClick={() => onPanel({ module: p.module })}
                  className={cx('h-7 px-2.5 rounded-lg text-[12px] transition-colors',
                    'module' in panel && panel.module === p.module ? 'bg-accent-soft text-accent' : 'bg-raised text-muted hover:text-text')}>
            {p.label}
          </button>
        ))}
        {'lane' in panel && <span className="h-7 px-2.5 rounded-lg text-[12px] bg-accent-soft text-accent inline-flex items-center">{panel.lane}</span>}
      </div>
      {shown.map((name) => <LaneBar key={name} g={g} laneName={name} where={where} />)}
      {'module' in panel && panel.module === 'bass' && <BassPanel g={g} fixed />}
      {'module' in panel && panel.module === 'chords' && <ChordsPanel g={g} fixed />}
      {'module' in panel && panel.module === 'disco' && <DiscoPanel g={g} fixed />}
      {'module' in panel && panel.module === 'verb' && <VerbPanel fixed />}
      {'lane' in panel && !shown.length && <p className="text-muted text-[12.5px]">This track has no {panel.lane} lane.</p>}
      {'lane' in panel && shown.length > 0 && <Sounds g={g} laneName={panel.lane} />}
      <LaneChoices g={g} roles={'lane' in panel ? (role ? [role] : []) : lanes.map((n) => laneRole(n)).filter((r): r is Role => !!r)}
                   lockable={where === 'generate'} />
    </div>
  )
}

/** A lane's name and its buttons: keep for the next track (Generate), a new sound where it plays, made again. */
function LaneBar({ g, laneName, where }: { g: Generation; laneName: string; where: 'generate' | 'arrange' }) {
  const lane = g.project.lanes.find((l) => l.name === laneName)!
  const role = laneRole(laneName)
  const keep = useGenerate((s) => s.keep)
  const toast = useApp((s) => s.toast)
  const kept = role && laneKept(role, keep)
  const btn = 'h-7 px-2 rounded-md bg-raised hover:bg-[#3a3b3f] text-[12px] inline-flex items-center gap-1.5'
  const rendered = role === 'bass' || role === 'keys'
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-3 h-11 flex items-center gap-2">
      <span className="w-2 h-5 rounded-full shrink-0" style={{ background: lane.color }} />
      <span className="font-medium text-[12.5px] truncate">{laneName}</span>
      <span className="flex-1" />
      {where === 'generate' && role && LOCKABLE.includes(role) && (
        <button className={cx(btn, kept && 'bg-accent/15 text-accent')} onClick={() => toggleLaneKeep(role)}
                title={kept ? 'Kept: the next press of G keeps this lane' : 'Keep this lane on the next press of G'}>
          <IconLock className="w-3.5 h-3.5" open={!kept} />{kept ? 'Kept' : 'Keep'}
        </button>
      )}
      <button className={btn} onClick={() => !newSound(lane.id) && toast('info', `No other sound for ${laneName} in the library.`)}
              title={rendered ? 'Another patch for the same part' : 'Other sounds of the same kind, where the lane plays now: its clips stay'}>
        <IconShuffle className="w-3.5 h-3.5" />New sound
      </button>
      <button className={btn} onClick={() => !rerollLane(lane.id) && toast('info', `Nothing new came out for ${laneName}.`)}
              title={where === 'arrange' ? 'Write the lane again as Generate would: a new sound and where it plays (your edits on this lane are replaced; ⌘Z undoes)'
                : 'Write the lane again: a new sound and where it plays; the rest stays (← goes back)'}>
        <IconSparkle className="w-3.5 h-3.5 text-accent" />Remake
      </button>
    </div>
  )
}

/** The samples on a lane, to play. */
function Sounds({ g, laneName }: { g: Generation; laneName: string }) {
  const [playing, setPlaying] = useState<number | null>(audition.playingId)
  useEffect(() => audition.subscribe(setPlaying), [])
  const lane = g.project.lanes.find((l) => l.name === laneName)
  const clips = g.project.clips.filter((c) => c.laneId === lane?.id)
  const sounds = [...new Map(clips.map((c) => [c.sample.relPath, c])).values()]
  const source = (relPath: string) => Object.values(g.picks).find((s) => s?.rel_path === relPath)?.source_code ?? relPath.split('/')[0]
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-4 py-3 space-y-2">
      {sounds.map((c) => {
        const n = clips.filter((x) => x.sample.relPath === c.sample.relPath).length
        const id = c.sample.id ?? 0
        return (
          <div key={c.sample.relPath} className="flex items-center gap-3 text-[12.5px]">
            <button className="w-7 h-7 rounded-full bg-raised hover:bg-[#3a3b3f] flex items-center justify-center text-accent shrink-0" title="Play"
                    onClick={() => audition.toggle({ id, rel_path: c.sample.relPath, kind: c.sample.kind })}>
              {playing === id ? <IconStop className="w-3.5 h-3.5" /> : <IconPlay className="w-3.5 h-3.5" />}
            </button>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{c.sample.name}</span>
              <span className="block truncate text-faint text-[11.5px]">{source(c.sample.relPath)} · {c.sample.kind === 'oneshot' ? 'one-shot' : c.sample.kind} · {n} clip{n === 1 ? '' : 's'}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** The choices that shape these lanes (not the track-wide ones: those are in Choices). */
function LaneChoices({ g, roles, lockable }: { g: Generation; roles: Role[]; lockable: boolean }) {
  const list = [...new Set(roles.flatMap(choicesOfRole))].filter((c) => c.roles.length <= 5 && (!c.when || c.when(g)))
  if (!list.length) return null
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-faint mb-2">Choices</div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1.5 items-center">
        {list.map((c) => <ChoiceRow key={c.rule} c={c} g={g} lockable={lockable} prefix />)}
      </div>
    </div>
  )
}

/**
 * One choice of the track: its value as a menu (changing it makes the lanes it shapes again) and,
 * in Generate, a lock that keeps it for every next track.
 */
export function ChoiceRow({ c, g, lockable, prefix }: { c: Choice; g: Generation; lockable: boolean; prefix?: boolean }) {
  const locks = useGenerate((s) => s.settings.locks)
  const value = g.rules[c.rule] ?? null
  const options = c.options.some((o) => optionKey(o.value) === optionKey(value)) ? c.options : [...c.options, { value, label: String(value) }]
  const locked = c.rule in locks
  return (
    <>
      <label className="flex items-center gap-2 min-w-0 text-[12.5px]">
        <span className="text-muted shrink-0">{prefix && c.group !== 'Sound' && c.group !== 'Every 8 and 16 bars' ? `${c.group}: ` : ''}{c.label}</span>
        <select className="min-w-0 flex-1 h-7 rounded-lg bg-[rgb(0_0_0/0.25)] px-2 text-text text-[12px] outline-none shadow-[0_0_0_1px_rgb(255_255_255/0.08)]"
                value={optionKey(value)} onChange={(e) => setChoice(c.rule, JSON.parse(e.target.value))}>
          {options.map((o) => <option key={optionKey(o.value)} value={optionKey(o.value)}>{o.label}</option>)}
        </select>
      </label>
      {lockable ? (
        <button onClick={() => toggleLock(c.rule)}
                title={locked ? 'Locked: every next track does this (click to free it)' : 'Lock: every next track does this'}
                className={cx('w-7 h-7 rounded-md flex items-center justify-center', locked ? 'bg-accent/15 text-accent' : 'text-faint hover:text-text hover:bg-raised')}>
          <IconLock className="w-3.5 h-3.5" open={!locked} />
        </button>
      ) : <span />}
    </>
  )
}
