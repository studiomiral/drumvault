import { useEffect, useState } from 'react'
import { api } from '../api'
import { onBassRendering } from '../audio/tempo'
import type { Generation } from '../generate/generator'
import { LOOP_CHANCE, LOOP_MAX_BPM, LOOP_MAX_SHIFT, loopFits, type VocalTake } from '../generate/vocals'
import { useApp } from '../store/app'
import { newVocalLoop, setVocalLoopOptions, useGenerate } from '../store/generate'
import { playableVocals, useVocals } from '../store/vocals'
import { takeName } from '../vocals/plan'
import { Module } from './Module'
import { Button } from './ui'

/**
 * Vocal Loops (SCOPE.md §6.11a): Splice vocal loops and phrases from the Vocal Loops page. Some new
 * tracks (G) sing one that fits their key and tempo, placed where and as loud as the user's own
 * tracks sing; New vocal loop gives this track another. One vocal per track: it replaces an
 * ElevenLabs take, and making one replaces it.
 */
export function VocalLoopsPanel({ g, fixed }: { g: Generation; fixed?: boolean }) {
  const opts = useGenerate((s) => s.settings.vocalLoops)
  const vocals = useVocals((s) => s.vocals)
  const setView = useApp((s) => s.setView)
  const toast = useApp((s) => s.toast)
  const [rendering, setRendering] = useState(false)
  useEffect(() => onBassRendering(setRendering, 'vocal'), [])
  const loops = (playableVocals(vocals) as VocalTake[]).filter((t) => t.source === 'splice')
  const unused = loops.filter((t) => !t.usedIn.length)
  const fitting = unused.filter((t) => loopFits(t, g.key, g.project.bpm))
  const rel = g.picks.vocal?.rel_path
  const sung = vocals.find((v) => rel === `Vocals/${v.id}/vocal.wav`)
  const sings = sung?.source === 'splice' ? sung : null
  const others = fitting.filter((t) => t.id !== sings?.id).length
  const reroll = () => {
    if (!newVocalLoop()) toast('info', `No other vocal loop fits ${g.key ?? 'this track'} at ${g.project.bpm} BPM: add more on the Vocal Loops page.`)
  }
  const summary = !opts.enabled ? 'Off: G generates without Splice vocal loops'
    : !loops.length ? 'No vocal loops yet: add them on the Vocal Loops page'
      : sings ? <><span className="text-text">{takeName(sings)}</span> · {sings.splice?.pack ?? 'Splice'}</>
        : `On: ${fitting.length} of ${unused.length} unused loops fit this track`

  return (
    <Module id="vocalloops" title="Vocal Loops" fixed={fixed} enabled={opts.enabled} onEnabled={(enabled) => setVocalLoopOptions({ enabled })}
            enabledTitle={opts.enabled ? `On: some new generations (${Math.round(LOOP_CHANCE * 100)} %) sing a Splice vocal loop that fits` : 'Off: new generations sing no Splice vocal loop'}
            summary={summary}>
      {!loops.length ? (
        <p className="text-muted text-[12.5px]">No vocal loops yet: add Splice vocal loops and phrases on the Vocal Loops page.{' '}
          <Button variant="ghost" onClick={() => setView('vocalloops')}>Open Vocal Loops</Button>
        </p>
      ) : (
        <div className="space-y-2.5 text-[12.5px]">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={reroll} disabled={!others}
                    title={others ? 'Another Splice vocal loop that fits this track; the rest stays (⌘Z goes back)' : 'No other loop fits this track\'s key and tempo'}>
              {sings ? 'New vocal loop' : 'Add a vocal loop'}
            </Button>
            {sings ? (
              <span className="text-muted">
                <span className="text-text">{takeName(sings)}</span>, sung in {sings.analysis?.key ?? sings.key ?? 'no key'}
                {sings.splice?.url && <> · <button className="text-accent hover:underline" onClick={() => void api.openSplice(sings.splice!.url!)}>{sings.splice.pack ?? 'pack'}</button></>}
                {rendering && <span className="text-faint"> · rendering…</span>}
              </span>
            ) : (
              <span className="text-muted">{sung ? 'This track sings a made vocal (ElevenLabs): a loop would replace it.' : `${others} of ${unused.length} unused loops fit ${g.key ?? 'no key'} at ${g.project.bpm} BPM.`}</span>
            )}
          </div>
          <p className="text-faint text-[11.5px]">
            A loop within {LOOP_MAX_SHIFT} semitones of the track key (moved into it, formants kept) and {LOOP_MAX_BPM} BPM of its tempo, never one
            that has gone out in an export. It sings where your own tracks sing and as loud against the kick. One vocal per track: this or a made one.
          </p>
        </div>
      )}
    </Module>
  )
}
