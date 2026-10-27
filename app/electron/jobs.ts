// Tracks engine jobs from RPC replies and events. The single source of truth for the
// queue shown in the Process view (it survives view switches and renderer reloads).

import type { EngineEvent, ProcessResult } from '../src/types/engine'
import type { JobInfo, JobMethod } from '../src/types/api'

const ACTIVE = new Set(['queued', 'processing'])

export class JobTracker {
  private jobs = new Map<string, JobInfo>()

  constructor(private onChange: (jobs: JobInfo[]) => void = () => {}) {}

  add(job_id: string, method: JobMethod, label: string, path: string | null = null,
      zip_id: number | null = null): void {
    const existing = this.jobs.get(job_id)
    if (existing) {
      // Events can arrive before the reply that announced the job.
      Object.assign(existing, { method, path, label, zip_id: existing.zip_id ?? zip_id })
    } else {
      this.jobs.set(job_id, {
        job_id, method, label, path, zip_id,
        status: 'queued', stage: '', pct: 0, message: 'Queued', result: null, error: null,
        created: Date.now(), finished: null,
      })
    }
    this.changed()
  }

  handleEvent(e: EngineEvent): void {
    if (e.event === 'progress') {
      const j = this.ensure(e.job_id, e.zip)
      if (!ACTIVE.has(j.status)) return
      Object.assign(j, { status: 'processing', stage: e.stage, pct: e.pct, message: e.message })
    } else if (e.event === 'job_done') {
      const j = this.ensure(e.job_id, e.zip)
      const result = e.result && typeof e.result === 'object' && 'status' in (e.result as object)
        ? e.result as ProcessResult : null
      Object.assign(j, {
        status: e.status, pct: 1, stage: 'done', finished: Date.now(), error: e.error,
        zip_id: e.zip_id ?? j.zip_id, result,
        message: e.error ? e.error.message : doneMessage(e.status, e.counts),
      })
    }
    this.changed()
  }

  /** The engine died: whatever it was doing is lost. */
  engineCrashed(): void {
    let any = false
    for (const j of this.jobs.values()) {
      if (ACTIVE.has(j.status)) {
        Object.assign(j, {
          status: 'error', finished: Date.now(), message: 'Engine stopped unexpectedly',
          error: { code: 'engine_crashed', message: 'Engine stopped unexpectedly' },
        })
        any = true
      }
    }
    if (any) this.changed()
  }

  fail(job_id: string, message: string): void {
    const j = this.jobs.get(job_id)
    if (!j) return
    Object.assign(j, { status: 'error', finished: Date.now(), message, error: { code: 'error', message } })
    this.changed()
  }

  clearFinished(): void {
    for (const [id, j] of this.jobs) if (!ACTIVE.has(j.status)) this.jobs.delete(id)
    this.changed()
  }

  isActive(job_id: string): boolean {
    const j = this.jobs.get(job_id)
    return !!j && ACTIVE.has(j.status)
  }

  get(job_id: string): JobInfo | undefined {
    return this.jobs.get(job_id)
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].sort((a, b) => a.created - b.created)
  }

  private ensure(job_id: string, label: string): JobInfo {
    let j = this.jobs.get(job_id)
    if (!j) {
      j = {
        job_id, method: 'process_zip', label, path: null, zip_id: null, status: 'queued', stage: '',
        pct: 0, message: '', result: null, error: null, created: Date.now(), finished: null,
      }
      this.jobs.set(job_id, j)
    }
    return j
  }

  private changed(): void {
    this.onChange(this.list())
  }
}

function doneMessage(status: string, counts: { oneshots: number; loops: number }): string {
  switch (status) {
    case 'skipped': return 'Already in the library'
    case 'cancelled': return 'Cancelled'
    case 'error': return 'Failed'
    default: return `${counts.oneshots} one-shots, ${counts.loops} loops`
  }
}
