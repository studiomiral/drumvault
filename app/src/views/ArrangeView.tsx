import { useEffect, useMemo, useState } from 'react'
import { playback } from '../audio/engine'
import { BottomPanel } from '../arrange/StepEditor'
import { LaneHeaders } from '../arrange/LaneHeaders'
import { LibraryPanel } from '../arrange/LibraryPanel'
import { MarkerEditor } from '../arrange/MarkerEditor'
import { Timeline } from '../arrange/Timeline'
import { Toolbar } from '../arrange/Toolbar'
import { ExportDialog } from '../arrange/ExportDialog'
import { LanePanel } from '../components/LanePanel'
import { IconX } from '../components/icons'
import { useApp } from '../store/app'
import { arrangeTrack, loadSamples, useGenerate } from '../store/generate'
import { useArrange } from '../store/arrange'
import { useProject } from '../store/project'
import type { Marker } from '../types/project'
import { BEATS_PER_BAR } from '../lib/project'
import { deleteSelection, duplicateSelection, shiftSelection, splitSelectionAt } from '../arrange/commands'

/** Mini DAW (SCOPE.md §6.4). */
export function ArrangeView() {
  const libraryOpen = useArrange((s) => s.libraryOpen)
  const { modal, setModal } = useApp()
  const [markerEdit, setMarkerEdit] = useState<{ marker: Marker; x: number } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return
      if (useApp.getState().modal) return
      const st = useProject.getState()
      if (e.key === ' ') {
        e.preventDefault()
        playback.toggle()
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        deleteSelection()
      } else if (e.key === 'Escape') {
        if (st.editingClip) st.openEditor(null)
        else st.select([])
      } else if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        duplicateSelection()
      } else if (e.key.toLowerCase() === 'l' && !e.metaKey && !e.ctrlKey) {
        st.edit('Toggle loop', (d) => {
          d.loop.enabled = !d.loop.enabled
        })
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
      } else if (e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        splitSelectionAt(Math.round(playback.position() * 4) / 4)  // at the playhead, on a 16th
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
      <div className="flex-1 min-h-0 flex relative">
        <LaneHeaders />
        <Timeline onMarkerEdit={(marker, x) => setMarkerEdit({ marker, x })} />
        {markerEdit && (
          <div className="absolute inset-0 z-20" onMouseDown={() => setMarkerEdit(null)}>
            <MarkerEditor marker={markerEdit.marker} x={markerEdit.x + 236} onClose={() => setMarkerEdit(null)} />
          </div>
        )}
        {libraryOpen && <LibraryPanel />}
        <GeneratedLanePanel />
      </div>
      <BottomPanel />
      {modal === 'export' && <ExportDialog onClose={() => setModal(null)} />}
    </div>
  )
}

/**
 * A generated project's lane panel (SCOPE.md §6.6): the lane's module (Bass, Chords, Disco Hits)
 * or its sounds and choices, as in Generate; changes are edits of the project (⌘Z).
 */
function GeneratedLanePanel() {
  const panel = useArrange((s) => s.lanePanel)
  const project = useProject((s) => s.project)
  const g = useMemo(() => arrangeTrack(project), [project])
  const samples = useGenerate((s) => s.samples)
  const generated = !!project.generation
  // The modules draw from the library like Generate does.
  useEffect(() => {
    if (generated && !useGenerate.getState().samples) void loadSamples()
  }, [generated])
  if (!panel || !g) return null
  return (
    <aside className="w-[440px] shrink-0 border-l border-line bg-panel overflow-y-auto">
      <div className="h-10 px-4 flex items-center border-b border-line">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint flex-1">Generated lanes</span>
        <button className="w-6 h-6 rounded-md flex items-center justify-center text-faint hover:text-text" title="Close"
                onClick={() => useArrange.getState().set({ lanePanel: null })}>
          <IconX className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="p-4">
        {!samples ? <p className="text-muted text-[12.5px]">Loading the library…</p>
          : <LanePanel g={g} panel={panel} onPanel={(lanePanel) => useArrange.getState().set({ lanePanel })} where="arrange" />}
      </div>
    </aside>
  )
}
