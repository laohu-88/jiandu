'use strict';

const crypto = require('node:crypto');

const LIFECYCLE = Object.freeze({
  preparing: 'preparing',
  handed_off: 'handed_off',
  running: 'running',
  analysis_needs_correction: 'analysis_needs_correction',
  completed: 'completed',
  failed: 'failed',
  canceled: 'canceled',
  agent_disconnected: 'agent_disconnected',
});

const PREPARING_STATUSES = new Set(['draft', 'ready']);
const HANDED_OFF_STATUSES = new Set([
  'launching_codex',
  'awaiting_user_send',
]);
const RUNNING_STATUSES = new Set([
  'scanning_media',
  'extracting_metadata',
  'extracting_frames',
  'analyzing_media',
  'planning_story',
  'analysis_needs_correction',
  'analysis_complete',
  'deciding_hyperframes',
  'designing_hyperframes',
  'rendering_hyperframes',
  'reviewing_hyperframes',
  'building_project',
  'rendering_preview',
  'generating_fcpxml',
  'verifying',
]);
const COMPLETED_STATUSES = new Set(['completed', 'completed_with_warnings']);
const FAILED_STATUSES = new Set(['failed']);
const CANCELED_STATUSES = new Set(['cancelled']);
const DISCONNECTED_STATUSES = new Set(['agent_disconnected']);

const TERMINAL_LIFECYCLES = new Set([
  LIFECYCLE.completed,
  LIFECYCLE.failed,
  LIFECYCLE.canceled,
]);

const ACTIVE_LIFECYCLES = new Set([
  LIFECYCLE.handed_off,
  LIFECYCLE.running,
  LIFECYCLE.analysis_needs_correction,
]);

const HEARTBEAT_STALE_MS = 120_000;
const LAUNCH_FAILURE_GRACE_MS = 15_000;

function statusOf(taskOrStatus) {
  if (taskOrStatus == null) return null;
  if (typeof taskOrStatus === 'string') return taskOrStatus;
  return taskOrStatus.status || null;
}

function lifecycleOf(taskOrStatus) {
  const status = statusOf(taskOrStatus);
  if (!status) return LIFECYCLE.preparing;
  if (DISCONNECTED_STATUSES.has(status) || status === LIFECYCLE.agent_disconnected) {
    return LIFECYCLE.agent_disconnected;
  }
  if (CANCELED_STATUSES.has(status) || status === LIFECYCLE.canceled) return LIFECYCLE.canceled;
  if (FAILED_STATUSES.has(status)) return LIFECYCLE.failed;
  if (COMPLETED_STATUSES.has(status)) return LIFECYCLE.completed;
  if (status === 'analysis_needs_correction') return LIFECYCLE.analysis_needs_correction;
  if (RUNNING_STATUSES.has(status)) return LIFECYCLE.running;
  if (HANDED_OFF_STATUSES.has(status)) return LIFECYCLE.handed_off;
  if (PREPARING_STATUSES.has(status)) return LIFECYCLE.preparing;
  return LIFECYCLE.preparing;
}

function isTerminalLifecycle(lifecycle) {
  return TERMINAL_LIFECYCLES.has(lifecycle);
}

function isTerminalStatus(status) {
  return isTerminalLifecycle(lifecycleOf(status));
}

function isActiveLifecycle(lifecycle) {
  return ACTIVE_LIFECYCLES.has(lifecycle);
}

function canCancel(task) {
  return !isTerminalStatus(task?.status);
}

function engineSelectionLocked(task) {
  return isActiveLifecycle(lifecycleOf(task));
}

function engineLabel(engine) {
  return 'Codex';
}

function disconnectedCopy(task) {
  return `${engineLabel(task?.engine || task?.currentAttempt?.engine)} 已停止，任务未完成`;
}

function recoveryActions(task) {
  const lifecycle = lifecycleOf(task);
  if (lifecycle !== LIFECYCLE.agent_disconnected && lifecycle !== LIFECYCLE.failed) return [];
  const engine = 'codex';
  const continueLabel = lifecycle === LIFECYCLE.failed ? '重新使用 Codex' : '继续使用 Codex';
  const actions = [
    { id: 'continue_codex', label: continueLabel, engine },
  ];
  if (lifecycle !== LIFECYCLE.failed) actions.push({ id: 'cancel', label: '取消任务' });
  return actions;
}

function createAttemptId() {
  return crypto.randomUUID();
}

function createAttempt({
  engine,
  previousAttemptId = null,
  takeoverReason = null,
  handoffRef = null,
  resultRef = null,
  generation = 1,
  now = new Date().toISOString(),
  status = LIFECYCLE.preparing,
} = {}) {
  const resolvedEngine = 'codex';
  return {
    attemptId: createAttemptId(),
    engine: resolvedEngine,
    startedAt: now,
    lastActivityAt: now,
    endedAt: null,
    status,
    launchAttemptedAt: null,
    handoffRef,
    resultRef,
    previousAttemptId,
    takeoverReason,
    generation,
    invalidatedAt: null,
  };
}

