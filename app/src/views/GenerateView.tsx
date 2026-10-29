import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { playback } from '../audio/engine'
import { openGenerated } from '../arrange/persistence'
import { IconPlay, IconSparkle, IconStar, IconStop } from '../components/icons'
import { Button, cx, Empty, inputClass, PageTitle, SectionTitle } from '../components/ui'
import { Module } from '../components/Module'
import { BarSlider, fmtDb } from '../arrange/LaneHeaders'
import { bassBars, KEEPABLE, LANES, laneRole, transposeTo, type Generation, type Role } from '../generate/generator'
import { isGenerated } from '../generate/bassline'
import { PianoRoll, type RollNote } from '../components/PianoRoll'
import { onBassRendering } from '../audio/tempo'
import { loadBass, toggleFavoritePreset, useBass } from '../store/bass'
import { markerColor } from '../lib/project'
import { laneAudible } from '../audio/graph'
import { attempt, useApp } from '../store/app'
import {
  attachPlayback, current, invalidate, loadSamples, newBassline, next, playSection, previous, rerollLane, saveTempo, setBassOptions,
  setGenerationBass, setLaneVolume, toggleLane, useGenerate, type KeepToggles,
} from '../store/generate'
import type { ZipListItem } from '../types/api'

const ROLE_LABEL: Partial<Record<Role, string>> = Object.fromEntries(LANES.map((l) => [l.role, l.name]))

/** Create → Generate (SCOPE.md §6.6): cycle through generated arrangements, send one to Arrange. */
export function GenerateView() {
  const { libraryVersion, setView } = useApp()
  const { samples, history, index, settings, keep, set } = useGenerate()
  const g = history[index] ?? null
  const [playing, setPlaying] = useState(playback.playing)
  const [loading, setLoading] = useState(playback.loading)
  const [sending, setSending] = useState(false)

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
            <div className="flex-1" />
            <span className="text-faint text-[11.5px]">G / → next · ← back · Space play · 1–9 sections · Enter send</span>
            <Button variant="primary" className="h-9 px-4 text-[13px]" onClick={() => void send()} disabled={!g || sending}>
              Send to Arrange ⏎
            </Button>
          </section>

          {g ? (
            <>
              <Overview g={g} />
              <BassPanel g={g} />
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

/** The arrangement at a glance: sections (click to play from there), lanes, playhead. */
function Overview({ g }: { g: Generation }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(900)
  const LABEL_W = 214
  const RIGHT_W = 84
  const BAND = 30
  const ROW = 26
  useGenerate((s) => s.settings.mix)  // redraw the sliders when a volume changes
  const toggles = useGenerate((s) => s.lanes)
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
          <div key={lane.id} className="absolute left-0 flex items-center gap-2 pl-3 pr-3 text-[11.5px]"
               style={{ top: BAND + li * ROW + 4, height: ROW - 4, width: LABEL_W }}>
            <span className="w-[52px] truncate text-muted" title={lane.name}>{lane.name}</span>
            <BarSlider className="flex-1 min-w-0" min={-60} max={6} step={0.5} value={lane.volumeDb}
                       reset={LANES.find((l) => l.role === role)?.volumeDb ?? 0} color={lane.color} dragging={dragging}
                       title={`Volume ${fmtDb(lane.volumeDb)} (double-click: starting level)`}
                       onChange={(v) => role && setLaneVolume(role, v)} />
            <span className="w-10 text-right text-[10.5px] tabular-nums text-faint">{fmtDb(lane.volumeDb)}</span>
          </div>
        )
      })}
      {/* Mute, solo and a new sound for just this lane. */}
      {g.project.lanes.map((lane, li) => (
        <div key={`r-${lane.id}`} className="absolute right-0 flex items-center justify-end gap-1 pr-3"
             style={{ top: BAND + li * ROW + 4, height: ROW - 4, width: RIGHT_W }}>
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
      ))}
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

const NO_FAVORITES: string[] = []

