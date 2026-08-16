'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  LIFECYCLE,
  assertWriteAllowed,
  canCancel,
  createAttempt,
  disconnectedCopy,
  hydrateAttempts,
  isTerminalStatus,
  lifecycleOf,
  reusableResultsFrom,
} = require('./agent-lifecycle-service');

const HANDOFF_SCHEMA_VERSION = 1;
const HANDOFF_DIRNAME = 'handoffs';
const SETTINGS_FILENAME = 'handoff-settings.json';
const TERMINAL_STATUSES = new Set(['completed', 'completed_with_warnings', 'failed', 'cancelled']);
const PARKED_STATUSES = new Set(['agent_disconnected']);
const AGENT_ENGINES = Object.freeze({
  codex: Object.freeze({
    id: 'codex',
    label: 'Codex',
    launchStatus: 'launching_codex',
    awaitingMessage: 'Codex 已打开并预填提示词。',
  }),
  cursor_agent: Object.freeze({
    id: 'cursor_agent',
    label: 'Cursor',
    launchStatus: 'launching_cursor',
    awaitingMessage: 'Cursor 已打开，正式提示词已放入输入框。',
  }),
});
const HANDOFF_STATUSES = Object.freeze([
  'draft',
  'ready',
  'launching_codex',
  'launching_cursor',
  'awaiting_user_send',
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
  'agent_disconnected',
  'completed',
  'completed_with_warnings',
  'failed',
  'cancelled',
]);
const STATUS_SET = new Set(HANDOFF_STATUSES);
const STAGE_LABELS = Object.freeze({
  draft: '准备交接',
  ready: '准备交接',
  launching_codex: '正在打开 Codex',
  launching_cursor: '正在打开 Cursor',
  awaiting_user_send: '等待在 Agent 中启动',
  scanning_media: '正在扫描素材',
  extracting_metadata: '正在读取素材信息',
  extracting_frames: '正在抽帧',
  analyzing_media: '正在分析素材',
  planning_story: '正在编排镜头',
  analysis_needs_correction: '分析合同待修正，正在等待 Agent 修正后再次校验',
  analysis_complete: '分析完成，可继续构建',
  deciding_hyperframes: '正在判断 HyperFrames',
  designing_hyperframes: '正在设计 HyperFrames',
  rendering_hyperframes: '正在渲染 HyperFrames',
  reviewing_hyperframes: '正在复核 HyperFrames',
  building_project: '正在创建正式项目',
  rendering_preview: '正在生成粗剪',
  generating_fcpxml: '正在生成 FCPXML',
  verifying: '正在完整验证',
  agent_disconnected: 'Agent 已停止，任务未完成',
  completed: '已完成',
  completed_with_warnings: '已完成但有警告',
  failed: '已失败',
  cancelled: '已取消',
});
const HYPERFRAMES_MODES = new Set(['auto', 'disabled', 'force-attempt']);
const LAUNCH_STATUSES = new Set(['launching_codex', 'launching_cursor']);

function isInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function taskRoot(userDataPath) {
  return path.join(path.resolve(String(userDataPath || '')), HANDOFF_DIRNAME);
}

function taskFilePath(userDataPath, taskId) {
  return path.join(taskRoot(userDataPath), `${taskId}.json`);
}

function packageDirForTask(taskPath) {
  const resolved = path.resolve(String(taskPath || ''));
  const taskId = path.basename(resolved, '.json');
  return path.join(path.dirname(resolved), `${taskId}.cursor-package`);
}

function eventFilePath(taskPath) {
  return taskPath.replace(/\.json$/i, '.events.ndjson');
}

function normalizeEngine(engine) {
  const value = String(engine || 'codex');
  if (!AGENT_ENGINES[value]) {
    throw Object.assign(new Error(`不支持的剪辑引擎：${value}`), {
      code: 'INVALID_AGENT_ENGINE',
    });
  }
  return value;
}

