import { useEffect, useRef } from 'react'
import { audition } from '../audio/audition'
import { playback } from '../audio/engine'
import { Button, cx, Segmented } from '../components/ui'
import { BEATS_PER_BAR, contentShift, formatPosition, loopBeats, shiftContent, PRESETS, presetSteps, resizePattern, STEPS_PER_BAR, STEPS_PER_BEAT } from '../lib/project'
import { useProject } from '../store/project'
import { BassEditor } from './BassEditor'
import type { Clip, ClipFilter, ClipReverb, PatternClip, Velocity } from '../types/project'

/** Bottom panel: step editor for the open pattern clip, or an inspector for one selected clip. */
export function BottomPanel() {
  const { project, selection, editingClip, openEditor } = useProject()
  const editing = project.clips.find((c) => c.id === editingClip)
  if (editing?.type === 'pattern') return <StepEditor clip={editing} onClose={() => openEditor(null)} />
  if (editing?.type === 'audio' && editing.bass) return <BassEditor clip={editing} onClose={() => openEditor(null)} />
  const single = selection.length === 1 ? project.clips.find((c) => c.id === selection[0]) : undefined
  if (single) return <ClipInspector clip={single} />
  return (
    <div className="h-10 shrink-0 border-t border-line bg-panel px-4 flex items-center text-[12px] text-faint gap-4">
      <span>Drag loops and one-shots from the library onto a lane.</span>
      <span>Drag clip edges to extend · snapping follows the zoom · ⌥ snaps finer · ⌥-drag copies · R duplicates · double-click a pattern to edit it</span>
    </div>
  )
}

function GainSlider({ clip }: { clip: Clip }) {
  const edit = useProject((s) => s.edit)
  return (
    <label className="flex items-center gap-2 text-[12px] text-muted">
      Gain
      <input type="range" min={-30} max={6} step={0.5} value={clip.gainDb} className="w-28 accent-[#e2c35f]"
             onChange={(e) => edit('Clip gain', (d) => {
               d.clips.find((c) => c.id === clip.id)!.gainDb = Number(e.target.value)
             }, { coalesce: `gain-${clip.id}` })}
             onDoubleClick={() => edit('Clip gain', (d) => {
               d.clips.find((c) => c.id === clip.id)!.gainDb = 0
             })} />
      <span className="w-12 tabular-nums">{clip.gainDb > 0 ? '+' : ''}{clip.gainDb.toFixed(1)} dB</span>
    </label>
  )
}

