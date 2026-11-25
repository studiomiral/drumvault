// The track choices Generate shows as menus (SCOPE.md §6.6): the rules of generate() a producer
// would decide on, what each value means, and which lanes each one shapes (those are made again
// when it changes on a track). A locked choice holds for every next track (GenerateOptions.locks).
// A layer lane (Clap 2, Perc 2, Tops 4, …) is listed only where the rule moves it: most layers
// play in drops only, so not in the intro, the outro, breakdowns or the bars before a drop.

import { BUILDUP_ROLES, STAB_ROLES, type Generation, type Role } from './generator'

export interface Choice {
  rule: string
  label: string
  group: 'Drops' | 'Breakdowns' | 'Builds' | 'Intro & outro' | 'Every 8 and 16 bars' | 'Sound'
  options: { value: unknown; label: string }[]
  /** The lanes it shapes. */
  roles: Role[]
  /** Only on tracks it applies to (with breakdowns, with stabs, …). */
  when?: (g: Generation) => boolean
  /** Its value on a track made before the rule was. */
  unset?: unknown
}

const CLAPS: Role[] = ['clap', 'clap2', 'clap3']
const HATS: Role[] = ['hats', 'hats2']
/** The top loops of builds (a fourth plays only in peak drops). */
const BUILD_TOPS: Role[] = ['top', 'top2', 'top3']
/** What plays in the bars before drops (the layers that play in drops only, and the ride, start with them). */
const LEAD_IN: Role[] = ['kick', 'clap', ...HATS, 'perc', ...BUILD_TOPS, 'groove', 'bass', ...STAB_ROLES]
/** Everything that stops for the silence before drops (fills, FX, crashes and hits ring through). */
const SILENCED: Role[] = [...LEAD_IN, 'disco', 'disco2', 'atmos']
/** What the mix high-pass before drops rides: the loops (not the moments: risers, fills, impacts, atmos, hits). */
const MIX: Role[] = LEAD_IN

const has = (kind: string) => (g: Generation) => g.sections.some((s) => s.kind === kind)
/** A track that plays its stabs (not a piano track, SCOPE.md §6.9a). */
const stabbing = (g: Generation) => !!g.rules.stabs && g.rules.keys !== 'piano' && g.rules.keys !== 'music'
const RISERS: Role[] = ['fx', 'fx2', 'fx3']
/** What the big build into the drops after the long breakdown shapes. */
const BIG: Role[] = ['kick', 'clap', 'buildup', ...RISERS, 'crash', ...STAB_ROLES, ...BUILD_TOPS, 'groove', 'vocal', 'vchop']
/** A track with a drop after its long breakdown. */
const longDrop = (g: Generation) => g.sections.some((s, i) => s.long && g.sections.slice(i + 1).some((x) => x.kind === 'drop'))
const bigOn = (g: Generation) => g.rules.bigBuild === 'big' && longDrop(g)
const yesNo = (yes: string, no: string) => [{ value: true, label: yes }, { value: false, label: no }]
/** Where the intro and outro bring in a part: the half of each next to the drops. */
const NEXT_TO_DROPS = 'the half next to the drops'

