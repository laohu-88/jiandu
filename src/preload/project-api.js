module.exports = (ipcRenderer) => ({
  createProject: (args) => ipcRenderer.invoke('project:create', args),
  chooseAndOpenProject: () => ipcRenderer.invoke('project:choose-open'),
  openProjectPath: (projectPath) => ipcRenderer.invoke('project:open-path', projectPath),
  ensureProjectDirs: (projectPath) => ipcRenderer.invoke('project:ensure-dirs', projectPath),
});
