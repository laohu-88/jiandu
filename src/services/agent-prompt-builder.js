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
    '每个可用图片/视频都必须在 assets[].cleanup 记录实际检查结果，并写真实代表帧路径（开头/中段/结尾/镜头变化，不能写 storyboard.jpg 这类占位词）。发现与本期无关的外文大标题、排行榜数字、符号、贴纸、水印时，必须给出 timeRanges、normalized zones、overlayTypes、处理策略和 confidence；有覆盖物却没有 cleanup plan 时不得继续 build。',
    '净化优先级：1) crop/reframe/scale/position 让覆盖物真正离开最终画面；2) 换时间段、换构图、缩短、换同类素材或不使用；3) 仅简单静态背景的小区域才可用 ffmpeg-delogo。禁止把 mask blur、马赛克、涂抹当成功。复杂主体遮挡标 unresolved/omit，宁可少用一条素材，也不要难看的修补画面。',
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
