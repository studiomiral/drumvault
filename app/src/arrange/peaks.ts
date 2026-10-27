// Waveform peaks for clips, keyed by sample path (ids can change when zips are reprocessed).

import { api } from '../api'
import type { PeakPoints } from '../types/api'
import type { SampleRef } from '../types/project'

const cache = new Map<string, PeakPoints | null>()
const pending = new Set<string>()
const listeners = new Set<() => void>()

/** Points per loop or event bar / per one-shot. */
const PER_BAR = 96
const ONESHOT = 64

export function clipPeaks(s: SampleRef): PeakPoints | null | undefined {
  const hit = cache.get(s.relPath)
  if (hit !== undefined || s.id == null) return hit
  if (!pending.has(s.relPath)) {
    pending.add(s.relPath)
    const n = s.kind !== 'oneshot' ? (s.bars ?? 1) * PER_BAR : ONESHOT
    void api.peaks(s.id, n).then((p) => {
      cache.set(s.relPath, p)
      pending.delete(s.relPath)
      for (const fn of listeners) fn()
    }, () => pending.delete(s.relPath))
  }
  return undefined
}

export function onPeaks(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The sample's audio changed: fetch its peaks again and redraw. */
export function forgetPeaks(relPath: string): void {
  cache.delete(relPath)
  for (const fn of listeners) fn()
}

export function clearPeaks(): void {
  cache.clear()
}
