// One AudioContext for the whole app (Library audition and Arrange playback share it, so an
// auditioned loop can start in sync with the transport), plus the decoded-buffer cache.

import { api } from '../api'

let ctx: AudioContext | null = null
let wantedRate = 44100

/** Call once at startup with the library's output sample rate (avoids resampling). */
export function setAudioSampleRate(rate: number): void {
  wantedRate = rate
}

export function audioContext(): AudioContext {
  ctx ??= new AudioContext({ sampleRate: wantedRate, latencyHint: 'interactive' })
  return ctx
}

const CACHE_BYTES = 1.5 * 1024 ** 3 // SCOPE.md §6.4: ~1.5 GB of decoded audio

class BufferCache {
  private buffers = new Map<string, AudioBuffer>()
  private loading = new Map<string, Promise<AudioBuffer>>()
  private bytes = 0

  /** Already decoded (no I/O). */
  get(relPath: string): AudioBuffer | undefined {
    const b = this.buffers.get(relPath)
    if (b) {
      this.buffers.delete(relPath) // LRU: most recently used last
      this.buffers.set(relPath, b)
    }
    return b
  }

  load(relPath: string): Promise<AudioBuffer> {
    const hit = this.get(relPath)
    if (hit) return Promise.resolve(hit)
    let p = this.loading.get(relPath)
    if (!p) {
      p = api.readSample(relPath)
        .then((data) => audioContext().decodeAudioData(data))
        .then((buf) => {
          this.buffers.set(relPath, buf)
          this.bytes += size(buf)
          this.evict()
          return buf
        })
        .finally(() => this.loading.delete(relPath))
      this.loading.set(relPath, p)
    }
    return p
  }

  /** Load many; resolves with the paths that failed (missing files). */
  async loadAll(relPaths: Iterable<string>): Promise<string[]> {
    const failed: string[] = []
    await Promise.all([...new Set(relPaths)].map((p) => this.load(p).catch(() => failed.push(p))))
    return failed
  }

  private evict(): void {
    for (const [k, b] of this.buffers) {
      if (this.bytes <= CACHE_BYTES) break
      this.buffers.delete(k)
      this.bytes -= size(b)
    }
  }
}

function size(b: AudioBuffer): number {
  return b.length * b.numberOfChannels * 4
}

export const buffers = new BufferCache()
