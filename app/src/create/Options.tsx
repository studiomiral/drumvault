import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Button } from '../components/ui'
import { useApp } from '../store/app'
import { invalidate, saveTempo, useGenerate } from '../store/generate'
import { setLearning, tasteFor, useTaste } from '../store/taste'
import { CHOICES } from '../generate/choices'
import { LANES } from '../generate/generator'
import { describeTaste } from '../generate/taste'
import { useProject } from '../store/project'
import type { ZipListItem } from '../types/api'

/** Create's Options (SCOPE.md §6.6): how the next tracks are made. The track on screen keeps its own. */
export function Options() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div ref={ref} className="relative app-no-drag">
      <Button variant={open ? 'secondary' : 'ghost'} onClick={() => setOpen(!open)} title="How new tracks are made">Options ▾</Button>
      {open && (
        <div className="absolute right-0 top-9 z-40 w-[560px] rounded-xl surface-pop p-4 space-y-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">New tracks</div>
          <OptionsBody />
        </div>
      )}
    </div>
  )
}

/** Tempo per track: the library BPM, a fixed BPM, or a random whole BPM from a range. */
function TempoOption({ sel }: { sel: string }) {
  const { settings, set } = useGenerate()
  const library = useApp((s) => s.settings?.engine.library_bpm ?? 124)
  const t = settings.tempo
  const mode = !t ? 'library' : t.min === t.max ? 'fixed' : 'range'
  const update = (tempo: typeof t) => {
    set({ settings: { ...settings, tempo } })
    saveTempo(tempo)
    invalidate()
  }
  const num = (v: string, fallback: number) => {
    const n = Math.round(Number(v))
    return n >= 60 && n <= 200 ? n : fallback
  }
  const field = 'w-14 h-7 rounded-lg bg-[rgb(0_0_0/0.25)] px-2 text-text text-[12px] outline-none shadow-[0_0_0_1px_rgb(255_255_255/0.08)] tabular-nums'
  return (
    <span className="flex items-center gap-1.5 ml-2"
          title="Other tempos keep the pitch: loops are sliced onto the grid, FX are stretched by the engine">
      Tempo
      <select className={sel} value={mode} onChange={(e) => {
        const m = e.target.value
        update(m === 'library' ? null : m === 'fixed' ? { min: t?.min ?? library, max: t?.min ?? library }
          : { min: Math.min(t?.min ?? library - 4, library - 4), max: Math.max(t?.max ?? library + 4, library + 4) })
      }}>
        <option value="library">Library ({library})</option>
        <option value="fixed">Fixed</option>
        <option value="range">Range</option>
      </select>
      {t && mode === 'fixed' && (
        <input key={`f${t.min}`} className={field} defaultValue={t.min}
               onBlur={(e) => { const v = num(e.target.value, t.min); update({ min: v, max: v }) }}
               onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      )}
      {t && mode === 'range' && (
        <>
          <input key={`a${t.min}`} className={field} defaultValue={t.min}
                 onBlur={(e) => { const v = num(e.target.value, t.min); update({ min: Math.min(v, t.max - 1), max: t.max }) }}
                 onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          –
          <input key={`b${t.max}`} className={field} defaultValue={t.max}
                 onBlur={(e) => { const v = num(e.target.value, t.max); update({ min: t.min, max: Math.max(v, t.min + 1) }) }}
                 onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        </>
      )}
    </span>
  )
}

