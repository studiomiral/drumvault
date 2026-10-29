import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { api } from '../api'
import { IconDrop, IconX } from '../components/icons'
import { Button, cx, Empty, inputClass, PageTitle } from '../components/ui'
import { ALL_KEYS } from '../lib/camelot'
import { attempt, useApp } from '../store/app'
import { loadBass } from '../store/bass'
import { learnBass, type BassModel } from '../generate/bassline'
import type { MidiItem } from '../types/api'

/**
 * Samples → MIDI (SCOPE.md §6.7): the basslines Generate learns to write its own from, added from
 * MIDI zips, .mid files or folders. Only basslines are kept; a zip's other parts help find its key.
 */
export function MidiView() {
  const { libraryVersion, engine, toast } = useApp()
  const [items, setItems] = useState<MidiItem[] | null>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    void api.listMidi().then((m) => setItems(m.filter((x) => x.role === 'bass').reverse()))
  }, [libraryVersion])

  const add = useCallback(async (paths: string[]) => {
    if (!paths.length) return
    setBusy(true)
    const r = await attempt(() => api.importMidi(paths))
    setBusy(false)
    if (!r) return
    void loadBass()
    const parts: string[] = []
    parts.push(r.imported.length ? `Added ${r.imported.length} bassline${r.imported.length === 1 ? '' : 's'}` : 'No new basslines')
    if (r.skipped) parts.push(`${r.skipped} already in`)
    if (r.ignored) parts.push(`${r.ignored} other part${r.ignored === 1 ? '' : 's'} left out`)
    if (r.failed.length) parts.push(`${r.failed.length} unreadable: ${r.failed.slice(0, 2).join('; ')}`)
    toast(r.failed.length && !r.imported.length ? 'error' : 'info', `${parts.join(', ')}.`)
  }, [toast])

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    await add(api.pathsForFiles([...e.dataTransfer.files]))
  }

  const remove = async (m: MidiItem) => {
    if (!window.confirm(`Remove "${m.name}" from your basslines? Projects that use it keep their bass.`)) return
    await attempt(() => api.deleteMidi([m.id]))
    void loadBass()
  }

  const setKey = async (m: MidiItem, key: string) => {
    await attempt(() => api.setMidiKey(m.id, key || null))
    void loadBass()
  }

  const model = useMemo(() => (items ? learnBass(items) : null), [items])
  const q = search.trim().toLowerCase()
  const shown = (items ?? []).filter((m) => !q || m.name.toLowerCase().includes(q) || (m.source_code ?? '').toLowerCase().includes(q))
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
        <PageTitle className="mr-3">MIDI</PageTitle>
        <input className={cx(inputClass, 'w-64')} placeholder="Search basslines" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="flex-1" />
        <span className="text-muted text-[12px]">{items ? `${items.length} bassline${items.length === 1 ? '' : 's'}` : ''}</span>
        <Button variant="primary" disabled={!ready || busy} onClick={() => void api.chooseMidi().then(add)}>Add MIDI…</Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
        <button disabled={!ready || busy} onClick={() => void api.chooseMidi().then(add)}
                className={cx('w-full rounded-2xl border border-dashed px-6 py-6 flex items-center gap-4 text-left transition-colors',
                  dragging ? 'border-accent bg-accent-soft' : 'border-[#3e3f44] bg-panel-2 hover:border-accent/60')}>
          <span className="w-12 h-12 rounded-full bg-raised flex items-center justify-center text-text shrink-0">
            <IconDrop className="w-6 h-6" />
          </span>
          <span>
            <span className="block text-text font-medium">{busy ? 'Importing…' : 'Drop MIDI zips, .mid files or folders'}</span>
            <span className="block mt-1 text-[12px] text-muted">
              Only basslines are kept: Generate learns from them to write its own. A zip&apos;s other parts (chords, leads) help find its key;
              a MIDI zip named like a processed stem zip (83686_midi ↔ 83686_stems) takes that track&apos;s key.
            </span>
          </span>
        </button>

        {model && <Learned model={model} />}

        {items && !items.length ? (
          <Empty title="No basslines yet">Drop the MIDI zips of your tracks here.</Empty>
        ) : (
          <div className="rounded-xl border border-line bg-panel-2 divide-y divide-line">
            {shown.map((m) => (
              <div key={m.id} className="h-12 px-4 flex items-center gap-4 text-[12.5px]">
                <NotesThumb notes={m.notes} bars={m.bars} />
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{m.name}</div>
                  <div className="text-[11px] text-faint truncate">
                    {m.notes.length} notes{m.source_code ? ` · track ${m.source_code}` : ''}{m.source ? ` · from ${m.source}` : ''}
                  </div>
                </div>
                <span className="w-16 text-muted">{m.bars} bar{m.bars === 1 ? '' : 's'}</span>
                <select className={cx(inputClass, 'w-36 h-7 text-[12px]')} value={m.key_label ?? ''} title="Key: the bassline is moved from this key into each track's key"
                        onChange={(e) => void setKey(m, e.target.value)}>
                  <option value="">No key (not moved)</option>
                  {ALL_KEYS.map((k) => <option key={k.label} value={k.label}>{k.label} ({k.camelot})</option>)}
                </select>
                <button title="Remove from your basslines" className="text-faint hover:text-bad" onClick={() => void remove(m)}>
                  <IconX className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** The bassline's notes as a tiny picture: time across, pitch up. */
function NotesThumb({ notes, bars }: { notes: [number, number, number, number][]; bars: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const W = 120
    const H = 28
    const dpr = window.devicePixelRatio || 1
    c.width = W * dpr
    c.height = H * dpr
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.clearRect(0, 0, W, H)
    if (!notes.length) return
    const lo = Math.min(...notes.map((n) => n[2]))
    const hi = Math.max(...notes.map((n) => n[2]), lo + 6)
    const span = bars * 4
    g.fillStyle = '#fda4af'
    for (const [s, l, p] of notes) {
      const y = H - 3 - ((p - lo) / (hi - lo)) * (H - 6)
      g.fillRect((s / span) * W, y - 1.5, Math.max(1.5, (l / span) * W - 0.5), 3)
    }
  }, [notes, bars])
  return <canvas ref={ref} style={{ width: 120, height: 28 }} className="shrink-0 rounded bg-[rgb(0_0_0/0.2)]" />
}

const INTERVAL: Record<number, string> = {
  0: 'root', 1: 'b2', 2: '2nd', 3: 'minor 3rd', 4: '3rd', 5: '4th', 6: 'b5', 7: '5th', 8: 'b6', 9: '6th', 10: 'b7', 11: 'note under the root',
}

/** What the bass generator took from these basslines. */
function Learned({ model }: { model: BassModel }) {
  const starts = model.onsets.slice(0, 16)
  const most = Math.max(...starts, 1)
  const ivs = new Map<string, number>()
  for (const w of model.at) {
    for (const [iv, n] of w) {
      const name = iv % 12 === 0 && iv !== 0 ? 'octave' : INTERVAL[((iv % 12) + 12) % 12]
      ivs.set(name, (ivs.get(name) ?? 0) + n)
    }
  }
  const total = [...ivs.values()].reduce((a, b) => a + b, 0) || 1
  const top = [...ivs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  const from = [...model.from.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const pct = (x: number) => `${Math.round(x * 100)}%`
  return (
    <section className="rounded-xl border border-line bg-panel-2 px-4 py-3 text-[12px] space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">What Generate learned</span>
        <span className="text-muted">from {model.lines} loop{model.lines === 1 ? '' : 's'} (an 8-bar file counts as two)</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-24 text-muted">Notes start</span>
        <span className="flex gap-[3px]" title="How often a note starts on each 16th of the bar">
          {starts.map((n, i) => (
            <span key={i} className={cx('w-4 h-5 rounded-[3px]', i % 4 === 0 && 'ring-1 ring-[#4a4b50]')}
                  style={{ background: `rgb(226 195 95 / ${0.08 + 0.92 * (n / most)})` }} />
          ))}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-24 text-muted">Notes</span>
        <span className="text-text">{top.map(([n, c]) => `${n} ${pct(c / total)}`).join(' · ')}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-24 text-muted">Later bars</span>
        <span className="text-text">
          bar 2 of 2 differs in {pct(model.varies.two)}; of 4: bar 2 {pct(model.varies.four[0])}, bar 3 {pct(model.varies.four[1])},
          bar 4 {pct(model.varies.four[2])}{from != null ? `; most often from ${from === 0 ? 'the 1 (the whole bar)' : `16th ${from + 1}`}` : ''}
          {model.moveShare ? `; ${pct(model.moveShare)} of whole-bar changes move to another root` : ''}
        </span>
      </div>
    </section>
  )
}
