const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { execute } = require('../bin/video-skill');
const {
  buildAgentPrompt,
} = require('../src/services/handoff-task-service');
const {
  sharedDouyinPlanningContractText,
} = require('../src/services/editing-contract-service');
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
  readDouyinVariant,
  readPlatformVariants,
  saveDouyinVariantDraft,
  validateDouyinPlan,
  verifyDouyinVariant,
} = require('../src/services/platform-variant-service');
const { readCodexProjectResult } = require('../src/services/codex-project-result-service');
const { runMediaTool } = require('../src/services/media-tool-service');
const {
  snapshotSource,
} = require('../src/services/pending-media-service');
const { resolveToolPath } = require('../src/services/stage7-service');

const CONTROL = '00-项目总控';

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fingerprint(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function baseAnalysis() {
  return {
    schemaVersion: 1,
    theme: {
      summary: '开发记录与移动端成果',
      rationale: '两组内容可以独立成立，不强制与趣味素材拼接。',
      confidence: 0.94,
      folderNameConflict: false,
    },
    titles: {
      candidates: ['竖屏开发记录', '移动端成果展示'],
      recommended: '竖屏开发记录',
      rationale: '对应素材内容。',
    },
    assets: [
      {
        assetId: 'vertical-video',
        type: 'video',
        semanticLabels: ['移动端', '操作'],
        contentSummary: '竖屏录屏展示移动端操作，画面含水印提示。',
        suggestedUse: ['独立开场'],
        status: 'adopt',
        reason: '竖屏表现好、原声有解释价值。',
        ranges: [{ startSec: 0, endSec: 3, confidence: 0.95, reviewRequired: false }],
        confidence: 0.95,
        warnings: ['右上角可能存在水印'],
        explanationPlan: {
          audienceNeedsExplanation: 'background',
        },
        audioAnalysis: {
          preserveOriginalAudio: true,
        },
      },
      {
        assetId: 'horizontal-video',
        type: 'video',
        semanticLabels: ['开发记录'],
        contentSummary: '横屏开发记录可作为另一条独立主题。',
        suggestedUse: ['开发过程'],
        status: 'adopt',
        reason: '视觉变化和主题一致性较强。',
        ranges: [{ startSec: 0, endSec: 4, confidence: 0.9, reviewRequired: false }],
        confidence: 0.9,
        audioAnalysis: {
          preserveOriginalAudio: true,
        },
      },
      {
        assetId: 'result-image',
        type: 'image',
        semanticLabels: ['结果'],
        contentSummary: '横屏结果截图，需要更多上下文。',
        suggestedUse: ['另拆补充'],
        status: 'candidate',
        reason: '独立成立但与当前开场主题不同。',
        ranges: [],
        confidence: 0.8,
      },
      {
        assetId: 'duplicate-image',
        type: 'image',
        semanticLabels: ['重复'],
        contentSummary: '与结果截图重复。',
        suggestedUse: [],
        status: 'reject',
        reason: '真实重复画面，没有新的叙事信息。',
        ranges: [],
        confidence: 0.97,
      },
    ],
    lightCaptionPlan: [
      {
        captionId: 'caption-mobile',
        assetId: 'vertical-video',
        text: '这是移动端操作入口',
        startTime: 0.3,
        endTime: 2,
        purpose: '解释操作背景',
        basedOn: '受管字幕规则',
      },
    ],
    storyUnits: [
      {
        storyUnitId: 'unit-1',
        title: '开发记录',
        assetIds: ['vertical-video', 'horizontal-video', 'result-image'],
        duplicateAssetIds: ['duplicate-image'],
        unusableAssetIds: [],
      },
    ],
    timeline: {
      orientation: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 30,
      shots: [
        {
          id: 'main-shot-a',
          assetId: 'vertical-video',
          inSec: 0,
          outSec: 3,
          durationSec: 3,
          fitMode: 'contain',
          audioMode: 'keep',
          purpose: '完整保留移动端操作',
          confidence: 0.95,
          reviewRequired: false,
        },
        {
          id: 'main-shot-b',
          assetId: 'horizontal-video',
          inSec: 0,
          outSec: 4,
          durationSec: 4,
          fitMode: 'contain',
          audioMode: 'keep',
          purpose: '完整保留开发记录',
          confidence: 0.9,
          reviewRequired: false,
        },
        {
          id: 'main-shot-c',
          assetId: 'result-image',
          inSec: 0,
          outSec: 2,
          durationSec: 2,
          fitMode: 'contain',
          audioMode: 'mute',
          purpose: '完整显示结果截图',
          confidence: 0.85,
          reviewRequired: false,
        },
      ],
      markers: [],
    },
  };
}

async function createFormalProject(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stage7a-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, '真实来源');
  const projectPath = path.join(root, '正式项目');
  const selectedDirectory = path.join(projectPath, '01-精选素材');
  const exportDirectory = path.join(projectPath, '03-导出');
  await Promise.all([
    fs.mkdir(sourceDirectory, { recursive: true }),
    fs.mkdir(path.join(projectPath, CONTROL), { recursive: true }),
    fs.mkdir(selectedDirectory, { recursive: true }),
    fs.mkdir(path.join(exportDirectory, 'FCPXML'), { recursive: true }),
    fs.mkdir(path.join(exportDirectory, '粗剪预览'), { recursive: true }),
  ]);
  const specs = [
    {
      assetId: 'vertical-video',
      filename: 'mobile.mov',
      type: 'video',
      chapterId: 'mobile',
      bytes: 'fake-mobile-video',
      metadata: {
        durationSec: 3,
        displayWidth: 720,
        displayHeight: 1280,
        width: 720,
        height: 1280,
        frameRate: 30,
        frameCount: 90,
        hasAudio: true,
        audioChannels: 2,
        sampleRate: 48000,
      },
    },
    {
      assetId: 'horizontal-video',
      filename: 'development.mov',
      type: 'video',
      chapterId: 'development',
      bytes: 'fake-development-video',
      metadata: {
        durationSec: 4,
        displayWidth: 1280,
        displayHeight: 720,
        width: 1280,
        height: 720,
        frameRate: 30,
        frameCount: 120,
        hasAudio: true,
        audioChannels: 2,
        sampleRate: 48000,
      },
    },
    {
      assetId: 'result-image',
      filename: 'result.png',
      type: 'image',
      chapterId: 'development',
      bytes: 'fake-result-image',
      metadata: {
        displayWidth: 1280,
        displayHeight: 720,
        width: 1280,
        height: 720,
        hasAudio: false,
      },
    },
    {
      assetId: 'duplicate-image',
      filename: 'duplicate.png',
      type: 'image',
      chapterId: 'development',
      bytes: 'fake-duplicate-image',
      metadata: {
        displayWidth: 1280,
        displayHeight: 720,
        width: 1280,
        height: 720,
        hasAudio: false,
      },
    },
  ];
  for (const spec of specs) {
    await fs.writeFile(path.join(sourceDirectory, spec.filename), spec.bytes);
    if (spec.assetId !== 'duplicate-image') {
      await fs.writeFile(path.join(selectedDirectory, spec.filename), spec.bytes);
    }
  }
  const sourceSnapshot = await snapshotSource(sourceDirectory);
  const manifest = {
    schemaVersion: 1,
    sourceDirectory,
    sourceSnapshot,
    items: specs.map((spec) => ({
      assetId: spec.assetId,
      filename: spec.filename,
      extension: path.extname(spec.filename).slice(1),
      type: spec.type,
      chapterId: spec.chapterId,
      sha256: sha(spec.bytes),
      sizeBytes: Buffer.byteLength(spec.bytes),
      metadata: spec.metadata,
    })),
  };
  const mappings = specs.filter((spec) => spec.assetId !== 'duplicate-image').map((spec) => ({
    assetId: spec.assetId,
    type: spec.type,
    projectFilename: spec.filename,
    projectRelativePath: `01-精选素材/${spec.filename}`,
    projectAbsolutePath: path.join(selectedDirectory, spec.filename),
    projectStableId: `stable-${spec.assetId}`,
    sourceSha256: sha(spec.bytes),
    metadata: spec.metadata,
  }));
  const analysis = baseAnalysis();
  const status = {
    schemaVersion: 1,
    status: 'verified',
    createdAt: '2026-07-27T00:00:00.000Z',
    generatedAt: '2026-07-27T00:01:00.000Z',
    verifiedAt: '2026-07-27T00:02:00.000Z',
    assetMappings: mappings,
    formats: {
      timeline: { orientation: 'horizontal', width: 1920, height: 1080, fps: 30 },
      preview: { width: 640, height: 360, fps: 30 },
    },
    artifacts: {
      fcpxml: '03-导出/FCPXML/timeline.fcpxml',
      preview: '03-导出/粗剪预览/preview.mp4',
    },
    verification: {
      ok: true,
      warnings: [],
      errors: [],
      sourceVerification: {
        unchanged: true,
        beforeDigest: sourceSnapshot.digest,
        afterDigest: sourceSnapshot.digest,
      },
      fcpxml: { ok: true, assetCount: 3, clipCount: 3, markerCount: 0 },
      xmlSyntax: { ok: true },
    },
  };
  await Promise.all([
    writeJson(path.join(projectPath, CONTROL, 'project.json'), {
      projectName: 'Stage 7A fixture',
      projectPath,
      version: 'v3.1.0-stage1',
      createdAt: status.createdAt,
    }),
    writeJson(path.join(projectPath, CONTROL, 'assets.json'), {
      assets: mappings.map((mapping) => ({
        stableId: mapping.projectStableId,
        filename: mapping.projectFilename,
        relativePath: mapping.projectRelativePath,
        availability: 'available',
      })),
    }),
    writeJson(path.join(projectPath, CONTROL, 'Codex视频素材清单.json'), manifest),
    writeJson(path.join(projectPath, CONTROL, 'Codex视频分析.json'), analysis),
    writeJson(path.join(projectPath, CONTROL, 'Codex视频状态.json'), status),
    fs.writeFile(path.join(exportDirectory, 'FCPXML', 'timeline.fcpxml'), '<fcpxml/>'),
    fs.writeFile(path.join(exportDirectory, '粗剪预览', 'preview.mp4'), 'default-preview'),
  ]);
  return {
    root,
    sourceDirectory,
    projectPath,
    manifest,
    analysis,
    mappings,
  };
}

