'use strict';

const path = require('node:path');

const { DEFAULT_PROJECT_ROOT } = require('../constants');
const {
  AGENT_ENGINES,
  cancelHandoffTask,
  createHandoffTask,
  listHandoffTasks,
  markAgentDisconnected,
  readHandoffTask,
  startAgentAttempt,
  updateHandoffTask,
} = require('./handoff-task-service');
const {
  continueBuildFromAnalysis,
  inspectAnalysisArtifacts,
} = require('./agent-handoff-service');
const {
  LIFECYCLE,
  canCancel,
  engineSelectionLocked,
  evaluateLiveness,
  hydrateAttempts,
  isTerminalStatus,
  lifecycleOf,
  processingViewModel,
  recoveryActions,
} = require('./agent-lifecycle-service');
const { probeTaskRuntime } = require('./agent-runtime-service');

const USER_STATUS = Object.freeze({
  waiting_ai: { id: 'waiting_ai', label: '等待 AI' },
  processing: { id: 'processing', label: 'AI 正在处理' },
  results_ready: { id: 'results_ready', label: '结果已就绪' },
  in_fcp: { id: 'in_fcp', label: '已进入 FCP' },
  blocked: { id: 'blocked', label: '真正阻塞' },
  agent_disconnected: { id: 'agent_disconnected', label: 'Agent 已停止' },
});

function userFacingStatus(task) {
  if (!task) return USER_STATUS.waiting_ai;
  const lifecycle = lifecycleOf(task);
  if (lifecycle === LIFECYCLE.failed) return USER_STATUS.blocked;
  if (lifecycle === LIFECYCLE.canceled) return USER_STATUS.waiting_ai;
  if (lifecycle === LIFECYCLE.agent_disconnected) return USER_STATUS.agent_disconnected;
  if (lifecycle === LIFECYCLE.analysis_needs_correction) return USER_STATUS.processing;
  if (lifecycle === LIFECYCLE.completed) {
    if (task.openedInFcpAt) return USER_STATUS.in_fcp;
    return USER_STATUS.results_ready;
  }
  if (lifecycle === LIFECYCLE.running || lifecycle === LIFECYCLE.handed_off) {
    return USER_STATUS.processing;
  }
  return USER_STATUS.waiting_ai;
}

function blockingErrors(task) {
  return (task?.errors || []).filter((item) => item && item.message);
}

function matchTaskForSource(tasks, sourceDirectory) {
  const resolved = path.resolve(String(sourceDirectory || ''));
  return tasks
    .filter((task) => path.resolve(task.sourceDirectoryRealPath || task.sourceDirectory || '') === resolved)
    .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))[0] || null;
}

async function createAgentTask(userDataPath, input) {
  const engine = 'codex';
  const listed = await listHandoffTasks(userDataPath);
  const existing = matchTaskForSource(listed.tasks, input.sourceDirectory);
  if (existing && !isTerminalStatus(existing.status)) {
    const life = lifecycleOf(existing);
    if (life === LIFECYCLE.agent_disconnected) {
      return startAgentAttempt(existing.taskFilePath, {
        engine,
        reason: 'resume_after_disconnect',
        extraRequirements: input.extraRequirements,
      });
    }
    if (life === LIFECYCLE.running || life === LIFECYCLE.handed_off) {
      throw Object.assign(new Error('当前素材已有进行中的 AI 任务。请先取消或等待完成后重试。'), {
        code: 'AGENT_TASK_IN_PROGRESS',
        task: existing,
      });
    }
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
      attemptId: task.currentAttempt?.attemptId,
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
        attemptId: task.currentAttempt?.attemptId,
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
          attemptId: task.currentAttempt?.attemptId,
          errors: [{ code: error.code || 'DOUYIN_FINALIZE_FAILED', message: error.message, at: new Date().toISOString() }],
        }).catch(() => task);
        return { task, blocked: true, error };
      }
    }
  }
  return { task, blocked: false };
}

