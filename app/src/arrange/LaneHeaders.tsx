import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconShuffle, IconSparkle } from '../components/icons'
import { cx } from '../components/ui'
import { laneRole } from '../generate/generator'
import { useApp } from '../store/app'
import { newSound, rerollLane } from '../store/generate'
import { LANE_PALETTE, makeLane, MAX_LANE_HEIGHT, MIN_LANE_HEIGHT } from '../lib/project'
import { panelOf, useArrange } from '../store/arrange'
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
    <div className="relative shrink-0 border-r border-line bg-panel-2 overflow-hidden" style={{ width: HEADER_W }}>
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
  // A generated project's lanes keep their module: a new sound, the lane made again, its panel.
  const generated = useProject((s) => !!s.project.generation) && !!laneRole(lane.name)
  const panel = useArrange((s) => s.lanePanel)
  const open = !!panel && JSON.stringify(panel) === JSON.stringify(panelOf(lane.name))
  const toast = useApp((s) => s.toast)
  const [name, setName] = useState<string | null>(null)
  const [palette, setPalette] = useState<DOMRect | null>(null)
  // Set while a control (volume, pan) is being dragged, so the lane itself doesn't start moving.
  const controlDrag = useRef(false)
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
        if (controlDrag.current) {
          e.preventDefault()
          return
        }
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
      <button title="Change colour" className="w-2 my-1.5 rounded-full shrink-0 cursor-pointer hover:ring-2 hover:ring-accent/30"
              style={{ background: lane.color }}
              onClick={(e) => setPalette(e.currentTarget.getBoundingClientRect())} />
      {palette && (
        <ColorPalette anchor={palette} value={lane.color} onClose={() => setPalette(null)}
                      onPick={(color) => {
                        set('Lane colour', { color })
                        setPalette(null)
                      }} />
      )}
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
          {generated && (
            <>
              <button title="New sound: other sounds of the same kind (another patch on Bass and Keys), the clips stay where they are"
                      className="w-5 h-5 rounded bg-raised text-muted hover:text-text flex items-center justify-center"
                      onClick={() => !newSound(lane.id) && toast('info', `No other sound for ${lane.name} in the library.`)}>
                <IconShuffle className="w-3 h-3" />
              </button>
              <button title="Remake: the lane written again as Generate would (your edits on it are replaced; ⌘Z undoes)"
                      className="w-5 h-5 rounded bg-raised text-accent hover:bg-accent/20 flex items-center justify-center"
                      onClick={() => !rerollLane(lane.id) && toast('info', `Nothing new came out for ${lane.name}.`)}>
                <IconSparkle className="w-3 h-3" />
              </button>
              <button title={open ? 'Close the lane panel' : 'Open the lane in the lane panel: its module, sounds and choices'}
                      className={cx('w-5 h-5 rounded text-[11px] font-bold', open ? 'bg-accent-soft text-accent' : 'bg-raised text-muted hover:text-text')}
                      onClick={() => useArrange.getState().set({ lanePanel: open ? null : panelOf(lane.name) })}>⋯</button>
            </>
          )}
          <button title="Mute" onClick={() => set(lane.mute ? 'Unmute' : 'Mute', { mute: !lane.mute })}
                  className={cx('w-5 h-5 rounded text-[10.5px] font-bold', lane.mute ? 'bg-warn text-on-accent' : 'bg-raised text-muted hover:text-text')}>M</button>
          <button title="Solo" onClick={() => set(lane.solo ? 'Unsolo' : 'Solo', { solo: !lane.solo })}
                  className={cx('w-5 h-5 rounded text-[10.5px] font-bold', lane.solo ? 'bg-brand text-on-accent' : 'bg-raised text-muted hover:text-text')}>S</button>
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
            <BarSlider className="flex-1 min-w-0" min={-60} max={6} step={0.5} value={lane.volumeDb} reset={0}
                       color={lane.color} title={`Volume ${fmtDb(lane.volumeDb)} (double-click: 0 dB)`} dragging={controlDrag}
                       onChange={(v) => set('Lane volume', { volumeDb: v }, `vol-${lane.id}`)} />
            <span className="w-11 text-right text-[10.5px] tabular-nums text-muted">{fmtDb(lane.volumeDb)}</span>
            <BarSlider className="w-12" min={-1} max={1} step={0.05} value={lane.pan} reset={0} origin={0}
                       color={lane.color} title={`Pan ${fmtPan(lane.pan)} (double-click: centre)`} dragging={controlDrag}
                       onChange={(v) => set('Lane pan', { pan: v }, `pan-${lane.id}`)} />
            {lane.duck !== undefined && (
              <BarSlider className="w-10" min={0} max={1} step={0.05} value={lane.duck} reset={0.6} color="#fda4af"
                         title={`Sidechain: ducks ${Math.round(lane.duck * 100)}% under the kick (double-click: 60%)`} dragging={controlDrag}
                         onChange={(v) => set('Sidechain', { duck: v }, `duck-${lane.id}`)} />
            )}
          </div>
        )}
      </div>
      <div onMouseDown={startResize} className="absolute left-0 right-0 -bottom-1 h-2 cursor-row-resize z-10" />
    </div>
  )
}

