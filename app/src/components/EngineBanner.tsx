import { api } from '../api'
import { attempt, useApp } from '../store/app'
import { Button, cx } from './ui'

const DOT: Record<string, string> = {
  ready: 'bg-ok', starting: 'bg-warn animate-pulse', crashed: 'bg-bad', missing: 'bg-bad', stopped: 'bg-faint',
}

export function EngineStatusDot() {
  const engine = useApp((s) => s.engine)
  const label = engine.state === 'ready' ? 'Engine ready' : engine.state === 'starting' ? 'Engine starting…'
    : engine.state === 'stopped' ? 'Engine stopped' : 'Engine unavailable'
  return (
    <div className="flex items-center gap-2 text-[11.5px] text-muted" title={engine.message}>
      <span className={cx('w-2 h-2 rounded-full', DOT[engine.state])} />
      {label}
    </div>
  )
}

/** Shown in the Process view while the engine can't take jobs. */
export function EngineBanner() {
  const { engine, deps, refreshDeps } = useApp()
  if (engine.state === 'ready' && engine.health?.ok !== false) return null
  const starting = engine.state === 'starting'
  const missing = deps?.checks.filter((c) => !c.ok) ?? []
  return (
    <div className={cx('mx-6 mt-4 rounded-lg border px-4 py-3',
      starting ? 'border-line bg-panel' : 'border-[#fecaca] bg-[#fef2f2]')}>
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="font-medium">
            {starting ? 'Starting the engine…' : engine.state === 'ready' ? 'Rubber Band not found' : 'The engine is not running'}
          </div>
          <div className="text-muted text-[12px] mt-0.5 select-text">
            {starting ? 'The first start sets up Python and the analysis libraries; this can take a few minutes.'
              : engine.message}
          </div>
        </div>
        {!starting && (
          <>
            <Button variant="ghost" onClick={() => void refreshDeps()}>Check again</Button>
            <Button onClick={() => void attempt(() => api.restartEngine())}>Restart engine</Button>
          </>
        )}
      </div>
      {!starting && missing.length > 0 && (
        <ul className="mt-3 space-y-1 text-[12px]">
          {missing.map((c) => (
            <li key={c.name} className="flex gap-2">
              <span className="text-bad">✕</span>
              <span className="text-text w-24">{c.name}</span>
              <span className="text-muted flex-1">{c.detail}</span>
              {c.fix && <code className="text-accent select-text">{c.fix}</code>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
