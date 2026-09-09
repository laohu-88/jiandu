const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { buildCodexVideoProject } = require('../src/services/codex-video-service');
const {
  materializeCleanMedia,
  mergeCleanupLayout,
  resolveCleanupPlan,
  validateCleanupPlan,
  verifyCleanupResults,
} = require('../src/services/source-cleanup-service');
const { preparePendingMedia, snapshotSource } = require('../src/services/pending-media-service');
const { resolveToolPath, runMediaTool } = require('../src/services/media-tool-service');

function cleanupPlan(overrides = {}) {
  return {
    decision: 'derived_media',
    overlayTypes: ['foreign_title'],
    rationale: '外文大标题压在非关键背景边缘，局部遮盖不会损害主体。',
    method: 'ffmpeg_mask_blur',
    provider: 'ffmpeg-mask-blur',
    zones: [{ x: 0, y: 0, width: 0.32, height: 0.16 }],
    fallback: 'preserve',
    reviewRequired: false,
    warnings: [],
    ...overrides,
  };
}

async function createVideo(root) {
  const source = path.join(root, '带外文标题.mp4');
  await runMediaTool('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=1.2:size=320x180:rate=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', source,
  ], { timeoutMs: 60_000 });
  return source;
}

async function baseAnalysis(assetId, plan) {
  return {
    schemaVersion: 1,
    theme: {
      summary: '测试源画面净化',
      rationale: '测试素材用于验证清理路径。',
      confidence: 1,
      folderNameConflict: false,
    },
    titles: {
      candidates: ['清理后的画面', '源画面净化验证'],
      recommended: '清理后的画面',
      rationale: '对应清理后的测试画面。',
    },
    assets: [{
      assetId,
      type: 'video',
      semanticLabels: ['测试画面'],
      contentSummary: '测试视频，顶部存在需要处理的外文覆盖物。',
      suggestedUse: ['画面验证'],
      status: 'adopt',
      reason: '用于验证清理路径。',
      cleanup: plan,
      ranges: [{ startSec: 0, endSec: 1.2, confidence: 1, reviewRequired: false }],
      confidence: 1,
    }],
    timeline: {
      orientation: 'horizontal', width: 1920, height: 1080, fps: 30,
      shots: [{
        id: 'cleanup-shot', assetId, inSec: 0, outSec: 1.2, durationSec: 1.2,
        fitMode: 'contain', audioMode: 'keep', purpose: '验证清理', confidence: 1,
        reviewRequired: false, cleanup: plan,
      }],
      markers: [],
    },
  };
}

test('cleanup 决策校验覆盖 crop、派生媒体和安全 fallback', () => {
  const errors = [];
  validateCleanupPlan(cleanupPlan(), 'cleanup', errors);
  assert.deepEqual(errors, []);
  const cropErrors = [];
  validateCleanupPlan(cleanupPlan({
    decision: 'crop_reframe',
    method: 'fcpxml_crop',
    provider: 'fcpxml',
    zones: [],
    layout: { crop: { top: 0.18, left: 0, right: 0, bottom: 0 } },
  }), 'cleanup', cropErrors);
  assert.deepEqual(cropErrors, []);
  const invalidErrors = [];
  validateCleanupPlan(cleanupPlan({ zones: [{ x: 0.9, y: 0, width: 0.3, height: 0.2 }] }), 'cleanup', invalidErrors);
  assert.ok(invalidErrors.some((message) => /zones/.test(message)));
  assert.equal(
    resolveCleanupPlan({ cleanup: cleanupPlan() }, { cleanup: cleanupPlan({ decision: 'none', method: 'none', provider: 'none', zones: [] }) }).decision,
    'derived_media',
  );
});

