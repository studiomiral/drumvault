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
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 h-7 text-[12.5px] font-medium transition-all',
        'disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap active:scale-[0.98]',
        // Primary is a soft yellow tint, not a solid fill: the accent stays quiet.
        variant === 'primary' && 'bg-accent/15 text-accent hover:bg-accent/22 '
          + 'shadow-[0_0_0_1px_rgb(226_195_95/0.35),inset_0_1px_0_rgb(255_255_255/0.06)]',
        (variant === 'secondary' || variant === 'danger') && 'surface-raised hover:bg-[rgb(255_255_255/0.13)]',
        variant === 'secondary' && 'text-text',
        variant === 'ghost' && 'text-muted hover:text-text hover:bg-raised',
        variant === 'danger' && 'text-bad',
        className,
      )}
    />
  )
}

const STATUS_STYLE: Record<string, string> = {
  done: 'bg-[rgb(74_222_128/0.12)] text-ok',
  needs_review: 'bg-[rgb(251_191_36/0.13)] text-warn',
  error: 'bg-[rgb(248_113_113/0.13)] text-bad',
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
    <span className={cx('inline-flex items-center rounded-md px-1.5 h-[18px] text-[11px] font-medium whitespace-nowrap',
      STATUS_STYLE[status] ?? STATUS_STYLE.queued)}>
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

export function Chip({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center rounded-md px-1.5 h-[18px] text-[11px] bg-raised text-muted whitespace-nowrap', className)}>
      {children}
    </span>
  )
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cx('h-1.5 rounded-full bg-raised overflow-hidden', className)}>
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
  'h-7 rounded-lg bg-[rgb(0_0_0/0.25)] border border-transparent px-2.5 text-text placeholder:text-faint '
  + 'shadow-[0_0_0_1px_rgb(255_255_255/0.08),inset_0_1px_2px_rgb(0_0_0/0.3)] transition-shadow '
  + 'focus:bg-[rgb(0_0_0/0.35)] focus:outline-none focus:shadow-[0_0_0_1px_rgb(226_195_95/0.5),0_0_0_3px_rgb(226_195_95/0.1)]'

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex rounded-lg bg-[rgb(0_0_0/0.25)] p-0.5 shadow-[0_0_0_1px_rgb(255_255_255/0.06)]">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cx('px-2.5 h-6 rounded-md text-[12px] transition-all',
            value === o.value
              ? 'surface-raised !bg-[rgb(255_255_255/0.12)] text-text font-medium'
              : 'text-muted hover:text-text')}
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
    <div className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[3px] flex items-center justify-center"
         onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="rounded-2xl surface-pop max-h-[88vh] flex flex-col"
           style={{ width }}>
        <div className="flex items-center px-5 pt-4 pb-3 border-b border-line">
          <h2 className="flex-1 font-display text-[19px] font-medium">{title}</h2>
          {onClose && <button onClick={onClose} className="text-muted hover:text-text text-[18px] leading-none">×</button>}
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  )
}

/** Page title in the top bar: heavy, modern display caps. */
export function PageTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h1 className={cx('font-title text-[22px] leading-none font-extrabold uppercase tracking-[0.01em] select-none', className)}
        style={{ fontVariationSettings: '"opsz" 96' }}>
      {children}
    </h1>
  )
}
