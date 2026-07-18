const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');

const {
  APP_NAME,
  APP_VERSION,
  DEFAULT_PROJECT_ROOT,
  FCP_EXPORT_DIR,
  RAW_SRT_FILE,
} = require('./constants');
const {
  createProject,
  openProject,
  ensureProjectDirs,
} = require('./services/project-service');
const {
  scanAssets,
  loadAssetIndex,
  getAssetPreview,
  readTextPreview,
  updateAssetReview,
  generateBrief,
} = require('./services/media-service');
const {
  getAiAnalysis,
  loadAiAnalysis,
  updateAiAnalysis,
} = require('./services/ai-analysis-store');
const { checkAiEnvironment } = require('./services/ai-environment-service');
const { analyzeCurrentTextAsset } = require('./services/ai-text-analysis-service');
const { analyzeCurrentImageAsset } = require('./services/ai-image-analysis-service');
const {
  analyzeBatchAssets,
  getAiEnvironmentIssue,
  selectBatchCandidates,
} = require('./services/ai-batch-analysis-service');
const {
  generateAiMaterialReport,
} = require('./services/ai-material-report-service');
const {
  generateEditSuggestion,
} = require('./services/ai-edit-suggestion-service');
const {
  loadAiSettings,
  saveAiSettings,
} = require('./services/ai-settings-service');
const {
  loadStage2State,
  importVideoPlan,
  scanVoiceFiles,
} = require('./services/stage2-service');
const {
  loadStage3State,
  saveAssignments,
  addAssetToSegment,
  autoFitSegment,
  syncSegmentPackages,
} = require('./services/stage3-service');
const {
  loadRoughcutStatus,
  generateOneSegment,
  generateAllSegments,
} = require('./services/stage4-service');
const {
  loadFinalRoughcutStatus,
  generateFinalRoughcut,
  generateFcpHandoff,
} = require('./services/stage5-service');
const {
  loadSubtitleState,
  writeSubtitleConfig,
  generateSubtitlesFromVideo,
  organizeExistingSrt,
} = require('./services/stage6-service');
const {
  loadRecentProjects,
  saveRecentProject,
  detectEnvironment,
} = require('./services/stage7-service');
const {
  preparePendingMedia,
  inspectVideoRange,
} = require('./services/pending-media-service');
const {
  buildCodexVideoProject,
  validateAnalysisFile,
  verifyCodexVideoProject,
} = require('./services/codex-video-service');

let mainWindow;
let aiAnalysisRunning = false;

async function runExclusiveAiAnalysis(action) {
  if (aiAnalysisRunning) {
    throw Object.assign(new Error('已有 AI 分析任务正在运行。'), {
      code: 'AI_ANALYSIS_IN_PROGRESS',
    });
  }
  aiAnalysisRunning = true;
  try {
    return await action();
  } finally {
    aiAnalysisRunning = false;
  }
}

async function recordNoAiEnvironment(projectPath, item, previous, issue) {
  const analyzedAt = new Date().toISOString();
  await updateAiAnalysis(projectPath, item.stableId, {
    sourceFingerprint: item.sourceFingerprint,
    sourceType: item.sourceType,
    aiStatus: 'failed',
    aiSummary: '',
    aiTags: [],
    aiRisk: { level: 'unknown', flags: [], reason: '' },
    aiCaptionIdeas: [],
    aiSuggestedUse: [],
    aiModel: null,
    aiAnalyzedAt: analyzedAt,
    aiError: {
      code: 'NO_AI_ENVIRONMENT',
      message: issue,
      retryable: true,
      occurredAt: analyzedAt,
    },
    promptVersion: previous?.promptVersion || 'asset-analysis-v1',
    preprocessVersion: previous?.preprocessVersion || 'media-input-v1',
    attempt: (previous?.attempt || 0) + 1,
  });
  throw Object.assign(new Error(issue), { code: 'NO_AI_ENVIRONMENT' });
}