export const CHOICES: Choice[] = [
  { rule: 'dropBreath', label: 'Bar before drops', group: 'Drops', roles: [...BUILD_TOPS, 'groove', 'clap', ...HATS, 'perc', 'bass'],
    options: [{ value: null, label: 'everything plays on' }, { value: 'tops', label: 'tops out' }, { value: 'all', label: 'tops, drums and bass out' }] },
  { rule: 'bassTurn', label: 'Bassline turns', group: 'Drops', roles: ['bass'], when: (g) => !!g.bass, unset: 'none',
    options: [{ value: 'none', label: 'never: the loop all through' }, { value: 'drop', label: 'at the end of each drop' },
      { value: '16', label: 'every 16 bars' }, { value: '8', label: 'every 8 bars' }] },
  { rule: 'bassTurnKind', label: 'Bassline turn', group: 'Drops', roles: ['bass'], when: (g) => !!g.bass && !!g.rules.bassTurn && g.rules.bassTurn !== 'none',
    options: [{ value: 'pickup', label: 'a 16th run into the 1' }, { value: 'gap', label: 'its last beat out' }, { value: 'octave', label: 'its last beat an octave up' }] },
  { rule: 'dropIn', label: 'Way into drops', group: 'Drops', roles: [...SILENCED, 'fills', ...RISERS], when: (g) => g.rules.dropIn != null,
    options: [{ value: 'straight', label: 'straight in' }, { value: 'gap', label: 'a gap, the drum fill alone in it' }, { value: 'suck', label: 'a gap, the FX pulling in' }] },
  { rule: 'dropInBeats', label: 'Gap before drops', group: 'Drops', roles: [...SILENCED, ...RISERS],
    when: (g) => g.rules.dropIn === 'gap' || g.rules.dropIn === 'suck',
    options: [{ value: 1, label: '1 beat' }, { value: 2, label: '2 beats' }, { value: 4, label: 'a bar' }] },
  { rule: 'dropSilence', label: 'Silence before drops', group: 'Drops', roles: SILENCED, when: (g) => g.rules.dropIn == null,
    options: [{ value: 0, label: 'none' }, { value: 1, label: '1 beat' }, { value: 2, label: '2 beats' }] },
  { rule: 'dropKickOut', label: 'Kick into drops', group: 'Drops', roles: ['kick'], options: yesNo('four kicks out', 'plays on') },
  { rule: 'buildup', label: 'Build-up', group: 'Drops', roles: BUILDUP_ROLES, unset: 'none',
    options: [{ value: 'none', label: 'none' }, { value: 'snareRoll', label: 'snare roll, filter opening' }, { value: 'snareSteps', label: 'snare in 4ths, 8ths, 16ths' },
      { value: 'kickRoll', label: 'kick roll, low-passed 8ths' }, { value: 'claps', label: 'claps on every beat' }] },
  { rule: 'buildupBars', label: 'Build-up length', group: 'Drops', roles: ['buildup', 'kick', 'clap'], when: (g) => (g.rules.buildup ?? 'none') !== 'none',
    options: [{ value: 2, label: '2 bars' }, { value: 4, label: '4 bars' }, { value: 8, label: '8 bars' }] },
  { rule: 'buildupCrash', label: 'Crashes into drops', group: 'Drops', roles: ['crash'], unset: 'none',
    options: [{ value: 'none', label: 'none' }, { value: 'faster', label: 'faster and faster' }, { value: 'last4', label: 'on the last 4 counts' }] },
  { rule: 'dropFill', label: 'Into drops', group: 'Drops', roles: BUILDUP_ROLES,
    options: [{ value: 'roll', label: 'a roll' }, { value: 'fill', label: 'a fill' }, { value: null, label: 'no fill' }] },
  { rule: 'dropRiser', label: 'Riser into drops', group: 'Drops', roles: ['fx', 'fx2', 'fx3'], options: yesNo('yes', 'no') },
  { rule: 'firstDrop', label: 'Drop 1', group: 'Drops', roles: ['clap2', 'clap3', 'hats2', 'perc2', 'top2', 'top3', 'groove'],
    when: (g) => g.sections[1]?.kind === 'drop', unset: 'full',
    options: [{ value: 'lean', label: 'leaner at first, full halfway' }, { value: 'full', label: 'full from the start' }] },
  { rule: 'mixHp', label: 'Mix high-passed', group: 'Drops', roles: MIX,
    options: [{ value: 0, label: 'no' }, { value: 1, label: 'the bar before' }, { value: 2, label: '2 bars before' }, { value: 4, label: '4 bars before' }] },
  { rule: 'glue', label: 'Groove', group: 'Breakdowns', roles: ['clap', ...HATS, 'perc', 'perc2', 'top', 'top2', 'top3', 'groove', 'ride'], when: has('break'), unset: false,
    options: yesNo('carries through, filtered', 'each breakdown its own') },
  { rule: 'gluePerc', label: 'Perc', group: 'Breakdowns', roles: ['perc'], when: (g) => !!g.rules.glue && has('break')(g),
    options: [{ value: 'through', label: 'low-passed' }, { value: 'leave', label: 'fades out' }] },
  { rule: 'topsBreaks', label: 'Tops', group: 'Breakdowns', roles: ['top'], when: has('break'),
    options: [{ value: 'filtered', label: 'low-passed' }, { value: 'open', label: 'open' }, { value: 'none', label: 'out' }] },
  { rule: 'hatsInBreaks', label: 'Hats', group: 'Breakdowns', roles: ['hats'], when: has('break'), options: yesNo('high-passed', 'out') },
  { rule: 'bassBreaks', label: 'Bass', group: 'Breakdowns', roles: ['bass'], when: (g) => !!g.bass && has('break')(g),
    options: [{ value: 'filtered', label: 'high-passed' }, { value: 'none', label: 'out' }] },
  { rule: 'stabsIn', label: 'Stabs', group: 'Breakdowns', roles: STAB_ROLES, when: (g) => !!g.rules.stabs,
    options: [{ value: 'drops', label: 'in drops only' }, { value: 'keys', label: 'also breaks & builds' }] },
  { rule: 'stabsBreaks', label: 'Stabs in breaks', group: 'Breakdowns', roles: STAB_ROLES,
    when: (g) => !!g.rules.stabs && g.rules.stabsIn === 'keys' && has('break')(g),
    options: [{ value: 'filtered', label: 'low-passed' }, { value: 'none', label: 'out' }] },
  { rule: 'bassBuild', label: 'Bass', group: 'Builds', roles: ['bass'], when: (g) => !!g.bass && has('build')(g),
    options: [{ value: 'filtered', label: 'high-passed' }, { value: 'sweep', label: 'sub sweeps in' }, { value: 'none', label: 'out' }] },
  { rule: 'stabsBuild', label: 'Stabs', group: 'Builds', roles: STAB_ROLES,
    when: (g) => !!g.rules.stabs && g.rules.stabsIn === 'keys' && has('build')(g),
    options: [{ value: 'sweep', label: 'filter opens' }, { value: 'filtered', label: 'low-passed' }, { value: 'none', label: 'out' }] },
  { rule: 'bigBuild', label: 'Build into the main drop', group: 'Builds', roles: BIG, when: longDrop, unset: 'usual',
    options: [{ value: 'big', label: 'big: layered, stacked risers, effects' }, { value: 'usual', label: 'as into the other drops' }] },
  { rule: 'bigBars', label: 'Main build length', group: 'Builds', roles: ['kick', 'clap', 'buildup', 'fx', 'fx2', ...STAB_ROLES], when: bigOn,
    options: [{ value: 4, label: '4 bars' }, { value: 8, label: '8 bars' }, { value: 16, label: '16 bars' }] },
  { rule: 'bigDrums', label: 'Main build drums', group: 'Builds', roles: ['clap', 'buildup'], when: bigOn,
    options: [{ value: 'both', label: 'claps, a snare joining' }, { value: 'claps', label: 'claps' }, { value: 'snare', label: 'a snare' }] },
  { rule: 'bigSnare', label: 'Main build snare', group: 'Builds', roles: ['buildup'], when: (g) => bigOn(g) && g.rules.bigDrums !== 'claps',
    options: [{ value: 'roll', label: 'a roll: 8ths, then 16ths' }, { value: 'steps', label: 'steps: 4ths, 8ths, 16ths' }] },
  { rule: 'bigKick', label: 'Main build kick', group: 'Builds', roles: ['kick'], when: bigOn,
    options: [{ value: 'out', label: 'out' }, { value: 'back', label: 'back in its second half' }, { value: 'roll', label: 'a roll over its last quarter' }] },
  { rule: 'bigRisers', label: 'Main build risers', group: 'Builds', roles: ['fx3'], when: bigOn,
    options: [{ value: 2, label: 'two: long, and its second half' }, { value: 3, label: 'three: and a short lift into the 1' }] },
  { rule: 'bigVerb', label: 'Main build effects', group: 'Builds', roles: ['clap', 'buildup', ...STAB_ROLES], when: bigOn,
    options: [{ value: 'drums', label: 'reverb and delay on its drums' }, { value: 'stabs', label: 'the stabs' }, { value: 'drums+stabs', label: 'its drums and the stabs' },
      { value: 'drums+tops', label: 'its drums and the top loops' }, { value: 'all', label: 'all: drums, stabs, tops, vocals' }] },
  { rule: 'bigHp', label: 'Main build high-pass', group: 'Builds', roles: MIX.filter((r) => r !== 'clap'), when: bigOn,
    options: [{ value: 0, label: 'as into the other drops' }, { value: 4, label: 'the mix over its last 4 bars' }, { value: 8, label: 'over its last 8 bars' }] },
  { rule: 'bigCrash', label: 'Main build crashes', group: 'Builds', roles: ['crash'], when: bigOn, options: yesNo('faster over its last 4 bars', 'as into the other drops') },
  { rule: 'introHats', label: 'Hats in the intro', group: 'Intro & outro', roles: ['hats'],
    options: [{ value: 'none', label: 'none' }, { value: 'half', label: 'the second half' }, { value: 'all', label: 'all through' }] },
  { rule: 'outroHats', label: 'Hats in the outro', group: 'Intro & outro', roles: ['hats'],
    options: [{ value: 'none', label: 'none' }, { value: 'half', label: 'the first half' }, { value: 'all', label: 'all through' }] },
  { rule: 'bassIO', label: 'Bass', group: 'Intro & outro', roles: ['bass'], when: (g) => !!g.bass,
    options: [{ value: 'none', label: 'none (DJ friendly)' }, { value: 'filtered', label: 'high-passed, half' }] },
  { rule: 'ioClaps', label: 'Claps', group: 'Intro & outro', roles: ['clap'], options: yesNo(NEXT_TO_DROPS, 'none') },
  { rule: 'ioPerc', label: 'Perc', group: 'Intro & outro', roles: ['perc'], options: yesNo(NEXT_TO_DROPS, 'none') },
  { rule: 'ioLift', label: 'Lift', group: 'Intro & outro', roles: ['hats', 'perc', 'top2', 'clap'], unset: false,
    options: yesNo('fills up into the drop', 'no') },
  { rule: 'phraseCrash', label: 'Crash', group: 'Every 8 and 16 bars', roles: ['crash'], options: yesNo('every 16 bars', 'no') },
  { rule: 'crash8', label: 'Crash every 8', group: 'Every 8 and 16 bars', roles: ['crash'], options: yesNo('yes', 'no') },
  { rule: 'phraseKickOut', label: 'Four kicks out', group: 'Every 8 and 16 bars', roles: ['kick', 'crash'], options: yesNo('every 16 bars', 'no') },
  { rule: 'phraseFill', label: 'Fill', group: 'Every 8 and 16 bars', roles: ['fills'], options: yesNo('every 16 bars', 'no') },
  { rule: 'clapRolls', label: 'Clap rolls', group: 'Every 8 and 16 bars', roles: CLAPS,
    options: [{ value: 'none', label: 'none' }, { value: '16', label: 'every 16 bars' }, { value: '8', label: 'every 8 bars' }] },
  { rule: 'hold', label: 'Held for the last drop', group: 'Drops', roles: ['ride', 'perc2', 'hats2', 'groove'], unset: 'none',
    when: (g) => g.sections.filter((s) => s.kind === 'drop').length >= 2,
    options: [{ value: 'ride', label: 'the ride' }, { value: 'perc2', label: 'the second perc' }, { value: 'hats2', label: 'the second hat loop' },
      { value: 'groove', label: 'the groove loop' }, { value: 'none', label: 'nothing' }] },
  { rule: 'ride', label: 'Ride', group: 'Sound', roles: ['ride', 'crash'],
    options: [{ value: 'late', label: 'later in drop 1' }, { value: 'second', label: 'from drop 2' }, { value: 'both', label: 'late in drop 1, then all through' }] },
  { rule: 'stabCount', label: 'Stab sounds', group: 'Sound', roles: STAB_ROLES, when: (g) => stabbing(g) && !!g.picks.stab, unset: 1,
    options: [{ value: 1, label: 'one' }, { value: 2, label: 'two' }, { value: 3, label: 'three' }] },
  { rule: 'stabTurns', label: 'Stabs take turns', group: 'Sound', roles: STAB_ROLES, when: (g) => !!g.picks.stab2 && !g.picks.stab3 && !looped(g), unset: 'hits',
    options: [{ value: 'bars', label: 'bar by bar' }, { value: 'hits', label: 'hit by hit' }] },
  { rule: 'stringsAt', label: 'Strings', group: 'Sound', roles: ['strings'], when: (g) => !!g.picks.strings,
    options: [{ value: 'later', label: 'from the second drop' }, { value: 'halves', label: 'the second half of drops' }, { value: 'breaks', label: 'in the breakdowns' },
      { value: 'drops', label: 'in every drop' }, { value: 'inner', label: 'all but intro and outro' }, { value: 'all', label: 'all through' }] },
  { rule: 'vocalAt', label: 'Vocal phrase', group: 'Sound', roles: ['vocal'], when: (g) => !!g.picks.vocal,
    options: [{ value: 'drops', label: 'in the drops' }, { value: 'halves', label: 'second half of drops' },
      { value: 'drops_breaks', label: 'drops and breakdowns' }, { value: 'breaks', label: 'breakdowns, last drop' }] },
  { rule: 'vocalLoop', label: 'Vocal loop', group: 'Sound', roles: ['vocal'], when: (g) => !!g.picks.vocal,
    options: [{ value: 'long', label: 'the long one' }, { value: 'short', label: 'the short one' }] },
  { rule: 'fx', label: 'FX', group: 'Sound', roles: ['fx', 'fx2', 'fx3', 'hits'],
    options: [{ value: 'sparse', label: 'sparse' }, { value: 'normal', label: 'normal' }, { value: 'busy', label: 'busy' }] },
]

