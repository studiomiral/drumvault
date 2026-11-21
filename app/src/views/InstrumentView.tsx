import { useState } from 'react'
import { PageTabs } from '../components/PageTabs'
import { SerumFolders } from '../components/SerumFolders'
import { FoldSection } from '../components/SoundSections'
import { Button, cx, inputClass } from '../components/ui'
import { useApp } from '../store/app'
import { hitWords, HitsSection, useHitImport, useKindHits } from './HitsView'
import { MidiSection, useMidi, useMidiImport, type MidiRole } from './MidiSection'

const VIEW = { bass: 'basses', piano: 'piano' } as const
const MIDI_WORDS: Record<MidiRole, [string, string]> = { bass: ['bassline', 'basslines'], piano: ['piano part', 'piano parts'] }

const count = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`

/**
 * Sounds → Bass and Sounds → Piano (SCOPE.md §6.7, §6.7a): everything an instrument plays and
 * learns from on one tab. Its Serum 2 patches (the folders it draws them from), its one-shot
 * samples (one note per file, played like a sampler), and the MIDI Generate learns its parts from.
 * Each part has its own drop zone. Generate plays the bass; the piano is collected for it.
 */
export function InstrumentView({ role }: { role: MidiRole }) {
  const setView = useApp((s) => s.setView)
  const genre = useApp((s) => s.settings?.genre ?? 'house')
  const { hits, loaded } = useKindHits(role)
  const samples = useHitImport(role)
  const midi = useMidi(role)
  const midiImport = useMidiImport(role)
  const [search, setSearch] = useState('')
  const sw = hitWords(role)
  const sampleWords: [string, string] = [sw.one, sw.many]

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      <header className="app-drag topbar-art h-14 shrink-0 flex items-center gap-4 px-6 border-b border-line">
        <PageTabs view={VIEW[role]} />
        {/* (No Add buttons: each part's drop zone is one, and the tabs need the room.) */}
        <input className={cx(inputClass, 'w-48 shrink-0')} placeholder={`Search ${role}`} value={search}
               onChange={(e) => setSearch(e.target.value)} />
        <div className="flex-1" />
        {role === 'bass' && (
          <Button variant="ghost" onClick={() => setView('splice')} title="Sounds in your Splice folder that could go on these pages">From Splice…</Button>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-6">
        {/* Each genre its own folders (keyed: switching genre shows its choice). */}
        <SerumFolders key={`${role}-${genre}`} module={role} />

        <FoldSection id={`${role}-samples`} title="Samples" count={loaded ? count(hits.length, sampleWords) : null}>
          <HitsSection kind={role} hits={hits} loaded={loaded} search={search} add={samples.add} busy={samples.busy} />
        </FoldSection>

        <FoldSection id={`${role}-midi`} title="MIDI" count={midi ? count(midi.length, MIDI_WORDS[role]) : null}>
          <MidiSection role={role} items={midi} search={search} add={midiImport.add} busy={midiImport.busy} />
        </FoldSection>
      </div>
    </div>
  )
}

const PATCHES_ABOUT = {
  pads: 'The breakdown layer: Generate lays a held pad or a reese under the breakdowns of most tracks that '
    + 'have one, from the patches in these folders. A patch with "reese" (or bass, sub) in its name, folder or tags plays one low note, any other a chord.',
  plucks: 'Organic\'s arps and plucks: the evolving melodic layer over the chords, from the patches in these folders.',
}

/** Sounds → Pads, and Sounds → Plucks for organic: the Serum 2 folders the module draws its patches from. */
export function PatchesView({ module }: { module: 'pads' | 'plucks' }) {
  const genre = useApp((s) => s.settings?.genre ?? 'house')
  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      <header className="app-drag topbar-art h-14 shrink-0 flex items-center gap-4 px-6 border-b border-line">
        <PageTabs view={module} />
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
        <p className="text-[12.5px] text-muted max-w-3xl">{PATCHES_ABOUT[module]}</p>
        <SerumFolders key={`${module}-${genre}`} module={module} defaultOpen />
      </div>
    </div>
  )
}
