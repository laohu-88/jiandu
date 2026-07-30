const { generateBrief, loadAssetIndex } = require('../services/media-service');
const {
  loadAiAnalysis,
  updateAiAnalysis,
} = require('../services/ai-analysis-store');
const { checkAiEnvironment } = require('../services/ai-environment-service');
const { analyzeCurrentTextAsset } = require('../services/ai-text-analysis-service');
const { analyzeCurrentImageAsset } = require('../services/ai-image-analysis-service');
const {
  analyzeBatchAssets,
  getAiEnvironmentIssue,
  selectBatchCandidates,
} = require('../services/ai-batch-analysis-service');
const {
  generateAiMaterialReport,
} = require('../services/ai-material-report-service');
const {
  generateEditSuggestion,
} = require('../services/ai-edit-suggestion-service');
const {
  loadAiSettings,
  saveAiSettings,
} = require('../services/ai-settings-service');

function registerAiIpc(ctx) {
  const {
    app,
    ipcMain,
    runExclusiveAiAnalysis,
    recordNoAiEnvironment,
    ensureBatchFailureRecord,
  } = ctx;

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
}

module.exports = { registerAiIpc };