/** Bass (SCOPE.md §6.7): the generation's bassline through a Serum 2 patch, browsable in place. */
function BassPanel({ g }: { g: Generation }) {
  const { basslines, presets, loaded, error } = useBass()
  const opts = useGenerate((s) => s.settings.bass)
  const keep = useGenerate((s) => s.keep)
  useGenerate((s) => s.history)  // re-render after a bass change
  // Default outside the selector: a new [] on every read makes the store re-render forever.
  const favorites = useApp((s) => s.settings?.bass?.favorites) ?? NO_FAVORITES
  const setView = useApp((s) => s.setView)
  const [rendering, setRendering] = useState(false)
  useEffect(() => onBassRendering(setRendering), [])
  const [editing, setEditing] = useState(false)
  const [saveName, setSaveName] = useState('')
  const dragging = useRef(false)
  const b = g.bass
  const step = <T,>(list: T[], cur: T | undefined, d: number, same: (a: T, b: T) => boolean) => {
    const i = cur ? list.findIndex((x) => same(x, cur)) : -1
    return list[(((i + d) % list.length) + list.length) % list.length]
  }
  const random = <T,>(list: T[], cur: T | undefined) => {
    const others = list.filter((x) => x !== cur)
    return others.length ? others[Math.floor(Math.random() * others.length)] : cur
  }
  const btn = 'h-7 min-w-7 px-2 rounded-md bg-raised hover:bg-[#3a3b3f] text-[12px] disabled:opacity-40'
  const missing = !basslines.length ? 'No bass MIDI to learn from yet: add your MIDI zips on the MIDI page.'
    : !presets.length ? 'No Serum 2 patches yet: choose preset folders under Settings → Bass.' : null

  const kept = [keep.bassline && 'bassline', keep.patch && 'patch'].filter(Boolean).join(' and ')
  const summary = !opts.enabled ? 'Off: G generates without bass'
    : missing ?? (b ? <>
        <span className="text-text">{b.midi.name}</span> · {bassBars(b)} bar{bassBars(b) === 1 ? '' : 's'} · {b.preset.name}
        {kept && <span className="text-accent"> · keeping the {kept}</span>}
      </> : 'On: the next generation gets a bass')

  return (
    <Module id="bass" title="Bass" enabled={opts.enabled} onEnabled={(on) => setBassOptions({ enabled: on })}
            enabledTitle={opts.enabled ? 'On: G writes a bass for every new generation' : 'Off: new generations have no bass'}
            summary={summary}
            status={<>
              {rendering && <span className="text-[11.5px] text-accent">Rendering with Serum 2…</span>}
              {error && <span className="text-[11.5px] text-bad" title={error}>Engine: {error.slice(0, 80)}</span>}
            </>}>
      {!loaded ? <p className="text-muted text-[12.5px]">Loading basslines and patches…</p>
        : missing ? (
          <p className="text-muted text-[12.5px]">{missing}{' '}
            {!basslines.length && <Button variant="ghost" onClick={() => setView('midi')}>Open MIDI</Button>}
            {!presets.length && basslines.length > 0 && <Button variant="ghost" onClick={() => setView('settings')}>Open Settings</Button>}
          </p>
        ) : !b ? (
          <p className="text-muted text-[12.5px]">{opts.enabled ? 'Press G for a generation with bass.' : 'Bass is off for new generations.'}</p>
        ) : (
          <div className="grid grid-cols-[86px_1fr] gap-y-2 items-center text-[12.5px]">
            <span className="text-muted">Patch</span>
            <span className="flex items-center gap-1.5 min-w-0">
              <button className={btn} title="Previous patch" onClick={() => setGenerationBass({ preset: step(presets, b.preset, -1, (x, y) => x.path === y.path) })}>‹</button>
              <span className="truncate font-medium" title={b.preset.path}>{b.preset.name}</span>
              <span className="text-faint truncate text-[11.5px]">{b.preset.folder}</span>
              <button className={btn} title="Next patch" onClick={() => setGenerationBass({ preset: step(presets, b.preset, 1, (x, y) => x.path === y.path) })}>›</button>
              <button className={btn} title="A random patch" onClick={() => setGenerationBass({ preset: random(presets, b.preset) })}>Random</button>
              <button className={cx(btn, favorites.includes(b.preset.path) && 'text-accent')} title="Star: picked more often"
                      onClick={() => toggleFavoritePreset(b.preset.path)}>
                <IconStar className="w-3.5 h-3.5" filled={favorites.includes(b.preset.path)} />
              </button>
              <span className="text-faint text-[11.5px] ml-1">{presets.length} patches</span>
            </span>
            <span className="text-muted">Bassline</span>
            <span className="flex items-center gap-1.5 min-w-0">
              <button className={btn} title="Write a new bassline, learned from your MIDI basslines" onClick={() => newBassline()}>New bassline</button>
              {([null, 1, 2, 4] as const).map((n) => (
                <button key={n ?? 'any'} className={cx(btn, opts.bars === n && 'bg-accent/20 text-accent')}
                        title={n ? `New basslines are ${n} bar${n === 1 ? '' : 's'} long (and write one now)` : 'New basslines as long as your MIDI basslines tend to be'}
                        onClick={() => { setBassOptions({ bars: n }); newBassline(n) }}>{n ?? 'Any'}</button>
              ))}
              <span className="truncate font-medium ml-1">{b.midi.name}</span>
              <span className="text-faint text-[11.5px] whitespace-nowrap">{b.midi.key_label ?? 'no key'} · {b.midi.bars} bar{b.midi.bars === 1 ? '' : 's'}</span>
              <span className="text-faint text-[11.5px] ml-1 whitespace-nowrap">learned from {basslines.length} bassline{basslines.length === 1 ? '' : 's'}</span>
            </span>
            <span className="text-muted">Transpose</span>
            <span className="flex items-center gap-1.5">
              <button className={btn} onClick={() => setGenerationBass({ transpose: Math.max(-24, b.transpose - 1) })}>−</button>
              <span className="w-16 text-center tabular-nums">{b.transpose > 0 ? '+' : ''}{b.transpose} st</span>
              <button className={btn} onClick={() => setGenerationBass({ transpose: Math.min(24, b.transpose + 1) })}>+</button>
              <button className={btn} title="Down / up an octave" onClick={() => setGenerationBass({ transpose: Math.max(-24, b.transpose - 12) })}>−12</button>
              <button className={btn} onClick={() => setGenerationBass({ transpose: Math.min(24, b.transpose + 12) })}>+12</button>
              <span className="text-faint text-[11.5px] ml-1">
                {g.key ? `into ${g.key} (${transposeTo(b.midi.key_label, g.key) >= 0 ? '+' : ''}${transposeTo(b.midi.key_label, g.key)} st from ${b.midi.key_label ?? '?'})` : 'no track key'}
              </span>
            </span>
            <span className="text-muted">Notes</span>
            <span className="flex items-center gap-1.5">
              <button className={cx(btn, editing && 'bg-accent/20 text-accent')} onClick={() => {
                setEditing(!editing)
                setSaveName(`${b.midi.name} edit`)
              }}>{editing ? 'Close piano roll' : 'Edit notes'}</button>
              {b.notes && <span className="text-accent text-[11.5px]">edited for this track</span>}
              {b.notes && <button className={btn} title={isGenerated(b.midi) ? 'Back to the line as it was written' : 'Back to the imported MIDI'}
                                  onClick={() => setGenerationBass({ notes: undefined, bars: undefined })}>Revert</button>}
            </span>
            {editing && (
              <div className="col-span-2 mt-1 space-y-2">
                <PianoRoll notes={(b.notes ?? b.midi.notes).map(([s, l, p, v]) => [s, l, p + b.transpose, v] as RollNote)}
                           bars={bassBars(b)} playhead={() => bassPlayhead(g)}
                           onChange={(notes, bars) => setGenerationBass({ notes: notes.map(([s, l, p, v]) => [s, l, p - b.transpose, v] as RollNote), bars })} />
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="text-faint">Edits apply to this track only.</span>
                  <span className="flex-1" />
                  <input className={cx(inputClass, 'w-48 h-7 text-[12px]')} value={saveName} onChange={(e) => setSaveName(e.target.value)} />
                  <Button onClick={() => void saveBassline(g, saveName)} title="Add the loop to your MIDI library, for future generations">
                    Save as new bassline
                  </Button>
                </div>
              </div>
            )}
            <span className="text-muted">Sidechain</span>
            <span className="flex items-center gap-2 max-w-[360px]">
              <BarSlider className="flex-1" min={0} max={1} step={0.05} value={opts.sidechain} reset={0.6} color="#fda4af"
                         dragging={dragging} title="How far the bass ducks under every kick (double-click: 60%)"
                         onChange={(v) => setBassOptions({ sidechain: v })} />
              <span className="w-10 text-right tabular-nums text-muted">{Math.round(opts.sidechain * 100)}%</span>
            </span>
          </div>
        )}
    </Module>
  )
}

