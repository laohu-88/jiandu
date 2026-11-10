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
});
