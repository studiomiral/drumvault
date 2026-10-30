// Canvas rendering of the timeline. The base layer (grid, markers, ruler, clips) is redrawn
// when something changes; the overlay (playhead, marquee, drop preview) every frame while
// playing. Everything outside the viewport is skipped, so long projects stay smooth.

import { BEATS_PER_BAR, clipEnd, loopBeats, STEPS_PER_BEAT } from '../lib/project'
import type { Clip, LoopRegion, Marker, Project } from '../types/project'
import { beatToX, MARKER_H, RULER_H, rulerStep, TOP, type LaneBox } from './geometry'
import { clipPeaks } from './peaks'

// Translucent fills over the dark background, so lanes, grid and ruler stay subtle.
const C = {
  bg: 'rgba(0, 0, 0, 0)',
  laneA: 'rgba(255, 255, 255, 0.035)',
  laneB: 'rgba(255, 255, 255, 0.012)',
  grid: 'rgba(255, 255, 255, 0.045)',
  gridBeat: 'rgba(255, 255, 255, 0.025)',
  gridBar: 'rgba(255, 255, 255, 0.09)',
  gridBar4: 'rgba(255, 255, 255, 0.16)',
  ruler: 'rgba(255, 255, 255, 0.05)',
  rulerText: '#a6a39d',
  markerBand: 'rgba(255, 255, 255, 0.03)',
  line: 'rgba(255, 255, 255, 0.08)',
  beyond: 'rgba(0, 0, 0, 0.28)',
  accent: '#e2c35f',
  missing: '#f87171',
}

const UI_FONT = '"Hanken Grotesk Variable", system-ui, sans-serif'

export interface BaseInput {
  project: Project
  boxes: LaneBox[]
  width: number
  height: number
  px: number
  sx: number
  clips: Clip[]                 // display clips (with drag previews applied)
  ghosts: Clip[]                // extra semi-transparent clips (copy-drag)
  selection: Set<string>
  editing: string | null
  selectedMarker: string | null
  missing: Set<string>
  loop: LoopRegion              // display loop (with drag preview)
  markers: Marker[]             // display markers (with drag preview)
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  g.beginPath()
  g.moveTo(x + rr, y)
  g.arcTo(x + w, y, x + w, y + h, rr)
  g.arcTo(x + w, y + h, x, y + h, rr)
  g.arcTo(x, y + h, x, y, rr)
  g.arcTo(x, y, x + w, y, rr)
  g.closePath()
}

