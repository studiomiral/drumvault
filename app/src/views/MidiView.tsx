import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { api } from '../api'
import { IconDrop, IconX } from '../components/icons'
import { Button, cx, Empty, inputClass, PageTitle } from '../components/ui'
import { SerumFolders } from '../components/SerumFolders'
import { ALL_KEYS } from '../lib/camelot'
import { attempt, useApp } from '../store/app'
import { loadKeys } from '../store/keys'
import { learnKeys, type KeysModel } from '../generate/keys'
import { harmonyOf, progressionName } from '../generate/harmony'
import { loadBass } from '../store/bass'
import { learnBass, type BassModel } from '../generate/bassline'
import type { MidiItem } from '../types/api'

type Section = 'bass' | 'keys'
const SECTION_KEY = 'drumvault.midi.section'
const SECTIONS: { id: Section; label: string; color: string; drop: string; what: string }[] = [
  {
    id: 'bass', label: 'Bass', color: '#fda4af', drop: 'Drop bass MIDI: .mid files, folders or zips',
    what: 'Generate learns from these to write its own basslines (rhythms, intervals, lengths, what later bars change).',
  },
  {
    id: 'keys', label: 'Keys & chords', color: '#c4b5fd', drop: 'Drop keys and chord MIDI: .mid files, folders or zips',
    what: 'Generate learns from these to write its own chord parts (voicings, chord rhythms, progressions); the bass follows their chords.',
  },
]

function savedSection(): Section {
  try {
    return localStorage.getItem(SECTION_KEY) === 'keys' ? 'keys' : 'bass'
  } catch {
    return 'bass'
  }
}

/**
 * Samples → MIDI (SCOPE.md §6.7): learning material, one section per part. Generate never plays
 * these files; it writes new basslines and keys parts from what each section's files have in
 * common. Every file dropped on a section is that part.
 */
