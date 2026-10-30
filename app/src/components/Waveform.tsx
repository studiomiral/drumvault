import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { PeakPoints } from '../types/api'

const cache = new Map<string, PeakPoints | null>()
const inflight = new Map<string, Promise<PeakPoints | null>>()
const changed = new Set<(id: number) => void>()

/** The sample's audio changed (Library "Move sound"): drop its peaks and redraw it. */
export function forgetWaveform(id: number): void {
  for (const k of [...cache.keys()]) if (k.startsWith(`${id}:`)) cache.delete(k)
  for (const fn of changed) fn(id)
}

function loadPeaks(id: number, points: number): Promise<PeakPoints | null> {
  const key = `${id}:${points}`
  if (cache.has(key)) return Promise.resolve(cache.get(key)!)
  let p = inflight.get(key)
  if (!p) {
    p = api.peaks(id, points).then((r) => {
      cache.set(key, r)
      inflight.delete(key)
      return r
    }, () => null)
    inflight.set(key, p)
  }
  return p
}

/** Waveform thumbnail drawn from the engine's precomputed peaks (no audio decoding). */
export function Waveform({ id, width, height, color = '#6a6863', points = 120 }: {
  id: number
  width: number
  height: number
  color?: string
  points?: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [peaks, setPeaks] = useState<PeakPoints | null | undefined>(cache.get(`${id}:${points}`))
  const [rev, setRev] = useState(0)
  useEffect(() => {
    const fn = (changedId: number) => changedId === id && setRev((r) => r + 1)
    changed.add(fn)
    return () => {
      changed.delete(fn)
    }
  }, [id])

  useEffect(() => {
    let alive = true
    const hit = cache.get(`${id}:${points}`)
    if (hit !== undefined) setPeaks(hit)
    else void loadPeaks(id, points).then((p) => alive && setPeaks(p))
    return () => {
      alive = false
    }
  }, [id, points, rev])

  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(width * dpr)
    c.height = Math.round(height * dpr)
    const g = c.getContext('2d')!
    g.clearRect(0, 0, c.width, c.height)
    if (!peaks?.length) return
    let max = 0
    for (const [lo, hi] of peaks) max = Math.max(max, Math.abs(lo), Math.abs(hi))
    const scale = max > 0 ? 1 / max : 1
    const mid = c.height / 2
    const barW = c.width / peaks.length
    g.fillStyle = color
    peaks.forEach(([lo, hi], i) => {
      const top = mid - hi * scale * mid
      const bot = mid - lo * scale * mid
      g.fillRect(i * barW, top, Math.max(1, barW - 0.5 * dpr), Math.max(1, bot - top))
    })
  }, [peaks, width, height, color])

  return <canvas ref={ref} style={{ width, height }} />
}
