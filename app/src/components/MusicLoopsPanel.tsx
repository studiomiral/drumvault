import { useEffect, useState } from 'react'
import { onBassRendering } from '../audio/tempo'
import type { Generation } from '../generate/generator'
import { colorAbout, loopName, MUSIC_CHANCE, MUSIC_MAX_BPM, MUSIC_MAX_SHIFT } from '../generate/musicloops'
import { useApp } from '../store/app'
import { musicLoopsFitting, newMusicLoop, setChoice, setMusicLoopOptions, useGenerate } from '../store/generate'
import { useMusicLoops } from '../store/musicloops'
import { Module } from './Module'
import { Button } from './ui'

/**
 * Music Loops (SCOPE.md §6.11b): a house track without a piano plays a loop from the Music Loops
 * page in place of the chord stabs a third of the time, when one fits: never exported, near its
 * tempo, and never as recorded (moved 1–3 semitones into the key, coloured for the track).
 */
export function MusicLoopsPanel({ g, fixed }: { g: Generation; fixed?: boolean }) {
  const opts = useGenerate((s) => s.settings.musicLoops)
  const loops = useMusicLoops((s) => s.loops)
  const setView = useApp((s) => s.setView)
  const toast = useApp((s) => s.toast)
  const [rendering, setRendering] = useState(false)
  useEffect(() => onBassRendering(setRendering, 'music'), [])
  const m = g.music
  const fit = musicLoopsFitting(g.key, g.project.bpm)
  const others = fit.filter((l) => l.id !== m?.loop.id).length
  const house = (g.project.genre ?? 'house') === 'house'
  const summary = !house ? 'House tracks only'
    : !opts.enabled ? 'Off: G plays no music loop in new tracks'
      : m ? <><span className="text-text">{loopName(m.loop)}</span> · {m.shift > 0 ? '+' : ''}{m.shift} st</>
        : g.rules.keys === 'piano' ? 'On: this track plays a piano (no music loop with it)'
          : `On: no music loop in this track (${Math.round(MUSIC_CHANCE * 100)} % of new house tracks get one)`
  const draw = () => {
    if (!newMusicLoop()) toast('info', `No other music loop fits ${g.key ?? 'this track'} at ${g.project.bpm} BPM.`)
  }

  return (
    <Module id="musicloops" title="Music Loops" fixed={fixed} enabled={opts.enabled} onEnabled={(enabled) => setMusicLoopOptions({ enabled })}
            enabledTitle={opts.enabled ? `On: ${Math.round(MUSIC_CHANCE * 100)} % of new house tracks without a piano play a music loop in place of the stabs` : 'Off: new generations play no music loop'}
            summary={summary}>
      {!house ? (
        <p className="text-muted text-[12.5px]">Music loops are for house tracks only.</p>
      ) : !loops.length ? (
        <p className="text-muted text-[12.5px]">No music loops yet: drop some on the Music Loops page.{' '}
          <Button variant="ghost" onClick={() => setView('musicloops')}>Open Music Loops</Button>
        </p>
      ) : (
        <div className="space-y-2.5 text-[12.5px]">
          <div className="flex flex-wrap items-center gap-3">
            {m ? (
              <>
                <Button variant="secondary" onClick={draw} disabled={!others}
                        title={others ? 'Another music loop that fits this track, at random; the rest stays (⌘Z goes back)' : 'No other music loop fits this track'}>
                  New music loop
                </Button>
                <Button variant="ghost" onClick={() => setChoice('keys', 'stabs')} title="This track with chord stabs instead (⌘Z goes back)">Play stabs instead</Button>
                <span className="text-muted">
                  <span className="text-text">{loopName(m.loop)}</span>, from {m.loop.key} moved {m.shift > 0 ? '+' : ''}{m.shift} st into {g.key}
                  {rendering && <span className="text-faint"> · rendering…</span>}
                </span>
              </>
            ) : g.rules.keys === 'piano' ? (
              <span className="text-muted">This track plays a piano part: no music loop with it.</span>
            ) : (
              <>
                <Button variant="secondary" onClick={draw} disabled={!others}
                        title={others ? 'This track with a music loop that fits in place of its chord stabs (⌘Z goes back)' : 'No music loop fits this track'}>
                  Play a music loop instead of stabs
                </Button>
                <span className="text-muted">{fit.length} of {loops.filter((l) => !l.usedIn.length).length} unused loops fit {g.key ?? 'no key'} at {g.project.bpm} BPM.</span>
              </>
            )}
          </div>
          {m && <p className="text-faint text-[11.5px]">Its colour in this track: {colorAbout(m.color)}.</p>}
          <p className="text-faint text-[11.5px]">
            A loop within {MUSIC_MAX_BPM} BPM of the track tempo, never one that has gone out in an export, and never heard as recorded: always moved
            1–{MUSIC_MAX_SHIFT} semitones into the key (a track in its own key doesn't get it) and given an EQ and saturation of its own. It plays where a
            piano would: whole in the drops, carrying the big breakdown, announcing the drops. The bassline stays as it is. Lock Chords in the track's
            choices to have every next track play one.
          </p>
        </div>
      )}
    </Module>
  )
}
