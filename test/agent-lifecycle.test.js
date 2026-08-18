'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  HEARTBEAT_STALE_MS,
  LIFECYCLE,
  assertWriteAllowed,
  canCancel,
  createAttempt,
  engineSelectionLocked,
  evaluateLiveness,
  hydrateAttempts,
  lifecycleOf,
  processingViewModel,
  recoveryActions,
} = require('../src/services/agent-lifecycle-service');
const {
  cancelHandoffTask,
  createHandoffTask,
  markAgentDisconnected,
  readHandoffTask,
  startAgentAttempt,
  updateHandoffTask,
} = require('../src/services/handoff-task-service');
const {
  USER_STATUS,
  reconcileActiveTasks,
  userFacingStatus,
} = require('../src/services/agent-bridge-service');
const { snapshotSource } = require('../src/services/pending-media-service');
const { deriveUserStatus } = require('../src/view-models/workspace-view-model');
const { matchesEngine } = require('../src/services/agent-runtime-service');

const ROOT = path.resolve(__dirname, '..');

async function fixture() {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lifecycle-')));
  const pendingRoot = path.join(temp, '视频待处理');
  const sourceDirectory = path.join(pendingRoot, '一期');
  const userData = path.join(temp, 'user');
  await fs.mkdir(sourceDirectory, { recursive: true });
  await fs.writeFile(path.join(sourceDirectory, 'a.txt'), 'x');
  return { temp, pendingRoot, sourceDirectory, userData };
}

async function createTask(paths, overrides = {}) {
  return createHandoffTask(paths.userData, {
    pendingRoot: paths.pendingRoot,
    sourceDirectory: paths.sourceDirectory,
    sourceSnapshot: await snapshotSource(paths.sourceDirectory),
    sourceSummary: { name: '一期' },
    appWorkspace: ROOT,
    hyperframesMode: 'auto',
    engine: 'codex',
    extraRequirements: '第二条开头换成狗',
    ...overrides,
  });
}

function runningTask(overrides = {}) {
  const now = new Date().toISOString();
  const attempt = createAttempt({
    engine: 'codex',
    now,
    status: LIFECYCLE.running,
    generation: 1,
  });
  attempt.launchAttemptedAt = now;
  attempt.lastActivityAt = now;
  return hydrateAttempts({
    taskId: attempt.attemptId,
    engine: 'codex',
    status: 'analyzing_media',
    stage: 'analyzing_media',
    launchedAt: now,
    lastHeartbeatAt: now,
    updatedAt: now,
    currentAttempt: attempt,
    attempts: [attempt],
    ...overrides,
  });
}

test('lifecycle 映射覆盖 preparing/handed_off/running/终态/失联', () => {
  assert.equal(lifecycleOf({ status: 'ready' }), LIFECYCLE.preparing);
  assert.equal(lifecycleOf({ status: 'awaiting_user_send' }), LIFECYCLE.handed_off);
  assert.equal(lifecycleOf({ status: 'analyzing_media' }), LIFECYCLE.running);
  assert.equal(lifecycleOf({ status: 'analysis_needs_correction' }), LIFECYCLE.analysis_needs_correction);
  assert.equal(lifecycleOf({ status: 'completed' }), LIFECYCLE.completed);
  assert.equal(lifecycleOf({ status: 'failed' }), LIFECYCLE.failed);
  assert.equal(lifecycleOf({ status: 'cancelled' }), LIFECYCLE.canceled);
  assert.equal(lifecycleOf({ status: 'agent_disconnected' }), LIFECYCLE.agent_disconnected);
});

