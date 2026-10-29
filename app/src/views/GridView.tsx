import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { audioContext } from '../audio/context'
import { IconPlay, IconStop } from '../components/icons'
import { Button, cx, Empty, inputClass, PageTitle, Segmented, StatusChip } from '../components/ui'
import { beatsIn, blockPeaks, foldAttack, foldBeats, isDownbeat, roundMs } from '../grid/analysis'
import { gridPlayer } from '../grid/player'
import { formatBpm } from '../lib/format'
import { formatTime } from '../lib/project'
import { attempt, useApp } from '../store/app'
import type { ZipDetail, ZipListItem } from '../types/api'
import type { GridPreview } from '../types/engine'

/** The summed drum stems of one zip, ready to draw and play. */
interface Loaded {
  zipId: number
  info: GridPreview
  data: Float32Array
  sr: number
  peaks16: Float32Array
  peaks256: Float32Array
}

type FoldRange = '15' | '50' | 'beat'

const RULER_H = 22
const COARSE = 16   // peaks16 block
const FINE_SNAP = 0.015

/** Bar 1 the library is cut on now, in seconds (the same rule as the engine's grid_preview). */
function savedBarOne(d: ZipDetail): { sec: number; manual: boolean } {
  const z = d.zip
  if (z.grid_offset_override_ms != null) return { sec: z.grid_offset_override_ms / 1000, manual: true }
  const sources = (z.bpm_source_stem ?? '').split(' + ')
  const sr = d.stems.find((s) => sources.includes(s.file_name))?.sample_rate ?? 44100
  return { sec: (z.phase_samples ?? 0) / sr, manual: false }
}

const fmtMs = (sec: number) => `${sec >= 0 ? '' : '−'}${Math.abs(sec * 1000).toFixed(1)} ms`

