import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { playback } from '../audio/engine'
import { BEATS_PER_BAR, canReplace, clipEnd, clipsInRange, loopBeats, makeClip, makeLane, makeMarker, nextMarkerName, snap, uid } from '../lib/project'
import { ContextMenu, type MenuEntry } from '../components/ContextMenu'
import {
  clipboardSample, copySelection, cutSelection, deleteSelection, duplicateSelection, hasClipboard, pasteAt, removeFades,
  changeBass, hasBass, newClipBassline, newClipKeysPart, pitchSelection, replaceWith, revealInFinder, shiftSelection, showInLibrary, splitSelectionAt, stepBass, swapForSimilar,
} from './commands'
import { CATEGORY_LABELS } from '../lib/format'
import { MAX_PX_PER_BEAT, MIN_PX_PER_BEAT, useArrange } from '../store/arrange'
import { useProject } from '../store/project'
import type { SampleListItem } from '../types/api'
import type { Clip, LoopRegion, Marker } from '../types/project'
import { drawBase, drawOverlay } from './draw'
import { beatToX, EDGE_PX, laneAt, laneBoxes, lanesHeight, MARKER_H, MIN_SNAP_BEATS, snapUnit, TOP, xToBeat } from './geometry'
import { onPeaks } from './peaks'

export const SAMPLE_MIME = 'application/x-drumvault-sample'

type Drag =
  | { kind: 'move'; x0: number; y0: number; lane0: number; ids: string[]; primary: Clip; copy: boolean; moved: boolean }
  | { kind: 'resize-r' | 'resize-l'; x0: number; ids: string[]; primary: Clip }
  | { kind: 'fade'; side: 'l' | 'r'; ids: string[]; primary: Clip }
  | { kind: 'marquee'; x0: number; y0: number; additive: string[] }
  | { kind: 'ruler'; x0: number; beat0: number; moved: boolean }
  | { kind: 'marker-new'; x0: number; beat0: number }
  | { kind: 'marker'; x0: number; marker: Marker; edge: 'l' | 'r' | null; moved: boolean }

interface Preview {
  dBeats: number
  dLanes: number
  copy: boolean
  resize: 'l' | 'r' | null
  alt: boolean
  /** Dragging a fade: its new length in beats. */
  fade?: { side: 'l' | 'r'; beats: number }
}

