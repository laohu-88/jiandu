const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { LEGACY_PROJECT_DIRS, PROJECT_DIRS, ASSETS_FILE } = require('../src/constants');
const {
  createProject,
  openProject,
  ensureProjectDirs,
} = require('../src/services/project-service');
const {
  getAssetType,
  getId,
  scanAssets,
  loadAssetIndex,
  getAssetPreview,
  readTextPreview,
  updateAssetReview,
  generateBrief,
} = require('../src/services/media-service');

test('创建项目时只生成当前素材筛选台所需的四个目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '中文项目');
  const entries = await fs.readdir(project.projectPath);

  for (const dir of PROJECT_DIRS) {
    assert.ok(entries.includes(dir), `缺少目录 ${dir}`);
  }
  assert.deepEqual(PROJECT_DIRS, [
    '00-项目总控',
    '01-精选素材',
    '02-配音字幕',
    '03-导出',
  ]);
  for (const dir of LEGACY_PROJECT_DIRS.slice(2)) {
    assert.ok(!entries.includes(dir), `不应创建旧目录 ${dir}`);
  }
  assert.ok(!entries.includes('原始素材'));
  assert.ok(!entries.includes('发布包'));
  assert.ok(!entries.some((entry) => entry.toLowerCase().includes('fcpxml')));
});

test('打开旧目录结构项目时保持兼容，不迁移也不补建新目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-legacy-'));
  const projectPath = path.join(root, '旧项目');
  for (const dir of LEGACY_PROJECT_DIRS) {
    await fs.mkdir(path.join(projectPath, dir), { recursive: true });
  }

  const opened = await openProject(projectPath);
  assert.deepEqual(opened.missingDirs, []);
  await ensureProjectDirs(projectPath);
  const entries = await fs.readdir(projectPath);
  assert.ok(!entries.includes('02-配音字幕'));
  assert.ok(!entries.includes('03-导出'));
  for (const dir of LEGACY_PROJECT_DIRS) assert.ok(entries.includes(dir));
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

test('扫描素材不修改源文件，保留已有编号并允许重复编号', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '扫描测试');
  const assetsPath = path.join(project.projectPath, '01-精选素材');

  await fs.writeFile(path.join(assetsPath, 'A001-已编号.txt'), 'one');
  await fs.writeFile(path.join(assetsPath, 'A001-重复编号.txt'), 'duplicate');
  await fs.writeFile(path.join(assetsPath, '中文文件.txt'), 'two');
  const result = await scanAssets(project.projectPath);

  assert.equal(result.schemaVersion, 2);
  assert.deepEqual(
    result.assets.map(({ id, filename }) => ({ id, filename })),
    [
      { id: null, filename: '中文文件.txt' },
      { id: 'A001', filename: 'A001-已编号.txt' },
      { id: 'A001', filename: 'A001-重复编号.txt' },
    ],
  );
  assert.deepEqual(
    (await fs.readdir(assetsPath)).sort(),
    ['A001-已编号.txt', 'A001-重复编号.txt', '中文文件.txt'],
  );
  assert.equal(await fs.readFile(path.join(assetsPath, 'A001-已编号.txt'), 'utf8'), 'one');
  assert.equal(await fs.readFile(path.join(assetsPath, 'A001-重复编号.txt'), 'utf8'), 'duplicate');
  assert.equal(await fs.readFile(path.join(assetsPath, '中文文件.txt'), 'utf8'), 'two');

  for (const asset of result.assets) {
    assert.match(asset.stableId, /^asset_[0-9a-f-]{36}$/);
    assert.equal(asset.availability, 'available');
    assert.equal(asset.fingerprintMode, 'size-mtime-path-v1');
    assert.equal(typeof asset.fingerprint, 'string');
    assert.equal(typeof asset.firstSeenAt, 'string');
    assert.equal(typeof asset.lastSeenAt, 'string');
    assert.equal(asset.missingSince, null);
    assert.equal(asset.reviewStatus, 'unreviewed');
    assert.equal(asset.rating, 0);
    assert.deepEqual(asset.tags, []);
    assert.equal(asset.note, '');
    assert.equal(asset.reviewUpdatedAt, null);
    assert.ok(Object.hasOwn(asset, 'id'));
    assert.ok(Object.hasOwn(asset, 'filename'));
    assert.ok(Object.hasOwn(asset, 'sizeBytes'));
    assert.ok(Object.hasOwn(asset, 'durationSec'));
  }

  const writtenPayload = JSON.parse(await fs.readFile(result.outputPath, 'utf8'));
  assert.equal(writtenPayload.schemaVersion, 2);
  assert.deepEqual(writtenPayload.assets, result.assets);

  const secondScan = await scanAssets(project.projectPath);
  assert.deepEqual(
    secondScan.assets.map(({ stableId }) => stableId),
    result.assets.map(({ stableId }) => stableId),
  );
  assert.deepEqual(
    secondScan.assets.map(({ fingerprint }) => fingerprint),
    result.assets.map(({ fingerprint }) => fingerprint),
  );
  assert.deepEqual(
    secondScan.assets.map(({ id, filename }) => ({ id, filename })),
    result.assets.map(({ id, filename }) => ({ id, filename })),
  );
  assert.deepEqual(
    (await fs.readdir(assetsPath)).sort(),
    ['A001-已编号.txt', 'A001-重复编号.txt', '中文文件.txt'],
  );

  const brief = await generateBrief(project.projectPath);
  const markdown = await fs.readFile(brief.outputPath, 'utf8');
  assert.match(markdown, /# 素材简报/);
  assert.match(markdown, /｜未知｜未知｜尺寸未知｜中文文件\.txt/);
});

