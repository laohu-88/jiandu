const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ProtocolQueue,
  buildReturnUrl,
  openReturnUrl,
  parseReturnUrl,
  protocolUrlFromArgv,
} = require('../src/protocol-service');

const TASK_ID = '7ac0cd4b-e53b-46a5-b1dd-26582841f288';

test('合法回流 URL 只携带 UUID，不接受路径、查询或外部 URL', () => {
  const url = buildReturnUrl(TASK_ID);
  assert.equal(url, `video-cut-planner://handoff/${TASK_ID}`);
  assert.equal(parseReturnUrl(url).taskId, TASK_ID);
  const invalid = [
    'video-cut-planner://handoff/not-a-uuid',
    `video-cut-planner://handoff/${TASK_ID}?path=/tmp/x`,
    `video-cut-planner://handoff/${TASK_ID}#x`,
    'video-cut-planner://handoff/%2e%2e',
    `video-cut-planner://handoff/ignored/../${TASK_ID}`,
    'video-cut-planner://evil/7ac0cd4b-e53b-46a5-b1dd-26582841f288',
    'https://example.com/',
    'video-cut-planner://handoff/7ac0cd4b-e53b-46a5-b1dd-26582841f288/extra',
  ];
  for (const value of invalid) assert.throws(() => parseReturnUrl(value));
});

test('ready 前队列、ready 后 drain 和重复回流保持幂等', async () => {
  const queue = new ProtocolQueue();
  assert.equal(queue.enqueue(buildReturnUrl(TASK_ID)).duplicate, false);
  assert.equal(queue.enqueue(buildReturnUrl(TASK_ID)).duplicate, true);
  const handled = [];
  await queue.drain(async (entry) => handled.push(entry.taskId));
  assert.deepEqual(handled, [TASK_ID]);
  assert.equal(queue.enqueue(buildReturnUrl(TASK_ID)).duplicate, false);
});

test('second-instance argv 只提取自身协议', () => {
  const url = buildReturnUrl(TASK_ID);
  assert.equal(protocolUrlFromArgv(['app', '--flag', url]), url);
  assert.equal(protocolUrlFromArgv(['app', 'codex://threads/new']), null);
});

test('回流启动使用 /usr/bin/open 和参数数组', async () => {
  const calls = [];
  const result = await openReturnUrl(TASK_ID, {
    allowNonDarwin: true,
    execFileImpl: async (command, args, options) => calls.push({ command, args, options }),
  });
  assert.equal(result.opened, true);
  assert.deepEqual(calls[0].command, '/usr/bin/open');
  assert.deepEqual(calls[0].args, [buildReturnUrl(TASK_ID)]);
});

test('主进程提前注册 open-url、单实例和稳定 userData', async () => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const source = await fs.readFile(path.join(__dirname, '../src/main.js'), 'utf8');
  const openUrlIndex = source.indexOf("app.on('open-url'");
  const readyIndex = source.indexOf('app.whenReady()');
  assert.ok(openUrlIndex > 0 && openUrlIndex < readyIndex);
  assert.match(source, /requestSingleInstanceLock/);
  assert.match(source, /second-instance/);
  assert.match(source, /stableUserDataPath/);
  assert.match(source, /isMinimized\(\).*restore\(\)/s);
  assert.doesNotMatch(source, /appWorkspace:\s*path\.resolve\(__dirname/);
});
