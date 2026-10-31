// Seeded randomness for the generator: the same seed gives the same generation.

export class Rng {
  private s: number

  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9
  }

  /** Uniform in [0, 1) (mulberry32). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** The state, to go on from here later (`restore`). */
  save(): number {
    return this.s
  }

  restore(state: number): void {
    this.s = state >>> 0
  }

  chance(p: number): boolean {
    return this.next() < p
  }

  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1))
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]
  }

  /** Pick by weight: `[[value, weight], …]`. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((s, [, w]) => s + w, 0)
    let r = this.next() * total
    for (const [v, w] of items) {
      r -= w
      if (r < 0) return v
    }
    return items[items.length - 1][0]
  }

  /** Pick one of `items` with weights from `weight(item)`. */
  pickBy<T>(items: readonly T[], weight: (item: T) => number): T {
    return this.weighted(items.map((i) => [i, Math.max(0, weight(i))] as const))
  }
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31)
}
