import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { forgetPeaks } from '../arrange/peaks'
import { audition } from '../audio/audition'
import { buffers } from '../audio/context'
import { forgetTempo } from '../audio/tempo'
import { IconPlay, IconStar, IconStop, IconTrash } from '../components/icons'
import { Button, cx, Empty, inputClass, PageTitle, Segmented } from '../components/ui'
import { VirtualList } from '../components/VirtualList'
import { forgetWaveform, Waveform } from '../components/Waveform'
import { ALL_KEYS, expandCompatible } from '../lib/camelot'
import { CATEGORY_LABELS, EVENT_CATEGORIES, formatBpm, formatDuration, KIND_LABELS, KIND_PASTEL, lengthLabel } from '../lib/format'
import { attempt, useApp } from '../store/app'
import { useLibrary } from '../store/library'
import type { LibraryFacets, RemovedSample, SampleListItem, SampleSort } from '../types/api'
import type { Category, SampleKind } from '../types/engine'

const ROW = 46

// Moves run one after another: each rewrites the sample file the next one reads.
let shiftQueue: Promise<unknown> = Promise.resolve()
const shiftListeners = new Set<(id: number, shift: number) => void>()

/** Library "Move sound": rotate a loop/fill/FX a beat inside itself (the file changes). */
function moveSound(s: SampleListItem, beats: number): void {
  if (s.kind === 'oneshot') return
  shiftQueue = shiftQueue.then(async () => {
    const wasPlaying = audition.playingId === s.id
    const shift = await attempt(() => api.shiftSample(s.id, beats))
    if (shift == null) return
    buffers.forget(s.rel_path)
    forgetTempo(s.rel_path)
    forgetWaveform(s.id)
    forgetPeaks(s.rel_path)
    for (const fn of shiftListeners) fn(s.id, shift)
    if (wasPlaying) void audition.play(s)
  })
}
const ONESHOT_ORDER: Category[] = ['kick', 'snare', 'clap', 'hat_closed', 'hat_open', 'ride', 'cymbal', 'shaker', 'perc']
const LOOP_ORDER: Category[] = ['snare', 'clap', 'hat', 'hat_closed', 'hat_open', 'ride', 'shaker', 'perc', 'top', 'groove', 'drums']
const ORDER: Record<SampleKind, Category[]> = { oneshot: ONESHOT_ORDER, loop: LOOP_ORDER, event: EVENT_CATEGORIES }

