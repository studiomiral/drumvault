// Sample auditioning for the Library view (SCOPE.md §6.3): one voice, loops repeat.

import { api } from '../api'
import type { SampleKind } from '../types/engine'

export interface Playable {
  id: number
  rel_path: string
  kind: SampleKind
}

type Listener = (playingId: number | null) => void

const CACHE_BYTES = 512 * 1024 * 1024

class Audition {
  private ctx: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  private cache = new Map<number, AudioBuffer>()
  private bytes = 0
  private token = 0
  private listeners = new Set<Listener>()
  playingId: number | null = null

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private setPlaying(id: number | null): void {
    this.playingId = id
    for (const fn of this.listeners) fn(id)
  }

  private context(): AudioContext {
    this.ctx ??= new AudioContext({ latencyHint: 'interactive' })
    return this.ctx
  }

  async load(s: Playable): Promise<AudioBuffer> {
    const hit = this.cache.get(s.id)
    if (hit) {
      this.cache.delete(s.id) // LRU: move to the end
      this.cache.set(s.id, hit)
      return hit
    }
    const data = await api.readSample(s.rel_path)
    const buf = await this.context().decodeAudioData(data)
    const size = buf.length * buf.numberOfChannels * 4
    this.cache.set(s.id, buf)
    this.bytes += size
    for (const [id, b] of this.cache) {
      if (this.bytes <= CACHE_BYTES) break
      this.cache.delete(id)
      this.bytes -= b.length * b.numberOfChannels * 4
    }
    return buf
  }

  async play(s: Playable): Promise<void> {
    const token = ++this.token
    this.stopSource()
    this.setPlaying(s.id)
    const buf = await this.load(s)
    if (token !== this.token) return // another sample was requested meanwhile
    const ctx = this.context()
    if (ctx.state === 'suspended') await ctx.resume()
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = s.kind === 'loop'
    src.connect(ctx.destination)
    src.onended = () => {
      if (this.source === src) {
        this.source = null
        this.setPlaying(null)
      }
    }
    src.start()
    this.source = src
  }

  toggle(s: Playable): void {
    if (this.playingId === s.id) this.stop()
    else void this.play(s)
  }

  stop(): void {
    this.token++
    this.stopSource()
    this.setPlaying(null)
  }

  private stopSource(): void {
    if (this.source) {
      this.source.onended = null
      try {
        this.source.stop()
      } catch {
        // already stopped
      }
      this.source = null
    }
  }
}

export const audition = new Audition()
