import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window = { drumvault: {} }
})

import { fillScript, hotKey, isHotUrl } from '../electron/houseoftracks'
import { checkFolder, deleteZipped, listExports, readUploads, uploadsFile, writeUpload, zipPart } from '../electron/upload'
import { parseInfoText } from '../src/arrange/exporter'
import { hotFields, lyricsOf, PRICES, uploadProblems, vocalKind, vocalPacks } from '../src/upload/fields'
import type { UploadCheck } from '../src/types/api'

const INFO = (title: string, length = '5:27 (176 bars)', vocals = 'Vocals: none') =>
  `Title: ${title}\nBPM: 129\nKey: F# minor\nLength: ${length}\n\nAbout the track\nDeep, warm house.\nTags: Melodic, Club, Soulful\n\n${vocals}\n`

/** An export folder as the app writes it (`master`: the master's name, `sings`: with instrumentals). */
function project(root: string, name: string, o: { master?: string; sings?: boolean; midi?: boolean; info?: string } = {}): string {
  const p = join(root, name)
  for (const d of ['masters', 'stems', 'midi']) mkdirSync(join(p, d), { recursive: true })
  writeFileSync(join(p, 'info.txt'), o.info ?? INFO(name))
  writeFileSync(join(p, 'masters', o.master ?? 'mastered.wav'), 'm')
  writeFileSync(join(p, 'masters', 'mixdown.wav'), 'x')
  if (o.sings) {
    writeFileSync(join(p, 'masters', 'Bring It mastered instrumental.wav'), 'i')
    writeFileSync(join(p, 'masters', 'mixdown instrumental.wav'), 'i')
  }
  writeFileSync(join(p, 'stems', 'Kick.wav'), 'k'.repeat(5000))
  writeFileSync(join(p, 'stems', 'Clap 2.wav'), 'c'.repeat(3000))
  if (o.midi !== false) writeFileSync(join(p, 'midi', 'Bass.mid'), 'MThd')
  return p
}

describe('upload: export folders', () => {
  it('lists folders with info.txt, newest export first', async () => {
    const d = mkdtempSync(join(tmpdir(), 'dv-up-'))
    const a = project(d, 'Old - 124 BPM')
    const b = project(d, 'New - 126 BPM')
    mkdirSync(join(d, 'Not an export'))
    utimesSync(join(a, 'info.txt'), 1000, 1000)
    const list = await listExports(d)
    expect(list.map((f) => f.name)).toEqual(['New - 126 BPM', 'Old - 124 BPM'])
    expect(list[0].path).toBe(b)
    expect(parseInfoText(list[0].info).title).toBe('New - 126 BPM')
    expect(await listExports(join(d, 'missing'))).toEqual([])
  })

  it('finds the masters, renamed ones too, and counts stems and MIDI', async () => {
    const d = mkdtempSync(join(tmpdir(), 'dv-up-'))
    const c = await checkFolder(project(d, 'Bring It', { master: 'Bring It mastered.wav', sings: true }))
    expect(c.master?.endsWith('masters/Bring It mastered.wav')).toBe(true)
    expect(c.masterInstrumental?.endsWith('masters/Bring It mastered instrumental.wav')).toBe(true)
    expect(c.mixdown?.endsWith('masters/mixdown.wav')).toBe(true)
    expect(c.mixdownInstrumental?.endsWith('masters/mixdown instrumental.wav')).toBe(true)
    expect([c.stems, c.stemsZipOnly, c.midi, c.info]).toEqual([2, false, 1, true])
    expect(c.zips).toEqual({ stems: null, midi: null })

    const plain = await checkFolder(project(d, 'Plain'))
    expect(plain.master?.endsWith('masters/mastered.wav')).toBe(true)
    expect(plain.masterInstrumental).toBeNull()
  })

  it('names what is missing and blocks on it', async () => {
    const d = mkdtempSync(join(tmpdir(), 'dv-up-'))
    const p = project(d, 'Thin', { master: 'premaster.wav', midi: false, info: INFO('Thin', '2:10 (64 bars)', 'Vocals\n- x.wav\n  Splice pack: P (L)\n  https://splice.com/x') })
    const info = parseInfoText(readFileSync(join(p, 'info.txt'), 'utf8'))
    const pr = uploadProblems(await checkFolder(p), info)
    expect(pr.blocking).toEqual([
      'No master: masters/mastered.wav (or "… mastered.wav")',
      'midi/ has no MIDI files',
      'It sings, but there is no instrumental master: masters/"… mastered instrumental.wav"',
      'It sings, but there is no instrumental mixdown: masters/mixdown instrumental.wav',
      '2:10 long: House of Tracks takes 2:30 to 8:00',
    ])
    expect(pr.track).toEqual(['2:10 long: House of Tracks takes 2:30 to 8:00'])
    const ok = project(d, 'Fine')
    expect(uploadProblems(await checkFolder(ok), parseInfoText(INFO('Fine')))).toEqual({ blocking: [], track: [], warnings: [] })
  })
})

