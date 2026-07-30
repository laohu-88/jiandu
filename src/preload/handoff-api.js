module.exports = (ipcRenderer) => ({
  createHandoffTask: (args) => ipcRenderer.invoke('handoff:create', args),
  launchCodexHandoff: (taskPath) => ipcRenderer.invoke('handoff:launch-codex', taskPath),
  launchCursorHandoff: (taskPath) => ipcRenderer.invoke('handoff:launch-cursor', taskPath),
  readHandoffTask: (taskPath) => ipcRenderer.invoke('handoff:read', taskPath),
  classifyHandoffTask: (taskPath) => ipcRenderer.invoke('handoff:classify', taskPath),
  continueHandoffBuild: (args) => ipcRenderer.invoke('handoff:continue-build', args),
  markHandoffAnalysisComplete: (args) => ipcRenderer.invoke('handoff:mark-analysis-complete', args),
  listHandoffTasks: () => ipcRenderer.invoke('handoff:list'),
  cancelHandoffTask: (taskPath) => ipcRenderer.invoke('handoff:cancel', taskPath),
  activateCodexHandoff: (taskPath) => ipcRenderer.invoke('handoff:activate-codex', taskPath),
  activateCursorHandoff: (taskPath) => ipcRenderer.invoke('handoff:activate-cursor', taskPath),
  copyHandoffPrompt: (taskPath) => ipcRenderer.invoke('handoff:copy-prompt', taskPath),
  showHandoffPackage: (taskPath) => ipcRenderer.invoke('handoff:show-package', taskPath),
  loadHandoffSettings: () => ipcRenderer.invoke('handoff:settings-load'),
  saveHandoffSettings: (settings) => ipcRenderer.invoke('handoff:settings-save', settings),
  openHandoffResult: (taskPath) => ipcRenderer.invoke('handoff:open-result', taskPath),
  onHandoffTerminal: (callback) => {
    const listener = (_event, task) => callback(task);
    ipcRenderer.on('handoff:terminal', listener);
    return () => ipcRenderer.removeListener('handoff:terminal', listener);
  },
});
