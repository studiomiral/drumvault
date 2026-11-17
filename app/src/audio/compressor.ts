// A lane's compressor (SCOPE.md §6.6): feed-forward, the two sides linked (one gain for both, so
// the stereo image stays), an RMS detector over a few ms, a soft knee, and no look-ahead, so a
// compressed lane stays sample-exact against the rest (Web Audio's own DynamicsCompressorNode
// delays its output by 256 frames and adds a makeup gain of its own). Plain code, run by the lane's AudioWorklet (compressor.worklet.ts)
// in playback and export alike, and by the tests.
//
// The gain computer and the smoothing are the usual log-domain design (Giannoulis, Massberg &
// Reiss, "Digital Dynamic Range Compressor Design", JAES 2012): the gain reduction is worked out
// from the level (the power of both sides over `DETECT_MS`: a hit's body, not the single sample at
// its crack), then smoothed in dB, falling at the attack's pace and recovering at the release's.

export interface CompParams {
  /** Where it starts working (dBFS at its input). */
  thresholdDb: number
  /** How much over the threshold it lets through: 4 lets 1 dB through for every 4 over. */
  ratio: number
  /** The knee's width (dB): it eases in from `kneeDb / 2` under the threshold. */
  kneeDb: number
  attackMs: number
  releaseMs: number
  /** Gain after it (dB). */
  makeupDb: number
  /** The level detector's time (ms): an RMS over about this long; `DETECT_MS` when unset. */
  detectMs?: number
}

/** The worklet's name, and its parameters (AudioParams, k-rate) with their defaults: a ratio of 1 does nothing. */
export const COMP_NODE = 'lane-comp'
/** The drum bus's detector (same parameters): the drums' sum in, the gain (linear) out, for each drum lane to apply. */
export const BUS_NODE = 'bus-detect'
export const COMP_DEFAULTS = { threshold: 0, ratio: 1, knee: 6, attack: 10, release: 100, makeup: 0, detect: 5 }

/** Under this a sample counts as silence (dBFS). */
const FLOOR_DB = -120
/** The level detector's time constant unless set (ms): an RMS over about this long. */
export const DETECT_MS = 5

/** The gain (dB, ≤ 0) the compressor wants for a sample at `xDb`. */
export function gainComputer(xDb: number, thresholdDb: number, ratio: number, kneeDb: number): number {
  const over = xDb - thresholdDb
  const slope = 1 / Math.max(1, ratio) - 1
  if (kneeDb > 0 && 2 * Math.abs(over) <= kneeDb) return (slope * (over + kneeDb / 2) ** 2) / (2 * kneeDb)
  return over > 0 ? slope * over : 0
}

/** A smoothing coefficient: the share of the last value kept each sample for a time constant of `ms`. */
const coeff = (ms: number, sr: number) => (ms > 0 ? Math.exp(-1 / ((ms / 1000) * sr)) : 0)

/** One compressor's memory: the gain reduction it is at (dB, ≤ 0). */
export class Compressor {
  /** The gain reduction now (dB, ≤ 0). */
  gr = 0
  /** The level now (the two sides' mean power). */
  private power = 0
  private key = ''
  private att = 0
  private rel = 0
  private det = 0

  private buf = new Float32Array(128)

  /**
   * The gain (linear, its makeup in) for each of `n` samples of `inputs` (one array per channel:
   * one or two; none: silence) into `gain`: what the bus's detector puts out, and what `process`
   * applies.
   */
  gains(inputs: Float32Array[], gain: Float32Array, n: number, p: CompParams, sampleRate: number): void {
    const detect = p.detectMs ?? DETECT_MS
    const key = `${p.attackMs},${p.releaseMs},${detect},${sampleRate}`
    if (key !== this.key) {
      this.att = coeff(p.attackMs, sampleRate)
      this.rel = coeff(p.releaseMs, sampleRate)
      this.det = coeff(detect, sampleRate)
      this.key = key
    }
    const l = inputs[0]
    const r = inputs[1] ?? inputs[0]
    const makeup = p.makeupDb
    let gr = this.gr
    let power = this.power
    const det = this.det
    for (let i = 0; i < n; i++) {
      // (No sound in: it recovers as in silence.)
      power = det * power + (l ? (1 - det) * 0.5 * (l[i] * l[i] + r[i] * r[i]) : 0)
      const xDb = power > 1e-12 ? 10 * Math.log10(power) : FLOOR_DB
      const want = gainComputer(xDb, p.thresholdDb, p.ratio, p.kneeDb)
      const a = want < gr ? this.att : this.rel
      gr = a * gr + (1 - a) * want
      gain[i] = 10 ** ((gr + makeup) / 20)
    }
    this.gr = gr
    this.power = power
  }

  /**
   * Compress `inputs` (one array per channel: one or two) into `outputs` (as many arrays, of the
   * same length; they may be the inputs). A mono input fills every output with the same sound.
   */
  process(inputs: Float32Array[], outputs: Float32Array[], p: CompParams, sampleRate: number): void {
    const n = outputs[0]?.length ?? 0
    if (this.buf.length < n) this.buf = new Float32Array(n)
    const g = this.buf
    this.gains(inputs, g, n, p, sampleRate)
    for (let c = 0; c < outputs.length; c++) {
      const x = inputs[c] ?? inputs[0]
      const o = outputs[c]
      if (!x) o.fill(0)
      else for (let i = 0; i < n; i++) o[i] = x[i] * g[i]
    }
  }
}
