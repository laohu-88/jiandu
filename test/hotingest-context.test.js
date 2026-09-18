const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  classifyHotIngestFile,
  ingestHotIngestContexts,
  parseIndexEntries,
  stripUnsafeHtml,
} = require('../src/services/hotingest-context-service');
const {
  preparePendingMedia,
} = require('../src/services/pending-media-service');
const { syncTimelineAssets } = require('../src/services/codex-video-service');
const { createProject } = require('../src/services/project-service');
const { validateVideoAnalysis } = require('../src/services/video-analysis-schema');

const fixtureRoot = path.join(__dirname, 'fixtures', 'hotingest-context');
const fixtureDate = path.join(fixtureRoot, '2026-07-20');
const VISUAL_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.tif', '.tiff', '.bmp',
  '.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mts', '.m2ts',
]);

async function walk(directory, root = directory, result = []) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolutePath, root, result);
    if (entry.isFile()) {
      result.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath),
      });
    }
  }
  return result;
}

async function ingestFixture() {
  const files = await walk(fixtureRoot);
  const items = files
    .filter((file) => VISUAL_EXTENSIONS.has(path.extname(file.relativePath).toLowerCase()))
    .map((file, index) => ({
      assetId: `asset-${index + 1}`,
      type: ['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mts', '.m2ts']
        .includes(path.extname(file.relativePath).toLowerCase()) ? 'video' : 'image',
      filename: path.basename(file.relativePath),
      relativePath: file.relativePath,
      originalPath: file.absolutePath,
      extension: path.extname(file.relativePath).slice(1).toLowerCase(),
      metadata: {},
    }));
  return ingestHotIngestContexts(fixtureRoot, files, items);
}

function itemByName(result, filename) {
  return result.items.find((item) => item.filename === filename);
}

test('识别视觉素材、单素材 sidecar、文件夹索引和隐藏 metadata 的不同角色', () => {
  assert.deepEqual(classifyHotIngestFile('001_demo.context.html'), {
    role: 'asset-sidecar',
    type: 'context-html',
  });
  assert.deepEqual(classifyHotIngestFile('002.text.html'), {
    role: 'asset-sidecar',
    type: 'text-html',
  });
  assert.deepEqual(classifyHotIngestFile('_素材索引.html'), {
    role: 'folder-index',
    type: 'folder-index-html',
  });
  assert.deepEqual(classifyHotIngestFile('.hotingest/items/002.json'), {
    role: 'asset-sidecar',
    type: 'metadata-json',
  });
  assert.equal(classifyHotIngestFile('002_demo.jpg'), null);
});

test('同名 mp4/context、同编号 jpg/text 均绑定到正确视觉素材', async () => {
  const result = await ingestFixture();
  const video = itemByName(result, '001_9gag_Future.mp4');
  const image = itemByName(result, '002_lemmy_Event.jpg');
  assert.ok(video.context.files.some((file) => /001_9gag_Future\.context\.html$/.test(file.relativePath)));
  assert.ok(image.context.files.some((file) => /002\.text\.html$/.test(file.relativePath)));
  assert.match(image.context.translation, /编号二的中文翻译/);
});

test('_素材索引为多个素材补缺，并报告索引指向的缺失文件', async () => {
  const result = await ingestFixture();
  const first = itemByName(result, '001_9gag_Future.mp4');
  const second = itemByName(result, '002_lemmy_Event.jpg');
  assert.ok(first.context.files.some((file) => file.type === 'folder-index'));
  assert.ok(second.context.files.some((file) => file.type === 'folder-index'));
  assert.equal(second.context.author, '索引作者');
  assert.ok(result.contextIngestion.warnings.some((warning) => /777_missing\.mp4/.test(warning)));
});

test('同一编号的多个视觉文件共享明确 sidecar，但 001 与 010 不串绑', async () => {
  const result = await ingestFixture();
  for (const filename of ['004_youtube_Multi_01.mp4', '004_youtube_Multi_02.jpg']) {
    const item = itemByName(result, filename);
    assert.match(item.context.body, /一个编号同时包含视频和补充截图/);
  }
  const first = itemByName(result, '001_9gag_Future.mp4');
  const tenth = itemByName(result, '010_mastodon_Ten.png');
  assert.doesNotMatch(first.context.body, /只属于 010/);
  assert.match(tenth.context.body, /只属于 010/);
});

