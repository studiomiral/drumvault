import { useRef, useState } from 'react'
import { api } from '../api'
import { playback } from '../audio/engine'
import { bassBars, harmonyOfKeys, transposeTo, type Generation } from '../generate/generator'
import { moves, progressionName } from '../generate/harmony'
import { isGenerated } from '../generate/bassline'
import { attempt, useApp } from '../store/app'
import { loadKeys, useKeys, toggleFavoriteKeysPreset } from '../store/keys'
import { useGenerate, newKeysPart, setKeysOptions, setGenerationKeys, shiftOctave } from '../store/generate'
import { PatchOctave } from './PatchOctave'
import { PianoRoll, type RollNote } from './PianoRoll'
import { BarSlider } from '../arrange/LaneHeaders'
import { IconStar } from './icons'
import { Button, cx, inputClass } from './ui'
const NO_FAVORITES: string[] = []

/** What the Chords module says about a track's keys (folded). */
export function keysSummary(g: Generation): string | null {
  const b = g.keys
  const harmony = harmonyOfKeys(b, g.key)
  return b ? `${b.midi.name}${harmony ? ` · ${progressionName(harmony)}` : ''} · ${b.preset.name}` : null
}

/** Keys (SCOPE.md §6.7) in the Chords module: the track's keys part through a Serum 2 patch. */
export function KeysPart({ g }: { g: Generation }) {
  const { parts, presets, loaded } = useKeys()
  const opts = useGenerate((s) => s.settings.keys)
  useGenerate((s) => s.history)  // re-render after a Keys change
  // Default outside the selector: a new [] on every read makes the store re-render forever.
  const favorites = useApp((s) => s.settings?.keys?.favorites) ?? NO_FAVORITES
  const setView = useApp((s) => s.setView)
  const [editing, setEditing] = useState(false)
  const [saveName, setSaveName] = useState('')
  const dragging = useRef(false)
  const b = g.keys
  const step = <T,>(list: T[], cur: T | undefined, d: number, same: (a: T, b: T) => boolean) => {
    const i = cur ? list.findIndex((x) => same(x, cur)) : -1
    return list[(((i + d) % list.length) + list.length) % list.length]
  }
  const random = <T,>(list: T[], cur: T | undefined) => {
    const others = list.filter((x) => x !== cur)
    return others.length ? others[Math.floor(Math.random() * others.length)] : cur
  }
  const btn = 'h-7 min-w-7 px-2 rounded-md bg-raised hover:bg-[#3a3b3f] text-[12px] disabled:opacity-40'
  const missing = keysMissing(parts.length, presets.length)
  const harmony = harmonyOfKeys(b, g.key)

  return (
    <>
      {harmony && b && (
        <p className="text-[12px] text-muted mb-2">
          {moves(harmony) ? 'Chords' : 'One chord'} <span className="text-text">{progressionName(harmony)}</span>
          {g.bass ? ', picked to go with the bass riff' : ''}
        </p>
      )}
      {!loaded ? <p className="text-muted text-[12.5px]">Loading parts and patches…</p>
        : missing ? (
          <p className="text-muted text-[12.5px]">{missing}{' '}
            <Button variant="ghost" onClick={() => setView('midi')}>Open MIDI</Button>
          </p>
        ) : !b ? (
          <p className="text-muted text-[12.5px]">{opts.enabled ? 'This track has no keys.' : 'Keys are off for new generations.'}</p>
        ) : (
          <div className="grid grid-cols-[86px_1fr] gap-y-2 items-center text-[12.5px]">
            <span className="text-muted">Patch</span>
            <span className="flex flex-wrap items-center gap-1.5 min-w-0">
              <button className={btn} title="Previous patch" onClick={() => setGenerationKeys({ preset: step(presets, b.preset, -1, (x, y) => x.path === y.path) })}>‹</button>
              <span className="truncate font-medium" title={b.preset.path}>{b.preset.name}</span>
              <span className="text-faint truncate text-[11.5px]">{b.preset.folder}</span>
              <button className={btn} title="Next patch" onClick={() => setGenerationKeys({ preset: step(presets, b.preset, 1, (x, y) => x.path === y.path) })}>›</button>
              <button className={btn} title="A random patch" onClick={() => setGenerationKeys({ preset: random(presets, b.preset) })}>Random</button>
              <button className={cx(btn, favorites.includes(b.preset.path) && 'text-accent')} title="Star: picked more often"
                      onClick={() => toggleFavoriteKeysPreset(b.preset.path)}>
                <IconStar className="w-3.5 h-3.5" filled={favorites.includes(b.preset.path)} />
              </button>
              <span className="text-faint text-[11.5px] ml-1">{presets.length} patches</span>
            </span>
            <span className="text-muted">Keys part</span>
            <span className="flex flex-wrap items-center gap-1.5 min-w-0">
              <button className={btn} title="Write a new keys part, learned from your MIDI parts" onClick={() => newKeysPart()}>New keys part</button>
              {([null, 1, 2, 4] as const).map((n) => (
                <button key={n ?? 'any'} className={cx(btn, opts.bars === n && 'bg-accent/20 text-accent')}
                        title={n ? `New parts are ${n} bar${n === 1 ? '' : 's'} long (and write one now)` : 'New parts as long as your MIDI parts tend to be'}
                        onClick={() => { setKeysOptions({ bars: n }); newKeysPart(n) }}>{n ?? 'Any'}</button>
              ))}
              <span className="truncate font-medium ml-1">{b.midi.name}</span>
              <span className="text-faint text-[11.5px] whitespace-nowrap">{b.midi.key_label ?? 'no key'} · {b.midi.bars} bar{b.midi.bars === 1 ? '' : 's'}</span>
              <span className="text-faint text-[11.5px] ml-1 whitespace-nowrap">learned from {parts.length} keys part{parts.length === 1 ? '' : 's'}</span>
            </span>
            <span className="text-muted">Transpose</span>
            <span className="flex flex-wrap items-center gap-1.5">
              <button className={btn} onClick={() => setGenerationKeys({ transpose: Math.max(-24, b.transpose - 1) })}>−</button>
              <span className="w-16 text-center tabular-nums">{b.transpose > 0 ? '+' : ''}{b.transpose} st</span>
              <button className={btn} onClick={() => setGenerationKeys({ transpose: Math.min(24, b.transpose + 1) })}>+</button>
              <button className={btn} title="An octave down: the patch remembers it for the next tracks" onClick={() => void shiftOctave('keys', -12)}>−12</button>
              <button className={btn} title="An octave up: the patch remembers it for the next tracks" onClick={() => void shiftOctave('keys', 12)}>+12</button>
              <PatchOctave role="keys" path={b.preset.path} />
              <span className="text-faint text-[11.5px] ml-1">
                {g.key ? `into ${g.key} (${transposeTo(b.midi.key_label, g.key) >= 0 ? '+' : ''}${transposeTo(b.midi.key_label, g.key)} st from ${b.midi.key_label ?? '?'})` : 'no track key'}
              </span>
            </span>
            <span className="text-muted">Notes</span>
            <span className="flex flex-wrap items-center gap-1.5">
              <button className={cx(btn, editing && 'bg-accent/20 text-accent')} onClick={() => {
                setEditing(!editing)
                setSaveName(`${b.midi.name} edit`)
              }}>{editing ? 'Close piano roll' : 'Edit notes'}</button>
              {b.notes && <span className="text-accent text-[11.5px]">edited for this track</span>}
              {b.notes && <button className={btn} title={isGenerated(b.midi) ? 'Back to the line as it was written' : 'Back to the imported MIDI'}
                                  onClick={() => setGenerationKeys({ notes: undefined, bars: undefined })}>Revert</button>}
            </span>
            {editing && (
              <div className="col-span-2 mt-1 space-y-2">
                <PianoRoll color="#c4b5fd" notes={(b.notes ?? b.midi.notes).map(([s, l, p, v]) => [s, l, p + b.transpose, v] as RollNote)}
                           bars={bassBars(b)} playhead={() => keysPlayhead(g)}
                           onChange={(notes, bars) => setGenerationKeys({ notes: notes.map(([s, l, p, v]) => [s, l, p - b.transpose, v] as RollNote), bars })} />
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="text-faint">Edits apply to this track only.</span>
                  <span className="flex-1" />
                  <input aria-label="Keys MIDI name" className={cx(inputClass, 'w-48 h-7 text-[12px]')} value={saveName} onChange={(e) => setSaveName(e.target.value)} />
                  <Button onClick={() => void saveKeysPart(g, saveName)} title="Add the loop to your MIDI library, for future generations">
                    Save as new keys part
                  </Button>
                </div>
              </div>
            )}
            <span className="text-muted">Sidechain</span>
            <span className="flex items-center gap-2 max-w-[360px]">
              <BarSlider className="flex-1" min={0} max={1} step={0.05} value={opts.sidechain} reset={0.4} color="#c4b5fd"
                         dragging={dragging} title="How far the keys duck under every kick (double-click: 40%)"
                         onChange={(v) => setKeysOptions({ sidechain: v })} />
              <span className="w-10 text-right tabular-nums text-muted">{Math.round(opts.sidechain * 100)}%</span>
            </span>
          </div>
        )}
    </>
  )
}

