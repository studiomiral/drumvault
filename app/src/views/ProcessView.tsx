import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { api } from '../api'
import { EngineBanner } from '../components/EngineBanner'
import { IconDrop, IconHit, IconKey, IconLoop, IconSparkle, IconX } from '../components/icons'
import { Button, Chip, cx, Empty, Modal, PageTitle, ProgressBar, SectionTitle, Segmented, StatusChip } from '../components/ui'
import { ENGINE_DEFAULTS } from '../lib/defaults'
import { formatBpm, KIND_PASTEL } from '../lib/format'
import { attempt, useApp } from '../store/app'
import type { JobInfo, ZipListItem } from '../types/api'
import type { SampleKind } from '../types/engine'
import { ZipDetailPanel } from './ZipDetailPanel'

type ZipFilter = 'all' | 'needs_review' | 'error'

export function ProcessView() {
  const { jobs, libraryVersion, engine, toast, settings } = useApp()
  const [zips, setZips] = useState<ZipListItem[]>([])
  const [filter, setFilter] = useState<ZipFilter>('all')
  const [selected, setSelected] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [dupes, setDupes] = useState<{ paths: string[]; dupes: Duplicate[] } | null>(null)

  useEffect(() => {
    void api.listZips().then(setZips)
  }, [libraryVersion])

  // Zips appear in the database as soon as their job starts; refresh while jobs run.
  const activeCount = jobs.filter((j) => j.status === 'queued' || j.status === 'processing').length
  useEffect(() => {
    if (!activeCount) return
    const t = setInterval(() => void api.listZips().then(setZips), 2000)
    return () => clearInterval(t)
  }, [activeCount])

  const submit = useCallback(async (paths: string[]) => {
    if (!paths.length) return
    // Warn about zips whose file name is already in the library, queued, or twice in this batch.
    const [inLibrary, queued] = [await api.listZips(), useApp.getState().jobs]
    const known = new Map<string, string>()
    for (const z of inLibrary) known.set(z.file_name.toLowerCase(), `already in the library as ${z.source_code}`)
    for (const j of queued) {
      if ((j.status === 'queued' || j.status === 'processing') && j.path) known.set(baseName(j.path).toLowerCase(), 'already in the queue')
    }
    const found: Duplicate[] = []
    const seen = new Set<string>()
    paths.forEach((p, index) => {
      const name = baseName(p)
      const why = known.get(name.toLowerCase()) ?? (seen.has(name.toLowerCase()) ? 'twice in this selection' : null)
      if (why) found.push({ index, path: p, name, why })
      seen.add(name.toLowerCase())
    })
    if (found.length) {
      setDupes({ paths, dupes: found })
      return
    }
    await attempt(() => api.processZips(paths))
  }, [toast])

  /** Zips are processed as tracks; loose samples (Splice and other folders) are added as packs. */
  const add = useCallback(async (dropped: string[]) => {
    if (!dropped.length) return
    const [zipPaths, samples] = await Promise.all([api.expandPaths(dropped), api.findSamples(dropped)])
    if (!zipPaths.length && !samples.length) {
      toast('info', 'No zips or audio files found in what was added.')
      return
    }
    if (samples.length) await attempt(() => api.importSamples(dropped))
    await submit(zipPaths)
  }, [submit, toast])

  const addViaDialog = useCallback(async () => {
    await add(await api.chooseZips())
  }, [add])

  useEffect(() => api.onMenu((cmd) => {
    if (cmd === 'add-zips') void addViaDialog()
  }), [addViaDialog])

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    await add(api.pathsForFiles([...e.dataTransfer.files]))
  }

  const shown = zips.filter((z) => filter === 'all' || z.status === filter)
  const counts = {
    review: zips.filter((z) => z.status === 'needs_review').length,
    error: zips.filter((z) => z.status === 'error').length,
  }
  const canProcess = engine.state === 'ready'

  return (
    <div
      className="flex-1 min-h-0 flex relative"
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragging) setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="app-drag topbar-art h-14 shrink-0 flex items-center gap-4 px-6 border-b border-line">
          <PageTitle>Process</PageTitle>
          <div className="flex-1" />
        </header>
        <EngineBanner />
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-6">
          <div className="flex gap-4 h-[196px]">
            <Hero bpm={settings?.engine.library_bpm ?? ENGINE_DEFAULTS.library_bpm} canProcess={canProcess}
                  onAdd={() => void addViaDialog()} />
            <DropZone onClick={() => void addViaDialog()} />
          </div>
          {jobs.length > 0 && <Queue jobs={jobs} onOpen={setSelected} />}
          <section>
            <SectionTitle right={
              <Segmented<ZipFilter> value={filter} onChange={setFilter} options={[
                { value: 'all', label: `All ${zips.length}` },
                { value: 'needs_review', label: `Needs review ${counts.review}` },
                { value: 'error', label: `Errors ${counts.error}` },
              ]} />
            }>Library sources</SectionTitle>
            {shown.length === 0 ? (
              <Empty title={zips.length ? 'Nothing here' : 'No zips processed yet'}>
                {zips.length ? 'Nothing matches this filter.' : 'Drop zips of stems or folders of samples above to build your library.'}
              </Empty>
            ) : (
              <ZipTable zips={shown} selected={selected} onSelect={setSelected} />
            )}
          </section>
        </div>
      </div>
      {selected != null && (
        <ZipDetailPanel zipId={selected} onClose={() => setSelected(null)} />
      )}
      {dupes && (
        <Modal title="Already added?" onClose={() => setDupes(null)} width={540}>
          <p className="text-muted">
            {dupes.dupes.length === 1 ? 'This zip has' : `These ${dupes.dupes.length} zips have`} the same file name as one you
            already added. Zips with identical contents are skipped anyway; a different download with the same name would be
            processed again.
          </p>
          <ul className="mt-3 space-y-1 max-h-56 overflow-y-auto">
            {dupes.dupes.map((d) => (
              <li key={d.index} className="flex gap-3 text-[12.5px]">
                <span className="truncate flex-1 text-text" title={d.path}>{d.name}</span>
                <span className="text-warn shrink-0">{d.why}</span>
              </li>
            ))}
          </ul>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDupes(null)}>Cancel</Button>
            <Button variant="secondary" onClick={() => {
              const skip = new Set(dupes.dupes.map((d) => d.index))
              const keep = dupes.paths.filter((_, i) => !skip.has(i))
              setDupes(null)
              if (keep.length) void attempt(() => api.processZips(keep))
            }}>Skip duplicates</Button>
            <Button variant="primary" onClick={() => {
              const all = dupes.paths
              setDupes(null)
              void attempt(() => api.processZips(all))
            }}>Add anyway</Button>
          </div>
        </Modal>
      )}
      {dragging && (
        <div className="absolute inset-2 rounded-2xl border-2 border-dashed border-accent/70 bg-accent/10 backdrop-blur-sm flex items-center justify-center pointer-events-none z-20">
          <div className="text-accent text-[15px] font-medium">Drop zips, samples or folders to process them</div>
        </div>
      )}
    </div>
  )
}

