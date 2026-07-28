const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  CODEX_VIDEO_ANALYSIS_FILE,
  CODEX_VIDEO_MANIFEST_FILE,
  CODEX_VIDEO_STATUS_FILE,
} = require('../src/constants');
const {
  alignSourceTime,
  buildSubjectTracking,
  normalizeTracking,
  validateTracking,
} = require('../src/services/subject-tracking-service');
const {
  buildFcpxml,
  frameDuration,
  validateFcpxmlStructure,
} = require('../src/services/fcpxml-service');
const {
  approveDouyinVariant,
  createDouyinVariant,
  generateDouyinPreview,
  loadDouyinProfile,
  normalizeDouyinPlan,
  saveDouyinVariantDraft,
  validateDouyinPlan,
} = require('../src/services/platform-variant-service');
const { probeMedia, runMediaTool } = require('../src/services/media-tool-service');
const { snapshotSource } = require('../src/services/pending-media-service');
const { resolveToolPath } = require('../src/services/stage7-service');

const SAFE_ZONE = { x: 0.07, y: 0.08, width: 0.72, height: 0.72 };

function observation(sourceTimeSec, x, confidence = 0.9, extras = {}) {
  return {
    sourceTimeSec,
    subjects: [{
      bounds: { x, y: 0.2, width: 0.18, height: 0.42 },
      confidence,
      primary: extras.primary !== false,
    }, ...(extras.subjects || [])],
  };
}

function tracking(options = {}) {
  return buildSubjectTracking({
    inSec: 0,
    outSec: 3,
    fps: 30,
    subjectType: 'person',
    safeZone: SAFE_ZONE,
    observations: [
      observation(0, 0.08),
      observation(1, 0.35),
      observation(2, 0.68),
      observation(3, 0.72),
    ],
    ...options,
  });
}

function layout(trackingData = tracking()) {
  return {
    mode: 'subject_track',
    scale: 1,
    position: { x: 0, y: 0 },
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    secondaryCrop: { left: 0, top: 0, right: 0, bottom: 0 },
    splitRatio: 0.5,
    subjectBounds: { x: 0.08, y: 0.2, width: 0.18, height: 0.42 },
    sourceTextBounds: [],
    minReadableTextHeightPx: null,
    agentNote: '跟随主要人物。',
    tracking: trackingData,
  };
}

function plan(trackingData = tracking()) {
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
      assetId: 'moving',
      decision: 'selected',
      reason: '人物横向移动构成完整动作。',
      selectedRanges: [],
      factors: {
        visualAppeal: 4,
        standaloneStrength: 4,
        themeConsistency: 5,
        mobileFit: 3,
        verticalPerformance: 5,
        contextCost: 4,
        visualChange: 5,
        originalAudioValue: 5,
        repetition: 5,
      },
    }],
    videos: [{
      videoId: 'douyin-track',
      theme: '动态主体',
      rationale: '跟随横向移动人物。',
      openingAssetId: 'moving',
      naturalEnding: '动作结束自然收束。',
      shots: [{
        shotId: 'tracking-shot',
        assetId: 'moving',
        inSec: 0,
        outSec: 3,
        purpose: '跟随人物',
        audioMode: 'keep',
        muteReason: null,
        layout: layout(trackingData),
      }],
      lightCaptions: [],
      warnings: [],
    }],
    createdBy: 'stage7c-test',
  };
}

function context(profile) {
  return {
    profile,
    manifest: {
      items: [{
        assetId: 'moving',
        filename: 'moving-person.mov',
        type: 'video',
        metadata: {
          durationSec: 3,
          displayWidth: 1920,
          displayHeight: 1080,
          frameRate: 30,
          frameCount: 90,
          hasAudio: true,
        },
      }],
    },
    analysis: {
      timeline: { fps: 30 },
      assets: [{
        assetId: 'moving',
        type: 'video',
        status: 'adopt',
        reason: '完整动作。',
        confidence: 0.95,
        contentSummary: '人物从左向右移动。',
      }],
    },
    requiredCaptionAssetIds: [],
  };
}

function mapping() {
  return {
    assetId: 'moving',
    type: 'video',
    projectFilename: 'moving-person.mov',
    projectAbsolutePath: '/tmp/moving-person.mov',
    metadata: {
      durationSec: 3,
      displayWidth: 1920,
      displayHeight: 1080,
      frameRate: 30,
      frameCount: 90,
      hasAudio: true,
      audioChannels: 2,
      sampleRate: 48000,
    },
  };
}

