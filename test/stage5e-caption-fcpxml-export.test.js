'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildCaptionExportPlan,
  buildTitleKey,
  exportConfirmedCaptionsToFcpxml,
  previewConfirmedCaptionFcpxmlExport,
  reconcileManagedTitles,
} = require('../src/services/caption-fcpxml-export-service');
const {
  BASIC_TITLE_EFFECT,
  MANAGED_CAPTION_NOTE_PREFIX,
  buildFcpxml,
  extractManagedCaptionTitles,
  validateFcpxmlStructure,
  writeFcpxml,
} = require('../src/services/fcpxml-service');
const {
  getConfirmedCaptions,
  saveEditorialReview,
} = require('../src/services/editorial-review-service');
const {
  CODEX_VIDEO_ANALYSIS_FILE,
  CODEX_VIDEO_MANIFEST_FILE,
  CODEX_VIDEO_STATUS_FILE,
  CONTROL_DIR,
  EDITORIAL_REVIEW_FILE,
} = require('../src/constants');

function baseAnalysis(assets, shots, extras = {}) {
  return {
    schemaVersion: 1,
    theme: {
      summary: 'Stage 5E caption export',
      rationale: '匿名 fixture',
      confidence: 0.9,
      folderNameConflict: false,
    },
    titles: {
      candidates: ['Stage 5E', '轻字幕导出'],
      recommended: 'Stage 5E 轻字幕导出',
      rationale: '测试',
    },
    assets,
    lightCaptionPlan: extras.lightCaptionPlan || [],
    timeline: {
      orientation: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 30,
      shots,
      markers: extras.markers || [
        {
          timeSec: 0.5,
          text: '章节标记',
          id: 'marker-chapter',
          subtitle: {
            enabled: true,
            text: '章节 Title',
            durationSec: 1,
            position: 'bottom-safe',
            purpose: 'chapter',
            renderAsFcpTitle: true,
          },
        },
      ],
    },
    storyUnits: extras.storyUnits || [
      {
        storyUnitId: 'su-1',
        theme: '单元一',
        assetIds: assets.map((asset) => asset.assetId),
      },
    ],
  };
}

function mappingsFor(assets) {
  return assets.map((asset, index) => ({
    assetId: asset.assetId,
    type: asset.type,
    projectFilename: `${asset.assetId}.${asset.type === 'video' ? 'mp4' : 'jpg'}`,
    projectAbsolutePath: `/tmp/stage5e/${asset.assetId}.${asset.type === 'video' ? 'mp4' : 'jpg'}`,
    projectStableId: `stable-${asset.assetId}`,
    sourceSha256: `${String(index + 1).repeat(64)}`.slice(0, 64),
    metadata: asset.type === 'video'
      ? {
        durationSec: asset.ranges?.[0]?.endSec || 20,
        width: 1280,
        height: 720,
        frameRate: 30,
        hasAudio: true,
        audioChannels: 2,
        sampleRate: 48000,
      }
      : { width: 1280, height: 720, hasAudio: false },
  }));
}

function videoAsset(assetId, durationSec = 20) {
  return {
    assetId,
    type: 'video',
    status: 'adopt',
    reason: '过程',
    ranges: [{ startSec: 0, endSec: durationSec, confidence: 0.9, reviewRequired: false }],
    confidence: 0.9,
    storyUnitId: 'su-1',
    chapterId: 'ch-1',
    narrativeRole: 'representative',
    audioAnalysis: {
      audioAvailable: true,
      preserveOriginalAudio: true,
      muteReason: null,
      warnings: [],
    },
    videoPreservationPlan: {
      preserveFullClip: true,
      sourceDuration: durationSec,
      proposedIn: 0,
      proposedOut: durationSec,
      keepRatio: 1,
      trimReason: null,
      criticalMoments: [],
      protectedTimeRanges: [],
      warnings: [],
    },
  };
}

