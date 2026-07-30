module.exports = (ipcRenderer) => ({
  scanPendingMedia: () => ipcRenderer.invoke('pending:scan'),
  showPendingMediaInFinder: (sourceDirectory) =>
    ipcRenderer.invoke('pending:show-in-finder', sourceDirectory),
});