const F_MIN = 30
const F_MAX = 18000
const toSlider = (hz: number) => Math.log(hz / F_MIN) / Math.log(F_MAX / F_MIN)
const fromSlider = (v: number) => Math.round(F_MIN * (F_MAX / F_MIN) ** v)
const fmtHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz` : `${hz} Hz`)

/** Clip filter: off / low-pass / high-pass, a cutoff, optionally swept to a second cutoff. */
function FilterControl({ clip }: { clip: Clip }) {
  const edit = useProject((s) => s.edit)
  const f = clip.filter
  const set = (label: string, next: ClipFilter | null, coalesce?: string) => edit(label, (d) => {
    const c = d.clips.find((x) => x.id === clip.id)!
    if (next) c.filter = next
    else delete c.filter
  }, { coalesce })
  const slider = (hz: number, onHz: (hz: number) => void, key: string) => (
    <input type="range" min={0} max={1} step={0.001} value={toSlider(hz)} className="w-24 accent-[#e2c35f]"
           onChange={(e) => onHz(fromSlider(Number(e.target.value)))} data-key={key} />
  )
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted">
      Filter
      <select className="h-6 rounded-md bg-[rgb(0_0_0/0.25)] px-1.5 text-text text-[12px] outline-none"
              value={f?.type ?? 'off'}
              onChange={(e) => {
                const type = e.target.value
                if (type === 'off') set('Filter off', null)
                else set('Clip filter', { type: type as ClipFilter['type'], from: type === 'lowpass' ? 800 : 300, to: null, q: 0.7 })
              }}>
        <option value="off">Off</option>
        <option value="lowpass">Low-pass</option>
        <option value="highpass">High-pass</option>
      </select>
      {f && (
        <>
          {slider(f.from, (hz) => set('Filter cutoff', { ...f, from: hz }, `ff-${clip.id}`), 'from')}
          <span className="w-14 tabular-nums">{fmtHz(f.from)}</span>
          <label className="flex items-center gap-1">
            <input type="checkbox" className="accent-[#e2c35f]" checked={f.to != null}
                   onChange={(e) => set('Filter sweep', { ...f, to: e.target.checked ? (f.type === 'lowpass' ? F_MAX : F_MIN) : null })} />
            sweep to
          </label>
          {f.to != null && (
            <>
              {slider(f.to, (hz) => set('Filter sweep', { ...f, to: hz }, `ft-${clip.id}`), 'to')}
              <span className="w-14 tabular-nums">{fmtHz(f.to)}</span>
            </>
          )}
        </>
      )}
    </div>
  )
}

/** Reverb build: off, or the send from the clip's start to its end (rising late). */
function ReverbControl({ clip }: { clip: Clip }) {
  const edit = useProject((s) => s.edit)
  const v = clip.verb
  const set = (label: string, next: ClipReverb | null, coalesce?: string) => edit(label, (d) => {
    const c = d.clips.find((x) => x.id === clip.id)!
    if (next) c.verb = next
    else delete c.verb
  }, { coalesce })
  const slider = (x: number, onX: (x: number) => void, title: string) => (
    <input type="range" min={0} max={1} step={0.01} value={x} className="w-16 accent-[#e2c35f]" title={title}
           onChange={(e) => onX(Number(e.target.value))} />
  )
  const pct = (x: number) => `${Math.round(x * 100)}%`
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted"
         title="Sends the clip to the lane's reverb, rising from the start to the end of the clip; the tail rings on after it (and is in the stem)">
      Reverb
      <select className="h-6 rounded-md bg-[rgb(0_0_0/0.25)] px-1.5 text-text text-[12px] outline-none"
              value={v ? 'on' : 'off'}
              onChange={(e) => set(e.target.value === 'on' ? 'Reverb build' : 'Reverb off', e.target.value === 'on' ? { from: 0, to: 0.6 } : null)}>
        <option value="off">Off</option>
        <option value="on">Build</option>
      </select>
      {v && (
        <>
          {slider(v.from, (from) => set('Reverb build', { ...v, from }, `vf-${clip.id}`), 'Send at the clip start')}
          <span className="w-9 tabular-nums">{pct(v.from)}</span>
          →
          {slider(v.to, (to) => set('Reverb build', { ...v, to }, `vt-${clip.id}`), 'Send at the clip end')}
          <span className="w-9 tabular-nums">{pct(v.to)}</span>
        </>
      )}
    </div>
  )
}

function ClipInspector({ clip }: { clip: Clip }) {
  const openEditor = useProject((s) => s.openEditor)
  return (
    <div className="h-10 shrink-0 border-t border-line bg-panel px-4 flex items-center gap-4 text-[12px]">
      <span className="font-medium truncate max-w-[360px]" title={clip.sample.relPath}>{clip.sample.name}</span>
      <span className="text-muted">
        at {formatPosition(clip.start)} · {clip.length / BEATS_PER_BAR} bars
        {clip.type === 'audio' && <> · {loopBeats(clip) / BEATS_PER_BAR}-bar loop</>}
      </span>
      <ShiftControl clip={clip} />
      <GainSlider clip={clip} />
      <FilterControl clip={clip} />
      <ReverbControl clip={clip} />
      {clip.type === 'pattern' && <Button variant="secondary" onClick={() => openEditor(clip.id)}>Edit pattern</Button>}
    </div>
  )
}

/** Move the sound a beat earlier/later inside the clip's loop (wrapping); the clip stays put. */
function ShiftControl({ clip }: { clip: Clip }) {
  const edit = useProject((s) => s.edit)
  const shift = clip.type === 'audio' ? contentShift(clip) : null
  const move = (beats: number) => edit('Move sound in clip', (d) => {
    d.clips = d.clips.map((c) => (c.id === clip.id ? shiftContent(c, beats) : c))
  }, { coalesce: 'shift-content' })
  return (
    <span className="flex items-center gap-1 text-muted" title="Move the sound inside its loop by a beat; what falls off one end comes back at the other (⇧← / ⇧→)">
      Move sound
      <Button variant="ghost" className="px-1.5" onClick={() => move(-1)}>−1</Button>
      <Button variant="ghost" className="px-1.5" onClick={() => move(1)}>+1</Button>
      <span className="w-14 tabular-nums">{shift ? `${shift > 0 ? '+' : '−'}${Math.abs(shift)} beat${Math.abs(shift) === 1 ? '' : 's'}` : ''}</span>
    </span>
  )
}

function StepEditor({ clip, onClose }: { clip: PatternClip; onClose: () => void }) {
  const edit = useProject((s) => s.edit)
  const cells = useRef<HTMLDivElement>(null)
  const setSteps = (label: string, steps: Velocity[], patternBars = clip.patternBars) =>
    edit(label, (d) => {
      const c = d.clips.find((x) => x.id === clip.id) as PatternClip
      c.steps = steps
      c.patternBars = patternBars
    })

  // Highlight the step being played.
  useEffect(() => {
    let raf = 0
    let last = -1
    const tick = () => {
      const el = cells.current
      if (el) {
        let cur = -1
        if (playback.playing) {
          const rel = playback.position() - clip.start
          if (rel >= 0 && rel < clip.length) cur = Math.floor(rel * STEPS_PER_BEAT) % clip.steps.length
        }
        if (cur !== last) {
          el.children[last]?.classList.remove('ring-2')
          el.children[cur]?.classList.add('ring-2')
          last = cur
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [clip.start, clip.length, clip.steps.length])

  const cycle = (i: number, e: React.MouseEvent) => {
    const steps = [...clip.steps]
    const v = steps[i]
    steps[i] = (e.shiftKey || e.button === 2 ? 0 : v === 0 ? 3 : v - 1) as Velocity
    setSteps('Edit step', steps)
  }

  return (
    <div className="shrink-0 border-t border-line bg-panel px-4 py-3">
      <div className="flex items-center gap-3 mb-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Pattern</span>
        <button className="font-medium text-[12.5px] hover:text-accent truncate max-w-[300px]" title="Play the sample"
                onClick={() => clip.sample.id != null && audition.toggle({ id: clip.sample.id, rel_path: clip.sample.relPath, kind: 'oneshot' })}>
          ▶ {clip.sample.name}
        </button>
        <Segmented<string> value={String(clip.patternBars)}
                           onChange={(v) => setSteps('Pattern length', resizePattern(clip.steps, Number(v)), Number(v) as 1 | 2 | 4)}
                           options={[{ value: '1', label: '1 bar' }, { value: '2', label: '2 bars' }, { value: '4', label: '4 bars' }]} />
        {PRESETS.map((p) => (
          <Button key={p.id} variant="ghost" onClick={() => setSteps(p.label, presetSteps(p.id, clip.patternBars))}>{p.label}</Button>
        ))}
        <Button variant="ghost" onClick={() => setSteps('Clear pattern', clip.steps.map(() => 0 as Velocity))}>Clear</Button>
        <div className="flex-1" />
        <GainSlider clip={clip} />
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>
      <div ref={cells} className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${Math.min(clip.steps.length, 32)}, minmax(0, 1fr))` }}
           onContextMenu={(e) => e.preventDefault()}>
        {clip.steps.map((v, i) => {
          const beatStart = i % STEPS_PER_BEAT === 0
          const barStart = i % STEPS_PER_BAR === 0
          return (
            <button key={i} title={`Step ${i + 1} · ${['off', 'soft', 'medium', 'full'][v]} (click: cycle, shift/right-click: off)`}
                    onMouseDown={(e) => cycle(i, e)}
                    className={cx('relative h-11 rounded-md overflow-hidden ring-accent ring-offset-1 transition-colors',
                      v ? 'bg-[rgb(255_255_255/0.1)]' : barStart ? 'bg-[rgb(255_255_255/0.09)]' : beatStart ? 'bg-[rgb(255_255_255/0.065)]' : 'bg-[rgb(255_255_255/0.04)]',
                      'hover:brightness-95')}>
              {v > 0 && <span className="absolute inset-x-0 bottom-0 bg-brand" style={{ height: `${(v / 3) * 100}%` }} />}
              {barStart && <span className="absolute left-1 top-0.5 text-[9.5px] text-faint">{i / STEPS_PER_BAR + 1}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
