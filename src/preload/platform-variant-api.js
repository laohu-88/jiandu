module.exports = (ipcRenderer) => ({
  createDouyinVariant: (args) =>
    ipcRenderer.invoke('platform-variant:douyin-create', args),
  readDouyinVariant: (args) =>
    ipcRenderer.invoke('platform-variant:douyin-read', args),
  saveDouyinVariant: (args) =>
    ipcRenderer.invoke('platform-variant:douyin-save', args),
  analyzeDouyinShotTracking: (args) =>
    ipcRenderer.invoke('platform-variant:douyin-analyze-tracking', args),
  approveDouyinVariant: (args) =>
    ipcRenderer.invoke('platform-variant:douyin-approve', args),
  buildDouyinVariant: (args) =>
    ipcRenderer.invoke('platform-variant:douyin-build', args),
  verifyDouyinVariant: (args) =>
    ipcRenderer.invoke('platform-variant:douyin-verify', args),
  runDouyinArtifactAction: (args) =>
    ipcRenderer.invoke('platform-variant:douyin-artifact', args),
  openDouyinFcpxmlInFinalCut: (args) =>
    ipcRenderer.invoke('platform-variant:douyin-open-final-cut', args),
});
