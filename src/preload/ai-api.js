module.exports = (ipcRenderer) => ({
  loadAiAnalysis: (projectPath) => ipcRenderer.invoke('ai:load-analysis', projectPath),
  updateAiAnalysis: (args) => ipcRenderer.invoke('ai:update-analysis', args),
  loadAiSettings: () => ipcRenderer.invoke('ai:load-settings'),
  saveAiSettings: (settings) => ipcRenderer.invoke('ai:save-settings', settings),
  checkAiEnvironment: () => ipcRenderer.invoke('ai:check-environment'),
  analyzeCurrentTextAsset: (args) =>
    ipcRenderer.invoke('ai:analyze-current-text-asset', args),
  analyzeCurrentImageAsset: (args) =>
    ipcRenderer.invoke('ai:analyze-current-image-asset', args),
  analyzeBatchAssets: (args) => ipcRenderer.invoke('ai:analyze-batch-assets', args),
  onBatchAnalysisProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('ai:batch-analysis-progress', listener);
    return () => ipcRenderer.removeListener('ai:batch-analysis-progress', listener);
  },
  generateBrief: (projectPath) => ipcRenderer.invoke('brief:generate', projectPath),
  generateAiMaterialReport: (projectPath) =>
    ipcRenderer.invoke('ai:generate-material-report', projectPath),
  generateEditSuggestion: (projectPath) =>
    ipcRenderer.invoke('ai:generate-edit-suggestion', projectPath),
});
