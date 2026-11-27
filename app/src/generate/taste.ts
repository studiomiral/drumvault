// What Generate learns from the user's exports (SCOPE.md §6.6, "Learning from exports"): every
// generated track remembers how it was made (`TrackOrigin`, Project.origin); when it is exported,
// what the user changed from there to the version that went out is logged (`ExportRecord`, in
// <Library>/.drumvault/exports.json); new tracks lean that way (`Taste`). Pure and seeded: what a
// track takes from it comes from RNGs of their own, so the rest of a track is the same either way.
//
// Learned and used: the track choices (the values changed to, over those changed away from), the
// sounds (one swapped in and exported comes up more, one swapped out less), the bass patch, the
// tempo, and lanes taken out of a kind of section (the perc out of every breakdown, a lane
// deleted or muted). Logged and shown, not made yet: lanes added to a kind of section.

import type { Genre } from '../types/engine'
import type { Clip, Project } from '../types/project'
import { splitClip } from '../lib/project'
import type { Choice } from './choices'
import type { Generation, Rules } from './generator'
import type { Section } from './structure'
import { Rng } from './rng'

/** A kind of section as the learning tells them apart: the long breakdown is one of its own. */
export type SectionKey = 'intro' | 'build' | 'drop' | 'break' | 'longbreak' | 'outro'

export const SECTION_KEY_LABEL: Record<SectionKey, string> = {
  intro: 'the intro', build: 'builds', drop: 'drops', break: 'short breakdowns', longbreak: 'the long breakdown', outro: 'the outro',
}

export function sectionKey(s: Pick<Section, 'kind' | 'long'>): SectionKey {
  return s.kind === 'break' && s.long ? 'longbreak' : s.kind
}

/** How a generated track was first made: what an export is compared with. */
export interface TrackOrigin {
  /** When it was made (ms since 1970): with the seed, the track's id in the export log. */
  at: number
  seed: number
  genre: Genre
  bpm: number
  /** Its rules as made (the choices' values). */
  rules: Rules
  /** Its sections, [kind, bars, long]: the presence below is per section. */
  sections: [Section['kind'], number, boolean][]
  /** The sound each lane plays most (library-relative path), by role. */
  samples: Record<string, string>
  /** The bass's Serum patch (path). */
  bassPreset: string | null
  /** Per role, the share of each section's bars it sounds in (muted lanes: none). */
  presence: Record<string, number[]>
}

/** What one export changed from its track's origin. */
export interface ExportRecord {
  /** `${origin.at}-${origin.seed}`: a later export of the same track replaces its record. */
  id: string
  /** When it was exported (ISO). */
  at: string
  name: string
  genre: Genre
  /** Tempo as made and as exported. */
  bpm: [number, number]
  /** Every choice the track showed (and any other changed): [as made, as exported]. */
  rules: Record<string, [unknown, unknown]>
  /** Sounds swapped: role → [as made, as exported]. */
  samples: Record<string, [string | null, string | null]>
  bassPreset?: [string | null, string | null]
  /** Per role, per kind of section: taken out of it, kept in it, or added to it. */
  sections: Record<string, Partial<Record<SectionKey, 'out' | 'kept' | 'added'>>>
  /** The bassline it went out with, when it was saved to the library then (its id). */
  bassline?: number
}

/** What new tracks take from the export log (one genre's). */
export interface Taste {
  /** How many exports it comes from. */
  tracks: number
  /** Per choice: how often a track takes a value from here (0…1), and the weight of each option. */
  rules: Record<string, { strength: number; weights: [unknown, number][]; changed: number }>
  /** Sound weights (library-relative path → a factor on how likely it's picked). */
  samples: Record<string, number>
  /** Bass patch weights (path → a factor). */
  presets: Record<string, number>
  /** Tempos the user moved tracks to, and how often a track takes one of them. */
  tempo: { bpms: number[]; strength: number } | null
  /** Per role, per kind of section: how often a new track leaves it out there (0…1). */
  cuts: Record<string, Partial<Record<SectionKey, number>>>
  /** Per role, per kind of section: how many exports added it there (shown only). */
  adds: Record<string, Partial<Record<SectionKey, number>>>
}

