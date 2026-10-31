// The track choices Generate shows as menus (SCOPE.md §6.6): the rules of generate() a producer
// would decide on, what each value means, and which lanes each one shapes (those are made again
// when it changes on a track). A locked choice holds for every next track (GenerateOptions.locks).
// A layer lane (Clap 2, Perc 2, Tops 4, …) is listed only where the rule moves it: most layers
// play in drops only, so not in the intro, the outro, breakdowns or the bars before a drop.

import type { Generation, Role } from './generator'

export interface Choice {
  rule: string
  label: string
  group: 'Drops' | 'Breakdowns' | 'Builds' | 'Intro & outro' | 'Every 8 and 16 bars' | 'Sound'
  options: { value: unknown; label: string }[]
  /** The lanes it shapes. */
  roles: Role[]
  /** Only on tracks it applies to (with breakdowns, with keys, …). */
  when?: (g: Generation) => boolean
}

const CLAPS: Role[] = ['clap', 'clap2', 'clap3']
const HATS: Role[] = ['hats', 'hats2']
/** The top loops of builds (a fourth plays only in peak drops). */
const BUILD_TOPS: Role[] = ['top', 'top2', 'top3']
/** What plays in the bars before drops (the layers that play in drops only, and the ride, start with them). */
const LEAD_IN: Role[] = ['kick', 'clap', ...HATS, 'perc', ...BUILD_TOPS, 'groove', 'bass', 'keys', 'stab']
/** Everything that stops for the silence before drops (fills, FX, crashes and hits ring through). */
const SILENCED: Role[] = [...LEAD_IN, 'disco', 'disco2', 'atmos']
/** What the mix high-pass before drops rides: the loops (not the moments: risers, fills, impacts, atmos, hits). */
const MIX: Role[] = LEAD_IN

const has = (kind: string) => (g: Generation) => g.sections.some((s) => s.kind === kind)
const yesNo = (yes: string, no: string) => [{ value: true, label: yes }, { value: false, label: no }]
/** Where the intro and outro bring in a part: the half of each next to the drops. */
const NEXT_TO_DROPS = 'the half next to the drops'

