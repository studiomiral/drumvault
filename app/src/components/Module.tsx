import { useState, type ReactNode } from 'react'
import { IconChevron } from './icons'
import { cx, Toggle } from './ui'

const OPEN_KEY = 'drumvault.generate.modules'

function savedOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

/**
 * A Generate module (Bass, Chords, Disco Hits, Reverb builds): a panel that folds down to its
 * header. The header keeps the module's on/off switch, so it shows at a glance whether G writes a
 * new one, plus a one-line summary while folded. Open or folded is remembered per module; in a
 * lane panel (`fixed`) it is always open, and its switch is on the module's pill instead.
 */
export function Module({ id, title, enabled, onEnabled, enabledTitle, summary, status, fixed, children }: {
  id: string
  title: string
  enabled: boolean
  onEnabled: (on: boolean) => void
  enabledTitle: string
  summary?: ReactNode
  status?: ReactNode
  fixed?: boolean
  children: ReactNode
}) {
  const [opened, setOpen] = useState(() => savedOpen()[id] ?? true)
  const open = fixed || opened
  const toggle = () => {
    if (fixed) return
    setOpen(!open)
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify({ ...savedOpen(), [id]: !open }))
    } catch {
      // not remembered
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-panel-2">
      <div className={cx('h-11 px-3 flex items-center gap-3 select-none', !fixed && 'cursor-pointer', open && 'border-b border-line', fixed && 'pl-4')} onClick={toggle}>
        {!fixed && (
          <button className="w-6 h-6 rounded-md flex items-center justify-center text-faint hover:text-text" title={open ? 'Fold' : 'Open'}
                  onClick={(e) => { e.stopPropagation(); toggle() }}>
            <IconChevron className={cx('w-3.5 h-3.5 transition-transform', open && 'rotate-90')} />
          </button>
        )}
        {/* In the lane panel the switch is on the module's pill. */}
        {!fixed && <Toggle checked={enabled} onChange={onEnabled} label={`${title} in new generations`} title={enabledTitle} />}
        <h3 className={cx('text-[11px] font-semibold uppercase tracking-wider', enabled ? 'text-text' : 'text-faint')}>{title}</h3>
        {!open && summary && <span className="min-w-0 truncate text-[12px] text-muted">{summary}</span>}
        <span className="flex-1" />
        {status}
      </div>
      {open && <div className="px-5 py-4">{children}</div>}
    </section>
  )
}
