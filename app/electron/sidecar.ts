// Spawns the Python engine and speaks JSON-lines RPC with it (SCOPE.md §5.14).
// Plain Node (no Electron imports) so it can be tested on its own.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import type { EngineEvent, HealthResult, RpcResponse } from '../src/types/engine'
import type { EngineStatus } from '../src/types/api'

export interface SidecarOptions {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  /** First start may include `uv sync` (downloads Python + deps): be generous. */
  startTimeoutMs?: number
  healthIntervalMs?: number
  healthTimeoutMs?: number
  /** Restart automatically after a crash (with backoff). */
  autoRestart?: boolean
  log?: (line: string) => void
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout | null
}

export class RpcCallError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

let nextId = 1

export class Sidecar extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, Pending>()
  private stopping = false
  private startTimer: NodeJS.Timeout | null = null
  private healthTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private healthFailures = 0
  private readySince = 0
  private _status: EngineStatus = { state: 'stopped', message: '', health: null, restarts: 0 }

  constructor(private opts: SidecarOptions) {
    super()
  }

  get status(): EngineStatus {
    return this._status
  }

  private setStatus(patch: Partial<EngineStatus>): void {
    this._status = { ...this._status, ...patch }
    this.emit('status', this._status)
  }

  private log(line: string): void {
    this.opts.log?.(line)
  }

  start(): void {
    if (this.proc) return
    this.stopping = false
    this.setStatus({ state: 'starting', message: 'Starting engine…', health: null })
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(this.opts.command, this.opts.args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...this.opts.env, PYTHONUNBUFFERED: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      this.setStatus({ state: 'missing', message: `Could not start engine: ${(e as Error).message}` })
      return
    }
    this.proc = proc
    this.log(`$ ${this.opts.command} ${this.opts.args.join(' ')}  (cwd ${this.opts.cwd})`)

    createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line))
    createInterface({ input: proc.stderr }).on('line', (line) => this.log(line))

    proc.on('error', (err) => {
      // ENOENT etc.: the command itself is missing.
      this.log(`engine spawn error: ${err.message}`)
      this.proc = null
      this.clearTimers()
      this.failPending(new RpcCallError('engine_unavailable', err.message))
      this.setStatus({ state: 'missing', message: `Engine could not be started: ${err.message}` })
    })
    proc.on('exit', (code, signal) => this.onExit(proc, code, signal))

    this.startTimer = setTimeout(() => {
      this.log('engine did not become ready in time; killing it')
      this.setStatus({ message: 'Engine did not start in time' })
      proc.kill('SIGKILL')
    }, this.opts.startTimeoutMs ?? 600_000)
  }

  /** Close stdin (the engine cancels its jobs and exits); kill if it lingers. */
  async stop(): Promise<void> {
    this.stopping = true
    this.clearTimers()
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const proc = this.proc
    if (!proc) {
      this.setStatus({ state: 'stopped', message: 'Engine stopped', health: null })
      return
    }
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => proc.kill('SIGKILL'), 5_000)
      proc.once('exit', () => {
        clearTimeout(kill)
        resolve()
      })
      proc.stdin.end()
    })
  }

  async restart(): Promise<void> {
    await this.stop()
    this.setStatus({ restarts: 0 })
    this.start()
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const proc = this.proc
    if (!proc || this._status.state !== 'ready') {
      // health is also used to *become* ready
      if (!(proc && method === 'health')) {
        return Promise.reject(new RpcCallError('engine_unavailable', `Engine is ${this._status.state}`))
      }
    }
    const id = `r${nextId++}`
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id)
          reject(new RpcCallError('timeout', `${method} timed out`))
        }, timeoutMs)
        : null
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      proc!.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  // ---- internals ----------------------------------------------------------

  private onLine(line: string): void {
    let msg: RpcResponse | EngineEvent | { event: 'ready'; version: string }
    try {
      msg = JSON.parse(line)
    } catch {
      this.log(`[non-JSON on engine stdout] ${line}`)
      return
    }
    if ('event' in msg) {
      if (msg.event === 'ready') {
        void this.becomeReady()
      } else {
        this.emit('event', msg as EngineEvent)
      }
      return
    }
    const res = msg as RpcResponse
    const p = res.id ? this.pending.get(res.id) : undefined
    if (!p) {
      if (res.error) this.log(`engine error: ${res.error.code}: ${res.error.message}`)
      return
    }
    this.pending.delete(res.id!)
    if (p.timer) clearTimeout(p.timer)
    if (res.error) p.reject(new RpcCallError(res.error.code, res.error.message))
    else p.resolve(res.result)
  }

  private async becomeReady(): Promise<void> {
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
    try {
      const health = await this.request<HealthResult>('health', {}, 30_000)
      this.readySince = Date.now()
      this.healthFailures = 0
      this.setStatus({
        state: 'ready',
        message: health.ok ? 'Engine ready' : 'Engine running, but Rubber Band was not found',
        health,
      })
      this.scheduleHealth()
    } catch (e) {
      this.log(`health check failed: ${(e as Error).message}`)
      this.proc?.kill('SIGKILL')
    }
  }

  private scheduleHealth(): void {
    const every = this.opts.healthIntervalMs ?? 20_000
    if (every <= 0) return
    this.healthTimer = setInterval(async () => {
      try {
        const health = await this.request<HealthResult>('health', {}, this.opts.healthTimeoutMs ?? 15_000)
        this.healthFailures = 0
        this._status = { ...this._status, health }
      } catch {
        this.healthFailures += 1
        this.log(`health check failed (${this.healthFailures})`)
        if (this.healthFailures >= 2) this.proc?.kill('SIGKILL')
      }
    }, every)
  }

  private clearTimers(): void {
    if (this.startTimer) clearTimeout(this.startTimer)
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.startTimer = this.healthTimer = null
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  private onExit(proc: ChildProcessWithoutNullStreams, code: number | null, signal: string | null): void {
    if (this.proc !== proc) return
    this.proc = null
    this.clearTimers()
    this.failPending(new RpcCallError('engine_exited', 'Engine exited'))
    this.log(`engine exited (code ${code}, signal ${signal})`)
    if (this.stopping) {
      this.setStatus({ state: 'stopped', message: 'Engine stopped', health: null })
      return
    }
    if (this._status.state === 'missing') return
    this.emit('crashed')
    // Back off 1, 2, 4 … 30 s; a run that stayed healthy for a minute resets the count.
    const restarts = Date.now() - this.readySince > 60_000 && this.readySince ? 0 : this._status.restarts
    const delay = Math.min(30_000, 1000 * 2 ** restarts)
    this.readySince = 0
    this.setStatus({
      state: 'crashed', health: null, restarts: restarts + 1,
      message: `Engine stopped unexpectedly (code ${code ?? signal}); restarting in ${Math.round(delay / 1000)} s`,
    })
    if (this.opts.autoRestart === false) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start()
    }, delay)
  }
}
