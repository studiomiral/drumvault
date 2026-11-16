import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Preflight } from '../src/arrange/Preflight'
import type { MixProfile, PreflightResult } from '../src/types/engine'

const profile: MixProfile = {
  seconds: 62, bpm: 124, bars: 32, sections_known: true, lufs: -6.5, peak_db: 0, true_peak_db: 1.1, plr_db: 7.6,
  bar_lufs: [...Array(8).fill(-12), ...Array(8).fill(null), ...Array(16).fill(-6)], full_bars: 16, full_lufs: -6,
  regions: [-3, -5.6, -8.8, -12.7, -14.6], width_db: -12.5, low_side_db: -38.9,
  drops: [{ bar: 16, bars: 16, lufs: -6, lift_lu: 3, lift_low_db: 16.5 }], lift_lu: 3, lift_low_db: 16.5, break_depth_lu: null,
  dc_db: -70, head_ms: 0, tail_db: -180, intro: { bars: 16, pulse_db: 17.5, low_rel_db: -5.5 }, outro: null,
}

const result: PreflightResult = {
  subject: 'master', mix: profile, master: profile, warnings: 1, references: { tracks: 5, pending: 2 },
  checks: [
    { id: 'true_peak', label: 'True peak', status: 'warn', value: '1.1 dBTP', detail: 'Between the samples the master peaks over +1 dB.' },
    { id: 'loudness', label: 'Loudness', status: 'ok', value: '−6.5 LUFS', detail: 'kept for the tooltip' },
    { id: 'tone', label: 'Tone against the references', status: 'info', value: 'no references', detail: 'With 3 or more tracks.' },
  ],
}

describe('the pre-flight scorecard', () => {
  it('shows what is wrong with its reason, the rest by its value, and the track bar by bar', () => {
    const html = renderToStaticMarkup(createElement(Preflight, { result }))
    expect(html).toContain('Pre-flight of the master')
    expect(html).toContain('1 to look at')
    expect(html).toContain('Between the samples the master peaks over +1 dB.')
    expect(html).toContain('−6.5 LUFS')
    expect(html).not.toContain('>kept for the tooltip<')   // an ok check keeps its detail for the tooltip
    expect(html).toContain('With 3 or more tracks.')
    expect(html.match(/<rect /g)).toHaveLength(32)        // one bar of the curve per bar of the track
    expect(html.match(/fill-accent/g)).toHaveLength(16)   // the drop lit
    expect(html).toContain('5 reference tracks')
    expect(html).toContain('2 more in the folder not measured yet')
  })

  it('says so when nothing is wrong', () => {
    const html = renderToStaticMarkup(createElement(Preflight, { result: { ...result, warnings: 0, checks: result.checks.slice(1), references: { tracks: 0, pending: 0 } } }))
    expect(html).toContain('nothing to look at')
    expect(html).not.toContain('reference track')
  })
})
