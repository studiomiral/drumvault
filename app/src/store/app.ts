import { create } from 'zustand'
import { api } from '../api'
import type { AppSettings, DepsReport, EngineStatus, JobInfo } from '../types/api'

export type View = 'process' | 'library' | 'grid' | 'generate' | 'arrange' | 'settings'

export interface Toast {
  id: number
  kind: 'info' | 'error'
  text: string
}

interface AppState {
  ready: boolean
  settings: AppSettings | null
  engine: EngineStatus
  deps: DepsReport | null
  jobs: JobInfo[]
  /** Bumped whenever the library database changed; views refetch on it. */
  libraryVersion: number
  view: View
  toasts: Toast[]
  modal: 'export' | 'shortcuts' | null
  /** The zip shown in the Grid view. */
  gridZipId: number | null

  init(): Promise<void>
  setView(v: View): void
  openGrid(zipId: number): void
  setModal(m: AppState['modal']): void
  saveSettings(patch: Partial<AppSettings>): Promise<void>
  refreshDeps(): Promise<void>
  toast(kind: Toast['kind'], text: string): void
  dismiss(id: number): void
}

let toastId = 0

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  settings: null,
  engine: { state: 'stopped', message: '', health: null, restarts: 0 },
  deps: null,
  jobs: [],
  libraryVersion: 0,
  view: 'process',
  toasts: [],
  modal: null,
  gridZipId: null,

  async init() {
    api.onEngineStatus((engine) => {
      set({ engine })
      if (engine.state === 'missing' || engine.state === 'ready') void get().refreshDeps()
    })
    api.onJobs((jobs) => set({ jobs }))
    api.onLibraryChanged(() => set((s) => ({ libraryVersion: s.libraryVersion + 1 })))
    api.onMenu((cmd) => {
      if (cmd.startsWith('view:')) set({ view: cmd.slice(5) as View })
      if (cmd === 'export') set({ view: 'arrange', modal: 'export' })
      if (cmd === 'shortcuts') set({ modal: 'shortcuts' })
    })
    const [settings, engine, jobs] = await Promise.all([api.getSettings(), api.engineStatus(), api.listJobs()])
    set({ settings, engine, jobs, ready: true })
    void get().refreshDeps()
  },

  setView: (view) => set({ view }),
  openGrid: (gridZipId) => set({ gridZipId, view: 'grid' }),
  setModal: (modal) => set({ modal }),

  async saveSettings(patch) {
    const settings = await api.saveSettings(patch)
    set({ settings })
  },

  async refreshDeps() {
    set({ deps: await api.checkDeps() })
  },

  toast(kind, text) {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => get().dismiss(id), kind === 'error' ? 8000 : 4000)
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/** Run an API call; errors become toasts. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    const msg = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    useApp.getState().toast('error', msg)
    return undefined
  }
}