function imageAsset(assetId) {
  return {
    assetId,
    type: 'image',
    status: 'adopt',
    reason: '结果图',
    ranges: [],
    confidence: 0.9,
    storyUnitId: 'su-1',
    chapterId: 'ch-1',
    narrativeRole: 'supporting',
    visualTextAnalysis: {
      items: [
        {
          sourceText: 'Panel A',
          language: 'en',
          translatedText: '面板甲',
          meaning: '对话1',
          textType: 'dialogue',
          readingOrder: 1,
          confidence: 0.9,
          warnings: [],
        },
        {
          sourceText: 'Panel B',
          language: 'en',
          translatedText: '面板乙',
          meaning: '对话2',
          textType: 'dialogue',
          readingOrder: 2,
          confidence: 0.9,
          warnings: [],
        },
      ],
      readingOrderUncertain: false,
      warnings: [],
    },
  };
}

function confirmed(captionId, assetId, overrides = {}) {
  return {
    captionId,
    assetId,
    storyUnitId: 'su-1',
    reviewStatus: overrides.reviewStatus || 'approved',
    text: overrides.text || `字幕 ${captionId}`,
    startTime: Object.hasOwn(overrides, 'startTime') ? overrides.startTime : 1,
    endTime: Object.hasOwn(overrides, 'endTime') ? overrides.endTime : 3,
    purpose: overrides.purpose || 'translate',
    basedOn: overrides.basedOn || null,
    userNotes: '',
    warningsAcknowledged: [],
    ...overrides,
  };
}

async function makeTempProject({ analysis, assetMappings, editorialReviews = null, fcpxml = null }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stage5e-'));
  await fs.mkdir(path.join(root, CONTROL_DIR), { recursive: true });
  await fs.mkdir(path.join(root, '03-导出', 'FCPXML'), { recursive: true });
  const fcpxmlRelative = path.join('03-导出', 'FCPXML', 'stage5e.fcpxml');
  const fcpxmlPath = path.join(root, fcpxmlRelative);
  const xml = fcpxml || buildFcpxml({
    projectName: 'Stage5E',
    analysis,
    assetMappings,
  });
  await fs.writeFile(fcpxmlPath, xml, 'utf8');
  await fs.writeFile(path.join(root, CODEX_VIDEO_ANALYSIS_FILE), `${JSON.stringify(analysis, null, 2)}\n`);
  await fs.writeFile(path.join(root, CODEX_VIDEO_MANIFEST_FILE), `${JSON.stringify({
    projectName: 'Stage5E',
    items: analysis.assets.map((asset) => ({
      assetId: asset.assetId,
      type: asset.type,
      storyUnitId: asset.storyUnitId,
      filename: `${asset.assetId}.bin`,
      relativePath: `${asset.assetId}.bin`,
      sha256: `sha-${asset.assetId}`,
      metadata: assetMappings.find((item) => item.assetId === asset.assetId)?.metadata || {},
    })),
    storyUnits: analysis.storyUnits,
  }, null, 2)}\n`);
  await fs.writeFile(path.join(root, CODEX_VIDEO_STATUS_FILE), `${JSON.stringify({
    schemaVersion: 1,
    status: 'verified',
    projectPath: root,
    assetMappings,
    effectiveAnalysis: analysis,
    artifacts: { fcpxml: fcpxmlRelative },
    fcpxmlReport: validateFcpxmlStructure(xml, {
      shotCount: analysis.timeline.shots.length,
      assetCount: assetMappings.length,
      markerCount: analysis.timeline.markers.length,
    }),
  }, null, 2)}\n`);
  if (editorialReviews) {
    await fs.mkdir(path.join(root, path.dirname(EDITORIAL_REVIEW_FILE)), { recursive: true });
    await saveEditorialReview(root, { reviews: editorialReviews });
  }
  return { root, fcpxmlPath, fcpxmlRelative };
}