export function Timeline({ onMarkerEdit }: { onMarkerEdit: (m: Marker, x: number) => void }) {
  const project = useProject((s) => s.project)
  const selection = useProject((s) => s.selection)
  const editing = useProject((s) => s.editingClip)
  const selectedMarker = useProject((s) => s.selectedMarker)
  const { pxPerBeat: px, scrollX: sx, scrollY: sy, missing, setView } = useArrange()

  const wrap = useRef<HTMLDivElement>(null)
  const base = useRef<HTMLCanvasElement>(null)
  const over = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 800, h: 400 })
  const [peaksVersion, setPeaksVersion] = useState(0)
  const drag = useRef<Drag | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loopPreview, setLoopPreview] = useState<LoopRegion | null>(null)
  const [markerPreview, setMarkerPreview] = useState<Marker | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [drop, setDrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  const boxes = useMemo(() => laneBoxes(project.lanes, sy), [project.lanes, sy])
  const selSet = useMemo(() => new Set(selection), [selection])

  useEffect(() => onPeaks(() => setPeaksVersion((v) => v + 1)), [])

  useLayoutEffect(() => {
    const el = wrap.current!
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keep scroll inside the content.
  const maxX = Math.max(0, (project.lengthBars * BEATS_PER_BAR + 8) * px - size.w)
  const maxY = Math.max(0, lanesHeight(project.lanes) + 60 - (size.h - TOP))
  useEffect(() => {
    if (sx > maxX || sy > maxY) setView({ scrollX: Math.min(sx, maxX), scrollY: Math.min(sy, maxY) })
  }, [sx, sy, maxX, maxY, setView])

  // ---- display model (drag previews applied) ---------------------------------
  const { clips, ghosts } = useMemo(() => {
    if (!preview || (!preview.dBeats && !preview.dLanes && !preview.fade)) return { clips: project.clips, ghosts: [] as Clip[] }
    const moved = selSet
    const lanes = project.lanes
    const transformed = project.clips.filter((c) => moved.has(c.id)).map((c) => transformClip(c, preview, lanes))
    if (preview.copy) return { clips: project.clips, ghosts: transformed }
    return { clips: [...project.clips.filter((c) => !moved.has(c.id)), ...transformed], ghosts: [] }
  }, [project.clips, project.lanes, preview, selSet])

  const markers = useMemo(() => {
    if (!markerPreview) return project.markers
    const exists = project.markers.some((m) => m.id === markerPreview.id)
    return exists ? project.markers.map((m) => (m.id === markerPreview.id ? markerPreview : m)) : [...project.markers, markerPreview]
  }, [project.markers, markerPreview])

  // ---- drawing ---------------------------------------------------------------
  useEffect(() => {
    const c = base.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = size.w * dpr
    c.height = size.h * dpr
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawBase(g, {
      project, boxes, width: size.w, height: size.h, px, sx, clips, ghosts, selection: selSet, editing,
      selectedMarker, missing, loop: loopPreview ?? project.loop, markers,
    })
  }, [project, boxes, size, px, sx, clips, ghosts, selSet, editing, selectedMarker, missing, loopPreview, markers, peaksVersion])

  const drawOver = useCallback(() => {
    const c = over.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    if (c.width !== size.w * dpr) {
      c.width = size.w * dpr
      c.height = size.h * dpr
    }
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const { scrollX } = useArrange.getState()
    drawOverlay(g, { width: size.w, height: size.h, px, sx: scrollX, playhead: playback.position(), marquee, drop })
  }, [size, px, marquee, drop])

  useEffect(() => {
    drawOver()
    let raf = 0
    const loop = () => {
      if (playback.playing) {
        // Follow the playhead.
        const x = beatToX(playback.position(), px, useArrange.getState().scrollX)
        if (x > size.w - 40 || x < 0) {
          setView({ scrollX: Math.max(0, Math.min(maxX, playback.position() * px - 40)) })
        }
        drawOver()
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    const unsub = playback.subscribe(drawOver)
    return () => {
      cancelAnimationFrame(raf)
      unsub()
    }
  }, [drawOver, px, size.w, maxX, setView, sx])

  // ---- wheel: scroll, ⌘/pinch zoom -------------------------------------------------
  useEffect(() => {
    const el = over.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const st = useArrange.getState()
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect()
        const mx = e.clientX - rect.left
        const beat = xToBeat(mx, st.pxPerBeat, st.scrollX)
        const next = Math.min(MAX_PX_PER_BEAT, Math.max(MIN_PX_PER_BEAT, st.pxPerBeat * Math.exp(-e.deltaY * 0.01)))
        st.setView({ pxPerBeat: next, scrollX: Math.max(0, beat * next - mx) })
      } else {
        const dx = e.shiftKey ? e.deltaY : e.deltaX
        const dy = e.shiftKey ? 0 : e.deltaY
        st.setView({ scrollX: Math.max(0, st.scrollX + dx), scrollY: Math.max(0, st.scrollY + dy) })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ---- hit testing -----------------------------------------------------------
  /**
   * The clip under the pointer. Near an edge, the top half drags that side's fade (also at the
   * fade's own handle inside the clip) and the bottom half resizes.
   */
  const clipAt = (x: number, y: number): { clip: Clip; edge: 'l' | 'r' | null; fade: 'l' | 'r' | null } | null => {
    const box = laneAt(boxes, y)
    if (!box || y < TOP) return null
    for (let i = project.clips.length - 1; i >= 0; i--) {
      const c = project.clips[i]
      if (c.laneId !== box.lane.id) continue
      const x0 = beatToX(c.start, px, sx)
      const x1 = beatToX(clipEnd(c), px, sx)
      if (x >= x0 && x <= x1) {
        const wide = x1 - x0 > 3 * EDGE_PX
        if (y < box.y + box.h / 2 && wide) {
          const fi = x0 + (c.fadeIn ?? 0) * px
          const fo = x1 - (c.fadeOut ?? 0) * px
          const fade = Math.abs(x - fi) <= EDGE_PX || x - x0 <= EDGE_PX ? 'l'
            : Math.abs(x - fo) <= EDGE_PX || x1 - x <= EDGE_PX ? 'r' : null
          if (fade) return { clip: c, edge: null, fade }
        }
        const edge = x1 - x <= EDGE_PX && wide ? 'r'
          : x - x0 <= EDGE_PX && c.type === 'audio' && wide ? 'l' : null
        return { clip: c, edge, fade: null }
      }
    }
    return null
  }

  const markerAt = (x: number): { marker: Marker; edge: 'l' | 'r' | null } | null => {
    for (const m of [...project.markers].reverse()) {
      const x0 = beatToX(m.start, px, sx)
      const x1 = beatToX(m.end, px, sx)
      if (x >= x0 && x <= x1) return { marker: m, edge: x - x0 <= EDGE_PX ? 'l' : x1 - x <= EDGE_PX ? 'r' : null }
    }
    return null
  }

  const pos = (e: { clientX: number; clientY: number }) => {
    const r = over.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  /** Snap step at the current zoom (finer when zoomed in); ⌥ snaps four times finer. */
  const unit = (alt: boolean) => snapUnit(px, alt)

  // ---- mouse ----------------------------------------------------------------
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const { x, y } = pos(e)
    const st = useProject.getState()
    const beat = xToBeat(x, px, sx)
    if (y < MARKER_H) {
      const hit = markerAt(x)
      if (hit) {
        st.select(clipsInRange(project.clips, hit.marker.start, hit.marker.end).map((c) => c.id))
        st.selectMarker(hit.marker.id)
        drag.current = { kind: 'marker', x0: x, marker: hit.marker, edge: hit.edge, moved: false }
      } else {
        st.selectMarker(null)
        drag.current = { kind: 'marker-new', x0: x, beat0: Math.max(0, snap(beat, unit(e.altKey))) }
      }
      return
    }
    if (y < TOP) {
      drag.current = { kind: 'ruler', x0: x, beat0: beat, moved: false }
      return
    }
    const hit = clipAt(x, y)
    if (hit) {
      let ids = st.selection
      if (e.shiftKey) {
        ids = ids.includes(hit.clip.id) ? ids.filter((i) => i !== hit.clip.id) : [...ids, hit.clip.id]
        st.select(ids)
        return
      }
      if (!ids.includes(hit.clip.id)) {
        ids = [hit.clip.id]
        st.select(ids)
      }
      if (hit.fade) {
        drag.current = { kind: 'fade', side: hit.fade, ids, primary: hit.clip }
      } else if (hit.edge) {
        drag.current = { kind: hit.edge === 'r' ? 'resize-r' : 'resize-l', x0: x, ids, primary: hit.clip }
      } else {
        const lane0 = laneAt(boxes, y)?.index ?? 0
        drag.current = { kind: 'move', x0: x, y0: y, lane0, ids, primary: hit.clip, copy: e.altKey, moved: false }
      }
      return
    }
    if (!e.shiftKey) st.select([])
    drag.current = { kind: 'marquee', x0: x, y0: y, additive: e.shiftKey ? st.selection : [] }
  }

  const onMouseMove = (e: React.MouseEvent | MouseEvent) => {
    const d = drag.current
    const { x, y } = pos(e)
    if (!d) {
      // Cursor feedback
      const c = over.current!
      if (y < MARKER_H) c.style.cursor = markerAt(x)?.edge ? 'ew-resize' : 'default'
      else if (y < TOP) c.style.cursor = 'text'
      else {
        const hit = clipAt(x, y)
        c.style.cursor = hit?.fade === 'l' ? 'nesw-resize' : hit?.fade === 'r' ? 'nwse-resize' : hit?.edge ? 'ew-resize' : 'default'
      }
      return
    }
    const beat = xToBeat(x, px, sx)
    const u = unit(e.altKey)
    switch (d.kind) {
      case 'move': {
        if (!d.moved && Math.abs(x - d.x0) < 3 && Math.abs(y - d.y0) < 3) return
        d.moved = true
        const raw = (x - d.x0) / px
        const newStart = Math.max(0, snap(d.primary.start + raw, u))
        const lane = laneAt(boxes, Math.max(TOP, y))?.index ?? (y > TOP ? boxes.length - 1 : 0)
        setPreview({ dBeats: newStart - d.primary.start, dLanes: lane - d.lane0, copy: d.copy, resize: null, alt: e.altKey })
        break
      }
      case 'resize-r': {
        const end = Math.max(d.primary.start + Math.min(u, d.primary.length), snap(clipEnd(d.primary) + (x - d.x0) / px, u))
        setPreview({ dBeats: end - clipEnd(d.primary), dLanes: 0, copy: false, resize: 'r', alt: e.altKey })
        break
      }
      case 'resize-l': {
        const start = Math.min(clipEnd(d.primary) - Math.min(u, d.primary.length),
          Math.max(0, snap(d.primary.start + (x - d.x0) / px, u)))
        setPreview({ dBeats: start - d.primary.start, dLanes: 0, copy: false, resize: 'l', alt: e.altKey })
        break
      }
      case 'fade': {
        const c = d.primary
        const raw = d.side === 'l' ? beat - c.start : clipEnd(c) - beat
        const other = (d.side === 'l' ? c.fadeOut : c.fadeIn) ?? 0
        const beats = Math.max(0, Math.min(c.length - other, snap(raw, u)))
        setPreview({ dBeats: 0, dLanes: 0, copy: false, resize: null, alt: e.altKey, fade: { side: d.side, beats } })
        break
      }
      case 'marquee': {
        const m = { x0: d.x0, y0: d.y0, x1: x, y1: y }
        setMarquee(m)
        const bx0 = xToBeat(Math.min(m.x0, m.x1), px, sx)
        const bx1 = xToBeat(Math.max(m.x0, m.x1), px, sx)
        const ys = [Math.min(m.y0, m.y1), Math.max(m.y0, m.y1)]
        const lanesHit = new Set(boxes.filter((b) => b.y < ys[1] && b.y + b.h > ys[0]).map((b) => b.lane.id))
        const hit = project.clips.filter((c) => lanesHit.has(c.laneId) && c.start < bx1 && clipEnd(c) > bx0).map((c) => c.id)
        useProject.getState().select([...new Set([...d.additive, ...hit])])
        break
      }
      case 'ruler': {
        if (!d.moved && Math.abs(x - d.x0) < 4) return
        d.moved = true
        const a = snap(Math.min(d.beat0, beat), u)
        const b = snap(Math.max(d.beat0, beat), u)
        setLoopPreview({ start: Math.max(0, a), end: Math.max(a + u, b), enabled: true })
        break
      }
      case 'marker-new': {
        const b = snap(beat, u)
        const start = Math.max(0, Math.min(d.beat0, b))
        const end = Math.max(d.beat0, b)
        if (end - start >= u) setMarkerPreview({ ...makeMarker(nextMarkerName(project.markers), start, end), id: '__new' })
        break
      }
      case 'marker': {
        if (!d.moved && Math.abs(x - d.x0) < 3) return
        d.moved = true
        const delta = snap((x - d.x0) / px, u)
        const m = d.marker
        const next = d.edge === 'l' ? { ...m, start: Math.max(0, Math.min(m.end - u, m.start + delta)) }
          : d.edge === 'r' ? { ...m, end: Math.max(m.start + u, m.end + delta) }
            : { ...m, start: Math.max(0, m.start + delta), end: Math.max(0, m.start + delta) + (m.end - m.start) }
        setMarkerPreview(next)
        break
      }
    }
  }

  const onMouseUp = (e: MouseEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const st = useProject.getState()
    const { x } = pos(e)
    switch (d.kind) {
      case 'move': {
        if (preview && (preview.dBeats || preview.dLanes)) {
          const p = preview
          const lanes = project.lanes
          if (p.copy) {
            const copies = project.clips.filter((c) => d.ids.includes(c.id))
              .map((c) => ({ ...transformClip(c, p, lanes), id: uid('c') }))
            st.edit(`Copy ${copies.length} clip${copies.length > 1 ? 's' : ''}`, (dr) => {
              dr.clips.push(...copies)
            })
            st.select(copies.map((c) => c.id))
          } else {
            st.edit(`Move ${d.ids.length} clip${d.ids.length > 1 ? 's' : ''}`, (dr) => {
              for (const c of dr.clips) if (d.ids.includes(c.id)) Object.assign(c, transformClip(c as Clip, p, lanes))
            })
          }
        }
        break
      }
      case 'fade': {
        if (preview?.fade) {
          const p = preview
          st.edit(p.fade!.side === 'l' ? 'Fade in' : 'Fade out', (dr) => {
            for (const c of dr.clips) if (d.ids.includes(c.id)) Object.assign(c, transformClip(c as Clip, p, project.lanes))
          })
        }
        break
      }
      case 'resize-r':
      case 'resize-l': {
        if (preview?.dBeats) {
          const p = preview
          st.edit(p.resize === 'r' ? 'Resize clips' : 'Trim clips', (dr) => {
            for (const c of dr.clips) if (d.ids.includes(c.id)) Object.assign(c, transformClip(c as Clip, p, project.lanes))
          })
        }
        break
      }
      case 'marquee':
        setMarquee(null)
        break
      case 'ruler':
        if (d.moved && loopPreview) {
          const lp = loopPreview
          st.edit('Set loop', (dr) => {
            dr.loop = lp
          })
        } else {
          playback.setPosition(Math.max(0, snap(xToBeat(x, px, sx), 1)))
        }
        setLoopPreview(null)
        break
      case 'marker-new': {
        let m = markerPreview ? { ...markerPreview, id: uid('m') } : null
        if (!m) {
          // A click: a section from this bar to the next section (at most 8 bars).
          const bar = Math.floor(d.beat0 / BEATS_PER_BAR) * BEATS_PER_BAR
          const end = Math.min(bar + 8 * BEATS_PER_BAR, ...project.markers.filter((k) => k.start > bar).map((k) => k.start))
          if (end > bar) m = makeMarker(nextMarkerName(project.markers), bar, end)
        }
        if (m) {
          const added = m
          st.edit('Add marker', (dr) => {
            dr.markers.push(added)
          })
          st.selectMarker(added.id)
          onMarkerEdit(added, beatToX(added.start, px, sx))  // type its name right away
        }
        setMarkerPreview(null)
        break
      }
      case 'marker':
        if (d.moved && markerPreview) {
          const m = markerPreview
          st.edit('Move marker', (dr) => {
            const t = dr.markers.find((k) => k.id === m.id)
            if (t) Object.assign(t, m)
          })
          st.select(clipsInRange(useProject.getState().project.clips, m.start, m.end).map((c) => c.id))
          st.selectMarker(m.id)
        }
        setMarkerPreview(null)
        break
    }
    setPreview(null)
  }

  // Track the mouse outside the canvas while dragging.
  useEffect(() => {
    const move = (e: MouseEvent) => drag.current && onMouseMove(e)
    const up = (e: MouseEvent) => onMouseUp(e)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  })

  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = pos(e)
    if (y < MARKER_H) {
      const hit = markerAt(x)
      if (hit) onMarkerEdit(hit.marker, beatToX(hit.marker.start, px, sx))
      return
    }
    const hit = clipAt(x, y)
    if (hit?.clip.type === 'pattern' || (hit?.clip.type === 'audio' && hit.clip.bass)) useProject.getState().openEditor(hit.clip.id)
  }

  // ---- right-click menu ---------------------------------------------------------------
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const { x, y } = pos(e)
    const st = useProject.getState()
    const beat = xToBeat(x, px, sx)
    const u = unit(false)
    const at = Math.max(0, Math.floor(beat / u) * u)    // paste / play position
    const cutAt = Math.max(0, snap(beat, u))             // split position
    const play: MenuEntry = { label: 'Play from here', onClick: () => void playback.play(at) }
    const paste: MenuEntry = { label: 'Paste here', shortcut: '⌘V', disabled: !hasClipboard(), onClick: () => pasteAt(at) }
    let items: MenuEntry[]

    if (y < MARKER_H) {
      const hit = markerAt(x)
      if (!hit) return
      const m = hit.marker
      st.select(clipsInRange(project.clips, m.start, m.end).map((c) => c.id))
      st.selectMarker(m.id)
      items = [
        { label: 'Rename section…', onClick: () => onMarkerEdit(m, beatToX(m.start, px, sx)) },
        { label: 'Duplicate section', shortcut: '⌘D', onClick: duplicateSelection },
        { label: 'Loop this section', onClick: () => st.edit('Set loop', (d) => {
          d.loop = { start: m.start, end: m.end, enabled: true }
        }) },
        { label: 'Play section', onClick: () => void playback.play(m.start) },
        'separator',
        { label: 'Delete section marker', danger: true, title: 'The clips stay', onClick: () => st.edit('Delete marker', (d) => {
          d.markers = d.markers.filter((k) => k.id !== m.id)
        }) },
      ]
    } else if (y < TOP) {
      items = [play, paste]
    } else {
      const hit = clipAt(x, y)
      if (!hit) {
        items = [paste, { label: 'Select all', shortcut: '⌘A', onClick: () => st.select(project.clips.map((c) => c.id)) }, 'separator', play]
      } else {
        const c = hit.clip
        if (!st.selection.includes(c.id)) st.select([c.id])
        const sel = useProject.getState().selection
        const selClips = project.clips.filter((k) => sel.includes(k.id))
        const copied = clipboardSample()
        const n = sel.length
        const many = n > 1 ? ` (${n})` : ''
        items = [
          { label: `Cut${many}`, shortcut: '⌘X', onClick: cutSelection },
          { label: `Copy${many}`, shortcut: '⌘C', onClick: copySelection },
          paste,
          { label: `Duplicate${many}`, shortcut: '⌘D', onClick: duplicateSelection },
          { label: `Delete${many}`, shortcut: '⌫', danger: true, onClick: deleteSelection },
          'separator',
          { label: 'Split here', shortcut: 'S', disabled: !selClips.some((k) => cutAt > k.start && cutAt < clipEnd(k)),
            onClick: () => splitSelectionAt(cutAt) },
          { label: 'Move sound a beat earlier', shortcut: '⇧←', onClick: () => shiftSelection(-1) },
          { label: 'Move sound a beat later', shortcut: '⇧→', onClick: () => shiftSelection(1) },
          ...(selClips.some((k) => k.fadeIn || k.fadeOut) ? [{ label: 'Remove fades', onClick: removeFades }] : []),
          ...(c.type === 'pattern' ? [{ label: 'Edit pattern…', onClick: () => st.openEditor(c.id) }] : []),
          'separator',
          ...(hasBass(selClips, 'keys') ? [
            { label: 'Edit keys notes…', onClick: () => st.openEditor(selClips.find((k) => k.type === 'audio' && k.bass?.role === 'keys')!.id) },
            { label: 'Transpose keys up a semitone', onClick: () => void changeBass('Transpose keys', (b) => ({ ...b, transpose: Math.min(24, b.transpose + 1) }), 'keys') },
            { label: 'Transpose keys down a semitone', onClick: () => void changeBass('Transpose keys', (b) => ({ ...b, transpose: Math.max(-24, b.transpose - 1) }), 'keys') },
            { label: 'Keys octave up', onClick: () => void changeBass('Transpose keys', (b) => ({ ...b, transpose: Math.min(24, b.transpose + 12) }), 'keys') },
            { label: 'Keys octave down', onClick: () => void changeBass('Transpose keys', (b) => ({ ...b, transpose: Math.max(-24, b.transpose - 12) }), 'keys') },
            { label: 'Next keys patch', onClick: () => void stepBass('patch', 1, 'keys') },
            { label: 'Previous keys patch', onClick: () => void stepBass('patch', -1, 'keys') },
            { label: 'Random keys patch', onClick: () => void stepBass('patch', 'random', 'keys') },
            { label: 'New keys part', onClick: () => void newClipKeysPart() },
          ] : []),
          ...(hasBass(selClips) ? [
            { label: 'Edit notes…', title: 'Piano roll: changes every clip of this bassline', onClick: () => st.openEditor(selClips.find((k) => k.type === 'audio' && k.bass && (k.bass.role ?? 'bass') === 'bass')!.id) },
            { label: 'Transpose up a semitone', onClick: () => void changeBass('Transpose bass', (b) => ({ ...b, transpose: Math.min(24, b.transpose + 1) }), 'bass') },
            { label: 'Transpose down a semitone', onClick: () => void changeBass('Transpose bass', (b) => ({ ...b, transpose: Math.max(-24, b.transpose - 1) }), 'bass') },
            { label: 'Octave up', onClick: () => void changeBass('Transpose bass', (b) => ({ ...b, transpose: Math.min(24, b.transpose + 12) }), 'bass') },
            { label: 'Octave down', onClick: () => void changeBass('Transpose bass', (b) => ({ ...b, transpose: Math.max(-24, b.transpose - 12) }), 'bass') },
            { label: 'Next bass patch', title: 'From the Serum patch pool', onClick: () => void stepBass('patch', 1) },
            { label: 'Previous bass patch', onClick: () => void stepBass('patch', -1) },
            { label: 'Random bass patch', onClick: () => void stepBass('patch', 'random') },
            { label: 'New bassline', title: 'Written from what your MIDI basslines have in common, in the same key', onClick: () => void newClipBassline() },
            'separator' as const,
          ] : []),
          ...(selClips.some((k) => !(k.type === 'audio' && k.bass)) ? [
            { label: 'Pitch up a semitone', title: 'Faster and higher, like a sampler; loops stay in time',
              onClick: () => pitchSelection(1) },
            { label: 'Pitch down a semitone', onClick: () => pitchSelection(-1) },
            ...(selClips.some((k) => k.pitch) ? [{ label: 'Original pitch', onClick: () => pitchSelection(null) }] : []),
            ...(selClips.some((k) => k.type === 'audio' && k.loopBars) ? [{ label: 'Play the whole loop', title: 'Not only its first bars',
              onClick: () => st.edit('Play the whole loop', (d) => {
                for (const k of d.clips) if (sel.includes(k.id) && k.type === 'audio') delete k.loopBars
              }) }] : []),
            ...(selClips.some((k) => k.type === 'pattern' && k.groove) ? [{ label: 'Play straight', title: "Without the loop's groove (timing and accents)",
              onClick: () => st.edit('Play straight', (d) => {
                for (const k of d.clips) if (sel.includes(k.id) && k.type === 'pattern') delete k.groove
              }) }] : []),
            'separator' as const,
          ] : []),
          ...(copied && selClips.some((k) => canReplace(k, copied)) && copied.relPath !== c.sample.relPath
            ? [{ label: `Replace with copied sample`, title: copied.name, onClick: () => void replaceWith(copied, 'Replace with copied sample') }]
            : []),
          ...(c.type === 'audio' && c.bass ? [] : [
            { label: 'Swap for a similar sound', title: 'The most similar sample in the library (again for the next one)', onClick: () => void swapForSimilar() },
            'separator' as const,
            { label: 'Show in Library', onClick: () => void showInLibrary(c) },
          ]),
          { label: 'Reveal in Finder', onClick: () => revealInFinder(c) },
        ]
      }
    }
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  // ---- drop from the library panel ------------------------------------------------
  const dropTarget = (e: React.DragEvent, sample: { kind: string; bars: number | null } | null) => {
    const { x, y } = pos(e)
    const u = unit(e.altKey)
    const start = Math.max(0, Math.floor(xToBeat(x, px, sx) / u) * u)
    const box = laneAt(boxes, y)
    const beats = sample && sample.kind !== 'oneshot' ? (sample.bars ?? 1) * BEATS_PER_BAR : 4 * BEATS_PER_BAR
    return { start, box, beats }
  }

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(SAMPLE_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const { start, box, beats } = dropTarget(e, dragSample.current)
    const y = box ? box.y + 3 : (boxes.length ? boxes[boxes.length - 1].y + boxes[boxes.length - 1].h + 3 : TOP + 3)
    setDrop({ x: beatToX(start, px, sx), y, w: beats * px, h: (box?.h ?? 64) - 6 })
  }

  const onDrop = (e: React.DragEvent) => {
    setDrop(null)
    const raw = e.dataTransfer.getData(SAMPLE_MIME)
    if (!raw) return
    e.preventDefault()
    const sample = JSON.parse(raw) as SampleListItem
    const { start, box } = dropTarget(e, sample)
    const st = useProject.getState()
    let laneId = box?.lane.id
    let newLane = null
    if (!laneId) {
      newLane = makeLane(CATEGORY_LABELS[sample.category].replace(/ \(.*\)$/, ''), project.lanes.length)
      laneId = newLane.id
    }
    const clip = makeClip(sample, laneId, start)
    st.edit('Add clip', (dr) => {
      if (newLane) dr.lanes.push(newLane)
      dr.clips.push(clip)
    })
    st.select([clip.id])
    void playback.preload(useProject.getState().project)
  }

  return (
    <div ref={wrap} className="relative flex-1 min-w-0 overflow-hidden"
         onDragOver={onDragOver} onDragLeave={() => setDrop(null)} onDrop={onDrop}>
      <canvas ref={base} className="absolute inset-0" style={{ width: size.w, height: size.h }} />
      <canvas ref={over} className="absolute inset-0" style={{ width: size.w, height: size.h }}
              onMouseDown={onMouseDown} onMouseMove={onMouseMove} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu} />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
      <HScrollbar width={size.w} contentWidth={(project.lengthBars * BEATS_PER_BAR + 8) * px} />
    </div>
  )
}

/** The sample being dragged from the library panel (dataTransfer can't be read during dragover). */
export const dragSample: { current: { kind: string; bars: number | null } | null } = { current: null }

function transformClip(c: Clip, p: Preview, lanes: { id: string }[]): Clip {
  if (p.fade) {
    // The same fade length on every selected clip, as far as each one is long enough.
    const key = p.fade.side === 'l' ? 'fadeIn' : 'fadeOut'
    const other = (p.fade.side === 'l' ? c.fadeOut : c.fadeIn) ?? 0
    const beats = Math.max(0, Math.min(c.length - other, p.fade.beats))
    return { ...c, [key]: beats || undefined }
  }
  if (p.resize === 'r') return fitFades({ ...c, length: Math.max(MIN_SNAP_BEATS, c.length + p.dBeats) })
  if (p.resize === 'l') {
    const d = Math.min(p.dBeats, c.length - MIN_SNAP_BEATS)
    if (c.type !== 'audio') return fitFades({ ...c, start: Math.max(0, c.start + d), length: c.length - d })
    const L = loopBeats(c)
    return fitFades({ ...c, start: Math.max(0, c.start + d), length: c.length - d, trimBeats: (((c.trimBeats + d) % L) + L) % L })
  }
  const li = lanes.findIndex((l) => l.id === c.laneId)
  const lane = lanes[Math.max(0, Math.min(lanes.length - 1, li + p.dLanes))]
  return { ...c, start: Math.max(0, c.start + p.dBeats), laneId: lane.id }
}

/** Fades never overlap: a shortened clip shortens its fades (fade-out first). */
function fitFades<T extends Clip>(c: T): T {
  if (!c.fadeIn && !c.fadeOut) return c
  const fadeOut = Math.min(c.fadeOut ?? 0, c.length)
  const fadeIn = Math.min(c.fadeIn ?? 0, c.length - fadeOut)
  return { ...c, fadeIn: fadeIn || undefined, fadeOut: fadeOut || undefined }
}

function HScrollbar({ width, contentWidth }: { width: number; contentWidth: number }) {
  const { scrollX, setView } = useArrange()
  const max = Math.max(0, contentWidth - width)
  if (max <= 0) return null
  const thumb = Math.max(40, (width / contentWidth) * width)
  const left = (scrollX / max) * (width - thumb)
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    const x0 = e.clientX
    const s0 = scrollX
    const move = (ev: MouseEvent) => setView({ scrollX: Math.max(0, Math.min(max, s0 + ((ev.clientX - x0) / (width - thumb)) * max)) })
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return (
    <div className="absolute left-0 right-0 bottom-0 h-2.5 bg-transparent">
      <div onMouseDown={startDrag} className="absolute top-0.5 h-1.5 rounded-full bg-[rgb(255_255_255/0.18)] hover:bg-[rgb(255_255_255/0.3)]"
           style={{ left, width: thumb }} />
    </div>
  )
}
