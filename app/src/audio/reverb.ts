// The lane reverb for reverb builds (SCOPE.md §6.6): a dark hall, its impulse generated here (no
// files, no plugin), the same in live playback and offline export. Clips send to it by their
// `verb` amount; it returns into the lane before its volume, sidechain and pan, so the wash is
// part of the lane's stem and its tail rings on over the drop or break.
//
// send → high-pass (the low end stays out of the wash) → convolver → lane

/** Seconds the tail takes to fall by 60 dB, and the impulse's length. */
const DECAY_S = 2.8
const LENGTH_S = 3.4
const PREDELAY_S = 0.02
/** Seconds the reflections take to thicken into the tail. */
const ONSET_S = 0.03
/** Below this the send is cut: kick and bass stay clean under the wash. */
const SEND_HIGHPASS_HZ = 280
/** The tail darkens from bright to dark (one-pole damping), most of it in the first `DARKEN_S`. */
const BRIGHT_HZ = 9000
const DARK_HZ = 1800
const DARKEN_S = 0.6
/** The last part of the impulse fades to silence (no click where it ends). */
const END_FADE_S = 0.15
/**
 * Level of the wet return. The convolver normalises the impulse, which leaves a send of 1 about
 * 7 dB under the dry sound; this brings it to about as loud as the dry sound.
 */
const WET_GAIN = 2

export interface Reverb {
  /** What clips send into. */
  input: GainNode
  /** Into the lane (disconnect to drop the reverb and its tail). */
  output: GainNode
}

const impulses = new WeakMap<BaseAudioContext, AudioBuffer>()

/** The hall's impulse at the context's rate: decaying, darkening noise, its own in each channel. */
function impulse(ctx: BaseAudioContext): AudioBuffer {
  const cached = impulses.get(ctx)
  if (cached) return cached
  const sr = ctx.sampleRate
  const n = Math.round(LENGTH_S * sr)
  const pre = Math.round(PREDELAY_S * sr)
  const buf = ctx.createBuffer(2, n, sr)
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch)
    // Seeded noise: the same hall every time, so an export is the same as the last one.
    let seed = (0x9e3779b9 ^ Math.imul(ch + 1, 0x85ebca6b)) >>> 0
    let lp = 0
    for (let i = pre; i < n; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const t = (i - pre) / sr
      const fc = DARK_HZ + (BRIGHT_HZ - DARK_HZ) * Math.exp(-t / DARKEN_S)
      lp += (1 - Math.exp((-2 * Math.PI * fc) / sr)) * ((seed / 2 ** 31) - 1 - lp)
      const env = 10 ** ((-3 * t) / DECAY_S) * Math.min(1, t / ONSET_S) * Math.min(1, (n - i) / (END_FADE_S * sr))
      data[i] = lp * env
    }
  }
  impulses.set(ctx, buf)
  return buf
}

/** A reverb returning into `dest`. */
export function createReverb(ctx: BaseAudioContext, dest: AudioNode): Reverb {
  const input = ctx.createGain()
  input.channelCount = 2
  input.channelCountMode = 'explicit'
  input.channelInterpretation = 'speakers'
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = SEND_HIGHPASS_HZ
  hp.Q.value = 0.7
  const conv = ctx.createConvolver()
  conv.normalize = true
  conv.buffer = impulse(ctx)
  const output = ctx.createGain()
  output.gain.value = WET_GAIN
  input.connect(hp).connect(conv).connect(output).connect(dest)
  return { input, output }
}
