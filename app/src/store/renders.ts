// Cleaning up renders (Settings → Storage): every bass and strings part (and older tracks' keys,
// stab and drone parts) and every FX stretched to a tempo is kept on disk, also for generations
// prepared and never played. What no saved project, shortlisted track or generation of this
// session plays can go; it's rendered again whenever it's needed.

import { api } from '../api'
import { forgetRenders } from '../audio/tempo'
import { soundPath } from '../audio/schedule'
import { parseProject } from '../lib/project'
import type { CleanRendersResult } from '../types/engine'
import type { Project } from '../types/project'
import { useGenerate } from './generate'
import { useProject } from './project'

/** The renders (library-relative) the saved projects, the open one, the shortlist and this session's generations play. */
export async function rendersInUse(): Promise<string[]> {
  const projects: Project[] = [useProject.getState().project]
  for (const p of await api.listProjects()) {
    // A project that doesn't read keeps nothing: the cleanup gives up rather than guess (see below).
    projects.push(parseProject(await api.readProject(p.file)))
  }
  const { history, pending, shortlist } = useGenerate.getState()
  for (const g of [...history, pending, ...shortlist.map((s) => s.g)]) if (g) projects.push(g.project)
  const used = new Set<string>()
  for (const p of projects) {
    for (const c of p.clips) {
      const rel = soundPath(c, p.bpm)
      if (rel.startsWith('.drumvault/')) used.add(rel)
    }
  }
  return [...used]
}

/** What a cleanup would delete (`dryRun`), or delete it. Throws when a project can't be read: nothing is deleted then. */
export async function cleanRenders(dryRun: boolean): Promise<CleanRendersResult> {
  const r = await api.cleanRenders(await rendersInUse(), dryRun)
  if (!dryRun) forgetRenders()
  return r
}
