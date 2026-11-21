import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { IconX } from '../components/icons'
import { DropZone } from '../components/SoundSections'
import { cx, Empty, inputClass } from '../components/ui'
import { ALL_KEYS } from '../lib/camelot'
import { attempt, useApp } from '../store/app'
import { loadBass } from '../store/bass'
import { learnBass, type BassModel } from '../generate/bassline'
import type { MidiItem } from '../types/api'

export type MidiRole = 'bass' | 'piano'

const COLOR: Record<MidiRole, string> = { bass: '#fda4af', piano: '#a5b4fc' }

const TEXT: Record<MidiRole, { one: string; many: string; drop: string; about: string; empty: string }> = {
  bass: {
    one: 'bassline', many: 'basslines', drop: 'Drop bass MIDI: .mid files, folders or zips',
    about: 'Generate learns from these to write its own basslines (rhythms, intervals, lengths, what later bars change). '
      + 'Learning material only: Generate never plays these files as they are. Every file dropped here counts as '
      + 'bass; from a zip with several parts, only the parts named for the bass.',
    empty: 'Drop your own basslines here.',
  },
  piano: {
    one: 'piano part', many: 'piano parts', drop: 'Drop piano MIDI: .mid files, folders or zips',
    about: 'House piano riffs for Generate to learn from once it writes piano (not yet: they are collected here for it). '
      + 'Learning material only: Generate will never play these files as they are. Every file dropped here counts as '
      + 'piano; from a zip with several parts, only the parts named piano, keys, e-piano, Rhodes, Wurli, organ or clav (not "Chords").',
    empty: 'Drop your own piano riffs here.',
  },
}

/** The MIDI files of a role, newest first (refetched when the library changes). */
export function useMidi(role: MidiRole): MidiItem[] | null {
  const libraryVersion = useApp((s) => s.libraryVersion)
  const [items, setItems] = useState<MidiItem[] | null>(null)
  useEffect(() => {
    void api.listMidi().then((m) => setItems(m.filter((x) => x.role === role).reverse()))
  }, [libraryVersion, role])
  return items
}

/** Adding MIDI of a role: the files, folders or zips given, with what came of it in a toast. */
export function useMidiImport(role: MidiRole): { add: (paths: string[]) => Promise<void>; busy: boolean } {
  const toast = useApp((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const add = useCallback(async (paths: string[]) => {
    if (!paths.length) return
    setBusy(true)
    const r = await attempt(() => api.importMidi(paths, role))
    setBusy(false)
    if (!r) return
    void loadBass()
    const t = TEXT[role]
    const parts: string[] = []
    parts.push(r.imported.length ? `Added ${r.imported.length} ${r.imported.length === 1 ? t.one : t.many}` : `No new ${t.many}`)
    if (r.skipped) parts.push(`${r.skipped} already in`)
    if (r.ignored) parts.push(`${r.ignored} other part${r.ignored === 1 ? '' : 's'} of a zip left out`)
    if (r.failed.length) parts.push(`${r.failed.length} unreadable: ${r.failed.slice(0, 2).join('; ')}`)
    toast(r.failed.length && !r.imported.length ? 'error' : 'info', `${parts.join(', ')}.`)
  }, [toast, role])
  return { add, busy }
}

/**
 * The MIDI of a Sounds tab (SCOPE.md §6.7): basslines on Bass, piano parts on Piano, to learn
 * from. Generate never plays these files; it writes new parts from what they have in common (the
 * bass now, the piano once it writes piano).
 */
export function MidiSection({ role, items, search, add, busy }: {
  role: MidiRole
  items: MidiItem[] | null
  search: string
  add: (paths: string[]) => Promise<void>
  busy: boolean
}) {
  const engine = useApp((s) => s.engine)
  const t = TEXT[role]
  const color = COLOR[role]

  const reload = () => {
    void loadBass()
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

  const bassModel = useMemo(() => (role === 'bass' ? learnBass(items ?? []) : null), [role, items])
  const q = search.trim().toLowerCase()
  const shown = (items ?? []).filter((m) => !q || m.name.toLowerCase().includes(q) || (m.source_code ?? '').toLowerCase().includes(q))
  const ready = engine.state === 'ready'

  return (
    <div className="space-y-5">
      <DropZone title={busy ? 'Importing…' : t.drop} about={t.about} disabled={!ready || busy}
                onChoose={() => void api.chooseMidi().then(add)} onPaths={(p) => void add(p)} />

      {bassModel && <Learned model={bassModel} />}

      {items && !items.length ? (
        <Empty title={`No ${role} MIDI yet`}>{t.empty}</Empty>
      ) : (
        <div className="rounded-xl border border-line bg-panel-2 divide-y divide-line">
          {shown.map((m) => (
            <div key={m.id} className="h-12 px-4 flex items-center gap-4 text-[12.5px]">
              <NotesThumb notes={m.notes} bars={m.bars} color={color} />
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
              <button title="Remove from what Generate learns from" className="text-faint hover:text-bad" onClick={() => void remove(m)}>
                <IconX className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
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
  const loops = model.periods[2] + model.periods[4] + model.periods[8]
  const answerFrom = [...model.answers.map((a) => a.from)].sort((a, b) => a - b)[Math.floor(model.answers.length / 2)] ?? 12
  const pct = (x: number) => `${Math.round(x * 100)}%`
  return (
    <section className="rounded-xl border border-line bg-panel-2 px-4 py-3 text-[12px] space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">What Generate learned</span>
        <span className="text-muted">from {model.lines} loop{model.lines === 1 ? '' : 's'}: {model.cells[16].length} rhythms of 4 beats, {model.cells[8].length} of 2</span>
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
        <span className="w-24 text-muted">Repeats every</span>
        <span className="text-text">
          {loops ? `2 beats ${pct(model.periods[2] / loops)} · 4 beats ${pct(model.periods[4] / loops)} · 8 beats ${pct(model.periods[8] / loops)}` : 'no line repeats within 8 beats'}
          {model.answers.length ? `; an 8-beat loop answers from 16th ${answerFrom + 1} of its second bar` : ''}
          {model.long ? <span className="text-faint">{`; ${model.long} longer line${model.long === 1 ? '' : 's'} (16 or 32 beats) learned as 8-beat loops: cut ${model.long === 1 ? 'it' : 'them'} to their best 4 or 8 beats`}</span> : ''}
        </span>
      </div>
    </section>
  )
}