test('Stage 5E: approved 进入导出计划，非确认状态不导出', () => {
  const assets = [videoAsset('vid-1')];
  const shots = [{
    id: 'shot-1', assetId: 'vid-1', inSec: 0, outSec: 10, durationSec: 10,
    fitMode: 'contain', audioMode: 'keep', chapterId: 'ch-1',
  }];
  const analysis = baseAnalysis(assets, shots, {
    lightCaptionPlan: [
      { captionId: 'c-approved', assetId: 'vid-1', text: '采用', startTime: 1, endTime: 2, purpose: 'translate' },
      { captionId: 'c-pending', assetId: 'vid-1', text: '待审', startTime: 2, endTime: 3, purpose: 'translate' },
    ],
  });
  const confirmedCaptions = [
    confirmed('c-approved', 'vid-1', { text: '采用', startTime: 1, endTime: 2 }),
    confirmed('c-edited', 'vid-1', {
      reviewStatus: 'edited_approved',
      text: '人工改写 & <测试>',
      startTime: 3,
      endTime: 5,
    }),
  ];
  const plan = buildCaptionExportPlan({
    confirmedCaptions,
    analysis,
    assetMappings: mappingsFor(assets),
  });
  assert.equal(plan.summary.confirmedCount, 2);
  assert.equal(plan.summary.exportableCount, 2);
  assert.ok(plan.exportableEntries.some((entry) => entry.approvedText === '采用'));
  assert.ok(plan.exportableEntries.some((entry) => entry.approvedText === '人工改写 & <测试>'));

  for (const status of ['pending', 'not_needed', 'rejected', 'needs_review', 'stale']) {
    const blocked = getConfirmedCaptions({
      reviews: {
        'vid-1': {
          assetId: 'vid-1',
          captions: {
            [`c-${status}`]: {
              captionId: `c-${status}`,
              reviewStatus: status,
              approvedText: '不应导出',
              approvedStartTime: 1,
              approvedEndTime: 2,
              originalSuggestion: { text: '不应导出', startTime: 1, endTime: 2 },
            },
          },
        },
      },
    });
    assert.equal(blocked.length, 0, `${status} 不得进入 confirmed`);
  }
});

test('Stage 5E: 未知 asset、未上时间线、区间外字幕被拦截', () => {
  const assets = [videoAsset('vid-1'), videoAsset('vid-2')];
  const shots = [{
    id: 'shot-1', assetId: 'vid-1', inSec: 2, outSec: 8, durationSec: 6,
    fitMode: 'contain', audioMode: 'keep',
  }];
  const analysis = baseAnalysis(assets, shots);
  const plan = buildCaptionExportPlan({
    confirmedCaptions: [
      confirmed('missing-asset', 'ghost', { text: '幽灵' }),
      confirmed('off-timeline', 'vid-2', { text: '未上线' }),
      confirmed('outside', 'vid-1', { text: '区间外', startTime: 0, endTime: 1 }),
      confirmed('partial', 'vid-1', { text: '部分重叠', startTime: 1, endTime: 4 }),
    ],
    analysis,
    assetMappings: mappingsFor(assets),
  });
  const byId = Object.fromEntries(plan.entries.map((entry) => [entry.captionId, entry]));
  assert.equal(byId['missing-asset'].exportable, false);
  assert.match(byId['missing-asset'].warnings.join(' '), /不存在的 assetId/);
  assert.equal(byId['off-timeline'].exportable, false);
  assert.match(byId['off-timeline'].warnings.join(' '), /未进入最终时间线/);
  assert.equal(byId['outside'].exportable, false);
  assert.equal(byId.partial.exportable, true);
  assert.equal(byId.partial.sourceStartTime, 2);
  assert.equal(byId.partial.timelineStartTime, 0);
  assert.ok(byId.partial.warnings.some((warning) => /部分重叠/.test(warning)));
});

