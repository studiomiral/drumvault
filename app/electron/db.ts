// Read-only access to <Library>/.drumvault/library.sqlite (the engine is the only writer).
// Uses Node's built-in `node:sqlite`, so there is no native module to rebuild for Electron.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expandCompatible } from '../src/lib/camelot'
import { fileName, parseJsonArray } from '../src/lib/format'
import type { PeaksFile, SampleKind, StemRow } from '../src/types/engine'
import type {
  EventShape, LibraryFacets, LoopGroove, MidiItem, PeakPoints, RemovedSample, SampleFilter, SampleListItem, TrackArrangement,
  ZipDetail, ZipListItem,
} from '../src/types/api'

type Row = Record<string, unknown>

export function dbPath(library: string): string {
  return join(library, '.drumvault', 'library.sqlite')
}

/** Where the library keeps a zip's or pack's own copy of its audio (SCOPE.md §5.8d). */
export function keptDir(library: string, sourceCode: string): string {
  return join(library, '.drumvault', 'originals', sourceCode)
}

export function isKept(library: string, sourceCode: string): boolean {
  return existsSync(join(keptDir(library, sourceCode), 'kept.json'))
}

export function peaksPath(library: string, sampleId: number): string {
  return join(library, '.drumvault', 'peaks', `${sampleId}.json`)
}

const ZIP_LIST_SQL = `
  SELECT z.*,
         COALESCE(SUM(s.kind = 'oneshot'), 0) AS oneshots,
         COALESCE(SUM(s.kind = 'loop'), 0) AS loops,
         COALESCE(SUM(s.kind = 'event'), 0) AS events
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
/**
 * `bodyCol` selects body_bars (libraries from before schema v2 lack the column), `grooveCol` the
 * groove (v7), `shapeCol` the event shape (v9).
 */
export function buildSampleQuery(f: SampleFilter, bodyCol = 's.body_bars', grooveCol = 's.groove',
                                 shapeCol = 's.shape'): { sql: string; params: (string | number)[] } {
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
    SELECT s.id, s.rel_path, s.kind, s.category, s.bpm, s.bars, ${bodyCol} AS body_bars, s.key_label, s.key_camelot,
           s.duration_s, s.channels, s.favorite, s.rating, s.tags, s.zip_id, z.source_code, ${grooveCol} AS groove,
           ${shapeCol} AS shape
    FROM samples s JOIN zips z ON z.id = s.zip_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${SORTS[f.sort ?? 'name'] ?? SORTS.name}`
  return { sql, params }
}

type SampleRow = Omit<SampleListItem, 'name' | 'groove' | 'shape'> & { groove?: string | null; shape?: string | null }

/** A JSON column, or null (a damaged value counts as none). */
function parsed<T>(json: string | null | undefined, ok: (v: T) => boolean): T | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as T
    return v && ok(v) ? v : null
  } catch {
    return null
  }
}

