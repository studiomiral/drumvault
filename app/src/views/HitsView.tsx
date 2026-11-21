import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { api } from '../api'
import { audition } from '../audio/audition'
import { IconPlay, IconStop, IconX } from '../components/icons'
import { DropZone } from '../components/SoundSections'
import { Button, cx, Empty, inputClass } from '../components/ui'
import { PageTabs } from '../components/PageTabs'
import { bedTempo, bedTonal } from '../generate/ambience'
import { hitSampleId } from '../generate/disco'
import { ALL_KEYS } from '../lib/camelot'
import { attempt, useApp } from '../store/app'
import { loadHits, useHits } from '../store/hits'
import type { HitItem } from '../types/api'

const SOURCE_LABEL: Record<NonNullable<HitItem['key_source']>, string> = {
  name: 'key from the name', detected: 'key from the sound', manual: 'key set by you',
}

/** What the page says, per kind of hit. */
const TEXT = {
  disco: {
    title: 'Drop Hits', one: 'drop hit', many: 'drop hits', empty: 'Drop the hits that mark your drops here: disco, brass and orchestra hits.',
    drop: 'Drop the hits: audio files, folders or zips',
    about: 'Stabs, brass hits, orchestra hits: one hit per file, trimmed and copied into the library. The key comes from the '
      + 'file name ("Brass Stab Cm", "Hit_F#_maj"), else from the sound. Generate moves each hit into the track key; if it '
      + 'sounds off, fix the key here or the pitch in Create.',
  },
  stab: {
    title: 'Chord Stabs', one: 'chord stab', many: 'chord stabs', empty: 'Drop your chord stabs here: organ, piano, synth and string stabs.',
    drop: 'Drop chord stabs: audio files, folders or zips',
    about: 'One chord per file, trimmed and copied into the library. The key comes from the file name ("Organ Stab Cm7", '
      + '"Stab_F#_maj"), else from the sound. Every generated track plays one of them in a funky rhythm, moved into '
      + 'the track key; if one sounds off, fix the key here or the pitch in Create.',
  },
  bass: {
    title: 'Bass samples', one: 'bass sample', many: 'bass samples', empty: 'Drop your bass one-shots here: one note per file.',
    drop: 'Drop bass one-shots: audio files, folders or zips',
    about: 'One bass note per file, trimmed and copied into the library. Its note comes from the file name ("Deep Bass A", '
      + '"808_F#"), else from its pitch. Generate can play a track\'s bassline with one of them instead of a Serum patch, '
      + 'like a sampler: every note is the sample played higher or lower. If a bass sounds out of key, fix its note here.',
  },
  piano: {
    title: 'Piano samples', one: 'piano sample', many: 'piano samples', empty: 'Drop your piano one-shots here: one note per file.',
    drop: 'Drop piano one-shots: audio files, folders or zips',
    about: 'One piano note per file (up to 12 s of its ring), trimmed and copied into the library. Its note comes from the '
      + 'file name ("Grand Piano C#", "Keys_F"), else from its pitch. Generate doesn\'t play piano yet: once it does, it plays '
      + 'a part with one of them like a sampler, as for the bass. If one is read wrong, fix its note here.',
  },
  ambience: {
    title: 'Ambience', one: 'texture', many: 'textures', empty: 'Drop long textures here: vinyl crackle, tape hiss, room tone, crowds, field recordings, or tonal beds: drones and soft pads.',
    drop: 'Drop textures: audio files, folders or zips',
    about: 'Long textures without a beat (up to a minute each), copied into the library. Generate lays one very quietly '
      + 'under most tracks, from the end of the intro to the start of the outro, made into a seamless loop and ducking under the kick: '
      + 'the air that makes a track sound less dry. Noise (crackle, hiss, a crowd) is never pitched. A tonal bed (a held tone: a drone, a pad) '
      + 'is always pitched into the track key, never heard as recorded: tracks in its own key (or the relative one) get another.',
  },
  strings: {
    title: 'Strings', one: 'string sample', many: 'string samples', empty: 'Drop your long string samples here: held chords and lines with a key.',
    drop: 'Drop strings: audio files, folders or zips',
    about: 'Long string samples with a key (up to a minute each). The key comes from the file name ("Warm Strings Am"), else '
      + 'from the sound; a sample needs one to be used. Generate plays one in some tracks as it was recorded, starting again '
      + 'on every 8-bar line, moved into the track key with its length kept: only samples within 3 semitones of the key, '
      + 'so fix a key read wrong here.',
  },
}

