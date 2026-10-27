import { describe, expect, it } from 'vitest'
import { JobTracker } from '../electron/jobs'

describe('JobTracker', () => {
  it('follows a job from queued to done, even if events beat the reply', () => {
    const snapshots: number[] = []
    const t = new JobTracker((jobs) => snapshots.push(jobs.length))
    t.handleEvent({ event: 'progress', job_id: 'a', zip: 'x.zip', stage: 'extract', pct: 0.1, message: 'Hashing' })
    t.add('a', 'process_zip', 'x.zip', '/z/x.zip')
    expect(t.get('a')).toMatchObject({ status: 'processing', path: '/z/x.zip', stage: 'extract' })
    t.handleEvent({
      event: 'job_done', job_id: 'a', zip_id: 3, zip: 'x.zip', status: 'done',
      counts: { oneshots: 4, loops: 9, events: 2 }, result: null, error: null,
    })
    expect(t.get('a')).toMatchObject({ status: 'done', zip_id: 3, pct: 1, message: '4 one-shots, 9 loops, 2 FX/fills' })
    expect(t.isActive('a')).toBe(false)
    expect(snapshots.length).toBeGreaterThan(0)
  })

  it('ignores late progress after completion and fails active jobs on a crash', () => {
    const t = new JobTracker()
    t.add('a', 'process_zip', 'a.zip')
    t.add('b', 'process_zip', 'b.zip')
    t.handleEvent({ event: 'job_done', job_id: 'a', zip_id: 1, zip: 'a.zip', status: 'skipped', counts: { oneshots: 0, loops: 0, events: 0 }, result: null, error: null })
    t.handleEvent({ event: 'progress', job_id: 'a', zip: 'a.zip', stage: 'tempo', pct: 0.2, message: '' })
    expect(t.get('a')?.status).toBe('skipped')
    t.engineCrashed()
    expect(t.get('b')).toMatchObject({ status: 'error', message: 'Engine stopped unexpectedly' })
    t.clearFinished()
    expect(t.list()).toEqual([])
  })
})
