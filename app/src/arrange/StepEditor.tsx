import { useEffect, useRef } from 'react'
import { audition } from '../audio/audition'
import { playback } from '../audio/engine'
import { Button, cx, Segmented } from '../components/ui'
import { BEATS_PER_BAR, formatPosition, loopBeats, PRESETS, presetSteps, resizePattern, STEPS_PER_BAR, STEPS_PER_BEAT } from '../lib/project'
import { useProject } from '../store/project'
import type { Clip, PatternClip, Velocity } from '../types/project'

/** Bottom panel: step editor for the open pattern clip, or an inspector for one selected clip. */
export function BottomPanel() {
  const { project, selection, editingClip, openEditor } = useProject()
  const editing = project.clips.find((c) => c.id === editingClip)
  if (editing?.type === 'pattern') return <StepEditor clip={editing} onClose={() => openEditor(null)} />
  const single = selection.length === 1 ? project.clips.find((c) => c.id === selection[0]) : undefined
  if (single) return <ClipInspector clip={single} />
  return (
    <div className="h-10 shrink-0 border-t border-line bg-panel px-4 flex items-center text-[12px] text-faint gap-4">
      <span>Drag loops and one-shots from the library onto a lane.</span>
      <span>Drag clip edges to extend · ⌥ snaps to beats · ⌥-drag copies · ⌘D duplicates · double-click a pattern to edit it</span>
    </div>
  )
}

function GainSlider({ clip }: { clip: Clip }) {
  const edit = useProject((s) => s.edit)
  return (
    <label className="flex items-center gap-2 text-[12px] text-muted">
      Gain
      <input type="range" min={-30} max={6} step={0.5} value={clip.gainDb} className="w-28 accent-[#7c3aed]"
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

function ClipInspector({ clip }: { clip: Clip }) {
  const openEditor = useProject((s) => s.openEditor)
  return (
    <div className="h-10 shrink-0 border-t border-line bg-panel px-4 flex items-center gap-4 text-[12px]">
      <span className="font-medium truncate max-w-[360px]" title={clip.sample.relPath}>{clip.sample.name}</span>
      <span className="text-muted">
        at {formatPosition(clip.start)} · {clip.length / BEATS_PER_BAR} bars
        {clip.type === 'audio' && <> · {loopBeats(clip) / BEATS_PER_BAR}-bar loop{clip.trimBeats ? ` · trimmed ${clip.trimBeats} beats` : ''}</>}
      </span>
      <GainSlider clip={clip} />
      {clip.type === 'pattern' && <Button variant="secondary" onClick={() => openEditor(clip.id)}>Edit pattern</Button>}
    </div>
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
                      v ? 'bg-[#ede8fb]' : barStart ? 'bg-[#e9e5f4]' : beatStart ? 'bg-[#f0edf8]' : 'bg-[#f6f4fb]',
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
