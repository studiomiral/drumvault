// Section lengths, where things change inside them, and intros and outros where the kick plays
// alone, over tracks made from the user's library (read-only). Not part of `npm test`:
//   DRUMVAULT_REAL_LIBRARY=<library> npx vitest run --config tests/bench/vitest.config.ts phrasing
import { describe, it } from 'vitest'
import { LibraryReader } from '../../electron/db'
import { refine } from '../../src/generate/critic'
import { generate, laneRole, type GenerateOptions, type Generation } from '../../src/generate/generator'
import type { Clip } from '../../src/types/project'
import { out } from './audio'

const LIB = process.env.DRUMVAULT_REAL_LIBRARY
/** Lanes that make a bar more than the kick alone (FX, crashes, impacts, ambience don't; a drum fill does). */
const MUSIC = /^(clap|hats|ride|perc|top|groove|bass|stab|strings|pad|vocal|disco|buildup|fills)/

/** Whether a clip sounds in bar `b` (a pattern: a step in that bar). */
const sounds = (c: Clip, b: number) => {
  if (c.start > b * 4 || c.start + c.length <= b * 4) return false
  if (c.type !== 'pattern') return true
  const k = Math.floor((b * 4 - c.start) / 4) % c.patternBars
  return c.steps.slice(k * 16, (k + 1) * 16).some((v) => v > 0)
}

describe.runIf(!!LIB)('phrasing', () => {
  const r = new LibraryReader(LIB!)
  const samples = r.querySamples({ sort: 'name' })
  const hits = r.listHits()
  const opts: GenerateOptions = { bpm: 124, minMinutes: 4, maxMinutes: 6, zipIds: null, useRatings: true, templates: r.arrangements(),
    stabs: { hits: hits.filter((h) => h.kind === 'stab') }, disco: { hits: hits.filter((h) => h.kind === 'disco') } }

  it('measures', () => {
    const lengths = new Map<string, Map<number, number>>()
    const changes = new Map<string, number>()
    let kickAlone = 0
    const alone: string[] = []
    const N = 200
    for (let i = 0; i < N; i++) {
      const g: Generation = refine(samples, opts, generate(samples, opts, 9000 + i))
      const roleOf = new Map(g.project.lanes.map((l) => [l.id, laneRole(l.name) ?? '']))
      for (const s of g.sections) {
        const m = lengths.get(s.kind) ?? new Map()
        m.set(s.bars, (m.get(s.bars) ?? 0) + 1)
        lengths.set(s.kind, m)
        // Where the halfway moments fall in drops: a disco hit, the groove switching, a vocal or strings coming or going.
        if (s.kind === 'drop') for (const c of g.project.clips) {
          const role = roleOf.get(c.laneId) ?? ''
          if (!/^(disco|groove|vocal|strings)/.test(role)) continue
          // (A disco hit is one hit: only where it starts.)
          for (const [what, edge] of [['in', c.start / 4], ...(/^disco/.test(role) ? [] : [['out', (c.start + c.length) / 4]])] as [string, number][]) {
            const at = Math.round(edge - s.start)
            if (at <= 0 || at >= s.bars || at % 16 === 0) continue
            const k = `drop ${s.bars}: ${role} ${what} at +${at}`
            changes.set(k, (changes.get(k) ?? 0) + 1)
          }
        }
        if (s.kind !== 'intro' && s.kind !== 'outro') continue
        for (let b = s.start; b < s.start + s.bars; b++) {
          const on = new Set(g.project.clips.filter((c) => sounds(c, b)).map((c) => roleOf.get(c.laneId) ?? ''))
          if (on.has('kick') && ![...on].some((x) => MUSIC.test(x))) {
            kickAlone++
            alone.push(`seed ${9000 + i} ${s.kind} bar ${b + 1} (${[...on].join(', ')})`)
            break
          }
        }
      }
    }
    out(`tracks ${N}; intros/outros with a bar of the kick alone: ${kickAlone}`)
    for (const a of alone.slice(0, 8)) out(`  ${a}`)
    for (const [k, m] of lengths) out(`${k.padEnd(6)} ${[...m.entries()].sort((a, b) => a[0] - b[0]).map(([b, n]) => `${b}:${n}`).join('  ')}`)
    out('moments in drops off the 16-bar lines (disco hits, groove, vocal, strings coming in or going): how often:')
    for (const [k, n] of [...changes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) out(`  ${String(n).padStart(4)}  ${k}`)
  })
})
