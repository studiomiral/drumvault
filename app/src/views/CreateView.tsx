import { useEffect, useMemo, useState } from 'react'
import { playback } from '../audio/engine'
import { BottomPanel } from '../arrange/StepEditor'
import { LaneHeaders } from '../arrange/LaneHeaders'
import { LibraryPanel } from '../arrange/LibraryPanel'
import { MarkerEditor } from '../arrange/MarkerEditor'
import { Timeline } from '../arrange/Timeline'
import { Toolbar, Transport } from '../arrange/Toolbar'
import { ExportDialog } from '../arrange/ExportDialog'
import { HEADER_W } from '../arrange/geometry'
import { LanePanel } from '../components/LanePanel'
import { IconSparkle, IconX } from '../components/icons'
import { Button } from '../components/ui'
import { useApp } from '../store/app'
import { arrangeTrack, forward, keepTrack, loadSamples, next, playSection, previous, useGenerate } from '../store/generate'
import { useArrange } from '../store/arrange'
import { useProject } from '../store/project'
import type { Marker } from '../types/project'
import { BEATS_PER_BAR } from '../lib/project'
import { deleteSelection, duplicateSelection, shiftSelection, splitSelectionAt } from '../arrange/commands'

/**
 * Create (SCOPE.md §6.6): make tracks (G), cycle through them (← →), and change what you like on
 * the timeline (SCOPE.md §6.4) and in the side panel. A track is saved once it's kept.
 */
export function CreateView() {
  const libraryOpen = useArrange((s) => s.libraryOpen)
  const { modal, setModal, libraryVersion } = useApp()
  const [markerEdit, setMarkerEdit] = useState<{ marker: Marker; x: number } | null>(null)

  // The generator draws from the library.
  useEffect(() => {
    void loadSamples()
  }, [libraryVersion])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return
      if (useApp.getState().modal) return
      const st = useProject.getState()
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 's' && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        void keepTrack()
        return
      }
      if (mod) return
      if (e.key === ' ') {
        e.preventDefault()
        playback.toggle()
      } else if (key === 'g' && !e.altKey) {
        e.preventDefault()
        next()
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !st.selection.length && !e.shiftKey && !e.altKey) {
        // Nothing selected: through the tracks.
        e.preventDefault()
        if (e.key === 'ArrowLeft') previous()
        else forward()
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        deleteSelection()
      } else if (e.key === 'Escape') {
        if (st.editingClip) st.openEditor(null)
        else st.select([])
      } else if (key === 'r' && !e.altKey) {
        e.preventDefault()
        duplicateSelection()
      } else if (key === 'l') {
        st.edit('Toggle loop', (d) => {
          d.loop.enabled = !d.loop.enabled
        }, { keepScratch: true })
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.shiftKey && st.selection.length) {
        e.preventDefault()
        shiftSelection(e.key === 'ArrowLeft' ? -1 : 1)
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && st.selection.length) {
        e.preventDefault()
        const delta = (e.key === 'ArrowLeft' ? -1 : 1) * (e.altKey ? 1 : BEATS_PER_BAR)
        const ids = new Set(st.selection)
        st.edit('Nudge clips', (d) => {
          for (const c of d.clips) if (ids.has(c.id)) c.start = Math.max(0, c.start + delta)
        }, { coalesce: 'nudge' })
      } else if (key === 's' && !e.altKey) {
        e.preventDefault()
        splitSelectionAt(Math.round(playback.position() * 4) / 4)  // at the playhead, on a 16th
      } else if (/^[1-9]$/.test(e.key)) {
        playSection(Number(e.key) - 1)
      } else if (e.key === 'Home' || e.key === 'Enter') {
        playback.setPosition(0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Toolbar />
      <Transport />
      <div className="flex-1 min-h-0 flex relative">
        <LaneHeaders />
        <Timeline onMarkerEdit={(marker, x) => setMarkerEdit({ marker, x })} />
        {markerEdit && (
          <div className="absolute inset-0 z-20" onMouseDown={() => setMarkerEdit(null)}>
            <MarkerEditor marker={markerEdit.marker} x={markerEdit.x + HEADER_W} onClose={() => setMarkerEdit(null)} />
          </div>
        )}
        <StartHere />
        {libraryOpen && <LibraryPanel />}
        <SidePanel />
      </div>
      <BottomPanel />
      {modal === 'export' && <ExportDialog onClose={() => setModal(null)} />}
    </div>
  )
}

/** An empty track: where to start (a new track, or sounds dragged in from the library). */
function StartHere() {
  const empty = useProject((s) => !s.project.generation && s.project.clips.length === 0)
  const samples = useGenerate((s) => s.samples)
  const { minMinutes, maxMinutes } = useGenerate((s) => s.settings)
  if (!empty) return null
  return (
    <div className="absolute inset-y-0 right-0 z-10 flex items-center justify-center pointer-events-none" style={{ left: HEADER_W }}>
      <div className="pointer-events-auto rounded-2xl border border-dashed border-[#3e3f44] bg-panel/90 px-10 py-8 text-center max-w-md">
        {samples && samples.length === 0 ? (
          <>
            <div className="font-display text-[22px] text-text">Nothing to make tracks from yet</div>
            <p className="mt-2 text-[12.5px] text-muted">Process some zips first (Drums → Drumvault): Create combines drums and FX from your library.</p>
            <Button variant="secondary" className="mt-4" onClick={() => useApp.getState().setView('process')}>Open Drumvault</Button>
          </>
        ) : (
          <>
            <div className="font-display text-[22px] text-text">A new track, every press</div>
            <p className="mt-2 text-[12.5px] text-muted">
              {minMinutes}–{maxMinutes} minutes with a DJ intro and outro, builds, breakdowns and drops. Keep what you like,
              remake the rest, move things around on the timeline.
            </p>
            <Button variant="primary" className="mt-4 h-9 px-4" onClick={() => next()} disabled={!samples}>
              <IconSparkle className="w-3.5 h-3.5" />Generate (G)
            </Button>
            <p className="mt-3 text-[11.5px] text-faint">Or open the Library and drag sounds in to build one by hand.</p>
          </>
        )}
      </div>
    </div>
  )
}

/** The side panel: the track, a module or a lane of a generated track (SCOPE.md §6.6). */
function SidePanel() {
  const panel = useArrange((s) => s.lanePanel)
  const project = useProject((s) => s.project)
  const g = useMemo(() => arrangeTrack(project), [project])
  const samples = useGenerate((s) => s.samples)
  if (!panel) return null
  return (
    <aside className="w-[400px] shrink-0 border-l border-line bg-panel overflow-y-auto">
      <div className="h-10 px-4 flex items-center border-b border-line sticky top-0 bg-panel z-10">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint flex-1">Track</span>
        <button className="w-6 h-6 rounded-md flex items-center justify-center text-faint hover:text-text" title="Close"
                onClick={() => useArrange.getState().set({ lanePanel: null })}>
          <IconX className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="p-4">
        {!g ? <p className="text-muted text-[12.5px]">This track was built by hand, so it has no generator choices or modules. Press G for a generated one.</p>
          : !samples ? <p className="text-muted text-[12.5px]">Loading the library…</p>
            : <LanePanel g={g} panel={panel} onPanel={(lanePanel) => useArrange.getState().set({ lanePanel })} />}
      </div>
    </aside>
  )
}