test('analysis 合同失败保持同一 attempt 可修正、可取消且重启后可恢复', async () => {
  const paths = await fixture();
  let task = await createTask(paths, { engine: 'cursor_agent' });
  const attemptId = task.currentAttempt.attemptId;
  task = await updateHandoffTask(task.taskFilePath, {
    status: 'analysis_needs_correction',
    attemptId,
    stageMessage: '分析合同校验未通过，正在等待 Agent 修正后再次校验。',
    validationIssues: [{ code: 'INVALID_VIDEO_ANALYSIS', message: 'warnings 缺失' }],
  });
  assert.equal(task.currentAttempt.attemptId, attemptId);
  assert.equal(task.lifecycle, LIFECYCLE.analysis_needs_correction);
  assert.equal(canCancel(task), true);
  assert.equal(processingViewModel(task).title, 'Cursor 正在修正分析');
  assert.equal(deriveUserStatus({ task }), 'processing');

  const afterRestart = await readHandoffTask(task.taskFilePath);
  assert.equal(afterRestart.status, 'analysis_needs_correction');
  assert.equal(afterRestart.validationIssues.length, 1);

  task = await updateHandoffTask(task.taskFilePath, {
    status: 'analysis_needs_correction',
    attemptId,
    validationIssues: [{ code: 'INVALID_VIDEO_ANALYSIS', message: '字幕 marker 缺失' }],
  });
  assert.equal(task.currentAttempt.attemptId, attemptId);
  task = await updateHandoffTask(task.taskFilePath, {
    status: 'analysis_complete',
    attemptId,
    validationIssues: [],
  });
  assert.equal(task.currentAttempt.attemptId, attemptId);
  assert.deepEqual(task.validationIssues, []);

  const correction = await updateHandoffTask(task.taskFilePath, {
    status: 'analysis_needs_correction',
    attemptId,
    validationIssues: [{ code: 'INVALID_VIDEO_ANALYSIS', message: '再次修正' }],
  }).catch((error) => error);
  assert.equal(correction.code, 'INVALID_HANDOFF_TRANSITION');
});

test('correction 状态下取消保持终态；failed recovery 保留旧 attempt 并记录复用谱系', async () => {
  const paths = await fixture();
  let task = await createTask(paths, { engine: 'cursor_agent' });
  task = await updateHandoffTask(task.taskFilePath, {
    status: 'analysis_needs_correction',
    validationIssues: [{ code: 'INVALID_VIDEO_ANALYSIS', message: '待修正' }],
  });
  const canceled = await cancelHandoffTask(task.taskFilePath);
  assert.equal(canceled.status, 'cancelled');
  assert.equal((await cancelHandoffTask(task.taskFilePath)).status, 'cancelled');

  task = await createTask(paths, { engine: 'cursor_agent' });
  task = await updateHandoffTask(task.taskFilePath, {
    status: 'failed',
    artifacts: { analysisPath: '/tmp/reused-analysis.json', manifestPath: '/tmp/reused-manifest.json' },
    errors: [{ code: 'AGENT_FAILURE', message: '明确失败' }],
  });
  const failedAttemptId = task.currentAttempt.attemptId;
  const recovery = await startAgentAttempt(task.taskFilePath, {
    engine: 'codex',
    reason: 'recovery_after_failure',
  });
  const old = recovery.attempts.find((item) => item.attemptId === failedAttemptId);
  assert.equal(old.status, LIFECYCLE.failed);
  assert.equal(recovery.currentAttempt.previousAttemptId, failedAttemptId);
  assert.equal(recovery.currentAttempt.recoveryReason, 'recovery_after_failure');
  assert.equal(recovery.currentAttempt.reusedAnalysis, true);
  assert.equal(recovery.currentAttempt.generation, 2);
  assert.equal(recovery.currentAttempt.reusableArtifacts.analysisPath, '/tmp/reused-analysis.json');
  await assert.rejects(
    updateHandoffTask(recovery.taskFilePath, { status: 'completed', attemptId: failedAttemptId }),
    /迟到回写/,
  );
});

test('running Agent 正常 heartbeat 保持 live', () => {
  const task = runningTask();
  const now = Date.parse(task.lastHeartbeatAt);
  const liveness = evaluateLiveness(task, { processExists: true }, now + 1_000);
  assert.equal(liveness.live, true);
  assert.equal(liveness.disconnected, false);
  assert.equal(liveness.reason, 'heartbeat');
});

test('Codex 关闭 → disconnected，不依赖超长超时', () => {
  const task = runningTask();
  const liveness = evaluateLiveness(task, { processExists: false }, Date.parse(task.lastHeartbeatAt) + 5_000);
  assert.equal(liveness.disconnected, true);
  assert.equal(liveness.reason, 'process_missing');
});

