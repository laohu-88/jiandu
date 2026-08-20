const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const cliPath = path.resolve(__dirname, '..', 'bin', 'video-skill.js');
const {
  formatOptions,
  hyperframesOptions,
  parseArguments,
  shouldMarkHandoffFailed,
} = require('../bin/video-skill');
const { createHandoffTask, readHandoffTask } = require('../src/services/handoff-task-service');
const { snapshotSource, preparePendingMedia } = require('../src/services/pending-media-service');

async function correctionFixture() {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'video-skill-correction-')));
  const pendingRoot = path.join(temp, '视频待处理');
  const sourceDirectory = path.join(pendingRoot, '一期');
  const userData = path.join(temp, 'user');
  await fs.mkdir(sourceDirectory, { recursive: true });
  await fs.writeFile(path.join(sourceDirectory, 'shot.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ));
  const task = await createHandoffTask(userData, {
    pendingRoot,
    sourceDirectory,
    sourceSnapshot: await snapshotSource(sourceDirectory),
    sourceSummary: { name: '一期' },
    appWorkspace: path.resolve(__dirname, '..'),
    hyperframesMode: 'disabled',
    engine: 'codex',
  });
  const prepared = await preparePendingMedia(sourceDirectory, { cacheRoot: path.join(temp, 'cache') });
  return { temp, task, prepared };
}

function validAnalysis(assetId) {
  return {
    schemaVersion: 1,
    theme: { summary: '主题', rationale: '可见素材', confidence: 0.9, folderNameConflict: false },
    titles: { candidates: ['假隧道撞上真车', '我向艺术家致敬'], recommended: '假隧道撞上真车', rationale: '与素材一致' },
    assets: [{ assetId, type: 'image', semanticLabels: ['壁画'], contentSummary: '壁画假隧道与银色轿车', suggestedUse: ['时间线'], status: 'adopt', reason: '完整展示', ranges: [], confidence: 0.9 }],
    timeline: { orientation: 'vertical', width: 1080, height: 1920, fps: 30, shots: [{ id: 'shot-001', assetId, inSec: 0, outSec: 2, durationSec: 2, fitMode: 'contain', audioMode: 'keep', purpose: '完整展示', confidence: 0.9, reviewRequired: false }], markers: [{ timeSec: 1, text: '我向艺术家致敬' }] },
  };
}

test('CLI help 列出准备、校验、构建和验证入口', () => {
  for (const argument of ['help', '--help', '-h']) {
    const result = spawnSync(process.execPath, [cliPath, argument], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /prepare/);
    assert.match(result.stdout, /validate-analysis/);
    assert.match(result.stdout, /build/);
    assert.match(result.stdout, /verify/);
    assert.match(result.stdout, /--orientation/);
    assert.match(result.stdout, /--preview-width/);
    assert.match(result.stdout, /hyperframes-doctor/);
    assert.match(result.stdout, /--hyperframes/);
  }
});

test('CLI 将 HyperFrames 保持为显式启用的可选适配', () => {
  const parsed = parseArguments([
    'build', '--hyperframes', '--hyperframes-duration', '1.5',
    '--hyperframes-quality', 'draft', '--hyperframes-executable', '/tmp/hyperframes',
    '--hyperframes-flow', '/tmp/flow.json',
  ]);
  assert.deepEqual(hyperframesOptions(parsed.options), {
    enabled: true,
    executablePath: '/tmp/hyperframes',
    browserPath: undefined,
    durationSec: '1.5',
    quality: 'draft',
    flowSpecPath: '/tmp/flow.json',
  });
  assert.equal(hyperframesOptions({}).enabled, false);
  assert.equal(
    hyperframesOptions({ 'reuse-hyperframes-project': '/tmp/reviewed-project' }).reuseProjectPath,
    '/tmp/reviewed-project',
  );
});

test('CLI 接受可选的正式时间线和独立预览格式', () => {
  const parsed = parseArguments([
    'build', '--orientation', 'vertical', '--width', '1080', '--height', '1920',
    '--fps', '30', '--preview-width', '640', '--preview-height', '360',
  ]);
  assert.deepEqual(formatOptions(parsed.options), {
    timeline: { orientation: 'vertical', width: '1080', height: '1920', fps: '30' },
    preview: { width: '640', height: '360', fps: undefined },
  });
});

test('CLI 非法命令返回结构化错误和退出码 2', () => {
  const result = spawnSync(process.execPath, [cliPath, 'not-a-command', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'INVALID_COMMAND');
});

test('CLI 缺少必填参数返回结构化错误和退出码 2', () => {
  const result = spawnSync(process.execPath, [cliPath, 'prepare', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.error.code, 'MISSING_ARGUMENT');
});

test('CLI 状态回退误用不会把仍可继续的交接任务降级为失败', () => {
  assert.equal(shouldMarkHandoffFailed({ code: 'INVALID_HANDOFF_TRANSITION' }), false);
  assert.equal(shouldMarkHandoffFailed({ code: 'HANDOFF_TERMINAL_STATE' }), false);
  assert.equal(shouldMarkHandoffFailed({ code: 'VIDEO_BUILD_FAILED' }), true);
  assert.equal(shouldMarkHandoffFailed({ code: 'INVALID_VIDEO_ANALYSIS' }, { command: 'validate-analysis' }), false);
  assert.equal(shouldMarkHandoffFailed({ code: 'INVALID_VIDEO_ANALYSIS' }, { command: 'build' }), true);
});

test('首次 validate-analysis 失败后同一 attempt 修正并成功，不进入永久 failed', async () => {
  const { temp, task, prepared } = await correctionFixture();
  const analysisPath = path.join(temp, 'analysis.json');
  await fs.writeFile(analysisPath, '{}\n');
  const first = spawnSync(process.execPath, [cliPath, 'validate-analysis', '--manifest', prepared.manifestPath,
    '--analysis', analysisPath, '--handoff-task', task.taskFilePath, '--attempt-id', task.currentAttempt.attemptId, '--json'], { encoding: 'utf8' });
  assert.notEqual(first.status, 0);
  let persisted = await readHandoffTask(task.taskFilePath);
  assert.equal(persisted.status, 'analysis_needs_correction');
  assert.equal(persisted.currentAttempt.attemptId, task.currentAttempt.attemptId);
  assert.equal(persisted.validationIssues[0].code, 'INVALID_VIDEO_ANALYSIS');

  await fs.writeFile(analysisPath, `${JSON.stringify(validAnalysis(prepared.items[0].assetId), null, 2)}\n`);
  const second = spawnSync(process.execPath, [cliPath, 'validate-analysis', '--manifest', prepared.manifestPath,
    '--analysis', analysisPath, '--handoff-task', task.taskFilePath, '--attempt-id', task.currentAttempt.attemptId, '--json'], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  persisted = await readHandoffTask(task.taskFilePath);
  assert.equal(persisted.status, 'deciding_hyperframes');
  assert.equal(persisted.currentAttempt.attemptId, task.currentAttempt.attemptId);
  assert.deepEqual(persisted.validationIssues, []);
});