test('单素材明确字段优先于索引，隐藏 metadata 优先且冲突有来源警告', async () => {
  const result = await ingestFixture();
  const first = itemByName(result, '001_9gag_Future.mp4');
  const second = itemByName(result, '002_lemmy_Event.jpg');
  assert.equal(first.context.title, '隐藏元数据标题');
  assert.match(first.context.body, /隐藏元数据中的正文/);
  assert.equal(first.context.fieldSources.title, '2026-07-20/.hotingest/items/001.json');
  assert.equal(second.context.title, '编号二事件');
  assert.ok(first.context.warnings.some((warning) => /title 冲突/));
  assert.deepEqual(result.contextIngestion.mergePriority, [
    'metadata-json', 'context-html', 'text-html', 'folder-index',
  ]);
});

test('孤立上下文和损坏 HTML 只产生警告，不会中断其他绑定', async () => {
  const result = await ingestFixture();
  const broken = itemByName(result, '005_broken.png');
  assert.ok(broken.context);
  assert.equal(result.contextIngestion.orphanContextCount, 1);
  assert.ok(result.contextIngestion.orphanContexts.some(
    (entry) => /099_orphan\.context\.html$/.test(entry.relativePath),
  ));
  assert.ok(result.contextIngestion.warnings.some(
    (warning) => /005_broken\.context\.html.*损坏 HTML/.test(warning),
  ));
  assert.equal(result.contextIngestion.parseWarningCount, 1);
  assert.equal(result.items.length, 7);
});

test('HTML 解析不执行脚本并忽略 script、style、导航与布局内容', async () => {
  const html = await fs.readFile(path.join(fixtureDate, '001_9gag_Future.context.html'), 'utf8');
  const text = stripUnsafeHtml(html);
  assert.match(text, /一条匿名事件背景/);
  assert.doesNotMatch(text, /shouldNeverRun|secret|导航内容/);
  const indexHtml = await fs.readFile(path.join(fixtureDate, '_素材索引.html'), 'utf8');
  assert.equal(parseIndexEntries(indexHtml).length, 4);
});

test('无 HotIngest 上下文时素材数组和原有字段保持不变', async () => {
  const items = [{
    assetId: 'ordinary',
    type: 'image',
    filename: '普通图片.png',
    relativePath: '普通图片.png',
    metadata: { width: 100, height: 100 },
  }];
  const result = await ingestHotIngestContexts('/tmp/ordinary', [], items);
  assert.deepEqual(result.items, items);
  assert.equal(result.contextIngestion.detected, false);
  assert.equal(result.contextIngestion.assetsWithContext, 0);
});

test('prepare 只把七个视觉文件写入 manifest，HTML/索引/metadata 不成为素材或分析镜头候选', {
  timeout: 60_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hotingest-prepare-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.cp(fixtureRoot, source, { recursive: true });
  const prepared = await preparePendingMedia(source, { cacheRoot: path.join(root, 'cache') });
  assert.equal(prepared.items.length, 7);
  assert.ok(prepared.items.every((item) => ['image', 'video'].includes(item.type)));
  assert.ok(prepared.items.every((item) => !/\.html?$|\.json$/i.test(item.filename)));
  assert.equal(prepared.contextIngestion.assetsWithContext, 7);
  assert.equal(prepared.contextIngestion.contextFileCount, 9);
  assert.equal(prepared.contextIngestion.orphanContextCount, 1);
  assert.equal(prepared.storyUnits.length, 6);
  assert.equal(prepared.contextIngestion.multiAssetStoryUnitCount, 1);
  assert.ok(prepared.storyUnits.some((unit) => unit.assetIds.length === 2));
  assert.ok(prepared.chapters.every((chapter) => chapter.chapterName !== '.hotingest'));

  const request = JSON.parse(await fs.readFile(prepared.analysisRequestPath, 'utf8'));
  assert.equal(request.items.length, 7);
  assert.equal(request.storyUnits.length, 6);
  assert.ok(request.contextBudget.usedChars <= request.contextBudget.maxTotalChars);
  assert.ok(request.items.find((item) => item.filename === '001_9gag_Future.mp4').context);
  assert.ok(request.items.find((item) => item.filename === '001_9gag_Future.mp4').semanticProfile);
  assert.match(request.instruction, /画面实际可见内容/);
  assert.match(request.instruction, /contextUsage/);
  assert.match(request.instruction, /representativeAssetIds/);
});