test('Cursor 关闭且无近期写回 → disconnected', () => {
  const task = runningTask({ engine: 'cursor_agent', status: 'planning_story', stage: 'planning_story' });
  task.engine = 'cursor_agent';
  task.currentAttempt.engine = 'cursor_agent';
  const liveness = evaluateLiveness(task, {
    processExists: true,
    taskWindowExists: false,
    windowProbeOk: true,
    sessionExists: false,
  }, Date.parse(task.lastHeartbeatAt) + HEARTBEAT_STALE_MS + 5_000);
  assert.equal(liveness.disconnected, true);
  assert.equal(liveness.reason, 'window_missing');
});

test('Cursor 窗口暂时无法匹配但刚有状态写回时保持 running', () => {
  const task = runningTask({ engine: 'cursor_agent', status: 'analyzing_media', stage: 'analyzing_media' });
  task.engine = 'cursor_agent';
  task.currentAttempt.engine = 'cursor_agent';
  const liveness = evaluateLiveness(task, {
    processExists: true,
    taskWindowExists: false,
    windowProbeOk: true,
    sessionExists: false,
  }, Date.parse(task.lastHeartbeatAt) + 15_000);
  assert.equal(liveness.live, true);
  assert.equal(liveness.disconnected, false);
  assert.equal(liveness.reason, 'heartbeat');
});

test('Cursor 任务窗口存在但心跳过期 → disconnected', () => {
  const task = runningTask({ engine: 'cursor_agent', status: 'planning_story', stage: 'planning_story' });
  task.engine = 'cursor_agent';
  task.currentAttempt.engine = 'cursor_agent';
  const liveness = evaluateLiveness(task, {
    processExists: true,
    taskWindowExists: true,
    windowProbeOk: true,
    sessionExists: true,
  }, Date.parse(task.lastHeartbeatAt) + HEARTBEAT_STALE_MS + 60_000);
  assert.equal(liveness.live, false);
  assert.equal(liveness.disconnected, true);
  assert.equal(liveness.reason, 'heartbeat_stale');
});

test('cancel 对任何未终态任务可用，并解锁 Agent 选择', async () => {
  const paths = await fixture();
  let task = await createTask(paths);
  task = await updateHandoffTask(task.taskFilePath, { status: 'launching_codex' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'awaiting_user_send' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'analyzing_media' });
  assert.equal(canCancel(task), true);
  assert.equal(engineSelectionLocked(task), true);
  const cancelled = await cancelHandoffTask(task.taskFilePath);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(canCancel(cancelled), false);
  assert.equal(engineSelectionLocked(cancelled), false);
  const again = await cancelHandoffTask(task.taskFilePath);
  assert.equal(again.status, 'cancelled');
  assert.equal(again.currentAttempt.invalidatedAt, cancelled.currentAttempt.invalidatedAt);
});

test('disconnected UI 文案与恢复动作', () => {
  const view = processingViewModel({
    engine: 'codex',
    status: 'agent_disconnected',
    stageMessage: 'Codex 已停止，任务未完成',
  });
  assert.equal(view.title, 'Codex 已停止，任务未完成');
  assert.equal(view.canCancel, true);
  assert.deepEqual(recoveryActions({ engine: 'codex', status: 'agent_disconnected' }).map((item) => item.label), [
    '继续使用 Codex',
    '改用 Cursor',
    '取消任务',
  ]);
  assert.deepEqual(recoveryActions({ engine: 'cursor_agent', status: 'agent_disconnected' }).map((item) => item.label), [
    '继续使用 Cursor',
    '改用 Codex',
    '取消任务',
  ]);
  assert.equal(userFacingStatus({ status: 'agent_disconnected' }).id, USER_STATUS.agent_disconnected.id);
  assert.equal(deriveUserStatus({ task: { status: 'agent_disconnected' } }), 'agent_disconnected');
  assert.equal(deriveUserStatus({ task: { status: 'failed' } }), 'blocked');
  assert.equal(deriveUserStatus({ task: { status: 'cancelled' } }), 'waiting_ai');
});

