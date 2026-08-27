const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  VIDEO_ANALYSIS_FILE,
  VIDEO_MANIFEST_FILE,
  VIDEO_STATUS_FILE,
} = require('../src/constants');
const {
  buildFcpxml,
  validateFcpxmlStructure,
} = require('../src/services/fcpxml-service');
const {
  approveDouyinVariant,
  buildDouyinVariant,
  createDouyinVariant,
  generateDouyinPreview,
  loadDouyinProfile,
  normalizeDouyinPlan,
  safeZoneIssues,
  saveDouyinVariantDraft,
  validateDouyinPlan,
} = require('../src/services/platform-variant-service');
const { runMediaTool, probeMedia } = require('../src/services/media-tool-service');
const { snapshotSource } = require('../src/services/pending-media-service');
const { resolveToolPath } = require('../src/services/media-tool-service');

function layout(mode, overrides = {}) {
  return {
    mode,
    scale: 1,
    position: { x: 0, y: 0 },
    crop: { left: 0.05, top: 0.05, right: 0.05, bottom: 0.05 },
    secondaryCrop: { left: 0.2, top: 0.15, right: 0.2, bottom: 0.15 },
    splitRatio: 0.46,
    subjectBounds: { x: 0.25, y: 0.2, width: 0.35, height: 0.3 },
    sourceTextBounds: [{ x: 0.1, y: 0.82, width: 0.5, height: 0.08 }],
    minReadableTextHeightPx: 32,
    agentNote: 'Agent 建议优先展示当前操作区域。',
    ...overrides,
  };
}

function fixtureContext(profile, options = {}) {
  const contentSummary = options.sensitive
    ? '开发录屏显示 /Users/alice/work 路径与 API token 设置。'
    : '横屏录屏展示完整界面、关键操作区域和最终结果。';
  return {
    profile,
    manifest: {
      items: [{
        assetId: 'screen',
        filename: '开发录屏.mov',
        type: 'video',
        metadata: {
          durationSec: 6,
          displayWidth: 1920,
          displayHeight: 1080,
          width: 1920,
          height: 1080,
          frameRate: 30,
          frameCount: 180,
          hasAudio: true,
          audioChannels: 2,
          sampleRate: 48000,
        },
      }],
    },
    analysis: {
      assets: [{
        assetId: 'screen',
        type: 'video',
        status: 'adopt',
        reason: '真实开发录屏，可按操作过程连续拆分。',
        confidence: 0.9,
        contentSummary,
      }],
      lightCaptionPlan: [],
    },
    requiredCaptionAssetIds: [],
  };
}

function advancedPlan() {
  return {
    schemaVersion: 1,
    platform: 'douyin',
    profileId: 'douyin-vertical-v1',
    planningPolicy: {
      fixedTargetDuration: false,
      fixedShotCount: false,
      fixedVideoCount: false,
      selectionDrivenByContent: true,
    },
    selection: [{
      assetId: 'screen',
      decision: 'selected',
      reason: '录屏包含完整界面、操作过程与最终结果，按内容连续选用。',
      selectedRanges: [{ startSec: 0, endSec: 6, reason: '覆盖完整连续操作过程。' }],
      factors: {
        visualAppeal: 4,
        standaloneStrength: 4,
        themeConsistency: 5,
        mobileFit: 3,
        verticalPerformance: 4,
        contextCost: 3,
        visualChange: 5,
        originalAudioValue: 4,
        repetition: 4,
      },
    }],
    videos: [{
      videoId: 'douyin-screen',
      theme: '开发录屏竖屏重构',
      rationale: '同一源录屏按完整界面、关键区域与结果连续呈现。',
      openingAssetId: 'screen',
      naturalEnding: '以最终结果界面自然结束。',
      shots: [
        {
          shotId: 'screen-full',
          assetId: 'screen',
          inSec: 0,
          outSec: 2,
          purpose: '展示完整界面',
          audioMode: 'keep',
          muteReason: null,
          layout: layout('screen_focus'),
        },
        {
          shotId: 'screen-split',
          assetId: 'screen',
          inSec: 2,
          outSec: 4,
          purpose: '上层完整界面，下层关键区域放大',
          audioMode: 'keep',
          muteReason: null,
          layout: layout('screen_split'),
        },
        {
          shotId: 'screen-result',
          assetId: 'screen',
          inSec: 4,
          outSec: 6,
          purpose: '展示最终结果',
          audioMode: 'keep',
          muteReason: null,
          layout: layout('segmented_focus', {
            crop: { left: 0.35, top: 0.2, right: 0.05, bottom: 0.1 },
          }),
        },
      ],
      lightCaptions: [{
        captionId: 'caption-context',
        assetId: 'screen',
        shotId: 'screen-split',
        text: '一层看全局，一层看关键操作',
        offsetSec: 0.2,
        durationSec: 1.5,
        position: 'top-safe',
        purpose: '解释上下双层关系',
        kind: 'context',
        basedOn: '真实录屏内容',
        required: true,
        sourceLocked: false,
      }],
      warnings: [],
    }],
    createdBy: 'stage7b-test',
  };
}