/** Welcome banner: what Drumvault does, the library tempo, and the main action. */
function Hero({ bpm, canProcess, onAdd }: { bpm: number; canProcess: boolean; onAdd: () => void }) {
  const bubbles = [
    { Icon: IconHit, bg: 'bg-pastel-blue', at: 'right-[150px] top-[22px]', size: 'w-[72px] h-[72px]' },
    { Icon: IconLoop, bg: 'bg-pastel-mint', at: 'right-[52px] top-[-14px]', size: 'w-[84px] h-[84px]' },
    { Icon: IconSparkle, bg: 'bg-pastel-lavender', at: 'right-[70px] bottom-[-18px]', size: 'w-[88px] h-[88px]' },
    { Icon: IconKey, bg: 'bg-pastel-yellow', at: 'right-[178px] bottom-[-26px]', size: 'w-[64px] h-[64px]' },
  ]
  return (
    <section className="relative flex-1 min-w-0 rounded-2xl border border-line overflow-hidden px-7 py-6 flex flex-col justify-center
                        bg-[radial-gradient(90%_130%_at_88%_40%,rgb(226_195_95/0.16),transparent_60%),linear-gradient(105deg,#222327_35%,#33332d_100%)]">
      <div className="absolute inset-y-0 right-0 w-[300px] pointer-events-none" aria-hidden>
        {bubbles.map(({ Icon, bg, at, size }, i) => (
          <div key={i} className={cx('absolute rounded-full p-2.5 bg-[#2c2d30] border border-[#3a3b3f]', at)}>
            <div className={cx('rounded-full flex items-center justify-center text-on-pastel', bg, size)}>
              <Icon className="w-1/2 h-1/2" />
            </div>
          </div>
        ))}
      </div>
      <div className="relative max-w-[460px] flex flex-col">
        <h2 className="font-display text-[26px] leading-[1.15] font-medium">Stems in, drums out</h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
          Drop zips of dance-track stems. Drumvault keeps the drums, FX and fills, matches them to {formatBpm(bpm)} BPM
          and labels them with the track&apos;s key. Loose samples from Splice and other packs are matched too.
        </p>
        <Button variant="primary" className="mt-4 h-8 px-3.5 self-start" onClick={onAdd} disabled={!canProcess}>Add zips or samples…</Button>
      </div>
    </section>
  )
}

function DropZone({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-[300px] shrink-0 rounded-2xl border border-dashed border-[#3e3f44] bg-panel-2 hover:border-accent/60 hover:bg-accent-soft
                 transition-colors flex flex-col items-center justify-center gap-3 px-6 text-center text-muted"
    >
      <span className="w-12 h-12 rounded-full bg-raised flex items-center justify-center text-text">
        <IconDrop className="w-6 h-6" />
      </span>
      <span>
        <span className="block text-text font-medium">Drop stem zips, samples or folders</span>
        <span className="block mt-1 text-[12px]">or click to browse. Zips are tracks; loose WAV/AIFF/FLAC samples join a pack per Splice pack or folder. MIDI goes on the MIDI page.</span>
      </span>
    </button>
  )
}

function Queue({ jobs, onOpen }: { jobs: JobInfo[]; onOpen: (zipId: number) => void }) {
  const finished = jobs.some((j) => j.status !== 'queued' && j.status !== 'processing')
  return (
    <section>
      <SectionTitle right={finished && (
        <Button variant="ghost" onClick={() => void api.clearFinishedJobs()}>Clear finished</Button>
      )}>Queue</SectionTitle>
      <div className="rounded-lg border border-line divide-y divide-line bg-panel">
        {jobs.map((j) => {
          const active = j.status === 'queued' || j.status === 'processing'
          const t = j.result?.analysis?.tempo
          const k = j.result?.analysis?.key
          return (
            <div
              key={j.job_id}
              onClick={() => j.zip_id != null && !active && j.method !== 'delete_zip' && onOpen(j.zip_id)}
              className={cx('px-4 py-2.5 grid grid-cols-[1fr_auto] gap-x-4 items-center',
                j.zip_id != null && !active && 'cursor-pointer hover:bg-panel-2')}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="truncate font-medium" title={j.path ?? j.label}>{j.label}</span>
                  <StatusChip status={j.status} />
                  {t && <Chip>{formatBpm(t.bpm)} BPM</Chip>}
                  {k && <Chip>{k.label ?? 'NoKey'}{k.uncertain && k.label ? '?' : ''}</Chip>}
                </div>
                <div className="text-[12px] text-muted mt-1 truncate select-text">
                  {j.status === 'processing' && <span className="text-faint mr-2 capitalize">{j.stage}</span>}
                  {j.message}
                </div>
                {active && <ProgressBar value={j.pct} className="mt-2" />}
              </div>
              {active && (
                <button title="Cancel" className="text-muted hover:text-bad"
                        onClick={(e) => {
                          e.stopPropagation()
                          void attempt(() => api.cancelJob(j.job_id))
                        }}>
                  <IconX className="w-4 h-4" />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function ZipTable({ zips, selected, onSelect }: {
  zips: ZipListItem[]
  selected: number | null
  onSelect: (id: number) => void
}) {
  return (
    <div className="rounded-lg border border-line overflow-hidden">
      <table className="w-full text-[12.5px]">
        <thead className="bg-panel text-faint text-[11px] uppercase tracking-wider">
          <tr className="text-left">
            <th className="font-medium px-3 py-2 w-16">Source</th>
            <th className="font-medium px-3 py-2">Zip or pack</th>
            <th className="font-medium px-3 py-2 w-28">Status</th>
            <th className="font-medium px-3 py-2 w-28">BPM</th>
            <th className="font-medium px-3 py-2 w-20">Key</th>
            <KindHead kind="oneshot" className="w-28">One-shots</KindHead>
            <KindHead kind="loop" className="w-20">Loops</KindHead>
            <KindHead kind="event" className="w-28">FX & fills</KindHead>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {zips.map((z) => {
            const bpm = z.bpm_override ?? z.detected_bpm
            return (
              <tr key={z.id} onClick={() => onSelect(z.id)}
                  className={cx('cursor-pointer', selected === z.id ? 'bg-brand-soft' : 'bg-panel hover:bg-panel-2')}>
                <td className="px-3 py-2 font-mono text-muted">{z.source_code}</td>
                <td className="px-3 py-2 truncate max-w-0" title={z.file_name}>
                  {z.file_name}
                  {z.kind === 'pack' && <span className="ml-2 text-faint text-[11px]">samples</span>}
                </td>
                <td className="px-3 py-2"><StatusChip status={z.status} /></td>
                <td className="px-3 py-2">
                  {z.kind === 'pack' ? <span className="text-faint">each its own</span> : formatBpm(bpm)}
                  {z.bpm_override != null && <span className="text-accent ml-1" title="Set manually">●</span>}
                </td>
                <td className="px-3 py-2">
                  {z.key_label ?? <span className="text-faint">–</span>}
                  {z.key_override ? <span className="text-accent ml-1" title="Set manually">●</span>
                    : z.key_confidence != null && z.key_confidence < 0.5 && z.key_label && <span className="text-warn ml-0.5">?</span>}
                </td>
                <td className="px-3 py-2 text-muted text-right tabular-nums">{z.oneshots}</td>
                <td className="px-3 py-2 text-muted text-right tabular-nums">{z.loops}</td>
                <td className="px-3 py-2 text-muted text-right tabular-nums">{z.events}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function KindHead({ kind, className, children }: { kind: SampleKind; className: string; children: string }) {
  return (
    <th className={cx('font-medium px-3 py-2 text-right whitespace-nowrap', className)}>
      <span className="inline-flex items-center gap-1.5">
        <span className={cx('w-1.5 h-1.5 rounded-full', KIND_PASTEL[kind])} />{children}
      </span>
    </th>
  )
}

interface Duplicate {
  index: number
  path: string
  name: string
  why: string
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}