test('disconnected → Cursor / Codex 接管会新建 attempt 并隔离旧回写', async () => {
  const paths = await fixture();
  let task = await createTask(paths, { engine: 'codex' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'launching_codex' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'analyzing_media' });
  const oldAttemptId = task.currentAttempt.attemptId;
  task = await markAgentDisconnected(task.taskFilePath, 'process_missing');
  assert.equal(task.status, 'agent_disconnected');
  const cursor = await startAgentAttempt(task.taskFilePath, {
    engine: 'cursor_agent',
    reason: 'switch_engine',
  });
  assert.equal(cursor.engine, 'cursor_agent');
  assert.notEqual(cursor.currentAttempt.attemptId, oldAttemptId);
  assert.equal(cursor.currentAttempt.previousAttemptId, oldAttemptId);
  assert.equal(cursor.reusableResults.skipFullRescan, false);
  assert.match(cursor.prompt, /第二条开头换成狗/);
  assert.match(cursor.prompt, new RegExp(cursor.currentAttempt.attemptId));
  await assert.rejects(
    updateHandoffTask(cursor.taskFilePath, {
      status: 'completed',
      attemptId: oldAttemptId,
    }),
    /迟到回写/,
  );
  const afterLate = await readHandoffTask(cursor.taskFilePath);
  assert.equal(afterLate.status, 'launching_cursor');
  assert.equal(afterLate.currentAttempt.attemptId, cursor.currentAttempt.attemptId);

  const disconnectedCursor = await markAgentDisconnected(cursor.taskFilePath, 'process_missing');
  const codex = await startAgentAttempt(disconnectedCursor.taskFilePath, {
    engine: 'codex',
    reason: 'switch_engine',
  });
  assert.equal(codex.engine, 'codex');
  assert.notEqual(codex.currentAttempt.attemptId, cursor.currentAttempt.attemptId);
});

test('App 重启 stale running 修复，仍运行任务恢复，completed 自动续建', async () => {
  const paths = await fixture();
  const stale = await createTask(paths);
  await updateHandoffTask(stale.taskFilePath, { status: 'launching_codex' });
  await updateHandoffTask(stale.taskFilePath, { status: 'analyzing_media' });
  const live = await createTask(paths, { engine: 'cursor_agent' });
  await updateHandoffTask(live.taskFilePath, { status: 'launching_cursor' });
  await updateHandoffTask(live.taskFilePath, { status: 'scanning_media' });

  const now = Date.now();
  const payload = await reconcileActiveTasks(paths.userData, {
    now,
    probeTaskRuntime: async (task) => ({
      processExists: task.engine === 'cursor_agent',
      resultUpdatedRecently: false,
    }),
  });
  const staleResult = payload.recovered.find((item) => item.task.taskId === stale.taskId);
  const liveResult = payload.recovered.find((item) => item.task.taskId === live.taskId);
  assert.equal(staleResult.action, 'disconnected');
  assert.equal(staleResult.task.status, 'agent_disconnected');
  assert.equal(liveResult.action, 'running');
  assert.equal(liveResult.task.status, 'scanning_media');
});

test('多次回流幂等：同一终态 attempt 重复写回保持稳定', async () => {
  const paths = await fixture();
  let task = await createTask(paths);
  task = await updateHandoffTask(task.taskFilePath, { status: 'launching_codex' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'completed' });
  const first = await updateHandoffTask(task.taskFilePath, {
    status: 'completed',
    attemptId: task.currentAttempt.attemptId,
    returnState: { requestedAt: new Date().toISOString(), acknowledgedAt: null },
  });
  const second = await updateHandoffTask(first.taskFilePath, {
    status: 'completed',
    attemptId: first.currentAttempt.attemptId,
    returnState: { requestedAt: first.returnState.requestedAt, acknowledgedAt: new Date().toISOString() },
  });
  assert.equal(second.status, 'completed');
  await assert.rejects(
    updateHandoffTask(second.taskFilePath, { status: 'analyzing_media' }),
    /终态/,
  );
});

