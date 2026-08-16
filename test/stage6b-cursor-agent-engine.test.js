'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AGENT_ENGINES,
  buildAgentPrompt,
  createHandoffTask,
  readHandoffTask,
  updateHandoffTask,
} = require('../src/services/handoff-task-service');
const {
  buildCursorLaunchPlan,
  classifyAgentHandoffState,
  continueBuildFromAnalysis,
  inspectAnalysisArtifacts,
  markAnalysisComplete,
  writeCursorAgentPackage,
} = require('../src/services/cursor-agent-handoff-service');
const {
  ACTIONS,
  buildEditPreflight,
  createEditJob,
  runEditJob,
} = require('../src/services/in-app-edit-workflow-service');
const { snapshotSource } = require('../src/services/pending-media-service');
const { CODEX_VIDEO_ANALYSIS_FILE, EDITORIAL_REVIEW_FILE } = require('../src/constants');

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createMaterialPng(filePath) {
  // Valid 1x1 PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await fs.writeFile(filePath, png);
}

async function fixture() {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stage6b-')));
  const pendingRoot = path.join(temp, '视频待处理');
  const projectRoot = path.join(temp, '视频素材库');
  const sourceDirectory = path.join(pendingRoot, 'Stage6B验收素材');
  const userData = path.join(temp, 'user-data');
  await fs.mkdir(sourceDirectory, { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await createMaterialPng(path.join(sourceDirectory, 'shot-1.png'));
  await fs.writeFile(path.join(sourceDirectory, 'note.txt'), 'hello\n', 'utf8');
  return { temp, pendingRoot, projectRoot, sourceDirectory, userData };
}

function minimalAnalysis(assetId = 'media-1') {
  return {
    schemaVersion: 1,
    theme: { summary: '主题', rationale: '可见素材', confidence: 0.9, folderNameConflict: false },
    titles: {
      candidates: ['标题A', '标题B'],
      recommended: '标题A',
      rationale: '与素材一致',
    },
    assets: [{
      assetId,
      type: 'image',
      semanticLabels: ['结果'],
      contentSummary: '可见结果',
      suggestedUse: ['时间线'],
      status: 'adopt',
      reason: '推动叙事',
      ranges: [],
      confidence: 0.9,
    }],
    timeline: {
      orientation: 'vertical',
      width: 1080,
      height: 1920,
      fps: 30,
      shots: [{
        id: 'shot-001',
        assetId,
        inSec: 0,
        outSec: 2,
        durationSec: 2,
        fitMode: 'contain',
        audioMode: 'keep',
        purpose: '结果',
        confidence: 0.9,
        reviewRequired: false,
      }],
      markers: [{ timeSec: 1, text: '结果' }],
    },
  };
}

async function createCursorTask(paths, overrides = {}) {
  return createHandoffTask(paths.userData, {
    pendingRoot: paths.pendingRoot,
    sourceDirectory: paths.sourceDirectory,
    sourceSnapshot: await snapshotSource(paths.sourceDirectory),
    sourceSummary: { name: path.basename(paths.sourceDirectory), totalFileCount: 1 },
    appWorkspace: '/Users/example/Projects/video-cut-planner-v3',
    hyperframesMode: 'disabled',
    engine: 'cursor_agent',
    autoOpenFcp: false,
    ...overrides,
  });
}

test('引擎选择：首次无分析默认 Cursor Agent，Codex 仍可用', async () => {
  const paths = await fixture();
  const preflight = await buildEditPreflight(paths.sourceDirectory, {
    projectRoot: paths.projectRoot,
  });
  assert.equal(preflight.generationMode, 'first');
  assert.equal(preflight.recommendedAction, 'cursor_agent_handoff');
  assert.equal(preflight.recommendedEngine, 'cursor_agent');
  assert.equal(preflight.actions.cursor_agent_handoff, true);
  assert.equal(preflight.actions.codex_handoff, true);
  assert.ok(ACTIONS.has('cursor_agent_handoff'));
  assert.ok(ACTIONS.has('codex_handoff'));
  assert.equal(AGENT_ENGINES.cursor_agent.id, 'cursor_agent');
});

test('Cursor 交接包包含任务清单、路径、提示词、预期产物、状态与恢复信息', async () => {
  const paths = await fixture();
  const task = await createCursorTask(paths);
  assert.equal(task.engine, 'cursor_agent');
  assert.ok(task.cursorPackagePath);
  assert.match(task.prompt, /执行视频剪辑任务/);
  assert.match(task.prompt, /本次任务清单/);
  assert.equal(task.codexDeepLink, null);

  const packageDir = task.cursorPackagePath;
  const files = await fs.readdir(packageDir);
  for (const name of [
    'TASK.md', 'TASK.json', 'prompt.md', 'paths.json', 'expected-artifacts.json', 'status.json', 'RECOVERY.md',
  ]) {
    assert.ok(files.includes(name), `missing ${name}`);
  }
  const packagePaths = JSON.parse(await fs.readFile(path.join(packageDir, 'paths.json'), 'utf8'));
  assert.equal(packagePaths.taskFilePath, task.taskFilePath);
  assert.equal(packagePaths.sourceDirectoryRealPath, task.sourceDirectoryRealPath);
  assert.ok(packagePaths.analysisOutputPath.endsWith('analysis.json'));
  const expected = JSON.parse(await fs.readFile(path.join(packageDir, 'expected-artifacts.json'), 'utf8'));
  assert.ok(expected.items.some((item) => item.id === 'analysis'));
  const plan = buildCursorLaunchPlan(task);
  assert.equal(plan.engine, 'cursor_agent');
  assert.ok(plan.openArgs.includes('--new-window'));
  assert.ok(plan.openArgs.some((arg) => String(arg).includes('.cursor-package')));
  assert.match(plan.windowTitleNeedle, /\.cursor-package$/);
  assert.match(plan.userInstruction, /提示词/);
});

test('Codex 既有路径不回归：默认仍生成深链接提示词', async () => {
  const paths = await fixture();
  const task = await createHandoffTask(paths.userData, {
    pendingRoot: paths.pendingRoot,
    sourceDirectory: paths.sourceDirectory,
    sourceSnapshot: await snapshotSource(paths.sourceDirectory),
    sourceSummary: { name: 'codex', totalFileCount: 1 },
    appWorkspace: '/Users/example/Projects/video-cut-planner-v3',
    hyperframesMode: 'auto',
    engine: 'codex',
  });
  assert.equal(task.engine, 'codex');
  assert.ok(task.codexDeepLink.startsWith('codex://'));
  assert.match(task.prompt, /执行视频剪辑任务/);
  assert.equal(task.cursorPackagePath, null);
  const prompt = buildAgentPrompt('codex', {
    sourceDirectory: paths.sourceDirectory,
    taskId: task.taskId,
    taskFilePath: task.taskFilePath,
    hyperframesMode: 'auto',
  });
  assert.match(prompt, /执行视频剪辑任务/);
});

test('状态流转：等待 Agent → 执行中 → 分析完成 → 可恢复识别', async () => {
  const paths = await fixture();
  let task = await createCursorTask(paths);
  assert.equal(classifyAgentHandoffState(task).state, 'awaiting_agent');

  task = await updateHandoffTask(task.taskFilePath, {
    status: 'launching_cursor',
    stageMessage: '正在打开 Cursor',
  });
  assert.equal(classifyAgentHandoffState(task).state, 'launching');

  task = await updateHandoffTask(task.taskFilePath, {
    status: 'awaiting_user_send',
    stageMessage: '等待启动',
  });
  assert.equal(classifyAgentHandoffState(task).state, 'awaiting_agent');

  task = await updateHandoffTask(task.taskFilePath, {
    status: 'analyzing_media',
    stageMessage: '分析中',
  });
  assert.equal(classifyAgentHandoffState(task).state, 'agent_running');

  task = await updateHandoffTask(task.taskFilePath, {
    status: 'analysis_complete',
    stageMessage: '分析完成但缺产物',
  });
  assert.equal(classifyAgentHandoffState(task).state, 'artifacts_incomplete');
  assert.equal(classifyAgentHandoffState(task).canContinueBuild, false);

  const failed = await updateHandoffTask(task.taskFilePath, {
    status: 'failed',
    stageMessage: '失败',
    errors: [{ message: 'boom' }],
  });
  assert.equal(classifyAgentHandoffState(failed).state, 'analysis_failed');
  assert.equal(classifyAgentHandoffState(failed).success, undefined);
});

test('分析结果接收与 build/verify 续接；重复完成不覆盖；失败不显示成功', async () => {
  const paths = await fixture();
  const { preparePendingMedia } = require('../src/services/pending-media-service');
  const prepared = await preparePendingMedia(paths.sourceDirectory, {
    cacheRoot: path.join(paths.temp, 'cache'),
  });
  const analysis = minimalAnalysis(prepared.items[0].assetId);
  const analysisPath = path.join(paths.temp, 'analysis.json');
  await writeJson(analysisPath, analysis);

  let task = await createCursorTask(paths);
  task = await updateHandoffTask(task.taskFilePath, { status: 'awaiting_user_send' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'scanning_media' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'extracting_metadata' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'extracting_frames' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'analyzing_media' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'planning_story' });
  task = await markAnalysisComplete(task.taskFilePath, {
    manifestPath: prepared.manifestPath,
    analysisPath,
    analysisRequestPath: prepared.analysisRequestPath,
    cacheDirectory: prepared.cacheDirectory,
  });
  assert.equal(task.status, 'analysis_complete');
  assert.equal(classifyAgentHandoffState(task).canContinueBuild, true);

  const inspection = await inspectAnalysisArtifacts(task);
  assert.equal(inspection.canContinueBuild, true);

  const completed = await continueBuildFromAnalysis(task.taskFilePath, {
    projectRoot: paths.projectRoot,
    projectName: 'Stage6B-Cursor续建',
  });
  assert.ok(['completed', 'completed_with_warnings'].includes(completed.status));
  assert.ok(completed.resultProjectPath);
  assert.notEqual(classifyAgentHandoffState(completed).state, 'analysis_failed');

  await assert.rejects(
    continueBuildFromAnalysis(task.taskFilePath, {
      projectRoot: paths.projectRoot,
      projectName: 'Stage6B-Cursor续建-2',
    }),
    /终态任务不能再次构建/,
  );

  const reread = await readHandoffTask(task.taskFilePath);
  assert.equal(reread.status, completed.status);
  assert.equal(reread.resultProjectPath, completed.resultProjectPath);
});

test('中断恢复：重启后可读任务；产物不完整不可续建；成功项目拒绝原地覆盖', async () => {
  const paths = await fixture();
  let task = await createCursorTask(paths);
  task = await updateHandoffTask(task.taskFilePath, { status: 'awaiting_user_send' });
  const revived = await readHandoffTask(task.taskFilePath);
  assert.equal(revived.status, 'awaiting_user_send');
  assert.equal(classifyAgentHandoffState(revived).recoverable, true);

  task = await updateHandoffTask(task.taskFilePath, { status: 'scanning_media' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'extracting_metadata' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'extracting_frames' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'analyzing_media' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'planning_story' });
  task = await updateHandoffTask(task.taskFilePath, {
    status: 'analysis_complete',
    stageMessage: '缺产物',
    artifacts: {},
  });
  const inspection = await inspectAnalysisArtifacts(task);
  assert.equal(inspection.incomplete, true);
  assert.equal(inspection.canContinueBuild, false);

  await assert.rejects(
    continueBuildFromAnalysis(task.taskFilePath, { projectRoot: paths.projectRoot }),
    /分析产物不完整|只有分析完成/,
  );
});

test('来源及人工文件不可变；edit job Cursor 路径可交接', async () => {
  const paths = await fixture();
  const before = await snapshotSource(paths.sourceDirectory);
  const preflight = await buildEditPreflight(paths.sourceDirectory, {
    projectRoot: paths.projectRoot,
  });
  const job = await createEditJob(paths.userData, {
    sourceDirectory: paths.sourceDirectory,
    action: 'cursor_agent_handoff',
    preflight,
  });
  const ran = await runEditJob(paths.userData, job.jobFilePath);
  assert.equal(ran.result.handoffRequired, true);
  assert.equal(ran.result.engine, 'cursor_agent');
  const after = await snapshotSource(paths.sourceDirectory);
  assert.equal(after.digest, before.digest);

  // Package rewrite must not touch source.
  const task = await createCursorTask(paths);
  await writeCursorAgentPackage(task);
  const afterPackage = await snapshotSource(paths.sourceDirectory);
  assert.equal(afterPackage.digest, before.digest);
  assert.equal(EDITORIAL_REVIEW_FILE.includes('editorial-review'), true);
  assert.equal(CODEX_VIDEO_ANALYSIS_FILE.includes('Codex视频分析'), true);
});

test('失败任务不得显示为成功；重复 package 写入保持任务 ID', async () => {
  const paths = await fixture();
  let task = await createCursorTask(paths);
  task = await updateHandoffTask(task.taskFilePath, { status: 'awaiting_user_send' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'scanning_media' });
  task = await updateHandoffTask(task.taskFilePath, {
    status: 'failed',
    stageMessage: '分析失败',
    errors: [{ message: 'bad analysis' }],
  });
  const classification = classifyAgentHandoffState(task);
  assert.equal(classification.state, 'analysis_failed');
  assert.notEqual(classification.state, 'completed');
  assert.equal(classification.canContinueBuild, false);

  const again = await writeCursorAgentPackage(task);
  assert.equal(again.packageDir, task.cursorPackagePath);
  const status = JSON.parse(await fs.readFile(path.join(again.packageDir, 'status.json'), 'utf8'));
  assert.equal(status.taskId, task.taskId);
  assert.equal(typeof crypto.randomUUID, 'function');
});