test('crop/reframe 只写入 FCPXML，不生成 clean-media', async (t) => {
  if (!(await resolveToolPath('ffmpeg')) || !(await resolveToolPath('ffprobe'))) {
    t.skip('本机缺少 ffmpeg 或 ffprobe。');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiandu-cleanup-crop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'pending');
  await fs.mkdir(sourceDir, { recursive: true });
  const source = await createVideo(sourceDir);
  const prepared = await preparePendingMedia(sourceDir, { cacheRoot: path.join(root, 'prepare-cache') });
  const assetId = prepared.items[0].assetId;
  const analysis = await baseAnalysis(assetId, cleanupPlan({
    decision: 'crop_reframe',
    method: 'fcpxml_crop',
    provider: 'fcpxml',
    zones: [],
    layout: {
      mode: 'center_crop', scale: 1, position: { x: 0, y: 0 },
      crop: { left: 0, top: 0.16, right: 0, bottom: 0 },
    },
  }));
  const analysisPath = path.join(root, 'analysis.json');
  await fs.writeFile(analysisPath, `${JSON.stringify(analysis)}\n`);
  const projectRoot = path.join(root, 'Desktop', '视频素材库');
  const internalRoot = path.join(root, 'Library', 'Application Support', '剪渡', 'projects', 'crop');
  const built = await buildCodexVideoProject({
    manifestPath: prepared.manifestPath,
    analysisPath,
    projectRoot,
    projectName: 'crop-project',
    internalRoot,
    generatePreview: false,
  });
  const xml = await fs.readFile(built.artifacts.fcpxmlPath, 'utf8');
  assert.match(xml, /<adjust-crop mode="trim">/);
  assert.equal(await fs.stat(path.join(internalRoot, 'cache', 'clean-media')).then(() => true).catch(() => false), false);
  assert.deepEqual(await fs.readdir(built.projectPath), ['清理后的画面.fcpxml']);
  assert.equal((await snapshotSource(sourceDir)).digest, prepared.sourceVerification.beforeDigest);
  assert.equal(source, prepared.items[0].originalPath);
});

test('派生媒体进入 Application Support clean-media，FCPXML 引用派生版本且源素材不可变', async (t) => {
  if (!(await resolveToolPath('ffmpeg')) || !(await resolveToolPath('ffprobe'))) {
    t.skip('本机缺少 ffmpeg 或 ffprobe。');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiandu-cleanup-derived-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'pending');
  await fs.mkdir(sourceDir, { recursive: true });
  const source = await createVideo(sourceDir);
  const beforeBytes = await fs.readFile(source);
  const prepared = await preparePendingMedia(sourceDir, { cacheRoot: path.join(root, 'prepare-cache') });
  const assetId = prepared.items[0].assetId;
  const analysisPath = path.join(root, 'analysis.json');
  await fs.writeFile(analysisPath, `${JSON.stringify(await baseAnalysis(assetId, cleanupPlan()))}\n`);
  const internalRoot = path.join(root, 'Library', 'Application Support', '剪渡', 'projects', 'derived');
  const built = await buildCodexVideoProject({
    manifestPath: prepared.manifestPath,
    analysisPath,
    projectRoot: path.join(root, 'Desktop', '视频素材库'),
    projectName: 'derived-project',
    internalRoot,
    generatePreview: false,
  });
  const cleanDir = path.join(internalRoot, 'cache', 'clean-media');
  const cleanFiles = await fs.readdir(cleanDir);
  assert.equal(cleanFiles.length, 1);
  assert.match(cleanFiles[0], /\.mp4$/);
  assert.equal(built.cleanupReports[0].status, 'generated');
  assert.match(await fs.readFile(built.artifacts.fcpxmlPath, 'utf8'), /cache%2Fclean-media|cache\/clean-media/);
  assert.equal((await fs.readFile(source)).equals(beforeBytes), true);
  assert.deepEqual(await fs.readdir(built.projectPath), ['清理后的画面.fcpxml']);
  assert.equal(built.verification.ok, true);
});

