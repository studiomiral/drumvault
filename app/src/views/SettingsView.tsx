import { useEffect, useState } from 'react'
import { api } from '../api'
import { Button, cx, Field, inputClass, PageTitle, SectionTitle } from '../components/ui'
import { ENGINE_DEFAULTS, resolveEngine, type ResolvedEngineOptions } from '../lib/defaults'
import { CATEGORY_LABELS } from '../lib/format'
import { attempt, serumPresetRoot, useApp } from '../store/app'
import { SERUM_MODULES } from '../components/SerumFolders'
import { loadBass, useBass } from '../store/bass'
import { loadReferences } from '../store/generate'
import { cleanRenders } from '../store/renders'
import { ELEVENLABS } from '../vocals/plan'
import type { CleanRendersResult, ReferencesResult } from '../types/engine'
import type { ElevenStatus, LibraryFacets } from '../types/api'
import type { Category } from '../types/engine'

const LOOP_CATS = Object.keys(ENGINE_DEFAULTS.loop_lengths) as Category[]

export function SettingsView() {
  const { settings, saveSettings, engine, deps, refreshDeps, toast, libraryVersion } = useApp()
  const [draft, setDraft] = useState<ResolvedEngineOptions>(() => resolveEngine(settings!.engine))
  const [paths, setPaths] = useState({ enginePath: settings!.enginePath ?? '', uvPath: settings!.uvPath ?? '' })
  const [facets, setFacets] = useState<LibraryFacets | null>(null)

  useEffect(() => {
    void api.facets().then(setFacets)
  }, [libraryVersion])

  if (!settings) return null
  const saved = resolveEngine(settings.engine)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
    || paths.enginePath !== (settings.enginePath ?? '') || paths.uvPath !== (settings.uvPath ?? '')
  const set = <K extends keyof ResolvedEngineOptions>(k: K, v: ResolvedEngineOptions[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const num = (k: keyof ResolvedEngineOptions, step = 1) => (
    <input type="number" step={step} className={cx(inputClass, 'w-24')} value={String(draft[k] ?? '')}
           onChange={(e) => set(k, (e.target.value === '' ? '' : Number(e.target.value)) as never)} />
  )

  const save = async () => {
    // Only values that differ from the engine defaults are stored and sent.
    const engineOpts: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(draft)) {
      if (JSON.stringify(v) !== JSON.stringify((ENGINE_DEFAULTS as Record<string, unknown>)[k])) engineOpts[k] = v
    }
    await attempt(() => saveSettings({
      engine: engineOpts, enginePath: paths.enginePath.trim() || null, uvPath: paths.uvPath.trim() || null,
    }))
    toast('info', 'Settings saved')
  }

  const changeLibrary = async () => {
    const dir = await api.chooseLibraryFolder()
    if (dir && dir !== settings.libraryPath) await attempt(() => saveSettings({ libraryPath: dir }))
  }

  const staleLoops = (facets?.loopBpms ?? []).filter((b) => b !== saved.library_bpm)

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="app-drag topbar-art h-14 shrink-0 flex items-center gap-4 px-6 border-b border-line">
        <PageTitle>Settings</PageTitle>
        <div className="flex-1" />
        <Button variant="ghost" disabled={!dirty} onClick={() => {
          setDraft(saved)
          setPaths({ enginePath: settings.enginePath ?? '', uvPath: settings.uvPath ?? '' })
        }}>Revert</Button>
        <Button variant="primary" disabled={!dirty} onClick={() => void save()}>Save</Button>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        <div className="max-w-[760px] space-y-8">
          <section>
            <SectionTitle>Library</SectionTitle>
            <Field label="Library folder">
              <span className="truncate select-text max-w-[360px]" title={settings.libraryPath ?? ''}>{settings.libraryPath}</span>
              <Button onClick={() => void changeLibrary()}>Change…</Button>
              <Button variant="ghost" onClick={() => void api.openLibraryFolder()}>Show</Button>
            </Field>
            <p className="text-faint text-[12px] ml-[192px] -mt-0.5">
              Changing this switches to another library; it doesn't move the current one.
            </p>
            <Field label="Library BPM" hint="loops and FX/fills are stretched to this tempo">{num('library_bpm')}</Field>
            {staleLoops.length > 0 && (
              <div className="ml-[192px] mt-1 mb-2 rounded-md border border-[rgb(251_191_36/0.3)] bg-[rgb(251_191_36/0.08)] px-3 py-2 text-[12px] flex items-center gap-3">
                <span className="flex-1 text-warn">
                  The library has loops and FX/fills at {staleLoops.join(', ')} BPM. Rebuild them at {saved.library_bpm} BPM
                  (one-shots stay; the original zips must still exist).
                </span>
                <Button disabled={dirty || engine.state !== 'ready'} onClick={() => {
                  if (window.confirm(`Rebuild all loops and FX/fills at ${saved.library_bpm} BPM? This reprocesses every zip.`)) {
                    void attempt(() => api.rebuildLoops())
                    useApp.getState().setView('process')
                  }
                }}>Rebuild loops</Button>
              </div>
            )}
          </section>

          <section>
            <SectionTitle>Analysis</SectionTitle>
            <Field label="Source BPM range">
              {num('bpm_min')}<span className="text-faint">to</span>{num('bpm_max')}
            </Field>
            <Field label="Whole-number BPM" hint="source tracks are always integer BPM">
              <input type="checkbox" checked={!!draft.integer_bpm} onChange={(e) => set('integer_bpm', e.target.checked)}
                     className="accent-[#e2c35f]" />
            </Field>
            <Field label="Max stretch" hint="skip loops beyond this tempo change">
              <input type="number" className={cx(inputClass, 'w-24')} value={Math.round(draft.max_stretch * 100)}
                     onChange={(e) => set('max_stretch', Number(e.target.value) / 100)} />
              <span className="text-faint">%</span>
            </Field>
          </section>

          <section>
            <SectionTitle>Output</SectionTitle>
            <Field label="Sample rate">
              <select className={cx(inputClass, 'w-28')} value={draft.output_sample_rate}
                      onChange={(e) => set('output_sample_rate', Number(e.target.value) as 44100 | 48000)}>
                <option value={44100}>44.1 kHz</option>
                <option value={48000}>48 kHz</option>
              </select>
            </Field>
            <Field label="Format">
              <select className={cx(inputClass, 'w-36')} value={draft.output_format}
                      onChange={(e) => set('output_format', e.target.value as 'pcm24' | 'float32')}>
                <option value="pcm24">24-bit WAV</option>
                <option value="float32">32-bit float WAV</option>
              </select>
            </Field>
            <Field label="One-shot peak" hint="dBFS">{num('oneshot_peak_dbfs', 0.1)}</Field>
            <Field label="Loop normalisation">
              <select className={cx(inputClass, 'w-28')} value={draft.loop_norm_mode}
                      onChange={(e) => set('loop_norm_mode', e.target.value as 'peak' | 'lufs')}>
                <option value="peak">Peak</option>
                <option value="lufs">Loudness</option>
              </select>
              {draft.loop_norm_mode === 'peak'
                ? <>{num('loop_peak_dbfs', 0.1)}<span className="text-faint">dBFS</span></>
                : <>{num('loop_lufs_target', 0.5)}<span className="text-faint">LUFS (peak ≤ {draft.loop_peak_dbfs} dBFS)</span></>}
            </Field>
          </section>

          <section>
            <SectionTitle>Selection</SectionTitle>
            <Field label="One-shots per stem">{num('max_oneshots_per_stem')}</Field>
            <Field label="Loops per stem & length">{num('max_loops_per_length')}</Field>
            <Field label="FX & fills per stem">{num('max_events_per_stem')}</Field>
            <Field label="Duplicate threshold" hint="one-shots / loops; higher keeps more variations">
              {num('oneshot_dedupe_threshold', 0.005)}{num('loop_dedupe_threshold', 0.005)}
            </Field>
            <div className="mt-3">
              <div className="text-muted mb-1.5">Loop lengths (bars)</div>
              <div className="grid grid-cols-3 gap-x-6 gap-y-1">
                {LOOP_CATS.map((c) => (
                  <label key={c} className="flex items-center gap-2">
                    <span className="w-24 text-muted text-[12px]">{CATEGORY_LABELS[c]}</span>
                    <input className={cx(inputClass, 'w-24 h-6 text-[12px]')}
                           defaultValue={(draft.loop_lengths[c] ?? []).join(', ')}
                           key={`${c}:${(draft.loop_lengths[c] ?? []).join(',')}`}
                           onBlur={(e) => {
                             const bars = e.target.value.split(/[ ,]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0)
                             set('loop_lengths', { ...draft.loop_lengths, [c]: bars })
                           }} />
                  </label>
                ))}
              </div>
              <p className="text-faint text-[12px] mt-1.5">Leave empty for no loops. Changes apply to newly processed or reprocessed zips.</p>
            </div>
          </section>

          <SerumSettingsSection />

          <ReferencesSection />

          <StorageSection />

          {ELEVENLABS && <ElevenLabsSection />}

          <section>
            <SectionTitle right={<Button variant="ghost" onClick={() => void refreshDeps()}>Check again</Button>}>Engine</SectionTitle>
            <Field label="Status">
              <span className={engine.state === 'ready' ? 'text-ok' : engine.state === 'starting' ? 'text-warn' : 'text-bad'}>
                {engine.message || engine.state}
              </span>
              <Button variant="ghost" onClick={() => void attempt(() => api.restartEngine())}>Restart</Button>
            </Field>
            {engine.health && (
              <Field label="Versions">
                <span className="text-muted">
                  engine {engine.health.version} · Python {engine.health.python} · Rubber Band {engine.health.rubberband ?? 'missing'}
                  {engine.health.rubberband_r3 ? ' (R3)' : ''} · key: {engine.health.key_backend}
                </span>
              </Field>
            )}
            {deps?.checks.map((c) => (
              <Field key={c.name} label={c.name}>
                <span className={c.ok ? 'text-ok' : 'text-bad'}>{c.ok ? '✓' : '✕'}</span>
                <span className="text-muted truncate max-w-[420px] select-text" title={c.detail}>{c.detail}</span>
                {c.fix && <code className="text-accent select-text">{c.fix}</code>}
              </Field>
            ))}
            <Field label="Engine folder" hint="empty = the bundled engine (../engine in dev)">
              <input className={cx(inputClass, 'w-[380px]')} placeholder="(default)" value={paths.enginePath}
                     onChange={(e) => setPaths((p) => ({ ...p, enginePath: e.target.value }))} />
            </Field>
            <Field label="uv binary" hint="empty = search PATH">
              <input className={cx(inputClass, 'w-[380px]')} placeholder="(default)" value={paths.uvPath}
                     onChange={(e) => setPaths((p) => ({ ...p, uvPath: e.target.value }))} />
            </Field>
          </section>
        </div>
      </div>
    </div>
  )
}

