import { useEffect, useState } from 'react'
import { api } from '../api'
import { Button, cx, Field, inputClass, PageTitle, SectionTitle } from '../components/ui'
import { ENGINE_DEFAULTS, resolveEngine, type ResolvedEngineOptions } from '../lib/defaults'
import { CATEGORY_LABELS } from '../lib/format'
import { attempt, serumPresetRoot, useApp } from '../store/app'
import { keysSettings, loadKeys, saveKeysSettings, useKeys } from '../store/keys'
import { bassSettings, loadBass, saveBassSettings, useBass } from '../store/bass'
import type { LibraryFacets } from '../types/api'
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

/** The modules that draw patches from Serum 2's presets: each picks its own folders under it. */
const SERUM_MODULES = [
  { id: 'bass', label: 'Bass', what: 'basslines', settings: bassSettings, save: saveBassSettings, load: loadBass },
  { id: 'keys', label: 'Keys', what: 'keys, piano and organ', settings: keysSettings, save: saveKeysSettings, load: loadKeys },
] as const

/**
 * Serum 2 (SCOPE.md §6.7): one presets folder for every module that plays Serum patches, and per
 * module the folders under it that make up its patch pool (saved at once, apart from the engine
 * settings).
 */
function SerumSettingsSection() {
  const { libraryVersion, toast } = useApp()
  const rootNow = serumPresetRoot()
  const pools = { bass: useBass((s) => s.presets.length), keys: useKeys((s) => s.presets.length) }
  const parts = { bass: useBass((s) => s.basslines.length), keys: useKeys((s) => s.parts.length) }
  const [root, setRoot] = useState(rootNow)
  const [folders, setFolders] = useState<{ folder: string; count: number }[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setFolders(null)
    api.serumPresets(rootNow, null).then((r) => alive && (setFolders(r.folders), setError(null)),
      (e) => alive && setError((e as Error).message))
    return () => {
      alive = false
    }
  }, [rootNow])
  useEffect(() => {
    void loadBass()
    void loadKeys()
  }, [libraryVersion])

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
  const toggle = async (m: (typeof SERUM_MODULES)[number], folder: string) => {
    const cur = m.settings().folders
    const next = cur.includes(folder) ? cur.filter((f) => f !== folder)
      // A folder replaces its own sub-folders (they're included).
      : [...cur.filter((f) => !f.startsWith(`${folder}/`)), folder]
    await m.save({ folders: next })
    await m.load()
  }
  const chosen = Object.fromEntries(SERUM_MODULES.map((m) => [m.id, new Set(m.settings().folders)])) as Record<string, Set<string>>
  const covered = (id: string, f: string) => [...chosen[id]].some((c) => f.startsWith(`${c}/`))
  const cols = `minmax(0,1fr) 56px ${SERUM_MODULES.map(() => '64px').join(' ')}`

  return (
    <section>
      <SectionTitle>Serum 2</SectionTitle>
      <Field label="Presets folder" hint="Serum 2's .SerumPreset files, shared by Bass, Keys and what comes">
        <span className="flex items-center gap-2">
          <input className={cx(inputClass, 'w-[420px]')} value={root} onChange={(e) => setRoot(e.target.value)}
                 onBlur={() => void changeRoot(root.trim())} />
          <Button variant="ghost" onClick={() => void openRoot()} title="Open the presets folder in Finder">Show in Finder</Button>
        </span>
      </Field>
      {SERUM_MODULES.map((m) => (
        <Field key={m.id} label={m.label} hint="add MIDI on the MIDI page">
          <span className="text-[12.5px]">
            {parts[m.id]} part{parts[m.id] === 1 ? '' : 's'} to learn from · {pools[m.id]} patches in the pool
          </span>
        </Field>
      ))}
      <div className="mt-2">
        <div className="text-[12px] text-muted mb-1.5">
          Patch pools: tick the folders each module draws its patches from ({SERUM_MODULES.map((m) => `${m.label}: ${m.what}`).join('; ')}).
          A folder counts with all its sub-folders. Star patches in Generate to hear them more often.
        </div>
        {error ? <p className="text-bad text-[12px]">{error}</p> : !folders ? <p className="text-faint text-[12px]">Reading presets…</p>
          : !folders.length ? <p className="text-faint text-[12px]">No Serum 2 presets in this folder.</p> : (
          <div className="rounded-lg border border-line bg-panel-2">
            <div className="grid items-center h-7 px-3 text-[11px] font-semibold uppercase tracking-wider text-faint border-b border-line"
                 style={{ gridTemplateColumns: cols }}>
              <span>Folder</span>
              <span className="text-right pr-3">Presets</span>
              {SERUM_MODULES.map((m) => <span key={m.id} className="text-center">{m.label}</span>)}
            </div>
            <div className="max-h-80 overflow-y-auto py-1">
              {folders.map(({ folder, count }) => {
                const depth = folder.split('/').length - 1
                return (
                  <div key={folder} className="grid items-center h-7 px-3 text-[12.5px] hover:bg-raised" style={{ gridTemplateColumns: cols }}>
                    <span className="truncate" style={{ paddingLeft: depth * 18 }} title={folder}>{folder.split('/').pop()}</span>
                    <span className="text-right pr-3 text-faint tabular-nums">{count}</span>
                    {SERUM_MODULES.map((m) => {
                      const under = covered(m.id, folder)
                      return (
                        <span key={m.id} className="flex justify-center">
                          <input type="checkbox" className={cx('accent-[#e2c35f]', under && 'opacity-60')}
                                 checked={chosen[m.id].has(folder) || under} disabled={under}
                                 title={under ? `In ${m.label}'s pool with the folder above it` : `${m.label} draws patches from ${folder}`}
                                 onChange={() => void toggle(m, folder)} />
                        </span>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
