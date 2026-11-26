import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BarSlider } from '../arrange/LaneHeaders'
import { ENHANCE_DEFAULTS, ENHANCE_MAX_AMOUNT } from '../audio/enhance'
import { setVocalEnhance } from '../store/generate'
import type { Lane, LaneEnhance } from '../types/project'
import { Segmented, Toggle } from './ui'

type Part = 'beef' | 'comp' | 'saturation' | 'reverb' | 'delay'

const PARTS: { key: Part; label: string; title: string }[] = [
  { key: 'beef', label: 'Beef', title: 'Body and presence: chest at 200 Hz, less box at 500 Hz, presence at 3 kHz and air on top' },
  { key: 'comp', label: 'Compression', title: "The vocal's compressor pushed harder (threshold lower, ratio higher, the level given back)" },
  { key: 'saturation', label: 'Saturation', title: 'Soft tape-style saturation, mixed in parallel: warmth and density, the peaks rounded off' },
  { key: 'reverb', label: 'Reverb', title: 'A short bright plate (1.5 s), a little pre-delay so the words stay in front' },
  { key: 'delay', label: 'Delay', title: 'Echoes in time, ducked while the vocal sings: they come out in the gaps' },
]

const TIMES: { value: LaneEnhance['delayTime']; label: string }[] = [
  { value: '1/8d', label: '1/8 dotted' },
  { value: '1/4', label: '1/4' },
]

const pct = (v: number) => `${Math.round(v * 100)}%`

/**
 * Vocal Enhance's popup (SCOPE.md §6.11c), under the lane bar's Enhance button: on or off, the
 * amount, each part, the delay's time. Each change is heard at once (and is a step of ⌘Z).
 */
export function EnhancePopup({ lane, anchor, onClose }: { lane: Lane; anchor: HTMLElement; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const e = lane.enhance ?? { ...ENHANCE_DEFAULTS, off: true }
  const on = !e.off
  const set = (patch: Partial<LaneEnhance>, label: string) => setVocalEnhance(lane.id, patch, label)

  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect()
    const r = ref.current!.getBoundingClientRect()
    const below = a.bottom + 6
    setPos({
      left: Math.max(6, Math.min(a.right - r.width, window.innerWidth - r.width - 6)),
      top: below + r.height > window.innerHeight - 6 ? Math.max(6, a.top - r.height - 6) : below,
    })
  }, [anchor])
  useEffect(() => {
    // A click elsewhere closes it (and does what it does: play, another lane); so do Esc and leaving the window.
    const down = (ev: MouseEvent) => {
      if (dragging.current || ref.current?.contains(ev.target as Node) || anchor.contains(ev.target as Node)) return
      onClose()
    }
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.stopPropagation()
      onClose()
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [anchor, onClose])

  return (
    <div ref={ref} className="fixed z-50 w-[300px] rounded-xl surface-pop p-3.5 text-[12.5px]"
         style={pos ?? { left: -9999, top: -9999 }}>
      <div className="flex items-center gap-2 mb-3">
        <span className="font-medium flex-1">Vocal Enhance</span>
        <Toggle checked={on} onChange={(v) => set({ off: !v }, v ? 'Enhance on' : 'Enhance off')}
                label="Vocal Enhance" title={on ? 'On (click: off, the vocal dry)' : 'Off (click: on)'} />
      </div>
      <div className={on ? '' : 'opacity-40 pointer-events-none'}>
        <div className="grid grid-cols-[84px_1fr_38px] gap-x-2 gap-y-2.5 items-center">
          <span className="text-text">Amount</span>
          <BarSlider min={0} max={ENHANCE_MAX_AMOUNT} step={0.05} value={e.amount} reset={ENHANCE_DEFAULTS.amount} color="#e2c35f"
                     dragging={dragging} title="All of it, together: 100% is the parts as set (double-click: 100%)"
                     onChange={(amount) => set({ amount }, 'Enhance amount')} />
          <span className="text-right tabular-nums text-muted">{pct(e.amount)}</span>
          <span className="col-span-3 h-px bg-line my-0.5" />
          {PARTS.map((p) => (
            <Row key={p.key} label={p.label} title={p.title} value={e[p.key]} reset={ENHANCE_DEFAULTS[p.key]} dragging={dragging}
                 onChange={(v) => set({ [p.key]: v }, `Enhance ${p.label.toLowerCase()}`)} />
          ))}
          <span className="text-muted">Delay time</span>
          <span className="col-span-2">
            <Segmented<LaneEnhance['delayTime']> value={e.delayTime} options={TIMES} onChange={(delayTime) => set({ delayTime }, 'Enhance delay time')} />
          </span>
        </div>
        <div className="flex items-center gap-2 mt-3.5">
          <span className="text-faint text-[11.5px] flex-1">In Vocal.wav on export.</span>
          <button className="h-6 px-2 rounded-md bg-raised hover:bg-[#3a3b3f] text-[12px] text-muted hover:text-text"
                  title="Every setting back to its default" onClick={() => set({ ...ENHANCE_DEFAULTS, off: false }, 'Enhance reset')}>
            Reset
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, title, value, reset, dragging, onChange }: {
  label: string
  title: string
  value: number
  reset: number
  dragging: React.MutableRefObject<boolean>
  onChange: (v: number) => void
}) {
  return (
    <>
      <span className="text-muted" title={title}>{label}</span>
      <BarSlider min={0} max={1} step={0.01} value={value} reset={reset} color="#f9a8d4" dragging={dragging}
                 title={`${title} (double-click: ${pct(reset)})`} onChange={onChange} />
      <span className="text-right tabular-nums text-muted">{pct(value)}</span>
    </>
  )
}