export function drawBase(g: CanvasRenderingContext2D, d: BaseInput): void {
  const { width: W, height: H, px, sx, project: p } = d
  const endBeat = p.lengthBars * BEATS_PER_BAR
  const firstBeat = Math.max(0, Math.floor(sx / px))
  const lastBeat = Math.ceil((sx + W) / px)
  g.clearRect(0, 0, W, H)
  g.fillStyle = C.bg
  g.fillRect(0, 0, W, H)

  // ---- lanes -------------------------------------------------------------
  g.save()
  g.beginPath()
  g.rect(0, TOP, W, H - TOP)
  g.clip()
  for (const b of d.boxes) {
    if (b.y + b.h < TOP || b.y > H) continue
    g.fillStyle = b.index % 2 ? C.laneB : C.laneA
    g.fillRect(0, b.y, W, b.h)
  }
  const lanesBottom = d.boxes.length ? d.boxes[d.boxes.length - 1].y + d.boxes[d.boxes.length - 1].h : TOP

  // Grid: 16ths when zoomed in, beats, bars (every 4th bar stronger).
  const showBeats = px >= 10
  const show16 = px >= 56
  for (let beat = firstBeat; beat <= lastBeat; beat++) {
    const x = Math.round(beatToX(beat, px, sx)) + 0.5
    const isBar = beat % BEATS_PER_BAR === 0
    if (!isBar && !showBeats) continue
    g.strokeStyle = isBar ? (beat % 16 === 0 ? C.gridBar4 : C.gridBar) : C.gridBeat
    g.beginPath()
    g.moveTo(x, TOP)
    g.lineTo(x, lanesBottom)
    g.stroke()
    if (show16) {
      g.strokeStyle = C.grid
      for (let s = 1; s < STEPS_PER_BEAT; s++) {
        const xs = Math.round(beatToX(beat + s / STEPS_PER_BEAT, px, sx)) + 0.5
        g.beginPath()
        g.moveTo(xs, TOP)
        g.lineTo(xs, lanesBottom)
        g.stroke()
      }
    }
  }
  for (const b of d.boxes) {
    g.strokeStyle = C.line
    g.beginPath()
    g.moveTo(0, Math.round(b.y + b.h) + 0.5)
    g.lineTo(W, Math.round(b.y + b.h) + 0.5)
    g.stroke()
  }

  // Selected section, loop region and the area after the project end.
  const sel = d.markers.find((m) => m.id === d.selectedMarker)
  if (sel) {
    g.fillStyle = `${sel.color}12`
    g.fillRect(beatToX(sel.start, px, sx), TOP, (sel.end - sel.start) * px, lanesBottom - TOP)
  }
  if (d.loop.enabled) {
    g.fillStyle = '#e2c35f0a'
    g.fillRect(beatToX(d.loop.start, px, sx), TOP, (d.loop.end - d.loop.start) * px, lanesBottom - TOP)
  }
  const endX = beatToX(endBeat, px, sx)
  if (endX < W) {
    g.fillStyle = C.beyond
    g.fillRect(endX, TOP, W - endX, H - TOP)
  }

  // ---- clips ---------------------------------------------------------------
  const laneBox = new Map(d.boxes.map((b) => [b.lane.id, b]))
  for (const c of d.clips) drawClip(g, c, laneBox.get(c.laneId), d, 1)
  for (const c of d.ghosts) drawClip(g, c, laneBox.get(c.laneId), d, 0.5)
  g.restore()

  // ---- markers band ------------------------------------------------------
  g.fillStyle = C.markerBand
  g.fillRect(0, 0, W, MARKER_H)
  if (!d.markers.length) {
    g.fillStyle = '#707070'
    g.font = `11px ${UI_FONT}`
    g.textBaseline = 'middle'
    g.fillText('Sections — click or drag here to add one (Intro, Build, Drop, Break, Outro …)', 8, MARKER_H / 2 + 0.5)
  }
  for (const m of d.markers) {
    const x0 = beatToX(m.start, px, sx)
    const x1 = beatToX(m.end, px, sx)
    if (x1 < 0 || x0 > W) continue
    const selected = m.id === d.selectedMarker
    g.fillStyle = selected ? `${m.color}40` : `${m.color}22`
    roundRect(g, x0 + 1, 3, Math.max(2, x1 - x0 - 2), MARKER_H - 6, 4)
    g.fill()
    g.fillStyle = m.color
    g.fillRect(x0 + 1, 3, 3, MARKER_H - 6)
    if (selected) {
      g.strokeStyle = m.color
      g.lineWidth = 1.5
      roundRect(g, x0 + 1, 3, Math.max(2, x1 - x0 - 2), MARKER_H - 6, 4)
      g.stroke()
      g.lineWidth = 1
    }
    g.save()
    g.beginPath()
    g.rect(x0 + 6, 0, Math.max(0, x1 - x0 - 10), MARKER_H)
    g.clip()
    g.fillStyle = '#ecebe8'
    g.font = `600 11px ${UI_FONT}`
    g.textBaseline = 'middle'
    g.fillText(m.name, Math.max(x0 + 8, 4), MARKER_H / 2 + 0.5)
    g.restore()
  }

  // ---- ruler --------------------------------------------------------------
  g.fillStyle = C.ruler
  g.fillRect(0, MARKER_H, W, RULER_H)
  if (d.loop.end > d.loop.start) {
    const x0 = beatToX(d.loop.start, px, sx)
    const w = (d.loop.end - d.loop.start) * px
    if (d.loop.enabled) {
      const grad = g.createLinearGradient(x0, 0, x0 + w, 0)
      grad.addColorStop(0, '#e2c35f55')
      grad.addColorStop(1, '#e2c35f40')
      g.fillStyle = grad
    } else {
      g.fillStyle = '#ffffff1f'
    }
    roundRect(g, x0, MARKER_H + 2, w, 7, 3)
    g.fill()
  }
  const step = rulerStep(px)
  g.font = `11px ${UI_FONT}`
  g.textBaseline = 'alphabetic'
  for (let bar = Math.floor(firstBeat / 4); bar * 4 <= lastBeat; bar++) {
    const x = Math.round(beatToX(bar * 4, px, sx)) + 0.5
    const label = bar % step === 0
    g.strokeStyle = label ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.12)'
    g.beginPath()
    g.moveTo(x, TOP - (label ? 12 : 6))
    g.lineTo(x, TOP)
    g.stroke()
    if (label) {
      g.fillStyle = bar * 4 >= endBeat ? '#5d5b57' : C.rulerText
      g.fillText(String(bar + 1), x + 4, TOP - 5)
    }
  }
  g.strokeStyle = C.line
  g.beginPath()
  g.moveTo(0, TOP - 0.5)
  g.lineTo(W, TOP - 0.5)
  g.moveTo(0, MARKER_H - 0.5)
  g.lineTo(W, MARKER_H - 0.5)
  g.stroke()
}

