import { useEffect, useState } from 'react'
import { audition } from '../audio/audition'
import { choicesOfRole, choiceValue, optionKey, type Choice } from '../generate/choices'
import { laneRole, type Generation, type Role } from '../generate/generator'
import { useApp } from '../store/app'
import type { Panel } from '../store/arrange'
import { useProject } from '../store/project'
import { TrackPanel } from '../create/TrackPanel'
import { compSummary } from '../generate/comp'
import { eqSummary } from '../generate/eq'
import { newSound, rerollLane, setBassOptions, setChoice, setDiscoOptions, setStabOptions, setAmbienceOptions, setMusicLoopOptions, setPadsOptions, setPianoOptions, setStringsOptions, setVerbOptions, setVocalLoopOptions, toggleDrumBus, toggleLaneComp, toggleLaneEq, toggleLock, useGenerate } from '../store/generate'
import { BassPanel } from './BassPanel'
import { ChordsPanel } from './ChordsPanel'
import { DiscoPanel } from './DiscoPanel'
import { StringsPanel } from './StringsPanel'
import { PadsPanel } from './PadsPanel'
import { PianoPanel } from './PianoPanel'
import { MusicLoopsPanel } from './MusicLoopsPanel'
import { AmbiencePanel } from './AmbiencePanel'
import { VocalLoopsPanel } from './VocalLoopsPanel'
import { VocalPanel } from './VocalPanel'
import { ELEVENLABS } from '../vocals/plan'
import { IconLock, IconPlay, IconShuffle, IconSparkle, IconStop } from './icons'
import { VerbPanel } from './VerbPanel'
import { cx, Toggle } from './ui'


/** The lanes a module plays on. */
const MODULE_LANES: Record<string, (g: Generation) => string[]> = {
  track: () => [],
  bass: () => ['Bass'],
  chords: () => ['Stab', 'Stab 2', 'Stab 3'],
  piano: () => ['Piano'],
  musicloops: () => ['Music Loop'],
  strings: () => ['Strings'],
  pads: () => ['Pad'],
  ambience: () => ['Ambience'],
  vocals: () => ['Vocal', 'Vocal Chops'],
  vocalloops: () => ['Vocal', 'Vocal Chops'],
  disco: () => ['Drop Hit', 'Drop Hit 2'],
  verb: () => [],
}

type ModuleId = 'track' | 'bass' | 'chords' | 'piano' | 'musicloops' | 'vocals' | 'vocalloops' | 'strings' | 'pads' | 'ambience' | 'disco' | 'verb'

/** The side panel's pills: the track, then the modules (with a switch: whether G writes it into new tracks). */
const PILLS: { module: ModuleId; label: string; on?: string; off?: string }[] = [
  { module: 'track', label: 'Track' },
  { module: 'bass', label: 'Bass', on: 'On: G writes a bass for every new generation', off: 'Off: new generations have no bass' },
  { module: 'chords', label: 'Chords', on: 'On: G writes chord stabs for every new generation', off: 'Off: new generations have no chord stabs' },
  { module: 'piano', label: 'Piano', on: 'On: a quarter of new house tracks play a piano part instead of chord stabs', off: 'Off: new generations have no piano' },
  { module: 'musicloops', label: 'Music Loops', on: 'On: a third of new house tracks without a piano play a music loop instead of chord stabs', off: 'Off: new generations play no music loop' },
  ...(ELEVENLABS ? [{ module: 'vocals' as const, label: 'Vocals' }] : []),
  { module: 'vocalloops', label: ELEVENLABS ? 'Vocal Loops' : 'Vocals', on: 'On: some new generations sing a Splice vocal loop that fits', off: 'Off: new generations sing no Splice vocal loop' },
  { module: 'strings', label: 'Strings', on: 'On: some new generations play strings under the track', off: 'Off: new generations have no strings' },
  { module: 'pads', label: 'Pads', on: 'On: new generations may get a pad or a reese in their breakdowns', off: 'Off: new generations have no breakdown layer' },
  { module: 'ambience', label: 'Ambience', on: 'On: most new generations get a very quiet texture under them', off: 'Off: new generations have no ambience bed' },
  { module: 'disco', label: 'Drop Hits', on: 'On: some new generations get one or two drop hits', off: 'Off: new generations have no drop hits' },
  { module: 'verb', label: 'Reverb', on: 'On: new generations get reverb builds', off: 'Off: new generations have no reverb builds' },
]

/** Whether G writes each module into new generations (the pills' switches). */
function useModulesOn(): Partial<Record<ModuleId, boolean>> {
  const s = useGenerate((x) => x.settings)
  return { bass: s.bass.enabled, chords: s.stabs.enabled, piano: s.piano.enabled, musicloops: s.musicLoops.enabled, strings: s.strings.enabled, pads: s.pads.enabled, ambience: s.ambience.enabled, vocalloops: s.vocalLoops.enabled, disco: s.disco.enabled, verb: s.verb.enabled }
}