/** A sample row as the app sees it: a name, the groove ('{}' = measured, none found) and shape parsed. */
function toListItem({ groove, shape, ...r }: SampleRow): SampleListItem {
  return {
    ...r, name: fileName(r.rel_path),
    groove: parsed<LoopGroove>(groove, (v) => Array.isArray(v.offsets)),
    shape: parsed<EventShape>(shape, (v) => typeof v.gap === 'number'),
  }
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

  /** Deleted samples (schema v3+), newest first, with their trashed file if it was kept (v4). */
  removedSamples(): RemovedSample[] {
    const cols = this.all<{ name: string }>('PRAGMA table_info(removed_samples)').map((c) => c.name)
    if (!cols.length || !this.library) return []
    const v4 = cols.includes('sample')
    const rows = this.all<{ id: number; zip_id: number; source_code: string; stem_file: string | null; kind: SampleKind
      bars: number | null; sample: string | null; removed_at: string | null }>(
      `SELECT r.id, r.zip_id, z.source_code, r.stem_file, r.kind, r.bars,
              ${v4 ? 'r.sample, r.removed_at' : 'NULL AS sample, NULL AS removed_at'}
       FROM removed_samples r JOIN zips z ON z.id = r.zip_id ORDER BY r.id DESC`)
    return rows.map((r) => {
      const s = r.sample ? JSON.parse(r.sample) as Record<string, never> : null
      const trash = `.drumvault/trash/${r.id}.wav`
      return {
        id: r.id, zip_id: r.zip_id, source_code: r.source_code, kind: r.kind, bars: r.bars,
        name: s ? fileName(s['rel_path']) : `${r.stem_file ?? 'stem'} (${r.kind})`,
        category: s?.['category'] ?? null, key_label: s?.['key_label'] ?? null, key_camelot: s?.['key_camelot'] ?? null,
        duration_s: s?.['duration_s'] ?? null, removed_at: r.removed_at,
        trash_path: existsSync(join(this.library!, trash)) ? trash : null,
      }
    })
  }

  private hasColumn(table: string, column: string): boolean {
    return this.all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column)
  }

  /** Imported MIDI files (schema v6), oldest first. */
  listMidi(): MidiItem[] {
    if (!this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'midi_files'").length) return []
    return this.all<Omit<MidiItem, 'notes' | 'name'> & { notes: string }>(
      `SELECT id, file_name, rel_path, role, bars, key_label, key_camelot, notes, favorite,
              ${this.hasColumn('midi_files', 'source') ? 'source, source_code' : 'NULL AS source, NULL AS source_code'}
       FROM midi_files ORDER BY id`)
      .map((r) => ({ ...r, name: r.file_name.replace(/\.midi?$/i, ''), notes: JSON.parse(r.notes) }))
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
      originalKept: !!this.library && isKept(this.library, zip.source_code),
    }
  }

  /** `s.body_bars`, or NULL until the engine has migrated this library to schema v2. */
  private bodyCol(): string {
    const cols = this.all<{ name: string }>('PRAGMA table_info(samples)')
    return cols.some((c) => c.name === 'body_bars') ? 's.body_bars' : 'NULL'
  }

  /** `s.groove`, or NULL before schema v7. */
  private grooveCol(): string {
    return this.hasColumn('samples', 'groove') ? 's.groove' : 'NULL'
  }

  /** `s.shape`, or NULL before schema v9. */
  private shapeCol(): string {
    return this.hasColumn('samples', 'shape') ? 's.shape' : 'NULL'
  }

  querySamples(filter: SampleFilter): SampleListItem[] {
    const { sql, params } = buildSampleQuery(filter, this.bodyCol(), this.grooveCol(), this.shapeCol())
    return this.all<SampleRow>(sql, ...params).map(toListItem)
  }

  /** Every track's arrangement (schema v7), for Generate's structure templates. */
  arrangements(): TrackArrangement[] {
    if (!this.hasTable('arrangements')) return []
    return this.all<Omit<TrackArrangement, 'parts'> & { parts: string }>(
      `SELECT a.zip_id, z.source_code, a.bpm, a.bars, a.parts FROM arrangements a JOIN zips z ON z.id = a.zip_id
       ORDER BY a.zip_id`).map((r) => ({ ...r, parts: JSON.parse(r.parts) as Record<string, string> }))
  }

  /** Loops without a measured groove, events without a shape, or tracks without an arrangement (older libraries). */
  needsAnalysis(): boolean {
    if (!this.conn()) return false
    const loops = this.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM samples WHERE kind = 'loop'${this.hasColumn('samples', 'groove') ? ' AND groove IS NULL' : ''}`)[0]?.n ?? 0
    if (loops) return true
    const events = this.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM samples WHERE kind = 'event'${this.hasColumn('samples', 'shape') ? ' AND shape IS NULL' : ''}`)[0]?.n ?? 0
    if (events) return true
    // Imports from before the library kept its own copy: kept while the zip or folder is still there.
    const lib = this.library
    if (lib && this.all<{ source_code: string; original_path: string | null }>(
      "SELECT source_code, original_path FROM zips WHERE status IN ('done', 'needs_review')")
      .some((z) => !isKept(lib, z.source_code) && !!z.original_path && existsSync(z.original_path))) return true
    const zips = `SELECT COUNT(*) AS n FROM zips z WHERE z.status IN ('done', 'needs_review')${
      this.hasColumn('zips', 'kind') ? " AND z.kind = 'stems'" : ''}`
    return (this.all<{ n: number }>(this.hasTable('arrangements')
      ? `${zips} AND z.id NOT IN (SELECT zip_id FROM arrangements)` : zips)[0]?.n ?? 0) > 0
  }

  private hasTable(name: string): boolean {
    return this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0
  }

  sample(id: number): SampleListItem | null {
    const [r] = this.all<SampleRow>(
      `SELECT s.*, z.source_code FROM samples s JOIN zips z ON z.id = s.zip_id WHERE s.id = ?`, id)
    return r ? toListItem(r) : null
  }

  samplesByPath(relPaths: string[]): SampleListItem[] {
    const out: SampleListItem[] = []
    const body = this.bodyCol()
    for (let i = 0; i < relPaths.length; i += 500) {
      const chunk = relPaths.slice(i, i + 500)
      out.push(...this.all<SampleRow>(
        `SELECT s.id, s.rel_path, s.kind, s.category, s.bpm, s.bars, ${body} AS body_bars, s.key_label, s.key_camelot,
                s.duration_s, s.channels, s.favorite, s.rating, s.tags, s.zip_id, z.source_code, ${this.grooveCol()} AS groove,
                ${this.shapeCol()} AS shape
         FROM samples s JOIN zips z ON z.id = s.zip_id WHERE s.rel_path IN (${chunk.map(() => '?').join(', ')})`,
        ...chunk).map(toListItem))
    }
    return out
  }

  /**
   * Nearest neighbours of a sample by fingerprint (cosine similarity of the engine's
   * L2-normalised log-mel fingerprints), within the same kind, category and loop length.
   */
  similar(sampleId: number, limit = 50): (SampleListItem & { similarity: number })[] {
    const [t] = this.all<{ kind: string; category: string; bars: number | null; fingerprint: Uint8Array | null }>(
      'SELECT kind, category, bars, fingerprint FROM samples WHERE id = ?', sampleId)
    if (!t?.fingerprint) return []
    const target = toFloats(t.fingerprint)
    const rows = this.all<Omit<SampleListItem, 'name'> & { fingerprint: Uint8Array | null }>(
      `SELECT s.id, s.rel_path, s.kind, s.category, s.bpm, s.bars, ${this.bodyCol()} AS body_bars, s.key_label,
              s.key_camelot, s.duration_s, s.channels, s.favorite, s.rating, s.tags, s.zip_id, z.source_code, s.fingerprint
       FROM samples s JOIN zips z ON z.id = s.zip_id
       WHERE s.kind = ? AND s.category = ? AND s.bars IS ? AND s.id != ?`,
      t.kind, t.category, t.bars, sampleId)
    const scored = []
    for (const { fingerprint, ...r } of rows) {
      if (!fingerprint || fingerprint.byteLength !== t.fingerprint.byteLength) continue
      const f = toFloats(fingerprint)
      let dot = 0
      for (let i = 0; i < f.length; i++) dot += f[i] * target[i]
      scored.push({ ...r, name: fileName(r.rel_path), similarity: dot })
    }
    return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit)
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
      loopBpms: this.all<{ bpm: number }>("SELECT DISTINCT bpm FROM samples WHERE bpm IS NOT NULL ORDER BY bpm").map((r) => r.bpm),
    }
  }

  /** Library "Move sound" of a loop/event, in beats (0 before schema v5). */
  sampleShift(sampleId: number): number {
    const cols = this.all<{ name: string }>('PRAGMA table_info(samples)')
    if (!cols.some((c) => c.name === 'shift_beats')) return 0
    return this.all<{ shift_beats: number | null }>('SELECT shift_beats FROM samples WHERE id = ?', sampleId)[0]?.shift_beats ?? 0
  }

  forgetPeaks(sampleId: number): void {
    for (const k of [...this.peakCache.keys()]) if (k.startsWith(`${sampleId}:`)) this.peakCache.delete(k)
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

function toFloats(blob: Uint8Array): Float32Array {
  // SQLite blobs are not necessarily 4-byte aligned: copy when needed.
  const aligned = blob.byteOffset % 4 === 0 ? blob : blob.slice()
  return new Float32Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 4))
}