function mapping(mediaPath = '/tmp/stage7b-screen.mov') {
  return {
    assetId: 'screen',
    type: 'video',
    projectFilename: '开发录屏.mov',
    projectAbsolutePath: mediaPath,
    metadata: {
      durationSec: 6,
      displayWidth: 1920,
      displayHeight: 1080,
      width: 1920,
      height: 1080,
      frameRate: 30,
      frameCount: 180,
      hasAudio: true,
      audioChannels: 2,
      sampleRate: 48000,
    },
  };
}

test('Stage 7B 三种高级布局保留独立裁切、缩放、位置、双层比例与 Agent 建议值', async () => {
  const { profile } = await loadDouyinProfile();
  const validated = validateDouyinPlan(advancedPlan(), fixtureContext(profile));
  assert.deepEqual(
    validated.videos[0].shots.map((shot) => shot.layout.mode),
    ['screen_focus', 'screen_split', 'segmented_focus'],
  );
  assert.equal(validated.videos[0].shots[1].layout.splitRatio, 0.46);
  assert.equal(validated.videos[0].shots[1].layout.secondaryCrop.left, 0.2);
  assert.equal(validated.videos[0].shots[0].agentLayout.agentNote, 'Agent 建议优先展示当前操作区域。');
  assert.equal(validated.videos[0].lightCaptions[0].kind, 'context');
});

test('同源分段局部放大保持连续源时间码，不连续时明确拒绝', async () => {
  const { profile } = await loadDouyinProfile();
  const context = fixtureContext(profile);
  assert.doesNotThrow(() => validateDouyinPlan(advancedPlan(), context));
  const broken = normalizeDouyinPlan(advancedPlan());
  broken.videos[0].shots[2].inSec = 4.2;
  assert.throws(
    () => validateDouyinPlan(broken, context),
    (error) => error.details.some((message) => /源时间码必须连续/.test(message)),
  );
});

test('上下双层录屏生成两层 FCPXML，仅重复画面层静音且主镜头保持原始时间码', () => {
  const plan = normalizeDouyinPlan(advancedPlan());
  const shot = plan.videos[0].shots[1];
  const analysis = {
    titles: { recommended: '上下双层录屏' },
    timeline: {
      orientation: 'vertical',
      width: 1080,
      height: 1920,
      fps: 30,
      shots: [{
        id: shot.shotId,
        assetId: shot.assetId,
        inSec: shot.inSec,
        outSec: shot.outSec,
        durationSec: shot.outSec - shot.inSec,
        fitMode: 'contain',
        audioMode: 'keep',
        purpose: shot.purpose,
        layout: shot.layout,
      }],
      markers: [],
    },
  };
  const xml = buildFcpxml({
    projectName: 'Stage 7B 双层布局',
    analysis,
    assetMappings: [mapping()],
  });
  const report = validateFcpxmlStructure(xml, {
    assetCount: 1,
    shotCount: 1,
    markerCount: 0,
    width: 1080,
    height: 1920,
    fps: 30,
  });
  assert.equal(report.ok, true, report.errors.join('；'));
  assert.equal(report.clipCount, 1, '双层画面不能被误算为两个主线镜头');
  assert.match(xml, /start="2s"/);
  assert.match(
    xml,
    /上下双层录屏 · 关键区域"[\s\S]*?<adjust-volume amount="-96dB"\/>/,
  );
  assert.equal((xml.match(/<adjust-volume amount="-96dB"\/>/g) || []).length, 1);
});