function validationContext(fixture, profile) {
  return {
    manifest: fixture.manifest,
    analysis: fixture.analysis,
    profile,
    requiredCaptionAssetIds: ['vertical-video'],
  };
}

test('抖音平台档案、独立变体、内容驱动选材与多成片规划保持默认主成片不变', async (t) => {
  const fixture = await createFormalProject(t);
  const protectedPaths = [
    'Codex视频素材清单.json',
    'Codex视频分析.json',
    'Codex视频状态.json',
  ].map((name) => path.join(fixture.projectPath, CONTROL, name));
  const before = await Promise.all(protectedPaths.map(fingerprint));
  const created = await createDouyinVariant(fixture.projectPath);
  assert.equal(created.status, 'draft');
  assert.equal(created.plan.videos.length, 2);
  assert.deepEqual(created.plan.planningPolicy, {
    fixedTargetDuration: false,
    fixedShotCount: false,
    fixedVideoCount: false,
    selectionDrivenByContent: true,
  });
  assert.equal(created.plan.selection.find((item) => item.assetId === 'vertical-video').decision, 'selected');
  assert.equal(created.plan.selection.find((item) => item.assetId === 'result-image').decision, 'separate');
  assert.equal(created.plan.selection.find((item) => item.assetId === 'duplicate-image').decision, 'excluded');
  assert.ok(created.plan.selection.every((item) => item.reason));
  assert.ok(created.plan.selection.every((item) => Object.keys(item.factors).length === 9));
  assert.equal(created.plan.videos[0].shots[0].audioMode, 'keep');
  assert.equal(created.plan.videos[1].shots[0].audioMode, 'keep');
  assert.equal(created.plan.videos[0].lightCaptions[0].text, '这是移动端操作入口');

  const registry = await readPlatformVariants(fixture.projectPath);
  assert.equal(registry.defaultMain.untouchedByPlatformVariants, true);
  assert.equal(registry.defaultMain.analysis, '00-项目总控/Codex视频分析.json');
  assert.deepEqual(await Promise.all(protectedPaths.map(fingerprint)), before);

  const cliCreated = await execute([
    'douyin-create',
    '--project', fixture.projectPath,
    '--variant-id', 'douyin-cli',
  ]);
  assert.equal(cliCreated.result.variantId, 'douyin-cli');
  assert.equal((await readPlatformVariants(fixture.projectPath)).variants.length, 2);
});