function setModuleOn(module: ModuleId, on: boolean): void {
  if (module === 'track' || module === 'vocals') return
  if (module === 'bass') setBassOptions({ enabled: on })
  else if (module === 'chords') setStabOptions({ enabled: on })
  else if (module === 'piano') setPianoOptions({ enabled: on })
  else if (module === 'musicloops') setMusicLoopOptions({ enabled: on })
  else if (module === 'strings') setStringsOptions({ enabled: on })
  else if (module === 'pads') setPadsOptions({ enabled: on })
  else if (module === 'ambience') setAmbienceOptions({ enabled: on })
  else if (module === 'vocalloops') setVocalLoopOptions({ enabled: on })
  else if (module === 'disco') setDiscoOptions({ enabled: on })
  else setVerbOptions({ enabled: on })
}

/**
 * Before a change that writes lanes again on a track that's kept (edited by hand, or saved): edits
 * on those lanes are replaced. A scratch track just changes (⌘Z undoes either way).
 */
export function confirmRemake(what: string): boolean {
  if (useProject.getState().scratch) return true
  return window.confirm(`This makes ${what} again: your own edits there are replaced (⌘Z undoes). Go on?`)
}

/**
 * Create's side panel (SCOPE.md §6.6): the track (key, structure, choices), the modules of the
 * track (Bass, Chords, Vocals, Strings, Drop Hits, Reverb builds), one at a time, or a lane's
 * sounds and the choices that shape it. Each lane on it can get a new sound where it plays, or be
 * made again. Every change is an edit of the track (⌘Z).
 */
export function LanePanel({ g, panel, onPanel }: {
  g: Generation
  panel: Panel
  onPanel: (p: Panel) => void
}) {
  const lanes = 'lane' in panel ? [panel.lane] : MODULE_LANES[panel.module](g)
  const shown = lanes.filter((name) => g.project.lanes.some((l) => l.name === name))
  const role = 'lane' in panel ? laneRole(panel.lane) : null
  const modulesOn = useModulesOn()
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {PILLS.map((p) => {
          const open = 'module' in panel && panel.module === p.module
          const switched = !!p.on
          return (
            <span key={p.module} className={cx('h-7 rounded-lg inline-flex items-center transition-colors',
              open ? 'bg-accent-soft' : 'bg-raised', switched && 'pl-2')}>
              {/* Whether G writes it into new tracks (the track on screen keeps its own). */}
              {switched && (
                <Toggle checked={!!modulesOn[p.module]} onChange={(on) => setModuleOn(p.module, on)}
                        label={`${p.label} in new generations`} title={modulesOn[p.module] ? p.on : p.off} />
              )}
              <button onClick={() => onPanel({ module: p.module })}
                      className={cx('h-7 px-2.5 text-[12px]', open ? 'text-accent' : modulesOn[p.module] || !switched ? 'text-muted hover:text-text' : 'text-faint hover:text-text')}>
                {p.label}
              </button>
            </span>
          )
        })}
        {'lane' in panel && <span className="h-7 px-2.5 rounded-lg text-[12px] bg-accent-soft text-accent inline-flex items-center">{panel.lane}</span>}
      </div>
      {shown.map((name) => <LaneBar key={name} g={g} laneName={name} />)}
      {'module' in panel && panel.module === 'track' && <TrackPanel g={g} />}
      {'module' in panel && panel.module === 'bass' && <BassPanel g={g} fixed />}
      {'module' in panel && panel.module === 'chords' && <ChordsPanel g={g} fixed />}
      {'module' in panel && panel.module === 'piano' && <PianoPanel g={g} fixed />}
      {'module' in panel && panel.module === 'musicloops' && <MusicLoopsPanel g={g} fixed />}
      {'module' in panel && panel.module === 'vocals' && ELEVENLABS && <VocalPanel g={g} fixed />}
      {'module' in panel && (panel.module === 'vocalloops' || (panel.module === 'vocals' && !ELEVENLABS)) && <VocalLoopsPanel g={g} fixed />}
      {'module' in panel && panel.module === 'strings' && <StringsPanel g={g} fixed />}
      {'module' in panel && panel.module === 'pads' && <PadsPanel g={g} fixed />}
      {'module' in panel && panel.module === 'ambience' && <AmbiencePanel g={g} fixed />}
      {'module' in panel && panel.module === 'disco' && <DiscoPanel g={g} fixed />}
      {'module' in panel && panel.module === 'verb' && <VerbPanel fixed />}
      {'lane' in panel && !shown.length && <p className="text-muted text-[12.5px]">This track has no {panel.lane} lane.</p>}
      {'lane' in panel && shown.length > 0 && <Sounds g={g} laneName={panel.lane} />}
      <LaneChoices g={g} roles={'lane' in panel ? (role ? [role] : []) : lanes.map((n) => laneRole(n)).filter((r): r is Role => !!r)} />
    </div>
  )
}

