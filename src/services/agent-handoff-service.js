'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { WORKSPACE_ROOT, DEFAULT_PROJECT_ROOT } = require('../constants');
const {
  AGENT_ENGINES,
  STAGE_LABELS,
  TERMINAL_STATUSES,
  atomicWriteJson,
  buildCodexAgentPrompt,
  listHandoffTasks,
  packageDirForTask,
  readHandoffTask,
  updateHandoffTask,
} = require('./handoff-task-service');
const { lifecycleOf, LIFECYCLE } = require('./agent-lifecycle-service');

const PACKAGE_SWEEP_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PACKAGE_RETENTION = Object.freeze({
  retain: 'retain',
  retain_recovery: 'retain_recovery',
  retain_diagnostics: 'retain_diagnostics',
  sweepable: 'sweepable',
});
const { validateAnalysisFile, buildCodexVideoProject, verifyCodexVideoProject } = require('./codex-video-service');
const { readCodexProjectResult } = require('./codex-project-result-service');

const EXPECTED_ANALYSIS_ARTIFACTS = Object.freeze([
  {
    id: 'manifest',
    label: '素材清单 manifest.json',
    required: true,
    field: 'manifestPath',
  },
  {
    id: 'analysis',
    label: '分析结果 analysis.json（符合 codex-video-analysis 合同）',
    required: true,
    field: 'analysisPath',
  },
  {
    id: 'analysisRequest',
    label: '分析请求 analysis-request.json',
    required: false,
    field: 'analysisRequestPath',
  },
]);

function engineLabel(engine) {
  return AGENT_ENGINES[engine]?.label || engine || 'Agent';
}

function agentWorkspaceFor(task) {
  return path.resolve(task?.appWorkspace || WORKSPACE_ROOT);
}

const TASK_WINDOW_TITLE = '剪渡 Codex 任务';

function isReusableCodexSession(session, { attemptId, taskId } = {}) {
  if (!session || session.active !== true) return false;
  if (taskId && session.taskId && session.taskId !== taskId) return false;
  if (attemptId && session.attemptId && session.attemptId !== attemptId) return false;
  return true;
}

function agentWindowsDirFor(task) {
  const packageDir = path.resolve(task.agentPackagePath || packageDirForTask(task.taskFilePath));
  return path.join(path.dirname(packageDir), 'agent-windows');
}

function agentWindowWorkspacePath(task) {
  const attemptId = task.currentAttempt?.attemptId || task.attemptId || 'task';
  return path.join(agentWindowsDirFor(task), `agent-window-${attemptId}.code-workspace`);
}

function buildCodexWindowWorkspace(task) {
  const workspace = agentWorkspaceFor(task);
  const title = path.basename(workspace);
  return {
    folders: [
      {
        path: workspace,
        name: title,
      },
    ],
    settings: {
      'window.title': TASK_WINDOW_TITLE,
      'workbench.startupEditor': 'none',
    },
  };
}

