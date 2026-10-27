// File-system helpers for the main process: settings file, zip discovery, library paths.
// Plain Node (no Electron imports) so it can be tested on its own.

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AppSettings } from '../src/types/api'

export const DEFAULT_SETTINGS: AppSettings = {
  libraryPath: null,
  engine: {},
  enginePath: null,
  uvPath: null,
}

export async function loadSettings(file: string): Promise<AppSettings> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'))
    return { ...DEFAULT_SETTINGS, ...data, engine: { ...(data.engine ?? {}) } }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(file: string, settings: AppSettings): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(settings, null, 2))
  await rename(tmp, file) // atomic replace
}

function isJunk(name: string): boolean {
  return name.startsWith('.') || name === '__MACOSX'
}

/** Dropped/selected files and folders -> zip files (folders searched recursively). */
export async function expandZipPaths(paths: string[]): Promise<string[]> {
  const out: string[] = []
  const walk = async (p: string): Promise<void> => {
    let st
    try {
      st = await stat(p)
    } catch {
      return
    }
    if (st.isDirectory()) {
      const entries = await readdir(p, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      for (const e of entries) {
        if (!isJunk(e.name)) await walk(join(p, e.name))
      }
    } else if (st.isFile() && p.toLowerCase().endsWith('.zip') && !isJunk(basename(p))) {
      out.push(resolve(p))
    }
  }
  for (const p of paths) await walk(p)
  return [...new Set(out)]
}

/** Absolute path of a library-relative sample path; refuses paths escaping the library. */
export function libraryFile(library: string, relPath: string): string {
  const abs = resolve(library, relPath)
  const rel = relative(resolve(library), abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path outside the library: ${relPath}`)
  }
  return abs
}

/**
 * PATH for child processes. Apps started from Finder get a minimal PATH that
 * misses Homebrew and uv's install location.
 */
export function augmentedPath(base = process.env.PATH ?? ''): string {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'),
    join(homedir(), '.cargo', 'bin')]
  const parts = base.split(delimiter).filter(Boolean)
  for (const e of extra) if (!parts.includes(e)) parts.push(e)
  return parts.join(delimiter)
}

/** The repo's `engine` folder: next to the app folder, searching upwards from `start`. */
export function findEngineDir(start: string, levels = 5): string | null {
  let dir = resolve(start)
  for (let i = 0; i <= levels; i++) {
    const candidate = join(dir, 'engine')
    if (existsSync(join(candidate, 'pyproject.toml'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** First executable named `name` on `path`. */
export function which(name: string, path = augmentedPath()): string | null {
  if (isAbsolute(name)) return existsSync(name) ? name : null
  for (const dir of path.split(delimiter)) {
    const candidate = join(dir, name)
    if (dir && existsSync(candidate)) return candidate
  }
  return null
}
