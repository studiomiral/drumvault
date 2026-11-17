import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { audioContext } from '../audio/context'
import { IconPlay, IconStop } from '../components/icons'
import { Button, cx, Empty, inputClass, Segmented } from '../components/ui'
import { PageTabs } from '../components/PageTabs'
import { attempt, useApp } from '../store/app'
import { loadHits } from '../store/hits'
import type { SpliceCandidate, SpliceScan } from '../types/api'

type Kind = SpliceCandidate['kind']
const PAGE: Record<Kind, string> = { stab: 'Chord Stabs', disco: 'Disco Hits', strings: 'Strings', bass: 'Bass Samples', ambience: 'Ambience' }
const KINDS: Kind[] = ['stab', 'disco', 'strings', 'bass', 'ambience']
type Filter = 'all' | Kind

/** One voice for listening to a file in the Splice folder (it isn't in the library, so not the library's audition). */
function usePreview() {
  const [playing, setPlaying] = useState<string | null>(null)
  const source = useRef<AudioBufferSourceNode | null>(null)
  const token = useRef(0)
  const stop = useCallback(() => {
    token.current++
    try { source.current?.stop() } catch { /* already stopped */ }
    source.current = null
    setPlaying(null)
  }, [])
  const toggle = useCallback(async (path: string) => {
    const was = playing
    stop()
    if (was === path) return
    const mine = ++token.current
    setPlaying(path)
    const data = await attempt(() => api.readSplice(path))
    if (!data || mine !== token.current) {
      if (mine === token.current) setPlaying(null)
      return
    }
    const ctx = audioContext()
    if (ctx.state === 'suspended') await ctx.resume()
    const buf = await ctx.decodeAudioData(data).catch(() => null)
    if (!buf || mine !== token.current) {
      if (mine === token.current) setPlaying(null)
      return
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.onended = () => {
      if (source.current === src) {
        source.current = null
        setPlaying(null)
      }
    }
    src.start()
    source.current = src
  }, [playing, stop])
  useEffect(() => stop, [stop])
  return { playing, toggle }
}

/**
 * Music → Splice (SCOPE.md §6.12): the sounds in the Splice folder that could go on the Chord
 * Stabs, Disco Hits, Strings or Bass Samples page, each with the page suggested for it. Nothing is added until
 * you add it: that is the page's own import, which copies the file into the library.
 */
export function SpliceView() {
  const { engine, toast } = useApp()
  const [scan, setScan] = useState<SpliceScan | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [hideAdded, setHideAdded] = useState(false)
  const { playing, toggle } = usePreview()
  const ready = engine.state === 'ready'

  const rescan = useCallback(async () => {
    setBusy(true)
    const r = await attempt(() => api.scanSplice())
    setBusy(false)
    if (r) setScan(r)
  }, [])

  // Looked through when the page opens (and when the engine comes up).
  useEffect(() => {
    if (ready) void rescan()
  }, [ready, rescan])

  const choose = async () => {
    const folder = await api.chooseSpliceFolder()
    if (folder) void rescan()
  }

  const add = async (c: SpliceCandidate, kind: Kind) => {
    setAdding(c.path)
    const r = await attempt(() => api.importHits([c.path], kind))
    setAdding(null)
    if (!r) return
    void loadHits()
    if (r.failed.length) {
      toast('error', `Couldn't add "${c.name}": ${r.failed[0]}.`)
      return
    }
    // (Already on a page: the import skips it, and the next scan says which.)
    setScan((s) => s && { ...s, candidates: s.candidates.map((x) => (x.path === c.path ? { ...x, imported: x.imported ?? kind } : x)) })
    const got = r.imported[0]
    toast('info', r.skipped ? `"${c.name}" is in the library already.`
      : `Added "${c.name}" to ${PAGE[kind]}${got?.key_label ? ` in ${got.key_label}${got.key_source === 'detected' ? ' (key from the sound: check it)' : ''}` : ', without a key'}.`)
  }

  const all = scan?.candidates ?? []
  const q = search.trim().toLowerCase()
  const shown = all.filter((c) => (filter === 'all' || c.kind === filter) && (!hideAdded || !c.imported)
    && (!q || c.name.toLowerCase().includes(q) || c.pack.toLowerCase().includes(q) || (c.key_label ?? '').toLowerCase() === q))
  const count = (k: Kind) => all.filter((c) => c.kind === k).length

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="app-drag topbar-art h-14 shrink-0 flex items-center gap-4 px-6 border-b border-line">
        <PageTabs view="splice" title="Splice" />
        <span className="text-faint text-[12px] tabular-nums">
          {scan?.found ? `${all.length} suggested of ${scan.files} sounds` : ''}
        </span>
        <input className={cx(inputClass, 'w-56')} placeholder="Search name, pack or key" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="flex-1" />
        <Button variant="secondary" disabled={!ready || busy} onClick={() => void choose()}>Folder…</Button>
        <Button variant="primary" disabled={!ready || busy} onClick={() => void rescan()}>{busy ? 'Scanning…' : 'Rescan'}</Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
        <div className="rounded-2xl border border-line bg-panel-2 px-5 py-4 text-[12px] text-muted">
          <div className="text-text font-medium text-[13px] mb-1">Sounds from your Splice folder for the music pages</div>
          The folder is only read: file names and lengths say which sounds could be chord stabs (short chords and keys one-shots),
          disco hits (brass and orchestra hits), strings (long string sounds), bass samples (bass one-shots) or ambience (long textures:
          crackle, hiss, room tone). Each one is a
          suggestion. Listen, then add it to a page: the file is copied into the library, trimmed, and its key read as on that
          page. Drums, vocals, FX, bass loops and loops of anything but strings are left out.
          {scan && <div className="mt-2 text-faint truncate" title={scan.folder}>{scan.folder}</div>}
        </div>

        {scan && !scan.found ? (
          <Empty title="No Splice folder here">
            Nothing at {scan.folder}. Choose the folder Splice downloads into with Folder…
          </Empty>
        ) : scan && !all.length ? (
          <Empty title="Nothing to suggest">None of the {scan.files} sounds in the folder looks like a chord stab, a disco hit, strings, a bass one-shot or a texture.</Empty>
        ) : scan ? (
          <>
            <div className="flex items-center gap-4">
              <Segmented<Filter> value={filter} onChange={setFilter} options={[
                { value: 'all', label: `All ${all.length}` }, ...KINDS.map((k) => ({ value: k as Filter, label: `${PAGE[k]} ${count(k)}` })),
              ]} />
              <label className="flex items-center gap-1.5 text-[12px] text-muted">
                <input type="checkbox" className="accent-[#e2c35f]" checked={hideAdded} onChange={(e) => setHideAdded(e.target.checked)} />
                Hide what's added
              </label>
            </div>
            <div className="rounded-xl border border-line bg-panel-2 divide-y divide-line">
              {shown.map((c) => (
                <div key={c.path} className="h-14 px-4 flex items-center gap-4 text-[12.5px]">
                  <button className="w-7 h-7 rounded-full bg-raised hover:bg-[#3a3b3f] flex items-center justify-center text-accent shrink-0"
                          title="Listen" onClick={() => void toggle(c.path)}>
                    {playing === c.path ? <IconStop className="w-3.5 h-3.5" /> : <IconPlay className="w-3.5 h-3.5" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium" title={c.path}>{c.name}</div>
                    <div className="text-[11px] text-faint truncate">
                      {c.pack ? `${c.pack} · ` : ''}{c.duration_s.toFixed(1)} s
                      {c.key_label ? ` · ${c.key_label}${c.key_source === 'root' ? ' (root only)' : ''}` : ' · no key in the name'}
                      {c.bpm ? ` · ${c.bpm} BPM` : ''} · {c.why}
                    </div>
                  </div>
                  {c.imported ? (
                    <span className="text-[12px] text-muted shrink-0">In {PAGE[c.imported]}</span>
                  ) : (
                    <div className="flex items-center gap-2 shrink-0">
                      <Button variant="primary" disabled={!ready || adding != null} onClick={() => void add(c, c.kind)}
                              title={`Suggested: ${c.why}`}>
                        {adding === c.path ? 'Adding…' : `Add to ${PAGE[c.kind]}`}
                      </Button>
                      <select className={cx(inputClass, 'w-[104px] h-8 text-[12px]')} value="" disabled={!ready || adding != null}
                              title="Add it to another page instead"
                              onChange={(e) => e.target.value && void add(c, e.target.value as Kind)}>
                        <option value="">Other page…</option>
                        {KINDS.filter((k) => k !== c.kind).map((k) => <option key={k} value={k}>{PAGE[k]}</option>)}
                      </select>
                    </div>
                  )}
                </div>
              ))}
              {!shown.length && <div className="px-4 py-6 text-[12.5px] text-faint">Nothing matches.</div>}
            </div>
          </>
        ) : (
          <div className="text-[12.5px] text-faint">{ready ? 'Looking through the folder…' : 'Waiting for the engine…'}</div>
        )}
      </div>
    </div>
  )
}
