import { useEffect, useRef, useState } from 'react'
import { playback } from '../audio/engine'
import { IconPlay, IconStop } from '../components/icons'
import { Button, cx, inputClass } from '../components/ui'
import { formatBpm } from '../lib/format'
import { formatPosition } from '../lib/project'
import { MAX_PX_PER_BEAT, MIN_PX_PER_BEAT, useArrange } from '../store/arrange'
import { useApp } from '../store/app'
import { useProject } from '../store/project'
import { createProject, deleteCurrentProject, openProject } from './persistence'

export function Toolbar() {
  const project = useProject((s) => s.project)
  const { past, future, undo, redo, edit, dirty } = useProject()
  const { pxPerBeat, setView, libraryOpen, saving, projects } = useArrange()
  const [, force] = useState(0)
  useEffect(() => playback.subscribe(() => force((n) => n + 1)), [])

  return (
    <div className="h-14 shrink-0 flex items-center gap-2 px-4 border-b border-line bg-panel">
      <ProjectMenu />
      <input className={cx(inputClass, 'w-44 font-medium')} value={project.name} title="Project name"
             onChange={(e) => edit('Rename project', (d) => {
               d.name = e.target.value
             }, { coalesce: 'project-name' })} />
      <span className="text-[11px] text-faint w-14">{saving ? 'Saving…' : dirty ? 'Edited' : 'Saved'}</span>

      <div className="w-px h-6 bg-line mx-1" />
      <Button variant="ghost" title="Undo (⌘Z)" disabled={!past.length} onClick={undo}>↶</Button>
      <Button variant="ghost" title="Redo (⇧⌘Z)" disabled={!future.length} onClick={redo}>↷</Button>

      <div className="w-px h-6 bg-line mx-1" />
      <button title="Play / stop (Space)" onClick={() => playback.toggle()}
              className={cx('w-9 h-9 rounded-full flex items-center justify-center shadow-sm',
                playback.playing ? 'bg-brand text-white shadow-violet-500/30' : 'bg-panel border border-line text-accent hover:bg-panel-2')}>
        {playback.loading ? <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
          : playback.playing ? <IconStop className="w-4 h-4" /> : <IconPlay className="w-4 h-4 ml-0.5" />}
      </button>
      <PositionDisplay />
      <Toggle on={project.loop.enabled} title="Loop region (L) — drag on the ruler to set it"
              onClick={() => edit('Toggle loop', (d) => {
                d.loop.enabled = !d.loop.enabled
              })}>Loop</Toggle>
      <Toggle on={project.metronome} title="Metronome"
              onClick={() => edit('Toggle metronome', (d) => {
                d.metronome = !d.metronome
              })}>Click</Toggle>
      <span className="text-[12px] text-muted ml-1" title="Project tempo = library BPM">
        <span className="font-semibold text-text">{formatBpm(project.bpm)}</span> BPM
      </span>
      <label className="flex items-center gap-1.5 text-[12px] text-muted ml-1" title="Project length in bars">
        <input type="number" min={1} max={999} className={cx(inputClass, 'w-16 h-7')} value={project.lengthBars}
               onChange={(e) => {
                 const v = Math.max(1, Math.min(999, Math.round(Number(e.target.value) || 1)))
                 edit('Project length', (d) => {
                   d.lengthBars = v
                 }, { coalesce: 'length' })
               }} />
        bars
      </label>

      <div className="flex-1" />
      <span className="text-[11px] text-faint">Zoom</span>
      <input type="range" min={Math.log(MIN_PX_PER_BEAT)} max={Math.log(MAX_PX_PER_BEAT)} step={0.01}
             value={Math.log(pxPerBeat)} className="w-28 accent-[#7c3aed]"
             onChange={(e) => {
               const next = Math.exp(Number(e.target.value))
               const st = useArrange.getState()
               const centre = (st.scrollX + 400) / st.pxPerBeat
               setView({ pxPerBeat: next, scrollX: Math.max(0, centre * next - 400) })
             }} />
      <Button variant="primary" title="Export stems (⌘E)" onClick={() => useApp.getState().setModal('export')}>Export…</Button>
      <Button variant={libraryOpen ? 'secondary' : 'ghost'} onClick={() => setView({ libraryOpen: !libraryOpen })}>
        Library {libraryOpen ? '›' : '‹'}
      </Button>
      <datalist id="dv-projects">{projects.map((p) => <option key={p.file} value={p.name} />)}</datalist>
    </div>
  )
}

function Toggle({ on, children, onClick, title }: { on: boolean; children: string; onClick: () => void; title: string }) {
  return (
    <button title={title} onClick={onClick}
            className={cx('h-7 px-2.5 rounded-md text-[12px] font-medium border transition-colors',
              on ? 'bg-brand text-white border-transparent' : 'border-line text-muted hover:text-text bg-panel')}>
      {children}
    </button>
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

function ProjectMenu() {
  const [open, setOpen] = useState(false)
  const { projects } = useArrange()
  const file = useProject((s) => s.file)
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
      <Button onClick={() => setOpen(!open)}>Projects ▾</Button>
      {open && (
        <div className="absolute left-0 top-9 z-30 w-72 rounded-lg border border-line bg-panel shadow-xl shadow-violet-900/10 py-1">
          <MenuItem onClick={() => {
            setOpen(false)
            void createProject()
          }}>New project</MenuItem>
          {projects.length > 0 && <div className="border-t border-line my-1" />}
          <div className="max-h-72 overflow-y-auto">
            {projects.map((p) => (
              <MenuItem key={p.file} active={p.file === file} onClick={() => {
                setOpen(false)
                if (p.file !== file) void openProject(p.file)
              }}>
                <span className="flex-1 truncate">{p.name}</span>
                <span className="text-[11px] text-faint">{new Date(p.modified).toLocaleDateString()}</span>
              </MenuItem>
            ))}
          </div>
          <div className="border-t border-line my-1" />
          <MenuItem danger onClick={() => {
            setOpen(false)
            if (window.confirm('Delete this project? Samples in the library are not affected.')) void deleteCurrentProject()
          }}>Delete this project</MenuItem>
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
