import { useCallback, useEffect, useRef, useState } from 'react'
import { playback } from '../audio/engine'
import { Options } from '../create/Options'
import { IconPlay, IconSparkle, IconStar, IconStop } from '../components/icons'
import { Range } from '../components/Range'
import { ContextMenu } from '../components/ContextMenu'
import { addLaneMenu } from './addLane'
import { Button, cx, inputClass, PageTitle } from '../components/ui'
import { formatBpm, GENRE_ABOUT, GENRE_LABELS } from '../lib/format'
import { beatToSec, BEATS_PER_BAR, formatPosition, formatTime } from '../lib/project'
import { DEFAULT_PX_PER_BEAT, MAX_PX_PER_BEAT, MIN_PX_PER_BEAT, useArrange } from '../store/arrange'
import { useApp } from '../store/app'
import { deleteTrack, keepTrack, newEmptyTrack, next, openTrack, previous, switchGenre, useGenerate } from '../store/generate'
import { DEFAULT_GENRE, GENRES } from '../types/engine'
import { useProject } from '../store/project'

/** Create's top bar (SCOPE.md §6.6): making tracks (‹ Generate ★), the track's name, Saved, Options, Export. */
export function Toolbar() {
  const project = useProject((s) => s.project)
  const { edit, dirty, scratch } = useProject()
  const saving = useArrange((s) => s.saving)
  const { history, index, detached, samples } = useGenerate()
  const generated = !!project.generation
  const unnamed = generated && project.name === 'Generated'
  const status = scratch ? 'Not saved' : saving ? 'Saving…' : dirty ? 'Edited' : 'Saved'

  // z-30: the bar's menus (Saved, Options) open over the timeline below, which is painted later.

  return (
    <div className="app-drag topbar-art z-30 h-14 shrink-0 flex items-center gap-2.5 px-5 border-b border-line">
      <PageTitle className="mr-2">Create</PageTitle>
      <GenreMenu />
      <Button variant="secondary" className="h-8 w-8 px-0" onClick={previous} title="Previous track (←)"
              disabled={detached ? !history[index] : index <= 0}>‹</Button>
      <Button variant="primary" className="h-8 px-3.5 text-[13px]" onClick={() => next()} disabled={!samples?.length}
              title="A new track (G; → steps forward through earlier ones first)">
        <IconSparkle className="w-3.5 h-3.5" />Generate
      </Button>
      {history.length > 0 && (
        <span className="text-faint text-[11.5px] tabular-nums w-12 text-center" title="This session's tracks: ← and → go through them">
          {detached ? '–' : index + 1} / {history.length}
        </span>
      )}
      <div className="w-px h-6 bg-line mx-1.5" />
      <button onClick={() => void keepTrack()} disabled={!scratch}
              title={scratch ? 'Keep this track (⌘S): it is saved, and autosaved from then on. Editing it by hand or exporting it keeps it too.'
                : `Saved as “${project.name}”`}
              className={cx('app-no-drag h-8 w-8 rounded-full flex items-center justify-center transition-colors',
                scratch ? 'surface-raised text-muted hover:text-text' : 'text-accent bg-accent/15 cursor-default')}>
        <IconStar className="w-4 h-4" filled={!scratch} />
      </button>
      <input className={cx(inputClass, 'w-48 font-medium')} value={unnamed ? '' : project.name}
             placeholder={unnamed ? (scratch ? 'New track (not saved)' : 'Generated') : 'Track name'} title="Track name (naming it keeps it)"
             onChange={(e) => edit('Rename track', (d) => {
               d.name = e.target.value
             }, { coalesce: 'project-name' })} />
      <span className={cx('text-[11px] w-16', scratch ? 'text-faint' : 'text-muted')}>{status}</span>
      <SavedMenu />
      <div className="flex-1" />
      <Options />
      <Button variant="primary" title="Export stems (⌘E): keeps the track" onClick={() => useApp.getState().setModal('export')}>Export…</Button>
    </div>
  )
}