function hydrateAttempts(task, now = new Date().toISOString()) {
  if (!task || typeof task !== 'object') return task;
  const lifecycle = lifecycleOf(task);
  if (task.currentAttempt?.attemptId && Array.isArray(task.attempts)) {
    return {
      ...task,
      lifecycle: task.lifecycle || lifecycle,
    };
  }
  const attempt = {
    attemptId: task.currentAttempt?.attemptId || task.taskId,
    engine: 'codex',
    startedAt: task.launchedAt || task.startedAt || task.createdAt || now,
    lastActivityAt: task.lastHeartbeatAt || task.updatedAt || now,
    endedAt: isTerminalLifecycle(lifecycle) || lifecycle === LIFECYCLE.agent_disconnected
      ? (task.completedAt || task.updatedAt || now)
      : null,
    status: lifecycle,
    launchAttemptedAt: task.launchedAt || null,
    handoffRef: task.taskFilePath || null,
    resultRef: {
      analysisPath: task.artifacts?.analysisPath || task.artifacts?.analysisOutputPath || null,
      manifestPath: task.artifacts?.manifestPath || null,
      projectPath: task.resultProjectPath || null,
    },
    previousAttemptId: task.parentTaskId || null,
    takeoverReason: null,
    generation: 1,
    invalidatedAt: null,
  };
  return {
    ...task,
    lifecycle,
    currentAttempt: attempt,
    attempts: [attempt],
  };
}

function currentAttemptId(task) {
  return task?.currentAttempt?.attemptId || null;
}

function writeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertWriteAllowed(task, patch = {}) {
  const hydrated = hydrateAttempts(task);
  const current = hydrated.currentAttempt;
  const nextStatus = patch.status || hydrated.status;
  const sameStatus = nextStatus === hydrated.status;
  const lifecycle = lifecycleOf(hydrated);

  if (isTerminalLifecycle(lifecycle) && !sameStatus) {
    throw writeError('HANDOFF_TERMINAL_STATE', '终态交接任务不能被普通阶段覆盖。');
  }

  if (current?.invalidatedAt && !sameStatus) {
    throw writeError('LATE_ATTEMPT_WRITE', '旧 Agent attempt 的迟到回写已被忽略。');
  }

  if (patch.attemptId && current?.attemptId && patch.attemptId !== current.attemptId) {
    throw writeError('LATE_ATTEMPT_WRITE', '旧 Agent attempt 的迟到回写已被忽略。');
  }

  if (
    current
    && current.generation > 1
    && !patch.attemptId
    && !sameStatus
    && !patch.newAttempt
  ) {
    throw writeError('LATE_ATTEMPT_WRITE', '旧 Agent attempt 的迟到回写已被忽略。');
  }

  return hydrated;
}

function lastActivityMs(task, now = Date.now()) {
  const stamps = [
    task?.currentAttempt?.lastActivityAt,
    task?.lastHeartbeatAt,
    task?.updatedAt,
  ].map((value) => Date.parse(value)).filter((value) => Number.isFinite(value));
  if (!stamps.length) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - Math.max(...stamps));
}

function hasLaunchFailure(task) {
  return (task?.errors || []).some((item) => (
    item && /LAUNCH_FAILED|DEEP_LINK_FAILED|ENOENT/i.test(`${item.code || ''} ${item.message || ''}`)
  ));
}

function launchAttempted(task) {
  return Boolean(task?.currentAttempt?.launchAttemptedAt || task?.launchedAt);
}

