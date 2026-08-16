'use strict';

const path = require('node:path');

const SKILL_RELATIVE_PATH = path.join('skills', 'video-cut-planner', 'SKILL.md');

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
    packageDir: task.cursorPackagePath || null,
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
      packageDir: task.cursorPackagePath || null,
      completeCommand: task.engine === 'cursor_agent' ? 'handoff-return' : 'handoff-complete',
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