test('静止主体只保留起点和终点，不产生无意义密集关键帧', () => {
  const result = tracking({
    observations: [0, 0.5, 1, 1.5, 2, 2.5, 3]
      .map((time) => observation(time, 0.35)),
  });
  assert.equal(result.status, 'tracked');
  assert.equal(result.keyframes.length, 2);
  assert.deepEqual(result.keyframes.map((item) => item.sourceTimeSec), [0, 3]);
});

test('横向移动主体生成平滑位置关键帧并保持源画面边界合法', () => {
  const result = tracking();
  assert.ok(result.keyframes.length >= 3);
  assert.ok(result.keyframes[0].position.x > result.keyframes.at(-1).position.x);
  assert.ok(result.points.every((point) => (
    point.bounds.x >= 0 && point.bounds.x + point.bounds.width <= 1
  )));
});

test('横屏填充到 9:16 时按实际宽高比计算平移，且不以缩小露黑边代替跟踪', () => {
  const result = tracking({
    sourceAspect: 460 / 404,
    outputAspect: 1080 / 1920,
    observations: [
      observation(0, 0.18),
      observation(1, 0.205),
      observation(2, 0.24),
      observation(3, 0.28),
    ],
  });
  assert.equal(result.status, 'tracked');
  assert.equal(result.sourceAspect, 460 / 404);
  assert.equal(result.outputAspect, 1080 / 1920);
  assert.ok(result.keyframes.every((keyframe) => keyframe.scale >= 1));
  assert.ok(result.keyframes[0].position.x > result.keyframes.at(-1).position.x);
  const normalized = normalizeTracking(result);
  assert.equal(normalized.sourceAspect, Number((460 / 404).toFixed(6)));
  assert.equal(normalized.outputAspect, 0.5625);
});

test('往返移动保留方向变化点，避免把关键动作过度平滑掉', () => {
  const result = tracking({
    observations: [
      observation(0, 0.1),
      observation(1, 0.65),
      observation(2, 0.12),
      observation(3, 0.62),
    ],
  });
  const positions = result.keyframes.map((item) => item.position.x);
  assert.ok(positions.length >= 4);
  assert.notEqual(Math.sign(positions[1] - positions[0]), Math.sign(positions[2] - positions[1]));
});

test('人物、动物、车辆与明显运动物体均使用同一逐镜头 tracking 结构', () => {
  for (const subjectType of ['person', 'animal', 'vehicle', 'moving_object']) {
    const result = tracking({ subjectType });
    assert.equal(result.subjectType, subjectType);
    assert.equal(result.status, 'tracked');
    assert.ok(result.points.length > 0);
  }
});

test('用户人工指定区域可保存为 manual 跟踪点', () => {
  const result = tracking({ subjectType: 'user_region', origin: 'manual' });
  assert.equal(result.subjectType, 'user_region');
  assert.ok(result.points.every((point) => point.origin === 'manual'));
});

test('多主体分散且没有明确主要主体时安全降级并记录原因', () => {
  const second = {
    bounds: { x: 0.72, y: 0.22, width: 0.2, height: 0.4 },
    confidence: 0.88,
    primary: false,
  };
  const result = tracking({
    observations: [
      observation(0, 0.02, 0.86, { primary: false, subjects: [second] }),
      observation(1, 0.04, 0.84, { primary: false, subjects: [second] }),
      observation(2, 0.06, 0.82, { primary: false, subjects: [second] }),
      observation(3, 0.08, 0.8, { primary: false, subjects: [second] }),
    ],
  });
  assert.equal(result.status, 'fallback');
  assert.equal(result.fallback.applied, true);
  assert.equal(result.fallback.mode, 'landscape_card_blur');
  assert.match(result.fallback.reason, /多个关键主体/);
});

test('低置信度不得静默批准，人工确认继续后才通过跟踪校验', () => {
  const result = tracking({
    observations: [0, 1, 2, 3].map((time) => observation(time, 0.3, 0.42)),
  });
  assert.equal(result.status, 'low_confidence');
  assert.match(validateTracking(result, { fps: 30, inSec: 0, outSec: 3 }).errors.join('\n'), /人工确认/);
  result.manualConfirmation = 'approved_continue';
  assert.equal(validateTracking(result, { fps: 30, inSec: 0, outSec: 3 }).errors.length, 0);
});

