// Arrange project state with command history (SCOPE.md §6.4: ⌘Z / ⇧⌘Z, ≥ 100 steps).
// Every edit goes through `edit()`, which records immer patches and their inverses; undo
// and redo replay them. Consecutive edits with the same `coalesce` key (fader drags,
// renames as you type) merge into one step.

import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from 'immer'
import { create } from 'zustand'
import { newProject } from '../lib/project'
import type { Project } from '../types/project'

enablePatches()

const HISTORY_LIMIT = 200
const COALESCE_MS = 1500

interface Command {
  label: string
  patches: Patch[]
  inverse: Patch[]
  coalesce?: string
  at: number
}

export interface ProjectState {
  project: Project
  /** File name in the projects folder; null until first saved. */
  file: string | null
  dirty: boolean
  past: Command[]
  future: Command[]
  selection: string[]          // clip ids
  selectedMarker: string | null
  editingClip: string | null   // pattern clip open in the step editor

  edit(label: string, recipe: (draft: Draft<Project>) => void, opts?: { coalesce?: string }): void
  undo(): void
  redo(): void
  load(project: Project, file: string | null): void
  markSaved(file: string): void
  select(ids: string[]): void
  selectMarker(id: string | null): void
  openEditor(id: string | null): void
}

export const useProject = create<ProjectState>((set, get) => ({
  project: newProject('Untitled', 124),
  file: null,
  dirty: false,
  past: [],
  future: [],
  selection: [],
  selectedMarker: null,
  editingClip: null,

  edit(label, recipe, opts = {}) {
    const { project, past } = get()
    const [next, patches, inverse] = produceWithPatches(project, recipe)
    if (!patches.length) return
    const now = Date.now()
    const last = past[past.length - 1]
    let history: Command[]
    if (opts.coalesce && last?.coalesce === opts.coalesce && now - last.at < COALESCE_MS) {
      history = [...past.slice(0, -1), {
        ...last, patches: [...last.patches, ...patches], inverse: [...inverse, ...last.inverse], at: now,
      }]
    } else {
      history = [...past, { label, patches, inverse, coalesce: opts.coalesce, at: now }].slice(-HISTORY_LIMIT)
    }
    set({ project: next, past: history, future: [], dirty: true, ...prune(next, get()) })
  },

  undo() {
    const { past, future, project } = get()
    const cmd = past[past.length - 1]
    if (!cmd) return
    const next = applyPatches(project, cmd.inverse)
    set({ project: next, past: past.slice(0, -1), future: [...future, { ...cmd, coalesce: undefined }], dirty: true, ...prune(next, get()) })
  },

  redo() {
    const { past, future, project } = get()
    const cmd = future[future.length - 1]
    if (!cmd) return
    const next = applyPatches(project, cmd.patches)
    set({ project: next, future: future.slice(0, -1), past: [...past, { ...cmd, coalesce: undefined }], dirty: true, ...prune(next, get()) })
  },

  load(project, file) {
    set({ project, file, dirty: false, past: [], future: [], selection: [], selectedMarker: null, editingClip: null })
  },

  markSaved(file) {
    set({ file, dirty: false })
  },

  select: (selection) => set({ selection, selectedMarker: null }),
  selectMarker: (selectedMarker) => set({ selectedMarker }),
  openEditor: (editingClip) => set({ editingClip }),
}))

/** Drop selections that point at things that no longer exist. */
function prune(p: Project, s: ProjectState): Partial<ProjectState> {
  const ids = new Set(p.clips.map((c) => c.id))
  const selection = s.selection.filter((id) => ids.has(id))
  return {
    selection: selection.length === s.selection.length ? s.selection : selection,
    editingClip: s.editingClip && ids.has(s.editingClip) ? s.editingClip : null,
    selectedMarker: s.selectedMarker && p.markers.some((m) => m.id === s.selectedMarker) ? s.selectedMarker : null,
  }
}
