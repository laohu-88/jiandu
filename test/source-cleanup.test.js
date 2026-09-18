const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { buildCodexVideoProject } = require('../src/services/codex-video-service');
const {
  inspectedNoneCleanup,
  materializeCleanMedia,
  mergeCleanupLayout,
  resolveCleanupPlan,
  validateCleanupPlan,
  verifyCleanupResults,
} = require('../src/services/source-cleanup-service');
const { validateVideoAnalysis } = require('../src/services/video-analysis-schema');
const { preparePendingMedia, snapshotSource } = require('../src/services/pending-media-service');
const { resolveToolPath, runMediaTool } = require('../src/services/media-tool-service');

function cleanupPlan(overrides = {}) {
  return {
    decision: 'derived_media',
    overlayTypes: ['watermark'],
    rationale: '固定边角徽标位于简单静态背景，使用小区域 delogo。',
    method: 'ffmpeg_delogo',
    provider: 'ffmpeg-delogo',
    zones: [{ x: 0.82, y: 0.8, width: 0.14, height: 0.16 }],
    inspectedFrames: ['start.jpg', 'middle.jpg', 'end.jpg'],
    fallback: 'preserve',
    reviewRequired: false,
    warnings: [],
    ...overrides,
  };
}

function cropPlan(overrides = {}) {
  return cleanupPlan({
    decision: 'crop_reframe',
    overlayTypes: ['foreign_title'],
    rationale: '顶部外文标题位于黑边/边缘，裁切后离开最终画面。',
    method: 'fcpxml_crop',
    provider: 'fcpxml',
    zones: [{ x: 0, y: 0, width: 1, height: 0.16 }],
    layout: {
      mode: 'center_crop',
      scale: 1,
      position: { x: 0, y: 0 },
      crop: { left: 0, top: 0.18, right: 0, bottom: 0 },
    },
    ...overrides,
  });
}

async function createPatternVideo(root, name = '带外文标题.mp4') {
  const source = path.join(root, name);
  await runMediaTool('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=1.2:size=320x180:rate=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', source,
  ], { timeoutMs: 60_000 });
  return source;
}

async function createLogoVideo(root) {
  const source = path.join(root, '带边角徽标.mp4');
  await runMediaTool('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=0x2a6b3c:size=320x180:rate=30:duration=1.2',
    '-f', 'lavfi', '-i', 'color=c=white:size=36x24:rate=30:duration=1.2',
    '-filter_complex', 'overlay=x=276:y=148',
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
      contentSummary: '测试视频，存在需要处理的覆盖物或已确认干净。',
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
  validateCleanupPlan(cropPlan(), 'cleanup', cropErrors);
  assert.deepEqual(cropErrors, []);
  const invalidErrors = [];
  validateCleanupPlan(cleanupPlan({ zones: [{ x: 0.9, y: 0, width: 0.3, height: 0.2 }] }), 'cleanup', invalidErrors);
  assert.ok(invalidErrors.some((message) => /zones/.test(message)));
  const placeholderErrors = [];
  validateCleanupPlan(inspectedNoneCleanup({ inspectedFrames: ['storyboard.jpg', 'timed key frames'] }), 'cleanup', placeholderErrors);
  assert.ok(placeholderErrors.some((message) => /inspectedFrames/.test(message)));
  const blurErrors = [];
  validateCleanupPlan(cleanupPlan({
    method: 'ffmpeg_mask_blur',
    provider: 'ffmpeg-mask-blur',
    zones: [{ x: 0, y: 0, width: 0.4, height: 0.3 }],
  }), 'cleanup', blurErrors);
  assert.ok(blurErrors.some((message) => /blur|遮盖/.test(message)));
  assert.equal(
    resolveCleanupPlan({ cleanup: cleanupPlan() }, { cleanup: inspectedNoneCleanup() }).decision,
    'derived_media',
  );
});