test('抖音合同阻止固定时长倒推、无原因排除、无理由静音和缺失轻字幕，并支持四种布局', async (t) => {
  const fixture = await createFormalProject(t);
  const { profile } = await loadDouyinProfile();
  const created = await createDouyinVariant(fixture.projectPath);
  const context = validationContext(fixture, profile);
  const fixedDuration = clone(created.plan);
  fixedDuration.targetDurationSec = 30;
  assert.throws(
    () => validateDouyinPlan(fixedDuration, context),
    (error) => error.code === 'INVALID_DOUYIN_PLAN'
      && error.details.some((message) => /固定时长/.test(message)),
  );
  const missingReason = clone(created.plan);
  missingReason.selection.find((item) => item.decision === 'excluded').reason = '';
  assert.throws(
    () => validateDouyinPlan(missingReason, context),
    (error) => error.details.some((message) => /必须记录/.test(message)),
  );
  const muted = clone(created.plan);
  muted.videos[0].shots[0].audioMode = 'mute';
  muted.videos[0].shots[0].muteReason = '';
  assert.throws(
    () => validateDouyinPlan(muted, context),
    (error) => error.details.some((message) => /静音必须记录明确原因/.test(message)),
  );
  const missingCaption = clone(created.plan);
  missingCaption.videos[0].lightCaptions = [];
  assert.throws(
    () => validateDouyinPlan(missingCaption, context),
    (error) => error.details.some((message) => /应生成轻字幕但没有生成/.test(message)),
  );
  const humanCaptionId = clone(created.plan);
  humanCaptionId.videos[0].lightCaptions[0].captionId = '人工字幕-一';
  assert.equal(
    validateDouyinPlan(humanCaptionId, context).videos[0].lightCaptions[0].captionId,
    '人工字幕-一',
  );

  const layoutAnalysis = {
    titles: { recommended: '四种竖屏布局' },
    timeline: {
      orientation: 'vertical',
      width: 1080,
      height: 1920,
      fps: 30,
      shots: Object.keys(profile.layouts).map((mode, index) => ({
        id: `layout-shot-${index + 1}`,
        assetId: 'vertical-video',
        inSec: index * 0.5,
        outSec: index * 0.5 + 0.5,
        durationSec: 0.5,
        fitMode: 'contain',
        audioMode: 'keep',
        layout: {
          mode,
          scale: 1,
          position: { x: 0, y: 0 },
          crop: { left: 0, top: 0, right: 0, bottom: 0 },
        },
      })),
      markers: [],
    },
  };
  const xml = buildFcpxml({
    projectName: 'Stage 7A layouts',
    analysis: layoutAnalysis,
    assetMappings: [fixture.mappings[0]],
  });
  const report = validateFcpxmlStructure(xml, {
    assetCount: 1,
    shotCount: 4,
    markerCount: 0,
    width: 1080,
    height: 1920,
    fps: 30,
  });
  assert.equal(report.ok, true, report.errors.join('；'));
  assert.equal(report.clipCount, 4, '模糊背景的嵌套素材不能被误算为主线镜头');
  assert.match(xml, /<adjust-conform type="fit"\/>/);
  assert.match(xml, /<adjust-conform type="fill"\/>/);
  assert.match(xml, /<filter-video ref="r\d+"\/>/);
  assert.match(xml, /<asset-clip[^>]*>\s*<adjust-conform type="fill"\/>/);
  assert.match(
    xml,
    /· 完整横屏卡片"[\s\S]*?<\/asset-clip>\s*<filter-video ref="r\d+"\/>/,
    '模糊背景 filter-video 必须位于前景卡片之后，符合 FCPXML 1.14 DTD',
  );
  const blurFilter = xml.match(/<filter-video ref="r\d+"\/>/)?.[0];
  const invalidOrder = blurFilter
    ? xml.replace(
      /(<adjust-conform type="fill"\/>)(\s*<asset-clip name="[^"]+ · 完整横屏卡片")/,
      `$1\n          ${blurFilter}$2`,
    )
    : xml;
  const invalidOrderReport = validateFcpxmlStructure(invalidOrder);
  assert.equal(invalidOrderReport.ok, false);
  assert.ok(invalidOrderReport.errors.some((message) => /子元素顺序.*DTD/.test(message)));
});