async function atomicWriteJson(filePath, value) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const tempPath = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  try {
    await fs.rename(tempPath, resolved);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function validateTaskShape(task, expectedPath = null) {
  if (!task || task.schemaVersion !== HANDOFF_SCHEMA_VERSION) {
    throw Object.assign(new Error('交接任务 schemaVersion 无效。'), { code: 'INVALID_HANDOFF_SCHEMA' });
  }
  if (typeof task.taskId !== 'string' || !/^[a-f0-9-]{36}$/i.test(task.taskId)) {
    throw Object.assign(new Error('交接任务 taskId 无效。'), { code: 'INVALID_HANDOFF_TASK_ID' });
  }
  if (!STATUS_SET.has(task.status) || task.stage !== task.status) {
    throw Object.assign(new Error('交接任务状态或阶段无效。'), { code: 'INVALID_HANDOFF_STATUS' });
  }
  if (!path.isAbsolute(task.sourceDirectory) || !path.isAbsolute(task.sourceDirectoryRealPath)) {
    throw Object.assign(new Error('交接任务素材路径必须为绝对路径。'), { code: 'INVALID_HANDOFF_SOURCE' });
  }
  if (!HYPERFRAMES_MODES.has(task.hyperframesMode)) {
    throw Object.assign(new Error('交接任务 HyperFrames 模式无效。'), { code: 'INVALID_HYPERFRAMES_MODE' });
  }
  if (task.engine != null && !AGENT_ENGINES[task.engine]) {
    throw Object.assign(new Error('交接任务剪辑引擎无效。'), { code: 'INVALID_AGENT_ENGINE' });
  }
  if (expectedPath) {
    const resolved = path.resolve(expectedPath);
    const expectedName = `${task.taskId}.json`;
    if (path.basename(resolved) !== expectedName || path.basename(path.dirname(resolved)) !== HANDOFF_DIRNAME) {
      throw Object.assign(new Error('交接任务文件位置与 taskId 不匹配。'), {
        code: 'UNSAFE_HANDOFF_TASK_PATH',
      });
    }
    if (task.taskFilePath && path.resolve(task.taskFilePath) !== resolved) {
      throw Object.assign(new Error('交接任务记录的文件位置不一致。'), {
        code: 'UNSAFE_HANDOFF_TASK_PATH',
      });
    }
  }
  return task;
}

async function readHandoffTask(taskPath) {
  const resolved = path.resolve(String(taskPath || ''));
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(resolved, 'utf8'));
  } catch (error) {
    throw Object.assign(new Error(`无法读取交接任务：${error.message}`), {
      code: 'HANDOFF_TASK_CORRUPT',
    });
  }
  return hydrateAttempts(validateTaskShape(parsed, resolved));
}

async function appendEvent(taskPath, event) {
  const line = `${JSON.stringify(event)}\n`;
  await fs.appendFile(eventFilePath(taskPath), line, { encoding: 'utf8', flag: 'a' });
}

async function readTaskEvents(taskPath) {
  const text = await fs.readFile(eventFilePath(taskPath), 'utf8').catch(() => '');
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event.at === 'string') events.push(event);
    } catch {
      // A truncated final line is ignored; the task snapshot remains authoritative.
    }
  }
  return events.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

function buildCodexPrompt(input) {
  return buildCompactPromptFor(input);
}

function buildCursorAgentPrompt(input) {
  return buildCompactPromptFor(input);
}

function buildCompactPromptFor(input) {
  const {
    buildCompactAgentPrompt,
    skillPathFor,
    taskManifestPathFor,
    normalizeExtraRequirements,
  } = require('./agent-prompt-builder');
  const extraRequirements = normalizeExtraRequirements(input.extraRequirements);
  const skillPath = skillPathFor(input.appWorkspace);
  const taskManifestPath = input.taskManifestPath || taskManifestPathFor(input.taskFilePath);
  return buildCompactAgentPrompt({
    taskId: input.taskId,
    attemptId: input.attemptId || input.currentAttempt?.attemptId || null,
    skillPath,
    taskManifestPath,
    extraRequirements,
  });
}

function buildAgentPrompt(engine, input) {
  const resolved = normalizeEngine(engine);
  if (resolved === 'cursor_agent') return buildCursorAgentPrompt(input);
  return buildCodexPrompt(input);
}

