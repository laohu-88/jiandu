module.exports = (ipcRenderer) => ({
  getConfig: () => ipcRenderer.invoke('app:get-config'),
});