/** What new tracks are made with: length, tempo, sources, favourites, listening back. */
function OptionsBody() {
  const { settings, set } = useGenerate()
  const [zips, setZips] = useState<ZipListItem[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (open) void api.listZips().then(setZips)
  }, [open])
  const update = (patch: Partial<typeof settings>) => {
    set({ settings: { ...settings, ...patch } })
    invalidate()
  }
  const minutes = [3, 4, 5, 6, 7, 8]
  const sel = 'h-7 rounded-lg bg-[rgb(0_0_0/0.25)] px-2 text-text text-[12px] outline-none shadow-[0_0_0_1px_rgb(255_255_255/0.08)]'
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted relative">
      Length
      <select className={sel} value={settings.minMinutes} onChange={(e) => {
        const v = Number(e.target.value)
        update({ minMinutes: v, maxMinutes: Math.max(v, settings.maxMinutes) })
      }}>
        {minutes.map((m) => <option key={m} value={m}>{m} min</option>)}
      </select>
      to
      <select className={sel} value={settings.maxMinutes} onChange={(e) => {
        const v = Number(e.target.value)
        update({ maxMinutes: v, minMinutes: Math.min(v, settings.minMinutes) })
      }}>
        {minutes.map((m) => <option key={m} value={m}>{m} min</option>)}
      </select>
      <TempoOption sel={sel} />
      <Button variant="secondary" className="ml-2" onClick={() => setOpen(!open)}>
        Sources: {settings.zipIds ? `${settings.zipIds.length} zip${settings.zipIds.length === 1 ? '' : 's'}` : 'all zips'}
      </Button>
      <label className="flex items-center gap-1.5 ml-2">
        <input type="checkbox" className="accent-[#e2c35f]" checked={settings.useRatings}
               onChange={(e) => update({ useRatings: e.target.checked })} />
        Prefer favourites
      </label>
      <label className="flex items-center gap-1.5 ml-2" title="Every track is listened back to: loops that play the same hits with the same tone, or have a kick in them, are swapped for ones that fit">
        <input type="checkbox" className="accent-[#e2c35f]" checked={settings.listenBack}
               onChange={(e) => update({ listenBack: e.target.checked })} />
        Listen back
      </label>
      <LearnOption />
      {open && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-50 w-80 max-h-96 overflow-y-auto rounded-xl surface-pop p-2">
            <label className="flex items-center gap-2 px-2 h-8 rounded-md hover:bg-raised">
              <input type="checkbox" className="accent-[#e2c35f]" checked={!settings.zipIds}
                     onChange={() => update({ zipIds: settings.zipIds ? null : [] })} />
              <span className="text-text">All zips</span>
            </label>
            {zips.map((z) => {
              const on = !settings.zipIds || settings.zipIds.includes(z.id)
              return (
                <label key={z.id} className="flex items-center gap-2 px-2 h-8 rounded-md hover:bg-raised">
                  <input type="checkbox" className="accent-[#e2c35f]" checked={on} onChange={() => {
                    const ids = settings.zipIds ?? zips.map((x) => x.id)
                    const nextIds = on ? ids.filter((i) => i !== z.id) : [...ids, z.id]
                    update({ zipIds: nextIds.length === zips.length ? null : nextIds })
                  }} />
                  <span className="font-mono text-faint text-[11px]">{z.source_code}</span>
                  <span className="truncate text-text">{z.file_name}</span>
                </label>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/** A role's lane name ("+top": a lane added as another one of the top loops). */
function laneName(role: string): string {
  const added = role.startsWith('+')
  const r = added ? role.slice(1) : role
  const name = LANES.find((l) => l.role === r)?.name ?? r
  return added ? `${name} (added lane)` : name
}

/** Learning from exports (SCOPE.md §6.6): on or off, and what new tracks take from them. */
function LearnOption() {
  const { enabled, records } = useTaste()
  const genre = useProject((s) => s.project.genre)
  const [show, setShow] = useState(false)
  const taste = enabled ? tasteFor(genre) : null
  const lines = taste ? describeTaste(taste, CHOICES, laneName, (p) => p.split('/').pop()!.replace(/\.SerumPreset$/i, '')) : []
  const n = records.filter((r) => r.genre === genre).length
  return (
    <div className="basis-full flex flex-col gap-1.5 mt-1">
      <span className="flex items-center gap-2">
        <label className="flex items-center gap-1.5"
               title="New tracks lean to what you changed in the tracks you exported: choices, sounds, the bass patch, the tempo and lanes taken out of sections">
          <input type="checkbox" className="accent-[#e2c35f]" checked={enabled} onChange={(e) => {
            setLearning(e.target.checked)
            invalidate()
          }} />
          Learn from exports
        </label>
        <span className="text-faint">{n ? `${n} exported track${n === 1 ? '' : 's'}` : 'none exported yet'}</span>
        {enabled && n > 0 && (
          <button className="text-faint hover:text-text underline-offset-2 hover:underline" onClick={() => setShow(!show)}>
            {show ? 'hide' : 'what it learned'}
          </button>
        )}
      </span>
      {show && enabled && (
        <ul className="rounded-lg border border-line bg-panel-2 p-2.5 space-y-0.5 max-h-56 overflow-y-auto text-[11px] select-text">
          {lines.length ? lines.map((l) => <li key={l}>{l}</li>)
            : <li className="text-faint">Nothing to go on yet: the exports kept the tracks as they were made.</li>}
        </ul>
      )}
    </div>
  )
}