async function writeCodexWindowWorkspace(task) {
  const filePath = agentWindowWorkspacePath(task);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(buildCodexWindowWorkspace(task), null, 2)}\n`, 'utf8');
  return filePath;
}

function deactivateCodexSession(session, reason = 'inactive') {
  if (!session) return null;
  return {
    ...session,
    active: false,
    closedReason: reason,
    closedAt: new Date().toISOString(),
  };
}

function packageRetentionOf(task) {
  const lifecycle = lifecycleOf(task);
  if (lifecycle === LIFECYCLE.completed || lifecycle === LIFECYCLE.canceled) {
    return PACKAGE_RETENTION.sweepable;
  }
  if (lifecycle === LIFECYCLE.failed) return PACKAGE_RETENTION.retain_diagnostics;
  if (lifecycle === LIFECYCLE.agent_disconnected) return PACKAGE_RETENTION.retain_recovery;
  return PACKAGE_RETENTION.retain;
}

function buildCodexLaunchPlan(task) {
  const packageDir = path.resolve(task.agentPackagePath || packageDirForTask(task.taskFilePath));
  const workspace = agentWorkspaceFor(task);
  const attemptId = task.currentAttempt?.attemptId || null;
  const session = task.agentSession || null;
  const reuseSession = isReusableCodexSession(session, {
    attemptId,
    taskId: task.taskId,
  });
  const windowWorkspacePath = agentWindowWorkspacePath(task);
  return {
    engine: 'codex',
    workspace,
    packageDir,
    windowWorkspacePath,
    promptPath: path.join(packageDir, 'prompt.md'),
    taskFilePath: task.taskFilePath,
    taskId: task.taskId,
    attemptId,
    sessionKey: `${task.taskId}:${attemptId || ''}`,
    windowTitleNeedle: TASK_WINDOW_TITLE,
    openArgs: ['--new-window', windowWorkspacePath],
    reuseSession,
    session: reuseSession ? session : null,
    clipboardText: task.prompt,
    restoreClipboard: true,
    userInstruction: 'Codex 已打开项目窗口，App 会把正式提示词放入 Agent 输入框。',
  };
}

async function pathExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(path.resolve(filePath));
    return true;
  } catch {
    return false;
  }
}

async function writeCodexAgentPackage(task) {
  const packageDir = packageDirForTask(task.taskFilePath);
  await fs.mkdir(packageDir, { recursive: true });
  const analysisOutputPath = path.join(packageDir, 'analysis.json');
  const paths = {
    taskId: task.taskId,
    engine: 'codex',
    sourceDirectory: task.sourceDirectory,
    sourceDirectoryRealPath: task.sourceDirectoryRealPath,
    taskFilePath: task.taskFilePath,
    packageDir,
    appWorkspace: task.appWorkspace,
    projectRoot: DEFAULT_PROJECT_ROOT,
    analysisOutputPath,
    expectedAnalysisContract: 'schemas/codex-video-analysis.schema.json',
    expectedPlatformVariantContract: 'schemas/douyin-platform-variant.schema.json',
    videoSkillCli: path.join(task.appWorkspace, 'bin/jiandu.js'),
  };
  const expectedArtifacts = {
    schemaVersion: 1,
    items: EXPECTED_ANALYSIS_ARTIFACTS.map((item) => ({
      ...item,
      suggestedPath: item.id === 'analysis' ? analysisOutputPath : null,
    })),
    afterAppBuild: [
      '正式项目目录',
      'Application Support 内部分析、素材清单和状态记录',
      '按需生成的成片 MP4',
      'FCPXML',
      '结果中心可读结构化结果',
    ],
  };
  const checklist = [
    '# Codex Agent 剪辑任务清单',
    '',
    `- 引擎：Codex Agent`,
    `- 任务 ID：\`${task.taskId}\``,
    `- 素材目录：\`${task.sourceDirectoryRealPath}\``,
    `- 状态文件：\`${task.taskFilePath}\``,
    `- 交接包：\`${packageDir}\``,
    '',
    '## 必做步骤',
    '',
    '1. 在 Codex Agent 中读取任务清单绝对路径并启动正式任务提示词（App 不会打开 prompt.md 或交接包窗口）',
    '2. 使用 `video-skill prepare` 扫描素材、元数据与抽帧',
    '3. 按现有分析数据合同写出 `analysis.json`，并包含独立的 `platformVariants.douyin` 规划',
    '4. 使用 `validate-analysis` 校验',
    '5. 将交接状态更新为 `analysis_complete` 并执行 `handoff-return`',
    '6. 回到「剪渡」继续 build / verify / 结果交接 / 打开 FCP',
    '',
    '## 禁止事项',
    '',
    '- 不修改来源素材',
    '- 不覆盖已有成功正式项目',
    '- 不改写 `editorial-review.json` 与人工字幕',
    '- 不另建与现有分析合同重复的数据格式',
    '- 不设默认成片时长上限，不跳过可用视觉素材，视频原声默认保留，应有轻字幕不得遗漏',
    '',
  ].join('\n');
  const recovery = [
    '# 错误与恢复',
    '',
    '- App 或 Codex 中途关闭后，重新打开 App 即可继续；交接包仅作内部恢复，不会作为 Codex 工作区打开。',
    '- 状态为 `awaiting_user_send`：重新复制提示词，在 Codex Agent 中启动。',
    '- 状态为 `analysis_complete`：App 会自动继续构建与验证；不要重复分析覆盖成功结果。',
    '- 状态为 `failed`：不得显示为成功；修复后可新建独立任务，不得原地覆盖成功项目。',
    '- 产物不完整：检查交接包与 prepare 缓存中的 manifest/analysis 是否齐全且通过 validate-analysis。',
    '- 重复读取已完成结果不得再次覆盖；终态任务不可被普通阶段回写。',
    '',
  ].join('\n');

  await Promise.all([
    fs.writeFile(path.join(packageDir, 'TASK.md'), `${checklist}\n`, 'utf8'),
    fs.writeFile(path.join(packageDir, 'prompt.md'), `${task.prompt}\n`, 'utf8'),
    fs.writeFile(path.join(packageDir, 'RECOVERY.md'), `${recovery}\n`, 'utf8'),
    atomicWriteJson(path.join(packageDir, 'paths.json'), paths),
    atomicWriteJson(path.join(packageDir, 'expected-artifacts.json'), expectedArtifacts),
    atomicWriteJson(path.join(packageDir, 'TASK.json'), require('./agent-prompt-builder').buildTaskManifest(task)),
    atomicWriteJson(path.join(packageDir, 'status.json'), {
      schemaVersion: 1,
      taskId: task.taskId,
      taskFilePath: task.taskFilePath,
      status: task.status,
      stage: task.stage,
      stageMessage: task.stageMessage,
      engine: 'codex',
      updatedAt: task.updatedAt,
      note: '权威状态以 taskFilePath 指向的交接任务快照为准；本文件仅便于 Agent 快速定位。',
    }),
  ]);
  const windowWorkspacePath = await writeCodexWindowWorkspace({
    ...task,
    agentPackagePath: packageDir,
  });

  return {
    packageDir,
    windowWorkspacePath,
    promptPath: path.join(packageDir, 'prompt.md'),
    pathsPath: path.join(packageDir, 'paths.json'),
    expectedArtifactsPath: path.join(packageDir, 'expected-artifacts.json'),
    analysisOutputPath,
    checklistPath: path.join(packageDir, 'TASK.md'),
    recoveryPath: path.join(packageDir, 'RECOVERY.md'),
    statusPointerPath: path.join(packageDir, 'status.json'),
  };
}