export function LibraryView() {
  const { libraryVersion } = useApp()
  const { filter, setFilter, resetFilter, selectedId, select, similarTo, findSimilar, showDeleted, setShowDeleted } = useLibrary()
  const [removed, setRemoved] = useState<RemovedSample[]>([])
  const [items, setItems] = useState<SampleListItem[]>([])
  const [facets, setFacets] = useState<LibraryFacets | null>(null)
  const [playingId, setPlayingId] = useState<number | null>(audition.playingId)
  const [loaded, setLoaded] = useState(false)
  // ⌘/⇧-click selection of several rows (to delete them together); empty = just `selectedId`.
  const [marked, setMarked] = useState<Set<number>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => audition.subscribe(setPlayingId), [])
  useEffect(() => () => audition.stop(), [])

  useEffect(() => {
    void api.facets().then(setFacets)
    void api.listRemoved().then(setRemoved)
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

  // Marks only cover rows in the current list.
  useEffect(() => {
    setMarked((m) => {
      if (!m.size) return m
      const ids = new Set(items.map((s) => s.id))
      const kept = new Set([...m].filter((id) => ids.has(id)))
      return kept.size === m.size ? m : kept
    })
  }, [items])
  const targets = useMemo(() => (marked.size ? items.filter((s) => marked.has(s.id)) : selected ? [selected] : []),
    [marked, items, selected])

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
    setMarked((m) => (m.size ? new Set() : m))
    if (play) void audition.play(s).catch((e) => useApp.getState().toast('error', `Could not play: ${e.message}`))
  }, [select])

  /** Click: select and play. ⌘-click: add/remove a row. ⇧-click: select the range from the current row. */
  const clickRow = (i: number, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
    const s = items[i]
    if (e.metaKey || e.ctrlKey) {
      const m = new Set(marked.size ? marked : selected ? [selected.id] : [])
      if (m.has(s.id)) m.delete(s.id)
      else m.add(s.id)
      setMarked(m)
      select(s.id)
    } else if (e.shiftKey && index >= 0) {
      const [a, b] = index < i ? [index, i] : [i, index]
      setMarked(new Set(items.slice(a, b + 1).map((x) => x.id)))
    } else {
      choose(s)
    }
  }

  const deleteSamples = useCallback(async () => {
    if (!targets.length) return
    const ids = new Set(targets.map((s) => s.id))
    if (audition.playingId != null && ids.has(audition.playingId)) audition.stop()
    const last = Math.max(...targets.map((s) => items.indexOf(s)))
    const next = items.slice(last + 1).find((s) => !ids.has(s.id)) ?? [...items].reverse().find((s) => !ids.has(s.id))
    const deleted = await attempt(() => api.deleteSamples([...ids]))
    if (deleted == null) return
    setMarked(new Set())
    select(next?.id ?? null)
    useApp.getState().toast('info', `Deleted ${deleted} sample${deleted === 1 ? '' : 's'}. Bring ${deleted === 1 ? 'it' : 'them'} back under Deleted.`)
  }, [targets, items, select])

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
      if (useLibrary.getState().showDeleted) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setMarked(new Set(items.map((s) => s.id)))
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        void deleteSamples()
      } else if (e.key === ' ') {
        e.preventDefault()
        if (selected) audition.toggle(selected)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (!items.length) return
        const next = index < 0 ? 0 : Math.max(0, Math.min(items.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))
        choose(items[next])
      } else if (e.key === 'Escape') {
        audition.stop()
        setMarked(new Set())
      } else if (selected && e.key.toLowerCase() === 'f' && !e.metaKey && !e.ctrlKey) {
        toggleFavorite(selected)
      } else if (selected && /^[1-5]$/.test(e.key)) {
        setRating(selected, Number(e.key))
      } else if (selected && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        moveSound(selected, e.key === 'ArrowLeft' ? -1 : 1)
      } else if (selected && e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey) {
        findSimilar({ id: selected.id, name: selected.name })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, index, selected, choose, toggleFavorite, setRating, findSimilar, deleteSamples])

  const filtered = !!(filter.kind || filter.categories?.length || filter.keys?.length || filter.bars?.length
    || filter.zipIds?.length || filter.favoritesOnly || filter.search)

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="app-drag topbar-art h-14 shrink-0 flex items-center gap-4 px-6 border-b border-line">
        <PageTitle className="mr-3">Library</PageTitle>
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
        <button onClick={() => setShowDeleted(!showDeleted)} title="Samples you deleted, to bring them back"
                className={cx('flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[12px]',
                  showDeleted ? 'border-accent text-accent bg-accent-soft' : 'border-line text-muted hover:text-text')}>
          <IconTrash className="w-3.5 h-3.5" /> Deleted{removed.length > 0 && <span className="tabular-nums">{removed.length}</span>}
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

      {showDeleted ? <DeletedList rows={removed} onBack={() => setShowDeleted(false)} /> : (
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
                  selected={marked.size ? marked.has(items[i].id) : items[i].id === selectedId}
                  playing={items[i].id === playingId}
                  onClick={(e) => clickRow(i, e)}
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
          {marked.size > 1 ? (
            <div className="h-12 shrink-0 border-t border-line bg-panel flex items-center gap-3 px-4 text-[12px]">
              <span className="font-medium">{marked.size} samples selected</span>
              <span className="text-faint">⌘-click to add or remove, ⇧-click for a range</span>
              <div className="flex-1" />
              <Button variant="ghost" onClick={() => setMarked(new Set())}>Clear selection</Button>
              <Button variant="danger" title="Delete from the library (⌫)" onClick={() => void deleteSamples()}>Delete {marked.size}</Button>
            </div>
          ) : selected && <SelectedBar s={selected} onSimilar={() => findSimilar({ id: selected.id, name: selected.name })} onTags={(tags) => {
            updateLocal(selected.id, { tags: tags || null })
            void attempt(() => api.setSampleMeta(selected.id, { tags }))
          }} onDelete={() => void deleteSamples()} />}
        </div>
      </div>
      )}
    </div>
  )
}

