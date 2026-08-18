'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  isReusableCursorSession,
  pickTargetWindowName,
  windowLooksTechnical,
  windowLooksForbidden,
  composerHoldsUnsentPrompt,
  focusedComposerLooksLikeAgent,
  destroyCursorHandoffController,
  getCursorHandoffController,
  runCursorHandoffController,
} = require('../src/services/cursor-automation-service');
const {
  buildCursorLaunchPlan,
  buildCursorWindowWorkspace,
  packageRetentionOf,
  PACKAGE_RETENTION,
  sweepHandoffPackages,
  writeCursorAgentPackage,
} = require('../src/services/cursor-agent-handoff-service');
const {
  createHandoffTask,
  startAgentAttempt,
  updateHandoffTask,
} = require('../src/services/handoff-task-service');
const { snapshotSource } = require('../src/services/pending-media-service');
const { probeTaskWindow } = require('../src/services/agent-runtime-service');

const ROOT = path.resolve(__dirname, '..');

async function fixture() {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-window-')));
  const pendingRoot = path.join(temp, '视频待处理');
  const sourceDirectory = path.join(pendingRoot, '一期');
  const userData = path.join(temp, 'user');
  await fs.mkdir(sourceDirectory, { recursive: true });
  await fs.writeFile(path.join(sourceDirectory, 'a.png'), 'x');
  return { temp, pendingRoot, sourceDirectory, userData };
}

async function createCursorTask(paths, overrides = {}) {
  return createHandoffTask(paths.userData, {
    pendingRoot: paths.pendingRoot,
    sourceDirectory: paths.sourceDirectory,
    sourceSnapshot: await snapshotSource(paths.sourceDirectory),
    sourceSummary: { name: '一期' },
    appWorkspace: ROOT,
    hyperframesMode: 'disabled',
    engine: 'cursor_agent',
    extraRequirements: 'CURSOR_E2E_EXTRA_REQUIREMENT_DO_NOT_REWRITE',
    ...overrides,
  });
}

test('Cursor 正常启动只打开真实项目窗口，不打开 prompt.md 或 cursor-package', async () => {
  const paths = await fixture();
  const task = await createCursorTask(paths);
  const packed = await writeCursorAgentPackage(task);
  const plan = buildCursorLaunchPlan(task);
  const workspaceFile = packed.windowWorkspacePath || plan.windowWorkspacePath;
  assert.equal(plan.workspace, ROOT);
  assert.equal(plan.windowTitleNeedle, '视频剪辑编排器 · 任务');
  assert.deepEqual(plan.openArgs, ['--new-window', workspaceFile]);
  assert.equal(plan.openArgs.some((arg) => String(arg).endsWith('.cursor-package')), false);
  assert.equal(plan.openArgs.some((arg) => /\.md$|\.json$/i.test(String(arg))), false);
  assert.match(workspaceFile, /\.code-workspace$/);
  assert.equal(workspaceFile.includes('.cursor-package'), false);
  assert.match(workspaceFile, /[/\\]cursor-windows[/\\]/);
  const workspaceDoc = buildCursorWindowWorkspace(task);
  assert.equal(workspaceDoc.folders[0].path, ROOT);
  assert.equal(workspaceDoc.settings['window.title'], '视频剪辑编排器 · 任务');
  assert.equal(workspaceDoc.settings['workbench.startupEditor'], 'none');
  const written = JSON.parse(await fs.readFile(workspaceFile, 'utf8'));
  assert.equal(written.folders[0].path, ROOT);
  assert.ok(task.cursorPackagePath);
  const files = await fs.readdir(task.cursorPackagePath);
  assert.ok(files.includes('prompt.md'));
  assert.ok(files.includes('TASK.json'));
  assert.equal(files.some((name) => name.endsWith('.code-workspace')), false);
});