test('attemptId 隔离与 assertWriteAllowed', () => {
  const current = createAttempt({ engine: 'cursor_agent', generation: 2, status: LIFECYCLE.running });
  const task = {
    status: 'scanning_media',
    currentAttempt: current,
    attempts: [current],
  };
  assert.throws(
    () => assertWriteAllowed(task, { status: 'completed', attemptId: 'old-attempt' }),
    /迟到回写/,
  );
  const allowed = assertWriteAllowed(task, { status: 'extracting_metadata', attemptId: current.attemptId });
  assert.equal(allowed.currentAttempt.attemptId, current.attemptId);
});

test('Cursor prompt 注入结果必须 verified 才算通过', () => {
  const edit = require('node:fs').readFileSync(
    path.join(ROOT, 'src/renderer/modules/workspace/edit-workspace.js'),
    'utf8',
  );
  assert.match(edit, /cursorInject\.verified !== true/);
  assert.match(edit, /取消任务/);
  assert.match(edit, /改用 Cursor/);
  assert.match(edit, /继续使用 Codex/);
  const ipc = require('node:fs').readFileSync(path.join(ROOT, 'src/ipc/handoff-ipc.js'), 'utf8');
  assert.match(ipc, /verified === true/);
  assert.match(ipc, /handoff:takeover/);
  assert.match(ipc, /handoff:reconcile/);
  const cancelIpc = require('node:fs').readFileSync(path.join(ROOT, 'src/ipc/handoff-ipc.js'), 'utf8');
  assert.doesNotMatch(cancelIpc, /只有尚未进入生产的交接任务可以取消/);
  const automation = require('node:fs').readFileSync(
    path.join(ROOT, 'src/services/cursor-automation-service.js'),
    'utf8',
  );
  assert.match(automation, /copiedLooksLikePrompt/);
  assert.match(automation, /keystroke\("l", \{ using: \["command down", "shift down"\] \}\)/);
  assert.match(automation, /CURSOR_WINDOW_FORBIDDEN/);
  assert.match(automation, /keyCode\(36, \{ using: \["command down"\] \}\)/);
  const planSource = require('node:fs').readFileSync(
    path.join(ROOT, 'src/services/cursor-agent-handoff-service.js'),
    'utf8',
  );
  assert.match(planSource, /windowTitleNeedle/);
  assert.doesNotMatch(planSource, /'-g', `\$\{promptPath\}:1`/);
});

test('Cursor 窗口选择与 copy-back 验证拒绝假阳性', () => {
  const {
    copiedLooksLikePrompt,
    pickTargetWindowName,
  } = require('../src/services/cursor-automation-service');
  const needle = '096a92e6-884c-4255-813f-ea260d393588';
  const prompt = [
    `执行视频剪辑任务 demo（attempt ${needle}）。`,
    '',
    '本次额外要求：',
    '验收原样',
    '',
    '完成后按任务清单写回结果和状态。',
  ].join('\n');
  assert.equal(copiedLooksLikePrompt(prompt, needle, prompt), true);
  assert.equal(copiedLooksLikePrompt(prompt.replace('验收原样', '被改写'), needle, prompt), false);
  assert.equal(copiedLooksLikePrompt('筛选器(例如 text、!excludeText、text1,text2)', needle, prompt), false);
  assert.equal(copiedLooksLikePrompt('', needle, prompt), false);
  const chosen = pickTargetWindowName([
    'prompt.md — video-cut-planner-v3',
    'video-cut-planner-v3',
    '视频剪辑编排器 · 任务',
  ], '视频剪辑编排器 · 任务');
  assert.equal(chosen, '视频剪辑编排器 · 任务');
  assert.equal(
    pickTargetWindowName(
      [{ name: 'prompt.md — video-cut-planner-v3', position: [0, 0], size: [800, 600] }],
      '视频剪辑编排器 · 任务',
      { preexisting: [{ name: 'prompt.md — video-cut-planner-v3', position: [0, 0], size: [800, 600] }] },
    ),
    null,
  );
  assert.equal(
    pickTargetWindowName([
      { name: 'README.md — video-cut-planner-v3', position: [0, 0], size: [800, 600] },
      { name: '视频剪辑编排器 · 任务', position: [40, 40], size: [800, 600] },
    ], '视频剪辑编排器 · 任务', {
      preexisting: [{ name: 'README.md — video-cut-planner-v3', position: [0, 0], size: [800, 600] }],
    }),
    '视频剪辑编排器 · 任务',
  );
  assert.equal(
    pickTargetWindowName(
      [{ name: 'README.md — video-cut-planner-v3', position: [0, 0], size: [800, 600] }],
      '视频剪辑编排器 · 任务',
      { preexisting: [{ name: 'README.md — video-cut-planner-v3', position: [0, 0], size: [800, 600] }] },
    ),
    null,
  );
});