/** Library → Deleted: samples deleted from the library, to listen to and restore. */
function DeletedList({ rows, onBack }: { rows: RemovedSample[]; onBack: () => void }) {
  const [marked, setMarked] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [playingId, setPlayingId] = useState<number | null>(audition.playingId)
  useEffect(() => audition.subscribe(setPlayingId), [])
  useEffect(() => {
    const ids = new Set(rows.map((r) => r.id))
    setMarked((m) => new Set([...m].filter((id) => ids.has(id))))
  }, [rows])

  // Audition ids are negative so they never clash with library sample ids.
  const play = (r: RemovedSample) => r.trash_path
    && audition.toggle({ id: -r.id, rel_path: r.trash_path, kind: r.kind, bars: r.bars })

  const click = (i: number, e: React.MouseEvent) => {
    const r = rows[i]
    if (e.shiftKey && anchor != null) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor]
      setMarked(new Set(rows.slice(a, b + 1).map((x) => x.id)))
      return
    }
    setAnchor(i)
    if (e.metaKey || e.ctrlKey) {
      const m = new Set(marked)
      if (m.has(r.id)) m.delete(r.id)
      else m.add(r.id)
      setMarked(m)
    } else {
      setMarked(new Set([r.id]))
      play(r)
    }
  }

  const restore = async (ids: number[]) => {
    if (!ids.length) return
    if (audition.playingId != null && ids.includes(-audition.playingId)) audition.stop()
    const r = await attempt(() => api.restoreSamples(ids))
    if (!r) return
    setMarked(new Set())
    const parts = [r.restored && `Restored ${r.restored} sample${r.restored === 1 ? '' : 's'}.`,
      r.pending && `${r.pending} had no saved file and come${r.pending === 1 ? 's' : ''} back when the zip is reprocessed.`]
    useApp.getState().toast('info', parts.filter(Boolean).join(' '))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setMarked(new Set(rows.map((r) => r.id)))
      } else if (e.key === 'Escape') {
        if (marked.size) setMarked(new Set())
        else onBack()
        audition.stop()
      } else if (e.key === 'Enter' && marked.size) {
        void restore([...marked])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-3 px-6 h-11 border-b border-line text-[12.5px]">
        <span className="font-medium">Deleted samples</span>
        <span className="text-faint">Kept out of the library, also when their zip is reprocessed. Restore puts them back.</span>
        <div className="flex-1" />
        <Button variant="ghost" onClick={onBack}>Back to the library</Button>
      </div>
      {rows.length === 0 ? (
        <Empty title="Nothing deleted">Samples you delete in the library (⌫) show up here, so you can bring them back.</Empty>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {rows.map((r, i) => (
            <div key={r.id} onMouseDown={(e) => e.button === 0 && !(e.target as HTMLElement).closest('button') && click(i, e)}
                 className={cx('flex items-center gap-3 px-6 border-b border-line/60 cursor-default select-none',
                   marked.has(r.id) ? 'bg-brand-soft' : 'hover:bg-panel')}
                 style={{ height: ROW }}>
              <button disabled={!r.trash_path} onClick={() => play(r)}
                      className={cx('w-7 h-7 rounded-full flex items-center justify-center shrink-0 disabled:opacity-30',
                        playingId === -r.id ? 'bg-brand text-on-accent' : 'text-muted hover:text-accent hover:bg-raised')}>
                {playingId === -r.id ? <IconStop className="w-3.5 h-3.5" /> : <IconPlay className="w-3.5 h-3.5" />}
              </button>
              <div className="flex-1 min-w-0">
                <div className="truncate text-[12.5px]">{r.name}</div>
                <div className="text-[11px] text-faint truncate">
                  {r.source_code}
                  {r.removed_at && ` · deleted ${new Date(r.removed_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`}
                  {!r.trash_path && ' · no saved file: comes back when the zip is reprocessed'}
                </div>
              </div>
              {r.category && (
                <span className={cx('w-[92px] inline-flex items-center justify-center rounded-md h-[18px] text-[11px] font-medium text-on-pastel whitespace-nowrap',
                  KIND_PASTEL[r.kind])}>{CATEGORY_LABELS[r.category]}</span>
              )}
              <span className="w-[74px] text-[12px]">
                {r.key_label ?? <span className="text-faint">NoKey</span>}
                {r.key_camelot && <span className="text-faint ml-1.5">{r.key_camelot}</span>}
              </span>
              <span className="w-[64px] text-[12px] text-muted">
                {r.kind === 'oneshot' ? (r.duration_s != null ? formatDuration(r.duration_s) : '') : r.bars ? `${r.bars} bar${r.bars === 1 ? '' : 's'}` : ''}
              </span>
              <Button variant="ghost" onClick={() => void restore([r.id])}>Restore</Button>
            </div>
          ))}
        </div>
      )}
      {marked.size > 1 && (
        <div className="h-12 shrink-0 border-t border-line bg-panel flex items-center gap-3 px-4 text-[12px]">
          <span className="font-medium">{marked.size} selected</span>
          <span className="text-faint">⌘-click to add or remove, ⇧-click for a range</span>
          <div className="flex-1" />
          <Button variant="ghost" onClick={() => setMarked(new Set())}>Clear selection</Button>
          <Button variant="primary" onClick={() => void restore([...marked])}>Restore {marked.size}</Button>
        </div>
      )}
    </div>
  )
}

