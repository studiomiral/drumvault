import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** Fixed-height virtualised list: only the visible rows are rendered (5,000+ samples stay smooth). */
export function VirtualList({ count, rowHeight, renderRow, scrollToIndex, className }: {
  count: number
  rowHeight: number
  renderRow: (index: number) => ReactNode
  scrollToIndex?: number | null
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el || scrollToIndex == null || scrollToIndex < 0) return
    const top = scrollToIndex * rowHeight
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight
  }, [scrollToIndex, rowHeight])

  const overscan = 6
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + overscan)
  const rows: ReactNode[] = []
  for (let i = start; i < end; i++) {
    rows.push(
      <div key={i} style={{ position: 'absolute', top: i * rowHeight, left: 0, right: 0, height: rowHeight }}>
        {renderRow(i)}
      </div>,
    )
  }
  return (
    <div ref={ref} className={className} style={{ overflowY: 'auto', position: 'relative' }}
         onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: count * rowHeight, position: 'relative' }}>{rows}</div>
    </div>
  )
}
