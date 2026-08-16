const { contextBridge, ipcRenderer } = require('electron');

// Domain-organized preload API, inlined for Electron sandbox compatibility.
// Source modules: src/preload/*-api.js (kept for review / non-sandbox tooling).
// Regenerate with: node scripts/build-preload.js
const api = {
  // --- app-api.js ---
  ...({
  getConfig: () => ipcRenderer.invoke('app:get-config'),
}),
  // --- pending-api.js ---
  ...({
  scanPendingMedia: () => ipcRenderer.invoke('pending:scan'),
  showPendingMediaInFinder: (sourceDirectory) =>
    ipcRenderer.invoke('pending:show-in-finder', sourceDirectory),
}),
  // --- handoff-api.js ---
  ...({
  startEditHandoff: (args) => ipcRenderer.invoke('handoff:start-edit', args),
  recognizeHandoffSource: (sourceDirectory) => ipcRenderer.invoke('handoff:recognize-source', sourceDirectory),
  checkCursorAccessibility: () => ipcRenderer.invoke('handoff:check-accessibility'),
  onHandoffProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('handoff:progress', listener);
    return () => ipcRenderer.removeListener('handoff:progress', listener);
  },
  launchCodexHandoff: (taskPath) => ipcRenderer.invoke('handoff:launch-codex', taskPath),
  launchCursorHandoff: (taskPath) => ipcRenderer.invoke('handoff:launch-cursor', taskPath),
  readHandoffTask: (taskPath) => ipcRenderer.invoke('handoff:read', taskPath),
  classifyHandoffTask: (taskPath) => ipcRenderer.invoke('handoff:classify', taskPath),
  continueHandoffBuild: (args) => ipcRenderer.invoke('handoff:continue-build', args),
  markHandoffAnalysisComplete: (args) => ipcRenderer.invoke('handoff:mark-analysis-complete', args),
  listHandoffTasks: () => ipcRenderer.invoke('handoff:list'),
  cancelHandoffTask: (taskPath) => ipcRenderer.invoke('handoff:cancel', taskPath),
  takeoverHandoffTask: (args) => ipcRenderer.invoke('handoff:takeover', args),
  reconcileHandoffTasks: () => ipcRenderer.invoke('handoff:reconcile'),
  activateCodexHandoff: (taskPath) => ipcRenderer.invoke('handoff:activate-codex', taskPath),
  activateCursorHandoff: (taskPath) => ipcRenderer.invoke('handoff:activate-cursor', taskPath),
  copyHandoffPrompt: (taskPath) => ipcRenderer.invoke('handoff:copy-prompt', taskPath),
  showHandoffPackage: (taskPath) => ipcRenderer.invoke('handoff:show-package', taskPath),
  sweepHandoffPackages: () => ipcRenderer.invoke('handoff:sweep-packages'),
  loadHandoffSettings: () => ipcRenderer.invoke('handoff:settings-load'),
  saveHandoffSettings: (settings) => ipcRenderer.invoke('handoff:settings-save', settings),
  openHandoffResult: (taskPath) => ipcRenderer.invoke('handoff:open-result', taskPath),
  onHandoffTerminal: (callback) => {
    const listener = (_event, task) => callback(task);
    ipcRenderer.on('handoff:terminal', listener);
    return () => ipcRenderer.removeListener('handoff:terminal', listener);
  },
}),
  // --- dialog-api.js ---
  ...({
  selectRoot: () => ipcRenderer.invoke('dialog:select-root'),
  selectMaterialDirectory: () => ipcRenderer.invoke('dialog:select-material'),
}),
  // --- edit-api.js ---
  ...({
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
}),
  // --- catalog-api.js ---
  ...({
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
}),
  // --- platform-variant-api.js ---
  ...({
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
}),
  // --- shell-api.js ---
  ...({
  showItemInFolder: (args) => ipcRenderer.invoke('shell:show-item', args),
  openFolder: (args) => ipcRenderer.invoke('shell:open-folder', args),
}),
};

contextBridge.exposeInMainWorld('plannerApi', api);
