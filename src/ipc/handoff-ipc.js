const path = require('node:path');

const {
  CODEX_WORKSPACE_ROOT,
  DEFAULT_PROJECT_ROOT,
} = require('../constants');
const { DEFAULT_PENDING_ROOT } = require('../services/pending-media-catalog-service');
const {
  assertUserDataTask,
  cancelHandoffTask,
  createHandoffTask,
  listHandoffTasks,
  loadHandoffSettings,
  readHandoffTask,
  saveHandoffSettings,
  startAgentAttempt,
  updateHandoffTask,
} = require('../services/handoff-task-service');
const {
  classifyAgentHandoffState,
  continueBuildFromAnalysis,
  inspectAnalysisArtifacts,
  markAnalysisComplete,
} = require('../services/agent-handoff-service');
const {
  createAgentTask,
  processingViewModel,
  reconcileActiveTasks,
} = require('../services/agent-bridge-service');
const { scanCanonicalInventory } = require('../services/hotingest-adapter');

async function launchCodexTask(shell, task) {
  if ((task.engine || 'codex') !== 'codex') {
    throw new Error('当前任务不是 Codex 引擎任务。');
  }
  const attemptId = task.currentAttempt?.attemptId;
  const launching = await updateHandoffTask(task.taskFilePath, {
    status: 'launching_codex',
    attemptId,
    stageMessage: '正在使用官方深链接打开 Codex。',
  });
  try {
    await shell.openExternal(launching.codexDeepLink, { activate: true });
    return updateHandoffTask(task.taskFilePath, {
      status: 'awaiting_user_send',
      attemptId,
      stageMessage: 'Codex 已打开并预填提示词。',
    });
  } catch (error) {
    await updateHandoffTask(task.taskFilePath, {
      status: 'launching_codex',
      attemptId,
      stageMessage: `Codex 深链接打开失败：${error.message}`,
      errors: [{ code: 'CODEX_DEEP_LINK_FAILED', message: error.message, at: new Date().toISOString() }],
    });
    throw error;
  }
}

