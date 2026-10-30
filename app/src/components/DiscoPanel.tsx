import { useEffect, useRef, useState } from 'react'
import { audition } from '../audio/audition'
import { BarSlider } from '../arrange/LaneHeaders'
import { HIT_PITCH_RANGE, hitIdOf, hitTranspose } from '../generate/disco'
import type { Generation } from '../generate/generator'
import { pitchRate } from '../lib/project'
import { useApp } from '../store/app'
import { setDiscoOptions, setHitPitchInTrack, useGenerate } from '../store/generate'
import { useHits } from '../store/hits'
import type { HitItem } from '../types/api'
import { IconPlay, IconStop } from './icons'
import { Module } from './Module'
import { Button } from './ui'

const WHERE: Record<string, string> = {
  drops: 'where drops start and halfway through', 16: 'every 16 bars of the drops', 8: 'every 8 bars of the drops',
  all: 'where drops and breaks start, and halfway through drops',
}

/** Disco hits (SCOPE.md §6.8): which of the Disco Hits page's samples this track drops, and their pitch. */
export function DiscoPanel({ g }: { g: Generation }) {
  const opts = useGenerate((s) => s.settings.disco)
  useGenerate((s) => s.history)  // re-render after a pitch change
  const { hits, loaded } = useHits()
  const setView = useApp((s) => s.setView)
  const used = (['disco', 'disco2'] as const)
    .map((role) => hits.find((h) => h.id === hitIdOf(g.picks[role]?.id)))
    .filter((h): h is HitItem => !!h)
  const where = WHERE[String(g.rules.discoAt)] ?? ''
  const summary = !opts.enabled ? 'Off: G generates without disco hits'
    : !hits.length ? 'No disco hits yet: add them on the Disco Hits page'
      : used.length ? <><span className="text-text">{used.map((h) => h.name).join(' and ')}</span> · {where}</>
        : 'On: none in this track (some tracks get one or two)'

  return (
    <Module id="disco" title="Disco Hits" enabled={opts.enabled} onEnabled={(enabled) => setDiscoOptions({ enabled })}
            enabledTitle={opts.enabled ? 'On: some new generations drop one or two disco hits' : 'Off: new generations have no disco hits'}
            summary={summary}>
      {!loaded ? <p className="text-muted text-[12.5px]">Loading disco hits…</p>
        : !hits.length ? (
          <p className="text-muted text-[12.5px]">No disco hits yet: drop stabs and brass hits on the Disco Hits page.{' '}
            <Button variant="ghost" onClick={() => setView('hits')}>Open Disco Hits</Button>
          </p>
        ) : !used.length ? (
          <p className="text-muted text-[12.5px]">
            {opts.enabled ? `No disco hits in this track. Some tracks get one or two, from your ${hits.length} hits.` : 'Disco hits are off for new generations.'}
          </p>
        ) : (
          <div className="space-y-2 text-[12.5px]">
            <p className="text-[12px] text-muted">On the 1 {where}{used.length > 1 ? ', taking turns' : ''}.</p>
            {used.map((h) => <HitRow key={h.id} hit={h} g={g} />)}
            <p className="text-faint text-[11.5px]">A pitch you set is remembered for the hit: the next tracks move it into their key the same way.</p>
          </div>
        )}
    </Module>
  )
}

function HitRow({ hit, g }: { hit: HitItem; g: Generation }) {
  const dragging = useRef(false)
  const [playing, setPlaying] = useState<number | null>(audition.playingId)
  useEffect(() => audition.subscribe(setPlaying), [])
  const clip = g.project.clips.find((c) => c.sample.relPath === hit.rel_path)
  const pitch = clip?.pitch ?? 0
  const auto = hitTranspose(hit, g.key)
  const sid = clip?.sample.id ?? 0
  const btn = 'w-7 h-7 rounded-full bg-raised hover:bg-[#3a3b3f] flex items-center justify-center text-accent shrink-0'
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)_minmax(140px,240px)_44px] gap-3 items-center">
      <button className={btn} title="Play at this pitch"
              onClick={() => audition.toggle({ id: sid, rel_path: hit.rel_path, kind: 'oneshot', rate: pitchRate(pitch) })}>
        {playing === sid ? <IconStop className="w-3.5 h-3.5" /> : <IconPlay className="w-3.5 h-3.5" />}
      </button>
      <span className="min-w-0">
        <span className="block truncate font-medium">{hit.name}</span>
        <span className="block truncate text-faint text-[11.5px]">
          {hit.key_label ? `${hit.key_label}${g.key ? ` → ${g.key}: ${auto >= 0 ? '+' : ''}${auto} st` : ''}` : 'no key: not moved'}
          {hit.key_source === 'detected' ? ' · key from the sound' : ''}
        </span>
      </span>
      <BarSlider min={-HIT_PITCH_RANGE} max={HIT_PITCH_RANGE} step={1} value={pitch} reset={auto} origin={0} color="#f0abfc"
                 dragging={dragging} title={`Pitch in semitones (double-click: the move into the track key, ${auto >= 0 ? '+' : ''}${auto})`}
                 onChange={(v) => v !== pitch && setHitPitchInTrack(hit, Math.round(v))} />
      <span className="text-right tabular-nums text-muted">{pitch > 0 ? '+' : ''}{pitch} st</span>
    </div>
  )
}
