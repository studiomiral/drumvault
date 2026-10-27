import { useEffect } from 'react'
import { initProjects, startAutosave } from './arrange/persistence'
import { setAudioSampleRate } from './audio/context'
import { EngineStatusDot } from './components/EngineBanner'
import { IconArrange, IconFolder, IconGrid, IconKeyboard, IconLibrary, IconProcess, IconSettings, IconSparkle, IconX } from './components/icons'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { cx } from './components/ui'
import { useApp, type View } from './store/app'
import { ArrangeView, duplicateSelection } from './views/ArrangeView'
import { useProject } from './store/project'
import { GenerateView } from './views/GenerateView'
import { GridView } from './views/GridView'
import { LibraryView } from './views/LibraryView'
import { ProcessView } from './views/ProcessView'
import { SettingsView } from './views/SettingsView'
import { WelcomeView } from './views/WelcomeView'

const NAV_GROUPS: { label: string; items: { view: View; label: string; Icon: typeof IconProcess }[] }[] = [
  { label: 'Samples', items: [
    { view: 'process', label: 'Process', Icon: IconProcess },
    { view: 'library', label: 'Library', Icon: IconLibrary },
    { view: 'grid', label: 'Grid', Icon: IconGrid },
  ] },
  { label: 'Create', items: [
    { view: 'generate', label: 'Generate', Icon: IconSparkle },
    { view: 'arrange', label: 'Arrange', Icon: IconArrange },
  ] },
  { label: 'Settings', items: [{ view: 'settings', label: 'Settings', Icon: IconSettings }] },
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
    <div className="h-full flex bg-bg">
      <nav className="w-[224px] shrink-0 bg-panel border-r border-line flex flex-col">
        {/* Room for the window buttons; lines up with the views' top bars. */}
        <div className="app-drag h-14 shrink-0 border-b border-line" />
        <div className="flex-1 min-h-0 overflow-y-auto px-3 pt-5 space-y-6">
          {NAV_GROUPS.map((g) => (
            <div key={g.label}>
              <div className="px-2.5 mb-2 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-faint">{g.label}</div>
              <div className="flex flex-col gap-1">
                {g.items.map(({ view: v, label, Icon }) => (
                  <NavItem key={v} label={label} Icon={Icon} active={view === v} onClick={() => setView(v)}
                           badge={v === 'process' && active > 0 ? active : null} />
                ))}
                {g.label === 'Settings' && (
                  <NavItem label="Shortcuts" Icon={IconKeyboard} active={false} onClick={() => setModal('shortcuts')} hint="?" />
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="mx-4 border-t border-line" />
        <div className="px-4 py-4 flex items-center gap-3">
          <div className="w-9 h-9 shrink-0 rounded-xl bg-pastel-yellow text-on-pastel flex items-center justify-center">
            <IconFolder className="w-[18px] h-[18px]" />
          </div>
          <div className="min-w-0">
            <div className="text-[12.5px] font-medium truncate" title={settings.libraryPath}>
              {settings.libraryPath.split('/').pop()}
            </div>
            <EngineStatusDot />
          </div>
        </div>
      </nav>
      <main className="flex-1 min-w-0 flex flex-col">
        {view === 'process' && <ProcessView />}
        {view === 'library' && <LibraryView />}
        {view === 'grid' && <GridView />}
        {view === 'generate' && <GenerateView />}
        {view === 'arrange' && <ArrangeView />}
        {view === 'settings' && <SettingsView />}
      </main>
      <Toasts />
      {modal === 'shortcuts' && <ShortcutsDialog onClose={() => setModal(null)} />}
    </div>
  )
}

function NavItem({ label, Icon, active, onClick, badge, hint }: {
  label: string
  Icon: typeof IconProcess
  active: boolean
  onClick: () => void
  badge?: number | null
  hint?: string
}) {
  return (
    <button onClick={onClick}
            className={cx('flex items-center gap-3 h-9 px-2.5 rounded-lg text-[13px] transition-colors',
              active ? 'bg-raised text-text font-medium' : 'text-muted hover:text-text hover:bg-[#2d2e32]')}>
      <Icon className={cx('w-[17px] h-[17px]', active && 'text-accent')} />
      <span className="flex-1 text-left">{label}</span>
      {badge != null && <span className="text-[10.5px] rounded-full bg-brand text-on-accent px-1.5 font-semibold">{badge}</span>}
      {hint && <kbd className="text-[10.5px] text-faint font-sans">{hint}</kbd>}
    </button>
  )
}

function Toasts() {
  const { toasts, dismiss } = useApp()
  return (
    <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50 w-[360px]">
      {toasts.map((t) => (
        <div key={t.id} className={cx('flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-[12.5px] surface-pop',
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
