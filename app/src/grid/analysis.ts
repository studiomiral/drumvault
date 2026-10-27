// Grid view maths (SCOPE.md §6.2a): beat positions for a bar-1 offset, waveform peaks, and
// "every beat stacked" (the drum hits folded onto one beat) for lining the grid up by eye.
// Times are in seconds of the stems' own timeline; bar 1 starts at `bar1`.

export interface Beat {
  time: number
  /** Beats from the downbeat of bar 1 (negative before it); index % 4 === 0 is a downbeat. */
  index: number
}

/** The grid's beats with from <= time < to. */
export function beatsIn(from: number, to: number, bar1: number, beat: number): Beat[] {
  const out: Beat[] = []
  for (let k = Math.ceil((from - bar1) / beat - 1e-9); bar1 + k * beat < to; k++) out.push({ time: bar1 + k * beat, index: k })
  return out
}

export const isDownbeat = (index: number) => ((index % 4) + 4) % 4 === 0

/** Max |x| per block of `block` samples (waveform drawing when zoomed out). */
export function blockPeaks(data: Float32Array, block: number): Float32Array {
  const out = new Float32Array(Math.ceil(data.length / block))
  for (let b = 0; b < out.length; b++) {
    let m = 0
    for (let i = b * block, e = Math.min(data.length, i + block); i < e; i++) {
      const v = Math.abs(data[i])
      if (v > m) m = v
    }
    out[b] = m
  }
  return out
}

/**
 * Every beat stacked: the mean envelope (max |x| per bin) of the audio from `window` seconds
 * before to `window` seconds after each grid beat, in `bins` bins. Hits that sit on the grid
 * pile up at the centre; late hits pile up right of it.
 */
export function foldBeats(data: Float32Array, sr: number, bar1: number, beat: number,
                          window: number, bins: number): Float32Array {
  const out = new Float32Array(bins)
  const binLen = (2 * window * sr) / bins
  let count = 0
  for (const b of beatsIn(window, data.length / sr - window, bar1, beat)) {
    const start = (b.time - window) * sr
    for (let j = 0; j < bins; j++) {
      let m = 0
      for (let i = Math.floor(start + j * binLen), e = Math.floor(start + (j + 1) * binLen); i < e; i++) {
        const v = Math.abs(data[i])
        if (v > m) m = v
      }
      out[j] += m
    }
    count++
  }
  if (count) for (let j = 0; j < bins; j++) out[j] /= count
  return out
}

/**
 * Seconds from the grid line to the stacked hits' attack: where the fold first rises to `rel`
 * of the way from its floor to its peak, walking back from the peak. Null without a clear hit.
 */
export function foldAttack(fold: Float32Array, window: number, rel = 0.3): number | null {
  let peak = 0
  let floor = Infinity
  for (let j = 0; j < fold.length; j++) {
    if (fold[j] > fold[peak]) peak = j
    floor = Math.min(floor, fold[j])
  }
  if (!(fold[peak] > 0) || fold[peak] - floor < fold[peak] * 0.2) return null
  const level = floor + rel * (fold[peak] - floor)
  let j = peak
  while (j > 0 && fold[j - 1] >= level) j--
  const binLen = (2 * window) / fold.length
  return -window + j * binLen
}

/** Bar 1 rounded to 0.1 ms (the precision the engine is given). */
export const roundMs = (sec: number) => Math.round(sec * 10000) / 10000
