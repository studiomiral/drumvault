import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { playback } from '../audio/engine'
import { openGenerated } from '../arrange/persistence'
import { IconLock, IconPlay, IconSparkle, IconStar, IconStop, IconX } from '../components/icons'
import { Button, cx, Empty, PageTitle, SectionTitle } from '../components/ui'
import { BarSlider, fmtDb } from '../arrange/LaneHeaders'
import { ChoiceRow, LanePanel } from '../components/LanePanel'
import { panelOf, type Panel } from '../store/arrange'
import { CHOICE_GROUPS, choicesFor } from '../generate/choices'
import { LANES, laneRole, type Generation } from '../generate/generator'
import { markerColor } from '../lib/project'
import { laneAudible } from '../audio/graph'
import { useApp } from '../store/app'
import {
  attachPlayback, changeTrackKey, current, invalidate, laneKept, loadSamples, LOCKABLE, metaOf, next, openShortlisted, playSection, previous,
  removeShortlisted, rerollLane, saveTempo, setLaneVolume, shortlistId, toggleLane, toggleLaneKeep, toggleStar, useGenerate,
} from '../store/generate'
import { ALL_KEYS } from '../lib/camelot'
import type { ZipListItem } from '../types/api'

const PANEL_KEY = 'drumvault.generate.panel'

function savedPanel(): Panel {
  try {
    return (JSON.parse(localStorage.getItem(PANEL_KEY) ?? 'null') as Panel | null) ?? { module: 'bass' }
  } catch {
    return { module: 'bass' }
  }
}