test('ffmpeg delogo 真实生成像素变化，并在后处理复检中被证明', async (t) => {
  if (!(await resolveToolPath('ffmpeg')) || !(await resolveToolPath('ffprobe'))) {
    t.skip('本机缺少 ffmpeg 或 ffprobe。');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiandu-cleanup-delogo-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'pending');
  await fs.mkdir(sourceDir, { recursive: true });
  const source = await createVideo(sourceDir);
  const prepared = await preparePendingMedia(sourceDir, { cacheRoot: path.join(root, 'prepare-cache') });
  const assetId = prepared.items[0].assetId;
  const plan = cleanupPlan({
    overlayTypes: ['watermark'],
    rationale: '固定角落徽标位于非关键背景，使用 delogo 周边插值。',
    method: 'ffmpeg_delogo',
    provider: 'ffmpeg-delogo',
    zones: [{ x: 0.72, y: 0.72, width: 0.2, height: 0.2 }],
    timeRanges: [{ startSec: 0, endSec: 1.15, confidence: 0.95 }],
    inspectedFrames: ['start.jpg', 'middle.jpg', 'end.jpg'],
  });
  const analysisPath = path.join(root, 'analysis.json');
  await fs.writeFile(analysisPath, `${JSON.stringify(await baseAnalysis(assetId, plan))}\n`);
  const built = await buildCodexVideoProject({
    manifestPath: prepared.manifestPath,
    analysisPath,
    projectRoot: path.join(root, 'Desktop', '视频素材库'),
    projectName: 'delogo-project',
    internalRoot: path.join(root, 'Library', 'Application Support', '剪渡', 'projects', 'delogo'),
    generatePreview: false,
  });
  assert.equal(built.cleanupReports[0].method, 'ffmpeg_delogo');
  assert.equal(built.cleanupReports[0].status, 'generated');
  assert.equal(built.cleanupVerification.ok, true);
  const result = built.cleanupVerification.results[0];
  assert.equal(result.checks.find((check) => check.type === 'pixel_change').ok, true);
  assert.equal(built.verification.ok, true);
  assert.ok(await fs.stat(built.assetMappings.find((mapping) => mapping.cleanupSourceAssetId)?.projectAbsolutePath));
});

test('后处理复检拒绝与原片没有像素变化的 clean-media', async (t) => {
  if (!(await resolveToolPath('ffmpeg')) || !(await resolveToolPath('ffprobe'))) {
    t.skip('本机缺少 ffmpeg 或 ffprobe。');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiandu-cleanup-no-change-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'pending');
  await fs.mkdir(sourceDir, { recursive: true });
  const source = await createVideo(sourceDir);
  const prepared = await preparePendingMedia(sourceDir, { cacheRoot: path.join(root, 'prepare-cache') });
  const item = prepared.items[0];
  const plan = cleanupPlan({
    method: 'ffmpeg_delogo',
    provider: 'ffmpeg-delogo',
    inspectedFrames: ['start.jpg', 'middle.jpg', 'end.jpg'],
    timeRanges: [{ startSec: 0, endSec: 1.1, confidence: 1 }],
  });
  const analysis = await baseAnalysis(item.assetId, plan);
  const mapping = {
    assetId: item.assetId,
    type: item.type,
    projectAbsolutePath: source,
    sourceSha256: item.sha256,
    metadata: item.metadata,
  };
  const result = await verifyCleanupResults({
    artifactRoot: root,
    analysis,
    mappings: [mapping, { ...mapping, assetId: `${item.assetId}__clean` }],
    cleanupReports: [{
      shotId: 'cleanup-shot',
      assetId: item.assetId,
      derivedAssetId: `${item.assetId}__clean`,
      decision: 'derived_media',
      status: 'generated',
    }],
    fcpxml: pathToFileURL(source).href,
  });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].status, 'unresolved');
  assert.match(result.results[0].warnings[0], /没有真实像素变化/);
});

test('inpainting provider 不可用时使用安全 fallback，不伪造修复成功', async () => {
  const source = {
    assetId: 'asset', type: 'video', projectAbsolutePath: '/tmp/not-used.mp4',
    sourceSha256: crypto.createHash('sha256').update('source').digest('hex'),
    metadata: { hasAudio: false },
  };
  const cleanup = cleanupPlan({
    provider: 'inpainting',
    fallback: 'crop_reframe',
    fallbackLayout: { crop: { top: 0.2, left: 0, right: 0, bottom: 0 } },
  });
  const result = await materializeCleanMedia({ artifactRoot: '/tmp/jiandu-cleanup-test', mapping: source, cleanup });
  assert.equal(result.status, 'fallback');
  assert.equal(result.mapping.projectAbsolutePath, source.projectAbsolutePath);
  assert.deepEqual(mergeCleanupLayout({ id: 'shot' }, cleanup), { id: 'shot' });
});

test('revision 风格复制保留 cleanup 决策，且不被普通字段覆盖', () => {
  const plan = cleanupPlan({ rationale: 'revision 保留原判断。' });
  const analysis = { timeline: { shots: [{ id: 'shot', cleanup: plan }] }, assets: [] };
  const revised = structuredClone(analysis);
  revised.timeline.shots[0].purpose = '新增说明';
  assert.equal(resolveCleanupPlan(revised.timeline.shots[0], null).rationale, plan.rationale);
});
