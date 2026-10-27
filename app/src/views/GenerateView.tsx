import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { playback } from '../audio/engine'
import { openGenerated } from '../arrange/persistence'
import { IconPlay, IconStop } from '../components/icons'
import { Button, cx, Empty, PageTitle, SectionTitle } from '../components/ui'
import { KEEPABLE, LANES, type Generation, type Role } from '../generate/generator'
import { markerColor } from '../lib/project'
import { useApp } from '../store/app'
import {
  attachPlayback, current, invalidate, loadSamples, next, playSection, previous, useGenerate, type KeepToggles,
} from '../store/generate'
import type { ZipListItem } from '../types/api'

const ROLE_LABEL: Partial<Record<Role, string>> = Object.fromEntries(LANES.map((l) => [l.role, l.name]))

/** Create → Generate (SCOPE.md §6.6): cycle through generated arrangements, send one to Arrange. */
export function GenerateView() {
  const { libraryVersion, setView } = useApp()
  const { samples, history, index, settings, keep, set } = useGenerate()
  const g = history[index] ?? null
  const [playing, setPlaying] = useState(playback.playing)
  const [sending, setSending] = useState(false)

  useEffect(() => attachPlayback(), [])
  useEffect(() => playback.subscribe(() => setPlaying(playback.playing)), [])
  useEffect(() => {
    void loadSamples()
  }, [libraryVersion])

  const send = async () => {
    const cur = current()
    if (!cur || sending) return
    setSending(true)
    try {
      await openGenerated(cur.project)
      setView('arrange')
    } finally {
      setSending(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return
      if (e.metaKey || e.ctrlKey || e.altKey || useApp.getState().modal) return
      if (e.key === 'g' || e.key === 'G' || e.key === 'ArrowRight') {
        e.preventDefault()
        next()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        previous()
      } else if (e.key === ' ') {
        e.preventDefault()
        if (current()) playback.toggle()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        void send()
      } else if (/^[1-9]$/.test(e.key)) {
        playSection(Number(e.key) - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const setKeep = (patch: Partial<KeepToggles>) => {
    set({ keep: { ...keep, ...patch } })
    invalidate()
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="app-drag h-14 shrink-0 flex items-center gap-4 px-6 border-b border-line">
        <PageTitle>Generate</PageTitle>
        <div className="flex-1" />
        <Options />
      </header>
      {samples && samples.length === 0 ? (
        <Empty title="Nothing to generate from yet">Process some zips first: the generator combines drums and FX from your library.</Empty>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
          {/* Transport + actions */}
          <section className="rounded-2xl border border-line bg-panel-2 px-5 py-4 flex items-center gap-3">
            <Button variant="secondary" className="h-9 w-9 px-0" onClick={previous} disabled={index <= 0} title="Previous (←)">‹</Button>
            <Button variant="primary" className="h-9 px-4 text-[13px]" onClick={() => next()} disabled={!samples} title="Generate (G or →)">
              Generate
            </Button>
            <button onClick={() => g && playback.toggle()} disabled={!g} title="Play / stop (Space)"
                    className={cx('h-9 w-9 rounded-full flex items-center justify-center transition-colors disabled:opacity-40',
                      playing ? 'bg-brand text-on-accent' : 'surface-raised text-accent hover:bg-[#3a3b3f]')}>
              {playing ? <IconStop className="w-4 h-4" /> : <IconPlay className="w-4 h-4" />}
            </button>
            <span className="text-muted text-[12.5px] ml-1">
              {g ? <>Generation <span className="text-text font-medium">{index + 1}</span> of {history.length}</> : 'Press G to generate'}
            </span>
            <div className="flex-1" />
            <span className="text-faint text-[11.5px]">G / → next · ← back · Space play · 1–9 sections · Enter send</span>
            <Button variant="primary" className="h-9 px-4 text-[13px]" onClick={() => void send()} disabled={!g || sending}>
              Send to Arrange ⏎
            </Button>
          </section>

          {g ? (
            <>
              <Overview g={g} />
              <div className="grid grid-cols-[1fr_340px] gap-5">
                <Details g={g} />
                <KeepPanel g={g} keep={keep} setKeep={setKeep} />
              </div>
            </>
          ) : (
            <section className="rounded-2xl border border-dashed border-[#3e3f44] h-64 flex flex-col items-center justify-center text-center text-muted">
              <div className="font-display text-[22px] text-text">A new track skeleton, every press</div>
              <p className="mt-2 max-w-md text-[12.5px]">
                {settings.minMinutes}–{settings.maxMinutes} minutes of drums and FX from different imports, with a DJ intro and outro,
                builds, breakdowns and drops. Keep what you like, re-roll the rest.
              </p>
              <Button variant="primary" className="mt-4 h-9 px-4" onClick={() => next()} disabled={!samples}>Generate</Button>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

/** Length, sources and favourites bias. */
function Options() {
  const { settings, set } = useGenerate()
  const [zips, setZips] = useState<ZipListItem[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (open) void api.listZips().then(setZips)
  }, [open])
  const update = (patch: Partial<typeof settings>) => {
    set({ settings: { ...settings, ...patch } })
    invalidate()
  }
  const minutes = [3, 4, 5, 6, 7, 8]
  const sel = 'h-7 rounded-lg bg-[rgb(0_0_0/0.25)] px-2 text-text text-[12px] outline-none shadow-[0_0_0_1px_rgb(255_255_255/0.08)]'
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted relative">
      Length
      <select className={sel} value={settings.minMinutes} onChange={(e) => {
        const v = Number(e.target.value)
        update({ minMinutes: v, maxMinutes: Math.max(v, settings.maxMinutes) })
      }}>
        {minutes.map((m) => <option key={m} value={m}>{m} min</option>)}
      </select>
      to
      <select className={sel} value={settings.maxMinutes} onChange={(e) => {
        const v = Number(e.target.value)
        update({ maxMinutes: v, minMinutes: Math.min(v, settings.minMinutes) })
      }}>
        {minutes.map((m) => <option key={m} value={m}>{m} min</option>)}
      </select>
      <Button variant="secondary" className="ml-2" onClick={() => setOpen(!open)}>
        Sources: {settings.zipIds ? `${settings.zipIds.length} zip${settings.zipIds.length === 1 ? '' : 's'}` : 'all zips'}
      </Button>
      <label className="flex items-center gap-1.5 ml-2">
        <input type="checkbox" className="accent-[#e2c35f]" checked={settings.useRatings}
               onChange={(e) => update({ useRatings: e.target.checked })} />
        Prefer favourites
      </label>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-50 w-80 max-h-96 overflow-y-auto rounded-xl surface-pop p-2">
            <label className="flex items-center gap-2 px-2 h-8 rounded-md hover:bg-raised">
              <input type="checkbox" className="accent-[#e2c35f]" checked={!settings.zipIds}
                     onChange={() => update({ zipIds: settings.zipIds ? null : [] })} />
              <span className="text-text">All zips</span>
            </label>
            {zips.map((z) => {
              const on = !settings.zipIds || settings.zipIds.includes(z.id)
              return (
                <label key={z.id} className="flex items-center gap-2 px-2 h-8 rounded-md hover:bg-raised">
                  <input type="checkbox" className="accent-[#e2c35f]" checked={on} onChange={() => {
                    const ids = settings.zipIds ?? zips.map((x) => x.id)
                    const nextIds = on ? ids.filter((i) => i !== z.id) : [...ids, z.id]
                    update({ zipIds: nextIds.length === zips.length ? null : nextIds })
                  }} />
                  <span className="font-mono text-faint text-[11px]">{z.source_code}</span>
                  <span className="truncate text-text">{z.file_name}</span>
                </label>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/** The arrangement at a glance: sections (click to play from there), lanes, playhead. */
function Overview({ g }: { g: Generation }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(900)
  const LABEL_W = 84
  const BAND = 30
  const ROW = 22
  const h = BAND + g.project.lanes.length * ROW + 8
  const totalBeats = g.project.lengthBars * 4

  useEffect(() => {
    const el = wrap.current!
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let raf = 0
    const draw = () => {
      const c = ref.current
      if (!c) return
      const dpr = window.devicePixelRatio || 1
      c.width = w * dpr
      c.height = h * dpr
      const x = c.getContext('2d')!
      x.setTransform(dpr, 0, 0, dpr, 0, 0)
      x.clearRect(0, 0, w, h)
      const px = (w - LABEL_W - 8) / totalBeats
      const bx = (beat: number) => LABEL_W + beat * px
      x.font = `500 11px "Hanken Grotesk Variable", system-ui, sans-serif`
      x.textBaseline = 'middle'
      // Sections
      g.sections.forEach((s, i) => {
        const x0 = bx(s.start * 4)
        const x1 = bx((s.start + s.bars) * 4)
        const col = markerColor(s.label)
        x.fillStyle = `${col}33`
        x.fillRect(x0 + 1, 4, x1 - x0 - 2, BAND - 8)
        x.fillStyle = col
        x.fillRect(x0 + 1, 4, 3, BAND - 8)
        x.save()
        x.beginPath()
        x.rect(x0 + 6, 0, x1 - x0 - 8, BAND)
        x.clip()
        x.fillStyle = '#f1f1ef'
        x.fillText(`${i < 9 ? `${i + 1}  ` : ''}${s.label} · ${s.bars}`, x0 + 8, BAND / 2)
        x.restore()
        x.fillStyle = 'rgba(255,255,255,0.06)'
        x.fillRect(Math.round(x0), BAND, 1, h - BAND)
      })
      // Lanes
      g.project.lanes.forEach((lane, li) => {
        const y = BAND + li * ROW + 4
        x.fillStyle = '#a5a5a1'
        x.fillText(lane.name, 8, y + ROW / 2 - 2)
        x.fillStyle = 'rgba(255,255,255,0.03)'
        x.fillRect(LABEL_W, y, w - LABEL_W - 8, ROW - 4)
        for (const c of g.project.clips) {
          if (c.laneId !== lane.id) continue
          const x0 = bx(c.start)
          const cw = Math.max(2, c.length * px - 1)
          x.fillStyle = c.filter ? `${lane.color}66` : `${lane.color}b3`
          x.beginPath()
          x.roundRect(x0, y + 1, cw, ROW - 6, 3)
          x.fill()
        }
      })
      // Playhead
      const pos = playback.position()
      if (pos > 0 || playback.playing) {
        x.fillStyle = '#e2c35f'
        x.fillRect(Math.round(bx(Math.min(pos, totalBeats))), 0, 2, h)
      }
      if (playback.playing) raf = requestAnimationFrame(draw)
    }
    draw()
    const off = playback.subscribe(() => {
      cancelAnimationFrame(raf)
      draw()
    })
    return () => {
      cancelAnimationFrame(raf)
      off()
    }
  }, [g, w, h, totalBeats])

  const onClick = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const beat = ((e.clientX - r.left - LABEL_W) / (w - LABEL_W - 8)) * totalBeats
    if (beat < 0) return
    if (e.clientY - r.top <= BAND) {
      const i = g.sections.findIndex((s) => beat >= s.start * 4 && beat < (s.start + s.bars) * 4)
      if (i >= 0) playSection(i)
    } else {
      void playback.play(Math.floor(beat / 4) * 4)
    }
  }

  return (
    <section ref={wrap} className="rounded-2xl border border-line bg-panel-2 overflow-hidden">
      <canvas ref={ref} style={{ width: w, height: h }} className="block cursor-pointer" onClick={onClick} />
    </section>
  )
}

function Details({ g }: { g: Generation }) {
  const bpm = g.project.bpm
  const secs = Math.round((g.project.lengthBars * 4 * 60) / bpm)
  return (
    <section className="rounded-2xl border border-line bg-panel-2 px-5 py-4 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-display text-[22px]">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span>
        <span className="text-muted">{g.project.lengthBars} bars · {bpm} BPM</span>
        {g.key && <span className="rounded-md px-2 h-[22px] inline-flex items-center bg-pastel-yellow text-on-pastel text-[12px] font-medium">Key {g.key}</span>}
        <span className="text-faint text-[11.5px] ml-auto">seed {g.seed}</span>
      </div>
      <div>
        <SectionTitle>Structure</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          {g.sections.map((s, i) => (
            <button key={i} onClick={() => playSection(i)} title={`Play from ${s.label} (${i + 1})`}
                    className="h-7 px-2.5 rounded-lg text-[12px] bg-raised hover:bg-[#3a3b3f] flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: markerColor(s.label) }} />
              {s.label} <span className="text-faint">{s.bars}</span>
            </button>
          ))}
        </div>
      </div>
      <div>
        <SectionTitle>Choices</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          {g.choices.map((c) => (
            <span key={c} className="h-6 px-2 rounded-md text-[11.5px] bg-pastel-lavender text-on-pastel inline-flex items-center">{c}</span>
          ))}
        </div>
      </div>
      <div className="text-[12px] text-muted">From {g.zips.length} zips: <span className="font-mono text-faint">{g.zips.join(' · ')}</span></div>
    </section>
  )
}

/** What survives the next press of G. */
function KeepPanel({ g, keep, setKeep }: { g: Generation; keep: KeepToggles; setKeep: (p: Partial<KeepToggles>) => void }) {
  const toggle = (on: boolean, label: string, onClick: () => void, detail?: string) => (
    <button onClick={onClick}
            className={cx('w-full h-9 px-3 rounded-lg flex items-center gap-2 text-left text-[12.5px] transition-colors',
              on ? 'bg-accent/15 text-accent shadow-[0_0_0_1px_rgb(226_195_95/0.35)]' : 'bg-raised text-muted hover:text-text')}>
      <span className={cx('w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center text-[10px]',
        on ? 'border-accent bg-accent text-on-accent' : 'border-[#55565b]')}>{on ? '✓' : ''}</span>
      <span className="flex-1">{label}</span>
      {detail && <span className="text-faint text-[11px] truncate max-w-[150px]">{detail}</span>}
    </button>
  )
  return (
    <section className="rounded-2xl border border-line bg-panel-2 px-4 py-4 space-y-1.5">
      <SectionTitle>Keep when generating</SectionTitle>
      {toggle(keep.structure, 'Structure', () => setKeep({ structure: !keep.structure }), `${g.sections.length} sections`)}
      {toggle(keep.key, 'Key', () => setKeep({ key: !keep.key }), g.key ?? 'no key')}
      {KEEPABLE.filter((r) => g.picks[r]).map((role) => {
        const on = keep.lanes.includes(role)
        return toggle(on, ROLE_LABEL[role] ?? role,
          () => setKeep({ lanes: on ? keep.lanes.filter((r) => r !== role) : [...keep.lanes, role] }),
          g.picks[role]?.source_code)
      })}
    </section>
  )
}