/** The second bar: undo, transport, loop, click, tempo, length, zoom, and the library and side panel. */
export function Transport() {
  const project = useProject((s) => s.project)
  const { past, future, undo, redo, edit } = useProject()
  const { pxPerBeat, setView, libraryOpen, lanePanel } = useArrange()
  const [, force] = useState(0)
  useEffect(() => playback.subscribe(() => force((n) => n + 1)), [])
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null)
  const closeAddMenu = useCallback(() => setAddMenu(null), [])

  return (
    <div className="h-11 shrink-0 flex items-center gap-2.5 px-5 border-b border-line bg-panel">
      <Button variant="ghost" title="Undo (⌘Z)" disabled={!past.length} onClick={undo}>↶</Button>
      <Button variant="ghost" title="Redo (⇧⌘Z)" disabled={!future.length} onClick={redo}>↷</Button>
      <Button variant="ghost" title="Add a lane: a kind the generator fills (a build-up, a top loop, fills, FX, …), or an empty one"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setAddMenu({ x: r.left, y: r.bottom + 4 })
              }}>+</Button>
      {addMenu && <ContextMenu x={addMenu.x} y={addMenu.y} items={addLaneMenu()} onClose={closeAddMenu} />}
      <div className="w-px h-5 bg-line mx-1.5" />
      <button title="Play / stop (Space)" onClick={() => playback.toggle()}
              className={cx('w-8 h-8 rounded-full flex items-center justify-center shadow-sm',
                playback.playing ? 'bg-brand text-on-accent shadow-black/30' : 'bg-panel-2 border border-line text-accent hover:bg-raised')}>
        {playback.loading ? <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
          : playback.playing ? <IconStop className="w-4 h-4" /> : <IconPlay className="w-4 h-4 ml-0.5" />}
      </button>
      <PositionDisplay />
      <TimeDisplay />
      <Toggle on={project.loop.enabled} title="Loop region (L) — drag on the ruler to set it"
              onClick={() => edit('Toggle loop', (d) => {
                d.loop.enabled = !d.loop.enabled
              }, { keepScratch: true })}>Loop</Toggle>
      <Toggle on={project.metronome} title="Metronome"
              onClick={() => edit('Toggle metronome', (d) => {
                d.metronome = !d.metronome
              }, { keepScratch: true })}>Click</Toggle>
      <TempoField />
      <label className="flex items-center gap-1.5 text-[12px] text-muted ml-1" title="Track length in bars">
        <input type="number" min={1} max={999} className={cx(inputClass, 'w-16 h-7')} value={project.lengthBars}
               onChange={(e) => {
                 const v = Math.max(1, Math.min(999, Math.round(Number(e.target.value) || 1)))
                 edit('Track length', (d) => {
                   d.lengthBars = v
                 }, { coalesce: 'length' })
               }} />
        bars
      </label>

      <div className="flex-1" />
      <span className="text-[11px] text-faint">Zoom</span>
      <Range min={Math.log(MIN_PX_PER_BEAT)} max={Math.log(MAX_PX_PER_BEAT)} step={0.01}
             value={Math.log(pxPerBeat)} reset={Math.log(DEFAULT_PX_PER_BEAT)} className="w-28 mr-1 accent-[#e2c35f]"
             title="Zoom (⌥-click or double-click: the default zoom)"
             onValue={(v) => {
               const nextPx = Math.exp(v)
               const st = useArrange.getState()
               const centre = (st.scrollX + 400) / st.pxPerBeat
               setView({ pxPerBeat: nextPx, scrollX: Math.max(0, centre * nextPx - 400) })
             }} />
      <Button variant="ghost" title="Zoom to fit the whole track" onClick={() => useArrange.getState().fitToTrack()}>Fit</Button>
      <div className="w-px h-5 bg-line mx-1.5" />
      <Button variant={libraryOpen ? 'secondary' : 'ghost'} title="The drum library, to drag sounds onto the timeline"
              onClick={() => setView({ libraryOpen: !libraryOpen })}>Library</Button>
      <Button variant={lanePanel ? 'secondary' : 'ghost'} title="The side panel: the track's choices, its modules and lanes"
              onClick={() => useArrange.getState().set({ lanePanel: lanePanel ? null : { module: 'track' } })}>Panel</Button>
    </div>
  )
}

function Toggle({ on, children, onClick, title }: { on: boolean; children: string; onClick: () => void; title: string }) {
  return (
    <button title={title} onClick={onClick}
            className={cx('h-7 px-2.5 rounded-md text-[12px] font-medium border transition-colors',
              on ? 'bg-brand text-on-accent border-transparent' : 'border-line text-muted hover:text-text bg-panel')}>
      {children}
    </button>
  )
}

/** Playhead time and the track's total length: "1:23.4 / 5:12". */
function TimeDisplay() {
  const ref = useRef<HTMLSpanElement>(null)
  const bpm = useProject((s) => s.project.bpm)
  const lengthBars = useProject((s) => s.project.lengthBars)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      if (ref.current) ref.current.textContent = formatTime(beatToSec(playback.position(), bpm), true)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [bpm])
  return (
    <span title="Playhead time / total length"
          className="font-mono text-[13px] tabular-nums rounded-md bg-panel-2 border border-line h-7 leading-7 px-2.5 whitespace-nowrap">
      <span ref={ref} className="text-text">0:00.0</span>
      <span className="text-faint"> / {formatTime(beatToSec(lengthBars * BEATS_PER_BAR, bpm))}</span>
    </span>
  )
}

function PositionDisplay() {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      if (ref.current) ref.current.textContent = formatPosition(playback.position())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <span ref={ref} title="Bar.beat.16th" className="w-[74px] font-mono text-[13px] tabular-nums text-center rounded-md bg-panel-2 border border-line h-7 leading-7">1.1.1</span>
}

/**
 * The track's tempo. Samples are cut at the library BPM; at another tempo loops, fills and rolls
 * are sliced onto the grid and FX are stretched (pitch stays), see SCOPE.md §6.4a. New tracks take
 * theirs from Options (Tempo).
 */
