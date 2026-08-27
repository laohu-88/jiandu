const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildCompactAgentPrompt,
  promptContainsFixedRules,
  skillPathFor,
} = require('../src/services/agent-prompt-builder');
const {
  USER_STATUS,
  blockingErrors,
  userFacingStatus,
} = require('../src/services/agent-bridge-service');
const { createHandoffTask } = require('../src/services/handoff-task-service');
const {
  snapshotSource,
} = require('../src/services/pending-media-service');
const {
  deriveUserStatus,
  buildAppRouteState,
  PROJECT_PAGES,
} = require('../src/view-models/workspace-view-model');

const ROOT = path.resolve(__dirname, '..');

async function tempTask() {
  const userData = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jiandu-handoff-'));
  const pendingRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jiandu-pending-'));
  const sourceDirectory = path.join(pendingRoot, '2026-07-20 示例专题');
  await fs.promises.mkdir(sourceDirectory, { recursive: true });
  return { userData, pendingRoot, sourceDirectory };
}

test('无本地 AI 产品 IPC / preload 能力', () => {
  const register = fs.readFileSync(path.join(ROOT, 'src/ipc/register.js'), 'utf8');
  assert.doesNotMatch(register, /registerAiIpc|ai-ipc|registerStageIpc|registerEditIpc|registerPlatformVariantIpc/);
  const preload = fs.readFileSync(path.join(ROOT, 'src/preload.js'), 'utf8');
  assert.doesNotMatch(preload, /ai:check-environment|checkAiEnvironment|mlxPythonPath/);
  assert.equal(fs.existsSync(path.join(ROOT, 'src/services/ai-environment-service.js')), false);
});

test('薄壳工作区只保留 brief / processing / results 三页', () => {
  const state = buildAppRouteState({});
  assert.equal(state.engine, 'codex');
  assert.deepEqual(PROJECT_PAGES.map((item) => item.id), ['brief', 'processing', 'results']);
  const tasks = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/workspace/task-pages.js'), 'utf8');
  assert.match(tasks, /开始剪辑/);
  assert.match(tasks, /在 Final Cut Pro 中打开/);
  assert.match(tasks, /让 AI 再改一次/);
  assert.doesNotMatch(tasks, /批准当前抖音方案/);
});

test('本次额外要求原样进入精炼 prompt，且不重复固定规则', async () => {
  const extra = '第二条开头换成狗\n字幕往上';
  const prompt = buildCompactAgentPrompt({
    taskId: '11111111-1111-4111-8111-111111111111',
    skillPath: '/tmp/SKILL.md',
    taskManifestPath: '/tmp/task.json',
    extraRequirements: extra,
  });
  assert.match(prompt, /执行视频剪辑任务 11111111-1111-4111-8111-111111111111/);
  assert.match(prompt, /固定剪辑 Skill：\/tmp\/SKILL.md/);
  assert.equal(prompt.includes(extra), true);
  assert.equal(promptContainsFixedRules(prompt), false);

  const paths = await tempTask();
  const task = await createHandoffTask(paths.userData, {
    pendingRoot: paths.pendingRoot,
    sourceDirectory: paths.sourceDirectory,
    sourceSnapshot: await snapshotSource(paths.sourceDirectory),
    sourceSummary: { name: '一期' },
    appWorkspace: ROOT,
    hyperframesMode: 'auto',
    engine: 'codex',
    extraRequirements: extra,
  });
  assert.equal(task.extraRequirements, extra);
  assert.equal(task.prompt.includes(extra), true);
  assert.equal(promptContainsFixedRules(task.prompt), false);
  const manifest = JSON.parse(await fs.promises.readFile(task.taskManifestPath, 'utf8'));
  assert.equal(manifest.extraRequirements, extra);
  assert.equal(manifest.skillPath, skillPathFor(ROOT));
});

test('Codex 完成、失败、失联回流状态模型', () => {
  assert.equal(userFacingStatus({ status: 'awaiting_user_send' }).id, USER_STATUS.processing.id);
  assert.equal(userFacingStatus({ status: 'completed' }).id, USER_STATUS.results_ready.id);
  assert.equal(userFacingStatus({ status: 'completed', openedInFcpAt: 't' }).id, USER_STATUS.in_fcp.id);
  assert.equal(userFacingStatus({ status: 'failed' }).id, USER_STATUS.blocked.id);
  assert.equal(userFacingStatus({ status: 'agent_disconnected' }).id, USER_STATUS.agent_disconnected.id);
  assert.equal(deriveUserStatus({ task: { status: 'failed' } }), 'blocked');
  assert.equal(deriveUserStatus({ task: { status: 'agent_disconnected' } }), 'agent_disconnected');
  assert.equal(blockingErrors({ errors: [{ message: '媒体缺失' }] }).length, 1);
});
