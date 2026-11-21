import { useState, type DragEvent, type ReactNode } from 'react'
import { api } from '../api'
import { IconChevron, IconDrop } from './icons'
import { cx } from './ui'

/**
 * A Sounds tab's dashed drop zone: click to choose, or drop files, folders or zips on it. It takes
 * the drop itself (a tab with two zones, Bass and Piano, sends each its own files).
 */
export function DropZone({ title, about, disabled, highlight, onChoose, onPaths }: {
  title: string
  about: ReactNode
  disabled?: boolean
  /** Lit as if dragged over (a tab that takes drops anywhere). */
  highlight?: boolean
  onChoose: () => void
  onPaths: (paths: string[]) => void
}) {
  const [over, setOver] = useState(false)
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setOver(false)
    if (!disabled) onPaths(api.pathsForFiles([...e.dataTransfer.files]))
  }
  return (
    <button disabled={disabled} onClick={onChoose}
            onDragOver={(e) => {
              e.preventDefault()
              if (!over) setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
            className={cx('w-full rounded-2xl border border-dashed px-6 py-6 flex items-center gap-4 text-left transition-colors',
              over || highlight ? 'border-accent bg-accent-soft' : 'border-[#3e3f44] bg-panel-2 hover:border-accent/60')}>
      <span className="w-12 h-12 rounded-full bg-raised flex items-center justify-center text-text shrink-0">
        <IconDrop className="w-6 h-6" />
      </span>
      <span>
        <span className="block text-text font-medium">{title}</span>
        <span className="block mt-1 text-[12px] text-muted">{about}</span>
      </span>
    </button>
  )
}

const FOLD_KEY = 'drumvault.soundSections'

function folded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

/** A part of a Sounds tab with several (Bass, Piano): its title and count, folded away with a click (remembered). */
export function FoldSection({ id, title, count, children }: { id: string; title: string; count?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(() => !folded()[id])
  const toggle = () => {
    setOpen(!open)
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify({ ...folded(), [id]: open }))
    } catch {
      // not remembered
    }
  }
  return (
    <section className="space-y-3">
      <button className="flex items-center gap-2 text-left" onClick={toggle}>
        <IconChevron className={cx('w-3.5 h-3.5 text-faint transition-transform', open && 'rotate-90')} />
        <span className="text-[11px] font-semibold uppercase tracking-wider">{title}</span>
        {count != null && <span className="text-[12px] text-faint tabular-nums">{count}</span>}
      </button>
      {open && children}
    </section>
  )
}
