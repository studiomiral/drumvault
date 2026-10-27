import { useEffect } from 'react'
import { initProjects, startAutosave } from './arrange/persistence'
import { setAudioSampleRate } from './audio/context'
import { EngineStatusDot } from './components/EngineBanner'
import { IconArrange, IconLibrary, IconProcess, IconSettings, IconX } from './components/icons'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { cx } from './components/ui'
import { useApp, type View } from './store/app'
import { ArrangeView, duplicateSelection } from './views/ArrangeView'
import { useProject } from './store/project'
import { LibraryView } from './views/LibraryView'
import { ProcessView } from './views/ProcessView'
import { SettingsView } from './views/SettingsView'
import { WelcomeView } from './views/WelcomeView'

const NAV: { view: View; label: string; Icon: typeof IconProcess; key: string }[] = [
  { view: 'process', label: 'Process', Icon: IconProcess, key: '1' },
  { view: 'library', label: 'Library', Icon: IconLibrary, key: '2' },
  { view: 'arrange', label: 'Arrange', Icon: IconArrange, key: '3' },
  { view: 'settings', label: 'Settings', Icon: IconSettings, key: ',' },
]

export function App() {
  const { ready, settings, view, setView, jobs, init, modal, setModal } = useApp()

  useEffect(() => {
    void init()
  }, [init])

  // Arrange: load the library's last project once the library is known (and on switch).
  const libraryPath = settings?.libraryPath
  useEffect(() => {
    if (!libraryPath) return
    setAudioSampleRate(useApp.getState().settings?.engine.output_sample_rate ?? 44100)
    startAutosave()
    void initProjects()
  }, [libraryPath])

  // Edit commands (menu and keyboard): text fields get text editing, the arrangement gets
  // project editing.
  useEffect(() => {
    const offMenu = window.drumvault.onMenu((cmd) => runEditCommand(cmd))
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '?' && t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA') {
        useApp.getState().setModal('shortcuts')
        return
      }
      const mod = window.drumvault.platform === 'darwin' ? e.metaKey : e.ctrlKey
      if (!mod || e.altKey) return
      const k = e.key.toLowerCase()
      const cmd = k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : k === 'y' && !e.shiftKey ? 'redo'
        : k === 'd' && !e.shiftKey ? 'duplicate' : k === 'a' && !e.shiftKey ? 'select-all' : null
      if (cmd && runEditCommand(cmd)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offMenu()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  if (!ready || !settings) return <div className="aurora" />
  if (!settings.libraryPath) return <WelcomeView />

  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'processing').length

  return (
    <div className="h-full flex">
      <div className="aurora" />
      <nav className="w-[196px] shrink-0 flex flex-col">
        <div className="app-drag h-12 shrink-0" />
        <div className="app-drag px-4 pt-1 pb-5 flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-[9px] bg-brand shadow-[inset_0_1px_0_rgb(255_255_255/0.35)] flex items-center justify-center">
            <span className="w-2.5 h-2.5 rounded-full bg-on-accent/85" />
          </div>
          <div className="min-w-0">
            <div className="font-display text-[19px] font-medium leading-tight">Drumvault</div>
            <div className="text-[11px] text-faint truncate" title={settings.libraryPath}>
              {settings.libraryPath.split('/').pop()}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-0.5 px-2">
          {NAV.map(({ view: v, label, Icon }) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cx('flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-[13px] transition-all',
                view === v
                  ? 'surface-raised text-text font-medium [&_svg]:text-accent'
                  : 'text-muted hover:text-text hover:bg-panel')}
            >
              <Icon className="w-4 h-4" />
              <span className="flex-1 text-left">{label}</span>
              {v === 'process' && active > 0 && (
                <span className="text-[10.5px] rounded-full bg-brand text-on-accent px-1.5 font-semibold">{active}</span>
              )}
            </button>
          ))}
        </div>
        <div className="mt-auto p-3">
          <EngineStatusDot />
        </div>
      </nav>
      <main className="flex-1 min-w-0 flex flex-col py-2.5 pr-2.5">
        <div className="flex-1 min-h-0 flex flex-col rounded-2xl glass-card overflow-hidden">
          {view === 'process' && <ProcessView />}
          {view === 'library' && <LibraryView />}
          {view === 'arrange' && <ArrangeView />}
          {view === 'settings' && <SettingsView />}
        </div>
      </main>
      <Toasts />
      {modal === 'shortcuts' && <ShortcutsDialog onClose={() => setModal(null)} />}
    </div>
  )
}

function Toasts() {
  const { toasts, dismiss } = useApp()
  return (
    <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50 w-[360px]">
      {toasts.map((t) => (
        <div key={t.id} className={cx('flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-[12.5px] glass-strong',
          t.kind === 'error' && 'text-[#fecaca] !bg-[rgb(69_18_18/0.85)]')}>
          <span className="flex-1 select-text">{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="text-muted hover:text-text"><IconX className="w-3.5 h-3.5" /></button>
        </div>
      ))}
    </div>
  )
}

/** Returns true when the command was handled. */
function runEditCommand(cmd: string): boolean {
  const el = document.activeElement as HTMLElement | null
  const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && (el as HTMLInputElement).type !== 'range'
  const arrange = useApp.getState().view === 'arrange'
  const p = useProject.getState()
  if (cmd === 'undo' || cmd === 'redo') {
    if (typing) document.execCommand(cmd)
    else if (arrange) (cmd === 'undo' ? p.undo : p.redo)()
    else return false
  } else if (cmd === 'select-all') {
    if (typing) (el as HTMLInputElement).select()
    else if (arrange) p.select(p.project.clips.map((c) => c.id))
    else return false
  } else if (cmd === 'duplicate') {
    if (!arrange || typing) return false
    duplicateSelection()
  } else {
    return false
  }
  return true
}