// ---- thresholds ----

/** A section's share of bars a role sounds in to count as playing there, and under which it's out. */
const PLAYS = 0.25
const SILENT = 0.05
/** Score of a choice value changed to, of the one changed away from, and of one heard and kept. */
const CHANGED_TO = 1
const CHANGED_FROM = -0.5
const KEPT = 0.2
/** Changes of a choice that make half of the new tracks take it from here; at most this share does. */
const RULE_HALF = 1.5
const MAX_STRENGTH = 0.85
/** A sound swapped in and exported: ×(1 + this) per export, up to MAX_BOOST; one swapped out ×CUT_FACTOR per export, down to MIN_FACTOR. */
const SWAP_IN = 1.5
const MAX_BOOST = 4
const CUT_FACTOR = 0.35
const MIN_FACTOR = 0.1
/** A role is left out of a kind of section once it was taken out of it this many times, this often. */
const CUT_MIN = 2
const CUT_SHARE = 0.6
/** Tempo moves that make half of the new tracks take one of those tempos. */
const TEMPO_HALF = 1.5

/** The lane a role plays in, by the lane's role (`roleOf`: the generator's laneRole, or an added lane's own). */
type RoleOf = (laneName: string, extra?: string) => string | undefined

/** Per role, the share of each section's bars it sounds in (muted lanes count as silent). */
export function presenceOf(project: Project, sections: Section[], roleOf: RoleOf): Record<string, number[]> {
  const lanes = new Map(project.lanes.filter((l) => !l.mute).map((l) => [l.id, roleOf(l.name, l.extra)]))
  const bars: Record<string, Set<number>> = {}
  for (const c of project.clips) {
    const role = lanes.get(c.laneId)
    if (!role) continue
    const set = (bars[role] ??= new Set())
    // A bar counts when the clip plays at least a beat of it.
    for (let b = Math.floor(c.start / 4); b * 4 < c.start + c.length; b++) {
      if (Math.min(c.start + c.length, b * 4 + 4) - Math.max(c.start, b * 4) >= 1) set.add(b)
    }
  }
  const out: Record<string, number[]> = {}
  for (const [role, set] of Object.entries(bars)) {
    out[role] = sections.map((s) => {
      let n = 0
      for (let b = s.start; b < s.start + s.bars; b++) if (set.has(b)) n++
      return s.bars ? n / s.bars : 0
    })
  }
  return out
}

/** The sound each role plays most (by beats). */
export function mainSamples(project: Project, roleOf: RoleOf): Record<string, string> {
  const lanes = new Map(project.lanes.filter((l) => !l.mute).map((l) => [l.id, roleOf(l.name, l.extra)]))
  const beats: Record<string, Map<string, number>> = {}
  for (const c of project.clips) {
    const role = lanes.get(c.laneId)
    // (A rendered part's file is a render, not a sound of the library: the bass goes by its patch.)
    if (!role || (c.type === 'audio' && c.bass)) continue
    const m = (beats[role] ??= new Map())
    m.set(c.sample.relPath, (m.get(c.sample.relPath) ?? 0) + c.length)
  }
  return Object.fromEntries(Object.entries(beats).map(([r, m]) => [r, [...m].sort((a, b) => b[1] - a[1])[0][0]]))
}

/** The bass patch a project plays. */
export function bassPresetOf(project: Project): string | null {
  for (const c of project.clips) if (c.type === 'audio' && c.bass && (c.bass.role ?? 'bass') === 'bass') return c.bass.preset
  return null
}

