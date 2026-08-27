module.exports = (ipcRenderer) => ({
  scanProjectCatalog: () => ipcRenderer.invoke('catalog:scan'),
  getCodexProjectResult: (projectPath) => ipcRenderer.invoke('catalog:get-result', projectPath),
  verifyCodexProjectReadOnly: (projectPath) => ipcRenderer.invoke('catalog:verify', projectPath),
  runProjectArtifactAction: (args) => ipcRenderer.invoke('catalog:artifact-action', args),
  openProjectFcpxmlInFinalCut: (projectPath) =>
    ipcRenderer.invoke('catalog:open-final-cut', projectPath),
});
