import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { ZipStatus } from '../types/engine'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({ variant = 'secondary', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md px-3 h-7 text-[12.5px] font-medium transition-colors',
        'disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap',
        variant === 'primary' && 'bg-brand text-white shadow-sm shadow-violet-500/25 hover:brightness-110',
        variant === 'secondary' && 'bg-panel text-text border border-line shadow-xs hover:bg-panel-2',
        variant === 'ghost' && 'text-muted hover:text-text hover:bg-raised',
        variant === 'danger' && 'bg-panel text-bad border border-line shadow-xs hover:bg-[#fef2f2]',
        className,
      )}
    />
  )
}

const STATUS_STYLE: Record<string, string> = {
  done: 'bg-[#15803d14] text-ok',
  needs_review: 'bg-[#f59e0b24] text-warn',
  error: 'bg-[#dc262614] text-bad',
  processing: 'bg-accent-soft text-accent',
  queued: 'bg-raised text-muted',
  skipped: 'bg-raised text-muted',
  cancelled: 'bg-raised text-muted',
}

const STATUS_LABEL: Record<string, string> = {
  done: 'Done', needs_review: 'Needs review', error: 'Error', processing: 'Processing', queued: 'Queued',
  skipped: 'Skipped', cancelled: 'Cancelled',
}

export function StatusChip({ status }: { status: ZipStatus | string }) {
  return (
    <span className={cx('inline-flex items-center rounded px-1.5 h-[18px] text-[11px] font-medium whitespace-nowrap',
      STATUS_STYLE[status] ?? STATUS_STYLE.queued)}>
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

export function Chip({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center rounded px-1.5 h-[18px] text-[11px] bg-raised text-muted whitespace-nowrap', className)}>
      {children}
    </span>
  )
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cx('h-1 rounded-full bg-raised overflow-hidden', className)}>
      <div className="h-full bg-brand transition-[width] duration-300" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  )
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-faint">{children}</h3>
      {right}
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[180px_1fr] items-center gap-3 py-1.5">
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-2">
        {children}
        {hint && <span className="text-faint text-[11.5px]">{hint}</span>}
      </span>
    </label>
  )
}

export const inputClass =
  'h-7 rounded-md bg-panel-2 border border-line px-2 text-text placeholder:text-faint focus:border-accent focus:outline-none'

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex rounded-md bg-panel-2 border border-line p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cx('px-2.5 h-6 rounded text-[12px] transition-colors',
            value === o.value ? 'bg-raised text-text' : 'text-muted hover:text-text')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6 text-muted">
      <div className="text-text font-medium mb-1">{title}</div>
      <div className="max-w-md">{children}</div>
    </div>
  )
}

export function Modal({ title, children, onClose, width = 560 }: {
  title: string
  children: ReactNode
  onClose?: () => void
  width?: number
}) {
  return (
    <div className="fixed inset-0 z-50 bg-[#1e1b2e33] backdrop-blur-[2px] flex items-center justify-center"
         onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="rounded-2xl border border-line bg-panel shadow-2xl shadow-violet-900/15 max-h-[88vh] flex flex-col"
           style={{ width }}>
        <div className="flex items-center px-5 pt-4 pb-3 border-b border-line">
          <h2 className="flex-1 text-[15px] font-semibold">{title}</h2>
          {onClose && <button onClick={onClose} className="text-muted hover:text-text text-[18px] leading-none">×</button>}
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  )
}