export const CHOICES: Choice[] = [
  { rule: 'dropBreath', label: 'Bar before drops', group: 'Drops', roles: [...BUILD_TOPS, 'groove', 'clap', ...HATS, 'perc', 'bass'],
    options: [{ value: null, label: 'everything plays on' }, { value: 'tops', label: 'tops out' }, { value: 'all', label: 'tops, drums and bass out' }] },
  { rule: 'dropSilence', label: 'Silence before drops', group: 'Drops', roles: SILENCED,
    options: [{ value: 0, label: 'none' }, { value: 1, label: '1 beat' }, { value: 2, label: '2 beats' }] },
  { rule: 'dropKickOut', label: 'Kick into drops', group: 'Drops', roles: ['kick'], options: yesNo('four kicks out', 'plays on') },
  { rule: 'dropFill', label: 'Into drops', group: 'Drops', roles: ['fills'],
    options: [{ value: 'roll', label: 'a roll' }, { value: 'fill', label: 'a fill' }, { value: null, label: 'no fill' }] },
  { rule: 'dropRiser', label: 'Riser into drops', group: 'Drops', roles: ['fx', 'fx2'], options: yesNo('yes', 'no') },
  { rule: 'mixHp', label: 'Mix high-passed', group: 'Drops', roles: MIX,
    options: [{ value: 0, label: 'no' }, { value: 1, label: 'the bar before' }, { value: 2, label: '2 bars before' }, { value: 4, label: '4 bars before' }] },
  { rule: 'topsBreaks', label: 'Tops', group: 'Breakdowns', roles: ['top'], when: has('break'),
    options: [{ value: 'filtered', label: 'low-passed' }, { value: 'open', label: 'open' }, { value: 'none', label: 'out' }] },
  { rule: 'hatsInBreaks', label: 'Hats', group: 'Breakdowns', roles: ['hats'], when: has('break'), options: yesNo('high-passed', 'out') },
  { rule: 'bassBreaks', label: 'Bass', group: 'Breakdowns', roles: ['bass'], when: (g) => !!g.bass && has('break')(g),
    options: [{ value: 'filtered', label: 'high-passed' }, { value: 'none', label: 'out' }] },
  { rule: 'keysBreaks', label: 'Keys', group: 'Breakdowns', roles: ['keys'], when: (g) => !!g.keys && has('break')(g),
    options: [{ value: 'full', label: 'open' }, { value: 'filtered', label: 'low-passed' }, { value: 'none', label: 'out' }] },
  { rule: 'stabsIn', label: 'Stabs', group: 'Breakdowns', roles: ['stab'], when: (g) => !!g.rules.stabs,
    options: [{ value: 'drops', label: 'in drops only' }, { value: 'keys', label: 'like keys' }] },
  { rule: 'stabsBreaks', label: 'Stabs in breaks', group: 'Breakdowns', roles: ['stab'],
    when: (g) => !!g.rules.stabs && g.rules.stabsIn === 'keys' && has('break')(g),
    options: [{ value: 'filtered', label: 'low-passed' }, { value: 'none', label: 'out' }] },
  { rule: 'bassBuild', label: 'Bass', group: 'Builds', roles: ['bass'], when: (g) => !!g.bass && has('build')(g),
    options: [{ value: 'filtered', label: 'high-passed' }, { value: 'sweep', label: 'sub sweeps in' }, { value: 'none', label: 'out' }] },
  { rule: 'keysBuild', label: 'Keys', group: 'Builds', roles: ['keys'], when: (g) => !!g.keys && has('build')(g),
    options: [{ value: 'sweep', label: 'filter opens' }, { value: 'filtered', label: 'low-passed' }, { value: 'none', label: 'out' }] },
  { rule: 'stabsBuild', label: 'Stabs', group: 'Builds', roles: ['stab'],
    when: (g) => !!g.rules.stabs && g.rules.stabsIn === 'keys' && has('build')(g),
    options: [{ value: 'sweep', label: 'filter opens' }, { value: 'filtered', label: 'low-passed' }, { value: 'none', label: 'out' }] },
  { rule: 'introHats', label: 'Hats in the intro', group: 'Intro & outro', roles: ['hats'],
    options: [{ value: 'none', label: 'none' }, { value: 'half', label: 'the second half' }, { value: 'all', label: 'all through' }] },
  { rule: 'outroHats', label: 'Hats in the outro', group: 'Intro & outro', roles: ['hats'],
    options: [{ value: 'none', label: 'none' }, { value: 'half', label: 'the first half' }, { value: 'all', label: 'all through' }] },
  { rule: 'bassIO', label: 'Bass', group: 'Intro & outro', roles: ['bass'], when: (g) => !!g.bass,
    options: [{ value: 'none', label: 'none (DJ friendly)' }, { value: 'filtered', label: 'high-passed, half' }] },
  { rule: 'ioClaps', label: 'Claps', group: 'Intro & outro', roles: ['clap'], options: yesNo(NEXT_TO_DROPS, 'none') },
  { rule: 'ioPerc', label: 'Perc', group: 'Intro & outro', roles: ['perc'], options: yesNo(NEXT_TO_DROPS, 'none') },
  { rule: 'phraseCrash', label: 'Crash', group: 'Every 8 and 16 bars', roles: ['crash'], options: yesNo('every 16 bars', 'no') },
  { rule: 'crash8', label: 'Crash every 8', group: 'Every 8 and 16 bars', roles: ['crash'], options: yesNo('yes', 'no') },
  { rule: 'phraseKickOut', label: 'Four kicks out', group: 'Every 8 and 16 bars', roles: ['kick', 'crash'], options: yesNo('every 16 bars', 'no') },
  { rule: 'phraseFill', label: 'Fill', group: 'Every 8 and 16 bars', roles: ['fills'], options: yesNo('every 16 bars', 'no') },
  { rule: 'clapRolls', label: 'Clap rolls', group: 'Every 8 and 16 bars', roles: CLAPS,
    options: [{ value: 'none', label: 'none' }, { value: '16', label: 'every 16 bars' }, { value: '8', label: 'every 8 bars' }] },
  { rule: 'ride', label: 'Ride', group: 'Sound', roles: ['ride', 'crash'],
    options: [{ value: 'late', label: 'later in drop 1' }, { value: 'second', label: 'from drop 2' }, { value: 'both', label: 'late in drop 1, then all through' }] },
  { rule: 'fx', label: 'FX', group: 'Sound', roles: ['fx', 'fx2', 'hits'],
    options: [{ value: 'sparse', label: 'sparse' }, { value: 'normal', label: 'normal' }, { value: 'busy', label: 'busy' }] },
]

export const CHOICE_GROUPS = ['Drops', 'Breakdowns', 'Builds', 'Intro & outro', 'Every 8 and 16 bars', 'Sound'] as const

/** The choices of `g` to show: the ones that apply to it. */
export function choicesFor(g: Generation): Choice[] {
  return CHOICES.filter((c) => !c.when || c.when(g))
}

/** The choices shaping a lane (by its role, or the role it's a layer of). */
export function choicesOfRole(role: Role): Choice[] {
  return CHOICES.filter((c) => c.roles.includes(role))
}

/** A value as an option key (values are JSON: null, booleans, numbers, strings). */
export const optionKey = (v: unknown) => JSON.stringify(v ?? null)

/** The label of a track's value, or the value itself when it isn't one of the options (a template's). */
export function valueLabel(c: Choice, v: unknown): string {
  return c.options.find((o) => optionKey(o.value) === optionKey(v))?.label ?? String(v)
}