/** A lane's name and its buttons: a new sound where it plays, made again. */
function LaneBar({ g, laneName }: { g: Generation; laneName: string }) {
  const lane = g.project.lanes.find((l) => l.name === laneName)!
  const drumBus = g.project.drumBus
  const role = laneRole(laneName)
  const toast = useApp((s) => s.toast)
  const btn = 'h-7 px-2 rounded-md bg-raised hover:bg-[#3a3b3f] text-[12px] inline-flex items-center gap-1.5'
  const rendered = role === 'bass'
  // A track's vocal is its own take (made for it): no other sound for it, and Remake sings it another way.
  const sung = role === 'vocal' || role === 'vchop'
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-3 h-11 flex items-center gap-2">
      <span className="w-2 h-5 rounded-full shrink-0" style={{ background: lane.color }} />
      <span className="font-medium text-[12.5px] truncate">{laneName}</span>
      <span className="flex-1" />
      {lane.eq && (
        <button className={cx(btn, !lane.eq.off && 'text-accent')} onClick={() => toggleLaneEq(lane.id)}
                title={`EQ ${lane.eq.off ? 'off' : 'on'}: ${eqSummary(lane.eq.bands)}${lane.eq.gainDb ? `, makeup ${lane.eq.gainDb > 0 ? '+' : ''}${lane.eq.gainDb} dB` : ''} (in the stems; click: ${lane.eq.off ? 'on' : 'off'})`}>
          EQ
        </button>
      )}
      {lane.comp && (
        <button className={cx(btn, !lane.comp.off && 'text-accent')} onClick={() => toggleLaneComp(lane.id)}
                title={`Compressor ${lane.comp.off ? 'off' : 'on'}: ${compSummary(lane.comp, role)}, makeup +${lane.comp.makeupDb} dB (in the stems; click: ${lane.comp.off ? 'on' : 'off'})`}>
          Comp
        </button>
      )}
      {lane.bus && drumBus && (
        <button className={cx(btn, !drumBus.off && 'text-accent')} onClick={() => toggleDrumBus()}
                title={`Drum bus ${drumBus.off ? 'off' : 'on'}: the drum lanes glued together, ${compSummary(drumBus)}, makeup +${drumBus.makeupDb} dB; each drum stem carries its share (click: ${drumBus.off ? 'on' : 'off'}, for every drum lane)`}>
          Bus
        </button>
      )}
      {!sung && (
        <button className={btn} onClick={() => !newSound(lane.id) && toast('info', `No other sound for ${laneName} in the library.`)}
                title={rendered ? 'Another patch for the same part' : 'Other sounds of the same kind, where the lane plays now: its clips stay'}>
          <IconShuffle className="w-3.5 h-3.5" />New sound
        </button>
      )}
      <button className={btn} onClick={() => !rerollLane(lane.id) && toast('info', `Nothing new came out for ${laneName}.`)}
              title={sung ? 'Sing the same vocal another way: the long or the short phrase, and where (no credits; your edits on these lanes are replaced; ⌘Z undoes)'
                : 'Write the lane again: a new sound and where it plays; the rest stays (your edits on this lane are replaced; ⌘Z undoes)'}>
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
function LaneChoices({ g, roles }: { g: Generation; roles: Role[] }) {
  const list = [...new Set(roles.flatMap(choicesOfRole))].filter((c) => c.roles.length <= 5 && (!c.when || c.when(g)))
  if (!list.length) return null
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-faint mb-2">Choices</div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1.5 items-center">
        {list.map((c) => <ChoiceRow key={c.rule} c={c} g={g} lockable prefix />)}
      </div>
    </div>
  )
}

/**
 * One choice of the track: its value as a menu (changing it makes the lanes it shapes again) and
 * a lock that keeps it for every next track.
 */
export function ChoiceRow({ c, g, lockable, prefix }: { c: Choice; g: Generation; lockable: boolean; prefix?: boolean }) {
  const locks = useGenerate((s) => s.settings.locks)
  const value = choiceValue(c, g)
  const options = c.options.some((o) => optionKey(o.value) === optionKey(value)) ? c.options : [...c.options, { value, label: String(value) }]
  const locked = c.rule in locks
  return (
    <>
      <label className="flex items-center gap-2 min-w-0 text-[12.5px]">
        <span className="text-muted shrink-0">{prefix && c.group !== 'Sound' && c.group !== 'Every 8 and 16 bars' ? `${c.group}: ` : ''}{c.label}</span>
        <select className="min-w-0 flex-1 h-7 rounded-lg bg-[rgb(0_0_0/0.25)] px-2 text-text text-[12px] outline-none shadow-[0_0_0_1px_rgb(255_255_255/0.08)]"
                value={optionKey(value)} onChange={(e) => confirmRemake(`the lanes shaped by “${c.label}”`) && setChoice(c.rule, JSON.parse(e.target.value))}>
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