/**
 * A rectangle filled up to the value (from `origin`, default the minimum): click or drag
 * to set it, double-click to reset. Marks `dragging` so the lane strip doesn't move along.
 */
export function BarSlider({ min, max, step, value, reset, origin = min, color, title, className, dragging, onChange }: {
  min: number
  max: number
  step: number
  value: number
  reset: number
  origin?: number
  color: string
  title: string
  className?: string
  dragging: React.MutableRefObject<boolean>
  onChange: (v: number) => void
}) {
  const frac = (v: number) => (v - min) / (max - min)
  const from = Math.min(frac(origin), frac(value))
  const to = Math.max(frac(origin), frac(value))
  const fromX = (el: HTMLElement, clientX: number) => {
    const r = el.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    return Math.round((min + f * (max - min)) / step) * step
  }
  return (
    <div title={title} role="slider" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
         className={cx('relative h-3.5 rounded-[3px] border border-line bg-raised overflow-hidden cursor-ew-resize', className)}
         onPointerDown={(e) => {
           if (e.button !== 0) return
           e.preventDefault()
           e.stopPropagation()
           dragging.current = true
           e.currentTarget.setPointerCapture(e.pointerId)
           onChange(fromX(e.currentTarget, e.clientX))
         }}
         onPointerMove={(e) => {
           if (e.currentTarget.hasPointerCapture(e.pointerId)) onChange(fromX(e.currentTarget, e.clientX))
         }}
         onPointerUp={() => {
           dragging.current = false
         }}
         onLostPointerCapture={() => {
           dragging.current = false
         }}
         onDoubleClick={() => onChange(reset)}>
      <div className="absolute inset-y-0 opacity-80" style={{ left: `${from * 100}%`, width: `${(to - from) * 100}%`, background: color }} />
      {origin !== min && <div className="absolute inset-y-0 w-px bg-faint/60" style={{ left: `${frac(origin) * 100}%` }} />}
    </div>
  )
}

function ColorPalette({ anchor, value, onPick, onClose }: {
  anchor: DOMRect
  value: string
  onPick: (color: string) => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const top = Math.min(anchor.top, window.innerHeight - 140)
  return createPortal(
    <div className="fixed inset-0 z-50" onMouseDown={onClose}>
      <div className="absolute grid grid-cols-8 gap-1.5 p-2.5 rounded-xl surface-pop"
           style={{ left: anchor.right + 8, top }} onMouseDown={(e) => e.stopPropagation()}>
        {LANE_PALETTE.map((c) => (
          <button key={c} title={c} onClick={() => onPick(c)} style={{ background: c }}
                  className={cx('w-5 h-5 rounded-[4px] hover:scale-110 transition-transform',
                    c === value && 'ring-2 ring-offset-2 ring-offset-[#2a2b2f] ring-text')} />
        ))}
      </div>
    </div>,
    document.body,
  )
}

export function fmtDb(db: number): string {
  return db <= -60 ? '-∞ dB' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`
}

function fmtPan(p: number): string {
  return Math.abs(p) < 0.01 ? 'C' : p < 0 ? `L${Math.round(-p * 100)}` : `R${Math.round(p * 100)}`
}
