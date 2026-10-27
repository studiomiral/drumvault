import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { augmentedPath, expandZipPaths, libraryFile, loadSettings, saveSettings } from '../electron/fs'

describe('fs helpers', () => {
  it('finds zips in dropped folders, skipping junk', async () => {
    const d = mkdtempSync(join(tmpdir(), 'dv-fs-'))
    mkdirSync(join(d, 'a', 'b'), { recursive: true })
    mkdirSync(join(d, '__MACOSX'))
    for (const f of ['a/x.zip', 'a/b/y.ZIP', 'a/notes.txt', '__MACOSX/._x.zip', 'a/._z.zip', 'top.zip']) {
      writeFileSync(join(d, f), 'x')
    }
    const zips = await expandZipPaths([join(d, 'a'), join(d, 'top.zip'), join(d, 'a', 'x.zip'), join(d, 'missing')])
    expect(zips).toEqual([join(d, 'a', 'b', 'y.ZIP'), join(d, 'a', 'x.zip'), join(d, 'top.zip')])
  })

  it('keeps sample paths inside the library', () => {
    expect(libraryFile('/lib', 'Loops/Tops/a.wav')).toBe('/lib/Loops/Tops/a.wav')
    expect(() => libraryFile('/lib', '../etc/passwd')).toThrow()
    expect(() => libraryFile('/lib', '/etc/passwd')).toThrow()
    expect(() => libraryFile('/lib', '')).toThrow()
  })

  it('adds Homebrew and uv locations to PATH once', () => {
    const p = augmentedPath('/usr/bin:/opt/homebrew/bin')
    expect(p.split(':').filter((x) => x === '/opt/homebrew/bin')).toHaveLength(1)
    expect(p).toContain('/usr/local/bin')
    expect(p.startsWith('/usr/bin:')).toBe(true)
  })

  it('round-trips settings and survives a corrupt file', async () => {
    const d = mkdtempSync(join(tmpdir(), 'dv-settings-'))
    const f = join(d, 'nested', 'settings.json')
    expect((await loadSettings(f)).libraryPath).toBeNull()
    await saveSettings(f, { libraryPath: '/x', engine: { library_bpm: 126 }, enginePath: null, uvPath: null, lastProject: null })
    expect(await loadSettings(f)).toEqual({ libraryPath: '/x', engine: { library_bpm: 126 }, enginePath: null, uvPath: null, lastProject: null })
    writeFileSync(f, '{nope')
    expect((await loadSettings(f)).libraryPath).toBeNull()
  })
})

describe('findEngineDir', () => {
  it('finds the engine folder next to the app from any depth', async () => {
    const { findEngineDir } = await import('../electron/fs')
    const d = mkdtempSync(join(tmpdir(), 'dv-repo-'))
    mkdirSync(join(d, 'engine'))
    writeFileSync(join(d, 'engine', 'pyproject.toml'), '')
    mkdirSync(join(d, 'app', 'out', 'main'), { recursive: true })
    expect(findEngineDir(join(d, 'app', 'out', 'main'))).toBe(join(d, 'engine'))
    expect(findEngineDir(join(d, 'app'))).toBe(join(d, 'engine'))
    expect(findEngineDir(tmpdir(), 0)).toBeNull()
  })
})
