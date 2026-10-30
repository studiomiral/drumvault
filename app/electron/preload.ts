// Typed bridge between the renderer and the main process (window.drumvault).

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DrumvaultAPI } from '../src/types/api'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: DrumvaultAPI = {
  platform: process.platform,

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  chooseLibraryFolder: () => ipcRenderer.invoke('dialog:library'),
  chooseZips: () => ipcRenderer.invoke('dialog:zips'),
  pathsForFiles: (files) => files.map((f) => webUtils.getPathForFile(f)).filter(Boolean),
  expandPaths: (paths) => ipcRenderer.invoke('fs:expand', paths),
  findSamples: (paths) => ipcRenderer.invoke('fs:samples', paths),

  checkDeps: () => ipcRenderer.invoke('engine:deps'),
  engineStatus: () => ipcRenderer.invoke('engine:status'),
  restartEngine: () => ipcRenderer.invoke('engine:restart'),
  onEngineStatus: (cb) => subscribe('engine-status', cb),

  listJobs: () => ipcRenderer.invoke('jobs:list'),
  onJobs: (cb) => subscribe('jobs', cb),
  processZips: (paths, reprocess) => ipcRenderer.invoke('jobs:process', paths, reprocess ?? false),
  importSamples: (paths) => ipcRenderer.invoke('jobs:samples', paths),
  reprocessZip: (zipId, overrides) => ipcRenderer.invoke('jobs:reprocess', zipId, overrides),
  deleteZip: (zipId) => ipcRenderer.invoke('jobs:delete', zipId),
  rebuildLoops: () => ipcRenderer.invoke('jobs:rebuild'),
  cancelJob: (jobId) => ipcRenderer.invoke('jobs:cancel', jobId),
  clearFinishedJobs: () => ipcRenderer.invoke('jobs:clear'),
  setSampleMeta: (id, meta) => ipcRenderer.invoke('sample:meta', id, meta),
  markReviewed: (zipId) => ipcRenderer.invoke('zip:reviewed', zipId),
  deleteSamples: (sampleIds) => ipcRenderer.invoke('samples:delete', sampleIds),
  shiftSample: (sampleId, beats) => ipcRenderer.invoke('samples:shift', sampleId, beats),
  sampleShift: (sampleId) => ipcRenderer.invoke('lib:shift', sampleId),
  stretchSamples: (relPaths, bpm) => ipcRenderer.invoke('samples:stretch', relPaths, bpm),
  importMidi: (paths, role) => ipcRenderer.invoke('midi:import', paths, role),
  chooseMidi: () => ipcRenderer.invoke('dialog:midi'),
  setMidiRole: (id, role) => ipcRenderer.invoke('midi:role', id, role),
  setMidiKey: (midiId, key) => ipcRenderer.invoke('midi:key', midiId, key),
  deleteMidi: (midiIds) => ipcRenderer.invoke('midi:delete', midiIds),
  listMidi: () => ipcRenderer.invoke('lib:midi'),
  arrangements: () => ipcRenderer.invoke('lib:arrangements'),
  serumPresets: (root, folders) => ipcRenderer.invoke('serum:presets', root, folders),
  renderBass: (p) => ipcRenderer.invoke('bass:render', p),
  saveMidi: (p) => ipcRenderer.invoke('midi:save', p),
  listRemoved: () => ipcRenderer.invoke('lib:removed'),
  restoreSamples: (removedIds) => ipcRenderer.invoke('samples:restore', removedIds),
  gridPreview: (zipId) => ipcRenderer.invoke('zip:gridPreview', zipId),

  onLibraryChanged: (cb) => subscribe('library-changed', () => cb()),
  listZips: () => ipcRenderer.invoke('lib:zips'),
  zipDetail: (id) => ipcRenderer.invoke('lib:zip', id),
  querySamples: (filter) => ipcRenderer.invoke('lib:samples', filter),
  facets: () => ipcRenderer.invoke('lib:facets'),
  peaks: (id, points) => ipcRenderer.invoke('lib:peaks', id, points),
  readSample: (relPath) => ipcRenderer.invoke('lib:read', relPath),

  revealSample: (relPath) => ipcRenderer.invoke('shell:revealSample', relPath),
  revealZip: (zipId) => ipcRenderer.invoke('shell:revealZip', zipId),
  openLibraryFolder: () => ipcRenderer.invoke('shell:openLibrary'),
  startDrag: (relPath) => ipcRenderer.send('drag:start', relPath),

  samplesByPath: (relPaths) => ipcRenderer.invoke('lib:byPath', relPaths),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  readProject: (file) => ipcRenderer.invoke('projects:read', file),
  writeProject: (prev, name, text) => ipcRenderer.invoke('projects:write', prev, name, text),
  deleteProject: (file) => ipcRenderer.invoke('projects:delete', file),

  chooseExportFolder: (defaultPath) => ipcRenderer.invoke('export:chooseDir', defaultPath),
  defaultExportFolder: () => ipcRenderer.invoke('export:defaultDir'),
  existingFiles: (dir, names) => ipcRenderer.invoke('export:existing', dir, names),
  writeExportFile: (dir, name, data) => ipcRenderer.invoke('export:write', dir, name, data),
  revealPath: (path) => ipcRenderer.invoke('shell:revealPath', path),
  similarSamples: (id, limit) => ipcRenderer.invoke('lib:similar', id, limit),

  onMenu: (cb) => subscribe('menu', cb),
}

contextBridge.exposeInMainWorld('drumvault', api)
