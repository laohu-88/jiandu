module.exports = (ipcRenderer) => ({
  showItemInFolder: (args) => ipcRenderer.invoke('shell:show-item', args),
  openFolder: (args) => ipcRenderer.invoke('shell:open-folder', args),
  detectEnvironment: () => ipcRenderer.invoke('shell:detect-environment'),
});