test('Stage 5E: 完整视频与裁剪视频源时间正确映射；同素材多次出现匹配相交镜头', () => {
  const assets = [videoAsset('vid-1', 30)];
  const shots = [
    {
      id: 'shot-a', assetId: 'vid-1', inSec: 0, outSec: 10, durationSec: 10,
      fitMode: 'contain', audioMode: 'keep',
    },
    {
      id: 'shot-b', assetId: 'vid-1', inSec: 10, outSec: 20, durationSec: 10,
      fitMode: 'contain', audioMode: 'keep',
    },
  ];
  const analysis = baseAnalysis(assets, shots);
  const plan = buildCaptionExportPlan({
    confirmedCaptions: [
      confirmed('full-map', 'vid-1', { text: '第一段', startTime: 2, endTime: 4 }),
      confirmed('second-clip', 'vid-1', { text: '第二段', startTime: 12, endTime: 14 }),
      confirmed('cross', 'vid-1', { text: '跨镜头', startTime: 9, endTime: 11 }),
    ],
    analysis,
    assetMappings: mappingsFor(assets),
  });
  const first = plan.exportableEntries.find((entry) => entry.captionId === 'full-map');
  assert.equal(first.matchedShotId, 'shot-a');
  assert.equal(first.timelineStartTime, 2);
  assert.equal(first.timelineEndTime, 4);

  const second = plan.exportableEntries.find((entry) => entry.captionId === 'second-clip');
  assert.equal(second.matchedShotId, 'shot-b');
  assert.equal(second.timelineStartTime, 12);
  assert.equal(second.sourceStartTime, 12);

  const cross = plan.exportableEntries.filter((entry) => entry.captionId === 'cross');
  assert.equal(cross.length, 2);
  assert.equal(cross[0].matchedShotId, 'shot-a');
  assert.equal(cross[1].matchedShotId, 'shot-b');
  assert.ok(cross[0].titleKey.endsWith(':seg1'));
  assert.ok(cross[1].titleKey.endsWith(':seg2'));
});

test('Stage 5E: 不支持的变速镜头拒绝线性换算', () => {
  const assets = [videoAsset('vid-1')];
  const shots = [{
    id: 'shot-rate', assetId: 'vid-1', inSec: 0, outSec: 10, durationSec: 5, rate: 2,
    fitMode: 'contain', audioMode: 'keep',
  }];
  const analysis = baseAnalysis(assets, shots);
  const plan = buildCaptionExportPlan({
    confirmedCaptions: [confirmed('rate', 'vid-1', { text: '变速', startTime: 1, endTime: 2 })],
    analysis,
    assetMappings: mappingsFor(assets),
  });
  assert.equal(plan.exportableEntries.length, 0);
  assert.ok(plan.entries[0].warnings.some((warning) => /变速|速率/.test(warning)));
});

test('Stage 5E: 图片字幕映射到图片镜头且无源视频时间；漫画阅读顺序；时长不足不强压', () => {
  const assets = [imageAsset('img-1')];
  const shots = [{
    id: 'shot-img', assetId: 'img-1', inSec: 0, outSec: 2.0, durationSec: 2.0,
    fitMode: 'contain', audioMode: 'mute',
  }];
  const analysis = baseAnalysis(assets, shots, {
    lightCaptionPlan: [
      {
        captionId: 'img-a', assetId: 'img-1', text: '对话一', purpose: 'dialogue',
        basedOn: 'Panel A', readingOrder: 1,
      },
      {
        captionId: 'img-b', assetId: 'img-1', text: '对话二', purpose: 'dialogue',
        basedOn: 'Panel B', readingOrder: 2,
      },
      {
        captionId: 'img-c', assetId: 'img-1', text: '对话三', purpose: 'dialogue',
        basedOn: 'Panel C', readingOrder: 3,
      },
    ],
  });
  const okPlan = buildCaptionExportPlan({
    confirmedCaptions: [
      confirmed('img-b', 'img-1', { text: '对话二', startTime: null, endTime: null, basedOn: 'Panel B' }),
      confirmed('img-a', 'img-1', { text: '对话一', startTime: null, endTime: null, basedOn: 'Panel A' }),
    ],
    analysis: {
      ...analysis,
      lightCaptionPlan: analysis.lightCaptionPlan.slice(0, 2),
      timeline: {
        ...analysis.timeline,
        shots: [{
          id: 'shot-img', assetId: 'img-1', inSec: 0, outSec: 4, durationSec: 4,
          fitMode: 'contain', audioMode: 'mute',
        }],
      },
    },
    assetMappings: mappingsFor(assets),
  });
  assert.equal(okPlan.exportableEntries.length, 2);
  assert.equal(okPlan.exportableEntries[0].approvedText, '对话一');
  assert.equal(okPlan.exportableEntries[1].approvedText, '对话二');
  assert.equal(okPlan.exportableEntries[0].sourceStartTime, null);
  assert.equal(okPlan.exportableEntries[0].matchedShotId, 'shot-img');
  assert.ok(okPlan.exportableEntries[0].timelineStartTime < okPlan.exportableEntries[1].timelineStartTime);

  const conflictPlan = buildCaptionExportPlan({
    confirmedCaptions: [
      confirmed('img-a', 'img-1', { text: '对话一', startTime: null, endTime: null }),
      confirmed('img-b', 'img-1', { text: '对话二', startTime: null, endTime: null }),
      confirmed('img-c', 'img-1', { text: '对话三', startTime: null, endTime: null }),
    ],
    analysis,
    assetMappings: mappingsFor(assets),
  });
  assert.equal(conflictPlan.exportableEntries.length, 0);
  assert.ok(conflictPlan.entries.every((entry) => /不足以按可读速度/.test(entry.warnings.join(' '))));
});

