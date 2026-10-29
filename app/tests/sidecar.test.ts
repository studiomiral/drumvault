import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { LibraryReader } from '../electron/db'
import { augmentedPath } from '../electron/fs'
import { JobTracker } from '../electron/jobs'
import { RpcCallError, Sidecar } from '../electron/sidecar'
import { encodeWav } from '../src/audio/wav'
import type { EngineEvent, HealthResult, JobAccepted } from '../src/types/engine'

const uv = inject('uv')
const engineDir = inject('engineDir')
const fixturesDir = inject('fixturesDir')

function waitFor<T>(emitter: Sidecar, event: string, pred: (x: T) => boolean, ms = 240_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms)
    const on = (x: T) => {
      if (pred(x)) {
        clearTimeout(t)
        emitter.off(event, on)
        resolve(x)
      }
    }
    emitter.on(event, on)
  })
}

describe('Sidecar with a missing command', () => {
  it('reports the engine as missing instead of crashing', async () => {
    const s = new Sidecar({ command: '/nonexistent/uv', args: [], cwd: tmpdir(), autoRestart: false })
    const status = waitFor<{ state: string }>(s, 'status', (x) => x.state === 'missing', 10_000)
    s.start()
    expect((await status).state).toBe('missing')
    await expect(s.request('health')).rejects.toBeInstanceOf(RpcCallError)
  })
})

describe.skipIf(!uv || !fixturesDir)('Sidecar with the real engine', () => {
  let s: Sidecar
  const lines: string[] = []

  beforeAll(async () => {
    s = new Sidecar({
      command: uv!, args: ['run', '--project', engineDir, 'python', '-m', 'drumvault_engine'],
      cwd: engineDir, env: { PATH: augmentedPath() }, log: (l) => lines.push(l), healthIntervalMs: 0,
    })
    const ready = waitFor<{ state: string }>(s, 'status', (x) => x.state === 'ready')
    s.start()
    await ready
  }, 300_000)
  afterAll(async () => {
    await s?.stop()
  })

  it('is healthy', async () => {
    expect(s.status.health?.version).toBeTruthy()
    const h = await s.request<HealthResult>('health')
    expect(h.rubberband).toBeTruthy()
  })

  it('runs a job and reports progress through to job_done', async () => {
    const lib = mkdtempSync(join(tmpdir(), 'dv-sidecar-lib-'))
    const tracker = new JobTracker()
    s.on('event', (e: EngineEvent) => tracker.handleEvent(e))
    const path = join(fixturesDir!, 'Deep Groove (Original Mix) Stems.zip')
    const acc = await s.request<JobAccepted>('process_zip', { path, settings: { library_path: lib } })
    tracker.add(acc.job_id, 'process_zip', 'Deep Groove', path)
    const done = await waitFor<EngineEvent>(s, 'event', (e) => e.event === 'job_done' && e.job_id === acc.job_id)
    expect(done).toMatchObject({ status: 'done', zip_id: 1 })
    expect(tracker.get(acc.job_id)).toMatchObject({ status: 'done', zip_id: 1 })
    expect(tracker.get(acc.job_id)?.result?.analysis?.tempo.bpm).toBe(124)
  }, 240_000)

  it('imports loose samples as a pack, which needs no structure analysis', async () => {
    const lib = mkdtempSync(join(tmpdir(), 'dv-sidecar-lib-'))
    const pack = join(mkdtempSync(join(tmpdir(), 'dv-pack-')), 'Garage Kit')
    mkdirSync(pack)
    // A decaying 60 Hz thump: a kick one-shot.
    const kick = new Float32Array(22050).map((_, i) => 0.8 * Math.sin((2 * Math.PI * 60 * i) / 44100) * Math.exp(-i / 4000))
    writeFileSync(join(pack, 'GK_Kick_01.wav'), Buffer.from(encodeWav([kick], 44100, 'pcm24')))
    const acc = await s.request<JobAccepted>('import_samples', { paths: [pack], settings: { library_path: lib } })
    const done = await waitFor<EngineEvent>(s, 'event', (e) => e.event === 'job_done' && e.job_id === acc.job_id)
    expect(done).toMatchObject({ status: 'done', counts: { oneshots: 1, loops: 0, events: 0 } })
    const reader = new LibraryReader(lib)
    try {
      expect(reader.listZips()).toMatchObject([{ source_code: 'P0001', file_name: 'Garage Kit', kind: 'pack', oneshots: 1 }])
      expect(reader.needsAnalysis()).toBe(false)  // no arrangement, and none expected
    } finally {
      reader.close()
    }
  }, 240_000)

  it('rejects RPC errors with their code', async () => {
    await expect(s.request('reprocess_zip', { zip_id: 'nope' })).rejects.toMatchObject({ code: 'bad_params' })
  })

  it('restarts after a crash', async () => {
    const crashed = waitFor<{ state: string }>(s, 'status', (x) => x.state === 'crashed', 20_000)
    ;(s as unknown as { proc: { kill(sig: string): void } }).proc.kill('SIGKILL')
    expect((await crashed).state).toBe('crashed')
    await waitFor<{ state: string }>(s, 'status', (x) => x.state === 'ready', 120_000)
    expect(s.status.restarts).toBe(1)
  }, 180_000)
})