test('旧 assets.json 无 stableId 时可升级并继承首次发现时间', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '旧索引升级测试');
  const assetsPath = path.join(project.projectPath, '01-精选素材');
  const outputPath = path.join(project.projectPath, ASSETS_FILE);
  const generatedAt = '2025-01-02T03:04:05.000Z';

  await fs.writeFile(path.join(assetsPath, '旧素材.txt'), 'legacy');
  await fs.writeFile(outputPath, `${JSON.stringify({
    projectPath: project.projectPath,
    generatedAt,
    assets: [{
      id: null,
      filename: '旧素材.txt',
      relativePath: path.join('01-精选素材', '旧素材.txt'),
      sizeBytes: 6,
      durationSec: null,
    }],
  }, null, 2)}\n`, 'utf8');

  const upgraded = await scanAssets(project.projectPath);
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.assets.length, 1);
  assert.match(upgraded.assets[0].stableId, /^asset_[0-9a-f-]{36}$/);
  assert.equal(upgraded.assets[0].availability, 'available');
  assert.equal(upgraded.assets[0].firstSeenAt, generatedAt);
  assert.deepEqual(
    {
      reviewStatus: upgraded.assets[0].reviewStatus,
      rating: upgraded.assets[0].rating,
      tags: upgraded.assets[0].tags,
      note: upgraded.assets[0].note,
      reviewUpdatedAt: upgraded.assets[0].reviewUpdatedAt,
    },
    {
      reviewStatus: 'unreviewed',
      rating: 0,
      tags: [],
      note: '',
      reviewUpdatedAt: null,
    },
  );

  const rescanned = await scanAssets(project.projectPath);
  assert.equal(rescanned.assets[0].stableId, upgraded.assets[0].stableId);
});