function evaluateLiveness(task, runtime = {}, now = Date.now()) {
  const hydrated = hydrateAttempts(task);
  const lifecycle = lifecycleOf(hydrated);
  if (isTerminalLifecycle(lifecycle)) {
    return {
      live: false,
      disconnected: false,
      reason: 'terminal',
      lifecycle,
      evidence: [],
    };
  }
  if (lifecycle === LIFECYCLE.preparing) {
    return {
      live: false,
      disconnected: false,
      reason: 'not_started',
      lifecycle,
      evidence: [],
    };
  }
  if (lifecycle === LIFECYCLE.agent_disconnected) {
    return {
      live: false,
      disconnected: true,
      reason: 'already_disconnected',
      lifecycle,
      evidence: [],
    };
  }

  const processExists = runtime.processExists === true;
  const taskWindowExists = runtime.taskWindowExists === true;
  const windowProbeOk = runtime.windowProbeOk === true;
  const sessionExists = runtime.sessionExists === true || processExists;
  const resultUpdatedRecently = runtime.resultUpdatedRecently === true;
  const ageMs = lastActivityMs(hydrated, now);
  const evidence = [];
  if (processExists) evidence.push('process');
  if (taskWindowExists) evidence.push('task_window');
  if (ageMs <= HEARTBEAT_STALE_MS) evidence.push('heartbeat');
  if (resultUpdatedRecently) evidence.push('result');
  if (runtime.launchAttempted === true || launchAttempted(hydrated)) evidence.push('launch');
  if (lifecycle === LIFECYCLE.handed_off) {
    if (hasLaunchFailure(hydrated) && ageMs >= LAUNCH_FAILURE_GRACE_MS) {
      return {
        live: false,
        disconnected: true,
        reason: 'launch_failed',
        lifecycle,
        evidence,
        ageMs,
      };
    }
    if (!processExists && launchAttempted(hydrated)) {
      return {
        live: false,
        disconnected: true,
        reason: 'process_missing',
        lifecycle,
        evidence,
        ageMs,
      };
    }
    if (!processExists && !launchAttempted(hydrated) && ageMs >= LAUNCH_FAILURE_GRACE_MS) {
      return {
        live: false,
        disconnected: true,
        reason: 'launch_failed',
        lifecycle,
        evidence,
        ageMs,
      };
    }
    return {
      live: processExists || !launchAttempted(hydrated),
      disconnected: false,
      reason: processExists ? 'awaiting_user' : 'preparing_launch',
      lifecycle,
      evidence,
      ageMs,
    };
  }

  if (!sessionExists) {
    return {
      live: false,
      disconnected: true,
      reason: launchAttempted(hydrated) ? 'process_missing' : 'no_runtime_evidence',
      lifecycle,
      evidence,
      ageMs,
    };
  }
  if (resultUpdatedRecently || ageMs <= HEARTBEAT_STALE_MS) {
    return {
      live: true,
      disconnected: false,
      reason: resultUpdatedRecently ? 'result' : 'heartbeat',
      lifecycle,
      evidence,
      ageMs,
    };
  }
  const launchedAt = Date.parse(
    hydrated.currentAttempt?.launchAttemptedAt || hydrated.launchedAt || 0,
  );
  if (Number.isFinite(launchedAt) && now - launchedAt <= HEARTBEAT_STALE_MS) {
    return {
      live: true,
      disconnected: false,
      reason: 'process_recent',
      lifecycle,
      evidence,
      ageMs,
    };
  }
  return {
    live: false,
    disconnected: true,
    reason: 'heartbeat_stale',
    lifecycle,
    evidence,
    ageMs,
  };
}

function reusableResultsFrom(task) {
  const artifacts = task?.artifacts || {};
  const analysisPath = artifacts.analysisPath || artifacts.analysisOutputPath || null;
  const manifestPath = artifacts.manifestPath || null;
  const hasAnalysis = Boolean(analysisPath && manifestPath);
  const lastActiveStatus = task?.lastActiveStatus
    || (lifecycleOf(task) === LIFECYCLE.agent_disconnected ? null : task?.status)
    || null;
  return {
    skipFullRescan: Boolean(hasAnalysis || task?.kind === 'revise' || task?.previousProjectPath),
    analysisPath,
    manifestPath,
    analysisRequestPath: artifacts.analysisRequestPath || null,
    cacheDirectory: artifacts.cacheDirectory || null,
    projectPath: task?.resultProjectPath || task?.previousProjectPath || null,
    lastActiveStatus,
    previousAttemptId: task?.currentAttempt?.attemptId || null,
  };
}

function processingViewModel(task) {
  const hydrated = hydrateAttempts(task);
  const lifecycle = lifecycleOf(hydrated);
  const engine = 'codex';
  const disconnected = lifecycle === LIFECYCLE.agent_disconnected;
  const correcting = lifecycle === LIFECYCLE.analysis_needs_correction;
  return {
    lifecycle,
    engine,
    engineLabel: engineLabel(engine),
    title: correcting
      ? `${engineLabel(engine)} 正在修正分析`
      : (disconnected
      ? disconnectedCopy(hydrated)
      : 'Codex 正在处理'),
    message: correcting
      ? (hydrated.stageMessage || '分析合同待修正，等待 Agent 写回并再次校验。')
      : (disconnected
      ? (hydrated.stageMessage || disconnectedCopy(hydrated))
      : (hydrated.stageMessage || '已交接，等待 Agent 返回。')),
    canCancel: canCancel(hydrated),
    engineLocked: engineSelectionLocked(hydrated),
    recoveryActions: recoveryActions(hydrated),
    attemptId: currentAttemptId(hydrated),
    status: hydrated.status,
  };
}

module.exports = {
  ACTIVE_LIFECYCLES,
  CANCELED_STATUSES,
  COMPLETED_STATUSES,
  DISCONNECTED_STATUSES,
  FAILED_STATUSES,
  HANDED_OFF_STATUSES,
  HEARTBEAT_STALE_MS,
  LAUNCH_FAILURE_GRACE_MS,
  LIFECYCLE,
  PREPARING_STATUSES,
  RUNNING_STATUSES,
  TERMINAL_LIFECYCLES,
  assertWriteAllowed,
  canCancel,
  createAttempt,
  createAttemptId,
  currentAttemptId,
  disconnectedCopy,
  engineLabel,
  engineSelectionLocked,
  evaluateLiveness,
  hydrateAttempts,
  isActiveLifecycle,
  isTerminalLifecycle,
  isTerminalStatus,
  lastActivityMs,
  lifecycleOf,
  processingViewModel,
  recoveryActions,
  reusableResultsFrom,
};
