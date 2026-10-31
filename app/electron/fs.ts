// File-system helpers for the main process: settings file, zip discovery, library paths.
// Plain Node (no Electron imports) so it can be tested on its own.

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AppSettings } from '../src/types/api'
import type { ProjectFileInfo } from '../src/types/project'

export const DEFAULT_SETTINGS: AppSettings = {
  libraryPath: null,
  engine: {},
  enginePath: null,
  uvPath: null,
  lastProject: null,
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
export function expandZipPaths(paths: string[]): Promise<string[]> {
  return expandFiles(paths, (p) => p.toLowerCase().endsWith('.zip'))
}

export const SAMPLE_EXTENSIONS = ['wav', 'aif', 'aiff', 'flac']

/** Loose audio files (Splice and other samples) in dropped files and folders. */
export function expandSamplePaths(paths: string[]): Promise<string[]> {
  return expandFiles(paths, (p) => SAMPLE_EXTENSIONS.includes(p.split('.').pop()?.toLowerCase() ?? ''))
}

async function expandFiles(paths: string[], wanted: (path: string) => boolean): Promise<string[]> {
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
    } else if (st.isFile() && wanted(p) && !isJunk(basename(p))) {
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

// ---------------------------------------------------------------------------
// Arrange projects: <Library>/.drumvault/projects/<name>.dvproj
// ---------------------------------------------------------------------------

/** Generate's shortlist: the starred generations (JSON), in the library. */
function shortlistPath(library: string): string {
  return join(library, '.drumvault', 'shortlist.json')
}

export async function readShortlist(library: string): Promise<string | null> {
  try {
    return await readFile(shortlistPath(library), 'utf8')
  } catch {
    return null
  }
}

export async function writeShortlist(library: string, text: string): Promise<void> {
  const path = shortlistPath(library)
  await mkdir(join(library, '.drumvault'), { recursive: true })
  await writeFile(`${path}.tmp`, text)
  await rename(`${path}.tmp`, path)
}

export function projectsDir(library: string): string {
  return join(library, '.drumvault', 'projects')
}

export function projectFileName(name: string): string {
  const safe = name.replace(/[/\\:*?"<>|\x00-\x1f]/g, '-').replace(/^\.+/, '').trim().slice(0, 80)
  return `${safe || 'Untitled'}.dvproj`
}

export async function listProjects(library: string): Promise<ProjectFileInfo[]> {
  const dir = projectsDir(library)
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.dvproj'))
  } catch {
    return []
  }
  const out: ProjectFileInfo[] = []
  for (const file of names) {
    try {
      const path = join(dir, file)
      const [st, text] = await Promise.all([stat(path), readFile(path, 'utf8')])
      const data = JSON.parse(text)
      out.push({ file, name: data.name ?? file.replace(/\.dvproj$/, ''), updatedAt: data.updatedAt ?? '', modified: st.mtimeMs })
    } catch {
      // unreadable file: skip
    }
  }
  return out.sort((a, b) => b.modified - a.modified)
}

export async function readProjectFile(library: string, file: string): Promise<string> {
  return readFile(projectPath(library, file), 'utf8')
}

/**
 * Save a project. The file is named after the project; a rename (name changed since the
 * last save) renames the file, and a new project never overwrites another one.
 * Returns the file name used.
 */
export async function writeProjectFile(library: string, previous: string | null, name: string, text: string): Promise<string> {
  const dir = projectsDir(library)
  await mkdir(dir, { recursive: true })
  const wanted = projectFileName(name)
  let file = previous ?? wanted
  if (file !== wanted) {
    file = existsSync(join(dir, wanted)) ? previous! : wanted  // keep the old name if the new one is taken
  }
  if (!previous) {
    for (let i = 2; existsSync(join(dir, file)); i++) file = projectFileName(`${name} ${i}`)
  }
  const tmp = join(dir, `.${file}.tmp`)
  await writeFile(tmp, text)
  await rename(tmp, join(dir, file))
  if (previous && previous !== file) await unlink(join(dir, previous)).catch(() => {})
  return file
}

export async function deleteProjectFile(library: string, file: string): Promise<void> {
  await unlink(projectPath(library, file))
}

function projectPath(library: string, file: string): string {
  if (file !== basename(file) || !file.endsWith('.dvproj')) throw new Error(`Bad project file name: ${file}`)
  return join(projectsDir(library), file)
}