/** What Keys still needs, if anything. */
export function keysMissing(parts: number, presets: number): string | null {
  return !parts ? 'No keys, piano or organ MIDI to learn from yet: add it under Keys & chords on the MIDI page.'
    : !presets ? 'No Serum 2 patches for Keys yet: tick their folders under Keys & chords on the MIDI page.' : null
}

/** Playhead inside the current Keys loop. */
function keysPlayhead(g: Generation): number | null {
  if (!playback.playing || !g.keys) return null
  const pos = playback.position()
  const c = g.project.clips.find((k) => k.type === 'audio' && k.bass?.role === 'keys' && pos >= k.start && pos < k.start + k.length)
  if (!c || c.type !== 'audio') return null
  const L = bassBars(g.keys) * 4
  return (((pos - c.start + c.trimBeats) % L) + L) % L
}

/** Save the generation's (edited) keys part to the MIDI library and use it from now on. */
async function saveKeysPart(g: Generation, name: string): Promise<void> {
  const b = g.keys
  if (!b) return
  const label = name.trim() || 'Keys part'
  const id = await attempt(() => api.saveMidi({ name: label, notes: b.notes ?? b.midi.notes, bars: bassBars(b), keyLabel: b.midi.key_label, role: 'keys' }))
  if (id == null) return
  await loadKeys()
  const saved = useKeys.getState().parts.find((m) => m.id === id)
  if (saved) setGenerationKeys({ midi: saved, notes: undefined, bars: undefined })
  useApp.getState().toast('info', `Saved "${label}" to your parts.`)
}

