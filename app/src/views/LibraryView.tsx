import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { audition } from '../audio/audition'
import { IconPlay, IconStar, IconStop } from '../components/icons'
import { Button, Chip, cx, Empty, inputClass, Segmented } from '../components/ui'
import { VirtualList } from '../components/VirtualList'
import { Waveform } from '../components/Waveform'
import { ALL_KEYS, expandCompatible } from '../lib/camelot'
import { CATEGORY_LABELS, EVENT_CATEGORIES, formatBpm, formatDuration, KIND_LABELS, lengthLabel } from '../lib/format'
import { attempt, useApp } from '../store/app'
import { useLibrary } from '../store/library'
import type { LibraryFacets, SampleListItem, SampleSort } from '../types/api'
import type { Category, SampleKind } from '../types/engine'

const ROW = 46
const ONESHOT_ORDER: Category[] = ['kick', 'snare', 'clap', 'hat_closed', 'hat_open', 'ride', 'cymbal', 'shaker', 'perc']
const LOOP_ORDER: Category[] = ['snare', 'clap', 'hat', 'hat_closed', 'hat_open', 'ride', 'shaker', 'perc', 'top', 'groove', 'drums']
const ORDER: Record<SampleKind, Category[]> = { oneshot: ONESHOT_ORDER, loop: LOOP_ORDER, event: EVENT_CATEGORIES }

