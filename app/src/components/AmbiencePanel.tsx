import { useEffect, useState } from 'react'
import { onBassRendering } from '../audio/tempo'
import type { Generation } from '../generate/generator'
import { useApp } from '../store/app'
import { newBed, setAmbienceOptions, useGenerate } from '../store/generate'
import { useHits } from '../store/hits'
import type { AudioClip } from '../types/project'
import { Module } from './Module'
import { Button } from './ui'

/** Ambience (SCOPE.md §6.10a): the very quiet texture under the track, from the Ambience page. */
export function AmbiencePanel({ g, fixed }: { g: Generation; fixed?: boolean }) {
  const opts = useGenerate((s) => s.settings.ambience)
  const textures = useHits((s) => s.hits.filter((h) => h.kind === 'ambience').length)
  const setView = useApp((s) => s.setView)
  const toast = useApp((s) => s.toast)
  const [rendering, setRendering] = useState(false)
  useEffect(() => onBassRendering(setRendering, 'ambience'), [])
  const render = g.project.clips.find((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'ambience')?.bass
  const reroll = () => {
    if (!newBed()) toast('info', 'No other texture came out: add more on the Ambience page.')
  }
  const summary = !opts.enabled ? 'Off: G generates without an ambience bed'
    : !textures ? 'No textures yet: add them on the Ambience page'
      : render ? <><span className="text-text">{render.presetName}</span> · under the track, very quiet</>
        : 'On: none in this track (most tracks get one)'

  return (
    <Module id="ambience" title="Ambience" fixed={fixed} enabled={opts.enabled} onEnabled={(enabled) => setAmbienceOptions({ enabled })}
            enabledTitle={opts.enabled ? 'On: most new generations get a very quiet texture under them' : 'Off: new generations have no ambience bed'}
            summary={summary}>
      {!textures ? (
        <p className="text-muted text-[12.5px]">No textures yet: drop vinyl crackle, tape hiss, room tone, field recordings or tonal beds on the Ambience page.{' '}
          <Button variant="ghost" onClick={() => setView('ambience')}>Open Ambience</Button>
        </p>
      ) : (
        <div className="space-y-2.5 text-[12.5px]">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={reroll} title="Another texture under this track; the rest stays (⌘Z goes back)">
              {render ? 'New ambience' : 'Add ambience'}
            </Button>
            {render ? (
              <span className="text-muted"><span className="text-text">{render.presetName}</span>, a {render.bars}-bar seamless loop
                {render.transpose ? `, a tonal bed pitched ${render.transpose > 0 ? '+' : ''}${render.transpose} into ${render.keyLabel ?? 'the key'}` : ''}
                {rendering && <span className="text-faint"> · rendering…</span>}</span>
            ) : (
              <span className="text-muted">{opts.enabled ? `No bed in this track. Most tracks get one, from your ${textures} texture${textures === 1 ? '' : 's'}.` : 'The ambience bed is off for new generations.'}</span>
            )}
          </div>
          <p className="text-faint text-[11.5px]">
            A constant, very quiet layer from the end of the intro to the start of the outro (the DJ mix-in and mix-out stay clean),
            ducking under every kick. It plays through the silence before drops. Its level is the Ambience lane's slider.
          </p>
        </div>
      )}
    </Module>
  )
}