export type HitKind = Exclude<HitItem['kind'], 'drone'>

/** The Sounds page's tab of each kind (Bass and Piano: their tab's samples). */
const VIEW_OF = { disco: 'hits', stab: 'stabs', strings: 'strings', bass: 'basses', piano: 'piano', ambience: 'ambience' } as const

/** The samples of a kind (loaded again when the library changes). */
export function useKindHits(kind: HitKind): { hits: HitItem[]; loaded: boolean } {
  const libraryVersion = useApp((s) => s.libraryVersion)
  const all = useHits((s) => s.hits)
  const loaded = useHits((s) => s.loaded)
  useEffect(() => {
    void loadHits()
  }, [libraryVersion])
  return { hits: all.filter((h) => h.kind === kind), loaded }
}

/** What a kind's samples are called ("bass sample", "bass samples"). */
export const hitWords = (kind: HitKind) => ({ one: TEXT[kind].one, many: TEXT[kind].many })

/** Adding samples of a kind: the files, folders or zips given, with what came of it in a toast. */
export function useHitImport(kind: HitKind): { add: (paths: string[]) => Promise<void>; busy: boolean } {
  const toast = useApp((s) => s.toast)
  const t = TEXT[kind]
  const [busy, setBusy] = useState(false)
  const add = useCallback(async (paths: string[]) => {
    if (!paths.length) return
    setBusy(true)
    const r = await attempt(() => api.importHits(paths, kind))
    setBusy(false)
    if (!r) return
    void loadHits()
    const parts: string[] = []
    const n = r.imported.length
    parts.push(n ? `Added ${n} ${n === 1 ? t.one : t.many}` : `No new ${t.many}`)
    const detected = r.imported.filter((h) => h.key_source === 'detected').length
    if (detected) parts.push(`${detected} with the key from the sound (check those)`)
    const none = r.imported.filter((h) => !h.key_label).length
    if (none) parts.push(`${none} without a key`)
    if (r.skipped) parts.push(`${r.skipped} already in`)
    if (r.failed.length) parts.push(`${r.failed.length} unreadable: ${r.failed.slice(0, 2).join('; ')}`)
    if (r.warnings.length) parts.push(r.warnings[0])
    toast(r.failed.length && !n ? 'error' : 'info', `${parts.join(', ')}.`)
  }, [toast, kind, t])
  return { add, busy }
}

/**
 * A Sounds tab of one kind of sample (SCOPE.md §6.8–6.10a): Drop Hits (stabs, brass hits and the
 * like, dropped on the 1 at key moments), Chord Stabs (the stabs every track plays), Strings (long
 * string samples), Ambience (textures). Bass and Piano show their samples beside their MIDI
 * (InstrumentView).
 */
export function HitsView({ kind }: { kind: HitKind }) {
  const { engine, setView } = useApp()
  const { hits, loaded } = useKindHits(kind)
  const { add, busy } = useHitImport(kind)
  const t = TEXT[kind]
  const [dragging, setDragging] = useState(false)
  const [search, setSearch] = useState('')
  const ready = engine.state === 'ready'

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    await add(api.pathsForFiles([...e.dataTransfer.files]))
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col relative"
         onDragOver={(e) => {
           e.preventDefault()
           if (!dragging) setDragging(true)
         }}
         onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
         onDropCapture={() => setDragging(false)}
         onDrop={(e) => void onDrop(e)}>
      <header className="app-drag topbar-art h-14 shrink-0 flex items-center gap-4 px-6 border-b border-line">
        <PageTabs view={VIEW_OF[kind]} />
        <span className="text-faint text-[12px] tabular-nums">{loaded ? `${hits.length} ${hits.length === 1 ? t.one : t.many}` : ''}</span>
        <input className={cx(inputClass, 'w-56')} placeholder={`Search ${t.many}`} value={search}
               onChange={(e) => setSearch(e.target.value)} />
        <div className="flex-1" />
        <Button variant="ghost" onClick={() => setView('splice')} title="Sounds in your Splice folder that could go on these pages">From Splice…</Button>
        <Button variant="primary" disabled={!ready || busy} onClick={() => void api.chooseHits(`Add ${t.many}`).then(add)}>Add {t.many}…</Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        <HitsSection kind={kind} hits={hits} loaded={loaded} search={search} add={add} busy={busy} dragging={dragging} />
      </div>
    </div>
  )
}