describe.skipIf(!existsSync('/usr/bin/ditto'))('upload: zips', () => {
  it('zips stems/ with the folder at the top, reports progress, and knows when the zip is stale', async () => {
    const d = mkdtempSync(join(tmpdir(), 'dv-up-'))
    const p = project(d, 'Zip Me')
    const seen: number[] = []
    const job = zipPart(p, 'stems', (done, total) => {
      expect(total).toBe(8000)
      seen.push(done)
    })
    const z = await job.done
    expect(z.path).toBe(join(p, 'stems.zip'))
    expect(z.size).toBeGreaterThan(0)
    expect(seen[0]).toBe(0)
    expect(seen.at(-1)).toBe(8000)
    expect(existsSync(join(p, '.stems.zip.part'))).toBe(false)
    const listing = execFileSync('/usr/bin/unzip', ['-Z1', z.path]).toString().split('\n').filter((l) => l && !l.startsWith('__MACOSX'))
    expect(listing.sort()).toEqual(['stems/', 'stems/Clap 2.wav', 'stems/Kick.wav'])

    let c = await checkFolder(p)
    expect(c.zips.stems?.fresh).toBe(true)
    expect(c.zips.midi).toBeNull()
    const later = Date.now() / 1000 + 60
    utimesSync(join(p, 'stems', 'Kick.wav'), later, later)
    c = await checkFolder(p)
    expect(c.zips.stems?.fresh).toBe(false)
  })

  it('deletes the stems once they are in the zip; the zip then stands for them', async () => {
    const d = mkdtempSync(join(tmpdir(), 'dv-up-'))
    const p = project(d, 'Space')
    await zipPart(p, 'stems', () => {}).done
    // A file the zip doesn't hold, or holds at another size, stays.
    writeFileSync(join(p, 'stems', 'Hats.wav'), 'h')
    expect(await deleteZipped(p, 'stems')).toBe(2)
    expect(existsSync(join(p, 'stems', 'Kick.wav'))).toBe(false)
    expect(existsSync(join(p, 'stems', 'Hats.wav'))).toBe(true)
    unlinkSync(join(p, 'stems', 'Hats.wav'))
    expect(await deleteZipped(p, 'stems')).toBe(0)
    expect(existsSync(join(p, 'stems'))).toBe(false)

    const c = await checkFolder(p)
    expect([c.stems, c.stemsZipOnly, c.zips.stems?.fresh]).toEqual([2, true, true])
    expect(uploadProblems(c, parseInfoText(INFO('Space'))).blocking).toEqual([])
    // stems/ there but empty (a file Finder left in it): still the zip's.
    mkdirSync(join(p, 'stems'))
    writeFileSync(join(p, 'stems', '.DS_Store'), 'x')
    const again = await checkFolder(p)
    expect([again.stems, again.stemsZipOnly, again.zips.stems?.fresh]).toEqual([2, true, true])
    // A broken zip: nothing deleted.
    const q = project(d, 'Broken')
    writeFileSync(join(q, 'stems.zip'), 'not a zip')
    await expect(deleteZipped(q, 'stems')).rejects.toThrow()
    expect(existsSync(join(q, 'stems', 'Kick.wav'))).toBe(true)
  })

  it('refuses an empty folder and a bad request, leaving no part file', async () => {
    const d = mkdtempSync(join(tmpdir(), 'dv-up-'))
    const p = project(d, 'Empty', { midi: false })
    await expect(zipPart(p, 'midi', () => {}).done).rejects.toThrow(/empty/)
    expect(existsSync(join(p, '.midi.zip.part'))).toBe(false)
    expect(() => zipPart('relative/path', 'stems', () => {})).toThrow(/Bad zip request/)
  })
})

describe('upload: records', () => {
  it('remembers price and status per track, merging changes', async () => {
    const lib = mkdtempSync(join(tmpdir(), 'dv-lib-'))
    expect(await readUploads(lib)).toEqual({})
    await Promise.all([
      writeUpload(lib, 'Bring It - 129 BPM - F# minor', { price: 349 }),
      writeUpload(lib, 'Bring It - 129 BPM - F# minor', { status: 'filled', filledAt: '2026-11-18T12:00:00.000Z' }),
      writeUpload(lib, 'Other', { genre: 'Tech House' }),
    ])
    const r = await readUploads(lib)
    expect(r['Bring It - 129 BPM - F# minor']).toEqual({ status: 'filled', price: 349, filledAt: '2026-11-18T12:00:00.000Z' })
    expect(r.Other).toEqual({ status: 'none', genre: 'Tech House' })
    expect(JSON.parse(readFileSync(uploadsFile(lib), 'utf8')).version).toBe(1)
    expect(() => writeUpload(lib, '../escape', {})).toThrow(/Bad track name/)
  })
})