function buildCodexDeepLink(prompt, workspacePath) {
  const workspace = path.resolve(String(workspacePath || ''));
  if (!path.isAbsolute(workspace)) throw new Error('Codex 工作目录必须为绝对路径。');
  const url = new URL('codex://threads/new');
  url.searchParams.set('prompt', String(prompt || ''));
  url.searchParams.set('path', workspace);
  if (url.href.length > 32_000) {
    throw Object.assign(new Error('Codex 深链接过长，无法安全打开。'), {
      code: 'CODEX_DEEP_LINK_TOO_LONG',
    });
  }
  return url.href;
}

async function resolveSourceDirectory(pendingRoot, sourceDirectory) {
  const root = path.resolve(String(pendingRoot || ''));
  const candidate = path.resolve(String(sourceDirectory || ''));
  const rootReal = await fs.realpath(root).catch(() => null);
  const candidateReal = await fs.realpath(candidate).catch(() => null);
  if (!rootReal || !candidateReal) {
    throw Object.assign(new Error('待处理素材根目录或一期素材目录不存在。'), {
      code: 'INVALID_HANDOFF_SOURCE',
    });
  }
  const relative = path.relative(rootReal, candidateReal);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || path.dirname(relative) !== '.') {
    throw Object.assign(new Error('只允许交接待处理根目录下的直属一期素材。'), {
      code: 'HANDOFF_SOURCE_OUTSIDE_ROOT',
    });
  }
  const stat = await fs.stat(candidateReal);
  if (!stat.isDirectory()) throw new Error('一期素材路径不是目录。');
  return { sourceDirectory: candidate, sourceDirectoryRealPath: candidateReal };
}

async function createHandoffTask(userDataPath, input) {
  if (!HYPERFRAMES_MODES.has(input.hyperframesMode)) {
    throw Object.assign(new Error('HyperFrames 模式无效。'), { code: 'INVALID_HYPERFRAMES_MODE' });
  }
  const engine = normalizeEngine(input.engine || 'cursor_agent');
  const source = await resolveSourceDirectory(input.pendingRoot, input.sourceDirectory);
  const taskId = crypto.randomUUID();
  const filePath = taskFilePath(userDataPath, taskId);
  const packageDir = packageDirForTask(filePath);
  const now = new Date().toISOString();
  const {
    buildTaskManifest,
    normalizeExtraRequirements,
    skillPathFor,
    taskManifestPathFor,
  } = require('./agent-prompt-builder');
  const extraRequirements = normalizeExtraRequirements(input.extraRequirements);
  const platformMode = input.platformMode === 'main' ? 'main' : 'douyin';
  const kind = input.kind === 'revise' ? 'revise' : 'edit';
  const taskManifestPath = taskManifestPathFor(filePath);
  const attempt = createAttempt({
    engine,
    handoffRef: filePath,
    generation: 1,
    now,
    status: LIFECYCLE.preparing,
  });
  const prompt = buildAgentPrompt(engine, {
    sourceDirectory: source.sourceDirectoryRealPath,
    taskId,
    attemptId: attempt.attemptId,
    taskFilePath: filePath,
    taskManifestPath,
    packageDir,
    hyperframesMode: input.hyperframesMode,
    extraRequirements,
    appWorkspace: input.appWorkspace,
  });
  const deepLink = engine === 'codex' ? buildCodexDeepLink(prompt, input.appWorkspace) : null;
  const task = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    taskId,
    taskFilePath: filePath,
    engine,
    sourceDirectory: source.sourceDirectory,
    sourceDirectoryRealPath: source.sourceDirectoryRealPath,
    sourceSnapshot: input.sourceSnapshot || null,
    sourceSummary: input.sourceSummary || null,
    appWorkspace: path.resolve(input.appWorkspace),
    createdAt: now,
    updatedAt: now,
    launchedAt: null,
    startedAt: null,
    completedAt: null,
    status: 'ready',
    stage: 'ready',
    stageMessage: STAGE_LABELS.ready,
    stageStartedAt: now,
    lastHeartbeatAt: now,
    hyperframesMode: input.hyperframesMode,
    hyperframesDecision: null,
    hyperframesReason: null,
    hyperframesGap: null,
    hyperframesQualityReview: null,
    prompt,
    extraRequirements,
    platformMode,
    kind,
    parentTaskId: input.parentTaskId || null,
    previousProjectPath: input.previousProjectPath || null,
    previousAnalysisPath: input.previousAnalysisPath || null,
    taskManifestPath,
    skillPath: skillPathFor(input.appWorkspace),
    openedInFcpAt: null,
    cursorInject: null,
    cursorSession: null,
    lifecycle: LIFECYCLE.preparing,
    currentAttempt: attempt,
    attempts: [attempt],
    lastActiveStatus: null,
    disconnectReason: null,
    reusableResults: null,
    codexDeepLink: deepLink,
    cursorPackagePath: engine === 'cursor_agent' ? packageDir : null,
    resultProjectPath: null,
    resultProjectId: null,
    artifacts: {},
    verification: null,
    validationIssues: [],
    warnings: [],
    errors: [],
    returnState: { requestedAt: null, acknowledgedAt: null },
    autoOpenFcp: input.autoOpenFcp === true,
    eventHistory: [{ at: now, status: 'ready', message: STAGE_LABELS.ready }],
  };
  validateTaskShape(task, filePath);
  await atomicWriteJson(filePath, task);
  await atomicWriteJson(taskManifestPath, buildTaskManifest(task));
  await appendEvent(filePath, task.eventHistory[0]);
  if (engine === 'cursor_agent') {
    const { writeCursorAgentPackage } = require('./cursor-agent-handoff-service');
    const packageInfo = await writeCursorAgentPackage(task);
    task.cursorPackagePath = packageInfo.packageDir;
    task.artifacts = {
      ...task.artifacts,
      cursorPackagePath: packageInfo.packageDir,
      analysisOutputPath: packageInfo.analysisOutputPath,
    };
    await atomicWriteJson(filePath, task);
  }
  return task;
}