/**
 * Serum 2 (SCOPE.md §6.7): the presets folder, and per module that plays Serum patches (the
 * bass) the folders under it that make up its patch pool (saved at once, apart from the engine
 * settings).
 */
function SerumSettingsSection() {
  const { libraryVersion, toast, setView } = useApp()
  const rootNow = serumPresetRoot()
  const pools = { bass: useBass((s) => s.presets.length), pads: useBass((s) => s.padPresets.length), plucks: useBass((s) => s.pluckPresets.length) }
  const parts = { bass: useBass((s) => s.basslines.length), pads: null, plucks: null }
  const organic = useApp((s) => s.settings?.genre === 'organic')
  useEffect(() => {
    void loadBass()
  }, [libraryVersion])
  const [root, setRoot] = useState(rootNow)

  const changeRoot = async (next: string) => {
    if (!next || next === rootNow) return
    // The folders picked are under the old one: every module starts again.
    await useApp.getState().saveSettings({ serumPresetRoot: next })
    for (const m of SERUM_MODULES) {
      await m.save({ folders: [] })
      await m.load()
    }
  }
  const openRoot = async () => {
    const err = await api.openFolder(rootNow)
    if (err) toast('error', `Can't open ${rootNow}: ${err}`)
  }

  return (
    <section>
      <SectionTitle>Serum 2</SectionTitle>
      <Field label="Presets folder" hint="Serum 2's .SerumPreset files the Bass draws its patches from">
        <span className="flex items-center gap-2">
          <input className={cx(inputClass, 'w-[420px]')} value={root} onChange={(e) => setRoot(e.target.value)}
                 onBlur={() => void changeRoot(root.trim())} />
          <Button variant="ghost" onClick={() => void openRoot()} title="Open the presets folder in Finder">Show in Finder</Button>
        </span>
      </Field>
      {SERUM_MODULES.filter((m) => m.id !== 'plucks' || organic).map((m) => (
        <Field key={m.id} label={m.label} hint="MIDI and patch folders on the MIDI page">
          <span className="text-[12.5px] flex items-center gap-2">
            {parts[m.id] != null && `${parts[m.id]} part${parts[m.id] === 1 ? '' : 's'} to learn from · `}
            {pools[m.id]} patches in the pool
            <Button variant="ghost" onClick={() => setView('midi')}>Pick folders</Button>
          </span>
        </Field>
      ))}
    </section>
  )
}