/** Grid view (SCOPE.md §6.2a): set bar 1 of a zip by ear and eye, then re-cut it. */
export function GridView() {
  const { gridZipId, openGrid, jobs, libraryVersion, toast } = useApp()
  const [zips, setZips] = useState<ZipListItem[]>([])
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bar1, setBar1State] = useState(0)
  const [saved, setSaved] = useState<{ sec: number; manual: boolean }>({ sec: 0, manual: false })
  const [playing, setPlaying] = useState(false)
  const [metronome, setMetronome] = useState(gridPlayer.metronome)
  const [levels, setLevels] = useState({ drums: gridPlayer.level('drums'), click: gridPlayer.level('click') })
  const [foldRange, setFoldRange] = useState<FoldRange>('50')

  useEffect(() => {
    void api.listZips().then((zs) => setZips(zs.filter((z) => z.kind !== 'pack')))  // packs have no shared grid
  }, [libraryVersion])

  // No zip chosen yet: the first one that needs review, else the newest.
  const zipId = gridZipId ?? (zips.find((z) => z.status === 'needs_review') ?? zips[zips.length - 1])?.id ?? null
  const zip = zips.find((z) => z.id === zipId) ?? null
  const busy = jobs.some((j) => j.zip_id === zipId && (j.status === 'queued' || j.status === 'processing'))
  const dirty = loaded != null && Math.abs(bar1 - saved.sec) > 0.00004

  const setBar1 = useCallback((sec: number) => {
    const v = roundMs(sec)
    gridPlayer.setBar1(v)
    setBar1State(v)
  }, [])

  // Load the preview whenever the zip changes.
  useEffect(() => {
    if (zipId == null) return
    let alive = true
    gridPlayer.stop()
    setLoading(true)
    setError(null)
    setLoaded(null)
    void (async () => {
      try {
        const { info, data } = await api.gridPreview(zipId)
        const buffer = await audioContext().decodeAudioData(data)
        if (!alive) return
        const ch = buffer.getChannelData(0)
        gridPlayer.buffer = buffer
        gridPlayer.beat = 60 / info.bpm
        gridPlayer.setPosition(Math.max(0, info.bar_one_ms / 1000))
        setLoaded({ zipId, info, data: ch, sr: buffer.sampleRate, peaks16: blockPeaks(ch, COARSE), peaks256: blockPeaks(ch, 256) })
        setSaved({ sec: info.bar_one_ms / 1000, manual: info.manual })
        setBar1(info.bar_one_ms / 1000)
      } catch (e) {
        if (alive) setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [zipId, setBar1])

  // After a re-cut: pick up the bar 1 the library now uses (unless there are unsaved edits).
  useEffect(() => {
    if (zipId == null || !loaded || busy) return
    void api.zipDetail(zipId).then((d) => {
      if (!d) return
      const s = savedBarOne(d)
      if (Math.abs(bar1 - saved.sec) <= 0.00004) setBar1(s.sec)
      setSaved(s)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryVersion, busy])

  useEffect(() => gridPlayer.subscribe(() => {
    setPlaying(gridPlayer.playing)
    setMetronome(gridPlayer.metronome)
  }), [])
  useEffect(() => () => gridPlayer.stop(), [])

  const beat = loaded ? 60 / loaded.info.bpm : 0.5

  const snapToHits = () => {
    if (!loaded) return
    const { data, sr, peaks16 } = loaded
    // Coarse over a quarter beat either side, then fine around the result.
    const wide = beat / 4
    const a = foldAttack(foldBeats(peaks16, sr / COARSE, bar1, beat, wide, 240), wide)
    if (a == null) {
      toast('info', 'No clear hits to snap to.')
      return
    }
    const b = foldAttack(foldBeats(data, sr, bar1 + a, beat, FINE_SNAP, 300), FINE_SNAP)
    setBar1(bar1 + a + (b ?? 0))
  }

  const apply = async (ms: number | null) => {
    if (zipId == null) return
    await attempt(() => api.reprocessZip(zipId, { grid_offset_ms: ms }))
    if (ms != null) setSaved({ sec: ms / 1000, manual: true })
    toast('info', `Re-cutting ${zip?.source_code ?? 'the zip'} on ${ms == null ? 'the detected grid' : 'the new grid'}…`)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return
      if (e.metaKey || e.ctrlKey || e.altKey || useApp.getState().modal || !loaded) return
      if (e.key === ' ') {
        e.preventDefault()
        gridPlayer.toggle()
      } else if (e.key === 'm' || e.key === 'M') {
        gridPlayer.setMetronome(!gridPlayer.metronome)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        setBar1(bar1 + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 0.01 : 0.001))
      } else if (e.key === 'Home') {
        gridPlayer.setPosition(Math.max(0, bar1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="app-drag topbar-art h-14 shrink-0 flex items-center gap-4 px-6 border-b border-line">
        <PageTitle className="mr-3">Grid</PageTitle>
        <select className={cx(inputClass, 'w-[360px]')} value={zipId ?? ''} onChange={(e) => openGrid(Number(e.target.value))}>
          {zips.map((z) => (
            <option key={z.id} value={z.id}>
              {z.source_code}  {z.file_name}{z.status === 'needs_review' ? '  · needs review' : ''}
            </option>
          ))}
        </select>
        {zip && <StatusChip status={zip.status} />}
        <div className="flex-1" />
        {loaded && (
          <span className="text-[12px] text-faint truncate" title={loaded.info.stems.join('\n')}>
            {formatBpm(loaded.info.bpm)} BPM · {loaded.info.stems.length} drum stem{loaded.info.stems.length === 1 ? '' : 's'}
          </span>
        )}
      </header>

      {zips.length === 0 ? (
        <Empty title="No zips yet">Process a zip first; its drum stems show up here to line up with the grid.</Empty>
      ) : (
        <>
          <div className="shrink-0 flex items-center gap-3 px-6 py-3 border-b border-line">
            <button disabled={!loaded} onClick={() => gridPlayer.toggle()} title="Play / stop (Space)"
                    className={cx('w-9 h-9 rounded-full flex items-center justify-center transition-colors disabled:opacity-40',
                      playing ? 'bg-accent text-on-accent' : 'bg-raised text-text hover:bg-[#3a3b40]')}>
              {playing ? <IconStop className="w-4 h-4" /> : <IconPlay className="w-4 h-4 ml-0.5" />}
            </button>
            <Position bar1={bar1} beat={beat} />
            <div className="w-px h-6 bg-line mx-2.5" />
            <button onClick={() => gridPlayer.setMetronome(!metronome)} title="Metronome on the grid (M)"
                    className={cx('h-7 px-2.5 rounded-md border text-[12px]',
                      metronome ? 'border-accent text-accent bg-accent-soft' : 'border-line text-muted hover:text-text')}>
              Metronome
            </button>
            <Level label="Click" value={levels.click} onChange={(v) => {
              gridPlayer.setLevel('click', v)
              setLevels((l) => ({ ...l, click: v }))
            }} />
            <Level label="Drums" value={levels.drums} onChange={(v) => {
              gridPlayer.setLevel('drums', v)
              setLevels((l) => ({ ...l, drums: v }))
            }} />
            <div className="w-px h-6 bg-line mx-2.5" />
            <span className="text-muted text-[12px]">Bar 1</span>
            {[-10, -1].map((d) => (
              <Button key={d} variant="ghost" className="px-1.5" disabled={!loaded} onClick={() => setBar1(bar1 + d / 1000)}>{d}</Button>
            ))}
            <span className={cx('w-[74px] text-center tabular-nums font-medium', dirty && 'text-accent')}>{fmtMs(bar1)}</span>
            {[1, 10].map((d) => (
              <Button key={d} variant="ghost" className="px-1.5" disabled={!loaded} onClick={() => setBar1(bar1 + d / 1000)}>+{d}</Button>
            ))}
            <Button variant="ghost" disabled={!loaded} onClick={snapToHits}
                    title="Move bar 1 so the stacked hits start on the grid line">Snap to hits</Button>
            <div className="flex-1" />
            {dirty && <Button variant="ghost" onClick={() => setBar1(saved.sec)}>Revert</Button>}
            {!dirty && saved.manual && (
              <Button disabled={busy} onClick={() => void apply(null)}
                      title="Forget the hand-set bar 1 and re-cut on the detected grid">Use detected</Button>
            )}
            <Button variant="primary" disabled={!dirty || busy || !loaded}
                    onClick={() => void apply(Math.round(bar1 * 10000) / 10)}>
              {busy ? 'Re-cutting…' : 'Apply & re-cut'}
            </Button>
          </div>

          {error ? (
            <Empty title="Can't load the drum stems">{error}</Empty>
          ) : !loaded ? (
            <div className="flex-1 flex items-center justify-center text-muted">{loading ? 'Mixing the drum stems…' : ''}</div>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col gap-4 p-5">
              <section className="flex-1 min-h-[220px] rounded-2xl border border-line bg-panel-2 overflow-hidden flex flex-col">
                <div className="flex items-center gap-3 px-4 h-9 shrink-0 border-b border-line text-[12px]">
                  <span className="font-medium">All drum stems</span>
                  <span className="text-faint">
                    Drag the waveform onto the grid · ⇧ drag for fine moves · ⌘ scroll to zoom · click the ruler to play from there
                  </span>
                  <div className="flex-1" />
                  <span className="text-faint">
                    Library cut at {fmtMs(saved.sec)}{saved.manual ? ' (set by hand)' : ' (detected)'}
                  </span>
                </div>
                <Timeline loaded={loaded} bar1={bar1} onBar1={setBar1} />
              </section>
              <section className="h-[190px] shrink-0 rounded-2xl border border-line bg-panel-2 overflow-hidden flex flex-col">
                <div className="flex items-center gap-3 px-4 h-9 shrink-0 border-b border-line text-[12px]">
                  <span className="font-medium">Every beat stacked</span>
                  <span className="text-faint">All the hits on top of each other. Line them up with the centre line; drag here for fine moves.</span>
                  <div className="flex-1" />
                  <Segmented<FoldRange> value={foldRange} onChange={setFoldRange}
                                        options={[{ value: '15', label: '±15 ms' }, { value: '50', label: '±50 ms' }, { value: 'beat', label: 'Beat' }]} />
                </div>
                <Fold loaded={loaded} bar1={bar1} onBar1={setBar1} window={foldRange === 'beat' ? beat / 2 : Number(foldRange) / 1000} />
              </section>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Level({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-[12px] text-muted">
      {label}
      <input type="range" min={0} max={1} step={0.01} value={value} onChange={(e) => onChange(Number(e.target.value))}
             className="w-16 accent-accent" />
    </label>
  )
}

/** Playhead as bar.beat and time, refreshed while playing. */
function Position({ bar1, beat }: { bar1: number; beat: number }) {
  const [pos, setPos] = useState(gridPlayer.position())
  useEffect(() => {
    let raf = 0
    const loop = () => {
      setPos(gridPlayer.position())
      raf = requestAnimationFrame(loop)
    }
    const off = gridPlayer.subscribe(() => {
      cancelAnimationFrame(raf)
      if (gridPlayer.playing) loop()
      else setPos(gridPlayer.position())
    })
    if (gridPlayer.playing) loop()
    return () => {
      off()
      cancelAnimationFrame(raf)
    }
  }, [])
  const beats = Math.floor((pos - bar1) / beat + 1e-6)
  const label = beats < 0 ? '–' : `${Math.floor(beats / 4) + 1}.${(beats % 4) + 1}`
  return (
    <span className="w-[120px] tabular-nums text-[12.5px]">
      <span className="font-medium">{label}</span> <span className="text-faint">· {formatTime(pos, true)}</span>
    </span>
  )
}

/** Canvas sized to its box, drawn by `draw` (CSS px, with devicePixelRatio applied). */
function useCanvas(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current?.parentElement
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const paint = useCallback(() => {
    const c = ref.current
    if (!c || !size.w || !size.h) return
    const dpr = window.devicePixelRatio || 1
    if (c.width !== size.w * dpr || c.height !== size.h * dpr) {
      c.width = size.w * dpr
      c.height = size.h * dpr
    }
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, size.w, size.h)
    draw(g, size.w, size.h)
  }, [draw, size])
  return { ref, size, paint }
}

const C = {
  wave: 'rgba(213,222,232,0.78)',
  bar: 'rgba(226,195,95,0.6)',
  barOne: 'rgba(226,195,95,0.95)',
  beat: 'rgba(255,255,255,0.16)',
  sixteenth: 'rgba(255,255,255,0.055)',
  ruler: 'rgba(0,0,0,0.22)',
  text: 'rgba(241,241,239,0.6)',
  playhead: '#f1f1ef',
}
/** Quiet hats stay visible next to loud kicks. */
const amp = (v: number) => Math.pow(Math.min(1, v), 0.6)

/** Waveform of the stems moving under a fixed grid. Scroll and zoom are in grid time. */
function Timeline({ loaded, bar1, onBar1 }: { loaded: Loaded; bar1: number; onBar1: (sec: number) => void }) {
  const { data, sr, peaks16, peaks256, info } = loaded
  const beat = 60 / info.bpm
  const bar = 4 * beat
  const [view, setView] = useState<{ pps: number; scroll: number } | null>(null)

  const draw = useCallback((g: CanvasRenderingContext2D, w: number, h: number) => {
    if (!view) return
    const { pps, scroll } = view
    const xOf = (gridSec: number) => (gridSec - scroll) * pps
    // Ruler.
    g.fillStyle = C.ruler
    g.fillRect(0, 0, w, RULER_H)
    // Grid lines (fixed: bar 1 is at grid time 0).
    const from = scroll
    const to = scroll + w / pps
    const showSixteenths = (beat / 4) * pps >= 7
    const showBeats = beat * pps >= 6
    const barEvery = [1, 2, 4, 8, 16, 32, 64].find((n) => n * bar * pps >= 48) ?? 128
    if (showSixteenths) {
      g.fillStyle = C.sixteenth
      for (let k = Math.ceil(from / (beat / 4)); k * (beat / 4) < to; k++) if (k % 4) g.fillRect(Math.round(xOf(k * beat / 4)), RULER_H, 1, h)
    }
    for (const b of beatsIn(from, to, 0, beat)) {
      const x = Math.round(xOf(b.time))
      if (isDownbeat(b.index)) {
        const n = b.index / 4
        g.fillStyle = n === 0 ? C.barOne : C.bar
        g.fillRect(x, n % barEvery === 0 ? 0 : RULER_H, n === 0 ? 2 : 1, h)
        if (n >= 0 && n % barEvery === 0) {
          g.fillStyle = C.text
          g.font = '500 11px "Hanken Grotesk Variable", system-ui'
          g.fillText(String(n + 1), x + 4, 15)
        }
      } else if (showBeats) {
        g.fillStyle = C.beat
        g.fillRect(x, RULER_H, 1, h)
      }
    }
    // Waveform: the stems drawn at audio time - bar 1.
    const mid = RULER_H + (h - RULER_H) / 2
    const half = (h - RULER_H) / 2 - 6
    const spp = sr / pps
    const [src, block] = spp >= 512 ? [peaks256, 256] : spp >= 32 ? [peaks16, COARSE] : [data, 1]
    g.fillStyle = C.wave
    for (let x = 0; x < w; x++) {
      const t0 = (x / pps + scroll + bar1) * sr
      const i0 = Math.floor(t0 / block)
      const i1 = Math.max(i0 + 1, Math.floor((t0 + spp) / block))
      if (i1 <= 0 || i0 >= src.length) continue
      let m = 0
      for (let i = Math.max(0, i0); i < Math.min(src.length, i1); i++) {
        const v = Math.abs(src[i])
        if (v > m) m = v
      }
      const y = amp(m) * half
      if (y > 0.3) g.fillRect(x, mid - y, 1, Math.max(1, 2 * y))
    }
    // Playhead.
    const px = xOf(gridPlayer.position() - bar1)
    if (px >= 0 && px <= w) {
      g.fillStyle = C.playhead
      g.fillRect(Math.round(px), 0, 1.5, h)
    }
  }, [view, beat, bar, bar1, data, sr, peaks16, peaks256])

  const { ref, size, paint } = useCanvas(draw)

  // Start on bar 1 with 8 bars in view.
  useEffect(() => {
    if (size.w && !view) setView({ pps: size.w / (8.25 * bar), scroll: -beat / 4 })
  }, [size.w, view, bar, beat])

  useEffect(paint, [paint])

  // Follow the playhead while playing.
  useEffect(() => {
    let raf = 0
    const loop = () => {
      if (view && size.w) {
        const x = (gridPlayer.position() - bar1 - view.scroll) * view.pps
        if (x > size.w * 0.9 || x < 0) setView({ ...view, scroll: gridPlayer.position() - bar1 - (size.w * 0.1) / view.pps })
      }
      paint()
      raf = requestAnimationFrame(loop)
    }
    const run = () => {
      cancelAnimationFrame(raf)
      if (gridPlayer.playing) loop()
      else paint()
    }
    const off = gridPlayer.subscribe(run)
    run()
    return () => {
      off()
      cancelAnimationFrame(raf)
    }
  }, [paint, view, size.w, bar1])

  // Wheel: scroll, ⌘/pinch to zoom around the pointer.
  useEffect(() => {
    const c = ref.current
    if (!c || !view) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const x = e.clientX - c.getBoundingClientRect().left
      if (e.metaKey || e.ctrlKey) {
        const at = view.scroll + x / view.pps
        const pps = Math.max(size.w / (info.duration_s + bar), Math.min(sr / 2, view.pps * Math.exp(-e.deltaY * 0.01)))
        setView({ pps, scroll: at - x / pps })
      } else {
        setView({ ...view, scroll: view.scroll + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / view.pps })
      }
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  }, [ref, view, size.w, info.duration_s, bar, sr])

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!view || e.button !== 0) return
    const c = e.currentTarget
    const left = c.getBoundingClientRect().left
    const y = e.clientY - c.getBoundingClientRect().top
    const x0 = e.clientX
    const start = bar1
    if (y < RULER_H) {
      gridPlayer.setPosition(view.scroll + (x0 - left) / view.pps + bar1)
      return
    }
    c.setPointerCapture(e.pointerId)
    c.style.cursor = 'grabbing'
    let moved = false
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0
      if (Math.abs(dx) > 2) moved = true
      if (moved) onBar1(start - (dx * (ev.shiftKey ? 0.1 : 1)) / view.pps)
    }
    const up = (ev: PointerEvent) => {
      c.removeEventListener('pointermove', move)
      c.removeEventListener('pointerup', up)
      c.style.cursor = ''
      if (!moved) gridPlayer.setPosition(view.scroll + (ev.clientX - left) / view.pps + bar1)
    }
    c.addEventListener('pointermove', move)
    c.addEventListener('pointerup', up)
  }

  return (
    <div className="flex-1 min-h-0 relative">
      <canvas ref={ref} style={{ width: size.w, height: size.h }} className="absolute inset-0 block cursor-grab"
              onPointerDown={onPointerDown} />
    </div>
  )
}

/** Every beat folded onto one: drag sideways to move bar 1 precisely. */
function Fold({ loaded, bar1, onBar1, window }: { loaded: Loaded; bar1: number; onBar1: (sec: number) => void; window: number }) {
  const { data, sr, peaks16, info } = loaded
  const beat = 60 / info.bpm
  const BINS = 600
  const fold = useMemo(
    () => (window > 0.06 ? foldBeats(peaks16, sr / COARSE, bar1, beat, window, BINS) : foldBeats(data, sr, bar1, beat, window, BINS)),
    [data, peaks16, sr, bar1, beat, window])
  const attack = useMemo(() => foldAttack(fold, window), [fold, window])

  const draw = useCallback((g: CanvasRenderingContext2D, w: number, h: number) => {
    const xOf = (sec: number) => ((sec + window) / (2 * window)) * w
    const base = h - 20
    // ms ticks
    const step = [1, 2, 5, 10, 20, 50, 100].find((s) => (s / 1000 / (2 * window)) * w >= 46) ?? 200
    g.font = '500 10.5px "Hanken Grotesk Variable", system-ui'
    for (let ms = -Math.floor((window * 1000) / step) * step; ms <= window * 1000; ms += step) {
      const x = Math.round(xOf(ms / 1000))
      g.fillStyle = C.beat
      g.fillRect(x, 0, 1, base)
      g.fillStyle = C.text
      const t = ms === 0 ? '0' : `${ms > 0 ? '+' : '−'}${Math.abs(ms)}`
      g.fillText(t, x - g.measureText(t).width / 2, h - 6)
    }
    // Stacked envelope.
    let peak = 0
    for (const v of fold) peak = Math.max(peak, v)
    if (peak > 0) {
      g.beginPath()
      g.moveTo(0, base)
      for (let j = 0; j < fold.length; j++) g.lineTo(((j + 0.5) / fold.length) * w, base - amp(fold[j] / peak) * (base - 10))
      g.lineTo(w, base)
      g.closePath()
      g.fillStyle = 'rgba(213,222,232,0.28)'
      g.fill()
      g.strokeStyle = C.wave
      g.lineWidth = 1.25
      g.stroke()
    }
    // The grid line.
    g.fillStyle = C.barOne
    g.fillRect(Math.round(xOf(0)) - 1, 0, 2, base)
  }, [fold, window])

  const { ref, size, paint } = useCanvas(draw)
  useEffect(paint, [paint])

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !size.w) return
    const c = e.currentTarget
    c.setPointerCapture(e.pointerId)
    const x0 = e.clientX
    const start = bar1
    const secPerPx = (2 * window) / size.w
    const move = (ev: PointerEvent) => onBar1(start - (ev.clientX - x0) * secPerPx * (ev.shiftKey ? 0.1 : 1))
    const up = () => {
      c.removeEventListener('pointermove', move)
      c.removeEventListener('pointerup', up)
    }
    c.addEventListener('pointermove', move)
    c.addEventListener('pointerup', up)
  }

  return (
    <div className="flex-1 min-h-0 relative">
      <canvas ref={ref} style={{ width: size.w, height: size.h }} className="absolute inset-0 block cursor-ew-resize"
              onPointerDown={onPointerDown} />
      {attack != null && (
        <div className="absolute top-2 right-3 text-[11.5px] rounded-md px-2 py-0.5 bg-[rgb(0_0_0/0.35)] tabular-nums">
          {Math.abs(attack) < 0.0015 ? <span className="text-[#bfe3bb]">Hits on the grid</span>
            : <span className="text-muted">Hits {(Math.abs(attack) * 1000).toFixed(1)} ms {attack > 0 ? 'late' : 'early'}</span>}
        </div>
      )}
    </div>
  )
}
