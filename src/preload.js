const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('plannerApi', {
  getConfig: () => ipcRenderer.invoke('app:get-config'),
  scanPendingMedia: () => ipcRenderer.invoke('pending:scan'),
  showPendingMediaInFinder: (sourceDirectory) =>
    ipcRenderer.invoke('pending:show-in-finder', sourceDirectory),
  createHandoffTask: (args) => ipcRenderer.invoke('handoff:create', args),
  launchCodexHandoff: (taskPath) => ipcRenderer.invoke('handoff:launch-codex', taskPath),
  launchCursorHandoff: (taskPath) => ipcRenderer.invoke('handoff:launch-cursor', taskPath),
  readHandoffTask: (taskPath) => ipcRenderer.invoke('handoff:read', taskPath),
  classifyHandoffTask: (taskPath) => ipcRenderer.invoke('handoff:classify', taskPath),
  continueHandoffBuild: (args) => ipcRenderer.invoke('handoff:continue-build', args),
  markHandoffAnalysisComplete: (args) => ipcRenderer.invoke('handoff:mark-analysis-complete', args),
  listHandoffTasks: () => ipcRenderer.invoke('handoff:list'),
  cancelHandoffTask: (taskPath) => ipcRenderer.invoke('handoff:cancel', taskPath),
  activateCodexHandoff: (taskPath) => ipcRenderer.invoke('handoff:activate-codex', taskPath),
  activateCursorHandoff: (taskPath) => ipcRenderer.invoke('handoff:activate-cursor', taskPath),
  copyHandoffPrompt: (taskPath) => ipcRenderer.invoke('handoff:copy-prompt', taskPath),
  showHandoffPackage: (taskPath) => ipcRenderer.invoke('handoff:show-package', taskPath),
  loadHandoffSettings: () => ipcRenderer.invoke('handoff:settings-load'),
  saveHandoffSettings: (settings) => ipcRenderer.invoke('handoff:settings-save', settings),
  openHandoffResult: (taskPath) => ipcRenderer.invoke('handoff:open-result', taskPath),
  onHandoffTerminal: (callback) => {
    const listener = (_event, task) => callback(task);
    ipcRenderer.on('handoff:terminal', listener);
    return () => ipcRenderer.removeListener('handoff:terminal', listener);
  },
  selectRoot: () => ipcRenderer.invoke('dialog:select-root'),
  selectMaterialDirectory: () => ipcRenderer.invoke('dialog:select-material'),
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
  createProject: (args) => ipcRenderer.invoke('project:create', args),
  chooseAndOpenProject: () => ipcRenderer.invoke('project:choose-open'),
  openProjectPath: (projectPath) => ipcRenderer.invoke('project:open-path', projectPath),
  ensureProjectDirs: (projectPath) => ipcRenderer.invoke('project:ensure-dirs', projectPath),
  scanAssets: (projectPath) => ipcRenderer.invoke('assets:scan', projectPath),
  loadAssetIndex: (projectPath) => ipcRenderer.invoke('assets:load-index', projectPath),
  updateAssetReview: (args) => ipcRenderer.invoke('assets:update-review', args),
  getAssetPreview: (args) => ipcRenderer.invoke('assets:get-preview', args),
  readTextPreview: (args) => ipcRenderer.invoke('assets:read-text-preview', args),
  loadAiAnalysis: (projectPath) => ipcRenderer.invoke('ai:load-analysis', projectPath),
  updateAiAnalysis: (args) => ipcRenderer.invoke('ai:update-analysis', args),
  loadAiSettings: () => ipcRenderer.invoke('ai:load-settings'),
  saveAiSettings: (settings) => ipcRenderer.invoke('ai:save-settings', settings),
  checkAiEnvironment: () => ipcRenderer.invoke('ai:check-environment'),
  analyzeCurrentTextAsset: (args) =>
    ipcRenderer.invoke('ai:analyze-current-text-asset', args),
  analyzeCurrentImageAsset: (args) =>
    ipcRenderer.invoke('ai:analyze-current-image-asset', args),
  analyzeBatchAssets: (args) => ipcRenderer.invoke('ai:analyze-batch-assets', args),
  onBatchAnalysisProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('ai:batch-analysis-progress', listener);
    return () => ipcRenderer.removeListener('ai:batch-analysis-progress', listener);
  },
  generateBrief: (projectPath) => ipcRenderer.invoke('brief:generate', projectPath),
  generateAiMaterialReport: (projectPath) =>
    ipcRenderer.invoke('ai:generate-material-report', projectPath),
  generateEditSuggestion: (projectPath) =>
    ipcRenderer.invoke('ai:generate-edit-suggestion', projectPath),
  loadStage2State: (projectPath) => ipcRenderer.invoke('stage2:load', projectPath),
  importVideoPlan: (args) => ipcRenderer.invoke('plan:import', args),
  scanVoiceFiles: (projectPath) => ipcRenderer.invoke('voice:scan', projectPath),
  loadStage3State: (projectPath) => ipcRenderer.invoke('stage3:load', projectPath),
  saveAssignments: (args) => ipcRenderer.invoke('assignments:save', args),
  addAssetToSegment: (args) => ipcRenderer.invoke('assignments:add-asset', args),
  autoFitSegment: (args) => ipcRenderer.invoke('assignments:auto-fit', args),
  syncSegmentPackages: (projectPath) => ipcRenderer.invoke('packages:sync', projectPath),
  loadRoughcutStatus: (projectPath) => ipcRenderer.invoke('roughcut:load-status', projectPath),
  generateRoughcut: (args) => ipcRenderer.invoke('roughcut:generate-one', args),
  generateAllRoughcuts: (projectPath) => ipcRenderer.invoke('roughcut:generate-all', projectPath),
  showRoughcutOutput: (args) => ipcRenderer.invoke('roughcut:show-output', args),
  loadFinalRoughcutStatus: (projectPath) =>
    ipcRenderer.invoke('final-roughcut:load-status', projectPath),
  generateFinalRoughcut: (projectPath) =>
    ipcRenderer.invoke('final-roughcut:generate', projectPath),
  generateFcpHandoff: (projectPath) => ipcRenderer.invoke('fcp-handoff:generate', projectPath),
  loadSubtitleState: (projectPath) => ipcRenderer.invoke('subtitle:load', projectPath),
  saveSubtitleConfig: (args) => ipcRenderer.invoke('subtitle:save-config', args),
  chooseSubtitleVideo: (projectPath) => ipcRenderer.invoke('subtitle:choose-video', projectPath),
  generateSubtitlesFromVideo: (args) =>
    ipcRenderer.invoke('subtitle:generate-from-video', args),
  organizeExistingSrt: (projectPath) => ipcRenderer.invoke('subtitle:organize-existing', projectPath),
  loadRecentProjects: () => ipcRenderer.invoke('recent-projects:load'),
  detectEnvironment: (subtitleCommand) => ipcRenderer.invoke('environment:detect', subtitleCommand),
  prepareCodexVideo: (args) => ipcRenderer.invoke('codex-video:prepare', args),
  inspectCodexVideoRange: (args) => ipcRenderer.invoke('codex-video:inspect-range', args),
  validateCodexVideoAnalysis: (args) => ipcRenderer.invoke('codex-video:validate-analysis', args),
  buildCodexVideoProject: (args) => ipcRenderer.invoke('codex-video:build', args),
  verifyCodexVideoProject: (projectPath) => ipcRenderer.invoke('codex-video:verify', projectPath),
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
  showItemInFolder: (args) => ipcRenderer.invoke('shell:show-item', args),
  openFolder: (args) => ipcRenderer.invoke('shell:open-folder', args),
});
