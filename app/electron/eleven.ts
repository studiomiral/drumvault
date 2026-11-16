// ElevenLabs (SCOPE.md §6.11): the API key, kept encrypted with the macOS keychain (Electron
// safeStorage) in the app-data folder, never in settings.json; and the calls the app makes with it.

import { app, safeStorage } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElevenStatus } from '../src/types/api'

const API = 'https://api.elevenlabs.io'
const keyFile = () => join(app.getPath('userData'), 'elevenlabs.key')

async function key(): Promise<string | null> {
  if (!existsSync(keyFile())) return null
  return safeStorage.decryptString(await readFile(keyFile()))
}

export async function setKey(k: string): Promise<ElevenStatus> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('The macOS keychain is not available to keep the key')
  await writeFile(keyFile(), safeStorage.encryptString(k.trim()), { mode: 0o600 })
  return status()
}

export async function clearKey(): Promise<void> {
  await rm(keyFile(), { force: true })
}

/** Seconds to wait before each new try when ElevenLabs is busy (429 heavy traffic, 503): then it gives up. */
const BUSY_RETRIES_S = [5, 15, 30, 60]

/**
 * An authorised request to the ElevenLabs API; throws with ElevenLabs' message when it fails. When
 * ElevenLabs is busy (429, 503) it waits and tries again, a few times: a failed try costs nothing.
 */
export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const k = await key()
  if (!k) throw new Error('No ElevenLabs API key: add it in Settings')
  let r = await fetch(`${API}${path}`, { ...init, headers: { ...init.headers, 'xi-api-key': k } })
  for (const wait of BUSY_RETRIES_S) {
    if (r.status !== 429 && r.status !== 503) break
    await new Promise((done) => setTimeout(done, wait * 1000))
    r = await fetch(`${API}${path}`, { ...init, headers: { ...init.headers, 'xi-api-key': k } })
  }
  if (!r.ok) {
    const text = await r.text()
    let msg = text
    try {
      const d = JSON.parse(text).detail
      msg = typeof d === 'string' ? d : d?.message ?? JSON.stringify(d)
    } catch {
      // not JSON: the text as it is
    }
    throw new Error(`ElevenLabs ${r.status}: ${msg.slice(0, 300)}`)
  }
  return r
}

/** Whether there's a key, and if it works, the plan and its credits. */
export async function status(): Promise<ElevenStatus> {
  if (!(await key())) return { hasKey: false }
  try {
    const s = await (await request('/v1/user/subscription')).json() as {
      tier: string; character_count: number; character_limit: number; next_character_count_reset_unix?: number | null
    }
    return {
      hasKey: true, tier: s.tier,
      credits: {
        used: s.character_count, limit: s.character_limit,
        resetsAt: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null,
      },
    }
  } catch (e) {
    return { hasKey: true, error: (e as Error).message }
  }
}

/** A generated take: the audio, and the response headers (the song id is among them). */
export interface Take {
  audio: Buffer
  headers: Record<string, string>
}

/** Compose music from a composition plan (POST /v1/music): `format` like mp3_44100_128. */
export async function compose(plan: unknown, format: string, model = 'music_v1'): Promise<Take> {
  const r = await request(`/v1/music?output_format=${encodeURIComponent(format)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ composition_plan: plan, model_id: model }),
  })
  const headers: Record<string, string> = {}
  r.headers.forEach((v, k) => (headers[k] = v))
  return { audio: Buffer.from(await r.arrayBuffer()), headers }
}

/** Split a take into vocal and instrumental (POST /v1/music/stem-separation, two stems): a zip, one file per stem. */
export async function separate(audio: Buffer, fileName: string, format: string): Promise<Buffer> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), fileName)
  form.append('stem_variation_id', 'two_stems_v1')
  const r = await request(`/v1/music/stem-separation?output_format=${encodeURIComponent(format)}`, { method: 'POST', body: form })
  return Buffer.from(await r.arrayBuffer())
}
