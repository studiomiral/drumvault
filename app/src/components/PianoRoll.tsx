// A small piano roll for one bass loop (SCOPE.md §6.7): add, move, resize and delete notes on
// a 16th grid, a velocity lane, and the loop length. Edits are committed when the mouse is let
// go (each commit re-renders the loop through Serum).

import { useEffect, useMemo, useRef, useState } from 'react'
import { cx } from './ui'

/** [start beats, length beats, pitch, velocity] */
export type RollNote = [number, number, number, number]

const ROW = 11
const KEYS_W = 38
const VEL_H = 52
const MIN_STEP_PX = 7
const LOOP_BARS = [1, 2, 4, 8, 16]
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const BLACK = new Set([1, 3, 6, 8, 10])
const EDGE = 5

type Drag =
  | { kind: 'move'; index: number; x0: number; y0: number; orig: RollNote; moved: boolean }
  | { kind: 'resize'; index: number; x0: number; orig: RollNote }
  | { kind: 'velocity'; index: number }

export function PianoRoll({ notes, bars, onChange, playhead, color = '#fda4af' }: {
  notes: RollNote[]
  bars: number
  onChange: (notes: RollNote[], bars: number) => void
  /** Beat inside the loop to draw the playhead at, or null. */
  playhead?: () => number | null
  color?: string
}) {
  const [draft, setDraft] = useState<RollNote[]>(notes)
  const latest = useRef(draft)
  latest.current = draft
  const [selected, setSelected] = useState<number | null>(null)
  const drag = useRef<Drag | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    if (!drag.current) setDraft(notes)
  }, [notes])
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - KEYS_W))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Pitch range: the notes with room around them, at least two octaves.
  const [lo, hi] = useMemo(() => {
    const ps = draft.map((n) => n.at(2)!)
    const min = ps.length ? Math.min(...ps) : 36
    const max = ps.length ? Math.max(...ps) : 52
    const a = Math.max(0, min - 5)
    return [a, Math.min(127, Math.max(max + 6, a + 24))]
  }, [draft])
  const rows = hi - lo + 1
  const steps = bars * 16
  const stepPx = Math.max(MIN_STEP_PX, width / steps)
  const gridW = steps * stepPx
  const beatPx = stepPx * 4
  const yOf = (pitch: number) => (hi - pitch) * ROW

  const commit = (next: RollNote[], nextBars = bars) => {
    const clean = next.filter((n) => n[0] < nextBars * 4 && n[1] > 0)
      .map((n) => [n[0], Math.min(n[1], nextBars * 4 - n[0]), n[2], n[3]] as RollNote)
      .sort((a, b) => a[0] - b[0] || a[2] - b[2])
    setDraft(clean)
    onChange(clean, nextBars)
  }

  const snapOf = (e: { altKey: boolean }) => (e.altKey ? 1 / 16 : 1 / 4)
  /** Pointer position inside the element the handler is on (grid or velocity lane). */
  const pos = (e: { clientX: number; clientY: number; currentTarget: EventTarget }) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onGridDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.focus()
    const { x, y } = pos(e)
    const beat = x / beatPx
    const pitch = hi - Math.floor(y / ROW)
    const hit = draft.findIndex((n) => n[2] === pitch && beat >= n[0] && beat < n[0] + n[1])
    e.currentTarget.setPointerCapture(e.pointerId)
    if (hit >= 0) {
      setSelected(hit)
      const n = draft[hit]
      const endX = (n[0] + n[1]) * beatPx
      drag.current = endX - x <= EDGE ? { kind: 'resize', index: hit, x0: x, orig: n }
        : { kind: 'move', index: hit, x0: x, y0: y, orig: n, moved: false }
      return
    }
    // Add a note (a 16th, or the last selected note's length) and keep dragging to size it.
    const snap = snapOf(e)
    const start = Math.floor(beat / snap) * snap
    const len = selected != null && draft[selected] ? draft[selected][1] : 0.25
    const n: RollNote = [start, Math.min(len, bars * 4 - start), pitch, selected != null && draft[selected] ? draft[selected][3] : 100]
    const next = [...draft, n]
    setDraft(next)
    setSelected(next.length - 1)
    drag.current = { kind: 'resize', index: next.length - 1, x0: (start + n[1]) * beatPx, orig: n }
  }

  const onGridMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const { x, y } = pos(e)
    if (!d) {
      const beat = x / beatPx
      const pitch = hi - Math.floor(y / ROW)
      const n = draft.find((k) => k[2] === pitch && beat >= k[0] && beat < k[0] + k[1])
      e.currentTarget.style.cursor = n && (n[0] + n[1]) * beatPx - x <= EDGE ? 'ew-resize' : n ? 'grab' : 'crosshair'
      return
    }
    const snap = snapOf(e)
    if (d.kind === 'move') {
      if (!d.moved && Math.abs(x - d.x0) < 3 && Math.abs(y - d.y0) < 3) return
      d.moved = true
      const [s0, len, p0, v] = d.orig
      const start = Math.max(0, Math.min(bars * 4 - len, Math.round((s0 + (x - d.x0) / beatPx) / snap) * snap))
      const pitch = Math.max(0, Math.min(127, p0 - Math.round((y - d.y0) / ROW)))
      setDraft((cur) => cur.map((n, i) => (i === d.index ? [start, len, pitch, v] : n)))
    } else if (d.kind === 'resize') {
      const [s0, , p, v] = d.orig
      const end = Math.max(s0 + snap, Math.min(bars * 4, Math.round(((s0 + d.orig[1]) + (x - d.x0) / beatPx) / snap) * snap))
      setDraft((cur) => cur.map((n, i) => (i === d.index ? [s0, end - s0, p, v] : n)))
    }
  }

  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === 'move' && !d.moved) return
    commit(latest.current)
  }

  const remove = (i: number) => {
    setSelected(null)
    commit(draft.filter((_, k) => k !== i))
  }

  const onKey = (e: React.KeyboardEvent) => {
    // Keep these keys away from the arrangement (Backspace would delete clips).
    if ((e.key === 'Backspace' || e.key === 'Delete') && selected != null) {
      e.preventDefault()
      e.stopPropagation()
      remove(selected)
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && selected != null && draft[selected]) {
      e.preventDefault()
      e.stopPropagation()
      const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1)
      commit(draft.map((n, i) => (i === selected ? [n[0], n[1], Math.max(0, Math.min(127, n[2] + d)), n[3]] : n)))
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && selected != null && draft[selected]) {
      e.preventDefault()
      e.stopPropagation()
      const d = (e.key === 'ArrowRight' ? 1 : -1) * (e.altKey ? 1 / 16 : 1 / 4)
      commit(draft.map((n, i) => (i === selected ? [Math.max(0, Math.min(bars * 4 - n[1], n[0] + d)), n[1], n[2], n[3]] : n)))
    }
  }

  // Velocity lane: drag a bar up or down.
  const onVelDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const { x } = pos(e)
    const beat = x / beatPx
    let best = -1
    for (let i = 0; i < draft.length; i++) {
      const n = draft[i]
      if (beat >= n[0] - 1 / 8 && beat < n[0] + Math.max(n[1], 1 / 4) && (best < 0 || Math.abs(n[0] - beat) < Math.abs(draft[best][0] - beat))) best = i
    }
    if (best < 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setSelected(best)
    drag.current = { kind: 'velocity', index: best }
    onVelMove(e)
  }
  const onVelMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.kind !== 'velocity') return
    const { y } = pos(e)
    const v = Math.max(1, Math.min(127, Math.round((1 - y / VEL_H) * 127)))
    setDraft((cur) => cur.map((n, i) => (i === d.index ? [n[0], n[1], n[2], v] : n)))
  }

  // Playhead
  useEffect(() => {
    if (!playhead) return
    let raf = 0
    const tick = () => {
      const b = playhead()
      const el = head.current
      if (el) {
        el.style.display = b == null ? 'none' : 'block'
        if (b != null) el.style.transform = `translateX(${KEYS_W + b * beatPx}px)`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playhead, beatPx])

  const gridLines = []
  for (let s = 0; s <= steps; s++) {
    const strong = s % 16 === 0 ? 'rgb(255 255 255/0.22)' : s % 4 === 0 ? 'rgb(255 255 255/0.09)' : 'rgb(255 255 255/0.035)'
    gridLines.push(<div key={s} className="absolute top-0 bottom-0 w-px" style={{ left: s * stepPx, background: strong }} />)
  }

  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="flex items-center gap-2 text-[12px] text-muted">
        Loop
        {LOOP_BARS.map((b) => (
          <button key={b} onClick={() => commit(draft, b)}
                  className={cx('h-6 px-2 rounded-md', b === bars ? 'bg-accent/20 text-accent' : 'bg-raised hover:text-text')}>
            {b} bar{b === 1 ? '' : 's'}
          </button>
        ))}
        <span className="text-faint ml-2">
          Click to add · drag to move (⌥ finer) · drag the end to resize · right-click or ⌫ to delete · ↑↓ ←→ move the selected note
        </span>
      </div>
      <div ref={wrap} className="relative rounded-lg border border-line bg-[rgb(0_0_0/0.2)] overflow-auto max-h-[300px]"
           style={{ height: Math.min(300, rows * ROW + VEL_H + 8) }}>
        <div className="relative" style={{ width: KEYS_W + gridW, height: rows * ROW + VEL_H + 4 }}>
          {/* Keyboard */}
          <div className="sticky left-0 z-10 float-left bg-panel" style={{ width: KEYS_W, height: rows * ROW }}>
            {Array.from({ length: rows }, (_, i) => {
              const p = hi - i
              return (
                <div key={p} className={cx('border-b border-[rgb(255_255_255/0.04)] text-[9px] leading-[11px] pl-1',
                  BLACK.has(p % 12) ? 'bg-[#1a1b1e] text-faint' : 'bg-[#2a2b2f] text-muted')}
                     style={{ height: ROW }}>
                  {p % 12 === 0 ? `C${Math.floor(p / 12) - 1}` : ''}
                </div>
              )
            })}
          </div>
          {/* Grid */}
          <div tabIndex={0} className="absolute top-0 outline-none" style={{ left: KEYS_W, width: gridW, height: rows * ROW }}
               onPointerDown={onGridDown} onPointerMove={onGridMove} onPointerUp={onUp} onKeyDown={onKey}
               onContextMenu={(e) => {
                 e.preventDefault()
                 const { x, y } = pos(e)
                 const beat = x / beatPx
                 const pitch = hi - Math.floor(y / ROW)
                 const i = draft.findIndex((n) => n[2] === pitch && beat >= n[0] && beat < n[0] + n[1])
                 if (i >= 0) remove(i)
               }}
               onDoubleClick={(e) => {
                 const { x, y } = pos(e)
                 const beat = x / beatPx
                 const pitch = hi - Math.floor(y / ROW)
                 const i = draft.findIndex((n) => n[2] === pitch && beat >= n[0] && beat < n[0] + n[1])
                 if (i >= 0) remove(i)
               }}>
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="absolute left-0 right-0" style={{ top: i * ROW, height: ROW,
                background: BLACK.has((hi - i) % 12) ? 'rgb(0 0 0/0.18)' : 'transparent' }} />
            ))}
            {gridLines}
            {draft.map((n, i) => (
              <div key={i} title={`${NAMES[n[2] % 12]}${Math.floor(n[2] / 12) - 1} · velocity ${n[3]}`}
                   className={cx('absolute rounded-[2px] pointer-events-none', i === selected && 'ring-1 ring-white')}
                   style={{ left: n[0] * beatPx + 1, top: yOf(n[2]) + 1, width: Math.max(3, n[1] * beatPx - 2), height: ROW - 2,
                     background: color, opacity: 0.45 + 0.55 * (n[3] / 127) }} />
            ))}
          </div>
          {/* Velocity lane */}
          <div className="absolute border-t border-line" style={{ left: KEYS_W, top: rows * ROW + 2, width: gridW, height: VEL_H }}
               onPointerDown={onVelDown} onPointerMove={onVelMove} onPointerUp={onUp}>
            {gridLines.filter((_, s) => s % 4 === 0)}
            {draft.map((n, i) => (
              <div key={i} className={cx('absolute bottom-0 w-[4px] rounded-t-[1px]', i === selected ? 'bg-white' : '')}
                   style={{ left: n[0] * beatPx, height: (n[3] / 127) * (VEL_H - 2), background: i === selected ? undefined : color }} />
            ))}
          </div>
          <div ref={head} className="absolute top-0 w-px bg-white/80 pointer-events-none" style={{ height: rows * ROW, left: 0, display: 'none' }} />
        </div>
      </div>
    </div>
  )
}
