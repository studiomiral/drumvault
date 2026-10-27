// Read-only access to <Library>/.drumvault/library.sqlite (the engine is the only writer).
// Uses Node's built-in `node:sqlite`, so there is no native module to rebuild for Electron.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expandCompatible } from '../src/lib/camelot'
import { fileName, parseJsonArray } from '../src/lib/format'
import type { PeaksFile, StemRow } from '../src/types/engine'
import type { LibraryFacets, PeakPoints, SampleFilter, SampleListItem, ZipDetail, ZipListItem } from '../src/types/api'

type Row = Record<string, unknown>

export function dbPath(library: string): string {
  return join(library, '.drumvault', 'library.sqlite')
}

export function peaksPath(library: string, sampleId: number): string {
  return join(library, '.drumvault', 'peaks', `${sampleId}.json`)
}

const ZIP_LIST_SQL = `
  SELECT z.*,
         COALESCE(SUM(s.kind = 'oneshot'), 0) AS oneshots,
         COALESCE(SUM(s.kind = 'loop'), 0) AS loops
  FROM zips z LEFT JOIN samples s ON s.zip_id = z.id
  GROUP BY z.id`

const SORTS: Record<string, string> = {
  name: 's.rel_path COLLATE NOCASE',
  newest: 's.id DESC',
  category: 's.kind, s.category, s.bars, s.rel_path COLLATE NOCASE',
  key: "CAST(s.key_camelot AS INTEGER), SUBSTR(s.key_camelot, -1), s.rel_path COLLATE NOCASE",
  rating: 's.favorite DESC, COALESCE(s.rating, 0) DESC, s.rel_path COLLATE NOCASE',
}

/** SQL WHERE clause + parameters for a sample filter (exported for tests). */
export function buildSampleQuery(f: SampleFilter): { sql: string; params: (string | number)[] } {
  const where: string[] = []
  const params: (string | number)[] = []
  const inList = (col: string, values: (string | number)[]) => {
    where.push(`${col} IN (${values.map(() => '?').join(', ')})`)
    params.push(...values)
  }
  if (f.kind) {
    where.push('s.kind = ?')
    params.push(f.kind)
  }
  if (f.categories?.length) inList('s.category', f.categories)
  if (f.keys?.length) {
    const wantsNoKey = f.keys.includes('NoKey')
    const labels = f.keys.filter((k) => k !== 'NoKey')
    const expanded = f.compatible ? expandCompatible(labels) : labels
    const parts: string[] = []
    if (expanded.length) {
      parts.push(`s.key_label IN (${expanded.map(() => '?').join(', ')})`)
      params.push(...expanded)
    }
    if (wantsNoKey) parts.push('s.key_label IS NULL')
    where.push(`(${parts.join(' OR ')})`)
  }
  if (f.bars?.length) inList('s.bars', f.bars)
  if (f.zipIds?.length) inList('s.zip_id', f.zipIds)
  if (f.favoritesOnly) where.push('s.favorite = 1')
  for (const word of (f.search ?? '').trim().split(/\s+/).filter(Boolean)) {
    where.push("(s.rel_path LIKE ? ESCAPE '\\' OR COALESCE(s.tags, '') LIKE ? ESCAPE '\\')")
    const like = `%${word.replace(/[\\%_]/g, (c) => '\\' + c)}%`
    params.push(like, like)
  }
  const sql = `
    SELECT s.id, s.rel_path, s.kind, s.category, s.bpm, s.bars, s.key_label, s.key_camelot,
           s.duration_s, s.channels, s.favorite, s.rating, s.tags, s.zip_id, z.source_code
    FROM samples s JOIN zips z ON z.id = s.zip_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${SORTS[f.sort ?? 'name'] ?? SORTS.name}`
  return { sql, params }
}

export class LibraryReader {
  private db: DatabaseSync | null = null
  private peakCache = new Map<string, PeakPoints>()

  constructor(public readonly library: string | null) {}

  /** Opens lazily: a fresh library has no database until the first zip is processed. */
  private conn(): DatabaseSync | null {
    if (this.db) return this.db
    if (!this.library || !existsSync(dbPath(this.library))) return null
    this.db = new DatabaseSync(dbPath(this.library), { readOnly: true })
    this.db.exec('PRAGMA busy_timeout = 5000')
    return this.db
  }

  close(): void {
    this.db?.close()
    this.db = null
  }

  private all<T>(sql: string, ...params: (string | number | null)[]): T[] {
    const db = this.conn()
    if (!db) return []
    return db.prepare(sql).all(...params).map((r) => ({ ...(r as Row) })) as T[]
  }