export function MidiView() {
  const { libraryVersion, engine, toast } = useApp()
  const [items, setItems] = useState<MidiItem[] | null>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [section, setSectionState] = useState<Section>(savedSection)
  const setSection = (s: Section) => {
    setSectionState(s)
    try {
      localStorage.setItem(SECTION_KEY, s)
    } catch {
      // not remembered
    }
  }
  const info = SECTIONS.find((s) => s.id === section)!

  useEffect(() => {
    void api.listMidi().then((m) => setItems(m.reverse()))
  }, [libraryVersion])

  const add = useCallback(async (paths: string[]) => {
    if (!paths.length) return
    setBusy(true)
    const r = await attempt(() => api.importMidi(paths, section))
    setBusy(false)
    if (!r) return
    void loadBass()
    void loadKeys()
    const what = section === 'keys' ? 'keys part' : 'bassline'
    const parts: string[] = []
    parts.push(r.imported.length ? `Added ${r.imported.length} ${what}${r.imported.length === 1 ? '' : 's'}` : `No new ${what}s`)
    if (r.skipped) parts.push(`${r.skipped} already in`)
    if (r.ignored) parts.push(`${r.ignored} other part${r.ignored === 1 ? '' : 's'} of a zip left out`)
    if (r.failed.length) parts.push(`${r.failed.length} unreadable: ${r.failed.slice(0, 2).join('; ')}`)
    toast(r.failed.length && !r.imported.length ? 'error' : 'info', `${parts.join(', ')}.`)
  }, [toast, section])

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    await add(api.pathsForFiles([...e.dataTransfer.files]))
  }

  const reload = () => {
    void loadBass()
    void loadKeys()
  }
  const remove = async (m: MidiItem) => {
    if (!window.confirm(`Remove "${m.name}" from what Generate learns from? Tracks made with it keep their parts.`)) return
    await attempt(() => api.deleteMidi([m.id]))
    reload()
  }
  const setKey = async (m: MidiItem, key: string) => {
    await attempt(() => api.setMidiKey(m.id, key || null))
    reload()
  }
  const move = async (m: MidiItem, to: Section) => {
    await attempt(() => api.setMidiRole(m.id, to))
    reload()
  }

  const ofSection = useMemo(() => (items ?? []).filter((m) => m.role === section), [items, section])
  const bassModel = useMemo(() => (section === 'bass' ? learnBass(ofSection) : null), [ofSection, section])
  const keysModel = useMemo(() => (section === 'keys' ? learnKeys(ofSection) : null), [ofSection, section])
  const count = (s: Section) => (items ?? []).filter((m) => m.role === s).length
  const q = search.trim().toLowerCase()
  const shown = ofSection.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.source_code ?? '').toLowerCase().includes(q))
  const ready = engine.state === 'ready'
  const other = SECTIONS.find((s) => s.id !== section)!

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
        <div className="flex rounded-lg bg-[rgb(0_0_0/0.25)] p-0.5 shadow-[0_0_0_1px_rgb(255_255_255/0.08)]">
          {SECTIONS.map((s) => (
            <button key={s.id} onClick={() => setSection(s.id)}
                    className={cx('h-7 px-3 rounded-md text-[12px] flex items-center gap-2 transition-colors',
                      section === s.id ? 'bg-raised text-text' : 'text-muted hover:text-text')}>
              <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
              {s.label}
              <span className="text-faint tabular-nums">{items ? count(s.id) : ''}</span>
            </button>
          ))}
        </div>
        <input className={cx(inputClass, 'w-56')} placeholder={`Search ${info.label.toLowerCase()}`} value={search}
               onChange={(e) => setSearch(e.target.value)} />
        <div className="flex-1" />
        <Button variant="primary" disabled={!ready || busy} onClick={() => void api.chooseMidi().then(add)}>Add to {info.label}…</Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
        <button disabled={!ready || busy} onClick={() => void api.chooseMidi().then(add)}
                className={cx('w-full rounded-2xl border border-dashed px-6 py-6 flex items-center gap-4 text-left transition-colors',
                  dragging ? 'border-accent bg-accent-soft' : 'border-[#3e3f44] bg-panel-2 hover:border-accent/60')}>
          <span className="w-12 h-12 rounded-full bg-raised flex items-center justify-center text-text shrink-0">
            <IconDrop className="w-6 h-6" />
          </span>
          <span>
            <span className="block text-text font-medium">{busy ? 'Importing…' : info.drop}</span>
            <span className="block mt-1 text-[12px] text-muted">
              {info.what} Learning material only: Generate never plays these files as they are. Every file dropped here
              counts as {section === 'keys' ? 'keys' : 'bass'}; from a zip with several parts, only the parts named for this section.
            </span>
          </span>
        </button>

        <SerumFolders key={section} module={section} />

        {bassModel && <Learned model={bassModel} />}
        {keysModel && <KeysLearned model={keysModel} items={ofSection} />}

        {items && !ofSection.length ? (
          <Empty title={`No ${info.label.toLowerCase()} MIDI yet`}>Drop your own {section === 'keys' ? 'chord and keys parts' : 'basslines'} here.</Empty>
        ) : (
          <div className="rounded-xl border border-line bg-panel-2 divide-y divide-line">
            {shown.map((m) => (
              <div key={m.id} className="h-12 px-4 flex items-center gap-4 text-[12.5px]">
                <NotesThumb notes={m.notes} bars={m.bars} color={info.color} />
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{m.name}</div>
                  <div className="text-[11px] text-faint truncate">
                    {m.notes.length} notes{m.source_code ? ` · track ${m.source_code}` : ''}{m.source ? ` · from ${m.source}` : ''}
                  </div>
                </div>
                <span className="w-16 text-muted">{m.bars} bar{m.bars === 1 ? '' : 's'}</span>
                <select className={cx(inputClass, 'w-36 h-7 text-[12px]')} value={m.key_label ?? ''} title="Key: what it learns is relative to this key"
                        onChange={(e) => void setKey(m, e.target.value)}>
                  <option value="">No key</option>
                  {ALL_KEYS.map((k) => <option key={k.label} value={k.label}>{k.label} ({k.camelot})</option>)}
                </select>
                <button className="text-[11.5px] text-faint hover:text-text whitespace-nowrap" title={`In the wrong section: move it to ${other.label}`}
                        onClick={() => void move(m, other.id)}>To {other.label}</button>
                <button title="Remove from what Generate learns from" className="text-faint hover:text-bad" onClick={() => void remove(m)}>
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

/** Where notes start in the bar, as 16 cells: the more, the brighter. */
function Starts({ onsets, title }: { onsets: number[]; title: string }) {
  const starts = onsets.slice(0, 16)
  const most = Math.max(...starts, 1)
  return (
    <span className="flex gap-[3px]" title={title}>
      {starts.map((n, i) => (
        <span key={i} className={cx('w-4 h-5 rounded-[3px]', i % 4 === 0 && 'ring-1 ring-[#4a4b50]')}
              style={{ background: `rgb(226 195 95 / ${0.08 + 0.92 * (n / most)})` }} />
      ))}
    </span>
  )
}

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

/** What the keys generator took from these parts. */
function KeysLearned({ model, items }: { model: KeysModel; items: MidiItem[] }) {
  const progressions = new Map<string, number>()
  for (const m of items) {
    if (!m.key_label || !m.notes.length) continue
    const name = progressionName(harmonyOf(m.notes, Math.min(m.bars, 4), m.key_label))
    progressions.set(name, (progressions.get(name) ?? 0) + 1)
  }
  const top = [...progressions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
  return (
    <section className="rounded-xl border border-line bg-panel-2 px-4 py-3 text-[12px] space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">What Generate learned</span>
        <span className="text-muted">from {model.parts} part{model.parts === 1 ? '' : 's'} ({model.phrases.length} phrases)</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-24 text-muted">Chords start</span>
        <Starts onsets={model.onsets} title="How often a chord starts on each 16th of the bar" />
      </div>
      <div className="flex items-center gap-3">
        <span className="w-24 text-muted">Voicings</span>
        <span className="text-text">typically {model.polyphony} notes, around {NOTE_NAMES[model.register % 12]}{Math.floor(model.register / 12) - 1}</span>
      </div>
      {top.length > 0 && (
        <div className="flex items-center gap-3">
          <span className="w-24 text-muted">Progressions</span>
          <span className="text-text">{top.map(([n, c]) => `${n}${c > 1 ? ` (${c}×)` : ''}`).join(' · ')}</span>
        </div>
      )}
    </section>
  )
}

/** A part's notes as a tiny picture: time across, pitch up. */
function NotesThumb({ notes, bars, color }: { color: string; notes: [number, number, number, number][]; bars: number }) {
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
    g.fillStyle = color
    for (const [s, l, p] of notes) {
      const y = H - 3 - ((p - lo) / (hi - lo)) * (H - 6)
      g.fillRect((s / span) * W, y - 1.5, Math.max(1.5, (l / span) * W - 0.5), 3)
    }
  }, [notes, bars, color])
  return <canvas ref={ref} style={{ width: 120, height: 28 }} className="shrink-0 rounded bg-[rgb(0_0_0/0.2)]" />
}

const INTERVAL: Record<number, string> = {
  0: 'root', 1: 'b2', 2: '2nd', 3: 'minor 3rd', 4: '3rd', 5: '4th', 6: 'b5', 7: '5th', 8: 'b6', 9: '6th', 10: 'b7', 11: 'note under the root',
}

/** What the bass generator took from these basslines. */
function Learned({ model }: { model: BassModel }) {
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
        <Starts onsets={model.onsets} title="How often a note starts on each 16th of the bar" />
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
