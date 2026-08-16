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
  skillPath,
  taskManifestPath,
  extraRequirements = '',
} = {}) {
  const extra = normalizeExtraRequirements(extraRequirements);
  return [
    `执行视频剪辑任务 ${taskId}。`,
    '',
    '读取：',
    `- 固定剪辑 Skill：${skillPath}`,
    `- 本次任务清单：${taskManifestPath}`,
    '',
    '本次额外要求：',
    extra,
    '',
    '完成后按任务清单写回结果和状态。',
  ].join('\n');
}

function buildTaskManifest(task) {
  const skillPath = skillPathFor(task.appWorkspace);
  const extraRequirements = normalizeExtraRequirements(task.extraRequirements);
  return {
    schemaVersion: 1,
    taskId: task.taskId,
    engine: task.engine || 'codex',
    kind: task.kind || 'edit',
    platformMode: task.platformMode === 'main' ? 'main' : 'douyin',
    sourceDirectory: task.sourceDirectoryRealPath || task.sourceDirectory,
    taskFilePath: task.taskFilePath,
    skillPath,
    cliPath: path.join(String(task.appWorkspace || ''), 'bin', 'video-skill.js'),
    extraRequirements,
    hyperframesMode: task.hyperframesMode || 'auto',
    previous: task.previousProjectPath || task.parentTaskId ? {
      taskId: task.parentTaskId || null,
      projectPath: task.previousProjectPath || null,
      analysisPath: task.previousAnalysisPath || null,
      skipFullRescan: task.kind === 'revise',
    } : null,
    writeback: {
      statusFile: task.taskFilePath,
      analysisPath: task.artifacts?.analysisOutputPath || task.artifacts?.analysisPath || null,
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
