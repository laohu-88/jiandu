'use strict';

const path = require('node:path');

const { DEFAULT_PROJECT_ROOT } = require('../constants');
const {
  AGENT_ENGINES,
  createHandoffTask,
  listHandoffTasks,
  readHandoffTask,
  updateHandoffTask,
} = require('./handoff-task-service');
const {
  continueBuildFromAnalysis,
  inspectAnalysisArtifacts,
} = require('./cursor-agent-handoff-service');

const USER_STATUS = Object.freeze({
  waiting_ai: { id: 'waiting_ai', label: '等待 AI' },
  processing: { id: 'processing', label: 'AI 正在处理' },
  results_ready: { id: 'results_ready', label: '结果已就绪' },
  in_fcp: { id: 'in_fcp', label: '已进入 FCP' },
  blocked: { id: 'blocked', label: '真正阻塞' },
});

const PROCESSING_STATUSES = new Set([
  'launching_codex', 'launching_cursor', 'awaiting_user_send',
  'scanning_media', 'extracting_metadata', 'extracting_frames',
  'analyzing_media', 'planning_story', 'analysis_complete',
  'deciding_hyperframes', 'designing_hyperframes', 'rendering_hyperframes',
  'reviewing_hyperframes', 'building_project', 'rendering_preview',
  'generating_fcpxml', 'verifying',
]);

function userFacingStatus(task) {
  if (!task) return USER_STATUS.waiting_ai;
  if (task.status === 'failed') return USER_STATUS.blocked;
  if (task.status === 'cancelled') return USER_STATUS.waiting_ai;
  if (task.status === 'completed' || task.status === 'completed_with_warnings') {
    if (task.openedInFcpAt) return USER_STATUS.in_fcp;
    return USER_STATUS.results_ready;
  }
  if (PROCESSING_STATUSES.has(task.status)) return USER_STATUS.processing;
  return USER_STATUS.waiting_ai;
}

function blockingErrors(task) {
  return (task?.errors || []).filter((item) => item && item.message);
}

async function createAgentTask(userDataPath, input) {
  const engine = input.engine || 'cursor_agent';
  if (!AGENT_ENGINES[engine]) {
    throw Object.assign(new Error(`不支持的剪辑引擎：${engine}`), { code: 'INVALID_AGENT_ENGINE' });
  }
  return createHandoffTask(userDataPath, {
    ...input,
    engine,
    extraRequirements: input.extraRequirements == null ? '' : String(input.extraRequirements),
    platformMode: input.platformMode === 'main' ? 'main' : 'douyin',
    kind: input.kind || 'edit',
  });
}

async function autoContinueIfNeeded(taskPath) {
  const task = await readHandoffTask(taskPath);
  if (task.status !== 'analysis_complete') return task;
  if (task.resultProjectPath) return task;
  const inspection = await inspectAnalysisArtifacts(task);
  if (!inspection.canContinueBuild) {
    return updateHandoffTask(taskPath, {
      status: 'failed',
      stageMessage: '分析结果未通过必要数据合同，无法继续。',
      errors: [{
        code: 'AGENT_CONTRACT_INVALID',
        message: inspection.validation?.error?.message || 'manifest/analysis 缺失或无效',
        at: new Date().toISOString(),
      }],
    });
  }
  return continueBuildFromAnalysis(taskPath, {
    projectRoot: DEFAULT_PROJECT_ROOT,
  });
}

async function autoFinalizeDouyin(projectPath) {
  const {
    readPlatformVariants,
    createDouyinVariant,
    approveDouyinVariant,
    buildDouyinVariant,
    allWarningIds,
  } = require('./platform-variant-service');
  let registry = await readPlatformVariants(projectPath).catch(() => ({ variants: [] }));
  let variant = (registry.variants || []).find((item) => item.platform === 'douyin');
  if (!variant) {
    variant = await createDouyinVariant(projectPath, { createdBy: 'agent-bridge' });
  }
  if (!['approved', 'generated', 'generated_with_warnings'].includes(String(variant.status))) {
    const warningIds = allWarningIds(variant.plan);
    variant = await approveDouyinVariant(projectPath, variant.variantId, {
      approvedBy: 'agent-bridge',
      approvedWarningIds: warningIds,
    });
  }
  if (!Array.isArray(variant.outputs) || variant.outputs.length === 0) {
    variant = await buildDouyinVariant(projectPath, variant.variantId, {
      approvedBy: 'agent-bridge',
    });
  }
  return variant;
}

async function finalizeAgentTask(taskPath) {
  let task = await autoContinueIfNeeded(taskPath);
  if (task.status === 'failed') return { task, blocked: true };
  const projectPath = task.resultProjectPath;
  if (!projectPath) return { task, blocked: false };
  if ((task.platformMode || 'douyin') === 'douyin') {
    try {
      const variant = await autoFinalizeDouyin(projectPath);
      task = await updateHandoffTask(taskPath, {
        status: task.status,
        artifacts: {
          ...(task.artifacts || {}),
          douyinVariantId: variant.variantId,
          douyinStatus: variant.status,
        },
      }).catch(() => task);
    } catch (error) {
      const blocking = /缺失|损坏|无效|合同|字幕/.test(error.message);
      if (blocking) {
        task = await updateHandoffTask(taskPath, {
          status: 'failed',
          stageMessage: error.message,
          errors: [{ code: error.code || 'DOUYIN_FINALIZE_FAILED', message: error.message, at: new Date().toISOString() }],
        }).catch(() => task);
        return { task, blocked: true, error };
      }
    }
  }
  return { task, blocked: false };
}

function matchTaskForSource(tasks, sourceDirectory) {
  const resolved = path.resolve(String(sourceDirectory || ''));
  return tasks
    .filter((task) => path.resolve(task.sourceDirectoryRealPath || task.sourceDirectory || '') === resolved)
    .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))[0] || null;
}

async function recoverActiveTasks(userDataPath) {
  const payload = await listHandoffTasks(userDataPath);
  const recovered = [];
  for (const task of payload.tasks) {
    if (task.status === 'analysis_complete' && !task.resultProjectPath) {
      recovered.push(await finalizeAgentTask(task.taskFilePath));
      continue;
    }
    recovered.push({ task, blocked: task.status === 'failed' });
  }
  return {
    tasks: payload.tasks,
    corrupt: payload.corrupt,
    recovered,
  };
}

module.exports = {
  USER_STATUS,
  PROCESSING_STATUSES,
  autoContinueIfNeeded,
  autoFinalizeDouyin,
  createAgentTask,
  finalizeAgentTask,
  matchTaskForSource,
  recoverActiveTasks,
  userFacingStatus,
  blockingErrors,
};