test('旧索引中扫描不到的素材保留并标记 missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '缺失素材测试');
  const outputPath = path.join(project.projectPath, ASSETS_FILE);
  const generatedAt = '2025-02-03T04:05:06.000Z';

  await fs.writeFile(outputPath, `${JSON.stringify({
    projectPath: project.projectPath,
    generatedAt,
    assets: [{
      id: 'A009',
      filename: 'A009-已丢失.mov',
      relativePath: path.join('01-精选素材', 'A009-已丢失.mov'),
      sizeBytes: 1234,
      durationSec: 8.5,
    }],
  }, null, 2)}\n`, 'utf8');

  const result = await scanAssets(project.projectPath);
  assert.equal(result.assets.length, 1);
  const missing = result.assets[0];
  assert.equal(missing.availability, 'missing');
  assert.match(missing.stableId, /^asset_[0-9a-f-]{36}$/);
  assert.equal(missing.firstSeenAt, generatedAt);
  assert.equal(missing.lastSeenAt, generatedAt);
  assert.equal(typeof missing.missingSince, 'string');
  assert.equal(missing.fingerprintMode, 'legacy-size-path-v1');
  assert.equal(typeof missing.fingerprint, 'string');
  assert.equal(missing.id, 'A009');
  assert.equal(missing.filename, 'A009-已丢失.mov');
  assert.equal(missing.sizeBytes, 1234);
  assert.equal(missing.durationSec, 8.5);

  const rescanned = await scanAssets(project.projectPath);
  assert.equal(rescanned.assets.length, 1);
  assert.equal(rescanned.assets[0].stableId, missing.stableId);
  assert.equal(rescanned.assets[0].missingSince, missing.missingSince);
});

test('通过 stableId 更新审核字段并规范化 tags', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '审核更新测试');
  const assetsPath = path.join(project.projectPath, '01-精选素材');
  await fs.writeFile(path.join(assetsPath, '待审核.txt'), 'review');

  const scanned = await scanAssets(project.projectPath);
  const original = scanned.assets[0];
  const note = '普通文本 **保持原样**';
  const updated = await updateAssetReview(project.projectPath, original.stableId, {
    reviewStatus: 'keep',
    rating: 5,
    tags: [' 风景 ', '', '夜景', '风景', '   ', '夜景 ', '旅行'],
    note,
  });

  assert.equal(updated.asset.reviewStatus, 'keep');
  assert.equal(updated.asset.rating, 5);
  assert.deepEqual(updated.asset.tags, ['风景', '夜景', '旅行']);
  assert.equal(updated.asset.note, note);
  assert.equal(typeof updated.asset.reviewUpdatedAt, 'string');
  assert.notEqual(updated.asset.reviewUpdatedAt, original.reviewUpdatedAt);

  const written = JSON.parse(await fs.readFile(updated.outputPath, 'utf8'));
  assert.deepEqual(written.assets[0], updated.asset);
});

test('读取不存在的素材索引时返回空索引且不触发扫描', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '空索引读取测试');
  const assetsPath = path.join(project.projectPath, '01-精选素材');
  const sourcePath = path.join(assetsPath, '不应被扫描.txt');
  await fs.writeFile(sourcePath, 'untouched');

  const loaded = await loadAssetIndex(project.projectPath);

  assert.deepEqual(loaded, {
    schemaVersion: 2,
    projectPath: project.projectPath,
    generatedAt: null,
    ffprobeAvailable: null,
    assets: [],
  });
  assert.equal(await fs.readFile(sourcePath, 'utf8'), 'untouched');
  await assert.rejects(
    fs.stat(path.join(project.projectPath, ASSETS_FILE)),
    { code: 'ENOENT' },
  );
});

test('读取素材索引时原样返回 assets.json 且不改写文件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '现有索引读取测试');
  const outputPath = path.join(project.projectPath, ASSETS_FILE);
  const payload = {
    schemaVersion: 2,
    projectPath: project.projectPath,
    generatedAt: '2026-06-29T00:00:00.000Z',
    ffprobeAvailable: false,
    assets: [{ stableId: 'asset_existing', reviewStatus: 'maybe' }],
  };
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.writeFile(outputPath, content, 'utf8');

  assert.deepEqual(await loadAssetIndex(project.projectPath), payload);
  assert.equal(await fs.readFile(outputPath, 'utf8'), content);
});