  listZips(): ZipListItem[] {
    return this.all<ZipListItem>(`${ZIP_LIST_SQL} ORDER BY z.id DESC`)
  }

  zipDetail(zipId: number): ZipDetail | null {
    const [zip] = this.all<ZipListItem>(`${ZIP_LIST_SQL} HAVING z.id = ?`, zipId)
    if (!zip) return null
    const stems = this.all<StemRow>('SELECT * FROM stems WHERE zip_id = ? ORDER BY file_name COLLATE NOCASE', zipId)
    return {
      zip, stems, warnings: parseJsonArray(zip.warnings),
      originalExists: !!zip.original_path && existsSync(zip.original_path),
    }
  }

  querySamples(filter: SampleFilter): SampleListItem[] {
    const { sql, params } = buildSampleQuery(filter)
    return this.all<Omit<SampleListItem, 'name'>>(sql, ...params)
      .map((r) => ({ ...r, name: fileName(r.rel_path) }))
  }

  sample(id: number): SampleListItem | null {
    const [r] = this.all<Omit<SampleListItem, 'name'>>(
      `SELECT s.*, z.source_code FROM samples s JOIN zips z ON z.id = s.zip_id WHERE s.id = ?`, id)
    return r ? { ...r, name: fileName(r.rel_path) } : null
  }

  samplesByPath(relPaths: string[]): SampleListItem[] {
    const out: SampleListItem[] = []
    for (let i = 0; i < relPaths.length; i += 500) {
      const chunk = relPaths.slice(i, i + 500)
      out.push(...this.all<Omit<SampleListItem, 'name'>>(
        `SELECT s.id, s.rel_path, s.kind, s.category, s.bpm, s.bars, s.key_label, s.key_camelot, s.duration_s,
                s.channels, s.favorite, s.rating, s.tags, s.zip_id, z.source_code
         FROM samples s JOIN zips z ON z.id = s.zip_id WHERE s.rel_path IN (${chunk.map(() => '?').join(', ')})`,
        ...chunk).map((r) => ({ ...r, name: fileName(r.rel_path) })))
    }
    return out
  }

  facets(): LibraryFacets {
    const total = this.all<{ n: number }>('SELECT COUNT(*) AS n FROM samples')[0]?.n ?? 0
    return {
      total,
      categories: this.all('SELECT kind, category, COUNT(*) AS count FROM samples GROUP BY kind, category ORDER BY kind, category'),
      keys: this.all('SELECT key_label AS label, key_camelot AS camelot, COUNT(*) AS count FROM samples GROUP BY key_label'),
      bars: this.all<{ bars: number }>('SELECT DISTINCT bars FROM samples WHERE bars IS NOT NULL ORDER BY bars').map((r) => r.bars),
      zips: this.all(`SELECT z.id, z.source_code, z.file_name, COUNT(s.id) AS count
                      FROM zips z JOIN samples s ON s.zip_id = z.id GROUP BY z.id ORDER BY z.id`),
      loopBpms: this.all<{ bpm: number }>("SELECT DISTINCT bpm FROM samples WHERE kind = 'loop' ORDER BY bpm").map((r) => r.bpm),
    }
  }

  /** Waveform peaks downsampled to `points` [min, max] pairs (cached). */
  async peaks(sampleId: number, points: number): Promise<PeakPoints | null> {
    if (!this.library) return null
    const key = `${sampleId}:${points}`
    const hit = this.peakCache.get(key)
    if (hit) return hit
    let file: PeaksFile
    try {
      file = JSON.parse(await readFile(peaksPath(this.library, sampleId), 'utf8'))
    } catch {
      return null
    }
    const out = downsamplePeaks(file.points, points)
    if (this.peakCache.size > 20_000) this.peakCache.clear()
    this.peakCache.set(key, out)
    return out
  }
}

export function downsamplePeaks(src: [number, number][], points: number): PeakPoints {
  if (src.length <= points) return src
  const out: PeakPoints = []
  for (let i = 0; i < points; i++) {
    const a = Math.floor((i * src.length) / points)
    const b = Math.max(a + 1, Math.floor(((i + 1) * src.length) / points))
    let lo = Infinity
    let hi = -Infinity
    for (let j = a; j < b; j++) {
      if (src[j][0] < lo) lo = src[j][0]
      if (src[j][1] > hi) hi = src[j][1]
    }
    out.push([lo, hi])
  }
  return out
}