test('Stage 5E: 生成原生 Title、XML 转义、幂等、更新与移除，并保护 Marker/章节 Title/镜头/原声', async () => {
  const assets = [videoAsset('vid-1'), imageAsset('img-1')];
  const shots = [
    {
      id: 'shot-v', assetId: 'vid-1', inSec: 0, outSec: 10, durationSec: 10,
      fitMode: 'contain', audioMode: 'keep', chapterId: 'ch-1',
    },
    {
      id: 'shot-i', assetId: 'img-1', inSec: 0, outSec: 3, durationSec: 3,
      fitMode: 'contain', audioMode: 'mute', chapterId: 'ch-1',
    },
  ];
  const analysis = baseAnalysis(assets, shots, {
    lightCaptionPlan: [
      { captionId: 'v1', assetId: 'vid-1', text: '第一句', startTime: 1, endTime: 3, purpose: 'translate' },
      { captionId: 'v2', assetId: 'vid-1', text: '第二句', startTime: 4, endTime: 6, purpose: 'translate' },
      { captionId: 'i1', assetId: 'img-1', text: '图片句', purpose: 'dialogue', basedOn: 'Panel A' },
      { captionId: 'rej', assetId: 'vid-1', text: '拒绝句', startTime: 7, endTime: 8, purpose: 'translate' },
    ],
  });
  const assetMappings = mappingsFor(assets);
  const project = await makeTempProject({
    analysis,
    assetMappings,
    editorialReviews: {
      'vid-1': {
        assetId: 'vid-1',
        preserveFullClipLocked: true,
        preserveOriginalAudioLocked: true,
        captions: {
          v1: {
            captionId: 'v1',
            reviewStatus: 'approved',
            approvedText: '第一句',
            approvedStartTime: 1,
            approvedEndTime: 3,
            originalSuggestion: { text: '第一句', startTime: 1, endTime: 3 },
          },
          v2: {
            captionId: 'v2',
            reviewStatus: 'edited_approved',
            approvedText: '人工 & <改写>',
            approvedStartTime: 4,
            approvedEndTime: 6,
            originalSuggestion: { text: '第二句', startTime: 4, endTime: 6 },
          },
          rej: {
            captionId: 'rej',
            reviewStatus: 'rejected',
            approvedText: null,
            originalSuggestion: { text: '拒绝句', startTime: 7, endTime: 8 },
          },
        },
      },
      'img-1': {
        assetId: 'img-1',
        captions: {
          i1: {
            captionId: 'i1',
            reviewStatus: 'approved',
            approvedText: '图片句',
            originalSuggestion: { text: '图片句' },
          },
        },
      },
    },
  });

  const beforeXml = await fs.readFile(project.fcpxmlPath, 'utf8');
  const beforeMarkers = [...beforeXml.matchAll(/<marker\s+/g)].length;
  const beforeUnmanaged = [...beforeXml.matchAll(/<title\s+/g)].length
    - extractManagedCaptionTitles(beforeXml).length;
  const beforeClips = [...beforeXml.matchAll(/<(?:asset-clip|video)\s+/g)].length;
  const beforeMute = [...beforeXml.matchAll(/adjust-volume amount="-96dB"/g)].length;

  const first = await exportConfirmedCaptionsToFcpxml(project.root);
  assert.equal(first.ok, true, first.message);
  assert.equal(first.written, true);
  assert.ok(first.summary.added >= 3);

  const xml1 = await fs.readFile(project.fcpxmlPath, 'utf8');
  assert.match(xml1, new RegExp(BASIC_TITLE_EFFECT.uid.replaceAll('.', '\\.')));
  assert.match(xml1, /人工 &amp; &lt;改写&gt;/);
  assert.match(xml1, new RegExp(`${MANAGED_CAPTION_NOTE_PREFIX}vcp-lc:`));
  assert.doesNotMatch(xml1, /拒绝句/);
  assert.equal([...xml1.matchAll(/<marker\s+/g)].length, beforeMarkers);
  assert.equal(
    [...xml1.matchAll(/<title\s+/g)].length - extractManagedCaptionTitles(xml1).length,
    beforeUnmanaged,
  );
  assert.equal([...xml1.matchAll(/<(?:asset-clip|video)\s+/g)].length, beforeClips);
  assert.equal([...xml1.matchAll(/adjust-volume amount="-96dB"/g)].length, beforeMute);
  assert.match(xml1, /asset-clip[^>]*audioRole="dialogue"/);
  assert.doesNotMatch(xml1, /asset-clip[\s\S]*?adjust-volume amount="-96dB"/);

  const second = await exportConfirmedCaptionsToFcpxml(project.root);
  assert.equal(second.ok, true);
  assert.equal(second.written, true);
  assert.equal(second.summary.added, 0);
  assert.equal(extractManagedCaptionTitles(await fs.readFile(project.fcpxmlPath, 'utf8')).length,
    extractManagedCaptionTitles(xml1).length);

  await saveEditorialReview(project.root, {
    reviews: {
      'vid-1': {
        assetId: 'vid-1',
        preserveFullClipLocked: true,
        preserveOriginalAudioLocked: true,
        captions: {
          v1: {
            captionId: 'v1',
            reviewStatus: 'edited_approved',
            approvedText: '第一句已更新',
            approvedStartTime: 1.5,
            approvedEndTime: 3.5,
            originalSuggestion: { text: '第一句', startTime: 1, endTime: 3 },
          },
          v2: {
            captionId: 'v2',
            reviewStatus: 'rejected',
            approvedText: null,
            originalSuggestion: { text: '第二句', startTime: 4, endTime: 6 },
          },
        },
      },
      'img-1': {
        assetId: 'img-1',
        captions: {
          i1: {
            captionId: 'i1',
            reviewStatus: 'approved',
            approvedText: '图片句',
            originalSuggestion: { text: '图片句' },
          },
        },
      },
    },
  });

  const third = await exportConfirmedCaptionsToFcpxml(project.root);
  assert.equal(third.ok, true);
  const xml3 = await fs.readFile(project.fcpxmlPath, 'utf8');
  assert.match(xml3, /第一句已更新/);
  assert.doesNotMatch(xml3, /人工 &amp; &lt;改写&gt;/);
  assert.ok(third.summary.updated >= 1 || third.summary.removed >= 1);
  assert.equal([...xml3.matchAll(/<marker\s+/g)].length, beforeMarkers);

  // titleKey 稳定，不因绝对路径变化
  const key = buildTitleKey({
    captionId: 'v1',
    assetId: 'vid-1',
    matchedShotId: 'shot-v',
  });
  assert.equal(key, 'vcp-lc:v1:vid-1:shot-v');
});