CHOICES.push(
  { rule: 'lead', label: 'Lead', group: 'Sound', roles: [...STAB_ROLES, 'piano', 'music', 'bass', 'perc'], unset: null,
    when: (g) => !!g.rules.character || g.rules.keys === 'piano' || g.rules.keys === 'music',
    options: [{ value: 'stab', label: 'the stabs' }, { value: 'piano', label: 'the piano' }, { value: 'music', label: 'the music loop' }, { value: 'bass', label: 'the bassline' },
      { value: 'perc', label: 'the percussion' }, { value: null, label: 'none' }] },
  // Piano, a music loop or stabs (SCOPE.md §6.9a, §6.11b): on tracks that could play another (piano MIDI to learn from, a loop that fits).
  { rule: 'keys', label: 'Chords', group: 'Sound', roles: [...STAB_ROLES, 'piano', 'music', 'bass', 'pad', 'strings'], when: (g) => g.rules.keys != null,
    options: [{ value: 'stabs', label: 'chord stabs' }, { value: 'piano', label: 'a piano part' }, { value: 'music', label: 'a music loop' }] },
  { rule: 'pianoKind', label: 'Piano', group: 'Sound', roles: ['piano', 'bass', 'pad', 'strings'], when: (g) => g.rules.keys === 'piano',
    options: [{ value: 'loop', label: 'a loop on the key (the bass as it is)' }, { value: 'progression', label: 'a progression (the bass follows it)' }] },
  { rule: 'padIn', label: 'Break layer', group: 'Breakdowns', roles: ['pad'], when: (g) => has('break')(g) && !!g.rules.padPreset, unset: false,
    options: yesNo('a pad or a reese', 'none') },
)