function assertTransition(previous, next, options = {}) {
  if (!STATUS_SET.has(next)) {
    throw Object.assign(new Error(`非法交接状态：${next}`), { code: 'INVALID_HANDOFF_STATUS' });
  }
  if (previous === next) return;
  if (TERMINAL_STATUSES.has(previous)) {
    throw Object.assign(new Error('终态交接任务不能被普通阶段覆盖。'), {
      code: 'HANDOFF_TERMINAL_STATE',
    });
  }
  if (TERMINAL_STATUSES.has(next)) return;
  if (next === 'agent_disconnected') return;
  if (previous === 'agent_disconnected') {
    if (options.revive === true || options.newAttempt === true) return;
    throw Object.assign(new Error(`拒绝交接状态回退：${previous} → ${next}`), {
      code: 'INVALID_HANDOFF_TRANSITION',
    });
  }
  if (previous === 'analysis_needs_correction'
    && ['planning_story', 'analysis_complete', 'analysis_needs_correction'].includes(next)) return;
  if (options.newAttempt === true && LAUNCH_STATUSES.has(next)) return;
  const previousIndex = HANDOFF_STATUSES.indexOf(previous);
  const nextIndex = HANDOFF_STATUSES.indexOf(next);
  if (nextIndex < previousIndex) {
    throw Object.assign(new Error(`拒绝交接状态回退：${previous} → ${next}`), {
      code: 'INVALID_HANDOFF_TRANSITION',
    });
  }
}