test('通过 stableId 获取素材预览信息和 fileUrl', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '预览信息测试');
  const assetsPath = path.join(project.projectPath, '01-精选素材');
  const sourcePath = path.join(assetsPath, 'preview.txt');
  await fs.writeFile(sourcePath, 'preview');
  const scanned = await scanAssets(project.projectPath);

  const preview = await getAssetPreview(project.projectPath, scanned.assets[0].stableId);
  const realSourcePath = await fs.realpath(sourcePath);

  assert.equal(preview.stableId, scanned.assets[0].stableId);
  assert.equal(preview.filename, 'preview.txt');
  assert.equal(preview.absolutePath, realSourcePath);
  assert.equal(preview.fileUrl, pathToFileURL(realSourcePath).href);
  assert.equal(preview.ext, 'txt');
  assert.equal(preview.sizeBytes, 7);
  assert.equal(preview.metadataError, null);
});

test('素材 fileUrl 正确编码中文和空格文件名', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '中文路径测试');
  const assetsPath = path.join(project.projectPath, '01-精选素材');
  const sourcePath = path.join(assetsPath, '中文 文件.txt');
  await fs.writeFile(sourcePath, '内容');
  const scanned = await scanAssets(project.projectPath);

  const preview = await getAssetPreview(project.projectPath, scanned.assets[0].stableId);
  const realSourcePath = await fs.realpath(sourcePath);

  assert.equal(preview.fileUrl, pathToFileURL(realSourcePath).href);
  assert.match(preview.fileUrl, /%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6\.txt$/);
});

test('获取素材预览时找不到 stableId 会报错', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '预览缺失 ID 测试');

  await assert.rejects(
    getAssetPreview(project.projectPath, 'asset_not_found'),
    /未找到 stableId 为 asset_not_found 的素材/,
  );
});

test('获取素材预览时拒绝 missing 素材', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '预览 missing 测试');
  const assetsPath = path.join(project.projectPath, '01-精选素材');
  const sourcePath = path.join(assetsPath, 'missing.txt');
  await fs.writeFile(sourcePath, 'missing');
  const scanned = await scanAssets(project.projectPath);
  await fs.unlink(sourcePath);
  await scanAssets(project.projectPath);

  await assert.rejects(
    getAssetPreview(project.projectPath, scanned.assets[0].stableId),
    /已标记为 missing/,
  );
});

test('文本预览通过 stableId 读取文本素材', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '文本预览测试');
  const assetsPath = path.join(project.projectPath, '01-精选素材');
  const text = '第一行\n第二行';
  await fs.writeFile(path.join(assetsPath, '字幕 文本.srt'), text);
  const scanned = await scanAssets(project.projectPath);

  const preview = await readTextPreview(project.projectPath, scanned.assets[0].stableId);

  assert.equal(preview.filename, '字幕 文本.srt');
  assert.equal(preview.text, text);
  assert.equal(preview.truncated, false);
  assert.equal(preview.bytesRead, Buffer.byteLength(text));
});

test('文本预览超过 maxBytes 时截断且限制最大值', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '文本截断测试');
  const assetsPath = path.join(project.projectPath, '01-精选素材');
  await fs.writeFile(path.join(assetsPath, 'long.txt'), 'abcdefghij');
  const scanned = await scanAssets(project.projectPath);
  const stableId = scanned.assets[0].stableId;

  const preview = await readTextPreview(project.projectPath, stableId, 4);

  assert.equal(preview.text, 'abcd');
  assert.equal(preview.truncated, true);
  assert.equal(preview.bytesRead, 4);
  await assert.rejects(
    readTextPreview(project.projectPath, stableId, 256 * 1024 + 1),
    /maxBytes 必须是 1 到 262144 之间的整数/,
  );
});