export function LibraryView() {
  const { libraryVersion } = useApp()
  const { filter, setFilter, resetFilter, selectedId, select, similarTo, findSimilar } = useLibrary()
  const [items, setItems] = useState<SampleListItem[]>([])
  const [facets, setFacets] = useState<LibraryFacets | null>(null)
  const [playingId, setPlayingId] = useState<number | null>(audition.playingId)
  const [loaded, setLoaded] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => audition.subscribe(setPlayingId), [])
  useEffect(() => () => audition.stop(), [])

  useEffect(() => {
    void api.facets().then(setFacets)
  }, [libraryVersion])

  // Debounce typing in the search box; other filter changes apply at once.
  const [search, setSearch] = useState(filter.search ?? '')
  useEffect(() => {
    const t = setTimeout(() => setFilter({ search }), 150)
    return () => clearTimeout(t)
  }, [search, setFilter])

  useEffect(() => {
    let alive = true
    const q = similarTo ? api.similarSamples(similarTo.id, 60) : api.querySamples(filter)
    void q.then((rows) => {
      if (!alive) return
      setItems(rows)
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [filter, similarTo, libraryVersion])

  const index = useMemo(() => items.findIndex((s) => s.id === selectedId), [items, selectedId])
  const selected = index >= 0 ? items[index] : null

  const updateLocal = useCallback((id: number, patch: Partial<SampleListItem>) => {
    setItems((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }, [])

  const toggleFavorite = useCallback((s: SampleListItem) => {
    const favorite = s.favorite ? 0 : 1
    updateLocal(s.id, { favorite })
    void attempt(() => api.setSampleMeta(s.id, { favorite: !!favorite }))
  }, [updateLocal])

  const setRating = useCallback((s: SampleListItem, rating: number) => {
    const r = s.rating === rating ? 0 : rating
    updateLocal(s.id, { rating: r || null })
    void attempt(() => api.setSampleMeta(s.id, { rating: r }))
  }, [updateLocal])

  const choose = useCallback((s: SampleListItem, play = true) => {
    select(s.id)
    if (play) void audition.play(s).catch((e) => useApp.getState().toast('error', `Could not play: ${e.message}`))
  }, [select])

  // Keyboard: Space play/stop, ↑/↓ next + play, Esc stop, F favourite, 1–5 rating, ⌘F search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const typing = t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (typing) {
        if (e.key === 'Escape' || e.key === 'ArrowDown') (t as HTMLInputElement).blur()
        if (e.key !== 'ArrowDown') return
      }
      if (e.key === ' ') {
        e.preventDefault()
        if (selected) audition.toggle(selected)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (!items.length) return
        const next = index < 0 ? 0 : Math.max(0, Math.min(items.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))
        choose(items[next])
      } else if (e.key === 'Escape') {
        audition.stop()
      } else if (selected && e.key.toLowerCase() === 'f' && !e.metaKey && !e.ctrlKey) {
        toggleFavorite(selected)
      } else if (selected && /^[1-5]$/.test(e.key)) {
        setRating(selected, Number(e.key))
      } else if (selected && e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey) {
        findSimilar({ id: selected.id, name: selected.name })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, index, selected, choose, toggleFavorite, setRating, findSimilar])

  const filtered = !!(filter.kind || filter.categories?.length || filter.keys?.length || filter.bars?.length
    || filter.zipIds?.length || filter.favoritesOnly || filter.search)

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="app-drag h-14 shrink-0 flex items-center gap-3 px-5 border-b border-line">
        <h1 className="font-display text-[21px] font-medium mr-2">Library</h1>
        <input ref={searchRef} className={cx(inputClass, 'w-64')} placeholder="Search names and tags  ⌘F"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        <Segmented<'all' | SampleKind> value={filter.kind ?? 'all'}
                   onChange={(v) => setFilter({ kind: v === 'all' ? null : v, categories: [] })}
                   options={[{ value: 'all', label: 'All' },
                             ...(['oneshot', 'loop', 'event'] as const).map((k) => ({ value: k, label: KIND_LABELS[k] }))]} />
        <button onClick={() => setFilter({ favoritesOnly: !filter.favoritesOnly })}
                className={cx('flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[12px]',
                  filter.favoritesOnly ? 'border-accent text-accent bg-accent-soft' : 'border-line text-muted hover:text-text')}>
          <IconStar className="w-3.5 h-3.5" filled={filter.favoritesOnly} /> Favourites
        </button>
        <div className="flex-1" />
        <span className="text-muted text-[12px]">
          {items.length.toLocaleString()}{facets && filtered ? ` of ${facets.total.toLocaleString()}` : ''} samples
        </span>
        <select className={cx(inputClass, 'w-32')} value={filter.sort ?? 'name'}
                onChange={(e) => setFilter({ sort: e.target.value as SampleSort })}>
          <option value="name">Name</option>
          <option value="category">Category</option>
          <option value="key">Key (Camelot)</option>
          <option value="rating">Favourites first</option>
          <option value="newest">Newest</option>
        </select>
      </header>

      <div className="flex-1 min-h-0 flex">
        <FilterSidebar facets={facets} onReset={() => {
          setSearch('')
          resetFilter()
        }} filtered={filtered} />
        <div className="flex-1 min-w-0 flex flex-col">
          {similarTo && (
            <div className="shrink-0 flex items-center gap-3 px-4 h-10 bg-brand-soft border-b border-line text-[12.5px]">
              <span className="text-accent font-medium">Similar to</span>
              <span className="truncate font-medium">{similarTo.name}</span>
              <span className="text-faint">same category{items[0] && items[0].kind !== 'oneshot' ? ' and length' : ''}, most similar first</span>
              <div className="flex-1" />
              <Button variant="ghost" onClick={() => findSimilar(null)}>Back to the list</Button>
            </div>
          )}
          {loaded && items.length === 0 ? (
            similarTo ? <Empty title="Nothing similar">No other samples in this category{' '}to compare with.</Empty> :
            <Empty title={facets?.total ? 'No samples match' : 'The library is empty'}>
              {facets?.total ? 'Try removing some filters.' : 'Process some zips in the Process view to fill it.'}
            </Empty>
          ) : (
            <VirtualList
              className="flex-1"
              count={items.length}
              rowHeight={ROW}
              scrollToIndex={index}
              renderRow={(i) => (
                <SampleRow
                  s={items[i]}
                  selected={items[i].id === selectedId}
                  playing={items[i].id === playingId}
                  onClick={() => choose(items[i])}
                  onPlayToggle={() => {
                    select(items[i].id)
                    audition.toggle(items[i])
                  }}
                  onFavorite={() => toggleFavorite(items[i])}
                  onRate={(r) => setRating(items[i], r)}
                />
              )}
            />
          )}
          {selected && <SelectedBar s={selected} onSimilar={() => findSimilar({ id: selected.id, name: selected.name })} onTags={(tags) => {
            updateLocal(selected.id, { tags: tags || null })
            void attempt(() => api.setSampleMeta(selected.id, { tags }))
          }} />}
        </div>
      </div>
    </div>
  )
}

function SampleRow({ s, selected, playing, onClick, onPlayToggle, onFavorite, onRate }: {
  s: SampleListItem
  selected: boolean
  playing: boolean
  onClick: () => void
  onPlayToggle: () => void
  onFavorite: () => void
  onRate: (r: number) => void
}) {
  return (
    <div
      onMouseDown={(e) => e.button === 0 && !(e.target as HTMLElement).closest('button') && onClick()}
      draggable
      onDragStart={(e) => {
        e.preventDefault()
        api.startDrag(s.rel_path)
      }}
      className={cx('h-full flex items-center gap-3 px-4 border-b border-line/60 cursor-default',
        selected ? 'bg-brand-soft' : 'hover:bg-panel')}
    >
      <button onClick={onPlayToggle}
              className={cx('w-7 h-7 rounded-full flex items-center justify-center shrink-0',
                playing ? 'bg-brand text-on-accent shadow-sm shadow-black/30' : 'text-muted hover:text-accent hover:bg-raised')}>
        {playing ? <IconStop className="w-3.5 h-3.5" /> : <IconPlay className="w-3.5 h-3.5" />}
      </button>
      <Waveform id={s.id} width={150} height={28} color={playing ? '#e2c35f' : selected ? '#bdbab3' : '#5d5b57'} />
      <div className="flex-1 min-w-0">
        <div className="truncate text-[12.5px]">{s.name}</div>
        <div className="text-[11px] text-faint truncate">{s.source_code} · {formatDuration(s.duration_s)}</div>
      </div>
      {'similarity' in s && (
        <span className="w-12 text-right text-[11.5px] tabular-nums text-accent font-medium" title="Similarity">
          {Math.round((s as SampleListItem & { similarity: number }).similarity * 100)}%
        </span>
      )}
      <Chip className="w-[92px] justify-center">{CATEGORY_LABELS[s.category]}</Chip>
      <span className="w-[74px] text-[12px]">
        {s.key_label ?? <span className="text-faint">NoKey</span>}
        {s.key_camelot && <span className="text-faint ml-1.5">{s.key_camelot}</span>}
      </span>
      <span className="w-[64px] text-[12px] text-muted">{lengthLabel(s)}</span>
      <button onClick={onFavorite} className={cx('shrink-0', s.favorite ? 'text-accent' : 'text-faint hover:text-muted')}
              title="Favourite (F)">
        <IconStar className="w-4 h-4" filled={!!s.favorite} />
      </button>
      <span className="flex gap-0.5 w-[58px] shrink-0" title="Rating (1–5)">
        {[1, 2, 3, 4, 5].map((r) => (
          <button key={r} onClick={() => onRate(r)}
                  className={cx('w-2.5 h-2.5 rounded-full', (s.rating ?? 0) >= r ? 'bg-brand' : 'bg-[rgb(255_255_255/0.12)] hover:bg-[rgb(255_255_255/0.22)]')} />
        ))}
      </span>
    </div>
  )
}

function SelectedBar({ s, onTags, onSimilar }: { s: SampleListItem; onTags: (tags: string) => void; onSimilar: () => void }) {
  const [tags, setTags] = useState(s.tags ?? '')
  useEffect(() => setTags(s.tags ?? ''), [s.id, s.tags])
  return (
    <div className="h-12 shrink-0 border-t border-line bg-panel flex items-center gap-3 px-4 text-[12px]">
      <span className="font-medium truncate max-w-[40%] select-text" title={s.rel_path}>{s.name}</span>
      <span className="text-muted">
        {s.kind !== 'oneshot' ? `${formatBpm(s.bpm)} BPM · ${lengthLabel(s)}` : 'one-shot'} · {s.channels === 1 ? 'mono' : 'stereo'}
      </span>
      <div className="flex-1" />
      <input className={cx(inputClass, 'w-56 h-6 text-[12px]')} placeholder="Tags (Enter to save)" value={tags}
             onChange={(e) => setTags(e.target.value)}
             onKeyDown={(e) => {
               if (e.key === 'Enter') {
                 onTags(tags)
                 ;(e.target as HTMLInputElement).blur()
               }
             }}
             onBlur={() => tags !== (s.tags ?? '') && onTags(tags)} />
      <Button variant="ghost" title="Find similar sounds (S)" onClick={onSimilar}>Find similar</Button>
      <Button variant="ghost" onClick={() => void api.revealSample(s.rel_path)}>Reveal in Finder</Button>
    </div>
  )
}

function toggle<T>(list: T[] | undefined, v: T): T[] {
  const l = list ?? []
  return l.includes(v) ? l.filter((x) => x !== v) : [...l, v]
}

function FilterSidebar({ facets, onReset, filtered }: { facets: LibraryFacets | null; onReset: () => void; filtered: boolean }) {
  const { filter, setFilter } = useLibrary()
  if (!facets) return <aside className="w-[232px] shrink-0 border-r border-line bg-panel-2" />

  const catCounts = new Map<string, number>()
  for (const c of facets.categories) {
    if (!filter.kind || c.kind === filter.kind) catCounts.set(c.category, (catCounts.get(c.category) ?? 0) + c.count)
  }
  const order = filter.kind ? ORDER[filter.kind] : [...new Set([...ONESHOT_ORDER, ...LOOP_ORDER, ...EVENT_CATEGORIES])]
  const keyCounts = new Map(facets.keys.map((k) => [k.label ?? 'NoKey', k.count]))
  const selectedKeys = filter.keys ?? []
  const implied = filter.compatible ? expandCompatible(selectedKeys.filter((k) => k !== 'NoKey')) : []

  return (
    <aside className="w-[232px] shrink-0 border-r border-line bg-panel-2 overflow-y-auto px-4 py-4 space-y-6 text-[12.5px]">
      {filtered && (
        <button onClick={onReset} className="text-accent hover:underline text-[12px]">Clear all filters</button>
      )}
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-faint mb-2">Category</div>
        <div className="space-y-0.5">
          {order.filter((c) => catCounts.has(c)).map((c) => {
            const on = filter.categories?.includes(c)
            return (
              <button key={c} onClick={() => setFilter({ categories: toggle(filter.categories, c) })}
                      className={cx('w-full flex items-center justify-between px-2 h-7 rounded-md',
                        on ? 'bg-accent-soft text-accent' : 'text-muted hover:text-text hover:bg-panel-2')}>
                <span>{CATEGORY_LABELS[c]}</span>
                <span className="text-faint text-[11px]">{catCounts.get(c)}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Key</span>
          <label className="flex items-center gap-1.5 text-[11.5px] text-muted cursor-pointer"
                 title="Also show keys next to the selected ones on the Camelot wheel">
            <input type="checkbox" checked={!!filter.compatible}
                   onChange={(e) => setFilter({ compatible: e.target.checked })} className="accent-[#e2c35f]" />
            compatible
          </label>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {ALL_KEYS.map((k) => {
            const on = selectedKeys.includes(k.label)
            const viaCompat = !on && implied.includes(k.label)
            const n = keyCounts.get(k.label) ?? 0
            return (
              <button key={k.label} onClick={() => setFilter({ keys: toggle(filter.keys, k.label) })}
                      title={`${k.label} (${k.camelot}) · ${n} samples`}
                      className={cx('h-9 rounded-md flex flex-col items-center justify-center leading-none',
                        on ? 'bg-brand text-on-accent' : viaCompat ? 'bg-accent-soft text-accent'
                          : n ? 'bg-panel-2 text-text hover:bg-raised' : 'bg-panel-2 text-faint/60 hover:bg-raised')}>
                <span className="text-[12px] font-medium">{k.label}</span>
                <span className={cx('text-[9.5px] mt-0.5', on ? 'text-on-accent/75' : 'text-faint')}>{k.camelot}</span>
              </button>
            )
          })}
        </div>
        {keyCounts.has('NoKey') && (
          <button onClick={() => setFilter({ keys: toggle(filter.keys, 'NoKey') })}
                  className={cx('mt-1 w-full h-7 rounded-md text-[12px]',
                    selectedKeys.includes('NoKey') ? 'bg-brand text-on-accent' : 'bg-panel-2 text-muted hover:bg-raised')}>
            No key ({keyCounts.get('NoKey')})
          </button>
        )}
      </div>

      {filter.kind !== 'oneshot' && facets.bars.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-faint mb-2">Length</div>
          <div className="flex flex-wrap gap-1">
            {facets.bars.map((b) => (
              <button key={b} onClick={() => setFilter({ bars: toggle(filter.bars, b) })}
                      className={cx('h-7 px-2.5 rounded-md',
                        filter.bars?.includes(b) ? 'bg-brand text-on-accent' : 'bg-panel-2 text-muted hover:bg-raised')}>
                {b} bar{b === 1 ? '' : 's'}
              </button>
            ))}
          </div>
        </div>
      )}

      {facets.zips.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-faint mb-2">Source zip</div>
          <div className="space-y-0.5">
            {facets.zips.map((z) => {
              const on = filter.zipIds?.includes(z.id)
              return (
                <button key={z.id} onClick={() => setFilter({ zipIds: toggle(filter.zipIds, z.id) })}
                        title={z.file_name}
                        className={cx('w-full flex items-center gap-2 px-2 h-7 rounded-md text-left',
                          on ? 'bg-accent-soft text-accent' : 'text-muted hover:text-text hover:bg-panel-2')}>
                  <span className="font-mono text-[11px] shrink-0">{z.source_code}</span>
                  <span className="truncate flex-1">{z.file_name.replace(/\.zip$/i, '')}</span>
                  <span className="text-faint text-[11px]">{z.count}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </aside>
  )
}