function registerHandoffIpc(ctx) {
  const {
    app,
    ipcMain,
    shell,
    authorizeProject,
    scanHandoffsAndPending,
    validateTerminalProject,
  } = ctx;

  ipcMain.handle('handoff:create', async (_event, args) => {
    const payload = await scanHandoffsAndPending();
    const sourcePath = path.resolve(String(args?.sourceDirectory || ''));
    const episode = payload.episodes.find((item) => item.sourceDirectory === sourcePath);
    if (!episode) throw new Error('所选素材目录未通过待处理目录授权。');
    if (episode.empty || episode.unreadable) throw new Error('空目录或无法读取目录不能启动生产。');
    const settings = await loadHandoffSettings(app.getPath('userData'));
    return createHandoffTask(app.getPath('userData'), {
      pendingRoot: DEFAULT_PENDING_ROOT,
      sourceDirectory: episode.sourceDirectory,
      sourceSnapshot: episode.sourceSnapshot,
      sourceSummary: {
        name: episode.name,
        counts: episode.counts,
        totalFileCount: episode.totalFileCount,
        totalVideoDurationSec: episode.totalVideoDurationSec,
        totalSizeBytes: episode.totalSizeBytes,
        warnings: episode.warnings,
        chapters: episode.chapters,
        briefFilesUsed: episode.briefFilesUsed,
        durationPolicy: episode.durationPolicy,
        allowChapterInterleave: episode.allowChapterInterleave,
      },
      appWorkspace: CODEX_WORKSPACE_ROOT,
      hyperframesMode: args?.hyperframesMode || 'auto',
      engine: 'codex',
      extraRequirements: args?.extraRequirements == null ? '' : String(args.extraRequirements),
      platformMode: 'main',
      kind: args?.kind === 'revise' ? 'revise' : 'edit',
      parentTaskId: args?.parentTaskId || null,
      previousProjectPath: args?.previousProjectPath || null,
      previousAnalysisPath: args?.previousAnalysisPath || null,
      autoOpenFcp: settings.autoOpenFcp,
    });
  });

  ipcMain.handle('handoff:launch-codex', async (_event, taskPath) => {
    const task = await assertUserDataTask(app.getPath('userData'), taskPath);
    return launchCodexTask(shell, task);
  });


  ipcMain.handle('handoff:recognize-source', async (_event, sourceDirectory) => {
    const payload = await scanHandoffsAndPending();
    const sourcePath = path.resolve(String(sourceDirectory || ''));
    const episode = payload.episodes.find((item) => item.sourceDirectory === sourcePath);
    if (!episode) throw new Error('所选素材目录未通过待处理目录授权。');
    const inventory = await scanCanonicalInventory(sourcePath);
    return {
      episode,
      inventory,
      recognized: true,
      hotingest: inventory.detected,
    };
  });

  ipcMain.handle('handoff:start-edit', async (_event, args) => {
    const payload = await scanHandoffsAndPending();
    const sourcePath = path.resolve(String(args?.sourceDirectory || ''));
    const episode = payload.episodes.find((item) => item.sourceDirectory === sourcePath);
    if (!episode) throw new Error('所选素材目录未通过待处理目录授权。');
    if (episode.empty || episode.unreadable) throw new Error('空目录或无法读取目录不能启动生产。');
    const settings = await loadHandoffSettings(app.getPath('userData'));
    const task = await createAgentTask(app.getPath('userData'), {
      pendingRoot: DEFAULT_PENDING_ROOT,
      sourceDirectory: episode.sourceDirectory,
      sourceSnapshot: episode.sourceSnapshot,
      sourceSummary: {
        name: episode.name,
        counts: episode.counts,
        totalFileCount: episode.totalFileCount,
        totalVideoDurationSec: episode.totalVideoDurationSec,
        totalSizeBytes: episode.totalSizeBytes,
        warnings: episode.warnings,
        chapters: episode.chapters,
        briefFilesUsed: episode.briefFilesUsed,
        durationPolicy: episode.durationPolicy,
        allowChapterInterleave: episode.allowChapterInterleave,
      },
      appWorkspace: CODEX_WORKSPACE_ROOT,
      hyperframesMode: args?.hyperframesMode || 'auto',
      engine: 'codex',
      extraRequirements: args?.extraRequirements == null ? '' : String(args.extraRequirements),
      platformMode: 'main',
      kind: args?.kind === 'revise' ? 'revise' : 'edit',
      parentTaskId: args?.parentTaskId || null,
      previousProjectPath: args?.previousProjectPath || null,
      previousAnalysisPath: args?.previousAnalysisPath || null,
      autoOpenFcp: settings.autoOpenFcp,
    });
    return { task };
  });

  ipcMain.handle('handoff:read', async (_event, taskPath) => {
    const task = await assertUserDataTask(app.getPath('userData'), taskPath);
    return task;
  });

  ipcMain.handle('handoff:classify', async (_event, taskPath) => {
    const task = await assertUserDataTask(app.getPath('userData'), taskPath);
    const classification = classifyAgentHandoffState(task);
    const inspection = task.status === 'analysis_complete'
      ? await inspectAnalysisArtifacts(task)
      : null;
    return { task, classification, inspection };
  });

  ipcMain.handle('handoff:continue-build', async (_event, args) => {
    const task = await assertUserDataTask(app.getPath('userData'), args?.taskPath);
    return continueBuildFromAnalysis(task.taskFilePath, {
      projectRoot: DEFAULT_PROJECT_ROOT,
      projectName: args?.projectName,
    });
  });

  ipcMain.handle('handoff:mark-analysis-complete', async (_event, args) => {
    const task = await assertUserDataTask(app.getPath('userData'), args?.taskPath);
    return markAnalysisComplete(task.taskFilePath, {
      manifestPath: args?.manifestPath,
      analysisPath: args?.analysisPath,
      analysisRequestPath: args?.analysisRequestPath,
      cacheDirectory: args?.cacheDirectory,
      stageMessage: args?.stageMessage,
    });
  });

  ipcMain.handle('handoff:list', () => listHandoffTasks(app.getPath('userData')));

  ipcMain.handle('handoff:cancel', async (_event, taskPath) => {
    const task = await assertUserDataTask(app.getPath('userData'), taskPath);
    return cancelHandoffTask(task.taskFilePath);
  });

  ipcMain.handle('handoff:takeover', async (_event, args) => {
    const task = await assertUserDataTask(app.getPath('userData'), args?.taskPath);
    const engine = 'codex';
    const updated = await startAgentAttempt(task.taskFilePath, {
      engine,
      reason: args?.reason || (engine === task.engine ? 'resume_after_disconnect' : 'switch_engine'),
      extraRequirements: args?.extraRequirements,
    });
    return launchCodexTask(shell, updated);
  });

  ipcMain.handle('handoff:reconcile', async () => {
    const payload = await reconcileActiveTasks(app.getPath('userData'));
    return {
      ...payload,
      views: payload.recovered.map((item) => ({
        task: item.task,
        action: item.action,
        view: processingViewModel(item.task),
      })),
    };
  });

  ipcMain.handle('handoff:activate-codex', async (_event, taskPath) => {
    await assertUserDataTask(app.getPath('userData'), taskPath);
    await shell.openExternal('codex://', { activate: true });
    return { activated: true };
  });

  ipcMain.handle('handoff:copy-prompt', async (_event, taskPath) => {
    const task = await assertUserDataTask(app.getPath('userData'), taskPath);
    clipboard.writeText(task.prompt);
    return { copied: true };
  });


  ipcMain.handle('handoff:settings-load', () => loadHandoffSettings(app.getPath('userData')));
  ipcMain.handle('handoff:settings-save', (_event, settings) =>
    saveHandoffSettings(app.getPath('userData'), settings));

  ipcMain.handle('handoff:open-result', async (_event, taskPath) => {
    const task = await assertUserDataTask(app.getPath('userData'), taskPath);
    const validated = await validateTerminalProject(task);
    if (!validated) throw new Error('交接任务没有可安全打开的正式项目结果。');
    authorizeProject(validated.projectPath);
    return validated.result;
  });
}

module.exports = { registerHandoffIpc, launchCodexTask };
