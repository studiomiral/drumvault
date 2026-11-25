import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../api'
import { parseInfoText, type TrackInfo } from '../arrange/exporter'
import { IconCheck, IconFolder, IconX } from '../components/icons'
import { PageTabs } from '../components/PageTabs'
import { Button, Chip, cx, Empty, inputClass, ProgressBar, SectionTitle } from '../components/ui'
import { attempt, useApp } from '../store/app'
import type { HotFillResult, UploadCheck, UploadFolder, UploadRecord, UploadStatus, ZipPart, ZipProgress } from '../types/api'
import {
  DEFAULT_GENRE, DEFAULT_INSTRUMENT, DEFAULT_PRICE, DEFAULT_VOCAL_CATEGORY, formatSize, GENRES, hotFields, INSTRUMENTS, PRICES, sings,
  uploadProblems, VOCAL_CATEGORIES,
} from '../upload/fields'

interface Track extends UploadFolder {
  parsed: TrackInfo
}

const STATUS_LABEL: Record<UploadStatus, string> = { none: 'Not uploaded', filled: 'Form filled', uploaded: 'Uploaded' }
const STATUS_STYLE: Record<UploadStatus, string> = {
  none: 'bg-raised text-muted',
  filled: 'bg-accent-soft text-accent',
  uploaded: 'bg-[rgb(74_222_128/0.12)] text-ok',
}

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '')

function StatusPill({ rec }: { rec: UploadRecord | undefined }) {
  const status = rec?.status ?? 'none'
  const when = status === 'uploaded' ? rec?.uploadedAt : status === 'filled' ? rec?.filledAt : undefined
  return (
    <span className={cx('inline-flex items-center rounded-md px-1.5 h-[18px] text-[11px] font-medium whitespace-nowrap', STATUS_STYLE[status])}>
      {STATUS_LABEL[status]}{when ? ` · ${day(when)}` : ''}
    </span>
  )
}

/**
 * Upload (SCOPE.md §6.5b): exported tracks, newest first; for the one picked, the folder checked,
 * stems/ and midi/ zipped, a price and the form's other choices, and House of Tracks' upload form
 * filled in its own window. The user checks the form and submits it there; everything is also
 * shown with Copy buttons, so an upload can always be done by hand.
 */
