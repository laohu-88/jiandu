module.exports = (ipcRenderer) => ({
  scanAssets: (projectPath) => ipcRenderer.invoke('assets:scan', projectPath),
  loadAssetIndex: (projectPath) => ipcRenderer.invoke('assets:load-index', projectPath),
  updateAssetReview: (args) => ipcRenderer.invoke('assets:update-review', args),
  getAssetPreview: (args) => ipcRenderer.invoke('assets:get-preview', args),
  readTextPreview: (args) => ipcRenderer.invoke('assets:read-text-preview', args),
});