async function updateHandoffTask(taskPath, patch = {}) {
  const task = await readHandoffTask(taskPath);
  const nextStatus = patch.status || task.status;
  const hydrated = assertWriteAllowed(task, patch);
  const newAttempt = patch.newAttempt === true;
  const revive = hydrated.status === 'agent_disconnected'
    && nextStatus !== 'agent_disconnected'
    && !TERMINAL_STATUSES.has(nextStatus)
    && !newAttempt;
  assertTransition(hydrated.status, nextStatus, { newAttempt, revive });
  const now = new Date().toISOString();
  const statusChanged = nextStatus !== hydrated.status;
  const allowed = [
    'stageMessage', 'hyperframesDecision', 'hyperframesReason', 'hyperframesGap',
    'hyperframesQualityReview', 'resultProjectPath', 'resultProjectId', 'artifacts',
    'verification', 'warnings', 'errors', 'returnState', 'autoOpenFcp',
    'cursorInject', 'cursorSession', 'openedInFcpAt', 'extraRequirements',
    'disconnectReason', 'lastActiveStatus', 'reusableResults', 'validationIssues',
  ];
  const cleanPatch = {};
  for (const key of allowed) {
    if (Object.hasOwn(patch, key) && patch[key] !== undefined) cleanPatch[key] = patch[key];
  }
  const event = {
    at: now,
    status: nextStatus,
    message: cleanPatch.stageMessage || STAGE_LABELS[nextStatus],
    attemptId: hydrated.currentAttempt?.attemptId || null,
  };
  const nextLifecycle = lifecycleOf(nextStatus);
  const currentAttempt = hydrated.currentAttempt
    ? {
      ...hydrated.currentAttempt,
      lastActivityAt: now,
      status: nextLifecycle,
      engine: hydrated.engine,
      launchAttemptedAt: hydrated.currentAttempt.launchAttemptedAt || (
        LAUNCH_STATUSES.has(nextStatus) ? now : hydrated.currentAttempt.launchAttemptedAt
      ),
      endedAt: (TERMINAL_STATUSES.has(nextStatus) || nextStatus === 'agent_disconnected')
        ? (hydrated.currentAttempt.endedAt || now)
        : null,
      invalidatedAt: nextStatus === 'cancelled'
        ? (hydrated.currentAttempt.invalidatedAt || now)
        : hydrated.currentAttempt.invalidatedAt,
      resultRef: {
        ...(hydrated.currentAttempt.resultRef || {}),
        analysisPath: cleanPatch.artifacts?.analysisPath
          || hydrated.currentAttempt.resultRef?.analysisPath
          || hydrated.artifacts?.analysisPath
          || null,
        manifestPath: cleanPatch.artifacts?.manifestPath
          || hydrated.currentAttempt.resultRef?.manifestPath
          || hydrated.artifacts?.manifestPath
          || null,
        projectPath: cleanPatch.resultProjectPath
          || hydrated.currentAttempt.resultRef?.projectPath
          || hydrated.resultProjectPath
          || null,
      },
    }
    : null;
  const attempts = Array.isArray(hydrated.attempts) ? hydrated.attempts.map((item) => (
    currentAttempt && item.attemptId === currentAttempt.attemptId ? currentAttempt : item
  )) : (currentAttempt ? [currentAttempt] : []);
  const updated = {
    ...hydrated,
    ...cleanPatch,
    validationIssues: nextStatus === 'analysis_complete'
      ? (Object.hasOwn(cleanPatch, 'validationIssues') ? cleanPatch.validationIssues : [])
      : (Object.hasOwn(cleanPatch, 'validationIssues') ? cleanPatch.validationIssues : hydrated.validationIssues || []),
    updatedAt: now,
    lastHeartbeatAt: now,
    status: nextStatus,
    stage: nextStatus,
    stageMessage: event.message,
    stageStartedAt: statusChanged ? now : hydrated.stageStartedAt,
    lifecycle: nextLifecycle,
    currentAttempt,
    attempts,
    lastActiveStatus: nextStatus === 'agent_disconnected'
      ? (cleanPatch.lastActiveStatus || hydrated.status)
      : (nextStatus === 'cancelled' ? hydrated.lastActiveStatus : hydrated.lastActiveStatus),
    startedAt: hydrated.startedAt || (HANDOFF_STATUSES.indexOf(nextStatus)
      >= HANDOFF_STATUSES.indexOf('scanning_media') ? now : null),
    launchedAt: hydrated.launchedAt || (
      LAUNCH_STATUSES.has(nextStatus)
        || HANDOFF_STATUSES.indexOf(nextStatus) >= HANDOFF_STATUSES.indexOf('awaiting_user_send')
        ? now
        : null
    ),
    completedAt: TERMINAL_STATUSES.has(nextStatus) ? (hydrated.completedAt || now) : null,
    cursorSession: (() => {
      const incoming = Object.hasOwn(cleanPatch, 'cursorSession')
        ? cleanPatch.cursorSession
        : hydrated.cursorSession;
      if ((TERMINAL_STATUSES.has(nextStatus) || nextStatus === 'agent_disconnected') && incoming) {
        return {
          ...incoming,
          active: false,
          closedReason: nextStatus,
          closedAt: now,
        };
      }
      return incoming;
    })(),
    eventHistory: [...hydrated.eventHistory, event].slice(-200),
  };
  validateTaskShape(updated, taskPath);
  await atomicWriteJson(taskPath, updated);
  await appendEvent(taskPath, event);
  if (updated.taskManifestPath) {
    try {
      const { buildTaskManifest } = require('./agent-prompt-builder');
      await atomicWriteJson(updated.taskManifestPath, buildTaskManifest(updated));
    } catch {
      // Manifest sync is best-effort; the task snapshot remains authoritative.
    }
  }
  if (updated.engine === 'cursor_agent' && updated.cursorPackagePath) {
    try {
      const { syncPackageStatusPointer } = require('./cursor-agent-handoff-service');
      await syncPackageStatusPointer(updated);
    } catch {
      // Package pointer sync is best-effort; task snapshot remains authoritative.
    }
  }
  return updated;
}

