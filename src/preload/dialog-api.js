module.exports = (ipcRenderer) => ({
  selectRoot: () => ipcRenderer.invoke('dialog:select-root'),
  selectMaterialDirectory: () => ipcRenderer.invoke('dialog:select-material'),
});