test('缺少 cleanup 时旧 analysis 仍可校验，但 build 拒绝静默继续', async (t) => {
  if (!(await resolveToolPath('ffmpeg')) || !(await resolveToolPath('ffprobe'))) {
    t.skip('本机缺少 ffmpeg 或 ffprobe。');
    return;
  }
  const analysis = {
    schemaVersion: 1,
    theme: { summary: '缺检查', rationale: '验证强制 cleanup。', confidence: 1, folderNameConflict: false },
    titles: { candidates: ['缺检查', '强制净化'], recommended: '缺检查', rationale: '验证。' },
    assets: [{
      assetId: 'media-video', type: 'video', semanticLabels: ['画面'],
      contentSummary: '有画面。', suggestedUse: ['时间线'], status: 'adopt',
      reason: '可用。', ranges: [{ startSec: 0, endSec: 1.2, confidence: 1, reviewRequired: false }],
      confidence: 1,
    }],
    timeline: {
      orientation: 'horizontal', width: 1920, height: 1080, fps: 30,
      shots: [{
        id: 'shot-1', assetId: 'media-video', inSec: 0, outSec: 1.2, durationSec: 1.2,
        fitMode: 'contain', audioMode: 'keep', purpose: '画面', confidence: 1, reviewRequired: false,
      }],
      markers: [],
    },
  };
  assert.doesNotThrow(() => validateVideoAnalysis(analysis, {
    items: [{ assetId: 'media-video', type: 'video', metadata: { durationSec: 2 } }],
  }));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiandu-cleanup-missing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'pending');
  await fs.mkdir(sourceDir, { recursive: true });
  await createPatternVideo(sourceDir, 'plain.mp4');
  const prepared = await preparePendingMedia(sourceDir, { cacheRoot: path.join(root, 'prepare-cache') });
  analysis.assets[0].assetId = prepared.items[0].assetId;
  analysis.timeline.shots[0].assetId = prepared.items[0].assetId;
  const analysisPath = path.join(root, 'analysis.json');
  await fs.writeFile(analysisPath, `${JSON.stringify(analysis)}\n`);
  await assert.rejects(
    () => buildCodexVideoProject({
      manifestPath: prepared.manifestPath,
      analysisPath,
      projectRoot: path.join(root, 'Desktop', '视频素材库'),
      projectName: 'missing-cleanup',
      internalRoot: path.join(root, 'Library', 'Application Support', '剪渡', 'projects', 'missing'),
      generatePreview: false,
    }),
    /缺少 cleanup plan/,
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
  await createPatternVideo(sourceDir);
  const prepared = await preparePendingMedia(sourceDir, { cacheRoot: path.join(root, 'prepare-cache') });
  const assetId = prepared.items[0].assetId;
  const analysis = await baseAnalysis(assetId, cropPlan());
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
  assert.match(xml, /top="18"/);
  assert.equal(built.cleanupReports[0].resultStatus, 'cleaned_by_reframe');
  const shot = (await fs.readFile(path.join(internalRoot, '视频状态.json'), 'utf8')
    .then((text) => JSON.parse(text))).effectiveAnalysis.timeline.shots[0];
  assert.equal(shot.layout.crop.top, 0.18);
  assert.equal(shot.fitMode, 'cover');
  assert.equal(await fs.stat(path.join(internalRoot, 'cache', 'clean-media')).then(() => true).catch(() => false), false);
  assert.deepEqual(await fs.readdir(built.projectPath), ['清理后的画面.fcpxml']);
  assert.equal((await snapshotSource(sourceDir)).digest, prepared.sourceVerification.beforeDigest);
  assert.equal(built.cleanupVerification.ok, true);
  assert.equal(built.cleanupVerification.results[0].resultStatus, 'cleaned_by_reframe');
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
  const source = await createLogoVideo(sourceDir);
  const beforeBytes = await fs.readFile(source);
  const prepared = await preparePendingMedia(sourceDir, { cacheRoot: path.join(root, 'prepare-cache') });
  const assetId = prepared.items[0].assetId;
  const analysisPath = path.join(root, 'analysis.json');
  await fs.writeFile(analysisPath, `${JSON.stringify(await baseAnalysis(assetId, cleanupPlan({
    zones: [{ x: 0.86, y: 0.82, width: 0.12, height: 0.14 }],
  })))}\n`);
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
  assert.equal(built.cleanupVerification.results[0].resultStatus, 'cleaned_by_derived_media');
  assert.match(await fs.readFile(built.artifacts.fcpxmlPath, 'utf8'), /cache%2Fclean-media|cache\/clean-media/);
  assert.equal((await fs.readFile(source)).equals(beforeBytes), true);
  assert.deepEqual(await fs.readdir(built.projectPath), ['清理后的画面.fcpxml']);
  assert.equal(built.verification.ok, true);
});

