import { useState } from 'react'
import { Button, inputClass } from '../components/ui'
import { markerColor, MARKER_NAMES } from '../lib/project'
import { useProject } from '../store/project'
import type { Marker } from '../types/project'

/** Small popover to rename / delete a section marker (double-click on a marker). */
export function MarkerEditor({ marker, x, onClose }: { marker: Marker; x: number; onClose: () => void }) {
  const edit = useProject((s) => s.edit)
  const [name, setName] = useState(marker.name)
  const save = () => {
    const n = name.trim()
    if (n && n !== marker.name) {
      edit('Rename marker', (d) => {
        const m = d.markers.find((k) => k.id === marker.id)
        if (m) Object.assign(m, { name: n, color: markerColor(n) })
      })
    }
    onClose()
  }
  return (
    <div className="absolute z-30 top-6 rounded-xl glass-strong p-2.5 flex items-center gap-2"
         style={{ left: Math.max(8, x) }} onMouseDown={(e) => e.stopPropagation()}>
      <input autoFocus list="dv-marker-names" className={inputClass + ' w-36'} value={name}
             onChange={(e) => setName(e.target.value)}
             onKeyDown={(e) => {
               if (e.key === 'Enter') save()
               if (e.key === 'Escape') onClose()
             }} />
      <datalist id="dv-marker-names">{MARKER_NAMES.map((n) => <option key={n} value={n} />)}</datalist>
      <Button variant="primary" onClick={save}>OK</Button>
      <Button variant="danger" onClick={() => {
        edit('Delete marker', (d) => {
          d.markers = d.markers.filter((m) => m.id !== marker.id)
        })
        onClose()
      }}>Delete</Button>
    </div>
  )
}
