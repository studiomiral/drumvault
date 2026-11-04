import { useEffect, useRef, useState } from 'react'
import { BarSlider } from '../arrange/LaneHeaders'
import { onBassRendering } from '../audio/tempo'
import type { Generation } from '../generate/generator'
import { useApp } from '../store/app'
import { newDrone, setDroneOptions, useGenerate } from '../store/generate'
import { useHits } from '../store/hits'
import type { AudioClip, DroneRhythm, DroneWarp } from '../types/project'
import { Module } from './Module'
import { Button } from './ui'

const WHERE: Record<string, string> = { drops: 'in the drops', all: 'all through the track', inner: 'between the intro and the outro' }
const RHYTHM: Record<DroneRhythm, string> = {
  pump: 'pumping with the kick', gate8: 'gated in 8ths', gate16: 'gated in 16ths', swell: 'swelling to every offbeat',
  dotted: 'gated in dotted 8ths', chop: 'chopped in 16ths',
}
const WARP: Record<DroneWarp, string> = { none: '', slow2: 'slowed down 2×', slow4: 'slowed down 4×', reverse: 'reversed' }

/** Drones (SCOPE.md §6.10): which Drones page sample this track runs under it, how, and the sidechain. */
export function DronePanel({ g, fixed }: { g: Generation; fixed?: boolean }) {
  const opts = useGenerate((s) => s.settings.drones)
  const samples = useHits((s) => s.hits.filter((h) => h.kind === 'drone').length)
  const setView = useApp((s) => s.setView)
  const toast = useApp((s) => s.toast)
  const dragging = useRef(false)
  const [rendering, setRendering] = useState(false)
  useEffect(() => onBassRendering(setRendering, 'drone'), [])
  const render = g.project.clips.find((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'drone')?.bass
  const where = WHERE[String(g.rules.droneAt)] ?? ''
  const how = render?.drone ? [RHYTHM[render.drone.rhythm], WARP[render.drone.warp ?? 'none'],
    g.rules.droneOctave ? `an octave ${Number(g.rules.droneOctave) < 0 ? 'down' : 'up'}` : ''].filter(Boolean).join(', ') : ''
  const reroll = () => {
    if (!newDrone()) toast('info', 'No other drone came out: add more samples on the Drones page.')
  }
  const summary = !opts.enabled ? 'Off: G generates without drones'
    : !samples ? 'No drone samples yet: add them on the Drones page'
      : render ? <><span className="text-text">{render.presetName}</span> · {where}</>
        : 'On: none in this track (some tracks get one)'

  return (
    <Module id="drones" title="Drones" fixed={fixed} enabled={opts.enabled} onEnabled={(enabled) => setDroneOptions({ enabled })}
            enabledTitle={opts.enabled ? 'On: some new generations run a drone under the track' : 'Off: new generations have no drone'}
            summary={summary}>
      {!samples ? (
        <p className="text-muted text-[12.5px]">No drones yet: drop pads, ambiences and sustained textures on the Drones page.{' '}
          <Button variant="ghost" onClick={() => setView('drones')}>Open Drones</Button>
        </p>
      ) : (
        <div className="space-y-2.5 text-[12.5px]">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={reroll}
                    title="Another drone for this track: another sample, place, rhythm or warp; the rest stays (← goes back)">
              {render ? 'New drone' : 'Add a drone'}
            </Button>
            {render ? (
              <span className="text-muted">
                <span className="text-text">{render.presetName}</span> {where}, {how}
                {rendering && <span className="text-faint"> · rendering…</span>}
              </span>
            ) : (
              <span className="text-muted">{opts.enabled ? `No drone in this track. Some tracks get one, from your ${samples} drone sample${samples === 1 ? '' : 's'}.` : 'Drones are off for new generations.'}</span>
            )}
          </div>
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
            <span className="text-muted">Sidechain</span>
            <span className="flex items-center gap-2 max-w-[360px]">
              <BarSlider className="flex-1" min={0} max={1} step={0.05} value={opts.sidechain} reset={0.6} color="#99f6e4"
                         dragging={dragging} title="How far the drone ducks under every kick (double-click: 60%)"
                         onChange={(v) => setDroneOptions({ sidechain: v })} />
              <span className="w-10 text-right tabular-nums text-muted">{Math.round(opts.sidechain * 100)}%</span>
            </span>
          </div>
          <p className="text-faint text-[11.5px]">
            Each track takes the sample its own way (an octave, slowed down or reversed, from another part of it), washes it in reverb and loops it in the track key; where it plays, its rhythm and warp are the track's choices below.
          </p>
        </div>
      )}
    </Module>
  )
}
