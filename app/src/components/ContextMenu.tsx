import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cx } from './ui'

export type MenuEntry =
  | { label: string; shortcut?: string; onClick: () => void; disabled?: boolean; danger?: boolean; title?: string }
  | 'separator'

/** A right-click menu at the pointer, kept inside the window; closes on choice, Esc or a click elsewhere. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect()
    setPos({
      left: Math.max(6, Math.min(x, window.innerWidth - r.width - 6)),
      top: Math.max(6, Math.min(y, window.innerHeight - r.height - 6)),
    })
  }, [x, y])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])
  // Trailing, leading and doubled separators fall away (items can be conditional).
  const shown = items.filter((it, i, all) => it !== 'separator'
    || (i > 0 && i < all.length - 1 && all[i - 1] !== 'separator'))
  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose} onContextMenu={(e) => {
      e.preventDefault()
      onClose()
    }}>
      <div ref={ref} className="absolute min-w-[230px] rounded-xl surface-pop py-1.5 text-[12.5px]" style={pos}
           onMouseDown={(e) => e.stopPropagation()}>
        {shown.map((it, i) => it === 'separator' ? (
          <div key={i} className="my-1.5 mx-2 h-px bg-line" />
        ) : (
          <button key={i} disabled={it.disabled} title={it.title}
                  onClick={() => {
                    onClose()
                    it.onClick()
                  }}
                  className={cx('w-full h-7 px-3 flex items-center gap-6 text-left disabled:opacity-35 enabled:hover:bg-[rgb(255_255_255/0.07)]',
                    it.danger ? 'text-bad' : 'text-text')}>
            <span className="flex-1">{it.label}</span>
            {it.shortcut && <span className="text-faint text-[11.5px]">{it.shortcut}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
