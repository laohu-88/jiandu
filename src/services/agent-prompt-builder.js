'use strict';

const path = require('node:path');

const SKILL_RELATIVE_PATH = path.join('skills', 'jiandu', 'SKILL.md');

function skillPathFor(appWorkspace) {
  return path.join(path.resolve(String(appWorkspace || '')), SKILL_RELATIVE_PATH);
}

function taskManifestPathFor(taskFilePath) {
  return String(taskFilePath || '').replace(/\.json$/i, '.task.json');
}

function normalizeExtraRequirements(value) {
  if (value == null) return '';
  return String(value);
}

function buildCompactAgentPrompt({
  taskId,
  attemptId,
  skillPath,
  taskManifestPath,
  extraRequirements = '',
} = {}) {
  const extra = normalizeExtraRequirements(extraRequirements);
  const attemptLine = attemptId ? `（attempt ${attemptId}）` : '';
  return [
    `执行视频剪辑任务 ${taskId}${attemptLine}。`,
    '',
    '读取：',
    `- 固定剪辑 Skill：${skillPath}`,
    `- 本次任务清单：${taskManifestPath}`,
    '',
    '本次额外要求：',
    extra,
    '',
    '源画面净化是默认步骤：必须实际查看每个可用视频的开头、中段、结尾和明显镜头变化处 storyboard/代表帧（必要时先用 inspect-range），不能用 HotIngest HTML、文件名、OCR 或旧 metadata 代替视觉检查。',
    '每个可用图片/视频都必须在 assets[].cleanup 记录实际检查结果；发现与本期无关的外文大标题、排行榜数字、符号、贴纸、水印等，写出 timeRanges、normalized zones、overlayTypes、isCoreContent、method、confidence 和 reviewRequired；没有发现也必须明确写 decision=none、实际检查帧和“检查后未发现”。',
    'cleanup 处理优先 crop_reframe（FCPXML 原生 crop/reframe）；普通背景上的固定覆盖物使用 derived_media + ffmpeg_delogo；复杂主体遮挡不得伪造成功，必须 fallback_preserve/unresolved。完成 build 后必须再次抽帧检查，未产生真实视觉变化不得报告净化成功。',
    '',
    '完成后按任务清单写回结果和状态。所有 handoff-update / prepare / validate-analysis / build / handoff-complete 必须带上：',
    `--attempt-id ${attemptId || '当前任务清单中的 attemptId'}`,
    '旧 attempt 的回写会被忽略。',
  ].join('\n');
}

function buildTaskManifest(task) {
  const skillPath = skillPathFor(task.appWorkspace);
  const extraRequirements = normalizeExtraRequirements(task.extraRequirements);
  const attempt = task.currentAttempt || null;
  const artifacts = task.artifacts || {};
  const analysisPath = artifacts.analysisPath || artifacts.analysisOutputPath || task.previousAnalysisPath || null;
  const manifestPath = artifacts.manifestPath || null;
  const reusable = task.reusableResults || {
    skipFullRescan: Boolean(
      analysisPath && manifestPath
      || task.kind === 'revise'
      || task.previousProjectPath,
    ),
    analysisPath,
    manifestPath,
    analysisRequestPath: artifacts.analysisRequestPath || null,
    cacheDirectory: artifacts.cacheDirectory || null,
    projectPath: task.resultProjectPath || task.previousProjectPath || null,
    lastActiveStatus: task.lastActiveStatus || null,
    previousAttemptId: attempt?.previousAttemptId || task.parentTaskId || null,
  };
  return {
    schemaVersion: 1,
    taskId: task.taskId,
    attemptId: attempt?.attemptId || null,
    engine: task.engine || 'codex',
    kind: task.kind || 'edit',
    platformMode: task.platformMode === 'main' ? 'main' : 'douyin',
    sourceDirectory: task.sourceDirectoryRealPath || task.sourceDirectory,
    taskFilePath: task.taskFilePath,
    skillPath,
    cliPath: path.join(String(task.appWorkspace || ''), 'bin', 'video-skill.js'),
    extraRequirements,
    hyperframesMode: task.hyperframesMode || 'auto',
    lifecycle: task.lifecycle || null,
    packageDir: task.agentPackagePath || null,
    reusableResults: reusable,
    previous: task.previousProjectPath || task.parentTaskId || reusable.skipFullRescan ? {
      taskId: task.parentTaskId || reusable.previousAttemptId || null,
      projectPath: reusable.projectPath || task.previousProjectPath || null,
      analysisPath: reusable.analysisPath || task.previousAnalysisPath || null,
      skipFullRescan: reusable.skipFullRescan === true,
    } : null,
    writeback: {
      statusFile: task.taskFilePath,
      attemptId: attempt?.attemptId || null,
      analysisPath: reusable.analysisPath || artifacts.analysisOutputPath || artifacts.analysisPath || null,
      packageDir: task.agentPackagePath || null,
      completeCommand: task.engine === 'codex' ? 'handoff-return' : 'handoff-complete',
      returnCommand: 'handoff-return',
    },
  };
}

function promptContainsFixedRules(prompt) {
  const text = String(prompt || '');
  return /不得修改、移动、重命名或删除原始素材/.test(text)
    || /sharedEditingRules/.test(text)
    || /独立选材/.test(text) && /动态主体跟踪/.test(text);
}

module.exports = {
  SKILL_RELATIVE_PATH,
  buildCompactAgentPrompt,
  buildTaskManifest,
  normalizeExtraRequirements,
  promptContainsFixedRules,
  skillPathFor,
  taskManifestPathFor,
};
