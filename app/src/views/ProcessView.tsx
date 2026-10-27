import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { api } from '../api'
import { EngineBanner } from '../components/EngineBanner'
import { IconDrop, IconX } from '../components/icons'
import { Button, Chip, cx, Empty, ProgressBar, SectionTitle, Segmented, StatusChip } from '../components/ui'
import { formatBpm } from '../lib/format'
import { attempt, useApp } from '../store/app'
import type { JobInfo, ZipListItem } from '../types/api'
import { ZipDetailPanel } from './ZipDetailPanel'

type ZipFilter = 'all' | 'needs_review' | 'error'

export function ProcessView() {
  const { jobs, libraryVersion, engine, toast } = useApp()
  const [zips, setZips] = useState<ZipListItem[]>([])
  const [filter, setFilter] = useState<ZipFilter>('all')
  const [selected, setSelected] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)

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
    if (!paths.length) {
      toast('info', 'No zip files found in what was dropped.')
      return
    }
    await attempt(() => api.processZips(paths))
  }, [toast])

  const addViaDialog = useCallback(async () => {
    const paths = await api.chooseZips()
    if (paths.length) await submit(paths)
  }, [submit])

  useEffect(() => api.onMenu((cmd) => {
    if (cmd === 'add-zips') void addViaDialog()
  }), [addViaDialog])

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const paths = api.pathsForFiles([...e.dataTransfer.files])
    await submit(await api.expandPaths(paths))
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
        <header className="h-14 shrink-0 flex items-center gap-3 px-6 border-b border-line">
          <h1 className="text-[15px] font-semibold flex-1">Process</h1>
          <Button variant="primary" onClick={() => void addViaDialog()} disabled={!canProcess}>Add zips…</Button>
        </header>
        <EngineBanner />
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-6">
          <DropZone compact={zips.length > 0 || jobs.length > 0} onClick={() => void addViaDialog()} />
          {jobs.length > 0 && <Queue jobs={jobs} onOpen={setSelected} />}
          <section>
            <SectionTitle right={
              <Segmented<ZipFilter> value={filter} onChange={setFilter} options={[
                { value: 'all', label: `All ${zips.length}` },
                { value: 'needs_review', label: `Needs review ${counts.review}` },
                { value: 'error', label: `Errors ${counts.error}` },
              ]} />
            }>Library zips</SectionTitle>
            {shown.length === 0 ? (
              <Empty title={zips.length ? 'Nothing here' : 'No zips processed yet'}>
                {zips.length ? 'No zips match this filter.' : 'Drop zips of stems above to build your library.'}
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
      {dragging && (
        <div className="absolute inset-2 rounded-xl border-2 border-dashed border-accent bg-[#7c3aed0d] flex items-center justify-center pointer-events-none z-20">
          <div className="text-accent text-[15px] font-medium">Drop zips or folders to process them</div>
        </div>
      )}
    </div>
  )
}

function DropZone({ compact, onClick }: { compact: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cx('w-full rounded-xl border border-dashed border-line hover:border-accent hover:bg-brand-soft bg-panel transition-colors',
        'flex items-center justify-center gap-3 text-muted', compact ? 'h-16' : 'h-56 flex-col')}
    >
      <IconDrop className={compact ? 'w-6 h-6' : 'w-10 h-10 text-faint'} />
      <span>
        <span className="text-text font-medium">Drop stem zips or folders here</span>
        {!compact && <span className="block mt-1 text-[12px]">Folders are searched for zips. Already processed zips are skipped.</span>}
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
                  {t && <Chip>{formatBpm(t.bpm)} BPM · {t.confidence.toFixed(2)}</Chip>}
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
            <th className="font-medium px-3 py-2">Zip</th>
            <th className="font-medium px-3 py-2 w-28">Status</th>
            <th className="font-medium px-3 py-2 w-28">BPM</th>
            <th className="font-medium px-3 py-2 w-20">Key</th>
            <th className="font-medium px-3 py-2 w-24 text-right">One-shots</th>
            <th className="font-medium px-3 py-2 w-20 text-right">Loops</th>
            <th className="font-medium px-3 py-2 w-24 text-right">FX & fills</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {zips.map((z) => {
            const bpm = z.bpm_override ?? z.detected_bpm
            return (
              <tr key={z.id} onClick={() => onSelect(z.id)}
                  className={cx('cursor-pointer', selected === z.id ? 'bg-brand-soft' : 'bg-panel hover:bg-panel-2')}>
                <td className="px-3 py-2 font-mono text-muted">{z.source_code}</td>
                <td className="px-3 py-2 truncate max-w-0" title={z.file_name}>{z.file_name}</td>
                <td className="px-3 py-2"><StatusChip status={z.status} /></td>
                <td className="px-3 py-2">
                  {formatBpm(bpm)}
                  {z.bpm_override != null ? <span className="text-accent ml-1" title="Set manually">●</span>
                    : z.tempo_confidence != null && <span className="text-faint ml-1.5">{z.tempo_confidence.toFixed(2)}</span>}
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
