// The lane reverb for reverb builds (SCOPE.md §6.6): a dark hall, its impulse generated here (no
// files, no plugin), the same in live playback and offline export. Clips send to it by their
// `verb` amount; it returns into the lane before its volume, sidechain and pan, so the wash is
// part of the lane's stem and its tail rings on over the drop or break.
//
// send → high-pass (the low end stays out of the wash) → convolver → lane

export type ReverbKind = 'hall' | 'room'

/**
 * Per kind: seconds the tail takes to fall by 60 dB and the impulse's length; the pre-delay; the
 * seconds the reflections take to thicken into the tail; how the tail darkens (one-pole damping,
 * from bright to dark, most of it in the first `darken` seconds). The hall is the reverb builds';
 * the room is short and close: what stabs from different packs are put in, so they sit in one space.
 */
const KINDS: Record<ReverbKind, { decay: number; length: number; predelay: number; onset: number; bright: number; dark: number; darken: number }> = {
  hall: { decay: 2.8, length: 3.4, predelay: 0.02, onset: 0.03, bright: 9000, dark: 1800, darken: 0.6 },
  room: { decay: 0.55, length: 0.75, predelay: 0.006, onset: 0.008, bright: 8000, dark: 3200, darken: 0.2 },
}
/** Below this the send is cut: kick and bass stay clean under the wash. */
const SEND_HIGHPASS_HZ = 280
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

const impulses = new WeakMap<BaseAudioContext, Partial<Record<ReverbKind, AudioBuffer>>>()

/** A kind's impulse at the context's rate: decaying, darkening noise, its own in each channel. */
function impulse(ctx: BaseAudioContext, kind: ReverbKind): AudioBuffer {
  const cache = impulses.get(ctx) ?? {}
  impulses.set(ctx, cache)
  if (cache[kind]) return cache[kind]!
  const k = KINDS[kind]
  const sr = ctx.sampleRate
  const n = Math.round(k.length * sr)
  const pre = Math.round(k.predelay * sr)
  const fade = Math.min(END_FADE_S, k.length / 4)
  const buf = ctx.createBuffer(2, n, sr)
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch)
    // Seeded noise: the same space every time, so an export is the same as the last one.
    let seed = (0x9e3779b9 ^ Math.imul(ch + 1, 0x85ebca6b)) >>> 0
    let lp = 0
    for (let i = pre; i < n; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const t = (i - pre) / sr
      const fc = k.dark + (k.bright - k.dark) * Math.exp(-t / k.darken)
      lp += (1 - Math.exp((-2 * Math.PI * fc) / sr)) * ((seed / 2 ** 31) - 1 - lp)
      const env = 10 ** ((-3 * t) / k.decay) * Math.min(1, t / k.onset) * Math.min(1, (n - i) / (fade * sr))
      data[i] = lp * env
    }
  }
  cache[kind] = buf
  return buf
}

/** A reverb of `kind` returning into `dest`. */
export function createReverb(ctx: BaseAudioContext, dest: AudioNode, kind: ReverbKind = 'hall'): Reverb {
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
  conv.buffer = impulse(ctx, kind)
  const output = ctx.createGain()
  output.gain.value = WET_GAIN
  input.connect(hp).connect(conv).connect(output).connect(dest)
  return { input, output }
}

// ---------------------------------------------------------------------------
// The lane delay for delay throws (SCOPE.md §6.9): what is sent to it comes back a set time later
// and again, each repeat quieter and thinner (a high- and a low-pass in the loop), into the lane
// before its volume, sidechain and pan, so the echoes are part of the lane's stem.
//
// send → delay → high-pass → low-pass → lane
//          ↑__________ feedback __________|
// ---------------------------------------------------------------------------

/** The echoes lose their lows and their top each time round. */
const ECHO_HIGHPASS_HZ = 350
const ECHO_LOWPASS_HZ = 3800
/** The longest delay time (seconds: a dotted 8th at 60 BPM is 0.75). */
const ECHO_MAX_S = 2

export interface Echo {
  input: GainNode
  output: GainNode
  delay: DelayNode
  feedback: GainNode
}

/** A delay returning into `dest`. */
export function createEcho(ctx: BaseAudioContext, dest: AudioNode): Echo {
  const input = ctx.createGain()
  const delay = ctx.createDelay(ECHO_MAX_S)
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = ECHO_HIGHPASS_HZ
  hp.Q.value = 0.7
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = ECHO_LOWPASS_HZ
  lp.Q.value = 0.7
  const feedback = ctx.createGain()
  const output = ctx.createGain()
  input.connect(delay).connect(hp).connect(lp).connect(output).connect(dest)
  lp.connect(feedback).connect(delay)
  return { input, output, delay, feedback }
}
