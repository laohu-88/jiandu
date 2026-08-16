'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildCompactAgentPrompt,
  buildTaskManifest,
  promptContainsFixedRules,
  skillPathFor,
} = require('../src/services/agent-prompt-builder');
const {
  parseMetadataFields,
  extractHotIngestHtmlFields,
  scanCanonicalInventory,
  buildCanonicalInventory,
} = require('../src/services/hotingest-adapter');
const { ingestHotIngestContexts } = require('../src/services/hotingest-context-service');
const {
  buildAgentPrompt,
  createHandoffTask,
} = require('../src/services/handoff-task-service');
const {
  checkAccessibilityPermission,
  withClipboard,
} = require('../src/services/cursor-automation-service');
const {
  USER_STATUS,
  userFacingStatus,
  blockingErrors,
} = require('../src/services/agent-bridge-service');
const { snapshotSource } = require('../src/services/pending-media-service');
const {
  NAV_ITEMS,
  PROJECT_PAGES,
  buildAppRouteState,
  deriveUserStatus,
} = require('../src/view-models/workspace-view-model');

const ROOT = path.resolve(__dirname, '..');
const REAL_HOTINGEST = '/Users/example/Desktop/视频素材库/我做了个“全球热料采集机”：自动找素材并下载，已跑完两期/HotIngest搭建及初步成果/HotIngest两期成果/2026-07-20';

async function tempTask() {
  const temp = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-first-')));
  const pendingRoot = path.join(temp, '视频待处理');
  const sourceDirectory = path.join(pendingRoot, '一期');
  await fs.promises.mkdir(sourceDirectory, { recursive: true });
  await fs.promises.writeFile(path.join(sourceDirectory, 'a.txt'), 'x');
  return { temp, pendingRoot, sourceDirectory, userData: path.join(temp, 'user') };
}

test('主导航只有待处理、项目、设置，无旧版入口文案', () => {
  assert.deepEqual(NAV_ITEMS.map((item) => item.label), ['待处理', '项目', '设置']);
  assert.equal(NAV_ITEMS.some((item) => item.id === 'tasks'), false);
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  assert.doesNotMatch(html, /打开素材筛选台/);
  assert.doesNotMatch(html, /STAGE 6A|STAGE 6B/);
  assert.doesNotMatch(html, /asset-view-model/);
  assert.match(html, /开始 AI 剪辑|pageBrief/);
  const settings = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/workspace/settings-page.js'), 'utf8');
  assert.doesNotMatch(settings, /检查 AI 环境|Ollama|mlxPythonPath|本地大模型/);
  assert.match(settings, /Cursor \/ Codex/);
});

test('无本地 AI 产品 IPC / preload 能力', () => {
  const register = fs.readFileSync(path.join(ROOT, 'src/ipc/register.js'), 'utf8');
  assert.doesNotMatch(register, /registerAiIpc|ai-ipc/);
  const preload = fs.readFileSync(path.join(ROOT, 'src/preload.js'), 'utf8');
  assert.doesNotMatch(preload, /ai:check-environment|checkAiEnvironment|mlxPythonPath/);
  assert.equal(fs.existsSync(path.join(ROOT, 'src/services/ai-environment-service.js')), false);
});

