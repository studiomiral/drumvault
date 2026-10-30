import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { buildSampleQuery, downsamplePeaks, LibraryReader } from '../electron/db'

const libraryDir = inject('libraryDir')

describe('buildSampleQuery', () => {
  it('builds parameterised filters', () => {
    const { sql, params } = buildSampleQuery({
      kind: 'loop', categories: ['top', 'groove'], keys: ['Am', 'NoKey'], compatible: true, bars: [4],
      zipIds: [2], favoritesOnly: true, search: '100% deep_', sort: 'key',
    })
    expect(params).toEqual(['loop', 'top', 'groove', 'Am', 'C', 'Dm', 'Em', 4, 2,
      '%100\\%%', '%100\\%%', '%deep\\_%', '%deep\\_%'])
    expect(sql).toContain('s.key_label IS NULL')
    expect(sql).toContain('s.favorite = 1')
    expect(sql).not.toContain('100%')  // user text only ever goes in as a parameter
  })
})

describe('downsamplePeaks', () => {
  it('keeps min/max per bucket', () => {
    const src: [number, number][] = [[-1, 1], [-0.2, 0.3], [-0.5, 0.1], [-0.1, 0.9]]
    expect(downsamplePeaks(src, 2)).toEqual([[-1, 1], [-0.5, 0.9]])
    expect(downsamplePeaks(src, 10)).toBe(src)
  })
})

describe.skipIf(!libraryDir)('LibraryReader on an engine-built library', () => {
  let reader: LibraryReader
  beforeAll(() => {
    reader = new LibraryReader(libraryDir!)
  })
  afterAll(() => reader.close())

  it('lists zips with sample counts', () => {
    const zips = reader.listZips()
    expect(zips.map((z) => z.source_code)).toEqual(['S0002', 'S0001'])  // newest first
    for (const z of zips) {
      expect(z.status).toBe('done')
      expect(z.oneshots).toBeGreaterThan(0)
      expect(z.loops).toBeGreaterThan(0)
      expect(Number.isInteger(z.detected_bpm)).toBe(true)
    }
  })

  it('returns zip details with stems and warnings', () => {
    const z = reader.listZips().find((x) => x.file_name.startsWith('Sunrise'))!
    const d = reader.zipDetail(z.id)!
    expect(d.zip.detected_bpm).toBe(126)
    expect(d.zip.key_label).toBe('D')
    expect(d.stems.map((s) => s.file_name)).toContain('KICK.wav')
    expect(d.stems.find((s) => s.file_name === 'Track 12.wav')).toMatchObject({ category: 'melodic', auto_classified: 1 })
    expect(Array.isArray(d.warnings)).toBe(true)
    expect(reader.zipDetail(99999)).toBeNull()
  })

  it('filters and sorts samples', () => {
    const all = reader.querySamples({})
    expect(all.length).toBe(reader.facets().total)
    expect(all[0].name).not.toMatch(/\.wav$/)

    const loops = reader.querySamples({ kind: 'loop', bars: [4] })
    expect(loops.length).toBeGreaterThan(0)
    expect(loops.every((s) => s.kind === 'loop' && s.bars === 4 && s.bpm === 124)).toBe(true)

    const kicks = reader.querySamples({ kind: 'oneshot', categories: ['kick'] })
    expect(kicks.map((s) => s.key_label).sort()).toEqual(['Am', 'D'])

    expect(reader.querySamples({ keys: ['Am'] }).every((s) => s.key_label === 'Am')).toBe(true)
    // D major's Camelot neighbours (10B: 10A Bm, 9B G, 11B A) don't include Am: same result.
    expect(reader.querySamples({ keys: ['D'], compatible: true }).every((s) => s.key_label === 'D')).toBe(true)
    // Am is compatible with C, Dm, Em, but not with D.
    expect(reader.querySamples({ keys: ['C'], compatible: true }).every((s) => s.key_label === 'Am')).toBe(true)

    const search = reader.querySamples({ search: 'sunrise top' })
    expect(search.length).toBeGreaterThan(0)
    expect(search.every((s) => /sunrise/i.test(s.rel_path) && /top/i.test(s.rel_path))).toBe(true)  // LIKE is case-insensitive

    const byKey = reader.querySamples({ sort: 'key' }).map((s) => s.key_camelot)
    expect(byKey.indexOf('8A')).toBeLessThan(byKey.indexOf('10B'))
  })

  it('reports facets', () => {
    const f = reader.facets()
    expect(f.loopBpms).toEqual([124])
    expect(f.bars).toEqual([1, 2, 4, 8])
    expect(f.zips).toHaveLength(2)
    expect(f.keys.map((k) => k.label).sort()).toEqual(['Am', 'D'])
    expect(f.categories.some((c) => c.kind === 'oneshot' && c.category === 'kick')).toBe(true)
  })

  it('reads downsampled waveform peaks', async () => {
    const loop = reader.querySamples({ kind: 'loop', bars: [8] })[0]
    const pts = await reader.peaks(loop.id, 120)
    expect(pts).toHaveLength(120)
    expect(pts!.every(([lo, hi]) => lo <= hi)).toBe(true)
    expect(await reader.peaks(999999, 120)).toBeNull()
  })

  it('finds similar samples within the same category and loop length', () => {
    const hat = reader.querySamples({ kind: 'loop', categories: ['hat'], bars: [2] })[0]
    const sim = reader.similar(hat.id, 10)
    expect(sim.length).toBeGreaterThan(0)
    expect(sim.every((s) => s.kind === 'loop' && s.category === 'hat' && s.bars === 2 && s.id !== hat.id)).toBe(true)
    expect(sim.map((s) => s.similarity)).toEqual([...sim.map((s) => s.similarity)].sort((a, b) => b - a))
    expect(sim[0].similarity).toBeLessThanOrEqual(1 + 1e-6)
    const kick = reader.querySamples({ kind: 'oneshot', categories: ['kick'] })[0]
    const k = reader.similar(kick.id, 10)
    expect(k.every((s) => s.category === 'kick')).toBe(true)
    expect(k[0].similarity).toBeGreaterThan(0.5)  // synthetic kicks are alike
    expect(reader.similar(999999)).toEqual([])
  })

  it('handles a library without a database yet', () => {
    const empty = new LibraryReader(mkdtempSync(join(tmpdir(), 'dv-empty-')))
    expect(empty.listZips()).toEqual([])
    expect(empty.facets().total).toBe(0)
    expect(new LibraryReader(null).querySamples({})).toEqual([])
  })

  it('opens read-only (never writes the engine database)', () => {
    const copy = mkdtempSync(join(tmpdir(), 'dv-ro-'))
    cpSync(join(libraryDir!, '.drumvault'), join(copy, '.drumvault'), { recursive: true })
    const r = new LibraryReader(copy)
    r.listZips()
    expect(() => (r as unknown as { conn(): { exec(s: string): void } }).conn().exec('DELETE FROM samples')).toThrow()
    r.close()
  })
})