async function maybeCompleteFromExistingProject(task) {
  if (isTerminalStatus(task.status) || !task.resultProjectPath) return null;
  if (!['verifying', 'building_project', 'rendering_preview', 'generating_fcpxml', 'analysis_complete'].includes(task.status)
    && lifecycleOf(task) !== LIFECYCLE.agent_disconnected) {
    return null;
  }
  try {
    const { verifyCodexVideoProject } = require('./codex-video-service');
    const { readCodexProjectResult } = require('./codex-project-result-service');
    const verification = await verifyCodexVideoProject(task.resultProjectPath);
    if (!verification.ok) return null;
    const result = await readCodexProjectResult(task.resultProjectPath);
    const warnings = [...new Set([
      ...(task.warnings || []),
      ...(verification.warnings || []),
      ...(result.verification.warnings || []),
    ])];
    const status = warnings.length ? 'completed_with_warnings' : 'completed';
    const completed = await updateHandoffTask(task.taskFilePath, {
      status,
      attemptId: task.currentAttempt?.attemptId,
      stageMessage: warnings.length
        ? '已根据现有正式项目完成交接，但存在警告。'
        : '已根据现有正式项目完成交接。',
      resultProjectPath: result.project.path,
      resultProjectId: result.project.name,
      verification,
      warnings,
    });
    return completed;
  } catch {
    return null;
  }
}

async function reconcileActiveTasks(userDataPath, options = {}) {
  const payload = await listHandoffTasks(userDataPath);
  const recovered = [];
  const probe = options.probeTaskRuntime || probeTaskRuntime;
  const now = options.now || Date.now();
  const engineRuntime = new Map();
  async function runtimeFor(task) {
    if (probe !== probeTaskRuntime) {
      return probe(task, { now, ...options.runtimeOptions });
    }
    const { probeAgentRuntime, attachResultEvidence, probeTaskWindow } = require('./agent-runtime-service');
    const engine = 'codex';
    if (!engineRuntime.has(engine)) {
      engineRuntime.set(engine, probeAgentRuntime(engine, { now, ...options.runtimeOptions }));
    }
    const shared = await engineRuntime.get(engine);
    const withResults = await attachResultEvidence(task, shared, now);
    const windowProbe = await probeTaskWindow(task, {
      ...(options.runtimeOptions || {}),
      processes: shared.processes,
    });
    const sessionExists = withResults.processExists === true;
    return { ...withResults, ...windowProbe, sessionExists };
  }
  for (const listed of payload.tasks) {
    const task = hydrateAttempts(listed);
    if (isTerminalStatus(task.status)) {
      recovered.push({ task, action: 'none', blocked: task.status === 'failed' });
      continue;
    }
    if (task.status === 'analysis_complete' && !task.resultProjectPath) {
      const finalized = await finalizeAgentTask(task.taskFilePath);
      recovered.push({
        task: finalized.task,
        action: 'finalize',
        blocked: finalized.blocked === true,
      });
      continue;
    }
    const completedFromProject = await maybeCompleteFromExistingProject(task);
    if (completedFromProject) {
      recovered.push({ task: completedFromProject, action: 'complete_from_project', blocked: false });
      continue;
    }
    const runtime = await runtimeFor(task);
    const liveness = evaluateLiveness(task, runtime, now);
    if (liveness.disconnected && task.status !== 'agent_disconnected') {
      const fresh = await readHandoffTask(task.taskFilePath);
      const freshRuntime = await runtimeFor(fresh);
      const freshLiveness = evaluateLiveness(fresh, freshRuntime, Date.now());
      if (!freshLiveness.disconnected) {
        recovered.push({
          task: fresh,
          action: 'running',
          blocked: false,
          liveness: freshLiveness,
          runtime: freshRuntime,
        });
        continue;
      }
      const disconnected = await markAgentDisconnected(task.taskFilePath, freshLiveness.reason);
      recovered.push({
        task: disconnected,
        action: 'disconnected',
        blocked: false,
        liveness: freshLiveness,
        runtime: freshRuntime,
      });
      continue;
    }
    recovered.push({
      task,
      action: task.status === 'agent_disconnected'
        ? 'disconnected'
        : (liveness.live ? 'running' : 'none'),
      blocked: false,
      liveness,
      runtime,
    });
  }
  return {
    tasks: payload.tasks,
    corrupt: payload.corrupt,
    recovered,
  };
}

async function recoverActiveTasks(userDataPath, options = {}) {
  return reconcileActiveTasks(userDataPath, options);
}

async function cancelAgentTask(taskPath) {
  return cancelHandoffTask(taskPath);
}

async function takeoverAgentTask(taskPath, input = {}) {
  return startAgentAttempt(taskPath, input);
}

module.exports = {
  USER_STATUS,
  autoContinueIfNeeded,
  autoFinalizeDouyin,
  blockingErrors,
  canCancel,
  cancelAgentTask,
  createAgentTask,
  engineSelectionLocked,
  finalizeAgentTask,
  lifecycleOf,
  matchTaskForSource,
  processingViewModel,
  recoverActiveTasks,
  reconcileActiveTasks,
  recoveryActions,
  takeoverAgentTask,
  userFacingStatus,
};
