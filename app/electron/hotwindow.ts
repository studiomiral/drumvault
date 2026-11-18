// House of Tracks' upload page in a window of its own (SCOPE.md §6.5b): its own session (the
// login is kept), no preload, nothing but houseoftracks.com loads in it. The app fills the form
// and attaches the files there; the user checks it and submits it on the site.

import { BrowserWindow, shell } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { HotFields, HotFillResult, HotFillRow, UploadCheck } from '../src/types/api'
import {
  DUMP_SCRIPT, fileNameScript, fillScript, HOT_FILE_INPUTS, HOT_FILE_LABELS, HOT_PARTITION, HOT_UPLOAD_URL, isHotUrl, READY_SCRIPT,
  type HotFileInput,
} from './houseoftracks'

let hot: BrowserWindow | null = null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Open (or bring up) the window on the upload page. `onPage`: each page it shows, and null when it closes. */
export function openHot(onPage: (url: string | null) => void): BrowserWindow {
  if (hot && !hot.isDestroyed()) {
    hot.show()
    hot.focus()
    return hot
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 940,
    title: 'House of Tracks',
    backgroundColor: '#1c1d20',
    webPreferences: { partition: HOT_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  hot = win
  const wc = win.webContents
  // Nothing but houseoftracks.com in here: other links open in the browser.
  const outside = (url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  }
  wc.on('will-navigate', (e, url) => {
    if (!isHotUrl(url)) {
      e.preventDefault()
      outside(url)
    }
  })
  wc.on('will-redirect', (e, url) => {
    if (!isHotUrl(url)) e.preventDefault()
  })
  // New windows (their "Upload Requirements" link and the like) go to the browser, so the form stays.
  wc.setWindowOpenHandler(({ url }) => {
    outside(url)
    return { action: 'deny' }
  })
  wc.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  wc.on('did-navigate', (_e, url) => onPage(url))
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => isMainFrame && onPage(url))
  win.on('closed', () => {
    if (hot === win) hot = null
    onPage(null)
  })
  void win.loadURL(HOT_UPLOAD_URL)
  return win
}

/** Wait until the form is on screen and React has it; false when it isn't (not logged in, a slow page). */
async function formReady(win: BrowserWindow, timeoutMs = 30_000): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (win.isDestroyed()) return false
    try {
      if (await win.webContents.executeJavaScript(READY_SCRIPT)) return true
    } catch {
      // the page is between loads
    }
    await sleep(300)
  }
  return false
}

/** The export's files for each file input (instrumental ones only for a track that sings). */
export function hotFiles(check: UploadCheck, sings: boolean): Record<HotFileInput, string | null> {
  return {
    master: check.master,
    masterInstrumental: sings ? check.masterInstrumental : null,
    mixdown: check.mixdown,
    mixdownInstrumental: sings ? check.mixdownInstrumental : null,
    stems: check.zips.stems?.path ?? null,
    midi: check.zips.midi?.path ?? null,
  }
}

/**
 * A clean upload form, filled with `fields`, the files attached (Chrome DevTools Protocol: a page
 * can't set a file input itself), then every field read back. Never presses Next or Submit.
 */
export async function fillHot(fields: HotFields, check: UploadCheck, onPage: (url: string | null) => void): Promise<HotFillResult> {
  const win = openHot(onPage)
  const wc = win.webContents
  // Always a fresh form: nothing left of a track filled before.
  await wc.loadURL(HOT_UPLOAD_URL).catch(() => {})
  if (!(await formReady(win))) {
    return { rows: [], error: `The upload form didn't show (${wc.getURL() || 'no page'}). Log in to House of Tracks in its window, then press Fill again.` }
  }
  await sleep(400)
  const filled = (await wc.executeJavaScript(fillScript(fields, false), true)) as HotFillRow[]

  const sings = fields.vocal !== 'None'
  const files = hotFiles(check, sings)
  const fileRows: HotFillRow[] = []
  const dbg = wc.debugger
  let attached = false
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      attached = true
    }
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: 0 }) as { root: { nodeId: number } }
    for (const input of Object.keys(HOT_FILE_INPUTS) as HotFileInput[]) {
      const path = files[input]
      const label = HOT_FILE_LABELS[input]
      if (!path) {
        if (input.endsWith('Instrumental') && !sings) continue
        fileRows.push({ field: label, value: '', ok: false, note: 'no file for it in the export' })
        continue
      }
      try {
        const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: HOT_FILE_INPUTS[input] }) as { nodeId: number }
        if (!nodeId) {
          fileRows.push({ field: label, value: basename(path), ok: false, note: `not found on the page (${HOT_FILE_INPUTS[input]})` })
          continue
        }
        await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [path] })
        fileRows.push({ field: label, value: basename(path), ok: true })
      } catch (e) {
        fileRows.push({ field: label, value: basename(path), ok: false, note: (e as Error).message })
      }
    }
  } catch (e) {
    fileRows.push({ field: 'Files', value: '', ok: false, note: `couldn't attach files: ${(e as Error).message}` })
  } finally {
    if (attached && dbg.isAttached()) dbg.detach()
  }

  // Read everything back once the page has caught up: React may have redrawn after the files.
  await sleep(600)
  const checked = (await wc.executeJavaScript(fillScript(fields, true), true)) as HotFillRow[]
  const rows = checked.map((r) => {
    const f = filled.find((x) => x.field === r.field)
    return !r.ok && f?.note ? { ...r, note: f.note } : r
  })
  for (const r of fileRows) {
    if (!r.ok) continue
    const input = (Object.keys(HOT_FILE_LABELS) as HotFileInput[]).find((k) => HOT_FILE_LABELS[k] === r.field)!
    const name = await wc.executeJavaScript(fileNameScript(input)).catch(() => null) as string | null
    if (name !== r.value) Object.assign(r, { ok: false, note: name ? `the page holds ${name}` : 'the page holds no file' })
  }
  return { rows: [...rows, ...fileRows] }
}

/** Dev only: the page's fields to a JSON file in `dir`; returns its path. */
export async function dumpHot(dir: string): Promise<string> {
  if (!hot || hot.isDestroyed()) throw new Error('Open House of Tracks first')
  const data = await hot.webContents.executeJavaScript(DUMP_SCRIPT)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `form-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  await writeFile(file, JSON.stringify(data, null, 2))
  return file
}