function drawClip(g: CanvasRenderingContext2D, c: Clip, box: LaneBox | undefined, d: BaseInput, alpha: number): void {
  if (!box) return
  const { px, sx, width: W } = d
  const x0 = beatToX(c.start, px, sx)
  const x1 = beatToX(clipEnd(c), px, sx)
  if (x1 < -2 || x0 > W + 2 || box.y + box.h < TOP || box.y > d.height) return
  const y = box.y + 3
  const h = box.h - 6
  const w = Math.max(3, x1 - x0 - 1)
  const color = box.lane.color
  const selected = d.selection.has(c.id)
  const missing = d.missing.has(c.sample.relPath)
  g.save()
  g.globalAlpha = alpha
  roundRect(g, x0 + 0.5, y, w, h, 5)
  g.fillStyle = selected ? `${color}4d` : `${color}2b`
  g.fill()
  g.lineWidth = selected ? 2 : 1
  g.strokeStyle = missing ? C.missing : selected ? color : `${color}88`
  g.stroke()
  g.clip()

  const bodyTop = y + (h >= 34 ? 15 : 2)
  const bodyH = y + h - bodyTop - 3
  if (c.type === 'audio') drawLoopBody(g, c, x0, x1, bodyTop, bodyH, px, color, W)
  else drawPatternBody(g, c, x0, x1, bodyTop, bodyH, px, color, W)
  drawFades(g, c, x0, x1, y, h, px, color, selected)

  if (h >= 34 && w >= 40) {
    g.fillStyle = missing ? C.missing : '#ecebe8'
    g.font = `${selected ? 600 : 500} 11px ${UI_FONT}`
    g.textBaseline = 'top'
    const filt = c.filter ? ` · ${c.filter.type === 'lowpass' ? 'LP' : 'HP'}${c.filter.to != null ? ' sweep' : ''}` : ''
    const pitch = c.pitch ? ` · ${c.pitch > 0 ? '+' : '−'}${Math.abs(c.pitch)} st` : ''
    const verb = c.verb ? ` · verb${c.verb.to > c.verb.from ? ' build' : ''}` : ''
    const part = c.type === 'audio' && c.loopBars ? ` · ${c.loopBars === 1 ? 'bar 1' : `bars 1–${c.loopBars}`}` : ''
    const label = (missing ? '⚠ missing: ' : '') + shortName(c.sample.name) + filt + verb + pitch + part
    g.fillText(label, Math.max(x0 + 6, 4), y + 3)
  }
  if (d.editing === c.id) {
    g.strokeStyle = C.accent
    g.lineWidth = 2
    g.setLineDash([4, 3])
    roundRect(g, x0 + 2, y + 2, w - 3, h - 4, 4)
    g.stroke()
  }
  g.restore()
}

/** Fade-in / fade-out: the faded-away part is shaded above a line from the edge to the handle. */
function drawFades(g: CanvasRenderingContext2D, c: Clip, x0: number, x1: number, y: number, h: number,
                   px: number, color: string, selected: boolean): void {
  const sides: [number, number][] = []
  if (c.fadeIn) sides.push([x0, x0 + c.fadeIn * px])
  if (c.fadeOut) sides.push([x1, x1 - c.fadeOut * px])
  for (const [edge, handle] of sides) {
    g.beginPath()
    g.moveTo(edge, y)
    g.lineTo(handle, y)
    g.lineTo(edge, y + h)
    g.closePath()
    g.fillStyle = 'rgba(12,12,14,0.55)'
    g.fill()
    g.beginPath()
    g.moveTo(edge, y + h)
    g.lineTo(handle, y)
    g.strokeStyle = color
    g.lineWidth = 1.25
    g.stroke()
    if (selected) {
      g.fillStyle = color
      g.fillRect(Math.round(handle) - 3, y + 1, 6, 6)
    }
  }
}

function shortName(name: string): string {
  // OS_Kick_Am_S0001-deep-groove_01 -> Kick · S0001 01
  const m = name.match(/^(?:OS|LP|FX|FL)_([A-Za-z]+)_(?:[\d.]+_)?[^_]+_([SP]\d{4})[^_]*_(?:(\d+bar)_)?(\d+)$/)
  return m ? `${m[1]} · ${m[2]}${m[3] ? ` · ${m[3]}` : ''} · ${m[4]}` : name
}

