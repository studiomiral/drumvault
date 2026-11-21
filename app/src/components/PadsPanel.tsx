import { useEffect, useState } from 'react'
import { onBassRendering } from '../audio/tempo'
import type { Generation } from '../generate/generator'
import { useApp } from '../store/app'
import { useBass } from '../store/bass'
import { newPad, setPadsOptions, useGenerate } from '../store/generate'
import type { AudioClip } from '../types/project'
import { Module } from './Module'
import { Button } from './ui'

/** Pads (SCOPE.md §6.7b): the layer made for breakdowns, a pad's chord or a reese's note through a Serum 2 patch. */
export function PadsPanel({ g, fixed }: { g: Generation; fixed?: boolean }) {
  const opts = useGenerate((s) => s.settings.pads)
  const patches = useBass((s) => s.padPresets.length)
  const setView = useApp((s) => s.setView)
  const toast = useApp((s) => s.toast)
  const [rendering, setRendering] = useState(false)
  useEffect(() => onBassRendering(setRendering, 'pad'), [])
  const render = g.project.clips.find((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'pad')?.bass
  const kind = render?.midiName === 'Reese' ? 'a reese' : 'a pad'
  const what = render ? `${kind} ${render.midiName === 'Reese' ? `on ${g.key?.replace(/m$/, '') ?? 'the root'}` : `holding ${g.key ?? 'the key'}`}` : ''
  const reroll = () => {
    if (!newPad()) toast('info', g.key ? 'No other break layer came out: tick more folders on the Pads tab.' : 'This track has no key: a break layer needs one.')
  }
  const summary = !opts.enabled ? 'Off: G generates without a break layer'
    : !patches ? 'No pad or reese patches yet: tick their folders on the Pads tab'
      : render ? <><span className="text-text">{render.presetName}</span> · {what} in the breakdowns</>
        : 'On: none in this track (most tracks with breakdowns get one)'

  return (
    <Module id="pads" title="Pads" fixed={fixed} enabled={opts.enabled} onEnabled={(enabled) => setPadsOptions({ enabled })}
            enabledTitle={opts.enabled ? 'On: new generations may get a pad or a reese in their breakdowns' : 'Off: new generations have no breakdown layer'}
            summary={summary}>
      {!patches ? (
        <p className="text-muted text-[12.5px]">No patches yet: tick the Serum 2 folders with your pads and reeses on the Pads tab.{' '}
          <Button variant="ghost" onClick={() => setView('pads')}>Open Pads</Button>
        </p>
      ) : (
        <div className="space-y-2.5 text-[12.5px]">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={reroll} title="Another patch for the breakdown layer; the rest of the track stays (⌘Z goes back)">
              {render ? 'New break layer' : 'Add a break layer'}
            </Button>
            {render ? (
              <span className="text-muted">
                <span className="text-text">{render.presetName}</span>: {what}{rendering && <span className="text-faint"> · rendering with Serum 2…</span>}
              </span>
            ) : (
              <span className="text-muted">{opts.enabled ? `No break layer in this track. ${patches} patch${patches === 1 ? '' : 'es'} to draw from.` : 'The break layer is off for new generations.'}</span>
            )}
          </div>
          <p className="text-faint text-[11.5px]">
            A layer made for the breakdowns: it comes in once the breakdown has stripped down, its filter opening and its level rising
            into the next part. A patch with "reese" (or bass, sub) in its name, folder or tags holds the key's root, low; any other
            holds the key's chord.
          </p>
        </div>
      )}
    </Module>
  )
}
