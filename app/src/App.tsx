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

  if (!ready || !settings) return <div className="h-full bg-bg" />
  if (!settings.libraryPath) return <WelcomeView />

  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'processing').length

  return (
    <div className="h-full flex">
      <div className="fixed top-0 inset-x-0 h-[3px] bg-brand z-40" />
      <nav className="w-[184px] shrink-0 bg-panel border-r border-line flex flex-col">
        <div className="px-4 pt-5 pb-4">
          <div className="text-[17px] font-bold tracking-tight text-brand">Drumvault</div>
          <div className="text-[11px] text-faint truncate" title={settings.libraryPath}>
            {settings.libraryPath.split('/').pop()}
          </div>
        </div>
        <div className="flex flex-col gap-0.5 px-2">
          {NAV.map(({ view: v, label, Icon }) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cx('flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13px] transition-colors',
                view === v ? 'bg-brand-soft text-accent font-medium' : 'text-muted hover:text-text hover:bg-panel-2')}
            >
              <Icon className="w-4 h-4" />
              <span className="flex-1 text-left">{label}</span>
              {v === 'process' && active > 0 && (
                <span className="text-[10.5px] rounded-full bg-brand text-white px-1.5 font-semibold">{active}</span>
              )}
            </button>
          ))}
        </div>
        <div className="mt-auto p-3 border-t border-line">
          <EngineStatusDot />
        </div>
      </nav>
      <main className="flex-1 min-w-0 flex flex-col">
        {view === 'process' && <ProcessView />}
        {view === 'library' && <LibraryView />}
        {view === 'arrange' && <ArrangeView />}
        {view === 'settings' && <SettingsView />}
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
        <div key={t.id} className={cx('flex items-start gap-2 rounded-lg border px-3 py-2.5 shadow-xl text-[12.5px]',
          t.kind === 'error' ? 'bg-[#fef2f2] border-[#fecaca] text-[#991b1b]' : 'bg-panel border-line')}>
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