test('Stage 5E: 无已确认字幕时不修改 FCPXML；旧项目无 Stage 5D 数据可预览', async () => {
  const assets = [videoAsset('vid-1')];
  const shots = [{
    id: 'shot-1', assetId: 'vid-1', inSec: 0, outSec: 5, durationSec: 5,
    fitMode: 'contain', audioMode: 'keep',
  }];
  const analysis = baseAnalysis(assets, shots);
  const project = await makeTempProject({
    analysis,
    assetMappings: mappingsFor(assets),
  });
  const before = await fs.readFile(project.fcpxmlPath, 'utf8');
  const preview = await previewConfirmedCaptionFcpxmlExport(project.root);
  assert.equal(preview.noOp, true);
  assert.equal(preview.canWrite, false);
  const result = await exportConfirmedCaptionsToFcpxml(project.root);
  assert.equal(result.written, false);
  assert.equal(result.noOp, true);
  assert.equal(await fs.readFile(project.fcpxmlPath, 'utf8'), before);
});

test('Stage 5E: 写入失败保留旧 FCPXML；受管 Title 可解析；reconcile 统计正确', async () => {
  const assets = [videoAsset('vid-1')];
  const shots = [{
    id: 'shot-1', assetId: 'vid-1', inSec: 0, outSec: 8, durationSec: 8,
    fitMode: 'contain', audioMode: 'keep',
  }];
  const analysis = baseAnalysis(assets, shots);
  const assetMappings = mappingsFor(assets);
  const managed = [{
    kind: 'managed_light_caption',
    titleKey: 'vcp-lc:c1:vid-1:shot-1',
    captionId: 'c1',
    assetId: 'vid-1',
    matchedShotId: 'shot-1',
    startSec: 1,
    durationSec: 2,
    text: '旧字幕',
    note: `${MANAGED_CAPTION_NOTE_PREFIX}vcp-lc:c1:vid-1:shot-1`,
  }];
  const xml = buildFcpxml({
    projectName: 'Stage5E',
    analysis,
    assetMappings,
    managedCaptionTitles: managed,
  });
  assert.match(xml, /note="vcp-managed-caption:vcp-lc:c1:vid-1:shot-1"/);
  const extracted = extractManagedCaptionTitles(xml);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].text, '旧字幕');

  const recon = reconcileManagedTitles(extracted, [{
    titleKey: 'vcp-lc:c1:vid-1:shot-1',
    text: '新字幕',
    durationSec: 2,
  }, {
    titleKey: 'vcp-lc:c2:vid-1:shot-1',
    text: '新增',
    durationSec: 1,
  }]);
  assert.equal(recon.updated, 1);
  assert.equal(recon.added, 1);
  assert.equal(recon.removed, 0);

  const project = await makeTempProject({ analysis, assetMappings, fcpxml: xml });
  const before = await fs.readFile(project.fcpxmlPath, 'utf8');
  await assert.rejects(
    () => writeFcpxml(project.fcpxmlPath, {
      projectName: 'bad',
      analysis: {
        ...analysis,
        timeline: { ...analysis.timeline, shots: [] },
      },
      assetMappings,
      managedCaptionTitles: managed,
    }, { atomic: true, backupExisting: true }),
  );
  assert.equal(await fs.readFile(project.fcpxmlPath, 'utf8'), before);
});

