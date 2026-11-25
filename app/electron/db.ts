// Read-only access to <Library>/.drumvault/library.sqlite (the engine is the only writer).
// Uses Node's built-in `node:sqlite`, so there is no native module to rebuild for Electron.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expandCompatible } from '../src/lib/camelot'
import { fileName, parseJsonArray } from '../src/lib/format'
import { DEFAULT_GENRE, type Genre, type PeaksFile, type SampleKind, type StemRow } from '../src/types/engine'
import type {
  EventShape, HitItem, LibraryFacets, LoopGroove, MidiItem, PeakPoints, RemovedSample, SampleFilter, SampleListItem, TrackArrangement,
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

const zipListSql = (where = '') => `
  SELECT z.*,
         COALESCE(SUM(s.kind = 'oneshot'), 0) AS oneshots,
         COALESCE(SUM(s.kind = 'loop'), 0) AS loops,
         COALESCE(SUM(s.kind = 'event'), 0) AS events
  FROM zips z LEFT JOIN samples s ON s.zip_id = z.id
  ${where ? `WHERE ${where}` : ''}
  GROUP BY z.id`

/** A WHERE condition and its parameters. */
export type Where = { sql: string; params: (string | number)[] }

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
                                 shapeCol = 's.shape', energyCol = 's.energy_db', toneCol = 's.tone', punchCol = 's.punch_db',
                                 genre?: Where): { sql: string; params: (string | number)[] } {
  const where: string[] = []
  const params: (string | number)[] = []
  if (genre) {
    where.push(genre.sql)
    params.push(...genre.params)
  }
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
           ${shapeCol} AS shape, ${energyCol} AS energy_db, ${toneCol} AS tone, ${punchCol} AS punch_db
    FROM samples s JOIN zips z ON z.id = s.zip_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${SORTS[f.sort ?? 'name'] ?? SORTS.name}`
  return { sql, params }
}

type SampleRow = Omit<SampleListItem, 'name' | 'groove' | 'shape' | 'tone'> & { groove?: string | null; shape?: string | null; tone?: string | null }

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
function toListItem({ groove, shape, tone, ...r }: SampleRow): SampleListItem {
  return {
    ...r, name: fileName(r.rel_path),
    groove: parsed<LoopGroove>(groove, (v) => Array.isArray(v.offsets)),
    shape: parsed<EventShape>(shape, (v) => typeof v.gap === 'number'),
    tone: toneOf(tone),
  }
}

/** A tone column: 24 dB values, or null (unmeasured, silent: '[]'). */
function toneOf(json: string | null | undefined): number[] | null {
  return parsed<number[]>(json, (v) => Array.isArray(v) && v.length > 0)
}

export class LibraryReader {
  private db: DatabaseSync | null = null
  private peakCache = new Map<string, PeakPoints>()

  /** `genre`: the active genre, read at each query: the lists show its sources only. */
  constructor(public readonly library: string | null, private readonly genre: () => Genre = () => DEFAULT_GENRE) {}

  /**
   * The active genre's rows of `table` (by `col`, e.g. `z.genre`). Before schema v21 (no column
   * yet: the engine adds it when it next opens the library) everything is house.
   */
  private genreIs(table: string, col: string): Where {
    if (this.hasColumn(table, 'genre')) return { sql: `COALESCE(${col}, 'house') = ?`, params: [this.genre()] }
    return { sql: this.genre() === DEFAULT_GENRE ? '1 = 1' : '1 = 0', params: [] }
  }

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
    const g = this.genreIs('midi_files', 'genre')
    return this.all<Omit<MidiItem, 'notes' | 'name'> & { notes: string }>(
      `SELECT id, file_name, rel_path, role, bars, key_label, key_camelot, notes, favorite,
              ${this.hasColumn('midi_files', 'source') ? 'source, source_code' : 'NULL AS source, NULL AS source_code'}
       FROM midi_files WHERE ${g.sql} ORDER BY id`, ...g.params)
      .map((r) => ({ ...r, name: r.file_name.replace(/\.midi?$/i, ''), notes: JSON.parse(r.notes) }))
  }

  /** Drop hits (schema v10) and chord stabs (v12), oldest first. */
  listHits(): HitItem[] {
    if (!this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hits'").length) return []
    const kind = this.all<{ name: string }>('PRAGMA table_info(hits)').some((c) => c.name === 'kind') ? "COALESCE(kind, 'disco')" : "'disco'"
    const energy = this.hasColumn('hits', 'energy_db') ? 'energy_db' : 'NULL AS energy_db'
    const tone = this.hasColumn('hits', 'tone') ? 'tone' : 'NULL AS tone'
    const more = this.hasColumn('hits', 'voices') ? 'punch_db, voices' : 'NULL AS punch_db, NULL AS voices'
    const tonal = this.hasColumn('hits', 'tonal') ? 'tonal' : 'NULL AS tonal'
    const bpm = this.hasColumn('hits', 'bpm') ? 'bpm' : 'NULL AS bpm'
    const g = this.genreIs('hits', 'genre')
    return this.all<Omit<HitItem, 'name' | 'tone'> & { tone: string | null }>(
      `SELECT id, ${kind} AS kind, file_name, rel_path, key_label, key_camelot, key_source, pitch_fix, duration_s, channels, ${energy}, ${tone}, ${more}, ${tonal}, ${bpm}
       FROM hits WHERE ${g.sql} ORDER BY id`, ...g.params)
      .map((r) => ({ ...r, tone: toneOf(r.tone), pitch_fix: r.pitch_fix ?? 0, name: r.file_name.replace(/\.(wav|aiff?|flac)$/i, '') }))
  }

  listZips(): ZipListItem[] {
    const g = this.genreIs('zips', 'z.genre')
    return this.all<ZipListItem>(`${zipListSql(g.sql)} ORDER BY z.id DESC`, ...g.params)
  }

  zipDetail(zipId: number): ZipDetail | null {
    const [zip] = this.all<ZipListItem>(`${zipListSql()} HAVING z.id = ?`, zipId)
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

  /** `s.energy_db`, or NULL before schema v13. */
  private energyCol(): string {
    return this.hasColumn('samples', 'energy_db') ? 's.energy_db' : 'NULL'
  }

  /** `s.tone`, or NULL before schema v14. */
  /** `s.punch_db`, or NULL before schema v15. */
  private punchCol(): string {
    return this.hasColumn('samples', 'punch_db') ? 's.punch_db' : 'NULL'
  }

  private toneCol(): string {
    return this.hasColumn('samples', 'tone') ? 's.tone' : 'NULL'
  }

  querySamples(filter: SampleFilter): SampleListItem[] {
    const { sql, params } = buildSampleQuery(filter, this.bodyCol(), this.grooveCol(), this.shapeCol(), this.energyCol(), this.toneCol(), this.punchCol(),
                                             this.genreIs('zips', 'z.genre'))
    return this.all<SampleRow>(sql, ...params).map(toListItem)
  }

  /** Every track's arrangement (schema v7), for Generate's structure templates. */
  arrangements(): TrackArrangement[] {
    if (!this.hasTable('arrangements')) return []
    const detail = this.hasColumn('arrangements', 'detail') ? 'a.detail' : 'NULL AS detail'
    const levels = this.hasColumn('arrangements', 'levels') ? 'a.levels' : 'NULL AS levels'
    const g = this.genreIs('zips', 'z.genre')
    return this.all<Omit<TrackArrangement, 'parts' | 'detail' | 'levels'> & { parts: string; detail: string | null; levels: string | null }>(
      `SELECT a.zip_id, z.source_code, a.bpm, a.bars, a.parts, ${detail}, ${levels} FROM arrangements a JOIN zips z ON z.id = a.zip_id
       WHERE ${g.sql} ORDER BY a.zip_id`, ...g.params).map((r) => ({ ...r, parts: JSON.parse(r.parts) as Record<string, string>,
      detail: r.detail ? JSON.parse(r.detail) as TrackArrangement['detail'] : null,
      levels: parsed<NonNullable<TrackArrangement['levels']>>(r.levels, (v) => typeof v.parts === 'object') }))
  }

  /** Loops without a measured groove, events without a shape, or tracks without an arrangement (older libraries). */
  needsAnalysis(): boolean {
    if (!this.conn()) return false
    // Atmosphere still in the drum library: it moves to the Ambience page (SCOPE.md §6.10a).
    if ((this.all<{ n: number }>("SELECT COUNT(*) AS n FROM samples WHERE category = 'fx_atmos'")[0]?.n ?? 0) > 0) return true
    const loops = this.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM samples WHERE kind = 'loop'${this.hasColumn('samples', 'groove') ? ' AND groove IS NULL' : ''}`)[0]?.n ?? 0
    if (loops) return true
    const events = this.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM samples WHERE kind = 'event'${this.hasColumn('samples', 'shape') ? ' AND shape IS NULL' : ''}`)[0]?.n ?? 0
    if (events) return true
    // Loudness (v13) and tone (v14): every sample and hit.
    if (!this.hasColumn('samples', 'tone') || !this.hasColumn('samples', 'punch_db')) return true
    if ((this.all<{ n: number }>('SELECT COUNT(*) AS n FROM samples WHERE punch_db IS NULL')[0]?.n ?? 0) > 0) return true
    if ((this.all<{ n: number }>('SELECT COUNT(*) AS n FROM samples WHERE energy_db IS NULL OR tone IS NULL')[0]?.n ?? 0) > 0) return true
    if (this.hasTable('hits') && this.hasColumn('hits', 'tone')
        && (this.all<{ n: number }>('SELECT COUNT(*) AS n FROM hits WHERE energy_db IS NULL OR tone IS NULL')[0]?.n ?? 0) > 0) return true
    // Punch and voices (v16): every hit.
    if (this.hasTable('hits') && (!this.hasColumn('hits', 'voices')
        || (this.all<{ n: number }>('SELECT COUNT(*) AS n FROM hits WHERE punch_db IS NULL OR voices IS NULL')[0]?.n ?? 0) > 0)) return true
    // Ambience textures told tonal or noise (v18).
    if (this.hasTable('hits') && this.hasColumn('hits', 'kind')
        && (this.all<{ n: number }>(`SELECT COUNT(*) AS n FROM hits WHERE kind = 'ambience'${this.hasColumn('hits', 'tonal') ? ' AND tonal IS NULL' : ''}`)[0]?.n ?? 0) > 0) return true
    // …and their tempo looked for (v19): a loop is synced to the track.
    if (this.hasTable('hits') && this.hasColumn('hits', 'kind')
        && (this.all<{ n: number }>(`SELECT COUNT(*) AS n FROM hits WHERE kind = 'ambience'${this.hasColumn('hits', 'bpm') ? ' AND bpm IS NULL' : ''}`)[0]?.n ?? 0) > 0) return true
    // Events moved in the Library (v22): their body measured again (the engine clears their shape when it opens the library).
    if (this.hasColumn('samples', 'shift_beats') && Number(this.all<{ v: string }>("SELECT value AS v FROM meta WHERE key = 'schema_version'")[0]?.v ?? 22) < 22
        && (this.all<{ n: number }>("SELECT COUNT(*) AS n FROM samples WHERE kind = 'event' AND shift_beats != 0")[0]?.n ?? 0) > 0) return true
    // The Disco Hits folder renamed Drop Hits (v20): the engine moves it when it opens the library.
    if (this.hasTable('hits')
        && (this.all<{ n: number }>("SELECT COUNT(*) AS n FROM hits WHERE substr(rel_path, 1, 11) = 'Disco Hits/'")[0]?.n ?? 0) > 0) return true
    // Imports from before the library kept its own copy: kept while the zip or folder is still there.
    const lib = this.library
    if (lib && this.all<{ source_code: string; original_path: string | null }>(
      "SELECT source_code, original_path FROM zips WHERE status IN ('done', 'needs_review')")
      .some((z) => !isKept(lib, z.source_code) && !!z.original_path && existsSync(z.original_path))) return true
    const zips = `SELECT COUNT(*) AS n FROM zips z WHERE z.status IN ('done', 'needs_review')${
      this.hasColumn('zips', 'kind') ? " AND z.kind = 'stems'" : ''}`
    // Arrangements measured before the rides (schema v11), the balance (v13) or the tone (v14) were are measured again.
    const measured = this.hasColumn('arrangements', 'levels')
      ? " WHERE detail IS NOT NULL AND levels IS NOT NULL AND json_extract(levels, '$.spectra') IS NOT NULL AND json_extract(levels, '$.vocals_measured') IS NOT NULL" : ' WHERE 0'
    return (this.all<{ n: number }>(this.hasTable('arrangements')
      ? `${zips} AND z.id NOT IN (SELECT zip_id FROM arrangements${measured})` : zips)[0]?.n ?? 0) > 0
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
                ${this.shapeCol()} AS shape, ${this.energyCol()} AS energy_db, ${this.toneCol()} AS tone, ${this.punchCol()} AS punch_db
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
    const g = this.genreIs('zips', 'z.genre')
    const rows = this.all<Omit<SampleListItem, 'name'> & { fingerprint: Uint8Array | null }>(
      `SELECT s.id, s.rel_path, s.kind, s.category, s.bpm, s.bars, ${this.bodyCol()} AS body_bars, s.key_label,
              s.key_camelot, s.duration_s, s.channels, s.favorite, s.rating, s.tags, s.zip_id, z.source_code, s.fingerprint
       FROM samples s JOIN zips z ON z.id = s.zip_id
       WHERE s.kind = ? AND s.category = ? AND s.bars IS ? AND s.id != ? AND ${g.sql}`,
      t.kind, t.category, t.bars, sampleId, ...g.params)
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
    // The active genre's samples only (by their zip's genre).
    const g = this.genreIs('zips', 'z.genre')
    const from = `FROM samples s JOIN zips z ON z.id = s.zip_id WHERE ${g.sql}`
    const total = this.all<{ n: number }>(`SELECT COUNT(*) AS n ${from}`, ...g.params)[0]?.n ?? 0
    return {
      total,
      categories: this.all(`SELECT s.kind, s.category, COUNT(*) AS count ${from} GROUP BY s.kind, s.category ORDER BY s.kind, s.category`, ...g.params),
      keys: this.all(`SELECT s.key_label AS label, s.key_camelot AS camelot, COUNT(*) AS count ${from} GROUP BY s.key_label`, ...g.params),
      bars: this.all<{ bars: number }>(`SELECT DISTINCT s.bars ${from} AND s.bars IS NOT NULL ORDER BY s.bars`, ...g.params).map((r) => r.bars),
      zips: this.all(`SELECT z.id, z.source_code, z.file_name, COUNT(s.id) AS count
                      ${from} GROUP BY z.id ORDER BY z.id`, ...g.params),
      loopBpms: this.all<{ bpm: number }>(`SELECT DISTINCT s.bpm ${from} AND s.bpm IS NOT NULL ORDER BY s.bpm`, ...g.params).map((r) => r.bpm),
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
