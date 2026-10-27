import { describe, expect, inject, it } from 'vitest'
import { checkDeps } from '../electron/deps'
import { which } from '../electron/fs'

describe('checkDeps', () => {
  it('reports uv, Rubber Band (with R3) and the engine folder', async () => {
    const r = await checkDeps(inject('engineDir'), null)
    const by = Object.fromEntries(r.checks.map((c) => [c.name, c]))
    expect(by.Engine.ok).toBe(true)
    expect(by.uv.ok).toBe(!!which('uv'))
    if (which('rubberband')) {
      expect(by['Rubber Band'].ok).toBe(true)
      expect(by['Rubber Band'].detail).toContain('(R3 engine)')  // 3.x has --fine
    }
  })

  it('explains how to fix a missing engine folder', async () => {
    const r = await checkDeps('/nonexistent/engine', '/nonexistent/uv')
    expect(r.ok).toBe(false)
    expect(r.checks.find((c) => c.name === 'Engine')?.fix).toBeTruthy()
  })
})
