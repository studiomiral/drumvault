import { api } from '../api'
import { Button } from '../components/ui'
import { attempt, useApp } from '../store/app'

export function WelcomeView() {
  const { saveSettings, deps } = useApp()

  const choose = async () => {
    const dir = await api.chooseLibraryFolder()
    if (dir) await attempt(() => saveSettings({ libraryPath: dir }))
  }

  return (
    <div className="app-drag h-full flex items-center justify-center bg-bg">
      <div className="w-[520px] rounded-3xl surface-pop p-9">
        <div className="font-display text-[30px] font-medium leading-tight">Welcome to <span className="text-brand">Warehouse</span></div>
        <p className="text-muted mt-2 leading-relaxed">
          Warehouse builds club house tracks from your own material. Its Drumvault turns zips of stems into
          one drum sample library (one-shots and tempo-matched loops, labelled with the source track's key);
          bass, keys and disco hits join them in Generate. Choose the folder for that library. Everything goes in
          there, including its index, so you can back it up or move it as one folder.
        </p>
        <Button variant="primary" className="mt-6 h-9 px-4 text-[13.5px]" onClick={() => void choose()}>
          Choose library folder…
        </Button>
        {deps && (
          <div className="mt-8 border-t border-line pt-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-faint mb-2">Requirements</div>
            <ul className="space-y-1.5 text-[12.5px]">
              {deps.checks.map((c) => (
                <li key={c.name} className="flex gap-2">
                  <span className={c.ok ? 'text-ok' : 'text-bad'}>{c.ok ? '✓' : '✕'}</span>
                  <span className="w-24">{c.name}</span>
                  <span className="text-muted flex-1 truncate" title={c.detail}>{c.detail}</span>
                  {c.fix && <code className="text-accent select-text">{c.fix}</code>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