test('三种高级布局生成真实 1080×1920 手机预览并保留单路原声', {
  timeout: 60_000,
}, async (t) => {
  if (!resolveToolPath('ffmpeg') || !resolveToolPath('ffprobe')) {
    t.skip('当前环境缺少 ffmpeg/ffprobe');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stage7b-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'screen.mp4');
  await runMediaTool('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc2=size=640x360:rate=30:duration=1.2',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000:duration=1.2',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    source,
  ], { timeoutMs: 30_000 });
  const sourceMetadata = await probeMedia(source);
  const modes = ['screen_focus', 'screen_split', 'segmented_focus'];
  const analysis = {
    timeline: {
      orientation: 'vertical',
      width: 1080,
      height: 1920,
      fps: 30,
      shots: modes.map((mode, index) => ({
        id: `shot-${index + 1}`,
        assetId: 'screen',
        inSec: index * 0.4,
        outSec: (index + 1) * 0.4,
        durationSec: 0.4,
        fitMode: 'contain',
        audioMode: 'keep',
        purpose: mode,
        layout: layout(mode),
      })),
      markers: [],
    },
  };
  const output = path.join(root, 'preview.mp4');
  const { profile } = await loadDouyinProfile();
  const result = await generateDouyinPreview(output, analysis, [{
    ...mapping(source),
    metadata: {
      ...sourceMetadata,
      durationSec: 1.2,
      displayWidth: 640,
      displayHeight: 360,
    },
  }], profile);
  assert.equal(result.metadata.displayWidth, 1080);
  assert.equal(result.metadata.displayHeight, 1920);
  assert.equal(result.metadata.hasAudio, true);
  assert.ok(result.metadata.durationSec >= 1.1);
});

test('手机安全区、字幕重叠、小字和敏感开发信息只生成警告并要求人工确认', async () => {
  const { profile } = await loadDouyinProfile();
  const plan = advancedPlan();
  plan.videos[0].shots[0].layout.minReadableTextHeightPx = 8;
  plan.videos[0].shots[1].layout.subjectBounds = null;
  plan.videos[0].shots[1].layout.sourceTextBounds = [
    { ...profile.subtitlePlacements['top-safe'] },
  ];
  const validated = validateDouyinPlan(plan, fixtureContext(profile, { sensitive: true }));
  const warningText = validated.videos[0].warnings.map((warning) => warning.message).join('\n');
  assert.match(warningText, /可能不可读/);
  assert.match(warningText, /关键区域/);
  assert.match(warningText, /路径、账号或凭据/);
  const safety = safeZoneIssues(profile, validated.videos[0]);
  assert.match(safety.warnings.join('\n'), /原画界面文字重叠/);
  assert.equal(safety.errors.length, 0, '视觉不确定时应警告并人工确认，而不是自动删除素材');
});

test('布局修改后批准哈希与旧生成状态失效，未重新批准不得生成旧 FCPXML', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stage7b-approval-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const project = path.join(root, 'project');
  const selected = path.join(project, '01-精选素材');
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(path.join(project, '00-项目总控'), { recursive: true });
  await fs.mkdir(selected, { recursive: true });
  const sourceFile = path.join(source, '开发录屏.mov');
  const selectedFile = path.join(selected, '开发录屏.mov');
  await fs.writeFile(sourceFile, 'source-video');
  await fs.copyFile(sourceFile, selectedFile);
  const sourceSnapshot = await snapshotSource(source);
  const context = fixtureContext((await loadDouyinProfile()).profile);
  await fs.writeFile(
    path.join(project, VIDEO_MANIFEST_FILE),
    `${JSON.stringify({
      schemaVersion: 1,
      sourceDirectory: source,
      sourceSnapshot,
      items: context.manifest.items,
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(project, VIDEO_ANALYSIS_FILE),
    `${JSON.stringify({
      schemaVersion: 1,
      titles: { candidates: ['开发录屏'], recommended: '开发录屏', rationale: '真实录屏。' },
      theme: { summary: '开发录屏', rationale: '真实录屏。', confidence: 1, folderNameConflict: false },
      assets: context.analysis.assets,
      lightCaptionPlan: [],
      timeline: {
        orientation: 'horizontal',
        width: 1920,
        height: 1080,
        fps: 30,
        shots: [],
        markers: [],
      },
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(project, VIDEO_STATUS_FILE),
    `${JSON.stringify({
      schemaVersion: 1,
      formats: { timeline: { fps: 30 } },
      assetMappings: [{
        ...mapping(selectedFile),
        projectRelativePath: '01-精选素材/开发录屏.mov',
      }],
    }, null, 2)}\n`,
  );
  const created = await createDouyinVariant(project, { plan: advancedPlan() });
  const warningIds = created.plan.videos.flatMap((video) =>
    video.warnings.map((warning) => warning.warningId));
  const approved = await approveDouyinVariant(project, created.variantId, {
    approvedWarningIds: warningIds,
  });
  assert.equal(approved.approval.revision, 1);
  const changed = structuredClone(approved.plan);
  changed.videos[0].shots[0].layout.scale = 1.25;
  const saved = await saveDouyinVariantDraft(project, created.variantId, changed, {
    expectedRevision: approved.revision,
  });
  assert.equal(saved.revision, 2);
  assert.equal(saved.status, 'draft');
  assert.equal(saved.approval, null);
  assert.deepEqual(saved.outputs, []);
  await assert.rejects(
    buildDouyinVariant(project, created.variantId),
    { code: 'DOUYIN_PLAN_NOT_APPROVED' },
  );
});