async function heartbeatHandoffTask(taskPath, message = null) {
  const task = await readHandoffTask(taskPath);
  if (TERMINAL_STATUSES.has(task.status) || PARKED_STATUSES.has(task.status)) return task;
  return updateHandoffTask(taskPath, {
    status: task.status,
    stageMessage: message || task.stageMessage,
    attemptId: task.currentAttempt?.attemptId,
  });
}

async function cancelHandoffTask(taskPath) {
  const task = await readHandoffTask(taskPath);
  if (task.status === 'cancelled') return task;
  if (!canCancel(task)) {
    throw Object.assign(new Error('终态任务不能取消。'), { code: 'HANDOFF_TERMINAL_STATE' });
  }
  return updateHandoffTask(taskPath, {
    status: 'cancelled',
    stageMessage: '任务已取消。',
    attemptId: task.currentAttempt?.attemptId,
  });
}

async function markAgentDisconnected(taskPath, reason = 'process_missing') {
  const task = await readHandoffTask(taskPath);
  if (task.status === 'agent_disconnected') return task;
  if (TERMINAL_STATUSES.has(task.status)) return task;
  return updateHandoffTask(taskPath, {
    status: 'agent_disconnected',
    stageMessage: disconnectedCopy(task),
    disconnectReason: reason,
    lastActiveStatus: task.status,
    attemptId: task.currentAttempt?.attemptId,
  });
}