/** A generation's origin, as it is now (taken when it's made). */
export function originOf(g: Generation, roleOf: RoleOf, at = Date.now()): TrackOrigin {
  return {
    at, seed: g.seed, genre: g.project.genre, bpm: g.project.bpm,
    rules: structuredClone(g.rules),
    sections: g.sections.map((s) => [s.kind, s.bars, !!s.long]),
    samples: mainSamples(g.project, roleOf),
    bassPreset: bassPresetOf(g.project),
    presence: presenceOf(g.project, g.sections, roleOf),
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * What an export changed: `g` is the exported track (its project and generation), `origin` how it
 * was made, `shown` the choices it showed, `all` every choice.
 */
export function recordOf(g: Generation, origin: TrackOrigin, shown: Choice[], all: Choice[], roleOf: RoleOf): ExportRecord {
  const value = (c: Choice, rules: Rules) => rules[c.rule] ?? c.unset ?? null
  const rules: ExportRecord['rules'] = {}
  for (const c of all) {
    const from = value(c, origin.rules)
    const to = value(c, g.rules)
    if (shown.includes(c) || !same(from, to)) rules[c.rule] = [from, to]
  }
  const finalSamples = mainSamples(g.project, roleOf)
  const samples: ExportRecord['samples'] = {}
  for (const role of new Set([...Object.keys(origin.samples), ...Object.keys(finalSamples)])) {
    const a = origin.samples[role] ?? null
    const b = finalSamples[role] ?? null
    if (a !== b) samples[role] = [a, b]
  }
  const preset = bassPresetOf(g.project)
  // Where the roles play, section by section (only while the track has the sections it was made with).
  const sections: ExportRecord['sections'] = {}
  const sameShape = same(origin.sections, g.sections.map((s) => [s.kind, s.bars, !!s.long]))
  if (sameShape) {
    const now = presenceOf(g.project, g.sections, roleOf)
    for (const role of new Set([...Object.keys(origin.presence), ...Object.keys(now)])) {
      const a = origin.presence[role] ?? []
      const b = now[role] ?? []
      const byKey: Partial<Record<SectionKey, { had: number; out: number; added: boolean; any: boolean }>> = {}
      g.sections.forEach((s, i) => {
        const k = sectionKey(s)
        const e = (byKey[k] ??= { had: 0, out: 0, added: false, any: false })
        const was = a[i] ?? 0
        const is = b[i] ?? 0
        if (was >= PLAYS) {
          e.had++
          if (is < SILENT) e.out++
        }
        if (was >= SILENT) e.any = true
        if (was < SILENT && is >= PLAYS) e.added = true
      })
      const r: Partial<Record<SectionKey, 'out' | 'kept' | 'added'>> = {}
      for (const [k, e] of Object.entries(byKey) as [SectionKey, NonNullable<(typeof byKey)[SectionKey]>][]) {
        if (e.had) r[k] = e.out * 2 >= e.had ? 'out' : 'kept'
        else if (!e.any && e.added) r[k] = 'added'
      }
      if (Object.keys(r).length) sections[role] = r
    }
  }
  return {
    id: `${origin.at}-${origin.seed}`, at: new Date().toISOString(), name: g.project.name, genre: g.project.genre,
    bpm: [origin.bpm, g.project.bpm], rules, samples,
    ...(origin.bassPreset || preset ? { bassPreset: [origin.bassPreset, preset] as [string | null, string | null] } : {}),
    sections,
  }
}

/** What new tracks of `genre` take from the export log. Null without exports of it. */
export function learnTaste(records: ExportRecord[], genre: Genre, choices: Choice[]): Taste | null {
  const recs = records.filter((r) => r.genre === genre)
  if (!recs.length) return null
  // ---- the choices ----
  const rules: Taste['rules'] = {}
  for (const c of choices) {
    const score = new Map<string, number>()
    const add = (v: unknown, x: number) => {
      const k = JSON.stringify(v ?? null)
      score.set(k, (score.get(k) ?? 0) + x)
    }
    let changed = 0
    for (const r of recs) {
      const fromTo = r.rules[c.rule]
      if (!fromTo) continue
      const [from, to] = fromTo
      if (same(from, to)) add(to, KEPT)
      else {
        changed++
        add(to, CHANGED_TO)
        add(from, CHANGED_FROM)
      }
    }
    // (Only a choice the user changed at least once: what was heard and kept alone says the generator's own odds.)
    if (!changed) continue
    const weights = c.options.map((o) => [o.value, Math.exp(score.get(JSON.stringify(o.value ?? null)) ?? 0)] as [unknown, number])
    rules[c.rule] = { strength: Math.min(MAX_STRENGTH, changed / (changed + RULE_HALF)), weights, changed }
  }
  // ---- sounds and bass patches ----
  const factors = (pairs: [string | null, string | null][]) => {
    const inn = new Map<string, number>()
    const out = new Map<string, number>()
    for (const [a, b] of pairs) {
      if (a === b) continue
      if (b) inn.set(b, (inn.get(b) ?? 0) + 1)
      if (a) out.set(a, (out.get(a) ?? 0) + 1)
    }
    const f: Record<string, number> = {}
    for (const p of new Set([...inn.keys(), ...out.keys()])) {
      const n = (inn.get(p) ?? 0) - (out.get(p) ?? 0)
      if (n > 0) f[p] = Math.min(MAX_BOOST, 1 + SWAP_IN * n)
      else if (n < 0) f[p] = Math.max(MIN_FACTOR, CUT_FACTOR ** -n)
    }
    return f
  }
  const samples = factors(recs.flatMap((r) => Object.values(r.samples)))
  const presets = factors(recs.flatMap((r) => (r.bassPreset ? [r.bassPreset] : [])))
  // ---- tempo ----
  const moved = recs.filter((r) => r.bpm[0] !== r.bpm[1]).map((r) => r.bpm[1])
  const tempo = moved.length ? { bpms: moved, strength: Math.min(MAX_STRENGTH, moved.length / (moved.length + TEMPO_HALF)) } : null
  // ---- where the roles play ----
  const cuts: Taste['cuts'] = {}
  const adds: Taste['adds'] = {}
  const count: Record<string, Partial<Record<SectionKey, { out: number; kept: number; added: number }>>> = {}
  for (const r of recs) {
    for (const [role, ks] of Object.entries(r.sections)) {
      for (const [k, v] of Object.entries(ks) as [SectionKey, 'out' | 'kept' | 'added'][]) {
        const e = ((count[role] ??= {})[k] ??= { out: 0, kept: 0, added: 0 })
        e[v]++
      }
    }
  }
  for (const [role, ks] of Object.entries(count)) {
    for (const [k, e] of Object.entries(ks) as [SectionKey, { out: number; kept: number; added: number }][]) {
      // (The kick always plays in drops: four on the floor.)
      if (role === 'kick' && k === 'drop') continue
      // (Put back where a track had left it out: that counts against leaving it out.)
      const against = e.kept + e.added
      if (e.out >= CUT_MIN && e.out / (e.out + against) >= CUT_SHARE) (cuts[role] ??= {})[k] = e.out / (e.out + against + 0.5)
      if (e.added) (adds[role] ??= {})[k] = e.added
    }
  }
  return { tracks: recs.length, rules, samples, presets, tempo, cuts, adds }
}

/** The choices a new track takes from the taste (its own RNG): soft locks, under the user's. */
export function tasteRules(taste: Taste, rng: Rng): Rules {
  const out: Rules = {}
  for (const rule of Object.keys(taste.rules).sort()) {
    const t = taste.rules[rule]
    if (rng.chance(t.strength)) out[rule] = rng.weighted(t.weights)
    else rng.next()
  }
  return out
}

/** A tempo the taste moves a new track to, inside the range it's drawn from; null: the drawn one. */
export function tasteTempo(taste: Taste | null | undefined, rng: Rng, min: number, max: number): number | null {
  const fit = (taste?.tempo?.bpms ?? []).filter((b) => b >= min && b <= max)
  if (!fit.length || !rng.chance(taste!.tempo!.strength)) return null
  return rng.pick(fit)
}

/** Clips with the beats [a, b) of lane `laneId` taken out. */
function cutOut(clips: Clip[], laneId: string, a: number, b: number): Clip[] {
  const out: Clip[] = []
  for (const c of clips) {
    if (c.laneId !== laneId || c.start >= b || c.start + c.length <= a) {
      out.push(c)
      continue
    }
    if (c.start < a) out.push(splitClip(c, a)?.[0] ?? c)
    if (c.start + c.length > b) out.push(splitClip(c, b)?.[1] ?? c)
  }
  return out
}

/** The lanes a new track leaves out of the kinds of section the user takes them out of (each by its share, its own RNG). */
export function drawCuts(taste: Taste, rng: Rng): [string, SectionKey][] {
  const out: [string, SectionKey][] = []
  for (const role of Object.keys(taste.cuts).sort()) {
    for (const k of Object.keys(taste.cuts[role]).sort() as SectionKey[]) if (rng.chance(taste.cuts[role][k]!)) out.push([role, k])
  }
  return out
}

/** Those lanes' clips taken out of those kinds of section. Returns the cuts that took something out. */
export function applyCuts(project: Project, sections: Section[], cuts: [string, SectionKey][], roleOf: RoleOf): [string, SectionKey][] {
  const made: [string, SectionKey][] = []
  for (const [role, k] of cuts) {
    const lanes = new Set(project.lanes.filter((l) => roleOf(l.name, l.extra) === role).map((l) => l.id))
    if (!lanes.size) continue
    let touched = false
    for (const s of sections) {
      if (sectionKey(s) !== k) continue
      const a = s.start * 4
      const b = (s.start + s.bars) * 4
      touched ||= project.clips.some((c) => lanes.has(c.laneId) && c.start < b && c.start + c.length > a)
      for (const id of lanes) project.clips = cutOut(project.clips, id, a, b)
    }
    if (touched) made.push([role, k])
  }
  return made
}

/** What the taste says, as lines for the panel (`label`: a choice's and a value's labels; `name`: a role's lane). */
export function describeTaste(
  t: Taste, choices: Choice[], name: (role: string) => string, file: (path: string) => string,
): string[] {
  const lines: string[] = []
  const label = (c: Choice, v: unknown) => c.options.find((o) => same(o.value, v))?.label ?? String(v)
  const ranked = Object.entries(t.rules).sort((a, b) => b[1].changed - a[1].changed)
  for (const [rule, r] of ranked) {
    const c = choices.find((x) => x.rule === rule)
    if (!c) continue
    const best = [...r.weights].sort((a, b) => b[1] - a[1])[0]
    lines.push(`${c.label}: leans to “${label(c, best[0])}” (changed in ${r.changed} export${r.changed === 1 ? '' : 's'}, ${Math.round(r.strength * 100)} % of new tracks)`)
  }
  for (const [role, ks] of Object.entries(t.cuts)) {
    for (const [k, p] of Object.entries(ks) as [SectionKey, number][]) lines.push(`${name(role)}: left out of ${SECTION_KEY_LABEL[k]} (${Math.round(p * 100)} % of new tracks)`)
  }
  for (const [role, ks] of Object.entries(t.adds)) {
    for (const [k, n] of Object.entries(ks) as [SectionKey, number][]) lines.push(`${name(role)}: added to ${SECTION_KEY_LABEL[k]} in ${n} export${n === 1 ? '' : 's'} (noted, not made yet)`)
  }
  if (t.tempo) lines.push(`Tempo: moved to ${[...new Set(t.tempo.bpms)].sort((a, b) => a - b).join(', ')} BPM (${Math.round(t.tempo.strength * 100)} % of new tracks)`)
  const up = Object.entries(t.samples).filter(([, f]) => f > 1).length
  const down = Object.entries(t.samples).filter(([, f]) => f < 1).length
  if (up || down) lines.push(`Sounds: ${up} swapped in come up more, ${down} swapped out less`)
  const pu = Object.entries(t.presets).filter(([, f]) => f > 1).map(([p]) => file(p))
  if (pu.length) lines.push(`Bass patch${pu.length === 1 ? '' : 'es'} preferred: ${pu.slice(0, 3).join(', ')}${pu.length > 3 ? ' …' : ''}`)
  return lines
}