test('runtime 进程名识别 Codex / Cursor', () => {
  assert.equal(matchesEngine('Codex', 'codex'), true);
  assert.equal(matchesEngine('/Applications/Codex.app/Contents/MacOS/ChatGPT', 'codex'), true);
  assert.equal(matchesEngine('/Applications/Codex.app/Contents/Resources/cua_node/bin/node', 'codex'), false);
  assert.equal(matchesEngine('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', 'codex'), false);
  assert.equal(matchesEngine('/Applications/Cursor.app/Contents/MacOS/Cursor', 'cursor_agent'), true);
  assert.equal(matchesEngine('Safari', 'codex'), false);
});

test('Cursor 任务会话用已记录的 attempt 窗口识别，完成后不再把旧窗口当活跃证据', async () => {
  const { probeTaskWindow } = require('../src/services/agent-runtime-service');
  const attemptId = 'd4865b81-d08b-4739-bdb5-78710afa86a8';
  const active = await probeTaskWindow({
    engine: 'cursor_agent',
    status: 'scanning_media',
    currentAttempt: { attemptId },
    cursorSession: {
      active: true,
      attemptId,
      windowName: 'video-cut-planner-v3',
      fingerprint: 'name:video-cut-planner-v3|pos:10,10|size:800,600',
    },
  }, {
    windows: [
      { name: 'README.md — video-cut-planner-v3', position: [0, 0], size: [800, 600] },
      { name: 'video-cut-planner-v3', position: [10, 10], size: [800, 600] },
    ],
  });
  assert.equal(active.taskWindowExists, true);
  assert.equal(active.windowProbeOk, true);

  const finished = await probeTaskWindow({
    engine: 'cursor_agent',
    status: 'completed',
    currentAttempt: { attemptId },
    cursorSession: {
      active: false,
      attemptId,
      windowName: 'video-cut-planner-v3',
      fingerprint: 'name:video-cut-planner-v3|pos:10,10|size:800,600',
    },
    cursorPackagePath: '/tmp/d4865b81-d08b-4739-bdb5-78710afa86a8.cursor-package',
  }, {
    processes: [
      { pid: 1, command: 'Cursor Helper (Plugin): extension-host (user) d4865b81-d08b-4739-bdb5-78710afa86a8.cursor-package [6-66]' },
    ],
    windows: [{ name: 'video-cut-planner-v3', position: [10, 10], size: [800, 600] }],
  });
  assert.equal(finished.taskWindowExists, false);

  const legacy = await probeTaskWindow({
    engine: 'cursor_agent',
    status: 'scanning_media',
    cursorPackagePath: '/tmp/d4865b81-d08b-4739-bdb5-78710afa86a8.cursor-package',
  }, {
    processes: [
      { pid: 1, command: 'Cursor Helper (Plugin): extension-host (user) d4865b81-d08b-4739-bdb5-78710afa86a8.cursor-package [6-66]' },
    ],
  });
  assert.equal(legacy.taskWindowExists, true);
  assert.equal(legacy.legacyPackageProbe, true);
});

test('heartbeat stale 在进程仍在时也能失联', () => {
  const task = runningTask();
  const now = Date.parse(task.lastHeartbeatAt) + HEARTBEAT_STALE_MS + 1_000;
  const liveness = evaluateLiveness(task, { processExists: true, resultUpdatedRecently: false }, now);
  assert.equal(liveness.disconnected, true);
  assert.equal(liveness.reason, 'heartbeat_stale');
});
