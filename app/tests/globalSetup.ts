// Builds a small real library once per test run with the Python engine (two fixture zips),
// so the database reader and the sidecar are tested against the real thing.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TestProject } from 'vitest/node'
import { which } from '../electron/fs'

export const ENGINE_DIR = resolve(__dirname, '..', '..', 'engine')

declare module 'vitest' {
  export interface ProvidedContext {
    engineDir: string
    uv: string | null
    fixturesDir: string | null
    libraryDir: string | null
  }
}

export default function setup(project: TestProject) {
  const uv = which('uv')
  project.provide('engineDir', ENGINE_DIR)
  project.provide('uv', uv)
  // DRUMVAULT_SKIP_ENGINE=1 skips the engine-backed tests for quick runs.
  if (!uv || !existsSync(join(ENGINE_DIR, 'pyproject.toml')) || process.env.DRUMVAULT_SKIP_ENGINE) {
    project.provide('fixturesDir', null)
    project.provide('libraryDir', null)
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'drumvault-app-test-'))
  const fixtures = join(root, 'fixtures')
  const library = join(root, 'library')
  const run = (args: string[]) => execFileSync(uv, ['run', '--project', ENGINE_DIR, ...args],
    { cwd: ENGINE_DIR, stdio: ['ignore', 'ignore', 'inherit'] })
  run(['python', '-c', 'import sys; sys.path.insert(0, "tests"); import make_fixtures; '
    + 'make_fixtures.build_all(sys.argv[1], only=["deep_groove", "sunrise"])', fixtures])
  run(['python', '-m', 'drumvault_engine', 'cli', 'process', fixtures, '--library', library])
  project.provide('fixturesDir', fixtures)
  project.provide('libraryDir', library)
  return () => rmSync(root, { recursive: true, force: true })
}