async function startAgentAttempt(taskPath, input = {}) {
  const task = await readHandoffTask(taskPath);
  if (TERMINAL_STATUSES.has(task.status) && task.status !== 'failed') {
    throw Object.assign(new Error('终态任务不能再发起 Agent attempt。'), {
      code: 'HANDOFF_TERMINAL_STATE',
    });
  }
  const engine = normalizeEngine(input.engine || task.engine);
  const now = new Date().toISOString();
  const previous = task.currentAttempt || null;
  const endedPrevious = previous ? {
    ...previous,
    endedAt: previous.endedAt || now,
    invalidatedAt: now,
    // Preserve the old terminal truth for lineage. A recovery attempt must not
    // rewrite a failed attempt as merely disconnected.
    status: previous.status || (previous.status === 'canceled' ? 'canceled' : LIFECYCLE.agent_disconnected),
    failure: task.status === 'failed'
      ? {
        reason: input.reason || 'recovery_after_failure',
        error: (task.errors || [])[0] || null,
      }
      : previous.failure || null,
  } : null;
  const reusable = {
    ...reusableResultsFrom(task),
    ...(input.reusableResults || {}),
  };
  const attempt = createAttempt({
    engine,
    previousAttemptId: previous?.attemptId || null,
    takeoverReason: input.reason || (
      engine === task.engine ? 'resume_after_disconnect' : 'switch_engine'
    ),
    handoffRef: task.taskFilePath,
    resultRef: {
      analysisPath: reusable.analysisPath,
      manifestPath: reusable.manifestPath,
      projectPath: reusable.projectPath,
    },
    generation: Math.max(0, ...(task.attempts || []).map((item) => Number(item.generation) || 0)) + 1,
    now,
    status: LIFECYCLE.handed_off,
  });
  attempt.recoveryReason = input.recoveryReason || (task.status === 'failed' ? input.reason || 'recovery_after_failure' : null);
  attempt.reusedAnalysis = Boolean(reusable.analysisPath && reusable.manifestPath);
  attempt.reusableArtifacts = {
    analysisPath: reusable.analysisPath || null,
    manifestPath: reusable.manifestPath || null,
    cacheDirectory: reusable.cacheDirectory || null,
    projectPath: reusable.projectPath || null,
  };
  const {
    buildTaskManifest,
    normalizeExtraRequirements,
    skillPathFor,
    taskManifestPathFor,
  } = require('./agent-prompt-builder');
  const extraRequirements = normalizeExtraRequirements(
    input.extraRequirements == null || String(input.extraRequirements) === ''
      ? task.extraRequirements
      : input.extraRequirements,
  );
  const taskManifestPath = task.taskManifestPath || taskManifestPathFor(task.taskFilePath);
  const prompt = buildAgentPrompt(engine, {
    sourceDirectory: task.sourceDirectoryRealPath || task.sourceDirectory,
    taskId: task.taskId,
    attemptId: attempt.attemptId,
    taskFilePath: task.taskFilePath,
    taskManifestPath,
    packageDir: packageDirForTask(task.taskFilePath),
    hyperframesMode: task.hyperframesMode,
    extraRequirements,
    appWorkspace: task.appWorkspace,
  });
  const launchStatus = AGENT_ENGINES[engine].launchStatus;
  const attempts = [
    ...(task.attempts || []).filter((item) => item.attemptId !== previous?.attemptId),
    ...(endedPrevious ? [endedPrevious] : []),
    attempt,
  ];
  const event = {
    at: now,
    status: launchStatus,
    message: `${AGENT_ENGINES[engine].label} 接管开始`,
    attemptId: attempt.attemptId,
  };
  const updated = {
    ...task,
    engine,
    extraRequirements,
    prompt,
    taskManifestPath,
    skillPath: skillPathFor(task.appWorkspace),
    codexDeepLink: engine === 'codex' ? buildCodexDeepLink(prompt, task.appWorkspace) : null,
    cursorPackagePath: engine === 'cursor_agent'
      ? (task.cursorPackagePath || packageDirForTask(task.taskFilePath))
      : task.cursorPackagePath,
    cursorInject: null,
    cursorSession: task.cursorSession && (task.cursorSession.windowName || task.cursorSession.fingerprint || task.cursorSession.windowId != null)
      ? {
        ...task.cursorSession,
        active: true,
        taskId: task.taskId,
        attemptId: attempt.attemptId,
        reused: true,
        closedReason: null,
        closedAt: null,
      }
      : null,
    status: launchStatus,
    stage: launchStatus,
    stageMessage: event.message,
    stageStartedAt: now,
    updatedAt: now,
    lastHeartbeatAt: now,
    launchedAt: now,
    completedAt: null,
    lifecycle: LIFECYCLE.handed_off,
    currentAttempt: { ...attempt, launchAttemptedAt: now },
    attempts: attempts.map((item) => (
      item.attemptId === attempt.attemptId ? { ...attempt, launchAttemptedAt: now } : item
    )),
    lastActiveStatus: task.lastActiveStatus || task.status,
    disconnectReason: null,
    reusableResults: reusable,
    validationIssues: [],
    errors: [],
    returnState: { requestedAt: null, acknowledgedAt: null },
    eventHistory: [...(task.eventHistory || []), event].slice(-200),
  };
  validateTaskShape(updated, taskPath);
  await atomicWriteJson(taskPath, updated);
  await atomicWriteJson(taskManifestPath, buildTaskManifest(updated));
  await appendEvent(taskPath, event);
  if (engine === 'cursor_agent') {
    const { writeCursorAgentPackage } = require('./cursor-agent-handoff-service');
    const packageInfo = await writeCursorAgentPackage(updated);
    updated.cursorPackagePath = packageInfo.packageDir;
    updated.artifacts = {
      ...(updated.artifacts || {}),
      cursorPackagePath: packageInfo.packageDir,
      analysisOutputPath: packageInfo.analysisOutputPath || updated.artifacts?.analysisOutputPath,
    };
    await atomicWriteJson(taskPath, updated);
  }
  return updated;
}