test('人工可新增、移动和删除跟踪点，规范化后关键帧仍按时间排序', () => {
  const result = normalizeTracking(tracking());
  result.points.push({
    pointId: 'manual-added',
    sourceTimeSec: 1.5,
    sourceTime: '3/2s',
    bounds: { x: 0.45, y: 0.18, width: 0.2, height: 0.45 },
    confidence: 1,
    origin: 'manual',
    locked: false,
  });
  result.points.find((point) => point.pointId === 'manual-added').bounds.x = 0.5;
  result.points = result.points.filter((point) => point.pointId !== 'track-2');
  const normalized = normalizeTracking(result);
  assert.ok(normalized.points.some((point) => point.pointId === 'manual-added' && point.bounds.x === 0.5));
  assert.ok(!normalized.points.some((point) => point.pointId === 'track-2'));
  assert.deepEqual(
    normalized.keyframes.map((item) => item.sourceTimeSec),
    [...normalized.keyframes.map((item) => item.sourceTimeSec)].sort((a, b) => a - b),
  );
});

test('跟踪点与关键帧使用实际 frameDuration 对齐', () => {
  const ntsc = frameDuration(29.97);
  const aligned = alignSourceTime(2, ntsc);
  assert.equal(aligned.fcpTime, '1001/500s');
  assert.equal(aligned.seconds, 2.002);
  const result = tracking();
  assert.equal(validateTracking(result, { fps: 30, inSec: 0, outSec: 3 }).errors.length, 0);
});

test('FCPXML 1.14 生成可编辑 position/scale transform 关键帧且顺序合法', () => {
  const trackingData = tracking();
  const analysis = {
    titles: { recommended: '动态主体跟踪' },
    assets: [],
    timeline: {
      orientation: 'vertical',
      width: 1080,
      height: 1920,
      fps: 30,
      shots: [{
        id: 'tracking-shot',
        assetId: 'moving',
        inSec: 0,
        outSec: 3,
        durationSec: 3,
        fitMode: 'cover',
        audioMode: 'keep',
        purpose: '跟随人物',
        layout: layout(trackingData),
      }],
      markers: [],
    },
  };
  const xml = buildFcpxml({
    projectName: 'Stage 7C',
    analysis,
    assetMappings: [mapping()],
  });
  const report = validateFcpxmlStructure(xml, {
    shotCount: 1,
    assetCount: 1,
    markerCount: 0,
    titleCount: 0,
    width: 1080,
    height: 1920,
    fps: 30,
  });
  assert.equal(report.ok, true, report.errors.join('；'));
  assert.equal(report.version, '1.14');
  assert.equal(report.transformKeyframeCount, trackingData.keyframes.length * 2);
  assert.match(xml, /<param name="position"/);
  assert.match(xml, /<param name="scale"/);
  assert.doesNotMatch(xml, /<keyframe[^>]*\sinterp=/);
});

test('普通单主体跟踪不重复媒体层且原声只保留一次', () => {
  const analysis = {
    titles: { recommended: '单主体与单路原声' },
    assets: [],
    timeline: {
      orientation: 'vertical',
      width: 1080,
      height: 1920,
      fps: 30,
      shots: [{
        id: 'tracking-shot',
        assetId: 'moving',
        inSec: 0,
        outSec: 3,
        durationSec: 3,
        fitMode: 'cover',
        audioMode: 'keep',
        purpose: '跟随人物',
        layout: layout(),
      }],
      markers: [],
    },
  };
  const xml = buildFcpxml({
    projectName: 'Stage 7C audio',
    analysis,
    assetMappings: [mapping()],
  });
  assert.equal((xml.match(/<asset-clip\b/g) || []).length, 1);
  assert.equal((xml.match(/<adjust-volume amount="-96dB"\/>/g) || []).length, 0);
  assert.equal((xml.match(/audioRole="dialogue"/g) || []).length, 1);
});

