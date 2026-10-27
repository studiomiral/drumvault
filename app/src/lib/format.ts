import type { Category } from '../types/engine'

export const CATEGORY_LABELS: Record<Category, string> = {
  kick: 'Kick', clap: 'Clap', snare: 'Snare', hat: 'Hat', hat_closed: 'Closed hat',
  hat_open: 'Open hat', ride: 'Ride', cymbal: 'Cymbal', shaker: 'Shaker', perc: 'Perc',
  top: 'Top', groove: 'Groove', drums: 'Full drums', melodic: 'Melodic (key only)',
  full_mix: 'Full mix (key only)', ignore: 'Ignore',
}

export const STEM_CATEGORIES: Category[] = [
  'kick', 'clap', 'snare', 'hat', 'hat_closed', 'hat_open', 'ride', 'cymbal', 'shaker', 'perc',
  'top', 'groove', 'drums', 'melodic', 'full_mix', 'ignore',
]

export function fileName(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath
  return base.replace(/\.wav$/i, '')
}

export function formatDuration(s: number): string {
  if (s < 1) return `${Math.round(s * 1000)} ms`
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
}

export function formatBpm(bpm: number | null | undefined): string {
  if (bpm == null) return '–'
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(2)
}

export function parseJsonArray(s: string | null | undefined): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}