/**
 * A kind's samples: the drop zone and the list, each with its key (or note) to correct, to play
 * and to remove. A tab of its own (Chord Stabs, Drop Hits, …) or a part of Bass and Piano.
 */
export function HitsSection({ kind, hits, loaded, search, add, busy, dragging }: {
  kind: HitKind
  hits: HitItem[]
  loaded: boolean
  search: string
  add: (paths: string[]) => Promise<void>
  busy: boolean
  /** Something is dragged over the whole tab (a tab of its own takes drops anywhere). */
  dragging?: boolean
}) {
  const engine = useApp((s) => s.engine)
  const t = TEXT[kind]
  const [playing, setPlaying] = useState<number | null>(audition.playingId)
  useEffect(() => audition.subscribe(setPlaying), [])

  const setKey = async (h: HitItem, key: string) => {
    await attempt(() => api.setHitKey(h.id, key || null))
    void loadHits()
  }
  const remove = async (h: HitItem) => {
    if (!window.confirm(`Remove "${h.name}" from the ${t.many}? Projects that use it will miss it.`)) return
    await attempt(() => api.deleteHits([h.id]))
    void loadHits()
  }

  const q = search.trim().toLowerCase()
  const shown = [...hits].reverse().filter((h) => !q || h.name.toLowerCase().includes(q) || (h.key_label ?? '').toLowerCase() === q)
  const ready = engine.state === 'ready'

  return (
    <div className="space-y-5">
      <DropZone title={busy ? 'Importing…' : t.drop} about={t.about} disabled={!ready || busy} highlight={dragging}
                onChoose={() => void api.chooseHits(`Add ${t.many}`).then(add)} onPaths={(p) => void add(p)} />

        {loaded && !hits.length ? (
          <Empty title={`No ${t.many} yet`}>{t.empty}</Empty>
        ) : (
          <div className="rounded-xl border border-line bg-panel-2 divide-y divide-line">
            {shown.map((h) => {
              const sid = hitSampleId(h.id)
              return (
                <div key={h.id} className="h-12 px-4 flex items-center gap-4 text-[12.5px]">
                  <button className="w-7 h-7 rounded-full bg-raised hover:bg-[#3a3b3f] flex items-center justify-center text-accent shrink-0"
                          title="Play" onClick={() => audition.toggle({ id: sid, rel_path: h.rel_path, kind: 'oneshot' })}>
                    {playing === sid ? <IconStop className="w-3.5 h-3.5" /> : <IconPlay className="w-3.5 h-3.5" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{h.name}</div>
                    <div className="text-[11px] text-faint truncate">
                      {h.duration_s.toFixed(1)} s
                      {kind === 'ambience' && (bedTonal(h) ? ` · tonal bed: always pitched into the track key${h.key_label ? '' : ' (set its key to use it)'}` : ' · noise: never pitched')}
                      {kind === 'ambience' && bedTempo(h) ? ` · ${bedTempo(h)} BPM: synced to the track tempo` : ''}
                      {h.key_source && (kind !== 'ambience' || h.key_label) ? ` · ${SOURCE_LABEL[h.key_source]}` : ''}
                      {h.pitch_fix ? ` · pitch fixed ${h.pitch_fix > 0 ? '+' : ''}${h.pitch_fix} st` : ''}
                    </div>
                  </div>
                  <select className={cx(inputClass, 'w-36 h-7 text-[12px]', h.key_source === 'detected' && 'text-accent')}
                          value={h.key_label ?? (kind === 'ambience' && bedTonal(h) ? '?' : '')} title={kind === 'ambience'
                            ? 'Key: a tonal bed is pitched from this key into the track\'s; no key: noise, never pitched'
                            : `Key: Generate moves the ${t.one} from this key into the track's`}
                          onChange={(e) => void setKey(h, e.target.value)}>
                    {kind === 'ambience' && bedTonal(h) && !h.key_label && <option value="?" disabled>Tonal: set its key</option>}
                    <option value="">{kind === 'ambience' ? 'No key: noise' : 'No key'}</option>
                    {ALL_KEYS.map((k) => <option key={k.label} value={k.label}>{k.label} ({k.camelot})</option>)}
                  </select>
                  <button title={`Remove from the ${t.many}`} className="text-faint hover:text-bad" onClick={() => void remove(h)}>
                    <IconX className="w-4 h-4" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
    </div>
  )
}