test('动态轨迹生成真实 1080×1920 手机预览并保留视频原声', {
  timeout: 60_000,
}, async (t) => {
  if (!resolveToolPath('ffmpeg') || !resolveToolPath('ffprobe')) {
    t.skip('当前环境缺少 ffmpeg/ffprobe');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stage7c-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'moving.mp4');
  await runMediaTool('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=0x172033:s=640x360:r=30:d=3',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
    '-vf', 'drawbox=x=40+t*150:y=90:w=90:h=170:color=0xffcc33:t=fill',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    source,
  ], { timeoutMs: 30_000 });
  const metadata = await probeMedia(source);
  const analysis = {
    titles: { recommended: '手机预览' },
    assets: [],
    timeline: {
      orientation: 'vertical',
      width: 1080,
      height: 1920,
      fps: 30,
      shots: [{
        id: 'tracking-shot',
        assetId: 'moving',
        inSec: 0,
        outSec: 3,
        durationSec: 3,
        fitMode: 'cover',
        audioMode: 'keep',
        purpose: '动态跟随',
        layout: layout(),
      }],
      markers: [],
    },
  };
  const output = path.join(root, 'preview.mp4');
  const { profile } = await loadDouyinProfile();
  const result = await generateDouyinPreview(output, analysis, [{
    ...mapping(),
    projectAbsolutePath: source,
    metadata,
  }], profile);
  assert.equal(result.metadata.displayWidth, 1080);
  assert.equal(result.metadata.displayHeight, 1920);
  assert.equal(result.metadata.hasAudio, true);
  assert.ok(result.metadata.durationSec >= 2.9);
});

test('跟踪修改会令旧批准失效，revision 递增后必须重新批准', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stage7c-revision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const project = path.join(root, 'project');
  const selected = path.join(project, '01-精选素材');
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(path.join(project, '00-项目总控'), { recursive: true });
  await fs.mkdir(selected, { recursive: true });
  const sourceFile = path.join(source, 'moving-person.mov');
  const selectedFile = path.join(selected, 'moving-person.mov');
  await fs.writeFile(sourceFile, 'source-video');
  await fs.copyFile(sourceFile, selectedFile);
  const sourceSnapshot = await snapshotSource(source);
  const { profile } = await loadDouyinProfile();
  const fixture = context(profile);
  await fs.writeFile(path.join(project, CODEX_VIDEO_MANIFEST_FILE), `${JSON.stringify({
    schemaVersion: 1,
    sourceDirectory: source,
    sourceSnapshot,
    items: fixture.manifest.items,
  }, null, 2)}\n`);
  await fs.writeFile(path.join(project, CODEX_VIDEO_ANALYSIS_FILE), `${JSON.stringify({
    schemaVersion: 1,
    theme: { summary: '人物移动', rationale: '真实动作。', confidence: 1, folderNameConflict: false },
    titles: { candidates: ['人物移动'], recommended: '人物移动', rationale: '真实动作。' },
    assets: fixture.analysis.assets,
    lightCaptionPlan: [],
    timeline: { orientation: 'horizontal', width: 1920, height: 1080, fps: 30, shots: [], markers: [] },
  }, null, 2)}\n`);
  await fs.writeFile(path.join(project, CODEX_VIDEO_STATUS_FILE), `${JSON.stringify({
    schemaVersion: 1,
    formats: { timeline: { fps: 30 } },
    assetMappings: [{
      ...mapping(),
      projectAbsolutePath: selectedFile,
      projectRelativePath: '01-精选素材/moving-person.mov',
    }],
  }, null, 2)}\n`);
  const created = await createDouyinVariant(project, { plan: plan() });
  const warningIds = created.plan.videos.flatMap((video) => video.warnings.map((warning) => warning.warningId));
  const approved = await approveDouyinVariant(project, created.variantId, {
    approvedWarningIds: warningIds,
  });
  const changed = structuredClone(approved.plan);
  changed.videos[0].shots[0].layout.tracking.points[1].bounds.x += 0.02;
  changed.videos[0].shots[0].layout.tracking.manualConfirmation = 'corrected';
  const saved = await saveDouyinVariantDraft(project, created.variantId, changed, {
    expectedRevision: approved.revision,
  });
  assert.equal(saved.revision, 2);
  assert.equal(saved.approval, null);
  assert.equal(saved.status, 'draft');
});

test('静态布局与 Stage 7A/7B 计划继续兼容且不会伪造 tracking', async () => {
  const { profile } = await loadDouyinProfile();
  const staticPlan = plan();
  staticPlan.videos[0].shots[0].layout = {
    ...staticPlan.videos[0].shots[0].layout,
    mode: 'landscape_card_blur',
    tracking: null,
  };
  const normalized = validateDouyinPlan(staticPlan, context(profile));
  assert.equal(normalized.videos[0].shots[0].layout.mode, 'landscape_card_blur');
  assert.equal(normalized.videos[0].shots[0].layout.tracking, null);
  assert.equal(normalizeDouyinPlan(staticPlan).planningPolicy.fixedTargetDuration, false);
});
