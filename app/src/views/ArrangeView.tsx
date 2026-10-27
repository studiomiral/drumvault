import { useEffect, useState } from 'react'
import { playback } from '../audio/engine'
import { BottomPanel } from '../arrange/StepEditor'
import { LaneHeaders } from '../arrange/LaneHeaders'
import { LibraryPanel } from '../arrange/LibraryPanel'
import { MarkerEditor } from '../arrange/MarkerEditor'
import { Timeline } from '../arrange/Timeline'
import { Toolbar } from '../arrange/Toolbar'
import { ExportDialog } from '../arrange/ExportDialog'
import { useApp } from '../store/app'
import { useArrange } from '../store/arrange'
import { useProject } from '../store/project'
import type { Marker } from '../types/project'
import { BEATS_PER_BAR, duplicateClips, uid } from '../lib/project'

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
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && st.selection.length) {
        e.preventDefault()
        const delta = (e.key === 'ArrowLeft' ? -1 : 1) * (e.altKey ? 1 : BEATS_PER_BAR)
        const ids = new Set(st.selection)
        st.edit('Nudge clips', (d) => {
          for (const c of d.clips) if (ids.has(c.id)) c.start = Math.max(0, c.start + delta)
        }, { coalesce: 'nudge' })
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
      </div>
      <BottomPanel />
      {modal === 'export' && <ExportDialog onClose={() => setModal(null)} />}
    </div>
  )
}

export function deleteSelection(): void {
  const st = useProject.getState()
  if (st.selection.length) {
    const ids = new Set(st.selection)
    st.edit(`Delete ${ids.size} clip${ids.size > 1 ? 's' : ''}`, (d) => {
      d.clips = d.clips.filter((c) => !ids.has(c.id))
    })
  } else if (st.selectedMarker) {
    const id = st.selectedMarker
    st.edit('Delete marker', (d) => {
      d.markers = d.markers.filter((m) => m.id !== id)
    })
  }
}

/**
 * ⌘D / R: copies of the selection placed right after it. With a section marker selected the
 * whole section is duplicated: its clips move by the section length and the marker is copied.
 */
export function duplicateSelection(): void {
  const st = useProject.getState()
  const sel = st.project.clips.filter((c) => st.selection.includes(c.id))
  const marker = st.project.markers.find((m) => m.id === st.selectedMarker)
  if (!sel.length && !marker) return
  const span = marker ? marker.end - marker.start : undefined
  const copies = duplicateClips(sel, span)
  const markerCopy = marker ? { ...marker, id: uid('m'), start: marker.end, end: marker.end + span! } : null
  st.edit(markerCopy ? `Duplicate section ${marker!.name}` : `Duplicate ${copies.length} clip${copies.length > 1 ? 's' : ''}`, (d) => {
    d.clips.push(...copies)
    if (markerCopy) d.markers.push(markerCopy)
  })
  st.select(copies.map((c) => c.id))
  if (markerCopy) st.selectMarker(markerCopy.id)
}
