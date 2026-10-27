// Musical keys and Camelot-wheel compatibility (mirrors engine/drumvault_engine/key.py).

export const PITCHES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const

export interface KeyInfo {
  label: string      // "Am"
  camelot: string    // "8A"
}

export function camelotOf(pc: number, minor: boolean): string {
  const n = minor ? ((((pc - 9) * 7) % 12 + 12) % 12 + 7) % 12 + 1 : (((pc * 7) % 12) + 7) % 12 + 1
  return `${n}${minor ? 'A' : 'B'}`
}

/** All 24 keys, ordered around the Camelot wheel (1A, 1B, 2A, 2B, ...). */
export const ALL_KEYS: KeyInfo[] = (() => {
  const keys: KeyInfo[] = []
  for (let pc = 0; pc < 12; pc++) {
    for (const minor of [true, false]) {
      keys.push({ label: PITCHES[pc] + (minor ? 'm' : ''), camelot: camelotOf(pc, minor) })
    }
  }
  return keys.sort((a, b) => parseCamelot(a.camelot).n - parseCamelot(b.camelot).n
    || a.camelot.localeCompare(b.camelot))
})()

const BY_LABEL = new Map(ALL_KEYS.map((k) => [k.label, k]))
const BY_CAMELOT = new Map(ALL_KEYS.map((k) => [k.camelot, k]))

export function parseCamelot(code: string): { n: number; letter: 'A' | 'B' } {
  return { n: parseInt(code, 10), letter: code.endsWith('A') ? 'A' : 'B' }
}

export function camelotForLabel(label: string): string | null {
  return BY_LABEL.get(label)?.camelot ?? null
}

/** The key itself, its relative major/minor and the neighbours a fifth up/down. */
export function compatibleCamelots(code: string): string[] {
  const { n, letter } = parseCamelot(code)
  const wrap = (x: number) => ((x - 1 + 12) % 12) + 1
  return [code, `${n}${letter === 'A' ? 'B' : 'A'}`, `${wrap(n - 1)}${letter}`, `${wrap(n + 1)}${letter}`]
}

/** Expand key labels with their Camelot-compatible keys (order kept, no duplicates). */
export function expandCompatible(labels: string[]): string[] {
  const out: string[] = []
  for (const label of labels) {
    const code = camelotForLabel(label)
    const add = code ? compatibleCamelots(code).map((c) => BY_CAMELOT.get(c)!.label) : [label]
    for (const l of add) if (!out.includes(l)) out.push(l)
  }
  return out
}