test('不把开发会话或内部 handoff 文件当作任务窗口', () => {
  assert.equal(windowLooksTechnical('prompt.md — video-cut-planner-v3'), true);
  assert.equal(windowLooksTechnical('TASK.json — demo.cursor-package'), true);
  assert.equal(windowLooksTechnical('视频剪辑编排器 · 任务'), false);
  assert.equal(
    pickTargetWindowName(['prompt.md — uuid.cursor-package', 'status.json — uuid.cursor-package'], '视频剪辑编排器 · 任务'),
    null,
  );
  assert.equal(
    pickTargetWindowName(
      ['prompt.md — video-cut-planner-v3', 'video-cut-planner-v3', '视频剪辑编排器 · 任务'],
      '视频剪辑编排器 · 任务',
    ),
    '视频剪辑编排器 · 任务',
  );
  assert.equal(
    pickTargetWindowName(['video-cut-planner-v3'], '视频剪辑编排器 · 任务'),
    null,
  );
  assert.equal(
    pickTargetWindowName(
      [{ name: 'README.md — video-cut-planner-v3', position: [0, 0], size: [900, 700] }],
      '视频剪辑编排器 · 任务',
    ),
    null,
  );
  const leftover = { name: '视频剪辑编排器 · 任务', position: [12, 12], size: [900, 700] };
  const fresh = { name: '视频剪辑编排器 · 任务', position: [220, 80], size: [1280, 800] };
  assert.equal(windowLooksForbidden(fresh.name, '视频剪辑编排器 · 任务', {
    window: fresh,
    preexisting: [leftover],
    allowWorkspace: true,
  }), false);
  assert.equal(windowLooksForbidden(leftover.name, '视频剪辑编排器 · 任务', {
    window: leftover,
    preexisting: [leftover],
    allowWorkspace: true,
  }), true);
  assert.equal(windowLooksForbidden('Cursor Agents', '视频剪辑编排器 · 任务', {
    window: { name: 'Cursor Agents', position: [4, 148], size: [1281, 801] },
    allowAgentManager: true,
  }), false);
  assert.equal(windowLooksForbidden('Cursor Agents', '视频剪辑编排器 · 任务', {
    window: { name: 'Cursor Agents', position: [4, 148], size: [1281, 801] },
  }), true);
  const automation = require('node:fs').readFileSync(
    path.join(ROOT, 'src/services/cursor-automation-service.js'),
    'utf8',
  );
  assert.match(automation, /name === needle/);
  assert.doesNotMatch(automation, /name\.indexOf\(needle\)/);
});

test('prompt verified injection 才算成功，injected 不能单独过关', () => {
  const ipc = require('node:fs').readFileSync(path.join(ROOT, 'src/ipc/handoff-ipc.js'), 'utf8');
  assert.match(ipc, /verified === true/);
  assert.match(ipc, /verified && submitted/);
  assert.match(ipc, /scanning_media/);
  const automation = require('node:fs').readFileSync(
    path.join(ROOT, 'src/services/cursor-automation-service.js'),
    'utf8',
  );
  assert.match(automation, /copiedLooksLikePrompt/);
  assert.match(automation, /readFocusedComposer/);
  assert.match(automation, /PROMPT_SUBMIT_UNCONFIRMED/);
  assert.equal(composerHoldsUnsentPrompt({
    role: 'AXTextArea',
    value: '执行视频剪辑任务 demo（attempt abc）。\n\n本次额外要求：\n留着\n\n完成后按任务清单写回结果和状态。',
  }, 'abc', '执行视频剪辑任务 demo（attempt abc）。\n\n本次额外要求：\n留着\n\n完成后按任务清单写回结果和状态。'), true);
  assert.equal(composerHoldsUnsentPrompt({
    role: 'AXStaticText',
    value: '执行视频剪辑任务 demo（attempt abc）。\n\n本次额外要求：\n留着\n\n完成后按任务清单写回结果和状态。',
  }, 'abc', '执行视频剪辑任务 demo（attempt abc）。\n\n本次额外要求：\n留着\n\n完成后按任务清单写回结果和状态。'), false);
  assert.equal(focusedComposerLooksLikeAgent({ role: 'AXTextArea', description: 'Agent input' }), true);
  assert.equal(focusedComposerLooksLikeAgent({ role: 'AXTextField', description: 'Agent input' }), true);
  assert.equal(focusedComposerLooksLikeAgent({ role: 'AXTextField', description: 'Search files' }), false);
  assert.doesNotMatch(automation, /ok: last\?\.injected === true/);
});

