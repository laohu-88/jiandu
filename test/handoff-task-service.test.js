const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertTransition,
  assertUserDataTask,
  buildCodexDeepLink,
  createHandoffTask,
  listHandoffTasks,
  loadHandoffSettings,
  readHandoffTask,
  readTaskEvents,
  saveHandoffSettings,
  updateHandoffTask,
} = require('../src/services/handoff-task-service');
const { snapshotSource } = require('../src/services/pending-media-service');

async function fixture() {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-service-')));
  const pendingRoot = path.join(temp, '视频待处理');
  const sourceDirectory = path.join(pendingRoot, '中文 一期:a');
  const userData = path.join(temp, 'user data');
  await fs.mkdir(sourceDirectory, { recursive: true });
  await fs.writeFile(path.join(sourceDirectory, '说明.txt'), '真实素材说明');
  return { temp, pendingRoot, sourceDirectory, userData };
}

async function createTask(paths, overrides = {}) {
  return createHandoffTask(paths.userData, {
    pendingRoot: paths.pendingRoot,
    sourceDirectory: paths.sourceDirectory,
    sourceSnapshot: await snapshotSource(paths.sourceDirectory),
    sourceSummary: { name: path.basename(paths.sourceDirectory), totalFileCount: 1 },
    appWorkspace: '/Users/example/Projects/video-cut-planner-v3',
    hyperframesMode: 'auto',
    autoOpenFcp: false,
    ...overrides,
  });
}

test('创建唯一任务、原子快照、事件日志、中文深链接和完整提示词', async () => {
  const paths = await fixture();
  const first = await createTask(paths);
  const second = await createTask(paths);
  assert.notEqual(first.taskId, second.taskId);
  assert.equal(first.status, 'ready');
  assert.equal(first.stage, 'ready');
  assert.match(first.prompt, /使用 \$video-cut-planner/);
  assert.match(first.prompt, new RegExp(first.taskId));
  assert.match(first.prompt, /--handoff-task/);
  assert.match(first.prompt, /不得修改、移动、重命名或删除原始素材/);
  const parsed = new URL(first.codexDeepLink);
  assert.equal(parsed.protocol, 'codex:');
  assert.equal(parsed.hostname, 'threads');
  assert.equal(parsed.pathname, '/new');
  assert.equal(parsed.searchParams.get('path'), '/Users/example/Projects/video-cut-planner-v3');
  assert.equal(parsed.searchParams.get('prompt'), first.prompt);
  assert.deepEqual((await readTaskEvents(first.taskFilePath)).map((event) => event.status), ['ready']);
  const files = await fs.readdir(path.dirname(first.taskFilePath));
  assert.equal(files.some((name) => name.endsWith('.tmp')), false);
});

test('任务状态只前进、心跳更新、终态不被普通阶段覆盖且事件保持时间顺序', async () => {
  const paths = await fixture();
  let task = await createTask(paths);
  task = await updateHandoffTask(task.taskFilePath, { status: 'launching_codex' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'awaiting_user_send' });
  task = await updateHandoffTask(task.taskFilePath, { status: 'scanning_media' });
  const heartbeat = task.lastHeartbeatAt;
  task = await updateHandoffTask(task.taskFilePath, {
    status: 'extracting_metadata',
    stageMessage: '真实 ffprobe 阶段',
  });
  assert.ok(Date.parse(task.lastHeartbeatAt) >= Date.parse(heartbeat));
  await assert.rejects(
    updateHandoffTask(task.taskFilePath, { status: 'scanning_media' }),
    /拒绝交接状态回退/,
  );
  task = await updateHandoffTask(task.taskFilePath, { status: 'failed', errors: [{ message: '测试失败' }] });
  await assert.rejects(
    updateHandoffTask(task.taskFilePath, { status: 'verifying' }),
    /终态交接任务不能被普通阶段覆盖/,
  );
  const events = await readTaskEvents(task.taskFilePath);
  assert.deepEqual(events.map((event) => event.status), [
    'ready', 'launching_codex', 'awaiting_user_send', 'scanning_media', 'extracting_metadata', 'failed',
  ]);
});

test('损坏任务单点隔离、尾部不完整事件忽略、应用重启可恢复任务', async () => {
  const paths = await fixture();
  const task = await createTask(paths);
  await fs.appendFile(task.taskFilePath.replace(/\.json$/, '.events.ndjson'), '{broken');
  await fs.writeFile(path.join(path.dirname(task.taskFilePath), '11111111-1111-4111-8111-111111111111.json'), '{');
  const payload = await listHandoffTasks(paths.userData);
  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.corrupt.length, 1);
  assert.equal((await readTaskEvents(task.taskFilePath)).length, 1);
  assert.equal((await readHandoffTask(task.taskFilePath)).taskId, task.taskId);
});

test('任务路径、素材直属目录、路径穿越和符号链接越界均被拒绝', async () => {
  const paths = await fixture();
  const task = await createTask(paths);
  await assert.rejects(
    assertUserDataTask(paths.userData, path.join(paths.temp, 'outside.json')),
    /handoffs 目录之外/,
  );
  const nested = path.join(paths.sourceDirectory, '内部目录');
  await fs.mkdir(nested);
  await assert.rejects(createTask(paths, { sourceDirectory: nested }), /直属一期素材/);
  const outside = path.join(paths.temp, 'outside-source');
  const link = path.join(paths.pendingRoot, '链接一期');
  await fs.mkdir(outside);
  await fs.symlink(outside, link);
  await assert.rejects(createTask(paths, { sourceDirectory: link }), /直属一期素材/);
  assert.equal((await assertUserDataTask(paths.userData, task.taskFilePath)).taskId, task.taskId);
});

test('自动打开 FCP 设置默认关闭并持久化', async () => {
  const paths = await fixture();
  assert.equal((await loadHandoffSettings(paths.userData)).autoOpenFcp, false);
  await saveHandoffSettings(paths.userData, { autoOpenFcp: true });
  assert.equal((await loadHandoffSettings(paths.userData)).autoOpenFcp, true);
  await saveHandoffSettings(paths.userData, { autoOpenFcp: false });
  assert.equal((await loadHandoffSettings(paths.userData)).autoOpenFcp, false);
});

test('深链接长度限制和状态转换校验拒绝危险输入', () => {
  assert.throws(() => buildCodexDeepLink('x'.repeat(40_000), '/tmp'), /深链接过长/);
  assert.throws(() => assertTransition('ready', 'unknown'), /非法交接状态/);
  assert.throws(() => assertTransition('verifying', 'planning_story'), /状态回退/);
});
