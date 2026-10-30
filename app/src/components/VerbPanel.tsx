import { useRef } from 'react'
import { BarSlider } from '../arrange/LaneHeaders'
import { setVerbOptions, useGenerate } from '../store/generate'
import { Module } from './Module'
import { cx, Segmented } from './ui'

const EVERY = [
  { value: 'none', label: 'Into drops & breaks' },
  { value: '16', label: '+ every 16 bars' },
  { value: '8', label: '+ every 8 bars' },
]

/** Reverb builds (SCOPE.md §6.6): the top loops and/or keys washing out into drops and breaks. */
export function VerbPanel() {
  const opts = useGenerate((s) => s.settings.verb)
  const dragging = useRef(false)
  const btn = 'h-7 min-w-7 px-2 rounded-md bg-raised hover:bg-[#3a3b3f] text-[12px]'
  const on = [opts.tops && 'tops', opts.keys && 'keys'].filter(Boolean).join(' and ')
  const where = `into drops and breaks${opts.every ? `, every ${opts.every} bars` : ''}`
  const summary = !opts.enabled ? 'Off: G generates without reverb builds'
    : !on ? 'On, but on no part: choose tops and/or keys'
      : <><span className="text-text">{on[0].toUpperCase() + on.slice(1)}</span> · {where} · {Math.round(opts.amount * 100)}%</>

  return (
    <Module id="verb" title="Reverb builds" enabled={opts.enabled} onEnabled={(enabled) => setVerbOptions({ enabled })}
            enabledTitle={opts.enabled ? 'On: new generations get reverb builds' : 'Off: new generations have no reverb builds'}
            summary={summary}>
      <div className="grid grid-cols-[86px_1fr] gap-y-2 items-center text-[12.5px]">
        <span className="text-muted">On</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <button className={cx(btn, opts.tops && 'bg-accent/20 text-accent')} onClick={() => setVerbOptions({ tops: !opts.tops })}
                  title="The top loops still playing wash out into the line">Top loops</button>
          <button className={cx(btn, opts.keys && 'bg-accent/20 text-accent')} onClick={() => setVerbOptions({ keys: !opts.keys })}
                  title="The keys part washes out into the line">Keys</button>
        </span>
        <span className="text-muted">Where</span>
        <span className="flex flex-wrap items-center gap-2">
          <Segmented<string> value={opts.every ? String(opts.every) : 'none'} options={EVERY}
                             onChange={(v) => setVerbOptions({ every: v === 'none' ? null : (Number(v) as 8 | 16) })} />
          <span className="text-faint text-[11.5px]">2 bars into drops and breaks{opts.every ? ', 1 bar at the others' : ''}</span>
        </span>
        <span className="text-muted">Amount</span>
        <span className="flex items-center gap-2 max-w-[360px]">
          <BarSlider className="flex-1" min={0.1} max={1} step={0.05} value={opts.amount} reset={0.6} color="#e2c35f"
                     dragging={dragging} title="How far the reverb send rises at the peak of a build (double-click: 60%)"
                     onChange={(amount) => setVerbOptions({ amount })} />
          <span className="w-10 text-right tabular-nums text-muted">{Math.round(opts.amount * 100)}%</span>
        </span>
        <span />
        <span className="text-faint text-[11.5px]">Baked into the stems on export. Per clip in Arrange: select it and set Reverb.</span>
      </div>
    </Module>
  )
}