test('同一 taskId + attemptId 严格 single-flight，running 后不再保留 UI 自动化', async () => {
  let calls = 0;
  const work = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, submitted: true, windowName: '视频剪辑编排器 · 任务' };
  };
  const first = runCursorHandoffController({ taskId: 'task-1', attemptId: 'attempt-1' }, work);
  const second = runCursorHandoffController({ taskId: 'task-1', attemptId: 'attempt-1' }, work);
  const [left, right] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(left, right);
  assert.equal(getCursorHandoffController('task-1', 'attempt-1').phase, 'running');
  assert.equal(getCursorHandoffController('task-1', 'attempt-1').uiAutomationActive, false);
  assert.equal(destroyCursorHandoffController('task-1', 'attempt-1', 'completed'), true);
  assert.equal(getCursorHandoffController('task-1', 'attempt-1'), null);
});

test('handoff controller 失败后立即销毁，可由同一 attempt 显式重试', async () => {
  await assert.rejects(
    runCursorHandoffController({ taskId: 'task-2', attemptId: 'attempt-1' }, async () => {
      throw new Error('inject failed');
    }),
    /inject failed/,
  );
  assert.equal(getCursorHandoffController('task-2', 'attempt-1'), null);
  const result = await runCursorHandoffController(
    { taskId: 'task-2', attemptId: 'attempt-1' },
    async () => ({ ok: true, submitted: false }),
  );
  assert.equal(result.ok, true);
  assert.equal(getCursorHandoffController('task-2', 'attempt-1'), null);
});

test('重试注入复用同一 attempt 窗口，不把 cursor-package 当工作区', async () => {
  const paths = await fixture();
  let task = await createCursorTask(paths);
  const attemptId = task.currentAttempt.attemptId;
  task = await updateHandoffTask(task.taskFilePath, {
    status: 'launching_cursor',
    cursorSession: {
      active: true,
      taskId: task.taskId,
      attemptId,
      workspace: ROOT,
      windowName: 'video-cut-planner-v3',
      fingerprint: 'name:video-cut-planner-v3|pos:12,12|size:900,700',
    },
  });
  const plan = buildCursorLaunchPlan(task);
  assert.equal(plan.reuseSession, true);
  assert.equal(isReusableCursorSession(plan.session, { attemptId, taskId: task.taskId }), true);
  const again = buildCursorLaunchPlan(task);
  assert.equal(again.reuseSession, true);
  assert.equal(again.workspace, ROOT);
  assert.match(again.openArgs.join(' '), /\.code-workspace$/);
  assert.equal(again.openArgs.includes(ROOT), false);
});

test('新 attempt 使用不同窗口工作区文件，同一 attempt 路径保持稳定', async () => {
  const paths = await fixture();
  const task = await createCursorTask(paths);
  const first = buildCursorLaunchPlan(task).windowWorkspacePath;
  const again = buildCursorLaunchPlan(task).windowWorkspacePath;
  assert.equal(first, again);
  assert.match(first, new RegExp(`cursor-window-${task.currentAttempt.attemptId}\\.code-workspace$`));
  assert.match(first, /[/\\]cursor-windows[/\\]/);
  assert.doesNotMatch(first, /\.cursor-package/);
  const resumed = await startAgentAttempt(task.taskFilePath, {
    engine: 'cursor_agent',
    reason: 'retry_new_attempt',
  });
  const next = buildCursorLaunchPlan(resumed).windowWorkspacePath;
  assert.notEqual(next, first);
  assert.match(next, new RegExp(`cursor-window-${resumed.currentAttempt.attemptId}\\.code-workspace$`));
});

test('任务完成后窗口关联失效，旧窗口不再是活跃证据', async () => {
  const paths = await fixture();
  let task = await createCursorTask(paths);
  const attemptId = task.currentAttempt.attemptId;
  task = await updateHandoffTask(task.taskFilePath, { status: 'launching_cursor' });
  task = await updateHandoffTask(task.taskFilePath, {
    status: 'scanning_media',
    cursorSession: {
      active: true,
      taskId: task.taskId,
      attemptId,
      windowName: 'video-cut-planner-v3',
      fingerprint: 'id:42',
      windowId: 42,
    },
  });
  assert.equal(task.cursorSession.active, true);
  const completed = await updateHandoffTask(task.taskFilePath, { status: 'completed' });
  assert.equal(completed.cursorSession.active, false);
  const probe = await probeTaskWindow(completed, {
    windows: [{ name: 'video-cut-planner-v3', id: 42 }],
  });
  assert.equal(probe.taskWindowExists, false);
  const canceledTask = await createCursorTask(paths);
  const canceled = await updateHandoffTask(canceledTask.taskFilePath, {
    status: 'cancelled',
    cursorSession: {
      active: true,
      attemptId: canceledTask.currentAttempt.attemptId,
      windowName: 'video-cut-planner-v3',
    },
  });
  assert.equal(canceled.cursorSession.active, false);
});