test('Stage 5E: preserveFullClipLocked / preserveOriginalAudio 不被字幕导出破坏', () => {
  const assets = [videoAsset('vid-1')];
  const shots = [{
    id: 'shot-1', assetId: 'vid-1', inSec: 0, outSec: 12, durationSec: 12,
    fitMode: 'contain', audioMode: 'keep',
  }];
  const analysis = baseAnalysis(assets, shots);
  analysis.assets[0].videoPreservationPlan.preserveFullClip = true;
  analysis.assets[0].audioAnalysis.preserveOriginalAudio = true;
  const assetMappings = mappingsFor(assets);
  const xml = buildFcpxml({
    projectName: 'preserve',
    analysis,
    assetMappings,
    managedCaptionTitles: [{
      titleKey: 'vcp-lc:c:vid-1:shot-1',
      text: '字幕',
      startSec: 2,
      durationSec: 2,
      note: `${MANAGED_CAPTION_NOTE_PREFIX}vcp-lc:c:vid-1:shot-1`,
    }],
  });
  assert.match(xml, /asset-clip[^>]*duration="12\/1s"/);
  assert.match(xml, /audioRole="dialogue"/);
  assert.doesNotMatch(xml, /adjust-volume amount="-96dB"/);
  const report = validateFcpxmlStructure(xml, {
    shotCount: 1,
    assetCount: 1,
    markerCount: 1,
    titleCount: 2,
  });
  assert.equal(report.ok, true, report.errors.join('；'));
});