test('抖音是默认工作区模式，高级调整不是主流程', () => {
  const state = buildAppRouteState({});
  assert.equal(state.platformMode, 'douyin');
  assert.equal(state.engine, 'cursor_agent');
  assert.deepEqual(PROJECT_PAGES.map((item) => item.id), ['brief', 'processing', 'results', 'advanced']);
  const edit = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/workspace/edit-workspace.js'), 'utf8');
  assert.match(edit, /开始 AI 剪辑/);
  assert.match(edit, /在 Final Cut Pro 中打开/);
  assert.match(edit, /让 AI 再调整/);
  assert.match(edit, /高级调整/);
  assert.doesNotMatch(edit, /批准当前抖音方案/);
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
  assert.doesNotMatch(prompt, /不得修改、移动、重命名或删除原始素材/);

  const paths = await tempTask();
  const task = await createHandoffTask(paths.userData, {
    pendingRoot: paths.pendingRoot,
    sourceDirectory: paths.sourceDirectory,
    sourceSnapshot: await snapshotSource(paths.sourceDirectory),
    sourceSummary: { name: '一期' },
    appWorkspace: ROOT,
    hyperframesMode: 'auto',
    engine: 'cursor_agent',
    extraRequirements: extra,
  });
  assert.equal(task.extraRequirements, extra);
  assert.equal(task.prompt.includes(extra), true);
  assert.equal(promptContainsFixedRules(task.prompt), false);
  assert.equal(task.platformMode, 'douyin');
  const manifest = JSON.parse(await fs.promises.readFile(task.taskManifestPath, 'utf8'));
  assert.equal(manifest.extraRequirements, extra);
  assert.equal(manifest.skillPath, skillPathFor(ROOT));
});

test('Cursor 启动计划包含打开参数；权限检查失败时给出恢复说明', async () => {
  const { buildCursorLaunchPlan } = require('../src/services/cursor-agent-handoff-service');
  const plan = buildCursorLaunchPlan({
    engine: 'cursor_agent',
    appWorkspace: ROOT,
    taskFilePath: '/tmp/handoffs/11111111-1111-4111-8111-111111111111.json',
    cursorPackagePath: '/tmp/handoffs/11111111-1111-4111-8111-111111111111.cursor-package',
    prompt: '执行视频剪辑任务 demo',
  });
  assert.ok(plan.openArgs.includes('--new-window'));
  assert.ok(plan.openArgs.some((arg) => String(arg).includes('.cursor-package')));
  assert.equal(plan.windowTitleNeedle, '11111111-1111-4111-8111-111111111111.cursor-package');
  assert.equal(plan.openArgs.includes(ROOT), false);
  const permission = await checkAccessibilityPermission();
  assert.equal(typeof permission.granted, 'boolean');
  if (!permission.granted) {
    assert.match(permission.guidance || permission.message, /辅助功能/);
  }
  const clipboard = {
    stored: 'original',
    readText() { return this.stored; },
    writeText(value) { this.stored = value; },
  };
  const result = await withClipboard(clipboard, 'PROMPT', async () => {
    assert.equal(clipboard.stored, 'PROMPT');
    return { ok: true };
  });
  assert.equal(result.ok, true);
  assert.equal(clipboard.stored, 'original');
});

test('Codex / Cursor 完成、失败、失联回流状态模型', () => {
  assert.equal(userFacingStatus({ status: 'awaiting_user_send' }).id, USER_STATUS.processing.id);
  assert.equal(userFacingStatus({ status: 'completed' }).id, USER_STATUS.results_ready.id);
  assert.equal(userFacingStatus({ status: 'completed', openedInFcpAt: 't' }).id, USER_STATUS.in_fcp.id);
  assert.equal(userFacingStatus({ status: 'failed' }).id, USER_STATUS.blocked.id);
  assert.equal(userFacingStatus({ status: 'agent_disconnected' }).id, USER_STATUS.agent_disconnected.id);
  assert.equal(deriveUserStatus({ task: { status: 'failed' } }), 'blocked');
  assert.equal(deriveUserStatus({ task: { status: 'agent_disconnected' } }), 'agent_disconnected');
  assert.equal(blockingErrors({ errors: [{ message: '媒体缺失' }] }).length, 1);
});

test('让 AI 再调整创建 revise 任务且保留额外要求', async () => {
  const paths = await tempTask();
  const task = await createHandoffTask(paths.userData, {
    pendingRoot: paths.pendingRoot,
    sourceDirectory: paths.sourceDirectory,
    sourceSnapshot: await snapshotSource(paths.sourceDirectory),
    sourceSummary: { name: '一期' },
    appWorkspace: ROOT,
    hyperframesMode: 'auto',
    engine: 'codex',
    kind: 'revise',
    extraRequirements: '这一段不要裁人物',
    previousProjectPath: '/tmp/previous',
  });
  assert.equal(task.kind, 'revise');
  assert.equal(task.previousProjectPath, '/tmp/previous');
  assert.match(task.prompt, /这一段不要裁人物/);
  const manifest = buildTaskManifest(task);
  assert.equal(manifest.previous.skipFullRescan, true);
});

