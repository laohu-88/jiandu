const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('plannerApi', {
  getConfig: () => ipcRenderer.invoke('app:get-config'),
  selectRoot: () => ipcRenderer.invoke('dialog:select-root'),
  createProject: (args) => ipcRenderer.invoke('project:create', args),
  chooseAndOpenProject: () => ipcRenderer.invoke('project:choose-open'),
  ensureProjectDirs: (projectPath) => ipcRenderer.invoke('project:ensure-dirs', projectPath),
  scanAssets: (projectPath) => ipcRenderer.invoke('assets:scan', projectPath),
  generateBrief: (projectPath) => ipcRenderer.invoke('brief:generate', projectPath),
  loadStage2State: (projectPath) => ipcRenderer.invoke('stage2:load', projectPath),
  importVideoPlan: (args) => ipcRenderer.invoke('plan:import', args),
  scanVoiceFiles: (projectPath) => ipcRenderer.invoke('voice:scan', projectPath),
  loadStage3State: (projectPath) => ipcRenderer.invoke('stage3:load', projectPath),
  saveAssignments: (args) => ipcRenderer.invoke('assignments:save', args),
  addAssetToSegment: (args) => ipcRenderer.invoke('assignments:add-asset', args),
  autoFitSegment: (args) => ipcRenderer.invoke('assignments:auto-fit', args),
  syncSegmentPackages: (projectPath) => ipcRenderer.invoke('packages:sync', projectPath),
  loadRoughcutStatus: (projectPath) => ipcRenderer.invoke('roughcut:load-status', projectPath),
  generateRoughcut: (args) => ipcRenderer.invoke('roughcut:generate-one', args),
  generateAllRoughcuts: (projectPath) => ipcRenderer.invoke('roughcut:generate-all', projectPath),
  showRoughcutOutput: (outputPath) => ipcRenderer.invoke('roughcut:show-output', outputPath),
});