export function UploadView() {
  const { settings, saveSettings, toast } = useApp()
  const [dir, setDir] = useState<string | null>(null)
  const [tracks, setTracks] = useState<Track[] | null>(null)
  const [records, setRecords] = useState<Record<string, UploadRecord>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, ZipProgress>>({})
  const [zipping, setZipping] = useState<string | null>(null)
  const [filling, setFilling] = useState(false)
  const [report, setReport] = useState<{ name: string; result: HotFillResult } | null>(null)
  const [hotUrl, setHotUrl] = useState<string | null>(null)

  // The folder: the one chosen here, else where the last export went, else the default.
  useEffect(() => {
    if (dir) return
    const known = settings?.uploadDir ?? settings?.lastExportDir
    if (known) setDir(known)
    else void api.defaultExportFolder().then(setDir)
  }, [dir, settings?.uploadDir, settings?.lastExportDir])

  const load = useCallback(async () => {
    if (!dir) return
    const [list, recs] = await Promise.all([attempt(() => api.listExports(dir)), attempt(() => api.uploadRecords())])
    const ts = (list ?? []).map((f) => ({ ...f, parsed: parseInfoText(f.info) }))
    setTracks(ts)
    setRecords(recs ?? {})
    setSelected((s) => (s && ts.some((t) => t.name === s) ? s : ts[0]?.name ?? null))
  }, [dir])
  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => api.onZipProgress((p) => setProgress((x) => ({ ...x, [p.path]: p }))), [])
  useEffect(() => api.onHotPage(setHotUrl), [])

  const chooseFolder = async () => {
    const d = await api.chooseUploadFolder(dir)
    if (!d) return
    setDir(d)
    setTracks(null)
    void saveSettings({ uploadDir: d })
  }

  const setRecord = async (name: string, patch: Partial<UploadRecord>) => {
    const rec = await attempt(() => api.setUploadRecord(name, patch))
    if (rec) setRecords((r) => ({ ...r, [name]: rec }))
  }
  const setCheck = (path: string, check: UploadCheck) => setTracks((ts) => ts && ts.map((t) => (t.path === path ? { ...t, check } : t)))

  const track = tracks?.find((t) => t.name === selected) ?? null

  const zip = async (t: Track): Promise<UploadCheck | undefined> => {
    setZipping(t.path)
    try {
      const check = await attempt(() => api.zipExport(t.path))
      if (check) setCheck(t.path, check)
      return check
    } finally {
      setZipping(null)
      setProgress((x) => {
        const { [t.path]: _gone, ...rest } = x
        return rest
      })
    }
  }

  const fill = async (t: Track) => {
    // Zips first (only those missing or older than their folder are made).
    let check = t.check
    if (!check.zips.stems?.fresh || !check.zips.midi?.fresh) {
      const c = await zip(t)
      if (!c) return
      check = c
    }
    setFilling(true)
    setReport(null)
    try {
      const result = await attempt(() => api.hotFill({ folder: t.path, fields: hotFields(t.parsed, records[t.name]) }))
      if (!result) return
      setReport({ name: t.name, result })
      if (result.error) {
        toast('error', result.error)
        return
      }
      const failed = result.rows.filter((r) => !r.ok)
      if (failed.length) toast('error', `${failed.length} ${failed.length === 1 ? 'field' : 'fields'} not set: ${failed.map((r) => r.field).join(', ')}. Copy ${failed.length === 1 ? 'it' : 'them'} from the panel below.`)
      else toast('info', 'The form is filled. Check it in the House of Tracks window and submit it there.')
      if ((records[t.name]?.status ?? 'none') !== 'uploaded') void setRecord(t.name, { status: 'filled', filledAt: new Date().toISOString() })
    } finally {
      setFilling(false)
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="app-drag topbar-art h-14 shrink-0 flex items-center gap-4 px-6 border-b border-line">
        <PageTabs view="upload" />
        <span className="text-faint text-[12px] tabular-nums">
          {tracks ? `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}, ${tracks.filter((t) => records[t.name]?.status === 'uploaded').length} uploaded` : ''}
        </span>
        <div className="flex-1" />
        <span className="app-no-drag text-[12px] text-muted truncate max-w-[340px]" title={dir ?? ''}>{dir?.replace(/^\/Users\/[^/]+/, '~')}</span>
        <Button variant="ghost" className="app-no-drag" onClick={() => void load()}>Refresh</Button>
        <Button variant="secondary" className="app-no-drag" onClick={() => void chooseFolder()}>
          <IconFolder className="w-3.5 h-3.5" /> Choose folder…
        </Button>
      </header>

      <div className="flex-1 min-h-0 flex">
        <div className="w-[340px] shrink-0 border-r border-line overflow-y-auto px-3 py-4 space-y-1.5">
          {tracks && !tracks.length && (
            <Empty title="No exports here">Export a track from Create (Export…), or choose the folder your exports are in.</Empty>
          )}
          {tracks?.map((t) => {
            const p = uploadProblems(t.check, t.parsed)
            const rec = records[t.name]
            return (
              <button key={t.path} onClick={() => setSelected(t.name)}
                      className={cx('w-full text-left rounded-xl px-3 py-2.5 border transition-colors',
                        t.name === selected ? 'border-accent/50 bg-accent-soft' : 'border-transparent hover:bg-panel-2')}>
                <div className="flex items-center gap-2">
                  <span className="flex-1 truncate text-[13px] font-medium">{t.parsed.title || t.name}</span>
                  {p.blocking.length > 0 && <span className="text-bad text-[11px]" title={p.blocking.join('\n')}>{p.blocking.length} missing</span>}
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11.5px] text-muted tabular-nums">
                  <span>{t.parsed.bpm || '?'} BPM</span><span className="text-faint">·</span>
                  <span>{t.parsed.key || 'no key'}</span><span className="text-faint">·</span>
                  <span>{t.parsed.length.split(' ')[0] || '?'}</span>
                  <span className="flex-1" />
                  <StatusPill rec={rec} />
                </div>
              </button>
            )
          })}
        </div>

        <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5">
          {track ? (
            <TrackPanel key={track.path} track={track} rec={records[track.name]} setRecord={(patch) => setRecord(track.name, patch)}
                        progress={progress[track.path]} zipping={zipping === track.path} busy={zipping !== null || filling} filling={filling}
                        report={report?.name === track.name ? report.result : null} hotUrl={hotUrl}
                        onZip={() => void zip(track)} onFill={() => void fill(track)} />
          ) : tracks?.length ? null : (
            <div className="text-faint text-[12.5px]">{tracks ? '' : 'Looking for exports…'}</div>
          )}
        </div>
      </div>
    </div>
  )
}

