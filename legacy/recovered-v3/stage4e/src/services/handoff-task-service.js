'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const HANDOFF_SCHEMA_VERSION = 1;
const HANDOFF_DIRNAME = 'handoffs';
const SETTINGS_FILENAME = 'handoff-settings.json';
const TERMINAL_STATUSES = new Set(['completed', 'completed_with_warnings', 'failed', 'cancelled']);
const HANDOFF_STATUSES = Object.freeze([
  'draft',
  'ready',
  'launching_codex',
  'awaiting_user_send',
  'scanning_media',
  'extracting_metadata',
  'extracting_frames',
  'analyzing_media',
  'planning_story',
  'deciding_hyperframes',
  'designing_hyperframes',
  'rendering_hyperframes',
  'reviewing_hyperframes',
  'building_project',
  'rendering_preview',
  'generating_fcpxml',
  'verifying',
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
  awaiting_user_send: '等待在 Codex 中发送',
  scanning_media: '正在扫描素材',
  extracting_metadata: '正在读取素材信息',
  extracting_frames: '正在抽帧',
  analyzing_media: '正在分析素材',
  planning_story: '正在编排镜头',
  deciding_hyperframes: '正在判断 HyperFrames',
  designing_hyperframes: '正在设计 HyperFrames',
  rendering_hyperframes: '正在渲染 HyperFrames',
  reviewing_hyperframes: '正在复核 HyperFrames',
  building_project: '正在创建正式项目',
  rendering_preview: '正在生成粗剪',
  generating_fcpxml: '正在生成 FCPXML',
  verifying: '正在完整验证',
  completed: '已完成',
  completed_with_warnings: '已完成但有警告',
  failed: '已失败',
  cancelled: '已取消',
});
const HYPERFRAMES_MODES = new Set(['auto', 'disabled', 'force-attempt']);

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

function eventFilePath(taskPath) {
  return taskPath.replace(/\.json$/i, '.events.ndjson');
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
  return validateTaskShape(parsed, resolved);
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
  const mode = input.hyperframesMode;
  return `使用 $video-cut-planner，处理这期素材：

${input.sourceDirectory}

本次由视频剪辑编排器 v3 发起。
交接任务 ID：
${input.taskId}

交接任务状态文件：
${input.taskFilePath}

HyperFrames 模式：
${mode}

请严格使用现有共享 service 和 Video Skill 完成：素材扫描、ffprobe 元数据、抽帧、场景变化抽帧、语义分析、主题与标题、采用/候选/淘汰判断、有效区间、无口播镜头编排、连贯度检查、少量轻字幕 Marker、FCP 原生可编辑 Title、按规则判断 HyperFrames、正式 v3 项目、粗剪预览、独立素材 FCPXML 和完整验证。

必须把 --handoff-task ${JSON.stringify(input.taskFilePath)} 传给支持该参数的 video-skill 命令，并在语义分析、镜头编排、HyperFrames 判断/设计/复核等 Codex 决策节点使用 handoff-update 持续更新阶段、心跳、决策依据、表达缺口和质量复核。先仅用真实素材形成初步时间线，再决定 HyperFrames。auto 仅在动画明显优于普通剪辑、轻字幕或转场时启用；disabled 禁止生成；force-attempt 必须认真尝试但质量不足必须放弃。

不得修改、移动、重命名或删除原始素材；不得覆盖非空正式项目目录；不得省略验证；不得把粗剪预览写入 FCPXML；FCPXML 必须引用正式项目内的独立素材；正式时间线规格与预览规格必须分离；生成结果必须可由结果中心读取。

build 完成后必须实际观看粗剪；启用 HyperFrames 时还要观看独立动画，写入 reviewing_hyperframes 和质量复核，必要时返工或放弃。确认正式结果后执行 handoff-complete，把正式项目路径、镜头数、时长、Marker、FCP Title、HyperFrames、粗剪、FCPXML 和验证结果写入终态；警告或失败也必须如实记录。无论成功、警告或失败，最后执行 handoff-return 触发返回视频剪辑编排器 v3。`;
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
  const source = await resolveSourceDirectory(input.pendingRoot, input.sourceDirectory);
  const taskId = crypto.randomUUID();
  const filePath = taskFilePath(userDataPath, taskId);
  const now = new Date().toISOString();
  const prompt = buildCodexPrompt({
    sourceDirectory: source.sourceDirectoryRealPath,
    taskId,
    taskFilePath: filePath,
    hyperframesMode: input.hyperframesMode,
  });
  const deepLink = buildCodexDeepLink(prompt, input.appWorkspace);
  const task = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    taskId,
    taskFilePath: filePath,
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
    codexDeepLink: deepLink,
    resultProjectPath: null,
    resultProjectId: null,
    artifacts: {},
    verification: null,
    warnings: [],
    errors: [],
    returnState: { requestedAt: null, acknowledgedAt: null },
    autoOpenFcp: input.autoOpenFcp === true,
    eventHistory: [{ at: now, status: 'ready', message: STAGE_LABELS.ready }],
  };
  validateTaskShape(task, filePath);
  await atomicWriteJson(filePath, task);
  await appendEvent(filePath, task.eventHistory[0]);
  return task;
}