describe('upload: the House of Tracks form', () => {
  it("maps keys to the form's names", () => {
    expect(hotKey('F# minor')).toBe('F♯/G♭ Minor')
    expect(hotKey('Bb major')).toBe('A♯/B♭ Major')
    expect(hotKey('Eb minor')).toBe('D♯/E♭ Minor')
    expect(hotKey('A minor')).toBe('A Minor')
    expect(hotKey('none')).toBeNull()
  })

  it('loads nothing but houseoftracks.com', () => {
    expect(isHotUrl('https://houseoftracks.com/uploadtracks')).toBe(true)
    expect(isHotUrl('https://hot-edge.houseoftracks.com/x.png')).toBe(true)
    expect(isHotUrl('http://houseoftracks.com/')).toBe(false)
    expect(isHotUrl('https://houseoftracks.com.evil.io/')).toBe(false)
    expect(isHotUrl('https://evilhouseoftracks.com/')).toBe(false)
    expect(isHotUrl('not a url')).toBe(false)
  })

  const ALL_THERE: UploadCheck = {
    master: 'x', masterInstrumental: null, mixdown: 'x', mixdownInstrumental: null, stems: 1, stemsZipOnly: false, midi: 1, info: true, zips: { stems: null, midi: null },
  }

  it('fills from info.txt and the choices, with the vocal kind from the credits', () => {
    const none = parseInfoText(INFO('Bring It - 129 BPM - F# minor'))
    expect(hotFields(none, undefined)).toEqual({
      trackName: 'Bring It', bpm: '129', key: 'F# minor', genre: 'House', description: 'Deep, warm house.',
      tags: ['Melodic', 'Club', 'Soulful'], price: 299, instrument: 'Drums & Percussion', vocal: 'None', vocalCategory: 'Instrumental', lyrics: '',
      vocalPack: '', vocalPackUrl: '',
    })
    const splice = parseInfoText(INFO('X', undefined, 'Vocals\n- a.wav\n  Splice pack: P (L)\n  https://splice.com/a'))
    expect(vocalKind(splice)).toBe('Royalty Free')
    expect(hotFields(splice, { status: 'none', price: 449, vocalCategory: 'Male' })).toMatchObject({
      price: 449, vocal: 'Royalty Free', vocalCategory: 'Male', vocalPack: 'P (L)', vocalPackUrl: 'https://splice.com/a',
    })
    const two = parseInfoText(INFO('X', undefined, 'Vocals\n- a.wav\n  Splice pack: P (L)\n  https://splice.com/a\n- b.wav\n  Splice pack: P (L)\n  https://splice.com/a\n- c.wav\n  Splice pack: Q\n  https://splice.com/q'))
    expect(vocalPacks(two)).toEqual({ names: ['P (L)', 'Q'], urls: ['https://splice.com/a', 'https://splice.com/q'] })
    expect(hotFields(two, undefined)).toMatchObject({ vocalPack: 'P (L), Q', vocalPackUrl: 'https://splice.com/a' })
    expect(uploadProblems({ ...ALL_THERE, masterInstrumental: 'x', mixdownInstrumental: 'x' }, two).warnings)
      .toEqual(['It sings loops from 2 packs; the form takes one link: https://splice.com/a'])
    const unknown = parseInfoText(INFO('X', undefined, 'Vocals\n- a.wav\n  Splice pack: unknown\n  Link: unknown'))
    expect(hotFields(unknown, undefined)).toMatchObject({ vocal: 'Royalty Free', vocalPack: '', vocalPackUrl: '' })
    expect(uploadProblems({ ...ALL_THERE, masterInstrumental: 'x', mixdownInstrumental: 'x' }, unknown).warnings).toEqual([
      'The vocal\'s sample pack is unknown: type it in the form', 'The vocal\'s sample pack has no link: paste it in the form',
    ])
    const made = parseInfoText(INFO('X', undefined, 'Vocals\n- “Bring it back / One more time”\n  AI-generated with ElevenLabs (female, soulful); lyrics written for this app'))
    expect(vocalKind(made)).toBe('AI Generated')
    expect(lyricsOf(made)).toBe('Bring it back\nOne more time')
    expect(hotFields(made, undefined)).toMatchObject({ vocalCategory: 'Female', vocalPack: '', vocalPackUrl: '' })
    expect(PRICES).toEqual([299, 349, 399, 449, 499])
  })

  it('builds a page script with the values in it', () => {
    const s = fillScript(hotFields(parseInfoText(INFO('Bring It - 129 BPM - F# minor')), undefined), false)
    expect(s).toContain('"hotKey":"F♯/G♭ Minor"')
    expect(s).toContain('"#trackname"')
    expect(() => new Function(`return ${s}`)).not.toThrow()  // valid JavaScript
  })
})