/** Playhead inside the bass loop, when it is in a bass clip of this generation. */
function bassPlayhead(g: Generation): number | null {
  if (!playback.playing || !g.bass) return null
  const pos = playback.position()
  const c = g.project.clips.find((k) => k.type === 'audio' && k.bass && pos >= k.start && pos < k.start + k.length)
  if (!c || c.type !== 'audio') return null
  const L = bassBars(g.bass) * 4
  return (((pos - c.start + c.trimBeats) % L) + L) % L
}

/** Save the generation's (edited) bassline to the MIDI library and use it from now on. */
async function saveBassline(g: Generation, name: string): Promise<void> {
  const b = g.bass
  if (!b) return
  const label = name.trim() || 'Bassline'
  const id = await attempt(() => api.saveMidi({ name: label, notes: b.notes ?? b.midi.notes, bars: bassBars(b), keyLabel: b.midi.key_label }))
  if (id == null) return
  await loadBass()
  const saved = useBass.getState().basslines.find((m) => m.id === id)
  if (saved) setGenerationBass({ midi: saved, notes: undefined, bars: undefined })
  useApp.getState().toast('info', `Saved "${label}" to your basslines.`)
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
      {g.bass && toggle(keep.bassline, 'Bassline', () => setKeep({ bassline: !keep.bassline }), g.bass.midi.name)}
      {g.bass && toggle(keep.patch, 'Bass patch', () => setKeep({ patch: !keep.patch }), g.bass.preset.name)}
      {KEEPABLE.filter((r) => g.picks[r]).map((role) => {
        const on = keep.lanes.includes(role)
        return toggle(on, ROLE_LABEL[role] ?? role,
          () => setKeep({ lanes: on ? keep.lanes.filter((r) => r !== role) : [...keep.lanes, role] }),
          g.picks[role]?.source_code)
      })}
    </section>
  )
}