function TempoField() {
  const bpm = useProject((s) => s.project.bpm)
  const edit = useProject((s) => s.edit)
  const library = useApp((s) => s.settings?.engine.library_bpm ?? 124)
  const [text, setText] = useState(formatBpm(bpm))
  useEffect(() => setText(formatBpm(bpm)), [bpm])
  const commit = () => {
    const v = Math.round(Number(text.replace(',', '.')) * 100) / 100
    if (!(v >= 60 && v <= 200) || v === bpm) {
      setText(formatBpm(bpm))
      return
    }
    const at = playback.position()
    const wasPlaying = playback.playing
    edit('Tempo', (d) => {
      d.bpm = v
    })
    // Same bar after the change; stretched FX for the new tempo load before playing on.
    if (wasPlaying) void playback.play(at)
    else playback.setPosition(at)
  }
  return (
    <label className={cx('flex items-center gap-1.5 text-[12px] ml-1', bpm !== library ? 'text-accent' : 'text-muted')}
           title={bpm !== library
             ? `Library tempo is ${formatBpm(library)} BPM: loops are sliced onto this tempo and FX are stretched (pitch stays)`
             : 'Track tempo (the library BPM). Change it to play the track faster or slower; pitch stays. New tracks: Options → Tempo.'}>
      <input className={cx(inputClass, 'w-16 h-7 tabular-nums')} value={text} inputMode="decimal"
             onChange={(e) => setText(e.target.value)} onBlur={commit}
             onKeyDown={(e) => {
               if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
               if (e.key === 'Escape') {
                 setText(formatBpm(bpm))
                 ;(e.target as HTMLInputElement).blur()
               }
             }} />
      BPM
    </label>
  )
}

/** The saved tracks (projects): open one, start an empty one, delete the one on screen. */
/** The genre tracks are made in (SCOPE.md §5.18): its settings, its library, its tracks. */
function GenreMenu() {
  const [open, setOpen] = useState(false)
  const genre = useApp((s) => s.settings?.genre ?? DEFAULT_GENRE)
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="relative app-no-drag" onMouseDown={(e) => e.stopPropagation()}>
      <Button variant="secondary" className="h-8 px-3 text-[12.5px]" onClick={() => setOpen(!open)}
              title="The genre: its own library, settings and saved tracks">{GENRE_LABELS[genre]} ▾</Button>
      {open && (
        <div className="absolute left-0 top-9 z-30 w-80 rounded-xl surface-pop py-1">
          {GENRES.map((g) => (
            <button key={g} onClick={() => {
              setOpen(false)
              void switchGenre(g)
            }} className={cx('w-full px-3 py-1.5 text-left hover:bg-panel-2', g === genre && 'text-accent')}>
              <div className="text-[12.5px] font-medium">{GENRE_LABELS[g]}</div>
              <div className="text-[11.5px] text-faint">{GENRE_ABOUT[g]}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SavedMenu() {
  const [open, setOpen] = useState(false)
  const genre = useApp((s) => s.settings?.genre ?? DEFAULT_GENRE)
  const projects = useArrange((s) => s.projects).filter((p) => p.genre === genre)
  const file = useProject((s) => s.file)
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="relative app-no-drag" onMouseDown={(e) => e.stopPropagation()}>
      <Button variant="ghost" onClick={() => setOpen(!open)} title="Your saved tracks">Saved ({projects.length}) ▾</Button>
      {open && (
        <div className="absolute left-0 top-9 z-30 w-80 rounded-xl surface-pop py-1">
          <div className="max-h-80 overflow-y-auto">
            {projects.length === 0 && <div className="px-3 py-2 text-[12px] text-faint">No saved tracks yet: star one (⌘S), edit it or export it.</div>}
            {projects.map((p) => (
              <MenuItem key={p.file} active={p.file === file} onClick={() => {
                setOpen(false)
                if (p.file !== file) void openTrack(p.file)
              }}>
                <span className="flex-1 truncate">{p.name}</span>
                <span className="text-[11px] text-faint">{new Date(p.modified).toLocaleDateString()}</span>
              </MenuItem>
            ))}
          </div>
          <div className="border-t border-line my-1" />
          <MenuItem onClick={() => {
            setOpen(false)
            void newEmptyTrack()
          }}>New empty track (build it by hand)</MenuItem>
          <MenuItem danger onClick={() => {
            setOpen(false)
            const saved = !!useProject.getState().file
            if (!saved || window.confirm('Delete this saved track? Samples in the library are not affected.')) void deleteTrack()
          }}>{file ? 'Delete this track' : 'Discard this track'}</MenuItem>
        </div>
      )}
    </div>
  )
}

function MenuItem({ children, onClick, active, danger }: { children: React.ReactNode; onClick: () => void; active?: boolean; danger?: boolean }) {
  return (
    <button onClick={onClick}
            className={cx('w-full flex items-center gap-2 px-3 h-8 text-left text-[12.5px] hover:bg-panel-2',
              active && 'text-accent font-medium', danger && 'text-bad')}>
      {children}
    </button>
  )
}