async function listHandoffTasks(userDataPath) {
  const root = taskRoot(userDataPath);
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  const tasks = [];
  const corrupt = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/i.test(entry.name)) continue;
    const filePath = path.join(root, entry.name);
    try {
      tasks.push(await readHandoffTask(filePath));
    } catch (error) {
      corrupt.push({ filePath, error: error.message });
    }
  }
  tasks.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  return { rootPath: root, tasks, corrupt };
}

async function assertUserDataTask(userDataPath, requestedPath) {
  const root = await fs.realpath(taskRoot(userDataPath));
  const candidate = path.resolve(String(requestedPath || ''));
  if (!isInside(root, candidate) || path.dirname(candidate) !== root) {
    throw Object.assign(new Error('拒绝访问 handoffs 目录之外的任务文件。'), {
      code: 'UNSAFE_HANDOFF_TASK_PATH',
    });
  }
  return readHandoffTask(candidate);
}

async function loadHandoffSettings(userDataPath) {
  const filePath = path.join(path.resolve(String(userDataPath || '')), SETTINGS_FILENAME);
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8').catch(() => 'null'));
  const engine = raw?.defaultEngine === 'codex' ? 'codex' : 'cursor_agent';
  return {
    schemaVersion: 1,
    autoOpenFcp: raw?.schemaVersion === 1 && raw.autoOpenFcp === true,
    defaultEngine: engine,
    defaultPlatformMode: raw?.defaultPlatformMode === 'main' ? 'main' : 'douyin',
  };
}

async function saveHandoffSettings(userDataPath, input) {
  const current = await loadHandoffSettings(userDataPath);
  const settings = {
    schemaVersion: 1,
    autoOpenFcp: input?.autoOpenFcp == null ? current.autoOpenFcp : input.autoOpenFcp === true,
    defaultEngine: input?.defaultEngine === 'codex' ? 'codex' : (input?.defaultEngine === 'cursor_agent' ? 'cursor_agent' : current.defaultEngine),
    defaultPlatformMode: input?.defaultPlatformMode === 'main' ? 'main' : (input?.defaultPlatformMode === 'douyin' ? 'douyin' : current.defaultPlatformMode),
  };
  await atomicWriteJson(path.join(path.resolve(userDataPath), SETTINGS_FILENAME), settings);
  return settings;
}

module.exports = {
  AGENT_ENGINES,
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_STATUSES,
  HYPERFRAMES_MODES,
  LAUNCH_STATUSES,
  PARKED_STATUSES,
  STAGE_LABELS,
  TERMINAL_STATUSES,
  assertTransition,
  assertUserDataTask,
  atomicWriteJson,
  buildAgentPrompt,
  buildCodexDeepLink,
  buildCodexPrompt,
  buildCursorAgentPrompt,
  cancelHandoffTask,
  createHandoffTask,
  eventFilePath,
  heartbeatHandoffTask,
  listHandoffTasks,
  loadHandoffSettings,
  markAgentDisconnected,
  normalizeEngine,
  packageDirForTask,
  readHandoffTask,
  readTaskEvents,
  saveHandoffSettings,
  startAgentAttempt,
  taskFilePath,
  taskRoot,
  updateHandoffTask,
  validateTaskShape,
};