function TrackPanel({ track, rec, setRecord, progress, zipping, busy, filling, report, hotUrl, onZip, onFill }: {
  track: Track
  rec: UploadRecord | undefined
  setRecord: (patch: Partial<UploadRecord>) => Promise<void>
  progress: ZipProgress | undefined
  zipping: boolean
  busy: boolean
  filling: boolean
  report: HotFillResult | null
  hotUrl: string | null
  onZip: () => void
  onFill: () => void
}) {
  const { parsed: info, check } = track
  const problems = useMemo(() => uploadProblems(check, info), [check, info])
  const fields = hotFields(info, rec)
  const singing = sings(info)
  const status = rec?.status ?? 'none'
  const zipsFresh = !!check.zips.stems?.fresh && !!check.zips.midi?.fresh
  const failed = report?.rows.filter((r) => !r.ok) ?? []

  const checks: { label: string; ok: boolean }[] = [
    { label: 'info.txt', ok: check.info },
    { label: check.master ? `masters/${base(check.master)}` : 'masters/mastered.wav', ok: !!check.master },
    { label: 'masters/mixdown.wav', ok: !!check.mixdown },
    ...(singing ? [
      { label: check.masterInstrumental ? `masters/${base(check.masterInstrumental)}` : 'masters/mastered instrumental.wav', ok: !!check.masterInstrumental },
      { label: 'masters/mixdown instrumental.wav', ok: !!check.mixdownInstrumental },
    ] : []),
    { label: `${check.stemsZipOnly ? 'stems.zip' : 'stems/'} (${check.stems} WAV${check.stems === 1 ? '' : 's'})`, ok: check.stems > 0 },
    { label: `midi/ (${check.midi} file${check.midi === 1 ? '' : 's'})`, ok: check.midi > 0 },
  ]

  return (
    <div className="max-w-[860px] space-y-5">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <h2 className="font-display text-[24px] font-medium leading-tight truncate">{fields.trackName}</h2>
          <div className="mt-1 flex items-center gap-2 text-[12.5px] text-muted">
            <span className="truncate">{track.name}</span>
            <StatusPill rec={rec} />
          </div>
        </div>
        <Button variant="ghost" onClick={() => void api.revealPath(track.path)}>Reveal in Finder</Button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card title="The folder">
          <ul className="space-y-1 text-[12.5px]">
            {checks.map((c) => (
              <li key={c.label} className="flex items-center gap-2">
                {c.ok ? <IconCheck className="w-3.5 h-3.5 text-ok shrink-0" /> : <IconX className="w-3.5 h-3.5 text-bad shrink-0" />}
                <span className={cx('truncate', !c.ok && 'text-bad')}>{c.label}</span>
              </li>
            ))}
          </ul>
          {problems.track.map((b) => (
            <div key={b} className="mt-2 text-[12px] text-bad">{b}</div>
          ))}
          {problems.warnings.map((w) => <div key={w} className="mt-2 text-[12px] text-warn">{w}</div>)}
        </Card>

        <Card title="Price and the form's choices">
          <div className="space-y-2 text-[12.5px]">
            <Choice label="Price">
              <select className={cx(inputClass, 'w-full')} value={rec?.price ?? DEFAULT_PRICE}
                      onChange={(e) => void setRecord({ price: Number(e.target.value) })}>
                {PRICES.map((p) => <option key={p} value={p}>€{p}</option>)}
              </select>
            </Choice>
            <Choice label="Genre">
              <select className={cx(inputClass, 'w-full')} value={rec?.genre ?? DEFAULT_GENRE} onChange={(e) => void setRecord({ genre: e.target.value })}>
                {GENRES.map((g) => <option key={g}>{g}</option>)}
              </select>
            </Choice>
            <Choice label="Main instrument">
              <select className={cx(inputClass, 'w-full')} value={rec?.instrument ?? DEFAULT_INSTRUMENT} onChange={(e) => void setRecord({ instrument: e.target.value })}>
                {INSTRUMENTS.map((g) => <option key={g}>{g}</option>)}
              </select>
            </Choice>
            <Choice label="Vocal category">
              {singing ? (
                <select className={cx(inputClass, 'w-full')} value={rec?.vocalCategory ?? DEFAULT_VOCAL_CATEGORY}
                        onChange={(e) => void setRecord({ vocalCategory: e.target.value })}>
                  {VOCAL_CATEGORIES.map((g) => <option key={g}>{g}</option>)}
                </select>
              ) : <span className="text-muted">Instrumental (it doesn't sing)</span>}
            </Choice>
          </div>
        </Card>
      </div>

      <Card title="Zips for House of Tracks" right={
        <span className="flex items-center gap-1">
          {zipping
            ? <Button variant="ghost" onClick={() => void api.cancelZip(track.path)}>Cancel</Button>
            : <Button variant="secondary" disabled={busy || !check.stems} onClick={onZip}>{check.zips.stems || check.zips.midi ? 'Update zips' : 'Make zips'}</Button>}
        </span>
      }>
        <div className="space-y-1.5 text-[12.5px]">
          {(['stems', 'midi'] as ZipPart[]).map((part) => {
            const z = check.zips[part]
            const p = progress?.part === part ? progress : null
            return (
              <div key={part} className="flex items-center gap-3">
                <span className="w-[76px] text-muted">{part}.zip</span>
                {p ? (
                  <>
                    <ProgressBar value={p.total ? p.done / p.total : 0} className="flex-1" />
                    <span className="w-[120px] text-right tabular-nums text-muted">{formatSize(p.done)} / {formatSize(p.total)}</span>
                  </>
                ) : z ? (
                  <>
                    <span className="tabular-nums">{formatSize(z.size)}</span>
                    {z.fresh ? <Chip className="!text-ok">up to date</Chip> : <Chip className="!text-warn">older than {part}/</Chip>}
                    <span className="flex-1" />
                    <Button variant="ghost" onClick={() => void api.revealPath(z.path)}>Reveal zip in Finder</Button>
                  </>
                ) : (
                  <span className="text-faint">{zipping ? 'waiting…' : 'not made yet'}</span>
                )}
              </div>
            )
          })}
          <div className="text-[11.5px] text-faint pt-1">
            stems/ and midi/ each zipped as Finder's Compress does, next to them in the project folder; the stem WAVs are deleted once
            they're in stems.zip, to save space. The masters go up as they are.
          </div>
        </div>
      </Card>

      <Card title="House of Tracks">
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="primary" disabled={busy || problems.blocking.length > 0} onClick={onFill}
                  title={problems.blocking.length ? problems.blocking.join('\n') : 'Open the upload form, fill it and attach the files. You submit it there.'}>
            {filling ? 'Filling the form…' : zipping ? 'Zipping…' : zipsFresh ? 'Fill upload form' : 'Zip and fill upload form'}
          </Button>
          <Button variant="ghost" onClick={() => void api.hotOpen()}>Open House of Tracks</Button>
          {import.meta.env.DEV && (
            <Button variant="ghost" title="Dev: write every field of the page to a JSON file"
                    onClick={() => void attempt(() => api.hotDump()).then((p) => p && useApp.getState().toast('info', `Form dumped: ${p}`))}>
              Dump form
            </Button>
          )}
          <span className="flex-1" />
          {status !== 'uploaded' ? (
            <Button variant="secondary" disabled={status === 'none'} title="Once you've submitted it on House of Tracks"
                    onClick={() => void setRecord({ status: 'uploaded', uploadedAt: new Date().toISOString() })}>
              I submitted it: mark as uploaded
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => void setRecord({ status: rec?.filledAt ? 'filled' : 'none', uploadedAt: undefined })}>
              Mark as not uploaded
            </Button>
          )}
        </div>
        {problems.blocking.length > 0 && (
          <div className="mt-2 text-[12px] text-bad">Fix what's missing in the folder first ({problems.blocking.length}).</div>
        )}
        <div className="mt-2 text-[11.5px] text-faint">
          The form opens in its own window (log in there once). Every field is filled and the files attached; nothing is
          submitted: check the form, then press Next step and Submit there yourself.
          {hotUrl && <> Window: <span className="text-muted">{hotUrl.replace(/^https:\/\//, '')}</span></>}
        </div>
        {report && (
          <div className="mt-3 rounded-lg border border-line divide-y divide-line">
            {report.error && <div className="px-3 py-2 text-[12.5px] text-bad">{report.error}</div>}
            {report.rows.map((r) => (
              <div key={r.field} className="px-3 py-1.5 flex items-start gap-2 text-[12px]">
                {r.ok ? <IconCheck className="w-3.5 h-3.5 mt-0.5 text-ok shrink-0" /> : <IconX className="w-3.5 h-3.5 mt-0.5 text-bad shrink-0" />}
                <span className="w-[150px] shrink-0 text-muted">{r.field}</span>
                <span className="flex-1 min-w-0 truncate" title={r.value}>{r.value || '—'}</span>
                {r.note && <span className={cx('shrink-0 max-w-[45%] text-right', r.ok ? 'text-faint' : 'text-bad')}>{r.note}</span>}
              </div>
            ))}
            {failed.length > 0 && (
              <div className="px-3 py-2 text-[12px] text-warn">
                Not set: {failed.map((r) => r.field).join(', ')}. Copy {failed.length === 1 ? 'it' : 'them'} from “By hand” below.
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title="By hand">
        <div className="divide-y divide-line text-[12.5px]">
          <CopyRow label="Track name" value={fields.trackName} />
          <CopyRow label="BPM" value={String(Math.round(Number(fields.bpm)) || fields.bpm)} />
          <CopyRow label="Key" value={fields.key} />
          <CopyRow label="Genre" value={fields.genre} />
          <CopyRow label="Tags" value={fields.tags.join(', ')} />
          <CopyRow label="Description" value={fields.description} multiline />
          <CopyRow label="Price" value={`€${fields.price}`} />
          <CopyRow label="Main instrument" value={fields.instrument} />
          <CopyRow label="This track contains" value={fields.vocal} />
          <CopyRow label="Vocal category" value={fields.vocalCategory} />
          {fields.lyrics && <CopyRow label="Lyrics" value={fields.lyrics} multiline />}
          {fields.vocalPack && <CopyRow label="Vocal pack" value={fields.vocalPack} />}
          {fields.vocalPackUrl && <CopyRow label="Vocal pack URL" value={fields.vocalPackUrl} />}
          {singing && <CopyRow label="Vocal credits" value={info.vocals} multiline />}
          <FileRow label="Master" path={check.master} />
          {singing && <FileRow label="Master Instrumental" path={check.masterInstrumental} />}
          <FileRow label="Mixdown" path={check.mixdown} />
          {singing && <FileRow label="Mixdown Instrumental" path={check.mixdownInstrumental} />}
          <FileRow label="Stems Folder" path={check.zips.stems?.path ?? null} />
          <FileRow label="Midi Folder" path={check.zips.midi?.path ?? null} />
        </div>
      </Card>
    </div>
  )
}

const base = (p: string) => p.split('/').pop() ?? p

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-panel-2 px-4 py-3.5">
      <SectionTitle right={right}>{title}</SectionTitle>
      {children}
    </section>
  )
}

function Choice({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[120px_1fr] items-center gap-3">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  )
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button variant="ghost" className="shrink-0 w-[64px]" disabled={!value}
            onClick={() => void navigator.clipboard.writeText(value).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            })}>
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

function CopyRow({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className="py-1.5 flex items-start gap-3">
      <span className="w-[150px] shrink-0 pt-1 text-muted">{label}</span>
      <span className={cx('flex-1 min-w-0 pt-1 select-text', multiline ? 'whitespace-pre-wrap' : 'truncate', !value && 'text-faint')}>{value || '—'}</span>
      <CopyButton value={value} />
    </div>
  )
}

function FileRow({ label, path }: { label: string; path: string | null }) {
  return (
    <div className="py-1.5 flex items-center gap-3">
      <span className="w-[150px] shrink-0 text-muted">{label}</span>
      <span className={cx('flex-1 min-w-0 truncate select-text', !path && 'text-bad')} title={path ?? ''}>{path ? base(path) : 'missing'}</span>
      {path && <Button variant="ghost" onClick={() => void api.revealPath(path)}>Reveal</Button>}
      <CopyButton value={path ?? ''} />
    </div>
  )
}