async function ensureBatchFailureRecord(projectPath, item, error) {
  const current = await getAiAnalysis(projectPath, item.stableId);
  if (
    current?.aiStatus === 'failed'
    && current.sourceFingerprint === item.sourceFingerprint
  ) return;

  const analyzedAt = new Date().toISOString();
  const errorCode = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : 'BATCH_ANALYSIS_FAILED';
  await updateAiAnalysis(projectPath, item.stableId, {
    sourceFingerprint: item.sourceFingerprint,
    sourceType: item.sourceType,
    aiStatus: 'failed',
    aiSummary: '',
    aiTags: [],
    aiRisk: { level: 'unknown', flags: [], reason: '' },
    aiCaptionIdeas: [],
    aiSuggestedUse: [],
    aiModel: null,
    aiAnalyzedAt: analyzedAt,
    aiError: {
      code: errorCode,
      message: item.assetType === 'image' ? '图片分析失败。' : '文本分析失败。',
      retryable: error?.retryable === true,
      occurredAt: analyzedAt,
    },
    promptVersion: current?.promptVersion || 'asset-analysis-v1',
    preprocessVersion: current?.preprocessVersion || 'media-input-v1',
    attempt: (current?.attempt || 0) + 1,
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: APP_NAME,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function registerIpc() {
  ipcMain.handle('app:get-config', () => ({
    version: APP_VERSION,
    defaultProjectRoot: DEFAULT_PROJECT_ROOT,
  }));

  ipcMain.handle('dialog:select-root', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择项目根目录',
      defaultPath: DEFAULT_PROJECT_ROOT,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('project:create', (_event, args) =>
    createProject(args.rootPath, args.projectName).then(async (result) => {
      await saveRecentProject(app.getPath('userData'), result.project);
      return result;
    }));

  ipcMain.handle('project:choose-open', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择已有项目文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    const opened = await openProject(result.filePaths[0]);
    await saveRecentProject(app.getPath('userData'), opened.project);
    return opened;
  });

  ipcMain.handle('project:open-path', async (_event, projectPath) => {
    const opened = await openProject(projectPath);
    await saveRecentProject(app.getPath('userData'), opened.project);
    return opened;
  });

  ipcMain.handle('project:ensure-dirs', (_event, projectPath) =>
    ensureProjectDirs(projectPath));

  ipcMain.handle('assets:scan', (_event, projectPath) =>
    scanAssets(projectPath));

  ipcMain.handle('assets:load-index', (_event, projectPath) =>
    loadAssetIndex(projectPath));

  ipcMain.handle('assets:update-review', (_event, args) =>
    updateAssetReview(args.projectPath, args.stableId, args.patch));

  ipcMain.handle('assets:get-preview', (_event, args) =>
    getAssetPreview(args.projectPath, args.stableId));

  ipcMain.handle('assets:read-text-preview', (_event, args) =>
    readTextPreview(args.projectPath, args.stableId, args.maxBytes));

  ipcMain.handle('ai:load-analysis', (_event, projectPath) =>
    loadAiAnalysis(projectPath));

  ipcMain.handle('ai:update-analysis', (_event, args) =>
    updateAiAnalysis(args.projectPath, args.stableId, args.patch));

  ipcMain.handle('ai:load-settings', () =>
    loadAiSettings(app.getPath('userData')));

  ipcMain.handle('ai:save-settings', (_event, settings) =>
    saveAiSettings(app.getPath('userData'), settings));

  ipcMain.handle('ai:check-environment', async () => {
    const settings = await loadAiSettings(app.getPath('userData'));
    return checkAiEnvironment({ pythonPath: settings.mlxPythonPath });
  });

  ipcMain.handle('ai:analyze-current-text-asset', (_event, args) =>
    runExclusiveAiAnalysis(async () => {
      const settings = await loadAiSettings(app.getPath('userData'));
      return analyzeCurrentTextAsset(args, {
        pythonPath: settings.mlxPythonPath || undefined,
      });
    }));

  ipcMain.handle('ai:analyze-current-image-asset', (_event, args) =>
    runExclusiveAiAnalysis(async () => {
      const settings = await loadAiSettings(app.getPath('userData'));
      return analyzeCurrentImageAsset(args, {
        pythonPath: settings.mlxPythonPath || undefined,
      });
    }));

  ipcMain.handle('ai:analyze-batch-assets', (event, args) =>
    runExclusiveAiAnalysis(async () => {
      const { projectPath, mode } = args || {};
      const [assetsPayload, aiAnalysis, settings] = await Promise.all([
        loadAssetIndex(projectPath),
        loadAiAnalysis(projectPath),
        loadAiSettings(app.getPath('userData')),
      ]);
      const assets = assetsPayload.assets || [];
      const selection = selectBatchCandidates(assets, aiAnalysis, mode);
      let environmentIssue = null;
      let batchPythonPath = settings.mlxPythonPath || undefined;
      if (selection.queued.length > 0) {
        const environment = await checkAiEnvironment({
          pythonPath: batchPythonPath,
        });
        environmentIssue = getAiEnvironmentIssue(environment, selection.queued);
        if (!environmentIssue) batchPythonPath = environment.python.path || batchPythonPath;
      }

      const queuedById = new Map(selection.queued.map((item) => [item.stableId, item]));
      const createAnalyzeImpl = (analyzeImpl) => async (analyzeArgs) => {
        if (environmentIssue) {
          const item = queuedById.get(analyzeArgs.stableId);
          return recordNoAiEnvironment(
            projectPath,
            item,
            aiAnalysis.analyses?.[analyzeArgs.stableId],
            environmentIssue,
          );
        }
        return analyzeImpl(analyzeArgs, {
          pythonPath: batchPythonPath,
        });
      };

      return analyzeBatchAssets({
        projectPath,
        assets,
        aiAnalysis,
        mode,
      }, {
        selection,
        analyzeTextImpl: createAnalyzeImpl(analyzeCurrentTextAsset),
        analyzeImageImpl: createAnalyzeImpl(analyzeCurrentImageAsset),
        recordFailureImpl: (item, error) =>
          ensureBatchFailureRecord(projectPath, item, error),
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('ai:batch-analysis-progress', {
              projectPath,
              mode,
              ...progress,
            });
          }
        },
      });
    }));

  ipcMain.handle('brief:generate', (_event, projectPath) =>
    generateBrief(projectPath));

  ipcMain.handle('ai:generate-material-report', (_event, projectPath) =>
    generateAiMaterialReport(projectPath));

  ipcMain.handle('ai:generate-edit-suggestion', (_event, projectPath) =>
    runExclusiveAiAnalysis(async () => {
      const settings = await loadAiSettings(app.getPath('userData'));
      return generateEditSuggestion(projectPath, {
        pythonPath: settings.mlxPythonPath,
      });
    }));

  ipcMain.handle('stage2:load', (_event, projectPath) =>
    loadStage2State(projectPath));

  ipcMain.handle('plan:import', (_event, args) =>
    importVideoPlan(args.projectPath, args.planText));

  ipcMain.handle('voice:scan', (_event, projectPath) =>
    scanVoiceFiles(projectPath));

  ipcMain.handle('stage3:load', (_event, projectPath) =>
    loadStage3State(projectPath));

  ipcMain.handle('assignments:save', (_event, args) =>
    saveAssignments(args.projectPath, args.segments));

  ipcMain.handle('assignments:add-asset', (_event, args) =>
    addAssetToSegment(args.projectPath, args.segmentId, args.assetId));

  ipcMain.handle('assignments:auto-fit', (_event, args) =>
    autoFitSegment(args.projectPath, args.segmentId));

  ipcMain.handle('packages:sync', (_event, projectPath) =>
    syncSegmentPackages(projectPath));

  ipcMain.handle('roughcut:load-status', (_event, projectPath) =>
    loadRoughcutStatus(projectPath));

  ipcMain.handle('roughcut:generate-one', (_event, args) =>
    generateOneSegment(args.projectPath, args.segmentId));

  ipcMain.handle('roughcut:generate-all', (_event, projectPath) =>
    generateAllSegments(projectPath));

  ipcMain.handle('roughcut:show-output', (_event, outputPath) => {
    shell.showItemInFolder(outputPath);
  });

  ipcMain.handle('final-roughcut:load-status', (_event, projectPath) =>
    loadFinalRoughcutStatus(projectPath));

  ipcMain.handle('final-roughcut:generate', (_event, projectPath) =>
    generateFinalRoughcut(projectPath));

  ipcMain.handle('fcp-handoff:generate', (_event, projectPath) =>
    generateFcpHandoff(projectPath));

  ipcMain.handle('subtitle:load', (_event, projectPath) =>
    loadSubtitleState(projectPath));

  ipcMain.handle('subtitle:save-config', (_event, args) =>
    writeSubtitleConfig(args.projectPath, args.config));

  ipcMain.handle('subtitle:choose-video', async (_event, projectPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 FCP 导出的最终整片视频',
      defaultPath: path.join(projectPath, FCP_EXPORT_DIR),
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v'] }],
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('subtitle:generate-from-video', (_event, args) =>
    generateSubtitlesFromVideo(args.projectPath, args.inputVideo, args.command));

  ipcMain.handle('subtitle:organize-existing', async (_event, projectPath) => {
    let selectedSrtPath = null;
    const rawPath = path.join(projectPath, RAW_SRT_FILE);
    const rawExists = Boolean((await fs.stat(rawPath).catch(() => null))?.isFile());
    if (!rawExists) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择已有 SRT 文件',
        defaultPath: path.join(projectPath, '07-字幕'),
        properties: ['openFile'],
        filters: [{ name: 'SRT', extensions: ['srt'] }],
      });
      if (result.canceled) {
        throw new Error('找不到 raw.srt，请先放入 07-字幕/raw.srt，或选择一个已有 SRT 文件。');
      }
      selectedSrtPath = result.filePaths[0];
    }
    return organizeExistingSrt(projectPath, selectedSrtPath);
  });

  ipcMain.handle('recent-projects:load', () =>
    loadRecentProjects(app.getPath('userData')));

  ipcMain.handle('environment:detect', (_event, subtitleCommand) =>
    detectEnvironment(subtitleCommand));

  ipcMain.handle('codex-video:prepare', (_event, args) =>
    preparePendingMedia(args.sourceDirectory, { cacheRoot: args.cacheRoot }));

  ipcMain.handle('codex-video:inspect-range', (_event, args) =>
    inspectVideoRange(
      args.manifestPath,
      args.assetId,
      args.startSec,
      args.endSec,
      args.intervalSec,
    ));

  ipcMain.handle('codex-video:validate-analysis', (_event, args) =>
    validateAnalysisFile(args.manifestPath, args.analysisPath));

  ipcMain.handle('codex-video:build', (_event, args) =>
    buildCodexVideoProject(args));

  ipcMain.handle('codex-video:verify', (_event, projectPath) =>
    verifyCodexVideoProject(projectPath));

  ipcMain.handle('shell:show-item', (_event, itemPath) => {
    shell.showItemInFolder(itemPath);
  });

  ipcMain.handle('shell:open-folder', (_event, folderPath) =>
    shell.openPath(folderPath));
}

app.setName(APP_NAME);

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
