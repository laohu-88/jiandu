'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { DEFAULT_PROJECT_ROOT } = require('../constants');
const {
  AGENT_ENGINES,
  STAGE_LABELS,
  TERMINAL_STATUSES,
  atomicWriteJson,
  buildCursorAgentPrompt,
  packageDirForTask,
  readHandoffTask,
  updateHandoffTask,
} = require('./handoff-task-service');
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

function buildCursorLaunchPlan(task) {
  const packageDir = task.cursorPackagePath || packageDirForTask(task.taskFilePath);
  const promptPath = path.join(packageDir, 'prompt.md');
  const workspace = path.resolve(String(task.appWorkspace || ''));
  return {
    engine: 'cursor_agent',
    workspace,
    packageDir,
    promptPath,
    taskFilePath: task.taskFilePath,
    openArgs: ['--new-window', workspace, '-g', `${promptPath}:1`],
    clipboardText: task.prompt,
    userInstruction: '请在 Cursor 中打开 Agent，粘贴剪贴板中的正式任务提示词（或直接使用已打开的 prompt.md），然后显式启动任务。应用不会自动点击或模拟键盘发送。',
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

async function writeCursorAgentPackage(task) {
  const packageDir = packageDirForTask(task.taskFilePath);
  await fs.mkdir(packageDir, { recursive: true });
  const analysisOutputPath = path.join(packageDir, 'analysis.json');
  const paths = {
    taskId: task.taskId,
    engine: 'cursor_agent',
    sourceDirectory: task.sourceDirectory,
    sourceDirectoryRealPath: task.sourceDirectoryRealPath,
    taskFilePath: task.taskFilePath,
    packageDir,
    appWorkspace: task.appWorkspace,
    projectRoot: DEFAULT_PROJECT_ROOT,
    analysisOutputPath,
    expectedAnalysisContract: 'schemas/codex-video-analysis.schema.json',
    videoSkillCli: path.join(task.appWorkspace, 'bin/video-skill.js'),
  };
  const expectedArtifacts = {
    schemaVersion: 1,
    items: EXPECTED_ANALYSIS_ARTIFACTS.map((item) => ({
      ...item,
      suggestedPath: item.id === 'analysis' ? analysisOutputPath : null,
    })),
    afterAppBuild: [
      '正式 v3 项目目录',
      'Codex视频分析.json / Codex视频素材清单.json / Codex视频状态.json',
      '粗剪预览 MP4',
      'FCPXML',
      '结果中心可读结构化结果',
    ],
  };
  const checklist = [
    '# Cursor Agent 剪辑任务清单',
    '',
    `- 引擎：Cursor Agent`,
    `- 任务 ID：\`${task.taskId}\``,
    `- 素材目录：\`${task.sourceDirectoryRealPath}\``,
    `- 状态文件：\`${task.taskFilePath}\``,
    `- 交接包：\`${packageDir}\``,
    '',
    '## 必做步骤',
    '',
    '1. 在 Cursor Agent 中粘贴并启动 `prompt.md` 中的正式任务提示词',
    '2. 使用 `video-skill prepare` 扫描素材、元数据与抽帧',
    '3. 按现有分析数据合同写出 `analysis.json`',
    '4. 使用 `validate-analysis` 校验',
    '5. 将交接状态更新为 `analysis_complete` 并执行 `handoff-return`',
    '6. 回到「视频剪辑编排器 v3」继续 build / verify / 结果交接 / 打开 FCP',
    '',
    '## 禁止事项',
    '',
    '- 不修改来源素材',
    '- 不覆盖已有成功正式项目',
    '- 不改写 `editorial-review.json` 与人工字幕',
    '- 不另建与现有分析合同重复的数据格式',
    '',
  ].join('\n');
  const recovery = [
    '# 错误与恢复',
    '',
    '- App 或 Cursor 中途关闭后，重新打开 App，从待处理素材进入「查看交接任务」即可继续。',
    '- 状态为 `awaiting_user_send`：重新复制提示词，在 Cursor Agent 中启动。',
    '- 状态为 `analysis_complete`：在 App 中点击「继续构建与验证」，不要重复分析覆盖成功结果。',
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
    atomicWriteJson(path.join(packageDir, 'status.json'), {
      schemaVersion: 1,
      taskId: task.taskId,
      taskFilePath: task.taskFilePath,
      status: task.status,
      stage: task.stage,
      stageMessage: task.stageMessage,
      engine: 'cursor_agent',
      updatedAt: task.updatedAt,
      note: '权威状态以 taskFilePath 指向的交接任务快照为准；本文件仅便于 Agent 快速定位。',
    }),
  ]);

  return {
    packageDir,
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
  if (!task.cursorPackagePath) return null;
  const statusPath = path.join(task.cursorPackagePath, 'status.json');
  await atomicWriteJson(statusPath, {
    schemaVersion: 1,
    taskId: task.taskId,
    taskFilePath: task.taskFilePath,
    status: task.status,
    stage: task.stage,
    stageMessage: task.stageMessage,
    engine: task.engine || 'cursor_agent',
    updatedAt: task.updatedAt,
    artifacts: task.artifacts || {},
    errors: task.errors || [],
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
  if (['draft', 'ready', 'launching_codex', 'launching_cursor', 'awaiting_user_send'].includes(status)) {
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
    stageMessage: input.stageMessage
      || 'Cursor Agent 分析已通过协议校验，等待 App 继续构建与验证。',
    artifacts: {
      ...(task.artifacts || {}),
      manifestPath: validated.manifestPath,
      analysisPath: validated.analysisPath,
      analysisRequestPath: input.analysisRequestPath || task.artifacts?.analysisRequestPath || null,
      cacheDirectory: input.cacheDirectory || task.artifacts?.cacheDirectory || null,
    },
    hyperframesDecision: task.hyperframesDecision || 'disabled',
    hyperframesReason: task.hyperframesReason
      || 'Stage 6B 默认由 App 继续构建；HyperFrames 保持关闭，除非后续显式启用。',
    hyperframesGap: task.hyperframesGap || '无',
  });
  await syncPackageStatusPointer(updated);
  return updated;
}

async function continueBuildFromAnalysis(taskPath, options = {}) {
  const task = await readHandoffTask(taskPath);
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
  const projectName = options.projectName
    || task.sourceSummary?.name
    || path.basename(task.sourceDirectoryRealPath);
  const targetPath = path.join(projectRoot, projectName);
  const targetExists = await pathExists(targetPath);
  if (targetExists) {
    throw Object.assign(new Error('正式项目目录已存在，为保护成功结果不会原地覆盖。请改用新项目名。'), {
      code: 'PROJECT_ALREADY_EXISTS',
      projectPath: targetPath,
    });
  }

  let building = await updateHandoffTask(taskPath, {
    status: 'building_project',
    stageMessage: 'App 正在基于 Cursor Agent 分析结果创建正式项目。',
  });
  await syncPackageStatusPointer(building);

  try {
    const built = await buildCodexVideoProject({
      manifestPath: task.artifacts.manifestPath,
      analysisPath: task.artifacts.analysisPath,
      projectRoot,
      projectName,
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
          stageMessage: message || STAGE_LABELS[status] || status,
        });
        await syncPackageStatusPointer(building);
      },
    });

    await updateHandoffTask(taskPath, {
      status: 'verifying',
      stageMessage: '正式项目已生成，正在完整验证。',
      resultProjectPath: built.projectPath,
      resultProjectId: built.project?.projectId || built.project?.projectName || projectName,
      artifacts: {
        ...task.artifacts,
        previewPath: built.artifacts.previewPath,
        fcpxmlPath: built.artifacts.fcpxmlPath,
        summaryPath: built.artifacts.summaryPath,
      },
    });

    const verification = await verifyCodexVideoProject(built.projectPath);
    if (!verification.ok) {
      const failed = await updateHandoffTask(taskPath, {
        status: 'failed',
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
      stageMessage: warnings.length
        ? 'Cursor Agent 分析后由 App 完成构建与验证，但存在警告。'
        : 'Cursor Agent 分析后由 App 完成构建、验证与结果交接准备。',
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
        || 'Stage 6B App 续建默认关闭 HyperFrames。',
    });
    await syncPackageStatusPointer(completed);
    return completed;
  } catch (error) {
    if (error.code === 'HANDOFF_TERMINAL_STATE' || error.code === 'INVALID_HANDOFF_TRANSITION') {
      throw error;
    }
    const failed = await updateHandoffTask(taskPath, {
      status: 'failed',
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

module.exports = {
  EXPECTED_ANALYSIS_ARTIFACTS,
  buildCursorAgentPrompt,
  buildCursorLaunchPlan,
  classifyAgentHandoffState,
  continueBuildFromAnalysis,
  inspectAnalysisArtifacts,
  markAnalysisComplete,
  syncPackageStatusPointer,
  writeCursorAgentPackage,
};
