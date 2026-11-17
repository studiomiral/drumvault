import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { api } from '../api'
import { audition } from '../audio/audition'
import { IconDrop, IconPlay, IconStop, IconX } from '../components/icons'
import { PageTabs } from '../components/PageTabs'
import { Button, cx, Empty, inputClass } from '../components/ui'
import { LOOP_MAX_BPM, LOOP_MAX_SHIFT } from '../generate/vocals'
import { attempt, useApp } from '../store/app'
import { loadVocals, useVocals } from '../store/vocals'
import { takeName, type VocalMeta } from '../vocals/plan'

/** Audition ids for the page's loops (apart from the library's samples and hits). */
const playId = (i: number) => -1_700_000_000 - i

/**
 * Sounds → Vocal Loops (SCOPE.md §6.11a): vocal loops and phrases from Splice, made into takes
 * Generate can sing (their phrase loop and chops). The Vocal Loops module in Create gives some new
 * tracks one that fits their key and tempo; once a track with it is exported it is used and never
 * offered again (House of Tracks takes each vocal once), unless set free here.
 */
export function VocalLoopsView() {
  const { libraryVersion, engine, toast, setView } = useApp()
  const all = useVocals((s) => s.vocals)
  const loaded = useVocals((s) => s.loaded)
  const loops = all.filter((v) => v.source === 'splice')
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [playing, setPlaying] = useState<number | null>(audition.playingId)
  useEffect(() => audition.subscribe(setPlaying), [])

  useEffect(() => {
    void loadVocals()
  }, [libraryVersion])

  const add = useCallback(async (paths: string[]) => {
    if (!paths.length) return
    setBusy(true)
    const r = await attempt(() => api.importVocalLoops(paths))
    setBusy(false)
    if (!r) return
    void loadVocals()
    const n = r.imported.length
    const parts = [n ? `Added ${n} vocal ${n === 1 ? 'loop' : 'loops'}` : 'No new vocal loops']
    const unlinked = r.imported.filter((x) => !x.url).length
    if (unlinked) parts.push(`${unlinked} without a Splice link (set it below)`)
    if (r.skipped) parts.push(`${r.skipped} already in`)
    if (r.failed.length) parts.push(`${r.failed.length} not added: ${r.failed.slice(0, 2).join('; ')}`)
    toast(r.failed.length && !n ? 'error' : 'info', `${parts.join(', ')}.`)
  }, [toast])

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    await add(api.pathsForFiles([...e.dataTransfer.files]))
  }
  const remove = async (v: VocalMeta) => {
    if (!window.confirm(`Remove "${takeName(v)}" from the vocal loops? Tracks that sing it will miss it.`)) return
    await attempt(() => api.deleteVocal(v.id))
    void loadVocals()
  }
  const free = async (v: VocalMeta) => {
    if (!window.confirm(`Offer "${takeName(v)}" to new tracks again? It went out in ${v.usedIn.join(', ')}: House of Tracks takes each vocal only once.`)) return
    await attempt(() => api.unuseVocal(v.id))
    void loadVocals()
  }
  const saveUrl = async (v: VocalMeta) => {
    const u = url.trim()
    if (u && !/^https:\/\/(www\.)?splice\.com\//.test(u)) {
      toast('error', 'That isn\'t a splice.com link.')
      return
    }
    await attempt(() => api.setVocalUrl(v.id, u || null))
    setEditing(null)
    void loadVocals()
  }

  const q = search.trim().toLowerCase()
  const shown = [...loops].reverse().filter((v) => !q || takeName(v).toLowerCase().includes(q)
    || (v.splice?.pack ?? '').toLowerCase().includes(q) || (v.analysis?.key ?? v.key ?? '').toLowerCase() === q)
  const ready = engine.state === 'ready'
  const fresh = loops.filter((v) => !v.usedIn.length).length

  return (
    <div className="flex-1 min-h-0 flex flex-col relative"
         onDragOver={(e) => {
           e.preventDefault()
           if (!dragging) setDragging(true)
         }}
         onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
         onDrop={(e) => void onDrop(e)}>
      <header className="app-drag topbar-art h-14 shrink-0 flex items-center gap-4 px-6 border-b border-line">
        <PageTabs view="vocalloops" />
        <span className="text-faint text-[12px] tabular-nums">{loaded ? `${loops.length} ${loops.length === 1 ? 'loop' : 'loops'}, ${fresh} not used yet` : ''}</span>
        <input className={cx(inputClass, 'w-56')} placeholder="Search loops, packs or a key" value={search}
               onChange={(e) => setSearch(e.target.value)} />
        <div className="flex-1" />
        <Button variant="ghost" onClick={() => setView('splice')} title="Vocal loops and phrases in your Splice folder">From Splice…</Button>
        <Button variant="primary" disabled={!ready || busy} onClick={() => void api.chooseHits('Add vocal loops').then(add)}>Add vocal loops…</Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
        <button disabled={!ready || busy} onClick={() => void api.chooseHits('Add vocal loops').then(add)}
                className={cx('w-full rounded-2xl border border-dashed px-6 py-6 flex items-center gap-4 text-left transition-colors',
                  dragging ? 'border-accent bg-accent-soft' : 'border-[#3e3f44] bg-panel-2 hover:border-accent/60')}>
          <span className="w-12 h-12 rounded-full bg-raised flex items-center justify-center text-text shrink-0">
            <IconDrop className="w-6 h-6" />
          </span>
          <span>
            <span className="block text-text font-medium">{busy ? 'Importing… (each loop is analysed: a few seconds)' : 'Drop vocal loops and phrases: audio files or folders'}</span>
            <span className="block mt-1 text-[12px] text-muted">
              Vocal loops and phrases from Splice, made into a phrase loop and chops like a made vocal. With the Vocal Loops module on,
              some new tracks sing one within {LOOP_MAX_SHIFT} semitones of their key and {LOOP_MAX_BPM} BPM of their tempo, where and as loud
              as your own tracks sing. Once a track with it is exported, it's used: never offered again. Its pack and link go into the export's info.txt.
            </span>
          </span>
        </button>

        {loaded && !loops.length ? (
          <Empty title="No vocal loops yet">Drop Splice vocal loops here, or add them from the Splice page.</Empty>
        ) : (
          <div className="rounded-xl border border-line bg-panel-2 divide-y divide-line">
            {shown.map((v) => {
              const phrase = v.analysis?.phrases[0]
              const sid = playId(loops.indexOf(v))
              const key = v.analysis?.key ?? v.key
              return (
                <div key={v.id} className="min-h-12 px-4 py-2 flex items-center gap-4 text-[12.5px]">
                  <button className="w-7 h-7 rounded-full bg-raised hover:bg-[#3a3b3f] flex items-center justify-center text-accent shrink-0 disabled:opacity-40"
                          title={phrase ? `Play its ${phrase.bars}-bar phrase` : 'Play it'} disabled={!v.vocal}
                          onClick={() => audition.toggle(phrase ? { id: sid, rel_path: phrase.path, kind: 'loop', bars: phrase.bars } : { id: sid, rel_path: v.vocal!, kind: 'oneshot' })}>
                    {playing === sid ? <IconStop className="w-3.5 h-3.5" /> : <IconPlay className="w-3.5 h-3.5" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{takeName(v)}</div>
                    <div className="text-[11px] text-faint truncate">
                      {key ?? 'no key'} · {v.splice?.bpm ? `${v.splice.bpm} BPM` : 'a phrase, no tempo'}
                      {phrase ? ` · ${phrase.bars}-bar phrase` : ' · no phrase loop'} · {v.analysis?.chops.length ?? 0} chops
                      {' · '}{v.splice?.pack ?? 'not in Splice\'s records'}{v.splice?.label ? ` (${v.splice.label})` : ''}
                    </div>
                    {editing === v.id ? (
                      <div className="mt-1.5 flex items-center gap-2">
                        <input className={cx(inputClass, 'flex-1 h-7 text-[12px]')} autoFocus value={url} placeholder="https://splice.com/sounds/packs/…"
                               onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void saveUrl(v)} />
                        <Button variant="secondary" onClick={() => void saveUrl(v)}>Save</Button>
                        <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                      </div>
                    ) : (
                      <div className="text-[11px] truncate">
                        {v.splice?.url
                          ? <button className="text-accent hover:underline" onClick={() => void api.openSplice(v.splice!.url!)}>{v.splice.url.replace(/^https:\/\//, '')}</button>
                          : <span className="text-bad">No Splice link</span>}
                        <button className="ml-2 text-faint hover:text-text" onClick={() => { setUrl(v.splice?.url ?? ''); setEditing(v.id) }}>
                          {v.splice?.url ? 'edit' : 'set link'}
                        </button>
                      </div>
                    )}
                  </div>
                  {v.usedIn.length ? (
                    <span className="flex items-center gap-2 shrink-0 text-[12px]">
                      <span className="text-muted" title={v.usedIn.join(', ')}>Used in {v.usedIn[v.usedIn.length - 1]}</span>
                      <Button variant="ghost" onClick={() => void free(v)} title="Offer it to new tracks again (an export thrown away)">Offer again</Button>
                    </span>
                  ) : (
                    <span className="text-[12px] text-faint shrink-0">Not used</span>
                  )}
                  <button title="Remove from the vocal loops" className="text-faint hover:text-bad" onClick={() => void remove(v)}>
                    <IconX className="w-4 h-4" />
                  </button>
                </div>
              )
            })}
            {!shown.length && <div className="px-4 py-6 text-[12.5px] text-faint">Nothing matches.</div>}
          </div>
        )}
      </div>
    </div>
  )
}
