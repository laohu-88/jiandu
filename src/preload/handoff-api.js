module.exports = (ipcRenderer) => ({
  startEditHandoff: (args) => ipcRenderer.invoke('handoff:start-edit', args),
  recognizeHandoffSource: (sourceDirectory) => ipcRenderer.invoke('handoff:recognize-source', sourceDirectory),
  onHandoffProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('handoff:progress', listener);
    return () => ipcRenderer.removeListener('handoff:progress', listener);
  },
  launchCodexHandoff: (taskPath) => ipcRenderer.invoke('handoff:launch-codex', taskPath),
  readHandoffTask: (taskPath) => ipcRenderer.invoke('handoff:read', taskPath),
  classifyHandoffTask: (taskPath) => ipcRenderer.invoke('handoff:classify', taskPath),
  continueHandoffBuild: (args) => ipcRenderer.invoke('handoff:continue-build', args),
  markHandoffAnalysisComplete: (args) => ipcRenderer.invoke('handoff:mark-analysis-complete', args),
  listHandoffTasks: () => ipcRenderer.invoke('handoff:list'),
  cancelHandoffTask: (taskPath) => ipcRenderer.invoke('handoff:cancel', taskPath),
  takeoverHandoffTask: (args) => ipcRenderer.invoke('handoff:takeover', args),
  reconcileHandoffTasks: () => ipcRenderer.invoke('handoff:reconcile'),
  activateCodexHandoff: (taskPath) => ipcRenderer.invoke('handoff:activate-codex', taskPath),
  copyHandoffPrompt: (taskPath) => ipcRenderer.invoke('handoff:copy-prompt', taskPath),
  loadHandoffSettings: () => ipcRenderer.invoke('handoff:settings-load'),
  saveHandoffSettings: (settings) => ipcRenderer.invoke('handoff:settings-save', settings),
  openHandoffResult: (taskPath) => ipcRenderer.invoke('handoff:open-result', taskPath),
  onHandoffTerminal: (callback) => {
    const listener = (_event, task) => callback(task);
    ipcRenderer.on('handoff:terminal', listener);
    return () => ipcRenderer.removeListener('handoff:terminal', listener);
  },
});
