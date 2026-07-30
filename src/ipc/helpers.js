const path = require('node:path');

const { DEFAULT_PROJECT_ROOT } = require('../constants');
const {
  readCodexProjectResult,
  resolveProjectPath,
} = require('../services/codex-project-result-service');
const { assertCatalogProject } = require('../services/project-catalog-service');
const { getAiAnalysis, updateAiAnalysis } = require('../services/ai-analysis-store');
const {
  DEFAULT_PENDING_ROOT,
  scanPendingMediaCatalog,
} = require('../services/pending-media-catalog-service');
const { listHandoffTasks } = require('../services/handoff-task-service');

function createIpcHelpers({ app }) {
  const authorizedProjectPaths = new Set();
  let aiAnalysisRunning = false;

  function authorizeProject(projectPath) {
    const resolved = path.resolve(projectPath);
    authorizedProjectPaths.add(resolved);
    return resolved;
  }

  function assertAuthorizedProject(projectPath) {
    const resolved = path.resolve(String(projectPath || ''));
    if (!authorizedProjectPaths.has(resolved)) {
      throw Object.assign(new Error('项目尚未通过主进程授权。'), {
        code: 'PROJECT_NOT_AUTHORIZED',
      });
    }
    return resolved;
  }

  async function resolveAuthorizedItem(args, kind) {
    const projectPath = assertAuthorizedProject(args?.projectPath);
    return resolveProjectPath(projectPath, args?.relativePath, { kind });
  }

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

  async function scanHandoffsAndPending() {
    const handoffs = await listHandoffTasks(app.getPath('userData'));
    const catalog = await scanPendingMediaCatalog({
      rootPath: DEFAULT_PENDING_ROOT,
      projectRoot: DEFAULT_PROJECT_ROOT,
      tasks: handoffs.tasks,
    });
    return { ...catalog, handoffs };
  }

  async function validateTerminalProject(task) {
    if (!task.resultProjectPath) return null;
    const projectPath = await assertCatalogProject(DEFAULT_PROJECT_ROOT, task.resultProjectPath);
    const result = await readCodexProjectResult(projectPath);
    if (result.verification.status === 'failed' || !result.artifacts.fcpxml?.exists) return null;
    return { projectPath, result };
  }

  return {
    authorizeProject,
    assertAuthorizedProject,
    resolveAuthorizedItem,
    runExclusiveAiAnalysis,
    recordNoAiEnvironment,
    ensureBatchFailureRecord,
    scanHandoffsAndPending,
    validateTerminalProject,
  };
}

module.exports = { createIpcHelpers };
