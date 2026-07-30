module.exports = (ipcRenderer) => ({
  recognizeEditMaterial: (sourceDirectory) =>
    ipcRenderer.invoke('edit:recognize', sourceDirectory),
  buildEditPreflight: (sourceDirectory) =>
    ipcRenderer.invoke('edit:preflight', sourceDirectory),
  createEditJob: (args) => ipcRenderer.invoke('edit:create-job', args),
  runEditJob: (jobPath) => ipcRenderer.invoke('edit:run-job', jobPath),
  readEditJob: (jobPath) => ipcRenderer.invoke('edit:read-job', jobPath),
  listEditJobs: () => ipcRenderer.invoke('edit:list-jobs'),
  updateEditJob: (args) => ipcRenderer.invoke('edit:update-job', args),
  openEditJobInFinalCut: (jobPathOrProjectPath) =>
    ipcRenderer.invoke('edit:open-final-cut', jobPathOrProjectPath),
  openEditProjectFolder: (projectPath) =>
    ipcRenderer.invoke('edit:open-project', projectPath),
  showEditEditorialReview: (projectPath) =>
    ipcRenderer.invoke('edit:show-editorial-review', projectPath),
});
