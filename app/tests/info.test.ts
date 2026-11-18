import { describe, expect, it, vi } from 'vitest'

// The exporter talks to the app through `window.drumvault`; info.txt needs none of it.
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window = { drumvault: {} }
})

import { formatInfo, infoText, lengthSeconds, parseInfoText, trackInfo, trackNameOf } from '../src/arrange/exporter'
import { HOT_TAGS } from '../src/arrange/describe'
import { newProject } from '../src/lib/project'
import type { AudioClip, Project } from '../src/types/project'
import type { VocalMeta } from '../src/vocals/plan'

function track(vocals: boolean): Project {
  const p = newProject('Bring It', 129)
  const lane = (name: string) => ({ ...p.lanes[0], id: name.toLowerCase().replace(/\s/g, '-'), name, mute: false })
  p.lanes = [lane('Kick'), lane('Bass'), lane('Stab'), lane('Stab 2'), lane('Strings'), ...(vocals ? [lane('Vocal')] : [])]
  const clip = (laneId: string, relPath: string, bass?: AudioClip['bass']): AudioClip => ({
    id: `${laneId}-1`, type: 'audio', laneId, start: 0, length: 16, gainDb: 0, trimBeats: 0,
    sample: { relPath, id: -1, name: 'x', kind: 'loop', category: 'melodic', bars: 1, durationS: 2, bpm: 129 }, bass,
  })
  const part = (role: 'bass' | 'stab') => ({ role, preset: '/p.SerumPreset', presetName: 'p', midiId: 1, midiName: 'm', transpose: 0 })
  p.clips = [clip('kick', 'a/kick.wav'), clip('bass', '.drumvault/bass/x.wav', part('bass')), clip('stab', '.drumvault/stab/x.wav', part('stab')),
    clip('stab-2', '.drumvault/stab/y.wav', part('stab')), clip('strings', 'Strings/s.wav'),
    ...(vocals ? [clip('vocal', 'Vocals/take-1/phrase.wav'), { ...clip('vocal', 'Vocals/take-2/phrase.wav'), id: 'vocal-2' }] : [])]
  p.generation = { key: 'F#m', rules: { character: 'deep', lead: 'stabs' } } as unknown as Project['generation']
  return p
}

const takes = [
  { id: 'take-1', source: 'splice', lines: [], usedIn: [], splice: { file: 'osh_125_vocal_loop_Gmin.wav', pack: 'Old Skool House', label: 'Sample Magic', url: 'https://splice.com/sounds/packs/sample-magic/old-skool-house/samples' } },
  { id: 'take-2', source: 'elevenlabs', lines: ['Bring it back', 'One more time'], voice: 'female', mood: 'soulful', usedIn: [] },
] as unknown as VocalMeta[]

const range = { startBeat: 0, endBeat: 176 * 4 }

describe('info.txt', () => {
  it('reads back what the export wrote', () => {
    for (const vocals of [false, true]) {
      const p = track(vocals)
      const o = { folder: 'Bring It - 129 BPM - F# minor', range }
      const info = trackInfo(p, o, takes)
      expect(parseInfoText(infoText(p, o, takes))).toEqual(info)
      // and what was read writes the same file again
      expect(formatInfo(parseInfoText(infoText(p, o, takes)))).toBe(infoText(p, o, takes))
      expect(info).toMatchObject({ title: o.folder, bpm: '129', key: 'F# minor', length: '5:27 (176 bars)' })
      expect(info.tags).toHaveLength(3)
      for (const t of info.tags) expect(HOT_TAGS).toContain(t)
      expect(info.description).not.toMatch(/Tags:/)
      expect(info.description.split('\n').length).toBeGreaterThan(1)
      if (vocals) {
        expect(info.vocals.split('\n')).toEqual([
          '- osh_125_vocal_loop_Gmin.wav', '  Splice pack: Old Skool House (Sample Magic)', '  https://splice.com/sounds/packs/sample-magic/old-skool-house/samples',
          '- “Bring it back / One more time”', '  AI-generated with ElevenLabs (female, soulful); lyrics written for this app'])
      } else {
        expect(info.vocals).toBe('')
        expect(infoText(p, o, takes)).toMatch(/\nVocals: none\n$/)
      }
    }
  })

  it('parses a real export, and is lenient with a short one', () => {
    const real = `Title: Bring It - 129 BPM - F# minor
BPM: 129
Key: F# minor
Length: 5:27 (176 bars)

About the track
Deep, warm house at 129 BPM in F# minor, built around the stabs: a sampled bassline and a vocal hook.
Arrangement: 176 bars; a 32-bar intro and a 16-bar outro to mix in and out of, three drops and two breakdowns (the longest 16 bars).
Would sit well on labels like Defected, Freerange and Classic Music Company.
Tags: Melodic, Club, Soulful

Vocals
- osh_125_vocal_loop_tape_dontlet_Gmin.wav
  Splice pack: Old Skool House (Sample Magic)
  https://splice.com/sounds/packs/sample-magic/old-skool-house/samples
`
    const i = parseInfoText(real)
    expect(i.tags).toEqual(['Melodic', 'Club', 'Soulful'])
    expect(i.description.split('\n')).toHaveLength(3)
    expect(i.description.startsWith('Deep, warm house')).toBe(true)
    expect(i.vocals.split('\n')).toHaveLength(3)
    expect(trackNameOf(i.title)).toBe('Bring It')
    expect(lengthSeconds(i.length)).toBe(327)

    const short = parseInfoText('Title: Old - 124 BPM\r\nBPM: 124\r\nKey: none\r\nLength: 4:10 (128 bars)\r\n')
    expect(short).toEqual({ title: 'Old - 124 BPM', bpm: '124', key: 'none', length: '4:10 (128 bars)', description: '', tags: [], vocals: '' })
    expect(trackNameOf(short.title)).toBe('Old')
    expect(trackNameOf('Generated 08 - 122.50 BPM - Bb major')).toBe('Generated 08')
    expect(trackNameOf('Just a name')).toBe('Just a name')
  })
})
