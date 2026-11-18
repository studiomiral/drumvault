import { useEffect, useState } from 'react'
import { api } from '../api'
import { onBassRendering } from '../audio/tempo'
import type { Generation } from '../generate/generator'
import { LOOP_CHANCE, LOOP_MAX_BPM, LOOP_MAX_SHIFT, type VocalTake } from '../generate/vocals'
import { useApp } from '../store/app'
import { newVocalLoop, setVocalLoopOptions, useGenerate, vocalLoopsFitting } from '../store/generate'
import { playableVocals, useVocals } from '../store/vocals'
import { takeName } from '../vocals/plan'
import { Module } from './Module'
import { Button } from './ui'

/**
 * Vocals (SCOPE.md §6.11a): Splice vocal loops and phrases. Some new tracks (G) sing an imported one
 * that fits their key and tempo, placed where and as loud as the user's own tracks sing. **Add a
 * vocal from Splice** / **New vocal loop** draws one at random for the track on screen from all that
 * fit: the Vocal Loops page's, and the Splice folder's (imported when drawn). One vocal per track.
 */
export function VocalLoopsPanel({ g, fixed }: { g: Generation; fixed?: boolean }) {
  const opts = useGenerate((s) => s.settings.vocalLoops)
  const vocals = useVocals((s) => s.vocals)
  const busy = useVocals((s) => s.making)
  const setView = useApp((s) => s.setView)
  const toast = useApp((s) => s.toast)
  const [rendering, setRendering] = useState(false)
  useEffect(() => onBassRendering(setRendering, 'vocal'), [])
  const loops = (playableVocals(vocals) as VocalTake[]).filter((t) => t.source === 'splice')
  const unused = loops.filter((t) => !t.usedIn.length)
  const rel = g.picks.vocal?.rel_path
  const sung = vocals.find((v) => rel === `Vocals/${v.id}/vocal.wav`)
  const sings = sung?.source === 'splice' ? sung : null
  // What could be drawn for this track: imported loops, and the Splice folder's by name.
  const [fit, setFit] = useState<{ library: number; folder: number } | null>(null)
  useEffect(() => {
    let live = true
    setFit(null)
    void vocalLoopsFitting(g.key, g.project.bpm).then((f) => live && setFit(f))
    return () => { live = false }
  }, [g.key, g.project.bpm, vocals])
  const others = fit ? fit.library - (sings ? 1 : 0) + fit.folder : null
  const draw = async () => {
    try {
      const r = await newVocalLoop()
      if (r === 'none') toast('info', `No other Splice vocal loop fits ${g.key ?? 'this track'} at ${g.project.bpm} BPM.`)
      else if (r === 'gone') toast('info', 'The track changed meanwhile: no vocal was placed.')
      else if (typeof r === 'object') toast('info', `${sings ? 'Now singing' : 'Added'} ${r.placed}${r.from === 'folder' ? ' (from the Splice folder, now on the Vocal Loops page)' : ''}.`)
    } catch (e) {
      toast('error', `No vocal was added: ${(e as Error).message}`)
    }
  }
  const summary = sings ? <><span className="text-text">{takeName(sings)}</span> · {sings.splice?.pack ?? 'Splice'}</>
    : sung ? 'A made vocal (ElevenLabs)'
      : !opts.enabled ? 'No vocal · G sings none in new tracks'
        : `No vocal · G sings a Splice loop in some new tracks`

  return (
    <Module id="vocalloops" title="Vocals" fixed={fixed} enabled={opts.enabled} onEnabled={(enabled) => setVocalLoopOptions({ enabled })}
            enabledTitle={opts.enabled ? `On: some new generations (${Math.round(LOOP_CHANCE * 100)} %) sing a Splice vocal loop that fits` : 'Off: new generations sing no Splice vocal loop'}
            summary={summary}>
      <div className="space-y-2.5 text-[12.5px]">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={() => void draw()} disabled={busy || others === 0}
                  title={others === 0 ? 'No other Splice vocal loop fits this track\'s key and tempo'
                    : 'A Splice vocal loop at random from all that fit this track (the Vocal Loops page and the Splice folder); the rest stays (⌘Z goes back)'}>
            {busy ? 'Finding a vocal…' : sung ? 'New vocal loop' : 'Add a vocal from Splice'}
          </Button>
          {sings ? (
            <span className="text-muted">
              <span className="text-text">{takeName(sings)}</span>, sung in {sings.analysis?.key ?? sings.key ?? 'no key'}
              {sings.splice?.url && <> · <button className="text-accent hover:underline" onClick={() => void api.openSplice(sings.splice!.url!)}>{sings.splice.pack ?? 'pack'}</button></>}
              {rendering && <span className="text-faint"> · rendering…</span>}
            </span>
          ) : (
            <span className="text-muted">
              {sung ? 'This track sings a made vocal (ElevenLabs): a loop would replace it. ' : 'No vocal in this track. '}
              {fit ? `${fit.library} of ${unused.length} unused loops fit ${g.key ?? 'no key'} at ${g.project.bpm} BPM, ${fit.folder} more in the Splice folder.` : 'Looking through the Splice folder…'}
            </span>
          )}
        </div>
        {busy && <p className="text-faint text-[11.5px]">A loop from the Splice folder is imported and analysed first: a few seconds.</p>}
        <p className="text-faint text-[11.5px]">
          A loop within {LOOP_MAX_SHIFT} semitones of the track key (moved into it, formants kept) and {LOOP_MAX_BPM} BPM of its tempo, never one
          that has gone out in an export. It sings where your own tracks sing and as loud against the kick. One a track draws from the Splice folder
          goes on the <button className="text-accent hover:underline" onClick={() => setView('vocalloops')}>Vocal Loops</button> page.
        </p>
      </div>
    </Module>
  )
}
