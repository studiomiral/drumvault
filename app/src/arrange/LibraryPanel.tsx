import { useEffect, useState } from 'react'
import { api } from '../api'
import { audition } from '../audio/audition'
import { IconPlay, IconStop } from '../components/icons'
import { cx, inputClass, Segmented } from '../components/ui'
import { VirtualList } from '../components/VirtualList'
import { ALL_KEYS } from '../lib/camelot'
import { CATEGORY_LABELS } from '../lib/format'
import { useApp } from '../store/app'
import type { SampleListItem } from '../types/api'
import type { Category, SampleKind } from '../types/engine'
import { dragSample, SAMPLE_MIME } from './Timeline'

/** Collapsible library browser inside Arrange: audition and drag samples onto lanes. */
export function LibraryPanel() {
  const libraryVersion = useApp((s) => s.libraryVersion)
  const [kind, setKind] = useState<SampleKind | 'all'>('loop')
  const [category, setCategory] = useState<Category | ''>('')
  const [key, setKey] = useState('')
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<SampleListItem[]>([])
  const [playing, setPlaying] = useState<number | null>(audition.playingId)

  useEffect(() => audition.subscribe(setPlaying), [])
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      void api.querySamples({
        kind: kind === 'all' ? null : kind, categories: category ? [category] : [], keys: key ? [key] : [],
        compatible: !!key, search, sort: 'category',
      }).then((r) => alive && setItems(r))
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [kind, category, key, search, libraryVersion])

  const cats = kind === 'oneshot'
    ? ['kick', 'snare', 'clap', 'hat_closed', 'hat_open', 'ride', 'cymbal', 'shaker', 'perc']
    : ['snare', 'clap', 'hat', 'hat_closed', 'hat_open', 'ride', 'shaker', 'perc', 'top', 'groove', 'drums']

  return (
    <aside className="w-[300px] shrink-0 border-l border-line bg-panel flex flex-col min-h-0">
      <div className="p-3 space-y-2 border-b border-line">
        <input className={cx(inputClass, 'w-full')} placeholder="Search library" value={search}
               onChange={(e) => setSearch(e.target.value)} />
        <Segmented<SampleKind | 'all'> value={kind} onChange={(v) => {
          setKind(v)
          setCategory('')
        }} options={[{ value: 'loop', label: 'Loops' }, { value: 'oneshot', label: 'One-shots' }, { value: 'all', label: 'All' }]} />
        <div className="flex gap-2">
          <select className={cx(inputClass, 'flex-1 min-w-0')} value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            <option value="">All categories</option>
            {cats.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c as Category]}</option>)}
          </select>
          <select className={cx(inputClass, 'w-28')} value={key} onChange={(e) => setKey(e.target.value)} title="Key (with Camelot-compatible keys)">
            <option value="">Any key</option>
            {ALL_KEYS.map((k) => <option key={k.label} value={k.label}>{k.label} {k.camelot}</option>)}
          </select>
        </div>
      </div>
      <VirtualList className="flex-1" count={items.length} rowHeight={40} renderRow={(i) => {
        const s = items[i]
        const on = playing === s.id
        return (
          <div draggable
               onDragStart={(e) => {
                 e.dataTransfer.setData(SAMPLE_MIME, JSON.stringify(s))
                 e.dataTransfer.effectAllowed = 'copy'
                 dragSample.current = { kind: s.kind, bars: s.bars }
               }}
               onDragEnd={() => {
                 dragSample.current = null
               }}
               className={cx('h-full flex items-center gap-2 px-3 border-b border-line/60 cursor-grab', on ? 'bg-brand-soft' : 'hover:bg-panel-2')}>
            <button onClick={() => audition.toggle(s)}
                    className={cx('w-6 h-6 rounded-full flex items-center justify-center shrink-0',
                      on ? 'bg-brand text-white' : 'text-muted hover:text-accent')}>
              {on ? <IconStop className="w-3 h-3" /> : <IconPlay className="w-3 h-3" />}
            </button>
            <div className="flex-1 min-w-0">
              <div className="truncate text-[12px]" title={s.name}>{s.name}</div>
              <div className="text-[10.5px] text-faint">
                {CATEGORY_LABELS[s.category]} · {s.key_label ?? 'NoKey'}{s.kind === 'loop' ? ` · ${s.bars} bar${s.bars === 1 ? '' : 's'}` : ''}
              </div>
            </div>
          </div>
        )
      }} />
      <div className="px-3 py-2 text-[11px] text-faint border-t border-line">
        {items.length} samples · drag onto a lane · loops start on the next bar while playing
      </div>
    </aside>
  )
}