test('四种布局可生成 1080×1920 且保留所选视频原声的真实抖音预览', {
  timeout: 120_000,
}, async (t) => {
  if (!(await resolveToolPath('ffmpeg')) || !(await resolveToolPath('ffprobe'))) {
    t.skip('本机缺少 ffmpeg 或 ffprobe。');
    return;
  }
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stage7a-preview-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const verticalPath = path.join(root, 'vertical.mp4');
  const horizontalPath = path.join(root, 'horizontal.mp4');
  await runMediaTool('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc2=duration=1.2:size=180x320:rate=30',
    '-f', 'lavfi',
    '-i', 'sine=frequency=660:duration=1.2',
    '-shortest',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    verticalPath,
  ], { timeoutMs: 60_000 });
  await runMediaTool('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc2=duration=1.2:size=320x180:rate=30',
    '-f', 'lavfi',
    '-i', 'sine=frequency=880:duration=1.2',
    '-shortest',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    horizontalPath,
  ], { timeoutMs: 60_000 });
  const modes = [
    ['native_vertical', 'vertical'],
    ['center_crop', 'horizontal'],
    ['landscape_card', 'horizontal'],
    ['landscape_card_blur', 'horizontal'],
  ];
  const layout = (mode) => ({
    mode,
    scale: 1,
    position: { x: 0, y: 0 },
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    subjectBounds: null,
  });
  const analysis = {
    timeline: {
      fps: 30,
      shots: modes.map(([mode, assetId], index) => ({
        id: `preview-shot-${index + 1}`,
        assetId,
        inSec: index * 0.2,
        outSec: index * 0.2 + 0.2,
        durationSec: 0.2,
        audioMode: 'keep',
        layout: layout(mode),
      })),
    },
  };
  const mappings = [
    {
      assetId: 'vertical',
      type: 'video',
      projectAbsolutePath: verticalPath,
      metadata: { hasAudio: true },
    },
    {
      assetId: 'horizontal',
      type: 'video',
      projectAbsolutePath: horizontalPath,
      metadata: { hasAudio: true },
    },
  ];
  const { profile } = await loadDouyinProfile();
  const previewPath = path.join(root, 'preview.mp4');
  const preview = await generateDouyinPreview(previewPath, analysis, mappings, profile);
  assert.equal(preview.metadata.hasVideo, true);
  assert.equal(preview.metadata.hasAudio, true);
  assert.equal(preview.metadata.displayWidth, 1080);
  assert.equal(preview.metadata.displayHeight, 1920);
  assert.ok(preview.metadata.durationSec >= 0.7);
});

