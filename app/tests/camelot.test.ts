import { describe, expect, it } from 'vitest'
import { ALL_KEYS, camelotForLabel, compatibleCamelots, expandCompatible } from '../src/lib/camelot'

describe('camelot', () => {
  it('maps keys like the engine', () => {
    const cases: [string, string][] = [['Am', '8A'], ['C', '8B'], ['Em', '9A'], ['Fm', '4A'], ['D', '10B'],
      ['Abm', '1A'], ['B', '1B'], ['C#m', '12A'], ['E', '12B'], ['F#', '2B']]
    for (const [label, code] of cases) expect(camelotForLabel(label)).toBe(code)
  })

  it('lists all 24 keys around the wheel', () => {
    expect(ALL_KEYS).toHaveLength(24)
    expect(ALL_KEYS.slice(0, 4).map((k) => k.camelot)).toEqual(['1A', '1B', '2A', '2B'])
    expect(new Set(ALL_KEYS.map((k) => k.label)).size).toBe(24)
  })

  it('finds compatible keys (relative, and a fifth up/down), wrapping 12 -> 1', () => {
    expect(compatibleCamelots('8A')).toEqual(['8A', '8B', '7A', '9A'])
    expect(compatibleCamelots('12B')).toEqual(['12B', '12A', '11B', '1B'])
    expect(compatibleCamelots('1A')).toEqual(['1A', '1B', '12A', '2A'])
    expect(expandCompatible(['Am'])).toEqual(['Am', 'C', 'Dm', 'Em'])
    expect(expandCompatible(['Am', 'C'])).toEqual(['Am', 'C', 'Dm', 'Em', 'F', 'G'])
  })
})