function contextualAnalysis() {
  return {
    schemaVersion: 1,
    theme: {
      summary: '上下文测试',
      rationale: '画面和说明共同建立事件。',
      confidence: 0.9,
      folderNameConflict: false,
    },
    titles: {
      candidates: ['上下文测试', '事件测试'],
      recommended: '上下文测试',
      rationale: '对应素材。',
    },
    assets: [{
      assetId: 'contextual',
      type: 'image',
      semanticLabels: ['测试'],
      contentSummary: '画面显示测试卡；说明文件提供事件标题。',
      suggestedUse: ['测试'],
      status: 'adopt',
      reason: '可用。',
      cleanup: {
        decision: 'none', overlayTypes: [], rationale: '检查后未发现无关覆盖物。',
        method: 'none', provider: 'none', zones: [],
        inspectedFrames: ['preview.jpg'],
        reviewRequired: false, warnings: [],
      },
      ranges: [],
      confidence: 0.9,
      contextUsage: {
        used: true,
        sourceFiles: ['001.context.html'],
        visualEvidence: '画面实际可见一张测试卡。',
        contextEvidence: 'context.html 提供匿名事件标题。',
      },
    }],
    timeline: {
      shots: [{
        id: 'shot-1',
        assetId: 'contextual',
        inSec: 0,
        outSec: 2,
        durationSec: 2,
        fitMode: 'contain',
        audioMode: 'mute',
        purpose: '测试',
        confidence: 0.9,
        reviewRequired: false,
      }],
      markers: [],
    },
  };
}

test('分析结果必须标记上下文来源和是否使用，并分别记录画面与上下文证据', () => {
  const manifest = {
    items: [{
      assetId: 'contextual',
      type: 'image',
      metadata: {},
      context: {
        files: [{ relativePath: '001.context.html', type: 'context-html' }],
      },
    }],
  };
  const analysis = contextualAnalysis();
  assert.equal(validateVideoAnalysis(analysis, manifest), analysis);
  delete analysis.assets[0].contextUsage;
  assert.throws(
    () => validateVideoAnalysis(analysis, manifest),
    (error) => error.details.some((message) => /contextUsage/.test(message)),
  );
});

test('sidecar 不生成独立 assetMappings，也不会复制进正式精选素材目录', {
  timeout: 30_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hotingest-mapping-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const created = await createProject(root, 'context-mapping');
  const originalPath = path.join(fixtureDate, '002_lemmy_Event.jpg');
  const manifest = {
    items: [{
      assetId: 'contextual',
      type: 'image',
      filename: path.basename(originalPath),
      relativePath: path.join('2026-07-20', path.basename(originalPath)),
      originalPath,
      extension: 'jpg',
      sha256: 'fixture-hash',
      metadata: {},
      context: {
        files: [{ relativePath: '2026-07-20/002.text.html', type: 'text-html' }],
      },
    }],
  };
  const analysis = contextualAnalysis();
  const crypto = require('node:crypto');
  manifest.items[0].sha256 = crypto.createHash('sha256')
    .update(await fs.readFile(originalPath))
    .digest('hex');
  const mappings = await syncTimelineAssets(created.project.projectPath, manifest, analysis);
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].assetId, 'contextual');
  const copied = await fs.readdir(path.join(created.project.projectPath, '01-精选素材'));
  assert.deepEqual(copied, ['002_lemmy_Event.jpg']);
});

test('上下文不能绕过 WebM 在正式构建前的既有拦截', () => {
  const manifest = {
    items: [{
      assetId: 'contextual',
      type: 'image',
      extension: 'webm',
      metadata: {},
      context: {
        files: [{ relativePath: '001.context.html', type: 'context-html' }],
      },
    }],
  };
  const analysis = contextualAnalysis();
  assert.throws(
    () => validateVideoAnalysis(analysis, manifest),
    (error) => error.details.some((message) => /Final Cut Pro 不支持的 \.webm/.test(message)),
  );
});
