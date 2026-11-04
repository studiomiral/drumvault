import { useEffect, useRef, useState } from 'react'
import { BarSlider } from '../arrange/LaneHeaders'
import { onBassRendering } from '../audio/tempo'
import type { Generation } from '../generate/generator'
import { STRINGS_MAX_SHIFT } from '../generate/strings'
import { useApp } from '../store/app'
import { newStrings, setStringsOptions, useGenerate } from '../store/generate'
import { useHits } from '../store/hits'
import type { AudioClip } from '../types/project'
import { Module } from './Module'
import { Button } from './ui'

const WHERE: Record<string, string> = { drops: 'in the drops', all: 'all through the track', inner: 'between the intro and the outro' }

/** Strings (SCOPE.md §6.10): which Strings page sample this track plays under it, where, and the sidechain. */
export function StringsPanel({ g, fixed }: { g: Generation; fixed?: boolean }) {
  const opts = useGenerate((s) => s.settings.strings)
  const samples = useHits((s) => s.hits.filter((h) => h.kind === 'strings').length)
  const setView = useApp((s) => s.setView)
  const toast = useApp((s) => s.toast)
  const dragging = useRef(false)
  const [rendering, setRendering] = useState(false)
  useEffect(() => onBassRendering(setRendering, 'strings'), [])
  const render = g.project.clips.find((c): c is AudioClip => c.type === 'audio' && c.bass?.role === 'strings')?.bass
  const where = WHERE[String(g.rules.stringsAt)] ?? ''
  const moved = render?.transpose ? `moved ${Math.abs(render.transpose)} st ${render.transpose > 0 ? 'up' : 'down'} into ${g.key}` : `in ${g.key ?? 'its key'} as it is`
  const reroll = () => {
    if (!newStrings()) toast('info', `No other strings came out: add samples within ${STRINGS_MAX_SHIFT} semitones of ${g.key ?? 'the key'} on the Strings page.`)
  }
  const summary = !opts.enabled ? 'Off: G generates without strings'
    : !samples ? 'No string samples yet: add them on the Strings page'
      : render ? <><span className="text-text">{render.presetName}</span> · {where}</>
        : 'On: none in this track (some tracks get them)'

  return (
    <Module id="strings" title="Strings" fixed={fixed} enabled={opts.enabled} onEnabled={(enabled) => setStringsOptions({ enabled })}
            enabledTitle={opts.enabled ? 'On: some new generations play strings under the track' : 'Off: new generations have no strings'}
            summary={summary}>
      {!samples ? (
        <p className="text-muted text-[12.5px]">No strings yet: drop long string samples with a key on the Strings page.{' '}
          <Button variant="ghost" onClick={() => setView('strings')}>Open Strings</Button>
        </p>
      ) : (
        <div className="space-y-2.5 text-[12.5px]">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={reroll}
                    title="Other strings for this track: another sample and where it plays; the rest stays (← goes back)">
              {render ? 'New strings' : 'Add strings'}
            </Button>
            {render ? (
              <span className="text-muted">
                <span className="text-text">{render.presetName}</span> {where}, {moved}
                {rendering && <span className="text-faint"> · rendering…</span>}
              </span>
            ) : (
              <span className="text-muted">{opts.enabled ? `No strings in this track. Some tracks get them, from your ${samples} string sample${samples === 1 ? '' : 's'}.` : 'Strings are off for new generations.'}</span>
            )}
          </div>
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
            <span className="text-muted">Sidechain</span>
            <span className="flex items-center gap-2 max-w-[360px]">
              <BarSlider className="flex-1" min={0} max={1} step={0.05} value={opts.sidechain} reset={0.6} color="#99f6e4"
                         dragging={dragging} title="How far the strings duck under every kick (double-click: 60%)"
                         onChange={(v) => setStringsOptions({ sidechain: v })} />
              <span className="w-10 text-right tabular-nums text-muted">{Math.round(opts.sidechain * 100)}%</span>
            </span>
          </div>
          <p className="text-faint text-[11.5px]">
            The sample plays as it was recorded, starting again on every 8-bar line, moved into the track key with its length kept
            (only samples within {STRINGS_MAX_SHIFT} semitones of the key). Where it plays is the track's choice below.
          </p>
        </div>
      )}
    </Module>
  )
}
