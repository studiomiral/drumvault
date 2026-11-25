import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { api } from '../api'
import { audition } from '../audio/audition'
import { IconDrop, IconPlay, IconStop, IconX } from '../components/icons'
import { PageTabs } from '../components/PageTabs'
import { Button, cx, Empty, inputClass } from '../components/ui'
import { loopName, MUSIC_CHANCE, MUSIC_MAX_BPM, MUSIC_MAX_SHIFT } from '../generate/musicloops'
import { attempt, useApp } from '../store/app'
import { loadMusicLoops, useMusicLoops } from '../store/musicloops'
import type { MusicLoopMeta } from '../types/api'

/** Audition ids for the page's loops (apart from the library's samples, hits and vocal loops). */
const playId = (i: number) => -1_800_000_000 - i

/**
 * Sounds → Music Loops (SCOPE.md §6.11b): loops of music (chords, keys, guitars, a riff) some new
 * house tracks play in place of the chord stabs, never as recorded: always moved 1–3 semitones
 * into the track key and coloured (EQ and saturation). Once a track with one is exported it is
 * used and never offered again, unless set free here.
 */
export function MusicLoopsView() {
  const { libraryVersion, engine, toast } = useApp()
  const loops = useMusicLoops((s) => s.loops)
  const loaded = useMusicLoops((s) => s.loaded)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [playing, setPlaying] = useState<number | null>(audition.playingId)
  useEffect(() => audition.subscribe(setPlaying), [])

  useEffect(() => {
    void loadMusicLoops()
  }, [libraryVersion])

  const add = useCallback(async (paths: string[]) => {
    if (!paths.length) return
    setBusy(true)
    const r = await attempt(() => api.importMusicLoops(paths))
    setBusy(false)
    if (!r) return
    void loadMusicLoops()
    const n = r.imported.length
    const parts = [n ? `Added ${n} music ${n === 1 ? 'loop' : 'loops'}` : 'No new music loops']
    const keyless = r.imported.filter((x) => !x.key).length
    if (keyless) parts.push(`${keyless} without a key (never played)`)
    if (r.skipped) parts.push(`${r.skipped} already in`)
    if (r.failed.length) parts.push(`${r.failed.length} not added: ${r.failed.slice(0, 2).join('; ')}`)
    toast(r.failed.length && !n ? 'error' : 'info', `${parts.join(', ')}.`)
  }, [toast])

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    await add(api.pathsForFiles([...e.dataTransfer.files]))
  }
  const remove = async (l: MusicLoopMeta) => {
    if (!window.confirm(`Remove "${loopName(l)}" from the music loops? Tracks that play it will miss it.`)) return
    await attempt(() => api.deleteMusicLoop(l.id))
    void loadMusicLoops()
  }
  const free = async (l: MusicLoopMeta) => {
    if (!window.confirm(`Offer "${loopName(l)}" to new tracks again? It went out in ${l.usedIn.join(', ')}.`)) return
    await attempt(() => api.unuseMusicLoop(l.id))
    void loadMusicLoops()
  }

  const q = search.trim().toLowerCase()
  const shown = [...loops].reverse().filter((l) => !q || loopName(l).toLowerCase().includes(q) || (l.key ?? '').toLowerCase() === q)
  const ready = engine.state === 'ready'
  const fresh = loops.filter((l) => !l.usedIn.length).length
  const choose = () => void api.chooseHits('Add music loops').then(add)

  return (
    <div className="flex-1 min-h-0 flex flex-col relative"
         onDragOver={(e) => {
           e.preventDefault()
           if (!dragging) setDragging(true)
         }}
         onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
         onDrop={(e) => void onDrop(e)}>
      <header className="app-drag topbar-art h-14 shrink-0 flex items-center gap-4 px-6 border-b border-line">
        <PageTabs view="musicloops" />
        <span className="text-faint text-[12px] tabular-nums">{loaded ? `${loops.length} ${loops.length === 1 ? 'loop' : 'loops'}, ${fresh} not used yet` : ''}</span>
        <input className={cx(inputClass, 'w-56')} placeholder="Search loops or a key" value={search}
               onChange={(e) => setSearch(e.target.value)} />
        <div className="flex-1" />
        <Button variant="primary" disabled={!ready || busy} onClick={choose}>Add music loops…</Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
        <button disabled={!ready || busy} onClick={choose}
                className={cx('w-full rounded-2xl border border-dashed px-6 py-6 flex items-center gap-4 text-left transition-colors',
                  dragging ? 'border-accent bg-accent-soft' : 'border-[#3e3f44] bg-panel-2 hover:border-accent/60')}>
          <span className="w-12 h-12 rounded-full bg-raised flex items-center justify-center text-text shrink-0">
            <IconDrop className="w-6 h-6" />
          </span>
          <span>
            <span className="block text-text font-medium">{busy ? 'Importing… (each loop is cut and its key read: a moment)' : 'Drop music loops: audio files or folders'}</span>
            <span className="block mt-1 text-[12px] text-muted">
              Chord, keys, guitar or synth loops, cut to their whole bars (the tempo from the name, else from the length; the key from the name, else
              heard). With the Music Loops module on, {Math.round(MUSIC_CHANCE * 100)} % of new house tracks without a piano play one in place of the
              chord stabs: within {MUSIC_MAX_BPM} BPM of their tempo, and never as recorded: always moved 1–{MUSIC_MAX_SHIFT} semitones into the
              track key (a track in the loop's own key doesn't get it) and coloured with an EQ and saturation of its own. Once a track with it is
              exported, it's used: never offered again.
            </span>
          </span>
        </button>

        {loaded && !loops.length ? (
          <Empty title="No music loops yet">Drop music loops here.</Empty>
        ) : (
          <div className="rounded-xl border border-line bg-panel-2 divide-y divide-line">
            {shown.map((l) => {
              const sid = playId(loops.indexOf(l))
              return (
                <div key={l.id} className="min-h-12 px-4 py-2 flex items-center gap-4 text-[12.5px]">
                  <button className="w-7 h-7 rounded-full bg-raised hover:bg-[#3a3b3f] flex items-center justify-center text-accent shrink-0"
                          title="Play it as it was recorded (tracks never play it so)"
                          onClick={() => audition.toggle({ id: sid, rel_path: l.loop, kind: 'oneshot' })}>
                    {playing === sid ? <IconStop className="w-3.5 h-3.5" /> : <IconPlay className="w-3.5 h-3.5" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{loopName(l)}</div>
                    <div className="text-[11px] text-faint truncate">
                      {l.key ? `${l.key}${l.keySource === 'heard' ? ' (heard)' : ''}` : 'no key: never played'}
                      {' · '}{l.bpm} BPM{l.tempoSource === 'length' ? ' (from its length)' : ''} · {l.bars} bar{l.bars === 1 ? '' : 's'}
                    </div>
                  </div>
                  {l.usedIn.length ? (
                    <span className="flex items-center gap-2 shrink-0 text-[12px]">
                      <span className="text-muted" title={l.usedIn.join(', ')}>Used in {l.usedIn[l.usedIn.length - 1]}</span>
                      <Button variant="ghost" onClick={() => void free(l)} title="Offer it to new tracks again (an export thrown away)">Offer again</Button>
                    </span>
                  ) : (
                    <span className="text-[12px] text-faint shrink-0">Not used</span>
                  )}
                  <button title="Remove from the music loops" className="text-faint hover:text-bad" onClick={() => void remove(l)}>
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
