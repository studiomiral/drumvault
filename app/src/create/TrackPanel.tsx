import { ChoiceRow, confirmRemake } from '../components/LanePanel'
import { IconLock } from '../components/icons'
import { cx, SectionTitle } from '../components/ui'
import { CHOICE_GROUPS, choicesFor } from '../generate/choices'
import type { Generation } from '../generate/generator'
import { ALL_KEYS } from '../lib/camelot'
import { markerColor } from '../lib/project'
import { changeTrackKey, invalidate, playSection, useGenerate } from '../store/generate'

/** Keep the structure or the key on the next press of G. */
function KeepLock({ on, what, onClick }: { on: boolean; what: string; onClick: () => void }) {
  return (
    <button onClick={onClick} title={on ? `Kept: the next press of G keeps the ${what}` : `Keep the ${what} on the next press of G`}
            className={cx('w-6 h-6 rounded-md flex items-center justify-center', on ? 'bg-accent/15 text-accent' : 'text-faint hover:text-text hover:bg-raised')}>
      <IconLock className="w-3.5 h-3.5" open={!on} />
    </button>
  )
}

/**
 * The track (the side panel's Track): length, key, structure, its choices (to change, or lock for
 * every next one), its sources.
 */
export function TrackPanel({ g }: { g: Generation }) {
  const { keep, set } = useGenerate()
  const setKeep = (patch: Partial<typeof keep>) => {
    set({ keep: { ...keep, ...patch } })
    invalidate()
  }
  const bpm = g.project.bpm
  const secs = Math.round((g.project.lengthBars * 4 * 60) / bpm)
  const choices = choicesFor(g)
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-display text-[22px]">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span>
        <span className="text-muted">{g.project.lengthBars} bars · {bpm} BPM</span>
        <label className="rounded-md pl-2 h-[22px] inline-flex items-center gap-1 bg-pastel-yellow text-on-pastel text-[12px] font-medium"
               title="Another key for this track: the bass moves, drop hits and chord stabs are pitched, FX that don't fit are swapped; the drums stay (⌘Z goes back)">
          Key
          <select className="bg-transparent font-medium outline-none cursor-pointer pr-1" value={g.key ?? ''}
                  onChange={(e) => e.target.value && confirmRemake('the bass, stabs, hits and FX') && changeTrackKey(e.target.value)}>
            {!g.key && <option value="">none</option>}
            {ALL_KEYS.map((k) => <option key={k.label} value={k.label}>{k.label} ({k.camelot})</option>)}
          </select>
        </label>
        <KeepLock on={keep.key} what="key" onClick={() => setKeep({ key: !keep.key })} />
        <span className="text-faint text-[11.5px] ml-auto">seed {g.seed}</span>
      </div>
      <div>
        <SectionTitle right={<KeepLock on={keep.structure} what="structure" onClick={() => setKeep({ structure: !keep.structure })} />}>Structure</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          {g.sections.map((s, i) => (
            <button key={i} onClick={() => playSection(i)} title={`Play from ${s.label} (${i + 1})`}
                    className="h-7 px-2.5 rounded-lg text-[12px] bg-raised hover:bg-[#3a3b3f] flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: markerColor(s.label) }} />
              {s.label} <span className="text-faint">{s.bars}</span>
            </button>
          ))}
        </div>
      </div>
      <div>
        <SectionTitle>Choices</SectionTitle>
        <p className="text-faint text-[11.5px] -mt-1 mb-3">Change one to hear the track with it (the lanes it shapes are made again, ⌘Z goes back); lock it for every next track.</p>
        <div className="grid grid-cols-1 gap-y-4">
          {CHOICE_GROUPS.map((group) => {
            const list = choices.filter((c) => c.group === group)
            return list.length > 0 && (
              <div key={group}>
                <div className="text-[11.5px] font-medium text-text mb-1.5">{group}</div>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1.5 items-center">
                  {list.map((c) => <ChoiceRow key={c.rule} c={c} g={g} lockable />)}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div>
        <SectionTitle>Also</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          {g.choices.map((c) => (
            <span key={c} className="h-6 px-2 rounded-md text-[11.5px] bg-pastel-lavender text-on-pastel inline-flex items-center">{c}</span>
          ))}
        </div>
      </div>
      <div className="text-[12px] text-muted">From {g.zips.length} zips: <span className="font-mono text-faint">{g.zips.join(' · ')}</span></div>
    </section>
  )
}
