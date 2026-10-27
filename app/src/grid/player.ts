// Grid view playback: the summed drum stems with a metronome on the grid being set. Clicks
// are scheduled a little ahead; moving bar 1 cancels the ones not yet heard, so a drag is
// audible straight away.

import { audition } from '../audio/audition'
import { audioContext } from '../audio/context'
import { playback } from '../audio/engine'
import { beatsIn, isDownbeat } from './analysis'

const LOOKAHEAD = 0.12
const TICK_MS = 25

function clickBuffer(ctx: AudioContext, freq: number): AudioBuffer {
  const len = Math.round(ctx.sampleRate * 0.04)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) {
    const t = i / ctx.sampleRate
    d[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / 0.008) * Math.min(1, t / 0.0005)
  }
  return buf
}

type Listener = () => void

export class GridPlayer {
  buffer: AudioBuffer | null = null
  bar1 = 0
  beat = 0.5
  metronome = true
  private source: AudioBufferSourceNode | null = null
  private drums: GainNode | null = null
  private clickGain: GainNode | null = null
  private clicks: { node: AudioBufferSourceNode; when: number }[] = []
  private sounds: { accent: AudioBuffer; beat: AudioBuffer } | null = null
  private t0 = 0
  private from = 0
  private stoppedAt = 0
  private horizon = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<Listener>()
  private levels = { drums: 0.9, click: 0.5 }

  get playing(): boolean {
    return this.source != null
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  /** Playhead in seconds of the stems. */
  position(): number {
    if (!this.source) return this.stoppedAt
    return Math.min(this.from + audioContext().currentTime - this.t0, this.buffer?.duration ?? 0)
  }

  setPosition(sec: number): void {
    const at = Math.max(0, Math.min(sec, this.buffer?.duration ?? 0))
    if (this.source) this.play(at)
    else {
      this.stoppedAt = at
      this.emit()
    }
  }

  setLevel(which: 'drums' | 'click', v: number): void {
    this.levels[which] = v
    const g = which === 'drums' ? this.drums : this.clickGain
    g?.gain.setTargetAtTime(v, audioContext().currentTime, 0.01)
  }

  level(which: 'drums' | 'click'): number {
    return this.levels[which]
  }

  setBar1(sec: number): void {
    this.bar1 = sec
    this.reschedule()
  }

  setMetronome(on: boolean): void {
    this.metronome = on
    this.reschedule()
    this.emit()
  }

  play(from = this.stoppedAt): void {
    if (!this.buffer) return
    playback.stop()
    audition.stop()
    this.halt()
    const ctx = audioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    this.sounds ??= { accent: clickBuffer(ctx, 1760), beat: clickBuffer(ctx, 1320) }
    this.drums = ctx.createGain()
    this.drums.gain.value = this.levels.drums
    this.drums.connect(ctx.destination)
    this.clickGain = ctx.createGain()
    this.clickGain.gain.value = this.levels.click
    this.clickGain.connect(ctx.destination)
    const src = ctx.createBufferSource()
    src.buffer = this.buffer
    src.connect(this.drums)
    this.from = from >= this.buffer.duration - 0.05 ? 0 : from
    this.t0 = ctx.currentTime + 0.03
    this.horizon = this.from
    src.start(this.t0, this.from)
    src.onended = () => {
      if (this.source === src) this.stop()
    }
    this.source = src
    this.tick()
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.emit()
  }

  stop(): void {
    const at = this.position()
    this.halt()
    this.stoppedAt = at
    this.emit()
  }

  toggle(): void {
    if (this.playing) this.stop()
    else this.play()
  }

  private halt(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const src = this.source
    this.source = null
    try {
      src?.stop()
    } catch {
      // never started
    }
    for (const c of this.clicks) c.node.stop()
    this.clicks = []
    this.drums?.disconnect()
    this.clickGain?.disconnect()
    this.drums = this.clickGain = null
  }

  /** Drop the clicks not yet heard and schedule again from the playhead (after a grid change). */
  private reschedule(): void {
    if (!this.source) return
    const now = audioContext().currentTime
    this.clicks = this.clicks.filter((c) => {
      if (c.when <= now) return true
      c.node.stop()
      return false
    })
    this.horizon = this.position()
    this.tick()
  }

  private tick(): void {
    const ctx = audioContext()
    if (!this.source || !this.sounds || !this.clickGain) return
    const until = this.position() + LOOKAHEAD
    if (this.metronome) {
      for (const b of beatsIn(this.horizon, until, this.bar1, this.beat)) {
        const when = this.t0 + (b.time - this.from)
        if (when < ctx.currentTime) continue
        const node = ctx.createBufferSource()
        node.buffer = isDownbeat(b.index) ? this.sounds.accent : this.sounds.beat
        node.connect(this.clickGain)
        node.start(when)
        this.clicks.push({ node, when })
      }
    }
    this.horizon = until
    const now = ctx.currentTime
    this.clicks = this.clicks.filter((c) => c.when > now - 0.1)
  }
}

export const gridPlayer = new GridPlayer()
