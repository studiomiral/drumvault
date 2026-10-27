import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { IconX } from '../components/icons'
import { Button, Chip, cx, inputClass, SectionTitle, StatusChip } from '../components/ui'
import { ALL_KEYS } from '../lib/camelot'
import { CATEGORY_LABELS, formatBpm, formatDuration, parseJsonArray, STEM_CATEGORIES } from '../lib/format'
import { attempt, useApp } from '../store/app'
import { useLibrary } from '../store/library'
import type { ZipDetail } from '../types/api'
import type { Category } from '../types/engine'

/** Zip review: stems, tempo/grid, key, warnings, and overrides + reprocess (SCOPE.md §6.2). */
export function ZipDetailPanel({ zipId, onClose }: { zipId: number; onClose: () => void }) {
  const { libraryVersion, jobs, toast, setView } = useApp()
  const [detail, setDetail] = useState<ZipDetail | null>(null)
  const [bpm, setBpm] = useState('')
  const [offset, setOffset] = useState('')
  const [key, setKey] = useState('')
  const [stemEdits, setStemEdits] = useState<Record<number, Category>>({})

  useEffect(() => {
    let alive = true
    void api.zipDetail(zipId).then((d) => {
      if (!alive) return
      setDetail(d)
      if (d) {
        setBpm(d.zip.bpm_override != null ? String(d.zip.bpm_override) : '')
        setOffset(d.zip.grid_offset_override_ms != null ? String(d.zip.grid_offset_override_ms) : '')
        setKey(d.zip.key_override ?? '')
        setStemEdits({})
      }
    })
    return () => {
      alive = false
    }
  }, [zipId, libraryVersion])

  const busy = jobs.some((j) => j.zip_id === zipId && (j.status === 'queued' || j.status === 'processing'))

  const sourceSr = useMemo(() => {
    const src = detail?.stems.find((s) => detail.zip.bpm_source_stem?.split(' + ').includes(s.file_name))
    return src?.sample_rate ?? 44100
  }, [detail])

  if (!detail) {
    return <aside className="w-[460px] shrink-0 border-l border-line bg-panel" />
  }
  const z = detail.zip
  const detectedOffsetMs = z.phase_samples != null ? (z.phase_samples / sourceSr) * 1000 : null
  const dirty = bpm !== (z.bpm_override != null ? String(z.bpm_override) : '')
    || offset !== (z.grid_offset_override_ms != null ? String(z.grid_offset_override_ms) : '')
    || key !== (z.key_override ?? '') || Object.keys(stemEdits).length > 0

  const nudge = (ms: number) => {
    const cur = offset === '' ? (detectedOffsetMs ?? 0) : Number(offset)
    setOffset(String(Math.round((cur + ms) * 10) / 10))
  }

  const reprocess = async () => {
    const bpmNum = bpm.trim() === '' ? null : Number(bpm)
    const offNum = offset.trim() === '' ? null : Number(offset)
    if ((bpmNum != null && !(bpmNum > 40 && bpmNum < 250)) || (offNum != null && Number.isNaN(offNum))) {
      toast('error', 'Check the BPM and grid offset values.')
      return
    }
    const stems = Object.fromEntries(Object.entries(stemEdits).map(([id, c]) => [id, c]))
    await attempt(() => api.reprocessZip(zipId, { bpm: bpmNum, grid_offset_ms: offNum, key: key || null, stems }))
  }

  const remove = async () => {
    if (!window.confirm(`Delete all ${z.oneshots + z.loops} samples of ${z.source_code} from the library? The zip itself is not touched.`)) return
    await attempt(() => api.deleteZip(zipId))
    onClose()
  }

  return (
    <aside className="w-[460px] shrink-0 border-l border-line bg-panel flex flex-col min-h-0">
      <div className="px-5 pt-4 pb-3 border-b border-line">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-muted">{z.source_code}</span>
              <StatusChip status={z.status} />
            </div>
            <div className="font-medium mt-1 break-words select-text">{z.file_name}</div>
            <div className="text-[11.5px] text-faint mt-0.5 truncate select-text" title={z.original_path}>
              {detail.originalExists ? z.original_path : `Original zip missing: ${z.original_path}`}
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text mt-0.5"><IconX className="w-4 h-4" /></button>
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          <Button variant="primary" disabled={busy || !detail.originalExists} onClick={() => void reprocess()}>
            {busy ? 'Processing…' : dirty ? 'Reprocess with changes' : 'Reprocess'}
          </Button>
          <Button onClick={() => {
            useLibrary.getState().resetFilter()
            useLibrary.getState().setFilter({ zipIds: [zipId] })
            setView('library')
          }}>Show samples</Button>
          <Button variant="ghost" disabled={!detail.originalExists}
                  onClick={() => void api.revealZip(zipId)}>Reveal zip</Button>
          <div className="flex-1" />
          <Button variant="danger" disabled={busy} onClick={() => void remove()}>Delete samples</Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-6">
        {detail.warnings.length > 0 && (
          <section>
            <SectionTitle>Warnings</SectionTitle>
            <ul className="space-y-1.5">
              {detail.warnings.map((w, i) => (
                <li key={i} className="text-[12px] text-warn bg-[#f59e0b14] rounded px-2.5 py-1.5 select-text">{w}</li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <SectionTitle>Tempo &amp; grid</SectionTitle>
          <div className="grid grid-cols-[110px_1fr] gap-y-2 items-center">
            <span className="text-muted">Detected</span>
            <span>
              {formatBpm(z.detected_bpm)} BPM
              {z.tempo_confidence != null && (
                <span className={cx('ml-2', z.tempo_confidence < 0.8 ? 'text-warn' : 'text-faint')}>
                  confidence {z.tempo_confidence.toFixed(2)}
                </span>
              )}
            </span>
            <span className="text-muted">From</span>
            <span className="truncate text-muted" title={z.bpm_source_stem ?? ''}>{z.bpm_source_stem ?? '–'}</span>
            <span className="text-muted">BPM override</span>
            <span className="flex items-center gap-2">
              <input className={cx(inputClass, 'w-24')} placeholder={formatBpm(z.detected_bpm)} value={bpm}
                     onChange={(e) => setBpm(e.target.value)} inputMode="decimal" />
              {bpm !== '' && <Button variant="ghost" onClick={() => setBpm('')}>Use detected</Button>}
            </span>
            <span className="text-muted">Bar 1 offset</span>
            <span className="flex items-center gap-1.5">
              <input className={cx(inputClass, 'w-20')} placeholder={detectedOffsetMs != null ? detectedOffsetMs.toFixed(1) : '0'}
                     value={offset} onChange={(e) => setOffset(e.target.value)} inputMode="decimal" />
              <span className="text-faint mr-1">ms</span>
              {[-10, -1, 1, 10].map((d) => (
                <Button key={d} variant="ghost" className="px-1.5" onClick={() => nudge(d)}>{d > 0 ? `+${d}` : d}</Button>
              ))}
              {offset !== '' && <Button variant="ghost" onClick={() => setOffset('')}>Reset</Button>}
            </span>
          </div>
        </section>

        <section>
          <SectionTitle>Key</SectionTitle>
          <div className="grid grid-cols-[110px_1fr] gap-y-2 items-center">
            <span className="text-muted">Detected</span>
            <span>
              {z.key_label ?? 'NoKey'} {z.key_camelot && <span className="text-faint">{z.key_camelot}</span>}
              {z.key_confidence != null && z.key_label && (
                <span className={cx('ml-2', z.key_confidence < 0.5 ? 'text-warn' : 'text-faint')}>
                  confidence {z.key_confidence.toFixed(2)}
                </span>
              )}
            </span>
            <span className="text-muted">Override</span>
            <select className={cx(inputClass, 'w-44')} value={key} onChange={(e) => setKey(e.target.value)}>
              <option value="">Use detected</option>
              {ALL_KEYS.map((k) => <option key={k.label} value={k.label}>{k.label} ({k.camelot})</option>)}
            </select>
          </div>
        </section>

        <section>
          <SectionTitle>Stems</SectionTitle>
          <div className="space-y-1">
            {detail.stems.map((s) => {
              const used = parseJsonArray(s.used_for)
              const value = stemEdits[s.id] ?? s.category
              return (
                <div key={s.id} className="rounded-md bg-panel-2 px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 truncate select-text" title={s.file_name}>{s.file_name}</span>
                    {s.auto_classified ? <Chip className="text-warn" title="Classified by sound, not by name: check it">auto</Chip> : null}
                    <select
                      className={cx(inputClass, 'h-6 text-[12px] w-40', stemEdits[s.id] && 'border-accent')}
                      value={value}
                      onChange={(e) => {
                        const c = e.target.value as Category
                        setStemEdits((m) => {
                          const next = { ...m }
                          if (c === s.category) delete next[s.id]
                          else next[s.id] = c
                          return next
                        })
                      }}
                    >
                      {STEM_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                    </select>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1 text-[11px] text-faint">
                    <span>{formatDuration(s.duration_s)} · {s.sample_rate / 1000} kHz · {s.channels === 1 ? 'mono' : 'stereo'}</span>
                    {s.category_override && <span className="text-accent">· set manually</span>}
                    <span className="flex-1" />
                    {used.map((u) => <Chip key={u}>{u}</Chip>)}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </aside>
  )
}