function assertTransition(previous, next) {
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
  assertTransition(task.status, nextStatus);
  const now = new Date().toISOString();
  const statusChanged = nextStatus !== task.status;
  const allowed = [
    'stageMessage', 'hyperframesDecision', 'hyperframesReason', 'hyperframesGap',
    'hyperframesQualityReview', 'resultProjectPath', 'resultProjectId', 'artifacts',
    'verification', 'warnings', 'errors', 'returnState', 'autoOpenFcp',
  ];
  const cleanPatch = {};
  for (const key of allowed) {
    if (Object.hasOwn(patch, key) && patch[key] !== undefined) cleanPatch[key] = patch[key];
  }
  const event = {
    at: now,
    status: nextStatus,
    message: cleanPatch.stageMessage || STAGE_LABELS[nextStatus],
  };
  const updated = {
    ...task,
    ...cleanPatch,
    updatedAt: now,
    lastHeartbeatAt: now,
    status: nextStatus,
    stage: nextStatus,
    stageMessage: event.message,
    stageStartedAt: statusChanged ? now : task.stageStartedAt,
    startedAt: task.startedAt || (HANDOFF_STATUSES.indexOf(nextStatus)
      >= HANDOFF_STATUSES.indexOf('scanning_media') ? now : null),
    launchedAt: task.launchedAt || (HANDOFF_STATUSES.indexOf(nextStatus)
      >= HANDOFF_STATUSES.indexOf('launching_codex') ? now : null),
    completedAt: TERMINAL_STATUSES.has(nextStatus) ? (task.completedAt || now) : null,
    eventHistory: [...task.eventHistory, event].slice(-200),
  };
  validateTaskShape(updated, taskPath);
  await atomicWriteJson(taskPath, updated);
  await appendEvent(taskPath, event);
  return updated;
}

async function heartbeatHandoffTask(taskPath, message = null) {
  const task = await readHandoffTask(taskPath);
  if (TERMINAL_STATUSES.has(task.status)) return task;
  return updateHandoffTask(taskPath, {
    status: task.status,
    stageMessage: message || task.stageMessage,
  });
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
  const filePath = path.join(path.resolve(userDataPath), SETTINGS_FILENAME);
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8').catch(() => 'null'));
  return {
    schemaVersion: 1,
    autoOpenFcp: raw?.schemaVersion === 1 && raw.autoOpenFcp === true,
  };
}

async function saveHandoffSettings(userDataPath, input) {
  const settings = { schemaVersion: 1, autoOpenFcp: input?.autoOpenFcp === true };
  await atomicWriteJson(path.join(path.resolve(userDataPath), SETTINGS_FILENAME), settings);
  return settings;
}

module.exports = {
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_STATUSES,
  HYPERFRAMES_MODES,
  STAGE_LABELS,
  TERMINAL_STATUSES,
  assertTransition,
  assertUserDataTask,
  atomicWriteJson,
  buildCodexDeepLink,
  buildCodexPrompt,
  createHandoffTask,
  eventFilePath,
  heartbeatHandoffTask,
  listHandoffTasks,
  loadHandoffSettings,
  readHandoffTask,
  readTaskEvents,
  saveHandoffSettings,
  taskRoot,
  updateHandoffTask,
  validateTaskShape,
};
