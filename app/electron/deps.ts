// Startup dependency checks: uv, Rubber Band and the engine folder (SCOPE.md §3).

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DepCheck, DepsReport } from '../src/types/api'
import { augmentedPath, which } from './fs'

const run = promisify(execFile)

async function version(bin: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await run(bin, args, { timeout: 10_000, env: { ...process.env, PATH: augmentedPath() } })
  return (stdout || stderr).trim().split('\n')[0]
}

export async function checkDeps(engineDir: string, uvPath: string | null): Promise<DepsReport> {
  const checks: DepCheck[] = []

  const uv = uvPath || which('uv')
  if (!uv) {
    checks.push({ name: 'uv', ok: false, detail: 'Not found', fix: 'brew install uv' })
  } else {
    try {
      checks.push({ name: 'uv', ok: true, detail: `${await version(uv, ['--version'])} (${uv})` })
    } catch (e) {
      checks.push({ name: 'uv', ok: false, detail: `${uv}: ${(e as Error).message}`, fix: 'brew install uv' })
    }
  }

  const rb = which('rubberband')
  if (!rb) {
    checks.push({ name: 'Rubber Band', ok: false, detail: 'Not found', fix: 'brew install rubberband' })
  } else {
    try {
      const v = await version(rb, ['--version'])
      // `rubberband --help` exits non-zero: keep its output either way.
      const help = await run(rb, ['--help'], { timeout: 10_000 }).then(
        (r) => r.stdout + r.stderr,
        (e: { stdout?: string; stderr?: string }) => (e.stdout ?? '') + (e.stderr ?? ''))
      const r3 = /--fine\b/.test(help)
      checks.push({ name: 'Rubber Band', ok: true, detail: `${v}${r3 ? ' (R3 engine)' : ' (no R3 engine: default engine is used)'}` })
    } catch (e) {
      checks.push({ name: 'Rubber Band', ok: false, detail: (e as Error).message, fix: 'brew install rubberband' })
    }
  }

  const ok = existsSync(join(engineDir, 'pyproject.toml'))
  checks.push({
    name: 'Engine', ok,
    detail: ok ? engineDir : `No engine at ${engineDir}`,
    fix: ok ? undefined : 'Set the engine folder in Settings (the "engine" folder of the Drumvault repo)',
  })

  return { ok: checks.every((c) => c.ok), checks }
}
