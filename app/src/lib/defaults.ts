// Defaults of the engine settings (mirror of `Settings` in engine/drumvault_engine/config.py).
// The app only sends values the user changed; the engine fills in the rest.

import type { EngineOptions } from '../types/api'

export const ENGINE_DEFAULTS: Required<Omit<EngineOptions, 'thresholds' | 'rubberband_binary' |
  'rubberband_options' | 'rubberband_r3_flag'>> = {
  library_bpm: 124,
  bpm_min: 115,
  bpm_max: 135,
  max_stretch: 0.15,
  integer_bpm: true,
  output_sample_rate: 44100,
  output_format: 'pcm24',
  loop_lengths: {
    snare: [2, 4], clap: [2, 4],
    hat: [1, 2, 4], hat_closed: [1, 2, 4], hat_open: [1, 2, 4], ride: [1, 2, 4], shaker: [1, 2, 4],
    perc: [1, 2, 4],
    top: [2, 4, 8], groove: [2, 4, 8], drums: [2, 4, 8],
  },
  max_oneshots_per_stem: 4,
  max_loops_per_length: 6,
  max_events_per_stem: 6,
  oneshot_peak_dbfs: -0.3,
  loop_norm_mode: 'peak',
  loop_peak_dbfs: -1.0,
  loop_lufs_target: -14.0,
  event_peak_dbfs: -1.0,
  oneshot_dedupe_threshold: 0.97,
  loop_dedupe_threshold: 0.96,
  event_dedupe_threshold: 0.96,
  workers: 4,
  serum_plugin: '/Library/Audio/Plug-Ins/VST3/Serum2.vst3',
  serum_plugin_name: 'Serum 2',
}

/** Serum 2's presets folder, shared by the modules that play Serum patches. */
export const SERUM_PRESET_ROOT = '/Library/Audio/Presets/Xfer Records/Serum 2 Presets/Presets'

/** Bass patch pool (SCOPE.md §6.7): folders under the Serum 2 presets folder, picked in Settings. */
export const BASS_DEFAULTS = {
  presetRoot: SERUM_PRESET_ROOT,
  folders: [] as string[],
  favorites: [] as string[],
}

export const KEYS_DEFAULTS = { ...BASS_DEFAULTS, folders: [] as string[], favorites: [] as string[] }

/** Chord stab patch pool (SCOPE.md §6.9): the House chord stabs folder until others are picked. */
export const STABS_DEFAULTS = { ...BASS_DEFAULTS, folders: ['House - Chord Stabs'], favorites: [] as string[] }

export type ResolvedEngineOptions = typeof ENGINE_DEFAULTS & EngineOptions

export function resolveEngine(opts: EngineOptions): ResolvedEngineOptions {
  return { ...ENGINE_DEFAULTS, ...opts, loop_lengths: { ...ENGINE_DEFAULTS.loop_lengths, ...opts.loop_lengths } }
}