test('人工调整批准后生成多条独立 FCPXML、预览与验证报告，且默认与人工文件不变', {
  timeout: 120_000,
}, async (t) => {
  if (!(await resolveToolPath('xmllint'))) {
    t.skip('本机缺少 xmllint。');
    return;
  }
  const fixture = await createFormalProject(t);
  const protectedPaths = [
    'Codex视频素材清单.json',
    'Codex视频分析.json',
    'Codex视频状态.json',
    'project.json',
  ].map((name) => path.join(fixture.projectPath, CONTROL, name));
  const before = await Promise.all(protectedPaths.map(fingerprint));
  const created = await createDouyinVariant(fixture.projectPath);
  const adjusted = clone(created.plan);
  const resultSelection = adjusted.selection.find((item) => item.assetId === 'result-image');
  resultSelection.decision = 'selected';
  resultSelection.reason = '结果画面独立成立，人工确认移动到开发记录成片作为自然结束。';
  const development = adjusted.videos.find((video) => video.videoId === 'douyin-2');
  development.shots.push({
    shotId: 'douyin-2-shot-result',
    assetId: 'result-image',
    inSec: 0,
    outSec: 2,
    purpose: '人工调整后用结果截图自然收尾',
    audioMode: 'keep',
    muteReason: null,
    layout: {
      mode: 'center_crop',
      scale: 1,
      position: { x: 0, y: 0 },
      crop: { left: 0.05, top: 0, right: 0.05, bottom: 0 },
      subjectBounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    },
  });
  development.naturalEnding = '以人工选入的结果截图作为信息完成点。';
  const saved = await saveDouyinVariantDraft(
    fixture.projectPath,
    'douyin',
    adjusted,
    { expectedRevision: created.revision },
  );
  assert.equal(saved.revision, 2);
  await assert.rejects(
    approveDouyinVariant(fixture.projectPath, 'douyin'),
    { code: 'DOUYIN_WARNINGS_NOT_APPROVED' },
  );
  const warningIds = saved.plan.videos.flatMap((video) =>
    video.warnings.map((warning) => warning.warningId));
  const approved = await approveDouyinVariant(fixture.projectPath, 'douyin', {
    approvedWarningIds: warningIds,
    approvedBy: 'test-reviewer',
  });
  assert.equal(approved.status, 'approved');

  const generated = await buildDouyinVariant(fixture.projectPath, 'douyin', {
    generatePreviewImpl: async (outputPath, analysis) => {
      await fs.writeFile(outputPath, `preview:${analysis.timeline.shots.length}`);
      return {
        outputPath,
        command: ['test-preview'],
        metadata: {
          hasVideo: true,
          hasAudio: true,
          displayWidth: 1080,
          displayHeight: 1920,
          frameRate: analysis.timeline.fps,
          durationSec: analysis.timeline.shots.reduce(
            (sum, shot) => sum + shot.durationSec,
            0,
          ),
        },
      };
    },
  });
  assert.equal(
    generated.status,
    'generated',
    JSON.stringify(generated.outputs.flatMap((output) => output.validation?.warnings || [])),
  );
  assert.equal(generated.outputs.length, 2);
  for (const output of generated.outputs) {
    assert.equal(output.validationStatus, 'verified');
    assert.equal(output.specs.width, 1080);
    assert.equal(output.specs.height, 1920);
    assert.equal(output.specs.aspectRatio, '9:16');
    assert.equal(output.specs.frameDuration, '1/30s');
    assert.equal(output.validation.selection.defaultMainCompletenessApplied, false);
    if (output.validation.fcpxml.dtd.path) {
      assert.equal(output.validation.fcpxml.dtd.ok, true);
      assert.equal(output.validation.fcpxml.dtd.requiresFinalCutImport, false);
    }
    for (const name of [
      'timeline.fcpxml',
      'preview.mp4',
      'edit-plan.json',
      'analysis.json',
      'validation-report.json',
    ]) {
      assert.equal(
        (await fs.stat(path.join(output.outputDirectory, name))).isFile(),
        true,
        `${output.videoId} 缺少 ${name}`,
      );
    }
  }
  const mobileOutput = generated.outputs.find((output) => output.videoId === 'douyin-1');
  assert.equal(mobileOutput.originalAudio.keptOriginalAudioCount, 1);
  assert.equal(mobileOutput.validation.captions.complete, true);
  assert.equal(mobileOutput.validation.captions.generatedFcpTitleCount, 1);
  const mobileXml = await fs.readFile(
    path.join(mobileOutput.outputDirectory, 'timeline.fcpxml'),
    'utf8',
  );
  assert.match(mobileXml, /<title /);
  assert.match(mobileXml, /这是移动端操作入口/);
  assert.match(mobileXml, /audioRole="dialogue"/);
  assert.match(mobileXml, /name="位置"/);
  const developmentOutput = generated.outputs.find((output) => output.videoId === 'douyin-2');
  const developmentXml = await fs.readFile(
    path.join(developmentOutput.outputDirectory, 'timeline.fcpxml'),
    'utf8',
  );
  assert.match(
    developmentXml,
    /<adjust-crop mode="trim">[\s\S]*?<\/adjust-crop>\s*<adjust-conform type="fill"\/>/,
    '裁切必须位于 conform 前，符合 FCPXML 1.14 DTD intrinsic 参数顺序',
  );

  const verified = await verifyDouyinVariant(fixture.projectPath);
  assert.equal(verified.ok, true);
  assert.equal(verified.reports.length, 2);
  const result = await readCodexProjectResult(fixture.projectPath);
  assert.equal(result.platformVariants.defaultMain.untouchedByPlatformVariants, true);
  assert.equal(result.platformVariants.variants[0].outputs.length, 2);
  assert.equal(result.platformVariants.variants[0].outputs[0].artifacts.fcpxml.exists, true);
  assert.deepEqual(await Promise.all(protectedPaths.map(fingerprint)), before);
});