/** Create → Generate (SCOPE.md §6.6): cycle through generated arrangements, send one to Arrange. */
export function GenerateView() {
  const { libraryVersion, setView } = useApp()
  const { samples, history, index, settings, shortlist } = useGenerate()
  const g = history[index] ?? null
  const [playing, setPlaying] = useState(playback.playing)
  const [loading, setLoading] = useState(playback.loading)
  const [sending, setSending] = useState(false)
  const [panel, setPanelState] = useState<Panel>(savedPanel)
  const setPanel = (p: Panel) => {
    setPanelState(p)
    try {
      localStorage.setItem(PANEL_KEY, JSON.stringify(p))
    } catch {
      // not remembered
    }
  }
  const star = shortlistId(g, shortlist)

  useEffect(() => attachPlayback(), [])
  useEffect(() => playback.subscribe(() => {
    setPlaying(playback.playing)
    setLoading(playback.loading)
  }), [])
  useEffect(() => {
    void loadSamples()
  }, [libraryVersion])

  const send = async () => {
    const cur = current()
    if (!cur || sending) return
    setSending(true)
    try {
      // The project keeps its generation: its lanes keep their modules in Arrange.
      await openGenerated({ ...cur.project, generation: metaOf(cur) })
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
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        toggleStar()
      } else if (/^[1-9]$/.test(e.key)) {
        playSection(Number(e.key) - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="app-drag topbar-art h-14 shrink-0 flex items-center gap-4 px-6 border-b border-line">
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
              {loading ? <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                : playing ? <IconStop className="w-4 h-4" /> : <IconPlay className="w-4 h-4" />}
            </button>
            <span className="text-muted text-[12.5px] ml-1">
              {g ? <>Generation <span className="text-text font-medium">{index + 1}</span> of {history.length}</> : 'Press G to generate'}
            </span>
            <button onClick={toggleStar} disabled={!g} title={star ? 'On the shortlist (S): click to take it off' : 'Star (S): keep it on the shortlist, saved in the library'}
                    className={cx('h-9 w-9 rounded-full flex items-center justify-center transition-colors disabled:opacity-40',
                      star ? 'text-accent bg-accent/15' : 'surface-raised text-muted hover:text-text')}>
              <IconStar className="w-4 h-4" filled={!!star} />
            </button>
            <div className="flex-1" />
            <span className="text-faint text-[11.5px]">G / → next · ← back · Space play · S star · 1–9 sections · Enter send</span>
            <Button variant="primary" className="h-9 px-4 text-[13px]" onClick={() => void send()} disabled={!g || sending}>
              Send to Arrange ⏎
            </Button>
          </section>

          {shortlist.length > 0 && <Shortlist />}
          {g ? (
            <div className="grid grid-cols-1 min-[1280px]:grid-cols-[minmax(0,1fr)_460px] gap-5 items-start">
              <div className="space-y-5 min-w-0">
                <Overview g={g} panel={panel} onPanel={setPanel} />
                <Details g={g} />
              </div>
              <div className="min-[1280px]:sticky min-[1280px]:top-0">
                <LanePanel g={g} panel={panel} onPanel={setPanel} where="generate" />
              </div>
            </div>
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

/** Tempo per track: the library BPM, a fixed BPM, or a random whole BPM from a range. */
function TempoOption({ sel }: { sel: string }) {
  const { settings, set } = useGenerate()
  const library = useApp((s) => s.settings?.engine.library_bpm ?? 124)
  const t = settings.tempo
  const mode = !t ? 'library' : t.min === t.max ? 'fixed' : 'range'
  const update = (tempo: typeof t) => {
    set({ settings: { ...settings, tempo } })
    saveTempo(tempo)
    invalidate()
  }
  const num = (v: string, fallback: number) => {
    const n = Math.round(Number(v))
    return n >= 60 && n <= 200 ? n : fallback
  }
  const field = 'w-14 h-7 rounded-lg bg-[rgb(0_0_0/0.25)] px-2 text-text text-[12px] outline-none shadow-[0_0_0_1px_rgb(255_255_255/0.08)] tabular-nums'
  return (
    <span className="flex items-center gap-1.5 ml-2"
          title="Other tempos keep the pitch: loops are sliced onto the grid, FX are stretched by the engine">
      Tempo
      <select className={sel} value={mode} onChange={(e) => {
        const m = e.target.value
        update(m === 'library' ? null : m === 'fixed' ? { min: t?.min ?? library, max: t?.min ?? library }
          : { min: Math.min(t?.min ?? library - 4, library - 4), max: Math.max(t?.max ?? library + 4, library + 4) })
      }}>
        <option value="library">Library ({library})</option>
        <option value="fixed">Fixed</option>
        <option value="range">Range</option>
      </select>
      {t && mode === 'fixed' && (
        <input key={`f${t.min}`} className={field} defaultValue={t.min}
               onBlur={(e) => { const v = num(e.target.value, t.min); update({ min: v, max: v }) }}
               onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      )}
      {t && mode === 'range' && (
        <>
          <input key={`a${t.min}`} className={field} defaultValue={t.min}
                 onBlur={(e) => { const v = num(e.target.value, t.min); update({ min: Math.min(v, t.max - 1), max: t.max }) }}
                 onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          –
          <input key={`b${t.max}`} className={field} defaultValue={t.max}
                 onBlur={(e) => { const v = num(e.target.value, t.max); update({ min: t.min, max: Math.max(v, t.min + 1) }) }}
                 onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        </>
      )}
    </span>
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
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted relative">
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
      <TempoOption sel={sel} />
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

/**
 * The arrangement at a glance: sections (click to play from there), lanes, playhead. Each lane:
 * its volume, a lock that keeps it on the next press of G, mute, solo, made again; its name opens
 * it in the lane panel.
 */
function Overview({ g, panel, onPanel }: { g: Generation; panel: Panel; onPanel: (p: Panel) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(900)
  const LABEL_W = 214
  const RIGHT_W = 110
  const BAND = 30
  const ROW = 26
  useGenerate((s) => s.settings.mix)  // redraw the sliders when a volume changes
  const toggles = useGenerate((s) => s.lanes)
  const keep = useGenerate((s) => s.keep)
  const isOpen = (name: string) => JSON.stringify(panelOf(name)) === JSON.stringify(panel)
  const dragging = useRef(false)
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
      const px = (w - LABEL_W - RIGHT_W) / totalBeats
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
        x.fillStyle = 'rgba(255,255,255,0.03)'
        x.fillRect(LABEL_W, y, w - LABEL_W - RIGHT_W, ROW - 4)
        x.globalAlpha = laneAudible(lane, g.project.lanes) ? 1 : 0.3
        for (const c of g.project.clips) {
          if (c.laneId !== lane.id) continue
          const x0 = bx(c.start)
          const cw = Math.max(2, c.length * px - 1)
          x.fillStyle = c.filter ? `${lane.color}66` : `${lane.color}b3`
          x.beginPath()
          x.roundRect(x0, y + 1, cw, ROW - 6, 3)
          x.fill()
        }
        x.globalAlpha = 1
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
  }, [g, w, h, totalBeats, toggles])

  const onClick = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const beat = ((e.clientX - r.left - LABEL_W) / (w - LABEL_W - RIGHT_W)) * totalBeats
    if (beat < 0 || beat >= totalBeats) return
    if (e.clientY - r.top <= BAND) {
      const i = g.sections.findIndex((s) => beat >= s.start * 4 && beat < (s.start + s.bars) * 4)
      if (i >= 0) playSection(i)
    } else {
      void playback.play(Math.floor(beat / 4) * 4)
    }
  }

  return (
    <section ref={wrap} className="relative rounded-2xl border border-line bg-panel-2 overflow-hidden">
      <canvas ref={ref} style={{ width: w, height: h }} className="block cursor-pointer" onClick={onClick} />
      {/* Lane names and volume sliders, as in Arrange's lane headers. */}
      {g.project.lanes.map((lane, li) => {
        const role = laneRole(lane.name)
        return (
          <div key={lane.id} className="absolute left-0 flex items-center gap-2 pl-1.5 pr-3 text-[11.5px]"
               style={{ top: BAND + li * ROW + 4, height: ROW - 4, width: LABEL_W }}>
            <button className={cx('w-[64px] h-full px-1.5 rounded-md truncate text-left transition-colors',
                      isOpen(lane.name) ? 'bg-accent-soft text-accent' : 'text-muted hover:text-text hover:bg-raised')}
                    title={`Open ${lane.name} in the lane panel`} onClick={() => onPanel(panelOf(lane.name))}>{lane.name}</button>
            <BarSlider className="flex-1 min-w-0" min={-60} max={6} step={0.5} value={lane.volumeDb}
                       reset={LANES.find((l) => l.role === role)?.volumeDb ?? 0} color={lane.color} dragging={dragging}
                       title={`Volume ${fmtDb(lane.volumeDb)} (double-click: starting level)`}
                       onChange={(v) => role && setLaneVolume(role, v)} />
            <span className="w-10 text-right text-[10.5px] tabular-nums text-faint">{fmtDb(lane.volumeDb)}</span>
          </div>
        )
      })}
      {/* Keep, mute, solo and a new sound for just this lane. */}
      {g.project.lanes.map((lane, li) => {
        const role = laneRole(lane.name)
        const kept = role && laneKept(role, keep)
        return (
        <div key={`r-${lane.id}`} className="absolute right-0 flex items-center justify-end gap-1 pr-3"
             style={{ top: BAND + li * ROW + 4, height: ROW - 4, width: RIGHT_W }}>
          {role && LOCKABLE.includes(role) && (
            <button title={kept ? `Kept: the next press of G keeps ${lane.name}` : `Keep ${lane.name} on the next press of G`}
                    onClick={() => toggleLaneKeep(role)}
                    className={cx('w-5 h-5 rounded flex items-center justify-center', kept ? 'bg-accent/20 text-accent' : 'text-faint hover:text-text hover:bg-raised')}>
              <IconLock className="w-3.5 h-3.5" open={!kept} />
            </button>
          )}
          <button title="Mute" onClick={() => toggleLane(lane.name, 'mute')}
                  className={cx('w-5 h-5 rounded text-[10.5px] font-bold', lane.mute ? 'bg-warn text-on-accent' : 'bg-raised text-muted hover:text-text')}>M</button>
          <button title="Solo" onClick={() => toggleLane(lane.name, 'solo')}
                  className={cx('w-5 h-5 rounded text-[10.5px] font-bold', lane.solo ? 'bg-brand text-on-accent' : 'bg-raised text-muted hover:text-text')}>S</button>
          <button title={lane.name === 'Bass' ? 'New bassline or patch and where it plays; the rest stays' : `New ${lane.name.toLowerCase()}: another sound and pattern; the rest stays`}
                  onClick={() => {
                    if (!rerollLane(lane.id)) useApp.getState().toast('info', `No other sound for ${lane.name} in the library.`)
                  }}
                  className="w-5 h-5 rounded bg-raised text-accent hover:bg-accent/20 flex items-center justify-center">
            <IconSparkle className="w-3.5 h-3.5" />
          </button>
        </div>
        )
      })}
    </section>
  )
}

/** Keep the structure or the key on the next press of G. */
function KeepLock({ on, what, onClick }: { on: boolean; what: string; onClick: () => void }) {
  return (
    <button onClick={onClick} title={on ? `Kept: the next press of G keeps the ${what}` : `Keep the ${what} on the next press of G`}
            className={cx('w-6 h-6 rounded-md flex items-center justify-center', on ? 'bg-accent/15 text-accent' : 'text-faint hover:text-text hover:bg-raised')}>
      <IconLock className="w-3.5 h-3.5" open={!on} />
    </button>
  )
}

/** The track: length, key, structure, its choices (to change, or lock for every next one), its sources. */
function Details({ g }: { g: Generation }) {
  const { keep, set } = useGenerate()
  const setKeep = (patch: Partial<typeof keep>) => {
    set({ keep: { ...keep, ...patch } })
    invalidate()
  }
  const bpm = g.project.bpm
  const secs = Math.round((g.project.lengthBars * 4 * 60) / bpm)
  const choices = choicesFor(g)
  return (
    <section className="rounded-2xl border border-line bg-panel-2 px-5 py-4 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-display text-[22px]">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span>
        <span className="text-muted">{g.project.lengthBars} bars · {bpm} BPM</span>
        <label className="rounded-md pl-2 h-[22px] inline-flex items-center gap-1 bg-pastel-yellow text-on-pastel text-[12px] font-medium"
               title="Another key for this track: bass and keys move, disco hits are pitched, FX that don't fit are swapped; the drums stay (← goes back)">
          Key
          <select className="bg-transparent font-medium outline-none cursor-pointer pr-1" value={g.key ?? ''}
                  onChange={(e) => e.target.value && changeTrackKey(e.target.value)}>
            {!g.key && <option value="">none</option>}
            {ALL_KEYS.map((k) => <option key={k.label} value={k.label}>{k.label} ({k.camelot})</option>)}
          </select>
        </label>
        <KeepLock on={keep.key} what="key" onClick={() => setKeep({ key: !keep.key })} />
        <span className="text-faint text-[11.5px] ml-auto">seed {g.seed}</span>
      </div>
      <div>
        <SectionTitle right={<KeepLock on={keep.structure} what="structure" onClick={() => setKeep({ structure: !keep.structure })} />}>Structure</SectionTitle>
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
        <p className="text-faint text-[11.5px] -mt-1 mb-3">Change one to hear the track with it (the lanes it shapes are made again, ← goes back); lock it for every next track.</p>
        <div className="grid grid-cols-1 min-[1500px]:grid-cols-2 gap-x-8 gap-y-4">
          {CHOICE_GROUPS.map((group) => {
            const list = choices.filter((c) => c.group === group)
            return list.length > 0 && (
              <div key={group}>
                <div className="text-[11.5px] font-medium text-text mb-1.5">{group}</div>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1.5 items-center">
                  {list.map((c) => <ChoiceRow key={c.rule} c={c} g={g} lockable />)}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div>
        <SectionTitle>Also</SectionTitle>
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

/** Starred generations (S), saved in the library: click one to hear it again. */
function Shortlist() {
  const { shortlist, history, index } = useGenerate()
  const on = shortlistId(history[index] ?? null, shortlist)
  return (
    <section className="flex items-center gap-2 overflow-x-auto pb-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-faint shrink-0 mr-1">Shortlist</span>
      {shortlist.map((item, i) => {
        const { g } = item
        const secs = Math.round((g.project.lengthBars * 4 * 60) / g.project.bpm)
        return (
          <span key={item.id} className={cx('h-8 pl-2.5 pr-1 rounded-lg text-[12px] inline-flex items-center gap-1.5 shrink-0',
            on === item.id ? 'bg-accent-soft text-accent' : 'bg-raised text-muted')}>
            <button className="inline-flex items-center gap-1.5 hover:text-text" onClick={() => openShortlisted(item.id)}
                    title={`Starred ${new Date(item.savedAt).toLocaleString()}: ${g.zips.join(' · ')}`}>
              <IconStar className="w-3.5 h-3.5" filled />
              <span className="font-medium">{i + 1}</span>
              <span>{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span>
              <span className="text-faint">{g.key ?? 'no key'} · {g.project.bpm}</span>
            </button>
            <button className="w-5 h-5 rounded flex items-center justify-center text-faint hover:text-bad" title="Take it off the shortlist"
                    onClick={() => window.confirm('Take this generation off the shortlist?') && removeShortlisted(item.id)}>
              <IconX className="w-3 h-3" />
            </button>
          </span>
        )
      })}
    </section>
  )
}