test('文本预览拒绝读取非文本素材', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '二进制拒绝测试');
  const assetsPath = path.join(project.projectPath, '01-精选素材');
  await fs.writeFile(path.join(assetsPath, 'image.png'), Buffer.from([0, 1, 2, 3]));
  const scanned = await scanAssets(project.projectPath);

  await assert.rejects(
    readTextPreview(project.projectPath, scanned.assets[0].stableId),
    /不是支持的文本类型/,
  );
});

test('文本预览拒绝项目目录外路径和指向外部的符号链接', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '路径越界测试');
  const outputPath = path.join(project.projectPath, ASSETS_FILE);
  const outsidePath = path.join(root, 'outside.txt');
  await fs.writeFile(outsidePath, 'secret');
  const payload = {
    schemaVersion: 2,
    projectPath: project.projectPath,
    assets: [{
      stableId: 'asset_outside',
      availability: 'available',
      filename: 'outside.txt',
      relativePath: path.relative(project.projectPath, outsidePath),
      ext: 'txt',
    }],
  };
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

  await assert.rejects(
    readTextPreview(project.projectPath, 'asset_outside'),
    /路径位于项目目录外/,
  );

  const linkPath = path.join(project.projectPath, '01-精选素材', 'outside-link.txt');
  await fs.symlink(outsidePath, linkPath);
  payload.assets[0].relativePath = path.relative(project.projectPath, linkPath);
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  await assert.rejects(
    readTextPreview(project.projectPath, 'asset_outside'),
    /真实路径位于项目目录外/,
  );
});

test('审核更新严格校验字段和值且不修改索引字段', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-'));
  const { project } = await createProject(root, '审核校验测试');
  const assetsPath = path.join(project.projectPath, '01-精选素材');
  await fs.writeFile(path.join(assetsPath, '索引保护.txt'), 'protected');

  const scanned = await scanAssets(project.projectPath);
  const original = scanned.assets[0];

  await assert.rejects(
    updateAssetReview(project.projectPath, original.stableId, { rating: 6 }),
    /rating 必须是 0 到 5 的整数/,
  );
  await assert.rejects(
    updateAssetReview(project.projectPath, original.stableId, { rating: 1.5 }),
    /rating 必须是 0 到 5 的整数/,
  );
  await assert.rejects(
    updateAssetReview(project.projectPath, original.stableId, { reviewStatus: 'approved' }),
    /reviewStatus 必须是/,
  );
  await assert.rejects(
    updateAssetReview(project.projectPath, original.stableId, { tags: ['有效', 3] }),
    /tags 必须是字符串数组/,
  );
  await assert.rejects(
    updateAssetReview(project.projectPath, original.stableId, { note: 123 }),
    /note 必须是字符串/,
  );
  await assert.rejects(
    updateAssetReview(project.projectPath, original.stableId, {
      reviewStatus: 'reject',
      stableId: 'asset_replaced',
      filename: '已篡改.txt',
      relativePath: '01-精选素材/已篡改.txt',
      fingerprint: 'replaced',
    }),
    /不允许修改的字段/,
  );
  await assert.rejects(
    updateAssetReview(project.projectPath, 'asset_not_found', { reviewStatus: 'keep' }),
    /未找到 stableId 为 asset_not_found 的素材/,
  );

  const written = JSON.parse(await fs.readFile(path.join(project.projectPath, ASSETS_FILE), 'utf8'));
  assert.equal(written.assets[0].stableId, original.stableId);
  assert.equal(written.assets[0].filename, original.filename);
  assert.equal(written.assets[0].relativePath, original.relativePath);
  assert.equal(written.assets[0].fingerprint, original.fingerprint);
  assert.equal(written.assets[0].reviewStatus, 'unreviewed');
  assert.equal(written.assets[0].rating, 0);
  assert.equal(written.assets[0].reviewUpdatedAt, null);
});
