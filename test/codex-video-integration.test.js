const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  buildCodexVideoProject,
  verifyCodexVideoProject,
} = require('../src/services/codex-video-service');
const { runMediaTool } = require('../src/services/media-tool-service');
const {
  compareSourceSnapshots,
  inspectVideoRange,
  preparePendingMedia,
  snapshotSource,
} = require('../src/services/pending-media-service');
const { resolveToolPath } = require('../src/services/stage7-service');

async function mediaToolsAvailable() {
  return Boolean(
    await resolveToolPath('ffmpeg')
      && await resolveToolPath('ffprobe')
      && await resolveToolPath('xmllint'),
  );
}

async function createImage(outputPath, color) {
  await runMediaTool('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=${color}:s=640x360`,
    '-vf', 'drawbox=x=80:y=60:w=480:h=240:color=white@0.65:t=fill',
    '-frames:v', '1',
    '-update', '1',
    outputPath,
  ], { timeoutMs: 60_000 });
}

async function createVideo(outputPath) {
  await runMediaTool('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc2=duration=2.4:size=640x360:rate=30',
    '-f', 'lavfi',
    '-i', 'sine=frequency=880:duration=2.4',
    '-shortest',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    outputPath,
  ], { timeoutMs: 60_000 });
}

async function fileFingerprint(filePath) {
  const [buffer, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
  return {
    sha256: require('node:crypto').createHash('sha256').update(buffer).digest('hex'),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

test('最小样例从中文空格素材目录完成 v3、FCPXML、marker、预览与验证闭环', {
  timeout: 180_000,
}, async (t) => {
  if (!(await mediaToolsAvailable())) {
    t.skip('本机缺少 ffmpeg、ffprobe 或 xmllint。');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-video-e2e-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, '宽泛 名称 与内容不一致');
  const cacheRoot = path.join(root, '分析 缓存');
  const projectRoot = path.join(root, '正式 项目库');
  await fs.mkdir(source, { recursive: true });
  await createVideo(path.join(source, '屏幕录制 2026-07-16 14.22.31.mov'));
  await createImage(path.join(source, '截屏 最终结果 2026-07-16.png'), '0x2e8b57');
  await createImage(path.join(source, 'IMG_6382.png'), '0x555555');
  await fs.writeFile(path.join(source, '本期重点.txt'), '重点看实际操作和最终结果，不以文件夹名为标题。\n', 'utf8');

  const sourceBefore = await snapshotSource(source);
  const prepared = await preparePendingMedia(source, { cacheRoot });
  assert.equal(prepared.items.length, 3);
  assert.equal(prepared.sourceVerification.unchanged, true);
  const video = prepared.items.find((item) => item.type === 'video');
  const finalImage = prepared.items.find((item) => item.filename.includes('最终结果'));
  const duplicateImage = prepared.items.find((item) => item.filename === 'IMG_6382.png');
  assert.ok(video.analysisMedia.timedFrames.length >= 2);
  assert.ok(video.analysisMedia.storyboard);
  assert.ok(video.analysisMedia.storyboardLegend);
  assert.ok(finalImage.analysisMedia.imagePreview);

  const cached = await preparePendingMedia(source, { cacheRoot });
  assert.equal(cached.cached, true);
  assert.equal(cached.analysisRequestPath, prepared.analysisRequestPath);

  const dense = await inspectVideoRange(
    prepared.manifestPath,
    video.assetId,
    0,
    Math.min(1.2, video.metadata.durationSec),
    0.4,
  );
  assert.ok(dense.frames.length >= 3);
  assert.ok(dense.storyboard, dense.warnings.join('；'));

  const analysis = {
    schemaVersion: 1,
    theme: {
      summary: '从动态操作验证到最终结果确认',
      rationale: '录屏展示连续操作与测试画面，绿色结果截图适合作为完成状态；灰色图片与叙事重复。',
      confidence: 0.92,
      folderNameConflict: true,
    },
    titles: {
      candidates: ['把操作过程和结果接起来', '从动态验证到最终确认', '录屏与结果截图的完整闭环'],
      recommended: '从动态验证到最终确认',
      rationale: '标题直接对应录屏中的动态过程和截图中的最终状态，不复制宽泛文件夹名。',
    },
    assets: [
      {
        assetId: video.assetId,
        type: 'video',
        semanticLabels: ['动态操作', '测试画面'],
        contentSummary: '测试图案录屏连续变化并带有原始音频。',
        suggestedUse: ['开头动态画面', '操作过程'],
        status: 'adopt',
        reason: '提供主要动态过程。',
        ranges: [{ startSec: 0, endSec: 1.5, confidence: 0.84, reviewRequired: false }],
        confidence: 0.87,
      },
      {
        assetId: finalImage.assetId,
        type: 'image',
        semanticLabels: ['最终结果', '完成状态'],
        contentSummary: '绿色结果截图显示稳定完成状态。',
        suggestedUse: ['结果确认', '收尾'],
        status: 'adopt',
        reason: '与动态过程形成结果落点。',
        ranges: [],
        confidence: 0.95,
      },
      {
        assetId: duplicateImage.assetId,
        type: 'image',
        semanticLabels: ['重复静态画面'],
        contentSummary: '灰色静态图片没有补充新的叙事信息。',
        suggestedUse: [],
        status: 'reject',
        reason: '内容重复且没有可见结果价值。',
        ranges: [],
        confidence: 0.9,
      },
    ],
    timeline: {
      orientation: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 30,
      shots: [
        {
          id: 'shot-001', assetId: video.assetId, inSec: 0, outSec: 1.2,
          durationSec: 1.2, fitMode: 'contain', audioMode: 'keep',
          purpose: '用动态变化快速建立过程', confidence: 0.85, reviewRequired: false,
        },
        {
          id: 'shot-002', assetId: finalImage.assetId, inSec: 0, outSec: 1,
          durationSec: 1, fitMode: 'contain', audioMode: 'mute',
          purpose: '停留确认最终状态', confidence: 0.95, reviewRequired: false,
        },
      ],
      markers: [
        { timeSec: 0.3, text: '开始验证' },
        { timeSec: 1.4, text: '结果确认' },
      ],
    },
  };
  const analysisPath = path.join(root, 'Codex 分析 结果.json');
  await fs.writeFile(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
  const built = await buildCodexVideoProject({
    manifestPath: prepared.manifestPath,
    analysisPath,
    projectRoot,
    projectName: '中文 项目 带 空格',
  });
  assert.equal(built.ok, true);
  assert.equal(built.verification.ok, true);
  assert.equal(built.verification.fcpxml.assetCount, 2);
  assert.equal(built.verification.fcpxml.clipCount, 2);
  assert.equal(built.verification.fcpxml.markerCount, 2);
  assert.equal(built.verification.previewMetadata.displayWidth, 640);
  assert.equal(built.verification.previewMetadata.displayHeight, 360);
  assert.equal(built.verification.previewMetadata.frameRate, 30);
  assert.deepEqual(built.formats.timeline, {
    orientation: 'horizontal', width: 1920, height: 1080, fps: 30,
  });
  assert.deepEqual(built.formats.preview, { width: 640, height: 360, fps: 30 });
  assert.equal(built.verification.fcpxml.sequenceFormat.width, 1920);
  assert.equal(built.verification.fcpxml.sequenceFormat.height, 1080);
  assert.equal(built.verification.fcpxml.sequenceFormat.frameDuration, '1/30s');
  assert.equal(built.assetMappings.length, 2);
  const projectAssets = await fs.readdir(path.join(built.projectPath, '01-精选素材'));
  assert.ok(projectAssets.includes(video.filename));
  assert.ok(projectAssets.includes(finalImage.filename));
  assert.ok(!projectAssets.includes(duplicateImage.filename));
  const summary = await fs.readFile(built.artifacts.summaryPath, 'utf8');
  assert.match(summary, /文件夹名称与素材实际内容存在差异，本次主题以素材内容为准。/);
  assert.match(summary, /IMG_6382\.png｜reject/);
  const xml = await fs.readFile(built.artifacts.fcpxmlPath, 'utf8');
  assert.doesNotMatch(xml, /roughcut-preview\.mp4/);
  assert.match(xml, /<sequence[^>]*format="r1"/);
  assert.match(xml, /<format id="r1" frameDuration="1\/30s" width="1920" height="1080"/);

  const protectedFiles = [
    path.join(built.projectPath, '00-项目总控/project.json'),
    path.join(built.projectPath, '00-项目总控/assets.json'),
    path.join(built.projectPath, '00-项目总控/Codex视频分析.json'),
    path.join(built.projectPath, '00-项目总控/Codex视频状态.json'),
    path.join(built.projectPath, '00-项目总控/Codex视频素材清单.json'),
    built.artifacts.fcpxmlPath,
    built.artifacts.previewPath,
  ];
  const protectedBefore = await Promise.all(protectedFiles.map(fileFingerprint));
  const readOnlyVerification = await verifyCodexVideoProject(built.projectPath);
  assert.equal(readOnlyVerification.ok, true);
  assert.deepEqual(
    await Promise.all(protectedFiles.map(fileFingerprint)),
    protectedBefore,
    '只读验证不得改写项目 JSON、FCPXML 或粗剪预览',
  );

  const movedProjectPath = path.join(projectRoot, '已改名项目');
  await fs.rename(built.projectPath, movedProjectPath);
  const movedVerification = await verifyCodexVideoProject(movedProjectPath);
  assert.equal(movedVerification.ok, true);
  assert.ok(movedVerification.warnings.some((message) => /移动或改名/.test(message)));
  assert.equal(movedVerification.fcpxml.clipCount, 2);
  assert.equal(movedVerification.fcpxml.markerCount, 2);

  const sourceAfter = await snapshotSource(source);
  assert.deepEqual(compareSourceSnapshots(sourceBefore, sourceAfter), {
    unchanged: true,
    errors: [],
    beforeDigest: sourceBefore.digest,
    afterDigest: sourceAfter.digest,
  });
});

test('损坏视频保留清单记录并给出明确降级说明', { timeout: 60_000 }, async (t) => {
  if (!(await resolveToolPath('ffmpeg')) || !(await resolveToolPath('ffprobe'))) {
    t.skip('本机缺少 ffmpeg 或 ffprobe。');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-video-broken-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, '损坏素材');
  await fs.mkdir(source, { recursive: true });
  await createImage(path.join(source, '可用截图.png'), '0x336699');
  await fs.writeFile(path.join(source, '空视频.mov'), Buffer.alloc(0));
  const prepared = await preparePendingMedia(source, { cacheRoot: path.join(root, 'cache') });
  const broken = prepared.items.find((item) => item.filename === '空视频.mov');
  assert.ok(broken.metadataError);
  assert.equal(broken.analysisMedia.storyboard, null);
  assert.ok(prepared.warnings.some((message) => /为空、损坏或不可解码/.test(message)));
  assert.equal(prepared.sourceVerification.unchanged, true);
});
