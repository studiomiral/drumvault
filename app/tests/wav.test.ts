import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, inject, it } from 'vitest'
import { encodeWav, peakOf } from '../src/audio/wav'

function tone(n: number, amp: number): Float32Array[] {
  const l = new Float32Array(n)
  const r = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    l[i] = amp * Math.sin((2 * Math.PI * 440 * i) / 44100)
    r[i] = -l[i] * 0.5
  }
  return [l, r]
}

describe('encodeWav', () => {
  it('writes 24-bit PCM headers and little-endian samples, clipping at full scale', () => {
    const buf = encodeWav([new Float32Array([0, 0.5, -1, 1.5]), new Float32Array([1, -0.25, 0, -2])], 48000, 'pcm24')
    const v = new DataView(buf)
    const s = (o: number, n: number) => String.fromCharCode(...new Uint8Array(buf, o, n))
    expect(s(0, 4) + s(8, 4)).toBe('RIFFWAVE')
    expect(v.getUint16(20, true)).toBe(1)        // PCM
    expect(v.getUint16(22, true)).toBe(2)        // channels
    expect(v.getUint32(24, true)).toBe(48000)
    expect(v.getUint16(34, true)).toBe(24)
    expect(v.getUint32(40, true)).toBe(4 * 2 * 3) // data bytes
    const sample = (i: number) => {
      const o = 44 + i * 3
      const x = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)
      return x
    }
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(sample)).toEqual([0, 0x7fffff, 4194304, -2097152, -8388608, 0, 0x7fffff, -8388608])
  })

  it('writes 32-bit float with a fact chunk and applies gain', () => {
    const buf = encodeWav([new Float32Array([0.5, 2])], 44100, 'float32', 0.5)
    const v = new DataView(buf)
    expect(v.getUint16(20, true)).toBe(3)        // IEEE float
    expect(String.fromCharCode(...new Uint8Array(buf, 38, 4))).toBe('fact')
    expect(v.getFloat32(58, true)).toBe(0.25)
    expect(v.getFloat32(62, true)).toBe(1)
  })

  it('reports the peak', () => {
    expect(peakOf([new Float32Array([0.1, -0.7]), new Float32Array([0.3])])).toBeCloseTo(0.7)
  })

  it.skipIf(!inject('uv'))('produces files libsndfile reads back exactly', () => {
    const d = mkdtempSync(join(tmpdir(), 'dv-wav-'))
    const ch = tone(44100, 0.8)
    writeFileSync(join(d, 'f.wav'), Buffer.from(encodeWav(ch, 44100, 'float32')))
    writeFileSync(join(d, 'i.wav'), Buffer.from(encodeWav(ch, 44100, 'pcm24')))
    const py = `
import soundfile as sf, numpy as np, sys
f, sr1 = sf.read(sys.argv[1] + '/f.wav', dtype='float32'); i, sr2 = sf.read(sys.argv[1] + '/i.wav', dtype='float64')
info = sf.info(sys.argv[1] + '/i.wav')
print(sr1, sr2, f.shape[0], f.shape[1], info.subtype, sf.info(sys.argv[1] + '/f.wav').subtype)
print(float(np.max(np.abs(i - f))), float(f[1000, 0]), float(f[1000, 1]))`
    const out = execFileSync(inject('uv')!, ['run', '--project', inject('engineDir'), 'python', '-c', py, d],
      { cwd: inject('engineDir'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')
    expect(out[0]).toBe('44100 44100 44100 2 PCM_24 FLOAT')
    const [diff, l, r] = out[1].split(' ').map(Number)
    expect(diff).toBeLessThan(2 / 8388608)        // 24-bit quantisation only
    expect(l).toBeCloseTo(ch[0][1000], 6)
    expect(r).toBeCloseTo(ch[1][1000], 6)
  })
})
