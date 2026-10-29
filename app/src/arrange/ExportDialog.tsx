import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { playback } from '../audio/engine'
import { Button, cx, Field, inputClass, Modal, ProgressBar } from '../components/ui'
import { formatBpm } from '../lib/format'
import { BEATS_PER_BAR } from '../lib/project'
import { useApp } from '../store/app'
import { useProject } from '../store/project'
import type { WavFormat } from '../audio/wav'
import { exportStems, exportTargets, midiFileNames, type ExportOptions, type ExportResult } from './exporter'

type Phase =
  | { kind: 'setup' }
  | { kind: 'running'; message: string; pct: number }
  | { kind: 'clipping'; result: ExportResult; opts: ExportOptions }
  | { kind: 'done'; files: string[]; note?: string }
  | { kind: 'error'; message: string }

/** Export Stems (SCOPE.md §6.5). */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useProject((s) => s.project)
  const { settings, saveSettings } = useApp()
  const sampleRate = settings?.engine.output_sample_rate ?? 44100
  const usedLanes = useMemo(() => new Set(project.clips.map((c) => c.laneId)), [project.clips])
  const [dir, setDir] = useState<string>(settings?.lastExportDir ?? '')
  const [prefix, setPrefix] = useState(project.name)
  const hasLoop = project.loop.end > project.loop.start
  const [range, setRange] = useState<'project' | 'loop'>('project')
  const [format, setFormat] = useState<WavFormat>(settings?.engine.output_format === 'float32' ? 'float32' : 'pcm24')
  const [lanes, setLanes] = useState<string[]>(project.lanes.filter((l) => !l.mute && usedLanes.has(l.id)).map((l) => l.id))
  const [master, setMaster] = useState(false)
  const [midi, setMidi] = useState(project.markers.length > 0)
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' })
  const cancelled = useRef(false)

  useEffect(() => {
    if (!dir) void api.defaultExportFolder().then(setDir)
  }, [dir])

  const r = range === 'loop' && hasLoop
    ? { startBeat: project.loop.start, endBeat: project.loop.end }
    : { startBeat: 0, endBeat: project.lengthBars * BEATS_PER_BAR }
  const startBar = r.startBeat / BEATS_PER_BAR + 1
  const bars = (r.endBeat - r.startBeat) / BEATS_PER_BAR
  const base: ExportOptions = {
    dir, prefix: prefix.trim() || project.name, range: r, format, sampleRate, laneIds: lanes, master, midi,
    gain: 1, allowClipping: false,
  }
  const targets = exportTargets(project, base)
  const running = phase.kind === 'running'

  const run = async (opts: ExportOptions, checkExisting: boolean) => {
    cancelled.current = false
    if (checkExisting) {
      const names = [...exportTargets(project, opts).map((t) => t.file), ...(opts.midi ? midiFileNames(project, opts.prefix) : [])]
      const existing = await api.existingFiles(opts.dir, names)
      if (existing.length && !window.confirm(`Replace ${existing.length} existing file${existing.length > 1 ? 's' : ''} in ${opts.dir}?\n\n${existing.join('\n')}`)) return
      void saveSettings({ lastExportDir: opts.dir })
    }
    playback.stop()
    setPhase({ kind: 'running', message: 'Preparing', pct: 0 })
    try {
      const result = await exportStems(project, opts, (message, pct) => setPhase({ kind: 'running', message, pct }),
        () => cancelled.current)
      if (cancelled.current) setPhase({ kind: 'done', files: result.written, note: 'Export cancelled.' })
      else if (result.clipped.length) setPhase({ kind: 'clipping', result, opts })
      else setPhase({ kind: 'done', files: result.written })
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message })
    }
  }

  if (phase.kind === 'clipping') {
    const { result, opts } = phase
    const overDb = 20 * Math.log10(result.maxPeak)
    const gain = 0.97 / result.maxPeak  // ≈ -0.26 dBFS peak
    return (
      <Modal title="Some stems would clip" onClose={onClose}>
        <p className="text-muted leading-relaxed">
          {result.clipped.map((c) => c.target.label).join(', ')} peak{result.clipped.length === 1 ? 's' : ''} above
          0 dBFS (up to <span className="text-bad font-medium">+{overDb.toFixed(1)} dB</span>), which 24-bit files can't hold.
          {result.written.length > 0 && <> The other {result.written.length} file{result.written.length > 1 ? 's were' : ' was'} written.</>}
        </p>
        <div className="mt-4 grid gap-2">
          <Button variant="primary" className="justify-start h-9" onClick={() => void run({ ...opts, format: 'float32' }, false)}>
            Export everything as 32-bit float (no clipping; Logic reads it fine)
          </Button>
          <Button className="justify-start h-9" onClick={() => void run({ ...opts, gain }, false)}>
            Auto-gain: lower every stem by {(-20 * Math.log10(gain)).toFixed(1)} dB and export 24-bit
          </Button>
          <Button variant="ghost" className="justify-start h-9" onClick={() => void run({
            ...opts, allowClipping: true, laneIds: result.clipped.map((c) => c.target.key).filter((k) => k !== 'master'),
            master: result.clipped.some((c) => c.target.key === 'master'), midi: false,
          }, false)}>
            Export the clipping stems anyway
          </Button>
          <Button variant="ghost" className="justify-start h-9" onClick={onClose}>Cancel</Button>
        </div>
      </Modal>
    )
  }

  if (phase.kind === 'done' || phase.kind === 'error') {
    return (
      <Modal title={phase.kind === 'done' ? 'Export finished' : 'Export failed'} onClose={onClose}>
        {phase.kind === 'error' ? <p className="text-bad select-text">{phase.message}</p> : (
          <>
            {phase.note && <p className="text-warn mb-2">{phase.note}</p>}
            <p className="text-muted mb-3">
              {phase.files.length} file{phase.files.length === 1 ? '' : 's'} in <span className="text-text select-text">{dir}</span>.
              In Logic, set the project to <b className="text-text">{formatBpm(project.bpm)} BPM</b> and import them at
              <b className="text-text"> bar {startBar}</b>.
            </p>
            <ul className="text-[12px] space-y-0.5 max-h-56 overflow-y-auto font-mono select-text">
              {phase.files.map((f) => <li key={f}>{f}</li>)}
            </ul>
          </>
        )}
        <div className="flex justify-end gap-2 mt-5">
          {phase.kind === 'done' && phase.files.length > 0 && (
            <Button onClick={() => void api.revealPath(`${dir}/${phase.files[0]}`)}>Reveal in Finder</Button>
          )}
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Export stems" onClose={running ? undefined : onClose} width={620}>
      <Field label="Folder">
        <span className="truncate max-w-[300px] select-text" title={dir}>{dir}</span>
        <Button disabled={running} onClick={async () => {
          const d = await api.chooseExportFolder(dir || null)
          if (d) setDir(d)
        }}>Choose…</Button>
      </Field>
      <Field label="File name prefix">
        <input className={cx(inputClass, 'w-64')} value={prefix} disabled={running} onChange={(e) => setPrefix(e.target.value)} />
      </Field>
      <Field label="Range">
        <select className={cx(inputClass, 'w-64')} value={range} disabled={running} onChange={(e) => setRange(e.target.value as 'project' | 'loop')}>
          <option value="project">Whole project (bars 1–{project.lengthBars})</option>
          {hasLoop && <option value="loop">Loop region (bars {project.loop.start / 4 + 1}–{project.loop.end / 4})</option>}
        </select>
      </Field>
      <Field label="Format" hint={`${sampleRate / 1000} kHz (library rate)`}>
        <select className={cx(inputClass, 'w-44')} value={format} disabled={running} onChange={(e) => setFormat(e.target.value as WavFormat)}>
          <option value="pcm24">24-bit WAV</option>
          <option value="float32">32-bit float WAV</option>
        </select>
      </Field>
      <div className="mt-3">
        <div className="text-muted mb-1.5">Stems</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-line bg-panel-2 p-3">
          {project.lanes.map((l) => (
            <label key={l.id} className={cx('flex items-center gap-2', l.mute && 'text-faint')}>
              <input type="checkbox" className="accent-[#e2c35f]" disabled={l.mute || running}
                     checked={!l.mute && lanes.includes(l.id)}
                     onChange={(e) => setLanes((ls) => e.target.checked ? [...ls, l.id] : ls.filter((x) => x !== l.id))} />
              <span className="w-2 h-2 rounded-full" style={{ background: l.color }} />
              <span className="truncate">{l.name}</span>
              <span className="text-[11px] text-faint">{l.mute ? 'muted: skipped' : usedLanes.has(l.id) ? '' : 'empty'}</span>
            </label>
          ))}
          <label className="flex items-center gap-2 col-span-2 border-t border-line pt-2 mt-1">
            <input type="checkbox" className="accent-[#e2c35f]" checked={master} disabled={running} onChange={(e) => setMaster(e.target.checked)} />
            <span className="font-medium">Master</span><span className="text-[11px] text-faint">all unmuted lanes</span>
          </label>
          <label className="flex items-center gap-2 col-span-2">
            <input type="checkbox" className="accent-[#e2c35f]" checked={midi} disabled={running} onChange={(e) => setMidi(e.target.checked)} />
            <span className="font-medium">Markers (MIDI)</span>
            <span className="text-[11px] text-faint">tempo + {project.markers.length} section marker{project.markers.length === 1 ? '' : 's'} for Logic</span>
          </label>
        </div>
      </div>
      <p className="text-[12px] text-faint mt-3">
        {targets.length} WAV{targets.length === 1 ? '' : 's'}, each {bars} bars long from bar {startBar}, named
        {' '}<span className="font-mono">{targets[0]?.file ?? `${prefix}_<Lane>_${formatBpm(project.bpm)}bpm.wav`}</span>
        {targets.length > 1 ? ' …' : ''}. Solo is ignored; muted lanes are skipped.
      </p>
      {running && (
        <div className="mt-4">
          <div className="flex justify-between text-[12px] text-muted mb-1.5">
            <span>{phase.message}</span><span>{Math.round(phase.pct * 100)}%</span>
          </div>
          <ProgressBar value={phase.pct} />
        </div>
      )}
      <div className="flex justify-end gap-2 mt-5">
        {running ? <Button onClick={() => {
          cancelled.current = true
        }}>Cancel</Button> : <Button variant="ghost" onClick={onClose}>Cancel</Button>}
        <Button variant="primary" disabled={running || !dir || (!targets.length && !midi)} onClick={() => void run(base, true)}>
          Export
        </Button>
      </div>
    </Modal>
  )
}
