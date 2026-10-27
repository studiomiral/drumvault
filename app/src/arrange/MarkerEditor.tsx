import { useState } from 'react'
import { Button, inputClass } from '../components/ui'
import { markerColor, MARKER_NAMES } from '../lib/project'
import { useProject } from '../store/project'
import type { Marker } from '../types/project'

/** Small popover to name / delete a section marker (new markers, or double-click on one). */
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
  const pick = (n: string) => {
    edit('Rename marker', (d) => {
      const m = d.markers.find((k) => k.id === marker.id)
      if (m) Object.assign(m, { name: n, color: markerColor(n) })
    })
    onClose()
  }
  return (
    <div className="absolute z-30 top-8 rounded-xl surface-pop p-2.5 flex flex-col gap-2"
         style={{ left: Math.max(8, x) }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2">
        <input autoFocus className={inputClass + ' w-40'} value={name} placeholder="Section name"
               onFocus={(e) => e.target.select()}
               onChange={(e) => setName(e.target.value)}
               onKeyDown={(e) => {
                 if (e.key === 'Enter') save()
                 if (e.key === 'Escape') onClose()
               }} />
        <Button variant="primary" onClick={save}>OK</Button>
      <Button variant="danger" onClick={() => {
        edit('Delete marker', (d) => {
          d.markers = d.markers.filter((m) => m.id !== marker.id)
        })
        onClose()
      }}>Delete</Button>
      </div>
      <div className="flex flex-wrap gap-1 max-w-[300px]">
        {MARKER_NAMES.map((n) => (
          <button key={n} onClick={() => pick(n)}
                  className="h-6 px-2 rounded-md text-[11.5px] bg-raised hover:bg-[#3a3b3f] flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: markerColor(n) }} />{n}
          </button>
        ))}
      </div>
    </div>
  )
}