test('HotIngest canonical inventory 读取 production nested metadata、翻译和原声', async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REAL_HOTINGEST, '.hotingest/items/001.json'), 'utf8'));
  const fields = parseMetadataFields(raw);
  assert.equal(fields.title, 'Bro lives in the future');
  assert.match(fields.translation, /兄弟活在未来/);
  assert.equal(fields.hasAudio, true);
  assert.equal(fields.author, '37960555');
  assert.ok(fields.translationEntries.some((item) => item.field === 'title'));
  const html = fs.readFileSync(path.join(REAL_HOTINGEST, '001_9gag_Bro_lives_in_the_future.context.html'), 'utf8');
  const htmlFields = extractHotIngestHtmlFields(html);
  assert.equal(htmlFields.translation, '兄弟活在未来');
  assert.equal(htmlFields.platform, '9GAG');

  const inventory = await scanCanonicalInventory(REAL_HOTINGEST);
  assert.equal(inventory.sourceSystem, 'hotingest');
  assert.ok(inventory.items.length >= 8);
  assert.ok(inventory.items.some((item) => item.derived.titleZh));
  assert.ok(inventory.items.some((item) => item.original.audio.hasAudio === true));

  const drifted = parseMetadataFields({ ...raw, brand_new_hotingest_field: 'x' });
  assert.ok(drifted.schemaDrift.some((item) => item.keys.includes('brand_new_hotingest_field')));

  const youtubeRoot = '/Users/example/Desktop/视频素材库/我做了个“全球热料采集机”：自动找素材并下载，已跑完两期/HotIngest搭建及初步成果/HotIngest两期成果/2026-07-23';
  const youtube = await scanCanonicalInventory(youtubeRoot);
  const hobby = youtube.items.find((item) => /Hobbyhorsing/i.test(item.original.title || ''));
  assert.ok(hobby);
  assert.match(hobby.derived.bodyZh || '', /道具马|高速骑行|幕后/);
  assert.equal(hobby.original.categoryTitle, 'Pets & Animals');
  assert.ok((hobby.original.matchedPositiveSignals || []).includes('动物趣事'));
  assert.equal(hobby.schemaDrift, undefined);
  assert.equal((youtube.schemaDrift || []).length, 0);
});

test('HotIngest 绑定到 media inventory 后翻译不再丢失', async () => {
  const files = [];
  async function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      files.push({
        relativePath,
        absolutePath,
        filename: entry.name,
        sizeBytes: fs.statSync(absolutePath).size,
      });
    }
  }
  await walk(REAL_HOTINGEST);
  const items = files.filter((file) => /\.(mp4|jpg|png|webm)$/i.test(file.filename)).map((file, index) => ({
    assetId: `asset-${index}`,
    relativePath: file.relativePath,
    filename: file.filename,
    type: /\.(mp4|webm)$/i.test(file.filename) ? 'video' : 'image',
  }));
  const ingested = await ingestHotIngestContexts(REAL_HOTINGEST, files, items);
  const withTranslation = ingested.items.filter((item) => item.context?.translation);
  assert.ok(withTranslation.length >= 1, 'production translation should bind');
  assert.ok(ingested.inventory.items.length >= 1);
});

test('精炼 Codex prompt 不再内嵌旧规则长文', () => {
  const prompt = buildAgentPrompt('codex', {
    taskId: 'abc',
    taskFilePath: '/tmp/t.json',
    taskManifestPath: '/tmp/t.task.json',
    appWorkspace: ROOT,
    extraRequirements: '',
    hyperframesMode: 'auto',
    sourceDirectory: '/tmp/src',
  });
  assert.match(prompt, /执行视频剪辑任务 abc/);
  assert.doesNotMatch(prompt, /使用 \$video-cut-planner/);
});
