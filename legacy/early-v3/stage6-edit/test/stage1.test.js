const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { PROJECT_DIRS } = require('../src/constants');
const {
  createProject,
  openProject,
  ensureProjectDirs,
} = require('../src/services/project-service');
const {
  getAssetType,
  getId,
  scanAssets,
  generateBrief,
} = require('../src/services/media-service');

test('创建项目时只生成 Stage 1 指定目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '中文项目');
  const entries = await fs.readdir(project.projectPath);

  for (const dir of PROJECT_DIRS) {
    assert.ok(entries.includes(dir), `缺少目录 ${dir}`);
  }
  assert.ok(!entries.includes('原始素材'));
  assert.ok(!entries.includes('发布包'));
  assert.ok(!entries.some((entry) => entry.toLowerCase().includes('fcpxml')));
});

test('打开缺目录项目并补齐', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const projectPath = path.join(root, '待补齐项目');
  await fs.mkdir(projectPath);

  const opened = await openProject(projectPath);
  assert.equal(opened.missingDirs.length, PROJECT_DIRS.length);

  const repaired = await ensureProjectDirs(projectPath);
  assert.deepEqual(repaired.missingDirs, []);
});

test('素材类型与编号识别', () => {
  assert.equal(getAssetType('.heic'), 'image');
  assert.equal(getAssetType('.mov'), 'video');
  assert.equal(getAssetType('.m4a'), 'audio');
  assert.equal(getId('A001-中文截图.png'), 'A001');
  assert.equal(getId('a023 手动命名.mov'), 'A023');
  assert.equal(getId('普通文件.png'), null);
});

test('扫描时保留已有编号，并给未编号文件分配不重复编号', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '扫描测试');
  const assetsPath = path.join(project.projectPath, '01-精选素材');

  await fs.writeFile(path.join(assetsPath, 'A001-已编号.txt'), 'one');
  await fs.writeFile(path.join(assetsPath, '中文文件.txt'), 'two');
  const result = await scanAssets(project.projectPath);

  assert.deepEqual(result.assets.map((asset) => asset.id), ['A001', 'A002']);
  assert.deepEqual(
    (await fs.readdir(assetsPath)).sort(),
    ['A001-已编号.txt', 'A002-中文文件.txt'],
  );

  const secondScan = await scanAssets(project.projectPath);
  assert.deepEqual(secondScan.assets.map((asset) => asset.id), ['A001', 'A002']);

  const brief = await generateBrief(project.projectPath);
  const markdown = await fs.readFile(brief.outputPath, 'utf8');
  assert.match(markdown, /# 素材简报/);
  assert.match(markdown, /A002｜未知｜未知｜尺寸未知｜中文文件\.txt/);
});
