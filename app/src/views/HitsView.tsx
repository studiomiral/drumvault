import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { api } from '../api'
import { audition } from '../audio/audition'
import { IconDrop, IconPlay, IconStop, IconX } from '../components/icons'
import { Button, cx, Empty, inputClass, PageTitle } from '../components/ui'
import { hitSampleId } from '../generate/disco'
import { ALL_KEYS } from '../lib/camelot'
import { attempt, useApp } from '../store/app'
import { loadHits, useHits } from '../store/hits'
import type { HitItem } from '../types/api'

const SOURCE_LABEL: Record<NonNullable<HitItem['key_source']>, string> = {
  name: 'key from the name', detected: 'key from the sound', manual: 'key set by you',
}

/**
 * Samples → Disco Hits (SCOPE.md §6.8): stabs, brass hits and the like. Generate drops one or
 * two of them on the 1 at key moments of some tracks, moved into the track key.
 */
export function HitsView() {
  const { libraryVersion, engine, toast } = useApp()
  const { hits, loaded } = useHits()
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [playing, setPlaying] = useState<number | null>(audition.playingId)
  useEffect(() => audition.subscribe(setPlaying), [])

  useEffect(() => {
    void loadHits()
  }, [libraryVersion])

  const add = useCallback(async (paths: string[]) => {
    if (!paths.length) return
    setBusy(true)
    const r = await attempt(() => api.importHits(paths))
    setBusy(false)
    if (!r) return
    void loadHits()
    const parts: string[] = []
    const n = r.imported.length
    parts.push(n ? `Added ${n} disco hit${n === 1 ? '' : 's'}` : 'No new disco hits')
    const detected = r.imported.filter((h) => h.key_source === 'detected').length
    if (detected) parts.push(`${detected} with the key from the sound (check those)`)
    const none = r.imported.filter((h) => !h.key_label).length
    if (none) parts.push(`${none} without a key`)
    if (r.skipped) parts.push(`${r.skipped} already in`)
    if (r.failed.length) parts.push(`${r.failed.length} unreadable: ${r.failed.slice(0, 2).join('; ')}`)
    if (r.warnings.length) parts.push(r.warnings[0])
    toast(r.failed.length && !n ? 'error' : 'info', `${parts.join(', ')}.`)
  }, [toast])

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    await add(api.pathsForFiles([...e.dataTransfer.files]))
  }
  const setKey = async (h: HitItem, key: string) => {
    await attempt(() => api.setHitKey(h.id, key || null))
    void loadHits()
  }
  const remove = async (h: HitItem) => {
    if (!window.confirm(`Remove "${h.name}" from the disco hits? Projects that use it will miss it.`)) return
    await attempt(() => api.deleteHits([h.id]))
    void loadHits()
  }

  const q = search.trim().toLowerCase()
  const shown = [...hits].reverse().filter((h) => !q || h.name.toLowerCase().includes(q) || (h.key_label ?? '').toLowerCase() === q)
  const ready = engine.state === 'ready'

  return (
    <div className="flex-1 min-h-0 flex flex-col relative"
         onDragOver={(e) => {
           e.preventDefault()
           if (!dragging) setDragging(true)
         }}
         onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
         onDrop={(e) => void onDrop(e)}>
      <header className="app-drag topbar-art h-14 shrink-0 flex items-center gap-4 px-6 border-b border-line">
        <PageTitle className="mr-3">Disco Hits</PageTitle>
        <span className="text-faint text-[12px] tabular-nums">{loaded ? `${hits.length} hit${hits.length === 1 ? '' : 's'}` : ''}</span>
        <input className={cx(inputClass, 'w-56')} placeholder="Search disco hits" value={search}
               onChange={(e) => setSearch(e.target.value)} />
        <div className="flex-1" />
        <Button variant="primary" disabled={!ready || busy} onClick={() => void api.chooseHits().then(add)}>Add disco hits…</Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
        <button disabled={!ready || busy} onClick={() => void api.chooseHits().then(add)}
                className={cx('w-full rounded-2xl border border-dashed px-6 py-6 flex items-center gap-4 text-left transition-colors',
                  dragging ? 'border-accent bg-accent-soft' : 'border-[#3e3f44] bg-panel-2 hover:border-accent/60')}>
          <span className="w-12 h-12 rounded-full bg-raised flex items-center justify-center text-text shrink-0">
            <IconDrop className="w-6 h-6" />
          </span>
          <span>
            <span className="block text-text font-medium">{busy ? 'Importing…' : 'Drop disco hits: audio files, folders or zips'}</span>
            <span className="block mt-1 text-[12px] text-muted">
              Stabs, brass hits, orchestra hits: one hit per file, trimmed and copied into the library. The key comes from the
              file name ("Brass Stab Cm", "Hit_F#_maj"), else from the sound. Generate moves each hit into the track key; if it
              sounds off, fix the key here or the pitch in Generate.
            </span>
          </span>
        </button>

        {loaded && !hits.length ? (
          <Empty title="No disco hits yet">Drop your disco, brass and orchestra hits here.</Empty>
        ) : (
          <div className="rounded-xl border border-line bg-panel-2 divide-y divide-line">
            {shown.map((h) => {
              const sid = hitSampleId(h.id)
              return (
                <div key={h.id} className="h-12 px-4 flex items-center gap-4 text-[12.5px]">
                  <button className="w-7 h-7 rounded-full bg-raised hover:bg-[#3a3b3f] flex items-center justify-center text-accent shrink-0"
                          title="Play" onClick={() => audition.toggle({ id: sid, rel_path: h.rel_path, kind: 'oneshot' })}>
                    {playing === sid ? <IconStop className="w-3.5 h-3.5" /> : <IconPlay className="w-3.5 h-3.5" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{h.name}</div>
                    <div className="text-[11px] text-faint truncate">
                      {h.duration_s.toFixed(1)} s{h.key_source ? ` · ${SOURCE_LABEL[h.key_source]}` : ''}
                      {h.pitch_fix ? ` · pitch fixed ${h.pitch_fix > 0 ? '+' : ''}${h.pitch_fix} st` : ''}
                    </div>
                  </div>
                  <select className={cx(inputClass, 'w-36 h-7 text-[12px]', h.key_source === 'detected' && 'text-accent')}
                          value={h.key_label ?? ''} title="Key: Generate moves the hit from this key into the track's"
                          onChange={(e) => void setKey(h, e.target.value)}>
                    <option value="">No key</option>
                    {ALL_KEYS.map((k) => <option key={k.label} value={k.label}>{k.label} ({k.camelot})</option>)}
                  </select>
                  <button title="Remove from the disco hits" className="text-faint hover:text-bad" onClick={() => void remove(h)}>
                    <IconX className="w-4 h-4" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
