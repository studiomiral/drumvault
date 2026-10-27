import { useState } from 'react'
import { cx } from '../components/ui'
import { LANE_COLORS, makeLane, MAX_LANE_HEIGHT, MIN_LANE_HEIGHT } from '../lib/project'
import { useArrange } from '../store/arrange'
import { useProject } from '../store/project'
import type { Lane } from '../types/project'
import { HEADER_W, TOP } from './geometry'

/** Lane strip: name, colour, mute/solo, volume, pan; drag to reorder, drag the bottom edge to resize. */
export function LaneHeaders() {
  const lanes = useProject((s) => s.project.lanes)
  const scrollY = useArrange((s) => s.scrollY)
  const [dragId, setDragId] = useState<string | null>(null)
  const edit = useProject((s) => s.edit)

  const addLane = () => edit('Add lane', (d) => {
    d.lanes.push(makeLane(`Lane ${d.lanes.length + 1}`, d.lanes.length))
  })

  return (
    <div className="relative shrink-0 border-r border-line bg-panel overflow-hidden" style={{ width: HEADER_W }}>
      <div className="absolute inset-x-0 top-0 z-10 bg-panel border-b border-line flex items-end justify-between px-3 pb-1.5"
           style={{ height: TOP }}>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Lanes</span>
        <button onClick={addLane} className="text-[12px] text-accent hover:underline">+ Lane</button>
      </div>
      <div style={{ transform: `translateY(${TOP - scrollY}px)` }}>
        {lanes.map((lane) => (
          <LaneHeader key={lane.id} lane={lane} dragging={dragId === lane.id}
                      onDragStart={() => setDragId(lane.id)} onDragEnd={() => setDragId(null)}
                      onDropOn={() => {
                        if (!dragId || dragId === lane.id) return
                        edit('Reorder lanes', (d) => {
                          const from = d.lanes.findIndex((l) => l.id === dragId)
                          const [moved] = d.lanes.splice(from, 1)
                          d.lanes.splice(d.lanes.findIndex((l) => l.id === lane.id), 0, moved)
                        })
                        setDragId(null)
                      }} />
        ))}
      </div>
    </div>
  )
}

function LaneHeader({ lane, dragging, onDragStart, onDragEnd, onDropOn }: {
  lane: Lane
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDropOn: () => void
}) {
  const edit = useProject((s) => s.edit)
  const clipCount = useProject((s) => s.project.clips.filter((c) => c.laneId === lane.id).length)
  const [name, setName] = useState<string | null>(null)
  const set = (label: string, patch: Partial<Lane>, coalesce?: string) =>
    edit(label, (d) => {
      Object.assign(d.lanes.find((l) => l.id === lane.id)!, patch)
    }, { coalesce })
  const compact = lane.height < 56

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const y0 = e.clientY
    const h0 = lane.height
    const move = (ev: MouseEvent) => set('Resize lane', {
      height: Math.round(Math.max(MIN_LANE_HEIGHT, Math.min(MAX_LANE_HEIGHT, h0 + ev.clientY - y0))),
    }, `height-${lane.id}`)
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div
      className={cx('relative border-b border-line px-2 flex gap-2 group', dragging && 'opacity-40')}
      style={{ height: lane.height }}
      draggable={name === null}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-drumvault-lane', lane.id)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.dataTransfer.types.includes('application/x-drumvault-lane') && e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        onDropOn()
      }}
    >
      <button title="Change colour" className="w-1.5 my-1.5 rounded-full shrink-0 cursor-pointer"
              style={{ background: lane.color }}
              onClick={() => set('Lane colour', { color: LANE_COLORS[(LANE_COLORS.indexOf(lane.color) + 1) % LANE_COLORS.length] })} />
      <div className={cx('flex-1 min-w-0 flex', compact ? 'items-center gap-2' : 'flex-col justify-center gap-1')}>
        <div className="flex items-center gap-1.5 min-w-0">
          {name === null ? (
            <span className="flex-1 truncate font-medium text-[12.5px] cursor-text" title="Double-click to rename"
                  onDoubleClick={() => setName(lane.name)}>{lane.name}</span>
          ) : (
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                   onBlur={() => {
                     if (name.trim()) set('Rename lane', { name: name.trim() })
                     setName(null)
                   }}
                   onKeyDown={(e) => {
                     if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                     if (e.key === 'Escape') setName(null)
                   }}
                   className="flex-1 min-w-0 h-5 text-[12.5px] rounded border border-accent px-1 outline-none" />
          )}
          <button title="Mute" onClick={() => set(lane.mute ? 'Unmute' : 'Mute', { mute: !lane.mute })}
                  className={cx('w-5 h-5 rounded text-[10.5px] font-bold', lane.mute ? 'bg-[#f59e0b] text-white' : 'bg-raised text-muted hover:text-text')}>M</button>
          <button title="Solo" onClick={() => set(lane.solo ? 'Unsolo' : 'Solo', { solo: !lane.solo })}
                  className={cx('w-5 h-5 rounded text-[10.5px] font-bold', lane.solo ? 'bg-brand text-white' : 'bg-raised text-muted hover:text-text')}>S</button>
          <button title={clipCount ? `Delete lane and its ${clipCount} clips` : 'Delete lane'}
                  className="w-4 h-5 text-faint hover:text-bad opacity-0 group-hover:opacity-100"
                  onClick={() => {
                    if (clipCount && !window.confirm(`Delete "${lane.name}" and its ${clipCount} clips?`)) return
                    edit('Delete lane', (d) => {
                      d.lanes = d.lanes.filter((l) => l.id !== lane.id)
                      d.clips = d.clips.filter((c) => c.laneId !== lane.id)
                    })
                  }}>×</button>
        </div>
        {!compact && (
          <div className="flex items-center gap-1.5">
            <input type="range" min={-60} max={6} step={0.5} value={lane.volumeDb} title={`Volume ${fmtDb(lane.volumeDb)} (double-click: 0 dB)`}
                   onChange={(e) => set('Lane volume', { volumeDb: Number(e.target.value) }, `vol-${lane.id}`)}
                   onDoubleClick={() => set('Lane volume', { volumeDb: 0 })}
                   className="flex-1 min-w-0 h-1 accent-[#7c3aed]" />
            <span className="w-11 text-right text-[10.5px] tabular-nums text-muted">{fmtDb(lane.volumeDb)}</span>
            <input type="range" min={-1} max={1} step={0.05} value={lane.pan} title={`Pan ${fmtPan(lane.pan)} (double-click: centre)`}
                   onChange={(e) => set('Lane pan', { pan: Number(e.target.value) }, `pan-${lane.id}`)}
                   onDoubleClick={() => set('Lane pan', { pan: 0 })}
                   className="w-12 h-1 accent-[#7c3aed]" />
          </div>
        )}
      </div>
      <div onMouseDown={startResize} className="absolute left-0 right-0 -bottom-1 h-2 cursor-row-resize z-10" />
    </div>
  )
}

function fmtDb(db: number): string {
  return db <= -60 ? '-∞ dB' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`
}

function fmtPan(p: number): string {
  return Math.abs(p) < 0.01 ? 'C' : p < 0 ? `L${Math.round(-p * 100)}` : `R${Math.round(p * 100)}`
}
