import { create } from 'zustand'
import { api } from '../api'
import { SERUM_PRESET_ROOT } from '../lib/defaults'
import type { AppSettings, DepsReport, EngineStatus, JobInfo, SerumPreset } from '../types/api'

export type View = 'create' | 'process' | 'library' | 'grid' | 'midi' | 'hits' | 'stabs' | 'strings' | 'basses' | 'ambience' | 'vocalloops' | 'splice' | 'upload' | 'settings'

/** The sidebar's pages: Create, Drums (its tabs: Drumvault, Library; Grid opens from a zip), Sounds, Upload, Settings. */
export type Page = 'create' | 'drums' | 'sounds' | 'upload' | 'settings'

export const PAGE_TABS: Record<Page, { view: View; label: string }[]> = {
  create: [{ view: 'create', label: 'Create' }],
  drums: [{ view: 'process', label: 'Drumvault' }, { view: 'library', label: 'Library' }],
  sounds: [
    { view: 'stabs', label: 'Chord Stabs' }, { view: 'hits', label: 'Drop Hits' }, { view: 'strings', label: 'Strings' },
    { view: 'basses', label: 'Bass Samples' }, { view: 'ambience', label: 'Ambience' }, { view: 'vocalloops', label: 'Vocal Loops' }, { view: 'midi', label: 'MIDI' },
  ],
  upload: [{ view: 'upload', label: 'Upload' }],
  settings: [{ view: 'settings', label: 'Settings' }],
}

/** The page a view is on (Grid with the drums, Splice with the sounds). */
export function pageOf(v: View): Page {
  if (v === 'grid') return 'drums'
  if (v === 'splice') return 'sounds'
  return (Object.keys(PAGE_TABS) as Page[]).find((p) => PAGE_TABS[p].some((t) => t.view === v)) ?? 'create'
}

const TABS_KEY = 'drumvault.pageTabs'

function savedTabs(): Partial<Record<Page, View>> {
  try {
    return JSON.parse(localStorage.getItem(TABS_KEY) ?? '{}') as Partial<Record<Page, View>>
  } catch {
    return {}
  }
}

/** Views from before Create (the old menu's commands, a remembered tab). */
const viewOf = (v: string): View => (v === 'generate' || v === 'arrange' ? 'create' : v) as View

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
  /** Each page's last tab, to open it on again. */
  tabs: Partial<Record<Page, View>>
  toasts: Toast[]
  modal: 'export' | 'shortcuts' | null
  /** The zip shown in the Grid view. */
  gridZipId: number | null

  init(): Promise<void>
  setView(v: View): void
  /** Open a page of the sidebar on its last tab. */
  openPage(p: Page): void
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
  view: 'create',
  tabs: savedTabs(),
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
      if (cmd.startsWith('view:')) get().setView(viewOf(cmd.slice(5)))
      if (cmd === 'export') set({ view: 'create', modal: 'export' })
      if (cmd === 'shortcuts') set({ modal: 'shortcuts' })
    })
    const [settings, engine, jobs] = await Promise.all([api.getSettings(), api.engineStatus(), api.listJobs()])
    set({ settings, engine, jobs, ready: true })
    void get().refreshDeps()
  },

  setView: (view) => {
    const page = pageOf(view)
    // (Grid and Splice open from a tab, and aren't one.)
    if (PAGE_TABS[page].some((t) => t.view === view)) {
      const tabs = { ...get().tabs, [page]: view }
      try {
        localStorage.setItem(TABS_KEY, JSON.stringify(tabs))
      } catch {
        // not remembered
      }
      set({ view, tabs })
    } else {
      set({ view })
    }
  },
  openPage: (page) => {
    const tab = get().tabs[page]
    get().setView(tab && PAGE_TABS[page].some((t) => t.view === tab) ? tab : PAGE_TABS[page][0].view)
  },
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
/** Serum 2's presets folder, for the Bass and what comes (older settings: the bass one). */
/** The patches a pool plays: those whose samples are all here (Serum looks for missing ones on every load, and plays without them). */
export const playable = (presets: SerumPreset[]) => presets.filter((p) => !p.missing)

export function serumPresetRoot(): string {
  const s = useApp.getState().settings
  return s?.serumPresetRoot || s?.bass?.presetRoot || SERUM_PRESET_ROOT
}

export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    const msg = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    useApp.getState().toast('error', msg)
    return undefined
  }
}