function SampleRow({ s, selected, playing, onClick, onPlayToggle, onFavorite, onRate }: {
  s: SampleListItem
  selected: boolean
  playing: boolean
  onClick: (e: React.MouseEvent) => void
  onPlayToggle: () => void
  onFavorite: () => void
  onRate: (r: number) => void
}) {
  return (
    <div
      onMouseDown={(e) => e.button === 0 && !(e.target as HTMLElement).closest('button') && onClick(e)}
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
      <span className={cx('w-[92px] inline-flex items-center justify-center rounded-md h-[18px] text-[11px] font-medium text-on-pastel whitespace-nowrap',
        KIND_PASTEL[s.kind])}>{CATEGORY_LABELS[s.category]}</span>
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

function SelectedBar({ s, onTags, onSimilar, onDelete }: {
  s: SampleListItem
  onTags: (tags: string) => void
  onSimilar: () => void
  onDelete: () => void
}) {
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
      {s.kind !== 'oneshot' && <MoveSound s={s} />}
      <Button variant="ghost" title="Find similar sounds (S)" onClick={onSimilar}>Find similar</Button>
      <Button variant="ghost" onClick={() => void api.revealSample(s.rel_path)}>Reveal in Finder</Button>
      <Button variant="ghost" className="hover:!text-bad" title="Delete from the library (⌫)" onClick={onDelete}>Delete</Button>
    </div>
  )
}

/** −1 / +1 beat for the selected loop, fill or FX, with how far it is moved now. */
function MoveSound({ s }: { s: SampleListItem }) {
  const [shift, setShift] = useState(0)
  useEffect(() => {
    let alive = true
    void api.sampleShift(s.id).then((v) => alive && setShift(v))
    const fn = (id: number, v: number) => id === s.id && setShift(v)
    shiftListeners.add(fn)
    return () => {
      alive = false
      shiftListeners.delete(fn)
    }
  }, [s.id])
  const L = (s.bars ?? 1) * 4
  const signed = shift > L / 2 ? shift - L : shift
  return (
    <span className="flex items-center gap-1 text-muted"
          title="Move the sound a beat earlier or later inside the sample; what falls off one end comes back at the other (← / →)">
      Move sound
      <Button variant="ghost" className="px-1.5" onClick={() => moveSound(s, -1)}>−1</Button>
      <Button variant="ghost" className="px-1.5" onClick={() => moveSound(s, 1)}>+1</Button>
      <span className="w-14 tabular-nums">{signed ? `${signed > 0 ? '+' : '−'}${Math.abs(signed)} beat${Math.abs(signed) === 1 ? '' : 's'}` : ''}</span>
    </span>
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