/** "2.5 GB", "340 MB". */
function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

/**
 * Storage: the renders the app keeps (bass and strings parts, FX stretched to other
 * tempos), and a cleanup of the ones nothing plays any more (they're made again when needed).
 */
function StorageSection() {
  const { engine, toast } = useApp()
  const ready = engine.state === 'ready'
  const [count, setCount] = useState<CleanRendersResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const measure = async () => {
    try {
      setCount(await cleanRenders(true))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    if (ready) void measure()
  }, [ready])
  const clean = async () => {
    if (!count?.files) return
    if (!window.confirm(`Delete ${count.files} renders (${formatSize(count.bytes)}) that no saved project, shortlisted track or generation of this session plays?\n\nThey're made again if something needs them.`)) return
    setBusy(true)
    try {
      const r = await cleanRenders(false)
      toast('info', `Cleaned up ${r.files} renders: ${formatSize(r.bytes)} freed.`)
      await measure()
    } catch (e) {
      toast('error', `Cleanup failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section>
      <SectionTitle>Storage</SectionTitle>
      <Field label="Renders" hint="bass and strings parts, and FX stretched to other tempos: made again whenever they're needed">
        <span className="text-[12.5px] flex items-center gap-3">
          {!ready ? <span className="text-muted">Waiting for the engine…</span>
            : error ? <span className="text-bad select-text">{error}</span>
              : !count ? <span className="text-muted">Measuring…</span>
                : (
                  <span className="text-muted">
                    {formatSize(count.bytes + count.kept_bytes)} in {count.files + count.kept_files} files ·{' '}
                    <span className={count.files ? 'text-text' : undefined}>{formatSize(count.bytes)} not used</span> by a saved project, the shortlist or this session
                  </span>
                )}
          <Button variant="secondary" disabled={!ready || busy || !count?.files} onClick={() => void clean()}
                  title="Delete the renders nothing plays any more; anything made in the last 10 minutes stays">
            {busy ? 'Cleaning up…' : 'Clean up renders'}
          </Button>
        </span>
      </Field>
    </section>
  )
}

const signed = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '–' : `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`)

/**
 * References (SCOPE.md §5.17): finished tracks dropped into the library's References folder, each
 * measured as a whole mix. An export's masters are held against them (the pre-flight).
 */
function ReferencesSection() {
  const { engine, toast } = useApp()
  const ready = engine.state === 'ready'
  const [refs, setRefs] = useState<ReferencesResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async (analyze: boolean) => {
    try {
      setRefs(await api.scanReferences(analyze))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    if (ready) void load(false)
  }, [ready])
  const measure = async () => {
    setBusy(true)
    await load(true)
    setBusy(false)
    void loadReferences()
    toast('info', 'References measured.')
  }
  const measured = refs?.tracks.filter((t) => t.profile) ?? []
  return (
    <section>
      <SectionTitle right={refs && <Button variant="ghost" onClick={() => void api.openFolder(refs.folder)}>Open folder</Button>}>References</SectionTitle>
      <Field label="Reference tracks" hint="finished tracks (WAV, AIFF, FLAC, MP3) in the library's References folder: Create follows their structures and arc, and an export's masters are checked against them">
        <span className="text-[12.5px] flex items-center gap-3">
          {!ready ? <span className="text-muted">Waiting for the engine…</span>
            : error ? <span className="text-bad select-text">{error}</span>
              : !refs ? <span className="text-muted">Reading…</span>
                : (
                  <span className="text-muted">
                    {measured.length} measured
                    {refs.pending > 0 && <> · <span className="text-text">{refs.pending} to measure</span></>}
                    {measured.length < 3 && <> · 3 or more are needed to compare against</>}
                  </span>
                )}
          <Button variant="secondary" disabled={!ready || busy || !refs?.pending} onClick={() => void measure()}
                  title="Measure the new and changed files, and those measured before Create could read their structure: tempo, key, loudness, kick and drops bar by bar, tone and width (some seconds a track)">
            {busy ? 'Measuring…' : 'Measure tracks'}
          </Button>
        </span>
      </Field>
      {refs && refs.tracks.length > 0 && (
        <table className="w-full mt-2 text-[12px]">
          <thead>
            <tr className="text-faint text-left">
              <th className="font-normal py-1">Track</th><th className="font-normal">BPM</th><th className="font-normal">Key</th>
              <th className="font-normal">LUFS</th><th className="font-normal" title="True peak over loudness">Crest</th>
              <th className="font-normal">Drops</th><th className="font-normal" title="A drop's first 8 bars against the 8 before">Lift</th>
              <th className="font-normal" title="The sides against the middle, in the drops">Width</th>
            </tr>
          </thead>
          <tbody>
            {refs.tracks.map((t) => (
              <tr key={t.rel_path} className="border-t border-line">
                <td className="py-1 pr-2 truncate max-w-[260px] select-text" title={t.rel_path}>{t.name}</td>
                {t.profile ? (
                  <>
                    <td>{t.bpm ?? '–'}</td><td>{t.key_label ?? '–'}</td><td>{signed(t.profile.lufs)}</td>
                    <td>{signed(t.profile.plr_db)} dB</td><td>{t.profile.drops.length}</td>
                    <td>{t.profile.lift_lu === null ? '–' : `${signed(t.profile.lift_lu)} LU`}</td><td>{signed(t.profile.width_db)} dB</td>
                  </>
                ) : <td colSpan={7} className="text-warn select-text">{t.error ?? 'not measured'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/**
 * ElevenLabs (vocals, SCOPE.md §6.11): the API key, kept encrypted in the macOS keychain (never in
 * the settings file), and the plan and credits it has.
 */
function ElevenLabsSection() {
  const toast = useApp((s) => s.toast)
  const [st, setSt] = useState<ElevenStatus | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void api.elevenStatus().then(setSt).catch((e) => setSt({ hasKey: false, error: (e as Error).message }))
  }, [])
  const save = async () => {
    if (!draft.trim()) return
    setBusy(true)
    try {
      const next = await api.setElevenKey(draft)
      setSt(next)
      setDraft('')
      toast(next.error ? 'error' : 'info', next.error ? `Key saved, but: ${next.error}` : 'ElevenLabs key saved in the keychain')
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!window.confirm('Remove the ElevenLabs key from this Mac?')) return
    await api.clearElevenKey()
    setSt({ hasKey: false })
  }
  const c = st?.credits
  return (
    <section>
      <SectionTitle>ElevenLabs</SectionTitle>
      <Field label="API key" hint="for vocals; kept in the macOS keychain, never in the settings file">
        <span className="flex items-center gap-2">
          <input type="password" className={cx(inputClass, 'w-[320px]')} value={draft} placeholder={st?.hasKey ? '•••••••• (saved)' : 'paste your key'}
                 onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save() }} />
          <Button variant="secondary" disabled={busy || !draft.trim()} onClick={() => void save()}>Save</Button>
          {st?.hasKey && <Button variant="ghost" onClick={() => void remove()}>Remove</Button>}
        </span>
      </Field>
      {st?.hasKey && (
        <Field label="Account">
          <span className="text-[12.5px] text-muted">
            {st.error ? <span className="text-bad select-text">{st.error}</span>
              : c ? <>{st.tier} plan · <span className="text-text">{(c.limit - c.used).toLocaleString()}</span> of {c.limit.toLocaleString()} credits left
                {c.resetsAt ? ` · renews ${new Date(c.resetsAt).toLocaleDateString()}` : ''}</> : 'Checking…'}
          </span>
        </Field>
      )}
    </section>
  )
}