async function syncPackageStatusPointer(task) {
  if (!task.agentPackagePath) return null;
  const statusPath = path.join(task.agentPackagePath, 'status.json');
  await atomicWriteJson(statusPath, {
    schemaVersion: 1,
    taskId: task.taskId,
    taskFilePath: task.taskFilePath,
    status: task.status,
    stage: task.stage,
    stageMessage: task.stageMessage,
    engine: task.engine || 'codex',
    updatedAt: task.updatedAt,
    artifacts: task.artifacts || {},
    errors: task.errors || [],
    validationIssues: task.validationIssues || [],
    warnings: task.warnings || [],
  });
  return statusPath;
}

function classifyAgentHandoffState(task) {
  const engine = task.engine || 'codex';
  const status = task.status;
  const artifacts = task.artifacts || {};
  const hasAnalysisPaths = Boolean(artifacts.manifestPath && artifacts.analysisPath);
  const hasErrors = Array.isArray(task.errors) && task.errors.length > 0;

  if (status === 'analysis_needs_correction') {
    return {
      state: 'analysis_needs_correction',
      label: STAGE_LABELS.analysis_needs_correction,
      canContinueBuild: false,
      canRecover: true,
      recoverable: true,
      canCancel: true,
      validationIssues: task.validationIssues || [],
      engine,
    };
  }

  if (status === 'failed') {
    return {
      state: 'analysis_failed',
      label: '分析失败',
      canContinueBuild: false,
      canRecover: true,
      recoverable: true,
      engine,
    };
  }
  if (status === 'cancelled') {
    return {
      state: 'cancelled',
      label: '已取消',
      canContinueBuild: false,
      canRecover: false,
      recoverable: false,
      engine,
    };
  }
  if (status === 'agent_disconnected') {
    return {
      state: 'agent_disconnected',
      label: STAGE_LABELS.agent_disconnected || 'Agent 已停止，任务未完成',
      canContinueBuild: false,
      canRecover: true,
      recoverable: true,
      canCancel: true,
      engine,
    };
  }
  if (TERMINAL_STATUSES.has(status) && status !== 'failed' && status !== 'cancelled') {
    return {
      state: 'completed',
      label: STAGE_LABELS[status] || status,
      canContinueBuild: false,
      canRecover: false,
      recoverable: false,
      engine,
      success: status === 'completed' || status === 'completed_with_warnings',
    };
  }
  if (status === 'analysis_complete') {
    if (!hasAnalysisPaths) {
      return {
        state: 'artifacts_incomplete',
        label: '分析完成但产物不完整',
        canContinueBuild: false,
        canRecover: true,
        recoverable: true,
        engine,
      };
    }
    return {
      state: 'analysis_complete',
      label: '分析完成，可继续构建',
      canContinueBuild: true,
      canRecover: true,
      recoverable: true,
      engine,
    };
  }
  if (['draft', 'ready', 'launching_codex', 'awaiting_user_send'].includes(status)) {
    return {
      state: status === 'awaiting_user_send' || status === 'ready' || status === 'draft'
        ? 'awaiting_agent'
        : 'launching',
      label: status === 'awaiting_user_send'
        ? `等待在 ${engineLabel(engine)} 中启动`
        : STAGE_LABELS[status] || status,
      canContinueBuild: false,
      canRecover: true,
      recoverable: true,
      engine,
    };
  }
  if (hasErrors && ['analyzing_media', 'planning_story', 'extracting_frames'].includes(status)) {
    return {
      state: 'analysis_failed',
      label: '分析过程出现错误',
      canContinueBuild: false,
      canRecover: true,
      recoverable: true,
      engine,
    };
  }
  return {
    state: 'agent_running',
    label: STAGE_LABELS[status] || 'Agent 执行中',
    canContinueBuild: false,
    canRecover: true,
    recoverable: true,
    engine,
  };
}

