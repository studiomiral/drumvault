// Sample auditioning (SCOPE.md §6.3): one voice, loops repeat. While the Arrange transport
// is playing, an auditioned loop starts on the next bar, in sync.

import type { SampleKind } from '../types/engine'
import { audioContext, buffers } from './context'
import { playback } from './engine'

export interface Playable {
  id: number
  rel_path: string
  kind: SampleKind
  bars?: number | null
}

type Listener = (playingId: number | null) => void

class Audition {
  private source: AudioBufferSourceNode | null = null
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

  async play(s: Playable): Promise<void> {
    const token = ++this.token
    this.stopSource()
    this.setPlaying(s.id)
    const buf = await buffers.load(s.rel_path)
    if (token !== this.token) return // another sample was requested meanwhile
    const ctx = audioContext()
    if (ctx.state === 'suspended') await ctx.resume()
    const done = () => {
      if (this.token === token) this.setPlaying(null)
    }
    if (playback.auditionSynced(buf, s.kind, s.bars ?? null, done)) return
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = s.kind === 'loop'
    src.connect(ctx.destination)
    src.onended = () => {
      if (this.source === src) {
        this.source = null
        done()
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
    playback.stopAudition()
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
