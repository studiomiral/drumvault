import { useEffect, useState } from 'react'
import { api } from '../api'
import { serumPresetRoot, useApp } from '../store/app'
import { bassSettings, loadBass, padsSettings, pianoSettings, plucksSettings, saveBassSettings, savePadsSettings, savePianoSettings, savePlucksSettings, useBass } from '../store/bass'
import { IconChevron } from './icons'
import { cx } from './ui'

/** The modules that draw patches from Serum 2's presets: each picks its own folders under it. */
export const SERUM_MODULES = [
  { id: 'bass', label: 'Bass', what: 'basslines', settings: bassSettings, save: saveBassSettings, load: loadBass },
  // The breakdown layer (SCOPE.md §6.7b): a patch with "reese" (or bass, sub) in its name, folder or tags holds one low note; any other a chord.
  { id: 'pads', label: 'Pads', what: 'pad and reese', settings: padsSettings, save: savePadsSettings, load: loadBass },
  // Organic's arps and plucks (SCOPE.md §5.18).
  { id: 'plucks', label: 'Plucks', what: 'arp and pluck', settings: plucksSettings, save: savePlucksSettings, load: loadBass },
  // The Piano tab's patches (not played by Generate yet).
  { id: 'piano', label: 'Piano', what: 'piano', settings: pianoSettings, save: savePianoSettings, load: loadBass },
] as const

export type SerumModule = (typeof SERUM_MODULES)[number]['id']

/**
 * A module's Serum 2 patch pool (SCOPE.md §6.7), on the page where its parts come from: the
 * folders under the presets folder (Settings) it draws its patches from, saved at once. A folder
 * counts with all its sub-folders. Folded once it has patches.
 */
export function SerumFolders({ module, defaultOpen = false }: { module: SerumModule; defaultOpen?: boolean }) {
  const m = SERUM_MODULES.find((x) => x.id === module)!
  const root = serumPresetRoot()
  const setView = useApp((s) => s.setView)
  const pool = { bass: useBass((s) => s.presets.length), pads: useBass((s) => s.padPresets.length), plucks: useBass((s) => s.pluckPresets.length),
    piano: useBass((s) => s.pianoPresets.length) }[module]
  const skipped = { bass: useBass((s) => s.skipped), pads: useBass((s) => s.padSkipped), plucks: useBass((s) => s.pluckSkipped),
    piano: useBass((s) => s.pianoSkipped) }[module]
  const [open, setOpen] = useState(defaultOpen)
  const [folders, setFolders] = useState<{ folder: string; count: number }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState(() => new Set(m.settings().folders))
  const shown = open || !pool

  useEffect(() => {
    void m.load()
  }, [m])
  useEffect(() => {
    if (!shown) return
    let alive = true
    api.serumPresets(root, null).then((r) => alive && (setFolders(r.folders), setError(null)),
      (e) => alive && setError((e as Error).message))
    return () => {
      alive = false
    }
  }, [root, shown])

  const toggle = async (folder: string) => {
    const cur = m.settings().folders
    const next = cur.includes(folder) ? cur.filter((f) => f !== folder)
      // A folder replaces its own sub-folders (they're included).
      : [...cur.filter((f) => !f.startsWith(`${folder}/`)), folder]
    setChosen(new Set(next))
    await m.save({ folders: next })
    await m.load()
  }
  const covered = (f: string) => [...chosen].some((c) => f.startsWith(`${c}/`))

  return (
    <section className="rounded-2xl border border-line bg-panel-2">
      <button className={cx('w-full h-11 px-4 flex items-center gap-3 text-left', shown && 'border-b border-line')} onClick={() => setOpen(!open)}>
        <IconChevron className={cx('w-3.5 h-3.5 text-faint transition-transform', shown && 'rotate-90')} />
        <span className="text-[11px] font-semibold uppercase tracking-wider">{m.label} patches</span>
        <span className="text-[12px] text-muted truncate">
          {pool ? `${pool} Serum 2 patch${pool === 1 ? '' : 'es'} from ${chosen.size} folder${chosen.size === 1 ? '' : 's'}` : `No Serum 2 patches for ${m.label} yet: tick the folders with ${m.what} patches`}
        </span>
        {skipped > 0 && (
          <span className="text-[12px] text-warn truncate"
                title="These patches name sample files on another computer: Serum looks for them every time it loads the patch (up to a minute) and plays without them">
            · {skipped} left out: their samples aren't on this Mac
          </span>
        )}
      </button>
      {shown && (
        <div className="px-4 py-3">
          <p className="text-[12px] text-muted mb-2">
            Folders under <span className="text-text">{root}</span> that {m.label} draws its patches from (a folder counts with all its
            sub-folders).{' '}
            {module === 'piano' ? 'Generate doesn\'t play piano yet: these wait for it.' : 'Star patches in Create to hear them more often.'}{' '}
            <button className="text-accent hover:underline" onClick={() => setView('settings')}>Presets folder…</button>
          </p>
          {error ? <p className="text-bad text-[12px]">{error}</p> : !folders ? <p className="text-faint text-[12px]">Reading presets…</p>
            : !folders.length ? <p className="text-faint text-[12px]">No Serum 2 presets in this folder.</p> : (
              <div className="max-h-72 overflow-y-auto rounded-lg border border-line py-1">
                {folders.map(({ folder, count }) => {
                  const depth = folder.split('/').length - 1
                  const under = covered(folder)
                  return (
                    <label key={folder} className="flex items-center gap-2 h-7 px-3 text-[12.5px] hover:bg-raised cursor-pointer"
                           title={under ? `In the pool with the folder above it` : `${m.label} draws patches from ${folder}`}>
                      <input type="checkbox" className={cx('accent-[#e2c35f]', under && 'opacity-60')}
                             checked={chosen.has(folder) || under} disabled={under} onChange={() => void toggle(folder)} />
                      <span className="flex-1 truncate" style={{ paddingLeft: depth * 18 }}>{folder.split('/').pop()}</span>
                      <span className="text-faint tabular-nums">{count}</span>
                    </label>
                  )
                })}
              </div>
            )}
        </div>
      )}
    </section>
  )
}