/** The stab choices of tracks whose stabs are written for them (rule `stabFit`). */
const fitted = (g: Generation) => stabbing(g) && !!g.rules.stabFit
/** …and played as one loop (rule `stabLoop`). */
function looped(g: Generation): boolean { return fitted(g) && !!g.rules.stabLoop }
CHOICES.push(
  { rule: 'stabLoop', label: 'Stab loop', group: 'Sound', roles: STAB_ROLES, when: fitted, unset: false,
    options: yesNo('one loop, announcing drops', 'taking turns (as before)') },
  { rule: 'stabLayout', label: 'Second stab', group: 'Sound', roles: STAB_ROLES, when: (g) => looped(g) && !!g.picks.stab2 && !g.picks.stab3,
    options: [{ value: 'stack', label: 'layered on the first' }, { value: 'split', label: 'on the pickups' }] },
  { rule: 'stabMove', label: 'Stab moves', group: 'Sound', roles: STAB_ROLES, when: looped, unset: 0,
    options: [{ value: 0, label: 'never' }, { value: 2, label: 'a tone up' }, { value: 3, label: 'a minor third up' }, { value: 5, label: 'a fourth up' },
      { value: -2, label: 'a tone down' }] },
  { rule: 'stabMoveAt', label: 'Stab move on', group: 'Sound', roles: STAB_ROLES, when: (g) => looped(g) && !!g.rules.stabMove,
    options: [{ value: 'loop', label: 'the loop\'s last hit' }, { value: 'bar', label: 'every bar\'s last hit' }] },
  { rule: 'stabAnnounce', label: 'Stabs announce drops', group: 'Builds', roles: STAB_ROLES, when: looped,
    options: [{ value: 4, label: 'over 4 bars' }, { value: 8, label: 'over 8 bars' }] },
  { rule: 'stabRoll', label: 'Stab roll into drops', group: 'Builds', roles: STAB_ROLES, when: looped,
    options: [{ value: 'none', label: 'none' }, { value: 'eighths', label: 'in 8ths' }, { value: 'sixteenths', label: '8ths, then 16ths' }] },

  { rule: 'stabFit', label: 'Stabs', group: 'Sound', roles: STAB_ROLES, when: stabbing, unset: false,
    options: yesNo('written for the track', 'placed as before') },
  { rule: 'stabTurn', label: 'Stabs every 8 bars', group: 'Every 8 and 16 bars', roles: STAB_ROLES, when: fitted,
    options: [{ value: 'none', label: 'no turn' }, { value: 'drop', label: 'the last stab left out' }, { value: 'push', label: 'the last stab early' },
      { value: 'double', label: 'the last stab twice' }] },
  { rule: 'stabEcho', label: 'Stab delay throws', group: 'Every 8 and 16 bars', roles: STAB_ROLES, when: fitted,
    options: [{ value: 'none', label: 'none' }, { value: '8', label: 'every 8 bars' }, { value: '16', label: 'every 16 bars' }, { value: 'breaks', label: 'into breakdowns' }] },
  { rule: 'stabsOpen', label: 'Stab filter', group: 'Drops', roles: STAB_ROLES, when: fitted,
    options: [{ value: 'none', label: 'open' }, { value: 'first', label: 'opens over drop 1' }, { value: 'each', label: 'opens over every drop' }] },
  { rule: 'stabsGrow', label: 'Stabs in drop 1', group: 'Drops', roles: STAB_ROLES, when: fitted, options: yesNo('lean at first, full halfway', 'full from the start') },
  { rule: 'stabsTease', label: 'Stabs', group: 'Intro & outro', roles: STAB_ROLES,
    when: (g) => fitted(g) && g.sections[0]?.kind === 'intro' && g.sections[0].bars >= 24, options: yesNo('teased at the end of the intro', 'not before the drop') },
)

export const CHOICE_GROUPS = ['Drops', 'Breakdowns', 'Builds', 'Intro & outro', 'Every 8 and 16 bars', 'Sound'] as const

/** The choices of `g` to show: the ones that apply to it. */
export function choicesFor(g: Generation): Choice[] {
  return CHOICES.filter((c) => !c.when || c.when(g))
}

/** The choices shaping a lane (by its role, or the role it's a layer of). */
export function choicesOfRole(role: Role): Choice[] {
  return CHOICES.filter((c) => c.roles.includes(role))
}

/** A track's value of a choice. */
export function choiceValue(c: Choice, g: Generation): unknown {
  return g.rules[c.rule] ?? c.unset ?? null
}

/** A value as an option key (values are JSON: null, booleans, numbers, strings). */
export const optionKey = (v: unknown) => JSON.stringify(v ?? null)

/** The label of a track's value, or the value itself when it isn't one of the options (a template's). */
export function valueLabel(c: Choice, v: unknown): string {
  return c.options.find((o) => optionKey(o.value) === optionKey(v))?.label ?? String(v)
}
