// The Upload page's file work (SCOPE.md §6.5b): exported tracks listed, a project folder checked,
// its stems/ and midi/ zipped for House of Tracks, and what was uploaded remembered.
// Plain Node (no Electron imports) so it can be tested on its own.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { UploadCheck, UploadFolder, UploadRecord, UploadZip, ZipPart } from '../src/types/api'
import { writeAtomic } from './fs'

export const INFO_FILE = 'info.txt'
export const ZIP_PARTS: ZipPart[] = ['stems', 'midi']

const isJunk = (name: string) => name.startsWith('.') || name === '__MACOSX'

async function files(dir: string, ext: RegExp): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && !isJunk(e.name) && ext.test(e.name)).map((e) => e.name).sort()
  } catch {
    return []
  }
}

/** The export folders in `dir` (those with info.txt at their top), newest export first. */
export async function listExports(dir: string): Promise<UploadFolder[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: UploadFolder[] = []
  for (const e of entries) {
    if (!e.isDirectory() || isJunk(e.name)) continue
    const path = join(dir, e.name)
    const info = join(path, INFO_FILE)
    try {
      const [text, st] = await Promise.all([readFile(info, 'utf8'), stat(info)])
      out.push({ name: e.name, path, info: text, modified: st.mtimeMs, check: await checkFolder(path) })
    } catch {
      // no info.txt: not an export
    }
  }
  return out.sort((a, b) => b.modified - a.modified)
}

/**
 * What a project folder holds for the upload: the masters (any "… mastered.wav", since a master
 * redone by hand is renamed "Bring It mastered.wav"; the instrumental ones apart), the stems and
 * MIDI files, info.txt, and the zips made of stems/ and midi/ (fresh: newer than what's in them).
 */
export async function checkFolder(path: string): Promise<UploadCheck> {
  const masters = await files(join(path, 'masters'), /\.wav$/i)
  const pick = (re: RegExp) => {
    const name = masters.find((n) => re.test(n))
    return name ? join(path, 'masters', name) : null
  }
  const stems = await files(join(path, 'stems'), /\.wav$/i)
  const midi = await files(join(path, 'midi'), /\.midi?$/i)
  const zips = {} as UploadCheck['zips']
  for (const part of ZIP_PARTS) zips[part] = await zipState(path, part)
  return {
    master: pick(/(^|[\s_-])mastered\.wav$/i),
    masterInstrumental: pick(/(^|[\s_-])mastered instrumental\.wav$/i),
    mixdown: pick(/^mixdown\.wav$/i),
    mixdownInstrumental: pick(/^mixdown instrumental\.wav$/i),
    stems: stems.length,
    midi: midi.length,
    info: existsSync(join(path, INFO_FILE)),
    zips,
  }
}

/** The zip of a part, next to it in the project folder, and whether it is newer than what it holds. */
async function zipState(path: string, part: ZipPart): Promise<UploadZip | null> {
  const zip = join(path, `${part}.zip`)
  let st
  try {
    st = await stat(zip)
  } catch {
    return null
  }
  const dir = join(path, part)
  let newest = 0
  try {
    newest = (await stat(dir)).mtimeMs
    for (const name of await files(dir, /./)) newest = Math.max(newest, (await stat(join(dir, name))).mtimeMs)
  } catch {
    // no folder: the zip is all there is
  }
  return { path: zip, size: st.size, fresh: st.mtimeMs >= newest }
}

/** Bytes of the files in a folder (the zip's progress is counted against them). */
async function folderBytes(dir: string): Promise<number> {
  let total = 0
  for (const name of await files(dir, /./)) total += (await stat(join(dir, name))).size
  return total
}

/**
 * Zip `<path>/<part>/` into `<path>/<part>.zip` as Finder's Compress does (`ditto -c -k
 * --sequesterRsrc --keepParent`: the folder at the top of the zip), in a child process. Written
 * under a temporary name and renamed when done, so a cancelled or failed zip leaves no half file.
 * `onProgress` gets the bytes zipped so far (ditto -V names each file with its size) of the total.
 */
export function zipPart(path: string, part: ZipPart, onProgress: (done: number, total: number) => void,
  ditto = '/usr/bin/ditto'): { done: Promise<UploadZip>; cancel: () => void } {
  if (!isAbsolute(path) || !ZIP_PARTS.includes(part)) throw new Error(`Bad zip request: ${path} ${part}`)
  const out = join(path, `${part}.zip`)
  const tmp = join(path, `.${part}.zip.part`)
  let child: ReturnType<typeof spawn> | null = null
  let cancelled = false
  const done = (async () => {
    const total = await folderBytes(join(path, part))
    if (!total) throw new Error(`${part}/ is empty`)
    await unlink(tmp).catch(() => {})
    onProgress(0, total)
    await new Promise<void>((resolve, reject) => {
      child = spawn(ditto, ['-V', '-c', '-k', '--sequesterRsrc', '--keepParent', part, tmp], { cwd: path, stdio: ['ignore', 'pipe', 'pipe'] })
      let zipped = 0
      let err = ''
      let buf = ''
      const onData = (chunk: Buffer) => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const l of lines) {
          const m = /^(\d+) bytes for /.exec(l)
          if (m) {
            zipped += Number(m[1])
            onProgress(Math.min(zipped, total), total)
          } else if (!/^(>>> Copying|copying file)/.test(l) && l.trim()) {
            err += `${l}\n`
          }
        }
      }
      child.stdout!.on('data', onData)
      child.stderr!.on('data', onData)
      child.on('error', reject)
      child.on('close', (code) => {
        if (cancelled) reject(new Error('Cancelled'))
        else if (code === 0) resolve()
        else reject(new Error(`ditto failed (${code}): ${err.trim().slice(0, 300)}`))
      })
    })
    await rename(tmp, out)
    const st = await stat(out)
    onProgress(total, total)
    return { path: out, size: st.size, fresh: true }
  })().catch(async (e) => {
    await unlink(tmp).catch(() => {})
    throw e
  })
  return {
    done,
    cancel: () => {
      cancelled = true
      ;(child as ReturnType<typeof spawn> | null)?.kill()
    },
  }
}

// ---------------------------------------------------------------------------
// What was uploaded: <Library>/.drumvault/uploads.json, by export folder name
// ---------------------------------------------------------------------------

export function uploadsFile(library: string): string {
  return join(library, '.drumvault', 'uploads.json')
}

export async function readUploads(library: string): Promise<Record<string, UploadRecord>> {
  try {
    const data = JSON.parse(await readFile(uploadsFile(library), 'utf8'))
    return data && typeof data.tracks === 'object' ? data.tracks : {}
  } catch {
    return {}
  }
}

// Writes go one after another, so two quick changes don't read the same old file.
let queue: Promise<unknown> = Promise.resolve()

/** Merge `patch` into the record of the export folder `name`; returns the record. */
export function writeUpload(library: string, name: string, patch: Partial<UploadRecord>): Promise<UploadRecord> {
  if (!name || name !== basename(name)) throw new Error(`Bad track name: ${name}`)
  const next = queue.then(async () => {
    const tracks = await readUploads(library)
    const rec: UploadRecord = { ...(tracks[name] ?? { status: 'none' }), ...patch }
    tracks[name] = rec
    await mkdir(dirname(uploadsFile(library)), { recursive: true })
    await writeAtomic(uploadsFile(library), JSON.stringify({ version: 1, tracks }, null, 2))
    return rec
  })
  queue = next.catch(() => {})
  return next
}
