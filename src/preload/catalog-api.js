module.exports = (ipcRenderer) => ({
  scanProjectCatalog: () => ipcRenderer.invoke('catalog:scan'),
  getCodexProjectResult: (projectPath) => ipcRenderer.invoke('catalog:get-result', projectPath),
  verifyCodexProjectReadOnly: (projectPath) => ipcRenderer.invoke('catalog:verify', projectPath),
  runProjectArtifactAction: (args) => ipcRenderer.invoke('catalog:artifact-action', args),
  openProjectFcpxmlInFinalCut: (projectPath) =>
    ipcRenderer.invoke('catalog:open-final-cut', projectPath),
  loadEditorialReview: (projectPath) =>
    ipcRenderer.invoke('catalog:load-editorial-review', projectPath),
  saveEditorialReview: (args) =>
    ipcRenderer.invoke('catalog:save-editorial-review', args),
  getConfirmedCaptions: (projectPath) =>
    ipcRenderer.invoke('catalog:get-confirmed-captions', projectPath),
  previewCaptionFcpxmlExport: (projectPath) =>
    ipcRenderer.invoke('catalog:preview-caption-fcpxml-export', projectPath),
  exportCaptionFcpxml: (projectPath) =>
    ipcRenderer.invoke('catalog:export-caption-fcpxml', projectPath),
});