async function inspectAnalysisArtifacts(task) {
  const artifacts = task.artifacts || {};
  const checks = [];
  for (const item of EXPECTED_ANALYSIS_ARTIFACTS) {
    const filePath = artifacts[item.field] || null;
    const exists = await pathExists(filePath);
    checks.push({
      id: item.id,
      label: item.label,
      required: item.required,
      path: filePath,
      exists,
      ok: item.required ? exists : true,
    });
  }
  const incomplete = checks.some((item) => !item.ok);
  let validation = null;
  if (!incomplete && artifacts.manifestPath && artifacts.analysisPath) {
    try {
      const validated = await validateAnalysisFile(artifacts.manifestPath, artifacts.analysisPath);
      validation = { ok: true, ...validated };
    } catch (error) {
      validation = {
        ok: false,
        error: {
          code: error.code || 'ANALYSIS_VALIDATION_FAILED',
          message: error.message,
        },
      };
    }
  }
  return {
    incomplete: incomplete || validation?.ok === false,
    checks,
    validation,
    canContinueBuild: !incomplete && validation?.ok === true,
  };
}

async function markAnalysisComplete(taskPath, input = {}) {
  const task = await readHandoffTask(taskPath);
  const manifestPath = path.resolve(String(input.manifestPath || task.artifacts?.manifestPath || ''));
  const analysisPath = path.resolve(String(input.analysisPath || task.artifacts?.analysisPath || ''));
  if (!manifestPath || !analysisPath) {
    throw Object.assign(new Error('分析完成需要提供 manifest 与 analysis 绝对路径。'), {
      code: 'ARTIFACTS_INCOMPLETE',
    });
  }
  const validated = await validateAnalysisFile(manifestPath, analysisPath);
  const updated = await updateHandoffTask(taskPath, {
    status: 'analysis_complete',
    attemptId: task.currentAttempt?.attemptId,
    stageMessage: input.stageMessage
      || 'Codex Agent 分析已通过协议校验，等待 App 继续构建与验证。',
    artifacts: {
      ...(task.artifacts || {}),
      manifestPath: validated.manifestPath,
      analysisPath: validated.analysisPath,
      analysisRequestPath: input.analysisRequestPath || task.artifacts?.analysisRequestPath || null,
      cacheDirectory: input.cacheDirectory || task.artifacts?.cacheDirectory || null,
    },
    hyperframesDecision: task.hyperframesDecision || 'disabled',
    hyperframesReason: task.hyperframesReason
      || '默认由 App 继续构建；HyperFrames 保持关闭，除非后续显式启用。',
    hyperframesGap: task.hyperframesGap || '无',
  });
  await syncPackageStatusPointer(updated);
  return updated;
}