test('canceled / failed / disconnected package 生命周期与清理策略', async () => {
  const paths = await fixture();
  const running = await createCursorTask(paths);
  const disconnected = await createCursorTask(paths);
  await updateHandoffTask(disconnected.taskFilePath, { status: 'launching_cursor' });
  await updateHandoffTask(disconnected.taskFilePath, { status: 'scanning_media' });
  const parked = await updateHandoffTask(disconnected.taskFilePath, { status: 'agent_disconnected' });
  const failed = await createCursorTask(paths);
  await updateHandoffTask(failed.taskFilePath, { status: 'launching_cursor' });
  const failedTask = await updateHandoffTask(failed.taskFilePath, {
    status: 'failed',
    errors: [{ message: '分析失败' }],
  });
  const completed = await createCursorTask(paths);
  await updateHandoffTask(completed.taskFilePath, { status: 'launching_cursor' });
  const done = await updateHandoffTask(completed.taskFilePath, { status: 'completed' });
  const canceled = await createCursorTask(paths);
  const cancelledTask = await updateHandoffTask(canceled.taskFilePath, { status: 'cancelled' });

  assert.equal(packageRetentionOf(running), PACKAGE_RETENTION.retain);
  assert.equal(packageRetentionOf(parked), PACKAGE_RETENTION.retain_recovery);
  assert.equal(packageRetentionOf(failedTask), PACKAGE_RETENTION.retain_diagnostics);
  assert.equal(packageRetentionOf(done), PACKAGE_RETENTION.sweepable);
  assert.equal(packageRetentionOf(cancelledTask), PACKAGE_RETENTION.sweepable);

  const recentSweep = await sweepHandoffPackages(paths.userData, { now: Date.now(), maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
  assert.equal(recentSweep.swept.length, 0);
  assert.ok(await fs.access(parked.cursorPackagePath).then(() => true));
  assert.ok(await fs.access(failedTask.cursorPackagePath).then(() => true));

  const oldSweep = await sweepHandoffPackages(paths.userData, {
    now: Date.now() + 8 * 24 * 60 * 60 * 1000,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  });
  const sweptIds = oldSweep.swept.map((item) => item.taskId).sort();
  assert.deepEqual(sweptIds, [cancelledTask.taskId, done.taskId].sort());
  await assert.rejects(fs.access(done.cursorPackagePath));
  await assert.rejects(fs.access(cancelledTask.cursorPackagePath));
  assert.ok(await fs.access(parked.cursorPackagePath).then(() => true));
  assert.ok(await fs.access(failedTask.cursorPackagePath).then(() => true));
  assert.ok(await fs.access(running.cursorPackagePath).then(() => true));
  assert.ok(await fs.access(parked.taskFilePath).then(() => true));
  assert.ok(await fs.access(done.taskFilePath).then(() => true));
});

test('失败任务可以重新使用 Cursor，且交接包仍可内部读取', async () => {
  const paths = await fixture();
  let task = await createCursorTask(paths);
  await updateHandoffTask(task.taskFilePath, { status: 'launching_cursor' });
  task = await updateHandoffTask(task.taskFilePath, {
    status: 'failed',
    errors: [{ message: '分析结果未通过' }],
  });
  const resumed = await startAgentAttempt(task.taskFilePath, {
    engine: 'cursor_agent',
    reason: 'resume_after_failure',
    extraRequirements: '',
  });
  assert.equal(resumed.engine, 'cursor_agent');
  assert.notEqual(resumed.currentAttempt.attemptId, task.currentAttempt.attemptId);
  assert.match(resumed.prompt, /CURSOR_E2E_EXTRA_REQUIREMENT_DO_NOT_REWRITE/);
  const packed = await writeCursorAgentPackage(resumed);
  assert.equal(packed.packageDir, resumed.cursorPackagePath);
  const manifest = JSON.parse(await fs.readFile(resumed.taskManifestPath, 'utf8'));
  assert.equal(manifest.packageDir, resumed.cursorPackagePath);
  assert.equal(manifest.writeback.packageDir, resumed.cursorPackagePath);
});