test('Cursor Agent、Codex、App 和 CLI 共用抖音规划合同与本地续建入口', async () => {
  const input = {
    sourceDirectory: '/tmp/material',
    taskId: 'task-stage7a',
    taskFilePath: '/tmp/task-stage7a.json',
    packageDir: '/tmp/task-stage7a-package',
    hyperframesMode: 'disabled',
  };
  const contract = sharedDouyinPlanningContractText();
  const codexPrompt = buildAgentPrompt('codex', input);
  const cursorPrompt = buildAgentPrompt('cursor_agent', input);
  assert.ok(codexPrompt.includes(contract));
  assert.ok(cursorPrompt.includes(contract));
  assert.match(codexPrompt, /platformVariants\.douyin/);
  assert.match(cursorPrompt, /platformVariants\.douyin/);
  assert.match(contract, /不得写入或使用固定目标时长/);
  assert.doesNotMatch(contract, /\d+\s*[–—-]\s*\d+\s*秒/);

  const preloadRoot = path.join(__dirname, '../src/preload');
  const preloadFiles = await fs.readdir(preloadRoot);
  const [douyinPage, editorCore, workflowVm, preloadEntry, cli, packageVerifier, ...preloadModules] = await Promise.all([
    fs.readFile(path.join(__dirname, '../src/renderer/modules/douyin/douyin-page.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '../src/renderer/modules/douyin/editor-core.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '../src/view-models/douyin-workflow-view-model.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '../src/preload.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '../bin/video-skill.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '../scripts/verify-package.js'), 'utf8'),
    ...preloadFiles
      .filter((name) => name.endsWith('.js'))
      .map((name) => fs.readFile(path.join(preloadRoot, name), 'utf8')),
  ]);
  const preload = [preloadEntry, ...preloadModules].join('\n');
  const renderer = `${douyinPage}\n${editorCore}\n${workflowVm}`;
  for (const text of ['创建抖音变体', '生成预览与 FCP 时间线', '裁切前', '主体安全区', '抖音结果']) {
    assert.match(renderer, new RegExp(text));
  }
  for (const method of [
    'createDouyinVariant',
    'saveDouyinVariant',
    'approveDouyinVariant',
    'buildDouyinVariant',
    'verifyDouyinVariant',
  ]) {
    assert.match(preload, new RegExp(method));
  }
  assert.match(cli, /douyin-create/);
  assert.match(cli, /douyin-update/);
  assert.match(cli, /douyin-approve/);
  assert.match(cli, /douyin-build/);
  assert.match(cli, /douyin-verify/);
  assert.match(packageVerifier, /douyin-platform-variant\.schema\.json/);
  assert.match(packageVerifier, /config\/platforms\/douyin\.json/);
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