async function continueBuildFromAnalysis(taskPath, options = {}) {
  const task = await readHandoffTask(taskPath);
  const attemptId = task.currentAttempt?.attemptId;
  if (TERMINAL_STATUSES.has(task.status)) {
    throw Object.assign(new Error('终态任务不能再次构建；请直接查看已有结果。'), {
      code: 'HANDOFF_TERMINAL_STATE',
    });
  }
  if (task.status !== 'analysis_complete') {
    throw Object.assign(new Error('只有分析完成的任务可以由 App 继续构建。'), {
      code: 'ANALYSIS_NOT_READY',
    });
  }
  if (task.resultProjectPath) {
    throw Object.assign(new Error('该任务已关联正式项目，拒绝重复覆盖构建。'), {
      code: 'PROJECT_ALREADY_EXISTS',
    });
  }

  const inspection = await inspectAnalysisArtifacts(task);
  if (inspection.incomplete || !inspection.validation || inspection.validation.ok === false) {
    const failed = await updateHandoffTask(taskPath, {
      status: 'analysis_complete',
      attemptId: task.currentAttempt?.attemptId,
      stageMessage: '分析产物不完整或未通过协议校验，不能继续构建。',
      errors: [{
        code: 'ARTIFACTS_INCOMPLETE',
        message: inspection.validation?.error?.message || 'manifest/analysis 缺失或无效',
        at: new Date().toISOString(),
      }],
    });
    await syncPackageStatusPointer(failed);
    throw Object.assign(new Error('分析产物不完整或无效，不能继续构建。'), {
      code: 'ARTIFACTS_INCOMPLETE',
      inspection,
    });
  }

  const projectRoot = path.resolve(options.projectRoot || DEFAULT_PROJECT_ROOT);
  const requestedName = options.projectName
    || task.sourceSummary?.name
    || path.basename(task.sourceDirectoryRealPath);
  // Match buildCodexVideoProject's safeFilename collapse so uniqueness checks the real target name.
  const sanitizedRequested = String(requestedName || '')
    .trim()
    .replace(/[\\/:*?"<>|\0]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 100)
    .trim() || '未命名项目';
  let existingNames = [];
  try {
    existingNames = (await fs.readdir(projectRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    existingNames = [];
  }
  const projectName = uniqueProjectName(sanitizedRequested, existingNames);
  const targetPath = path.join(projectRoot, projectName);
  if (await pathExists(targetPath)) {
    throw Object.assign(new Error('正式项目目录已存在，为保护成功结果不会原地覆盖。请改用新项目名。'), {
      code: 'PROJECT_ALREADY_EXISTS',
      projectPath: targetPath,
    });
  }

  let building = await updateHandoffTask(taskPath, {
    status: 'building_project',
    attemptId: task.currentAttempt?.attemptId,
    stageMessage: 'App 正在基于 Codex Agent 分析结果创建正式项目。',
  });
  await syncPackageStatusPointer(building);

  try {
    const built = await buildCodexVideoProject({
      manifestPath: task.artifacts.manifestPath,
      analysisPath: task.artifacts.analysisPath,
      projectRoot,
      projectName,
      internalRoot: path.join(path.dirname(path.dirname(task.taskFilePath)), 'projects', projectName),
      generatePreview: false,
      timelineFormat: inspection.validation.formats?.timeline,
      previewFormat: inspection.validation.formats?.preview,
      hyperframes: { enabled: false },
      onStage: async (status, message) => {
        building = await updateHandoffTask(taskPath, {
          status: status === 'verifying' ? 'verifying' : (
            status === 'rendering_preview' ? 'rendering_preview' : (
              status === 'generating_fcpxml' ? 'generating_fcpxml' : 'building_project'
            )
          ),
          attemptId,
          stageMessage: message || STAGE_LABELS[status] || status,
        });
        await syncPackageStatusPointer(building);
      },
    });

    await updateHandoffTask(taskPath, {
      status: 'verifying',
      attemptId,
      stageMessage: '正式项目已生成，正在完整验证。',
      resultProjectPath: built.projectPath,
      resultProjectId: built.project?.projectId || built.project?.projectName || projectName,
      artifacts: {
        ...task.artifacts,
        previewPath: built.artifacts.previewPath || null,
        fcpxmlPath: built.artifacts.fcpxmlPath,
        summaryPath: built.artifacts.summaryPath,
      },
    });

    const verification = await verifyCodexVideoProject(built.projectPath);
    if (!verification.ok) {
      const failed = await updateHandoffTask(taskPath, {
        status: 'failed',
        attemptId,
        stageMessage: '构建后的项目未通过完整性验证。',
        resultProjectPath: built.projectPath,
        verification,
        errors: [{
          code: 'PROJECT_VERIFICATION_FAILED',
          message: (verification.errors || []).join('；') || '验证失败',
          at: new Date().toISOString(),
        }],
      });
      await syncPackageStatusPointer(failed);
      return failed;
    }

    const result = await readCodexProjectResult(built.projectPath);
    const warnings = [...new Set([
      ...(task.warnings || []),
      ...(verification.warnings || []),
      ...(result.verification.warnings || []),
    ])];
    const status = warnings.length ? 'completed_with_warnings' : 'completed';
    const completed = await updateHandoffTask(taskPath, {
      status,
      attemptId,
      stageMessage: warnings.length
        ? 'Codex Agent 分析后由 App 完成构建与验证，但存在警告。'
        : 'Codex Agent 分析后由 App 完成构建、验证与结果交接准备。',
      resultProjectPath: result.project.path,
      resultProjectId: result.project.name,
      artifacts: {
        ...task.artifacts,
        previewPath: result.artifacts.preview?.path || null,
        fcpxmlPath: result.artifacts.fcpxml?.path || null,
        summaryPath: task.artifacts?.summaryPath || null,
      },
      verification: {
        ...verification,
        shotCount: result.timeline.shotCount,
        durationSec: result.timeline.totalDurationSec,
        markerCount: result.timeline.markers.length,
        titleCount: result.formats.fcpxmlTitleCount,
        hyperframesCount: result.hyperframes.count || 0,
        timelineFormat: result.formats.timeline,
        previewFormat: result.formats.preview,
      },
      warnings,
      hyperframesDecision: task.hyperframesDecision || 'disabled',
      hyperframesReason: task.hyperframesReason
        || 'App 续建默认关闭 HyperFrames。',
    });
    await syncPackageStatusPointer(completed);
    return completed;
  } catch (error) {
    if (error.code === 'HANDOFF_TERMINAL_STATE'
      || error.code === 'INVALID_HANDOFF_TRANSITION'
      || error.code === 'LATE_ATTEMPT_WRITE') {
      throw error;
    }
    const failed = await updateHandoffTask(taskPath, {
      status: 'failed',
      attemptId,
      stageMessage: `App 续建失败：${error.message}`,
      errors: [{
        code: error.code || 'CONTINUE_BUILD_FAILED',
        message: error.message,
        at: new Date().toISOString(),
      }],
    });
    await syncPackageStatusPointer(failed);
    return failed;
  }
}

async function sweepHandoffPackages(userDataPath, options = {}) {
  const now = options.now || Date.now();
  const maxAgeMs = options.maxAgeMs == null ? PACKAGE_SWEEP_AGE_MS : Number(options.maxAgeMs);
  const payload = await listHandoffTasks(userDataPath);
  const swept = [];
  const retained = [];
  for (const task of payload.tasks) {
    const retention = packageRetentionOf(task);
    const packageDir = task.agentPackagePath || packageDirForTask(task.taskFilePath);
    if (!packageDir) {
      retained.push({ taskId: task.taskId, retention, reason: 'no_package' });
      continue;
    }
    let exists = false;
    try {
      await fs.access(packageDir);
      exists = true;
    } catch {
      retained.push({ taskId: task.taskId, retention, reason: 'already_absent' });
      continue;
    }
    const terminalAt = Date.parse(task.completedAt || task.updatedAt || 0);
    const ageMs = Number.isFinite(terminalAt) ? now - terminalAt : 0;
    if (retention !== PACKAGE_RETENTION.sweepable) {
      retained.push({
        taskId: task.taskId,
        retention,
        reason: retention === PACKAGE_RETENTION.retain_recovery
          ? 'keep_for_recovery'
          : (retention === PACKAGE_RETENTION.retain_diagnostics ? 'keep_diagnostics' : 'still_active'),
        exists,
      });
      continue;
    }
    if (ageMs < maxAgeMs) {
      retained.push({
        taskId: task.taskId,
        retention,
        reason: 'too_new',
        ageMs,
        exists,
      });
      continue;
    }
    const windowsDir = path.join(path.dirname(packageDir), 'agent-windows');
    const attemptIds = new Set([
      task.currentAttempt?.attemptId,
      ...(Array.isArray(task.attempts) ? task.attempts.map((item) => item.attemptId) : []),
    ].filter(Boolean));
    for (const attemptId of attemptIds) {
      await fs.rm(path.join(windowsDir, `agent-window-${attemptId}.code-workspace`), { force: true });
    }
    await fs.rm(packageDir, { recursive: true, force: true });
    swept.push({
      taskId: task.taskId,
      packageDir,
      retention,
      ageMs,
    });
  }
  return {
    rootPath: payload.rootPath,
    swept,
    retained,
    maxAgeMs,
  };
}

module.exports = {
  EXPECTED_ANALYSIS_ARTIFACTS,
  PACKAGE_RETENTION,
  PACKAGE_SWEEP_AGE_MS,
  buildCodexAgentPrompt,
  buildCodexLaunchPlan,
  buildCodexWindowWorkspace,
  classifyAgentHandoffState,
  continueBuildFromAnalysis,
  agentWindowWorkspacePath,
  agentWorkspaceFor,
  writeCodexWindowWorkspace,
  deactivateCodexSession,
  inspectAnalysisArtifacts,
  markAnalysisComplete,
  packageRetentionOf,
  sweepHandoffPackages,
  syncPackageStatusPointer,
  writeCodexAgentPackage,
};