test('ffmpeg delogo 只接受简单静态背景小区域，并在质量复检中被证明', async (t) => {
  if (!(await resolveToolPath('ffmpeg')) || !(await resolveToolPath('ffprobe'))) {
    t.skip('本机缺少 ffmpeg 或 ffprobe。');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiandu-cleanup-delogo-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'pending');
  await fs.mkdir(sourceDir, { recursive: true });
  await createLogoVideo(sourceDir);
  const prepared = await preparePendingMedia(sourceDir, { cacheRoot: path.join(root, 'prepare-cache') });
  const assetId = prepared.items[0].assetId;
  const plan = cleanupPlan({
    overlayTypes: ['watermark'],
    rationale: '固定角落徽标位于非关键静态背景，使用 delogo 周边插值。',
    zones: [{ x: 0.86, y: 0.82, width: 0.12, height: 0.14 }],
    timeRanges: [{ startSec: 0, endSec: 1.15, confidence: 0.95 }],
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
  assert.equal(result.checks.find((check) => check.type === 'visual_quality').ok, true);
  assert.equal(built.verification.ok, true);
  assert.ok(await fs.stat(built.assetMappings.find((mapping) => mapping.cleanupSourceAssetId)?.projectAbsolutePath));
});

test('复杂主体上的大区域 delogo / blur 不得被判定 cleaned', async (t) => {
  if (!(await resolveToolPath('ffmpeg')) || !(await resolveToolPath('ffprobe'))) {
    t.skip('本机缺少 ffmpeg 或 ffprobe。');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiandu-cleanup-lowq-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = {
    assetId: 'asset', type: 'video', projectAbsolutePath: '/tmp/not-used.mp4',
    sourceSha256: crypto.createHash('sha256').update('source').digest('hex'),
    metadata: { hasAudio: false, width: 320, height: 180 },
  };
  const large = cleanupPlan({
    overlayTypes: ['foreign_title'],
    rationale: '大块外文压在主体上。',
    method: 'ffmpeg_delogo',
    provider: 'ffmpeg-delogo',
    zones: [{ x: 0.2, y: 0.2, width: 0.6, height: 0.4 }],
  });
  const largeErrors = [];
  validateCleanupPlan(large, 'cleanup', largeErrors);
  assert.ok(largeErrors.length > 0);
  const result = await materializeCleanMedia({
    artifactRoot: path.join(root, 'artifacts'),
    mapping: source,
    cleanup: large,
  });
  assert.equal(result.status, 'fallback');
  const blur = await materializeCleanMedia({
    artifactRoot: path.join(root, 'artifacts'),
    mapping: source,
    cleanup: cleanupPlan({
      method: 'ffmpeg_mask_blur',
      provider: 'ffmpeg-mask-blur',
      zones: [{ x: 0.82, y: 0.8, width: 0.14, height: 0.16 }],
    }),
  });
  assert.equal(blur.status, 'fallback');
  assert.match(blur.reason, /blur|降级/);
});

test('后处理复检拒绝与原片没有质量合格变化的 clean-media', async (t) => {
  if (!(await resolveToolPath('ffmpeg')) || !(await resolveToolPath('ffprobe'))) {
    t.skip('本机缺少 ffmpeg 或 ffprobe。');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiandu-cleanup-no-change-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'pending');
  await fs.mkdir(sourceDir, { recursive: true });
  const source = await createLogoVideo(sourceDir);
  const prepared = await preparePendingMedia(sourceDir, { cacheRoot: path.join(root, 'prepare-cache') });
  const item = prepared.items[0];
  const plan = cleanupPlan({
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
      method: 'ffmpeg_delogo',
      provider: 'ffmpeg-delogo',
      status: 'generated',
    }],
    fcpxml: pathToFileURL(source).href,
  });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].resultStatus, 'unresolved');
  assert.ok(result.results[0].warnings.some((message) => /没有被处理|质量|模糊|马赛克/.test(message)));
});

test('inpainting provider 不可用时使用安全 fallback，不伪造修复成功', async () => {
  const source = {
    assetId: 'asset', type: 'video', projectAbsolutePath: '/tmp/not-used.mp4',
    sourceSha256: crypto.createHash('sha256').update('source').digest('hex'),
    metadata: { hasAudio: false },
  };
  const cleanup = cleanupPlan({
    provider: 'inpainting',
    method: 'ffmpeg_delogo',
    fallback: 'crop_reframe',
    fallbackLayout: { crop: { top: 0.2, left: 0, right: 0, bottom: 0 } },
  });
  const result = await materializeCleanMedia({ artifactRoot: '/tmp/jiandu-cleanup-test', mapping: source, cleanup });
  assert.equal(result.status, 'fallback');
  assert.equal(result.mapping.projectAbsolutePath, source.projectAbsolutePath);
});

test('crop layout 会进入最终 shot，revision 复制保留 cleanup', () => {
  const plan = cropPlan({ rationale: 'revision 保留原判断。' });
  const analysis = { timeline: { shots: [{ id: 'shot', cleanup: plan }] }, assets: [] };
  const revised = structuredClone(analysis);
  revised.timeline.shots[0].purpose = '新增说明';
  assert.equal(resolveCleanupPlan(revised.timeline.shots[0], null).rationale, plan.rationale);
  const merged = mergeCleanupLayout({ id: 'shot', fitMode: 'contain' }, plan);
  assert.equal(merged.layout.crop.top, 0.18);
  assert.equal(merged.layout.mode, 'center_crop');
  assert.equal(merged.fitMode, 'cover');
});

test('无法高质量净化的素材允许 omit，不得再写成 cleaned', () => {
  const errors = [];
  validateCleanupPlan(cleanupPlan({
    decision: 'omit',
    method: 'preserve',
    provider: 'none',
    overlayTypes: ['foreign_title', 'platform_sticker'],
    zones: [{ x: 0.2, y: 0.2, width: 0.6, height: 0.5 }],
    rationale: '覆盖物压在猫和人物上，无法通过构图去掉，像素修复会损坏主体，不使用该素材。',
  }), 'cleanup', errors);
  assert.deepEqual(errors, []);
});
