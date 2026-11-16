import { useEffect, useState } from 'react'
import { api } from '../api'
import { onBassRendering } from '../audio/tempo'
import type { Generation } from '../generate/generator'
import { ALL_KEYS } from '../lib/camelot'
import { useApp } from '../store/app'
import { makeVocal } from '../store/generate'
import { useVocals } from '../store/vocals'
import type { ElevenStatus } from '../types/api'
import { LYRICS, PHRASES, pickLines } from '../vocals/lyrics'
import { randomVocal, takeSeconds, vocalCredits, VOCAL_MOODS, type VocalMood, type VocalVoice } from '../vocals/plan'
import { IconChevron } from './icons'
import { Module } from './Module'
import { Button, cx, inputClass } from './ui'

const WHERE: Record<string, string> = {
  drops: 'in the drops', halves: 'in the second half of every drop', drops_breaks: 'in the drops and breakdowns', breaks: 'in the breakdowns and the last drop',
}

/** A vocal drawn from the lyric bank (a chant, a pair, a phrase or two) in one of `keys`. */
const drawVocal = (bpm: number, keys: string[]) => randomVocal(bpm, keys, (n, phrases) => pickLines(n, Math.random, phrases ? PHRASES : LYRICS))

/**
 * Vocals (SCOPE.md §6.11): made in Arrange, one for each track. ElevenLabs sings a take in the
 * track's key (lines drawn, or the ones typed in), and it's placed as Generate would: its phrase,
 * its chops or both, and where. Generate itself sings none.
 */
export function VocalPanel({ g, where, fixed }: { g: Generation; where: 'generate' | 'arrange'; fixed?: boolean }) {
  const bpm = useApp((s) => s.settings?.engine.library_bpm ?? 124)
  const setView = useApp((s) => s.setView)
  const vocals = useVocals((s) => s.vocals)
  const making = useVocals((s) => s.making)
  const [eleven, setEleven] = useState<ElevenStatus | null>(null)
  // The credits left, again after each take.
  useEffect(() => {
    if (!making) void api.elevenStatus().then(setEleven)
  }, [making])
  const [rendering, setRendering] = useState(false)
  useEffect(() => onBassRendering(setRendering, 'vocal'), [])
  const [form, setForm] = useState(false)
  const [lines, setLines] = useState(() => drawVocal(bpm, ['Am']).lines.join('\n'))
  const [voice, setVoice] = useState<VocalVoice>('female')
  const [mood, setMood] = useState<VocalMood>('soulful')
  const [seconds, setSeconds] = useState(() => takeSeconds(8, bpm))

  const pick = g.picks.vocal
  const take = pick ? vocals.find((t) => pick.rel_path === `Vocals/${t.id}/vocal.wav`) : undefined
  const lanes = (name: string) => g.project.clips.some((c) => c.laneId === g.project.lanes.find((l) => l.name === name)?.id)
  const how = [lanes('Vocal') && `the phrase ${WHERE[String(g.rules.vocalAt)] ?? ''}`, lanes('Vocal Chops') && 'chops in the drops'].filter(Boolean).join(', ')
  // Sung in the track's key, so the phrase only moves to the track's tempo.
  const key = g.key
  const left = eleven?.credits ? eleven.credits.limit - eleven.credits.used : null
  const chosen = lines.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3)
  const cost = vocalCredits(seconds)
  const short = (credits: number) => left != null && left < credits
  const summary = pick ? <><span className="text-text">{pick.name}</span> · {how}</> : 'No vocal in this track'

  return (
    <Module id="vocals" title="Vocals" fixed={fixed} enabled onEnabled={() => {}} enabledTitle="Made in Arrange, one for each track" summary={summary}>
      {where === 'generate' ? (
        <p className="text-muted text-[12.5px]">
          {pick && <>This track sings <span className="text-text">{pick.name}</span>. </>}
          Vocals are made in Arrange, one for each track: send the track there to give it one.
        </p>
      ) : !eleven ? null : !eleven.hasKey ? (
        <p className="text-muted text-[12.5px]">
          Add your ElevenLabs API key in Settings to make vocals.{' '}
          <Button variant="ghost" onClick={() => setView('settings')}>Open Settings</Button>
        </p>
      ) : (
        <div className="space-y-2.5 text-[12.5px]">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" disabled={making || short(vocalCredits(takeSeconds(16, bpm)))}
                    onClick={() => void makeVocal(drawVocal(bpm, key ? [key] : ALL_KEYS.map((k) => k.label)))}
                    title="A new vocal for this track with everything drawn (lines, voice, mood), sung in its key; ⌘Z goes back">
              {making ? 'Making the vocal…' : pick ? 'New vocal' : 'Add a vocal'}
            </Button>
            {pick ? (
              <span className="text-muted">
                <span className="text-text">{pick.name}</span>{take ? ` · ${take.voice}, ${take.mood}, sung in ${take.analysis?.key ?? take.key}` : ''} · {how}
                {rendering && <span className="text-faint"> · rendering…</span>}
              </span>
            ) : <span className="text-muted">No vocal in this track yet.</span>}
          </div>
          {making && <p className="text-faint text-[11.5px]">ElevenLabs sings it, then it's split and analysed: a minute or two. You can keep working.</p>}

          <button className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-text" onClick={() => setForm(!form)}>
            <IconChevron className={cx('w-3 h-3 transition-transform', form && 'rotate-90')} />Choose the lines and voice
          </button>
          {form && (
            <div className="space-y-2 pl-4">
              <div className="flex items-start gap-2">
                <textarea className={cx(inputClass, 'w-[260px] h-[68px] py-1.5 leading-snug')} value={lines} onChange={(e) => setLines(e.target.value)}
                          title="One to three short lines, sung over and over" />
                <Button variant="ghost" onClick={() => setLines(drawVocal(bpm, ['Am']).lines.join('\n'))}
                        title="Other lines from the lyric bank: a chant, a pair, a phrase or two">New lines</Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select className={cx(inputClass, 'w-24')} value={voice} onChange={(e) => setVoice(e.target.value as VocalVoice)}>
                  <option value="female">female</option><option value="male">male</option>
                </select>
                <select className={cx(inputClass, 'w-28')} value={mood} onChange={(e) => setMood(e.target.value as VocalMood)}>
                  {VOCAL_MOODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <select className={cx(inputClass, 'w-36')} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}
                        title="Length of the take: credits go by the second">
                  {[8, 12, 16, 24].map((b) => takeSeconds(b, bpm)).map((s) => (
                    <option key={s} value={s}>{s} s · {Math.round(((s - 1) * bpm) / 240)} bars · ≈{vocalCredits(s)} cr</option>
                  ))}
                </select>
              </div>
              <Button variant="secondary" disabled={making || !chosen.length || short(cost)}
                      onClick={() => void makeVocal({ lines: chosen, voice, mood, bpm, key: key ?? null, seconds })}
                      title="A vocal with these lines and this voice, sung in the track's key; ⌘Z goes back">
                Make this vocal
              </Button>
            </div>
          )}

          <p className="text-faint text-[11.5px]">
            Sung in {key ?? 'any key'} at {bpm} BPM, about {vocalCredits(takeSeconds(12, bpm)).toLocaleString()} credits a take
            {left != null ? ` (${left.toLocaleString()} left)` : ''}. House of Tracks takes each vocal once: it's this track's alone, marked
            used when you export, and one you replace is never used again. Remake on its lanes sings it another way for no credits.
          </p>
        </div>
      )}
    </Module>
  )
}
