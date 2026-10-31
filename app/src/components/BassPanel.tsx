import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { playback } from '../audio/engine'
import { onBassRendering } from '../audio/tempo'
import { BarSlider } from '../arrange/LaneHeaders'
import { isGenerated } from '../generate/bassline'
import { bassBars, transposeTo, type Generation } from '../generate/generator'
import { attempt, useApp } from '../store/app'
import { loadBass, toggleFavoritePreset, useBass } from '../store/bass'
import { newBassline, setBassOptions, setGenerationBass, shiftOctave, useGenerate } from '../store/generate'
import { IconStar } from './icons'
import { Module } from './Module'
import { PatchOctave } from './PatchOctave'
import { PianoRoll, type RollNote } from './PianoRoll'
import { Button, cx, inputClass } from './ui'

const NO_FAVORITES: string[] = []

/** Bass (SCOPE.md §6.7): the generation's bassline through a Serum 2 patch, browsable in place. */
export function BassPanel({ g, fixed }: { g: Generation; fixed?: boolean }) {
  const { basslines, presets, loaded, error } = useBass()
  const opts = useGenerate((s) => s.settings.bass)
  const keep = useGenerate((s) => s.keep)
  useGenerate((s) => s.history)  // re-render after a bass change
  // Default outside the selector: a new [] on every read makes the store re-render forever.
  const favorites = useApp((s) => s.settings?.bass?.favorites) ?? NO_FAVORITES
  const setView = useApp((s) => s.setView)
  const [rendering, setRendering] = useState(false)
  useEffect(() => onBassRendering(setRendering), [])
  const [editing, setEditing] = useState(false)
  const [saveName, setSaveName] = useState('')
  const dragging = useRef(false)
  const b = g.bass
  const step = <T,>(list: T[], cur: T | undefined, d: number, same: (a: T, b: T) => boolean) => {
    const i = cur ? list.findIndex((x) => same(x, cur)) : -1
    return list[(((i + d) % list.length) + list.length) % list.length]
  }
  const random = <T,>(list: T[], cur: T | undefined) => {
    const others = list.filter((x) => x !== cur)
    return others.length ? others[Math.floor(Math.random() * others.length)] : cur
  }
  const btn = 'h-7 min-w-7 px-2 rounded-md bg-raised hover:bg-[#3a3b3f] text-[12px] disabled:opacity-40'
  const missing = !basslines.length ? 'No bass MIDI to learn from yet: add your MIDI zips under Bass on the MIDI page.'
    : !presets.length ? 'No Serum 2 patches for Bass yet: tick their folders under Bass on the MIDI page.' : null

  const kept = [keep.bassline && 'bassline', keep.patch && 'patch'].filter(Boolean).join(' and ')
  const summary = !opts.enabled ? 'Off: G generates without bass'
    : missing ?? (b ? <>
        <span className="text-text">{b.midi.name}</span> · {bassBars(b)} bar{bassBars(b) === 1 ? '' : 's'} · {b.preset.name}
        {kept && <span className="text-accent"> · keeping the {kept}</span>}
      </> : 'On: the next generation gets a bass')

  return (
    <Module id="bass" title="Bass" fixed={fixed} enabled={opts.enabled} onEnabled={(on) => setBassOptions({ enabled: on })}
            enabledTitle={opts.enabled ? 'On: G writes a bass for every new generation' : 'Off: new generations have no bass'}
            summary={summary}
            status={<>
              {rendering && <span className="text-[11.5px] text-accent">Rendering with Serum 2…</span>}
              {error && <span className="text-[11.5px] text-bad" title={error}>Engine: {error.slice(0, 80)}</span>}
            </>}>
      {!loaded ? <p className="text-muted text-[12.5px]">Loading basslines and patches…</p>
        : missing ? (
          <p className="text-muted text-[12.5px]">{missing}{' '}
            <Button variant="ghost" onClick={() => setView('midi')}>Open MIDI</Button>
          </p>
        ) : !b ? (
          <p className="text-muted text-[12.5px]">{opts.enabled ? 'Press G for a generation with bass.' : 'Bass is off for new generations.'}</p>
        ) : (
          <div className="grid grid-cols-[86px_1fr] gap-y-2 items-center text-[12.5px]">
            <span className="text-muted">Patch</span>
            <span className="flex flex-wrap items-center gap-1.5 min-w-0">
              <button className={btn} title="Previous patch" onClick={() => setGenerationBass({ preset: step(presets, b.preset, -1, (x, y) => x.path === y.path) })}>‹</button>
              <span className="truncate font-medium" title={b.preset.path}>{b.preset.name}</span>
              <span className="text-faint truncate text-[11.5px]">{b.preset.folder}</span>
              <button className={btn} title="Next patch" onClick={() => setGenerationBass({ preset: step(presets, b.preset, 1, (x, y) => x.path === y.path) })}>›</button>
              <button className={btn} title="A random patch" onClick={() => setGenerationBass({ preset: random(presets, b.preset) })}>Random</button>
              <button className={cx(btn, favorites.includes(b.preset.path) && 'text-accent')} title="Star: picked more often"
                      onClick={() => toggleFavoritePreset(b.preset.path)}>
                <IconStar className="w-3.5 h-3.5" filled={favorites.includes(b.preset.path)} />
              </button>
              <span className="text-faint text-[11.5px] ml-1">{presets.length} patches</span>
            </span>
            <span className="text-muted">Bassline</span>
            <span className="flex flex-wrap items-center gap-1.5 min-w-0">
              <button className={btn} title="Write a new bassline, learned from your MIDI basslines" onClick={() => newBassline()}>New bassline</button>
              {([null, 1, 2, 4] as const).map((n) => (
                <button key={n ?? 'any'} className={cx(btn, opts.bars === n && 'bg-accent/20 text-accent')}
                        title={n ? `New basslines are ${n} bar${n === 1 ? '' : 's'} long (and write one now)` : 'New basslines as long as your MIDI basslines tend to be'}
                        onClick={() => { setBassOptions({ bars: n }); newBassline(n) }}>{n ?? 'Any'}</button>
              ))}
              <span className="truncate font-medium ml-1">{b.midi.name}</span>
              <span className="text-faint text-[11.5px] whitespace-nowrap">{b.midi.key_label ?? 'no key'} · {b.midi.bars} bar{b.midi.bars === 1 ? '' : 's'}</span>
              <span className="text-faint text-[11.5px] ml-1 whitespace-nowrap">learned from {basslines.length} bassline{basslines.length === 1 ? '' : 's'}</span>
            </span>
            <span className="text-muted">Transpose</span>
            <span className="flex items-center gap-1.5">
              <button className={btn} onClick={() => setGenerationBass({ transpose: Math.max(-24, b.transpose - 1) })}>−</button>
              <span className="w-16 text-center tabular-nums">{b.transpose > 0 ? '+' : ''}{b.transpose} st</span>
              <button className={btn} onClick={() => setGenerationBass({ transpose: Math.min(24, b.transpose + 1) })}>+</button>
              <button className={btn} title="An octave down: the patch remembers it for the next tracks" onClick={() => void shiftOctave('bass', -12)}>−12</button>
              <button className={btn} title="An octave up: the patch remembers it for the next tracks" onClick={() => void shiftOctave('bass', 12)}>+12</button>
              <PatchOctave role="bass" path={b.preset.path} />
              <span className="text-faint text-[11.5px] ml-1">
                {g.key ? `into ${g.key} (${transposeTo(b.midi.key_label, g.key) >= 0 ? '+' : ''}${transposeTo(b.midi.key_label, g.key)} st from ${b.midi.key_label ?? '?'})` : 'no track key'}
              </span>
            </span>
            <span className="text-muted">Notes</span>
            <span className="flex items-center gap-1.5">
              <button className={cx(btn, editing && 'bg-accent/20 text-accent')} onClick={() => {
                setEditing(!editing)
                setSaveName(`${b.midi.name} edit`)
              }}>{editing ? 'Close piano roll' : 'Edit notes'}</button>
              {b.notes && <span className="text-accent text-[11.5px]">edited for this track</span>}
              {b.notes && <button className={btn} title={isGenerated(b.midi) ? 'Back to the line as it was written' : 'Back to the imported MIDI'}
                                  onClick={() => setGenerationBass({ notes: undefined, bars: undefined })}>Revert</button>}
            </span>
            {editing && (
              <div className="col-span-2 mt-1 space-y-2">
                <PianoRoll notes={(b.notes ?? b.midi.notes).map(([s, l, p, v]) => [s, l, p + b.transpose, v] as RollNote)}
                           bars={bassBars(b)} playhead={() => bassPlayhead(g)}
                           onChange={(notes, bars) => setGenerationBass({ notes: notes.map(([s, l, p, v]) => [s, l, p - b.transpose, v] as RollNote), bars })} />
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="text-faint">Edits apply to this track only.</span>
                  <span className="flex-1" />
                  <input className={cx(inputClass, 'w-48 h-7 text-[12px]')} value={saveName} onChange={(e) => setSaveName(e.target.value)} />
                  <Button onClick={() => void saveBassline(g, saveName)} title="Add the loop to your MIDI library, for future generations">
                    Save as new bassline
                  </Button>
                </div>
              </div>
            )}
            <span className="text-muted">Sidechain</span>
            <span className="flex items-center gap-2 max-w-[360px]">
              <BarSlider className="flex-1" min={0} max={1} step={0.05} value={opts.sidechain} reset={0.6} color="#fda4af"
                         dragging={dragging} title="How far the bass ducks under every kick (double-click: 60%)"
                         onChange={(v) => setBassOptions({ sidechain: v })} />
              <span className="w-10 text-right tabular-nums text-muted">{Math.round(opts.sidechain * 100)}%</span>
            </span>
          </div>
        )}
    </Module>
  )
}

/** Playhead inside the bass loop, when it is in a bass clip of this generation. */
function bassPlayhead(g: Generation): number | null {
  if (!playback.playing || !g.bass) return null
  const pos = playback.position()
  const c = g.project.clips.find((k) => k.type === 'audio' && k.bass && (k.bass.role ?? 'bass') === 'bass' && pos >= k.start && pos < k.start + k.length)
  if (!c || c.type !== 'audio') return null
  const L = bassBars(g.bass) * 4
  return (((pos - c.start + c.trimBeats) % L) + L) % L
}

/** Save the generation's (edited) bassline to the MIDI library and use it from now on. */
async function saveBassline(g: Generation, name: string): Promise<void> {
  const b = g.bass
  if (!b) return
  const label = name.trim() || 'Bassline'
  const id = await attempt(() => api.saveMidi({ name: label, notes: b.notes ?? b.midi.notes, bars: bassBars(b), keyLabel: b.midi.key_label }))
  if (id == null) return
  await loadBass()
  const saved = useBass.getState().basslines.find((m) => m.id === id)
  if (saved) setGenerationBass({ midi: saved, notes: undefined, bars: undefined })
  useApp.getState().toast('info', `Saved "${label}" to your basslines.`)
}
