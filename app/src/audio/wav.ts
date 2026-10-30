// WAV encoding for stem export (SCOPE.md §6.5): 24-bit PCM or 32-bit float, interleaved.

export type WavFormat = 'pcm24' | 'float32'

/** Peak absolute sample value over all channels. */
export function peakOf(channels: Float32Array[]): number {
  let peak = 0
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i])
      if (a > peak) peak = a
    }
  }
  return peak
}

/**
 * Encode `channels` (equal length) as a WAV file. 24-bit samples are clipped to ±1;
 * `gain` (linear) is applied first (auto-gain after the clipping check).
 */
export function encodeWav(channels: Float32Array[], sampleRate: number, format: WavFormat, gain = 1): ArrayBuffer {
  const nch = channels.length
  const frames = channels[0]?.length ?? 0
  const bytesPer = format === 'float32' ? 4 : 3
  const dataBytes = frames * nch * bytesPer
  const isFloat = format === 'float32'
  // Float files carry an 18-byte fmt chunk and a fact chunk (WAVE_FORMAT_IEEE_FLOAT).
  const fmtSize = isFloat ? 18 : 16
  const factBytes = isFloat ? 12 : 0
  const header = 12 + 8 + fmtSize + factBytes + 8
  const buf = new ArrayBuffer(header + dataBytes + (dataBytes % 2))
  const v = new DataView(buf)
  let o = 0
  const str = (s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i))
  }
  const u32 = (x: number) => {
    v.setUint32(o, x, true)
    o += 4
  }
  const u16 = (x: number) => {
    v.setUint16(o, x, true)
    o += 2
  }
  str('RIFF')
  u32(buf.byteLength - 8)
  str('WAVE')
  str('fmt ')
  u32(fmtSize)
  u16(isFloat ? 3 : 1)
  u16(nch)
  u32(sampleRate)
  u32(sampleRate * nch * bytesPer)
  u16(nch * bytesPer)
  u16(bytesPer * 8)
  if (isFloat) {
    u16(0) // cbSize
    str('fact')
    u32(4)
    u32(frames)
  }
  str('data')
  u32(dataBytes)

  if (isFloat) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nch; c++) {
        v.setFloat32(o, channels[c][i] * gain, true)
        o += 4
      }
    }
  } else {
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nch; c++) {
        let s = channels[c][i] * gain
        s = s > 1 ? 1 : s < -1 ? -1 : s
        const n = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff)
        bytes[o] = n & 0xff
        bytes[o + 1] = (n >> 8) & 0xff
        bytes[o + 2] = (n >> 16) & 0xff
        o += 3
      }
    }
  }
  return buf
}