function drawLoopBody(g: CanvasRenderingContext2D, c: Clip & { type: 'audio' }, x0: number, x1: number,
                      top: number, h: number, px: number, color: string, W: number): void {
  const L = loopBeats(c)
  const trim = ((c.trimBeats % L) + L) % L
  // Loop seams
  g.strokeStyle = `${color}55`
  for (let b = c.start + (L - trim); b < c.start + c.length; b += L) {
    const x = Math.round(x0 + (b - c.start) * px) + 0.5
    g.beginPath()
    g.moveTo(x, top - 12)
    g.lineTo(x, top + h)
    g.stroke()
  }
  const peaks = clipPeaks(c.sample)
  if (!peaks?.length || h < 6) return
  const full = Math.max(1, (c.sample.bars ?? 1) * BEATS_PER_BAR)  // the peaks cover the whole file
  let max = 0
  for (const [lo, hi] of peaks) max = Math.max(max, -lo, hi)
  const scale = max > 0 ? (h / 2) / max : 0
  const mid = top + h / 2
  g.fillStyle = `${color}b0`
  const from = Math.max(0, Math.ceil(x0))
  const to = Math.min(W, Math.ceil(x1))
  for (let x = from; x < to; x += 1) {  // one column per pixel
    const beat = (x - x0) / px
    const content = (((trim + beat) % L) + L) % L
    const i = Math.max(0, Math.min(peaks.length - 1, Math.floor((content / full) * peaks.length)))
    const [lo, hi] = peaks[i]
    g.fillRect(x, mid - hi * scale, 1, Math.max(1, (hi - lo) * scale))
  }
}

function drawPatternBody(g: CanvasRenderingContext2D, c: Clip & { type: 'pattern' }, x0: number, x1: number,
                         top: number, h: number, px: number, color: string, W: number): void {
  const n = c.steps.length
  const stepPx = px / STEPS_PER_BEAT
  const total = Math.round(c.length * STEPS_PER_BEAT)
  const patternBeats = c.patternBars * BEATS_PER_BAR
  // Pattern repeat seams
  g.strokeStyle = `${color}40`
  for (let b = patternBeats; b < c.length; b += patternBeats) {
    const x = Math.round(x0 + b * px) + 0.5
    g.beginPath()
    g.moveTo(x, top - 12)
    g.lineTo(x, top + h)
    g.stroke()
  }
  if (h < 4) return
  const first = Math.max(0, Math.floor((-x0) / stepPx))
  const last = Math.min(total - 1, Math.ceil((W - x0) / stepPx))
  g.fillStyle = color
  for (let i = first; i <= last; i++) {
    const v = c.steps[i % n]
    if (!v) continue
    const x = x0 + i * stepPx
    if (x > x1) break
    const bh = Math.max(2, (h * v) / 3)
    g.fillRect(Math.round(x) + 1, top + h - bh, Math.max(1.5, Math.min(stepPx - 1.5, 6)), bh)
  }
}

export interface OverlayInput {
  width: number
  height: number
  px: number
  sx: number
  playhead: number
  marquee: { x0: number; y0: number; x1: number; y1: number } | null
  drop: { x: number; y: number; w: number; h: number } | null
}

export function drawOverlay(g: CanvasRenderingContext2D, d: OverlayInput): void {
  g.clearRect(0, 0, d.width, d.height)
  if (d.drop) {
    g.fillStyle = '#e2c35f1c'
    g.strokeStyle = '#e2c35f'
    g.setLineDash([4, 3])
    roundRect(g, d.drop.x, d.drop.y, d.drop.w, d.drop.h, 5)
    g.fill()
    g.stroke()
    g.setLineDash([])
  }
  if (d.marquee) {
    const x = Math.min(d.marquee.x0, d.marquee.x1)
    const y = Math.min(d.marquee.y0, d.marquee.y1)
    g.fillStyle = '#e2c35f12'
    g.strokeStyle = '#e2c35f99'
    g.fillRect(x, y, Math.abs(d.marquee.x1 - d.marquee.x0), Math.abs(d.marquee.y1 - d.marquee.y0))
    g.strokeRect(x + 0.5, y + 0.5, Math.abs(d.marquee.x1 - d.marquee.x0), Math.abs(d.marquee.y1 - d.marquee.y0))
  }
  const x = Math.round(beatToX(d.playhead, d.px, d.sx)) + 0.5
  if (x >= -1 && x <= d.width + 1) {
    g.strokeStyle = C.accent
    g.lineWidth = 1.5
    g.beginPath()
    g.moveTo(x, MARKER_H)
    g.lineTo(x, d.height)
    g.stroke()
    g.lineWidth = 1
    g.fillStyle = C.accent
    g.beginPath()
    g.moveTo(x - 6, MARKER_H)
    g.lineTo(x + 6, MARKER_H)
    g.lineTo(x, MARKER_H + 8)
    g.closePath()
    g.fill()
  }
}
