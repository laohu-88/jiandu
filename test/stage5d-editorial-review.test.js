'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildFcpxml } = require('../src/services/fcpxml-service');
const { EDITORIAL_REVIEW_FILE } = require('../src/constants');
const {
  buildDefaultAudioAnalysis,
  buildDefaultVideoPreservationPlan,
} = require('../src/services/visual-explanation-service');
const {
  buildEditorialReviewModel,
  getConfirmedCaptions,
  loadEditorialReviewFile,
  mergeEditorialReviews,
  saveEditorialReview,
  seekTimeForCaption,
  validateCaptionTimes,
} = require('../src/services/editorial-review-service');

function baseManifest(items, extras = {}) {
  return {
    items,
    storyUnits: extras.storyUnits || [],
    chapters: extras.chapters || [],
    narrative: extras.narrative || { enforceChapterValidation: false },
    ...extras,
  };
}

function baseAnalysis(assets, shots, extras = {}) {
  return {
    schemaVersion: 1,
    theme: {
      summary: 'Stage 5D 解释审阅',
      rationale: '匿名 fixture 验证人工审核、锁定与合并。',
      confidence: 0.9,
      folderNameConflict: false,
    },
    titles: {
      candidates: ['解释与轻字幕审阅', '人工决定优先'],
      recommended: '解释与轻字幕审阅',
      rationale: '对应 Stage 5D 目标。',
    },
    assets,
    lightCaptionPlan: extras.lightCaptionPlan || [],
    timeline: {
      orientation: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 30,
      shots,
      markers: extras.markers || [],
    },
    storyUnits: extras.storyUnits,
  };
}

function videoItem(assetId, durationSec = 10, extras = {}) {
  return {
    assetId,
    type: 'video',
    filename: `${assetId}.mp4`,
    relativePath: `${assetId}.mp4`,
    extension: 'mp4',
    sha256: extras.sha256 || `sha-${assetId}`,
    sizeBytes: 1024,
    metadata: {
      durationSec,
      hasAudio: extras.hasAudio !== false,
      width: 1280,
      height: 720,
    },
    storyUnitId: extras.storyUnitId || 'su-1',
  };
}

function imageItem(assetId, extras = {}) {
  return {
    assetId,
    type: 'image',
    filename: `${assetId}.jpg`,
    relativePath: `${assetId}.jpg`,
    extension: 'jpg',
    sha256: extras.sha256 || `sha-${assetId}`,
    sizeBytes: 512,
    metadata: { width: 1280, height: 720, hasAudio: false },
    storyUnitId: extras.storyUnitId || 'su-1',
  };
}

function videoAsset(assetId, overrides = {}) {
  const item = videoItem(assetId);
  return {
    assetId,
    type: 'video',
    semanticLabels: ['事件'],
    contentSummary: '视频展示事件过程。',
    suggestedUse: ['过程'],
    status: 'adopt',
    reason: '关键过程。',
    ranges: [{ startSec: 0, endSec: 10, confidence: 0.9, reviewRequired: false }],
    confidence: 0.9,
    storyUnitId: 'su-1',
    narrativeRole: 'representative',
    chapterId: 'ch-1',
    visualTextAnalysis: {
      items: [{
        sourceText: 'Hello world',
        language: 'en',
        translatedText: '你好世界',
        meaning: '开场字幕',
        textType: 'subtitle',
        startTime: 1,
        endTime: 3,
        confidence: 0.9,
        warnings: [],
      }],
      warnings: [],
    },
    explanationPlan: {
      audienceNeedsExplanation: 'translate_on_screen_text',
      visualSummary: '画面出现英文开场字幕。',
      keyPoint: '需要翻译',
      setup: '先出现英文',
      payoffOrResult: '理解含义',
      humorOrConflict: null,
      translatedMeaning: '你好世界',
      explanationReason: '外文需要翻译',
      visualEvidenceUsed: ['画面有 Hello world'],
      contextEvidenceUsed: ['sidecar 说明这是开场'],
      inference: ['观众可能看不懂英文'],
      confidence: 0.9,
      warnings: [],
    },
    audioAnalysis: buildDefaultAudioAnalysis(item),
    videoPreservationPlan: buildDefaultVideoPreservationPlan(item),
    ...overrides,
  };
}

function imageAsset(assetId, overrides = {}) {
  return {
    assetId,
    type: 'image',
    semanticLabels: ['梗图'],
    contentSummary: '图片含外文标题。',
    suggestedUse: ['对比'],
    status: 'adopt',
    reason: '有笑点。',
    ranges: [],
    confidence: 0.88,
    storyUnitId: 'su-1',
    narrativeRole: 'supporting',
    chapterId: 'ch-1',
    visualTextAnalysis: {
      items: [{
        sourceText: 'Wait for it...',
        language: 'en',
        translatedText: '等着瞧……',
        meaning: '铺垫反转',
        textType: 'title',
        confidence: 0.92,
        warnings: [],
      }],
      warnings: [],
    },
    explanationPlan: {
      audienceNeedsExplanation: 'humor_or_twist',
      visualSummary: '梗图标题为英文。',
      keyPoint: '反转需要解释',
      setup: '先给英文标题',
      payoffOrResult: '中文点破笑点',
      humorOrConflict: '预期违背',
      translatedMeaning: '等着瞧……',
      explanationReason: '外文梗需要翻译',
      visualEvidenceUsed: ['画面标题 Wait for it...'],
      contextEvidenceUsed: [],
      inference: ['需要轻字幕'],
      confidence: 0.88,
      warnings: [],
    },
    audioAnalysis: {
      audioAvailable: false,
      audioEnabled: false,
      audioRole: 'none',
      preserveOriginalAudio: false,
      muteReason: 'no_audio_stream',
      warnings: [],
    },
    ...overrides,
  };
}

function shot(id, assetId, overrides = {}) {
  return {
    id,
    assetId,
    inSec: overrides.inSec ?? 0,
    outSec: overrides.outSec ?? 10,
    durationSec: overrides.durationSec ?? 10,
    purpose: '过程',
    fitMode: 'contain',
    audioMode: overrides.audioMode || 'keep',
    storyUnitId: 'su-1',
    narrativeRole: 'representative',
    ...overrides,
  };
}

function statusFor(items) {
  return {
    schemaVersion: 1,
    status: 'generated',
    assetMappings: items.map((item) => ({
      assetId: item.assetId,
      type: item.type,
      sourceRelativePath: item.relativePath,
      sourceSha256: item.sha256,
      projectFilename: item.filename,
      projectRelativePath: path.join('01-精选素材', item.filename),
      projectStableId: `stable-${item.assetId}`,
      metadata: item.metadata,
    })),
    artifacts: {},
  };
}

async function createFixtureProject(label = 'stage5d') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  const control = path.join(root, '00-项目总控');
  const assetsDir = path.join(root, '01-精选素材');
  await fs.mkdir(control, { recursive: true });
  await fs.mkdir(assetsDir, { recursive: true });
  const video = videoItem('vid_1', 10);
  const image = imageItem('img_1');
  const analysis = baseAnalysis([
    videoAsset('vid_1'),
    imageAsset('img_1'),
  ], [
    shot('shot-1', 'vid_1'),
    shot('shot-2', 'img_1', { inSec: 0, outSec: 2.5, durationSec: 2.5, audioMode: 'mute' }),
  ], {
    lightCaptionPlan: [
      {
        captionId: 'cap-vid',
        assetId: 'vid_1',
        storyUnitId: 'su-1',
        startTime: 1,
        endTime: 3,
        text: '你好世界',
        purpose: 'translate',
        basedOn: 'visualText:Hello world',
        confidence: 0.9,
        reviewRequired: true,
        warnings: [],
      },
      {
        captionId: 'cap-img',
        assetId: 'img_1',
        storyUnitId: 'su-1',
        startTime: 0,
        endTime: 2,
        text: '等着瞧……',
        purpose: 'humor',
        basedOn: 'visualText:Wait for it...',
        confidence: 0.88,
        reviewRequired: false,
        warnings: [],
      },
    ],
    storyUnits: [{
      storyUnitId: 'su-1',
      assetIds: ['vid_1', 'img_1'],
      theme: '开场反转',
      narrativeRole: 'hook',
      chapterId: 'ch-1',
      contextSourceFiles: [],
      representativeAssetIds: ['vid_1'],
      supportingAssetIds: ['img_1'],
      alternateAssetIds: [],
      duplicateAssetIds: [],
      unusableAssetIds: [],
      selectionReason: '代表开场',
      confidence: 0.9,
      conflicts: [],
      warnings: [],
      evidence: {
        visualEvidenceUsed: ['视频字幕'],
        contextEvidenceUsed: [],
        inference: ['需要解释'],
      },
    }],
  });
  const manifest = baseManifest([video, image], {
    storyUnits: analysis.storyUnits,
  });
  const status = statusFor([video, image]);
  await fs.writeFile(path.join(assetsDir, video.filename), 'fake-video');
  await fs.writeFile(path.join(assetsDir, image.filename), 'fake-image');
  await fs.writeFile(path.join(control, 'Codex视频分析.json'), `${JSON.stringify(analysis, null, 2)}\n`);
  await fs.writeFile(path.join(control, 'Codex视频素材清单.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(control, 'Codex视频状态.json'), `${JSON.stringify(status, null, 2)}\n`);
  await fs.writeFile(path.join(control, 'project.json'), `${JSON.stringify({
    projectName: 'stage5d-fixture',
    version: '3',
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return { root, analysis, manifest, status, video, image };
}

test('Stage 5C 数据可加载到审核模型', async () => {
  const { root } = await createFixtureProject();
  const model = await buildEditorialReviewModel(root);
  assert.equal(model.available, true);
  assert.equal(model.items.length, 2);
  assert.ok(model.items.some((item) => item.hasVisualText));
  assert.ok(model.items.some((item) => item.suggestsLightCaption));
  assert.equal(model.summary.needsReview >= 1, true);
});

test('未审核视频字幕保留建议时间，不把 null 当成 0 秒', async () => {
  const { root, analysis, manifest, status } = await createFixtureProject('stage5d-seek');
  const merged = mergeEditorialReviews({
    stored: null,
    analysis,
    manifest,
    status,
  });
  const storedCaption = merged.reviews.vid_1.captions['cap-vid'];
  assert.equal(storedCaption.approvedStartTime, null);
  assert.equal(storedCaption.approvedEndTime, null);
  assert.equal(storedCaption.originalSuggestion.startTime, 1);
  assert.equal(storedCaption.originalSuggestion.endTime, 3);

  const model = await buildEditorialReviewModel(root);
  const videoCaption = model.items
    .find((item) => item.assetId === 'vid_1')
    .captions
    .find((caption) => caption.captionId === 'cap-vid');
  assert.equal(videoCaption.displayTiming.startTime, 1);
  assert.equal(videoCaption.displayTiming.endTime, 3);
  assert.equal(videoCaption.seekTimeSec, 1);
  assert.equal(seekTimeForCaption(videoCaption), 1);
});

test('没有 Stage 5C 数据的旧项目正常打开', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stage5d-old-'));
  await fs.mkdir(path.join(root, '00-项目总控'), { recursive: true });
  const analysis = baseAnalysis([{
    assetId: 'old_1',
    type: 'image',
    semanticLabels: ['旧'],
    contentSummary: '旧素材',
    suggestedUse: ['参考'],
    status: 'adopt',
    reason: '兼容',
    ranges: [],
    confidence: 0.8,
  }], [shot('shot-1', 'old_1', { durationSec: 2, outSec: 2, audioMode: 'mute' })]);
  const manifest = baseManifest([imageItem('old_1')]);
  await fs.writeFile(path.join(root, '00-项目总控', 'Codex视频分析.json'), `${JSON.stringify(analysis, null, 2)}\n`);
  await fs.writeFile(path.join(root, '00-项目总控', 'Codex视频素材清单.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(root, '00-项目总控', 'Codex视频状态.json'), `${JSON.stringify(statusFor(manifest.items), null, 2)}\n`);
  const model = await buildEditorialReviewModel(root);
  assert.equal(model.available, false);
  assert.match(model.message, /暂无解释与轻字幕分析/);
  assert.equal(model.items.length, 0);
});

test('新建议默认 pending，reviewRequired 进入 needs_review', async () => {
  const { root } = await createFixtureProject();
  const model = await buildEditorialReviewModel(root);
  const video = model.items.find((item) => item.assetId === 'vid_1');
  const image = model.items.find((item) => item.assetId === 'img_1');
  assert.equal(video.captions[0].reviewStatus, 'needs_review');
  assert.equal(image.captions[0].reviewStatus, 'pending');
});

test('approved 状态可保存并恢复', async () => {
  const { root } = await createFixtureProject();
  await saveEditorialReview(root, {
    reviews: {
      vid_1: {
        captions: {
          'cap-vid': {
            reviewStatus: 'approved',
            approvedText: '你好世界',
            approvedStartTime: 1,
            approvedEndTime: 3,
          },
        },
      },
    },
  });
  const reloaded = await buildEditorialReviewModel(root);
  const caption = reloaded.items.find((item) => item.assetId === 'vid_1').captions[0];
  assert.equal(caption.reviewStatus, 'approved');
  assert.equal(caption.approvedText, '你好世界');
  const file = await loadEditorialReviewFile(root);
  assert.equal(file.reviews.vid_1.captions['cap-vid'].reviewStatus, 'approved');
});

test('edited_approved 可保存人工文本', async () => {
  const { root } = await createFixtureProject();
  await saveEditorialReview(root, {
    reviews: {
      vid_1: {
        captions: {
          'cap-vid': {
            reviewStatus: 'edited_approved',
            approvedText: '开场你好',
            approvedStartTime: 1.2,
            approvedEndTime: 3.1,
          },
        },
      },
    },
  });
  const model = await buildEditorialReviewModel(root);
  const caption = model.items.find((item) => item.assetId === 'vid_1').captions[0];
  assert.equal(caption.reviewStatus, 'edited_approved');
  assert.equal(caption.approvedText, '开场你好');
});

test('视频字幕修改时间可保存并恢复', async () => {
  const { root } = await createFixtureProject();
  await saveEditorialReview(root, {
    reviews: {
      vid_1: {
        captions: {
          'cap-vid': {
            reviewStatus: 'edited_approved',
            approvedText: '开场你好',
            approvedStartTime: 2,
            approvedEndTime: 4,
          },
        },
      },
    },
  });
  const model = await buildEditorialReviewModel(root);
  const caption = model.items.find((item) => item.assetId === 'vid_1').captions[0];
  assert.equal(caption.approvedStartTime, 2);
  assert.equal(caption.approvedEndTime, 4);
});

test('非法时间范围被阻止', async () => {
  const { root } = await createFixtureProject();
  await assert.rejects(
    () => saveEditorialReview(root, {
      reviews: {
        vid_1: {
          captions: {
            'cap-vid': {
              reviewStatus: 'approved',
              approvedText: '你好世界',
              approvedStartTime: 5,
              approvedEndTime: 4,
            },
          },
        },
      },
    }),
    /endTime 必须大于 startTime/,
  );
});

test('视频字幕时间不得超过源时长', async () => {
  const { root } = await createFixtureProject();
  await assert.rejects(
    () => saveEditorialReview(root, {
      reviews: {
        vid_1: {
          captions: {
            'cap-vid': {
              reviewStatus: 'approved',
              approvedText: '你好世界',
              approvedStartTime: 0,
              approvedEndTime: 12,
            },
          },
        },
      },
    }),
    /不得超过源视频时长/,
  );
});

test('图片不得保存非法视频时间', async () => {
  const { root } = await createFixtureProject();
  await assert.rejects(
    () => saveEditorialReview(root, {
      reviews: {
        img_1: {
          captions: {
            'cap-img': {
              reviewStatus: 'approved',
              approvedText: '等着瞧……',
              forceVideoSourceTimes: true,
              approvedStartTime: 1,
              approvedEndTime: 2,
            },
          },
        },
      },
    }),
    /图片不得保存非法视频源时间/,
  );
});

test('not_needed / rejected / needs_review / stale 不进入已确认字幕集合', async () => {
  const reviews = {
    a: {
      assetId: 'a',
      captions: {
        c1: { captionId: 'c1', reviewStatus: 'not_needed', approvedText: 'x' },
        c2: { captionId: 'c2', reviewStatus: 'rejected', approvedText: 'y' },
        c3: { captionId: 'c3', reviewStatus: 'needs_review', approvedText: 'z' },
        c4: { captionId: 'c4', reviewStatus: 'stale', approvedText: 's' },
        c5: { captionId: 'c5', reviewStatus: 'pending', approvedText: 'p' },
      },
    },
  };
  const confirmed = getConfirmedCaptions({ reviews });
  assert.equal(confirmed.length, 0);
});

test('approved 和 edited_approved 正确进入已确认字幕集合', async () => {
  const confirmed = getConfirmedCaptions({
    reviews: {
      vid_1: {
        assetId: 'vid_1',
        captions: {
          'cap-a': {
            captionId: 'cap-a',
            reviewStatus: 'approved',
            approvedText: '采用原文',
            approvedStartTime: 1,
            approvedEndTime: 2,
            originalSuggestion: { text: '采用原文', startTime: 1, endTime: 2 },
          },
          'cap-b': {
            captionId: 'cap-b',
            reviewStatus: 'edited_approved',
            approvedText: '人工改写',
            approvedStartTime: 2,
            approvedEndTime: 3,
          },
        },
      },
    },
  });
  assert.equal(confirmed.length, 2);
  assert.deepEqual(confirmed.map((item) => item.text).sort(), ['人工改写', '采用原文']);
});

test('人工编辑文本不会被重新分析覆盖，同时可出现新建议', async () => {
  const { root, analysis, manifest, status } = await createFixtureProject();
  await saveEditorialReview(root, {
    reviews: {
      vid_1: {
        captions: {
          'cap-vid': {
            reviewStatus: 'edited_approved',
            approvedText: '人工锁定文本',
            approvedStartTime: 1,
            approvedEndTime: 3,
          },
        },
      },
    },
  });
  const nextAnalysis = {
    ...analysis,
    lightCaptionPlan: [
      ...analysis.lightCaptionPlan,
      {
        captionId: 'cap-new',
        assetId: 'vid_1',
        storyUnitId: 'su-1',
        startTime: 4,
        endTime: 5,
        text: '新建议',
        purpose: 'clarify',
        basedOn: 'new',
        confidence: 0.7,
        reviewRequired: false,
        warnings: [],
      },
    ],
  };
  await fs.writeFile(
    path.join(root, '00-项目总控', 'Codex视频分析.json'),
    `${JSON.stringify(nextAnalysis, null, 2)}\n`,
  );
  const model = await buildEditorialReviewModel(root, {
    analysis: nextAnalysis,
    manifest,
    status,
  });
  const captions = model.items.find((item) => item.assetId === 'vid_1').captions;
  const edited = captions.find((caption) => caption.captionId === 'cap-vid');
  const created = captions.find((caption) => caption.captionId === 'cap-new');
  assert.equal(edited.approvedText, '人工锁定文本');
  assert.equal(edited.reviewStatus, 'edited_approved');
  assert.equal(created.reviewStatus, 'pending');
  assert.equal(created.suggestedText, '新建议');
});

test('素材真实变化时人工决定标记 stale；目录改名与 DS_Store 不导致 stale', async () => {
  const { root, analysis, manifest, status, video } = await createFixtureProject();
  await saveEditorialReview(root, {
    reviews: {
      vid_1: {
        captions: {
          'cap-vid': {
            reviewStatus: 'approved',
            approvedText: '你好世界',
            approvedStartTime: 1,
            approvedEndTime: 3,
          },
        },
      },
    },
  });

  const renamed = `${root}-renamed`;
  await fs.rename(root, renamed);
  await fs.writeFile(path.join(renamed, '.DS_Store'), 'junk');
  const afterRename = await buildEditorialReviewModel(renamed);
  assert.equal(
    afterRename.items.find((item) => item.assetId === 'vid_1').captions[0].reviewStatus,
    'approved',
  );

  const changedManifest = {
    ...manifest,
    items: manifest.items.map((item) => (
      item.assetId === 'vid_1'
        ? { ...item, sha256: 'sha-changed-content' }
        : item
    )),
  };
  const changedStatus = {
    ...status,
    assetMappings: status.assetMappings.map((item) => (
      item.assetId === 'vid_1'
        ? { ...item, sourceSha256: 'sha-changed-content' }
        : item
    )),
  };
  const merged = mergeEditorialReviews({
    stored: await loadEditorialReviewFile(renamed),
    analysis,
    manifest: changedManifest,
    status: changedStatus,
  });
  assert.equal(merged.reviews.vid_1.reviewStatus, 'stale');
  assert.match(merged.reviews.vid_1.staleReason || '', /内容发生变化|被替换/);
  assert.ok(video.sha256 !== 'sha-changed-content');
});

test('preserveFullClipLocked / preserveOriginalAudioLocked 可保存并覆盖自动建议', async () => {
  const { root, analysis } = await createFixtureProject();
  analysis.assets[0].videoPreservationPlan.preserveFullClip = false;
  analysis.assets[0].videoPreservationPlan.proposedIn = 1;
  analysis.assets[0].videoPreservationPlan.proposedOut = 4;
  analysis.assets[0].videoPreservationPlan.keepRatio = 0.3;
  analysis.assets[0].audioAnalysis.preserveOriginalAudio = false;
  analysis.assets[0].audioAnalysis.audioEnabled = false;
  analysis.assets[0].audioAnalysis.muteReason = 'user_brief';
  await fs.writeFile(
    path.join(root, '00-项目总控', 'Codex视频分析.json'),
    `${JSON.stringify(analysis, null, 2)}\n`,
  );
  await saveEditorialReview(root, {
    reviews: {
      vid_1: {
        preserveFullClipLocked: true,
        preserveOriginalAudioLocked: true,
      },
    },
  });
  const model = await buildEditorialReviewModel(root);
  const item = model.items.find((entry) => entry.assetId === 'vid_1');
  assert.equal(item.preserveFullClipLocked, true);
  assert.equal(item.preserveOriginalAudioLocked, true);
  assert.equal(item.preserveFullClip, true);
  assert.equal(item.preserveOriginalAudio, true);
});

test('没有原因时不能人工设置静音', async () => {
  const { root } = await createFixtureProject();
  await saveEditorialReview(root, {
    reviews: {
      vid_1: {
        preserveOriginalAudioLocked: true,
      },
    },
  });
  await assert.rejects(
    () => saveEditorialReview(root, {
      reviews: {
        vid_1: {
          preserveOriginalAudioLocked: false,
          forceMute: true,
        },
      },
    }),
    /没有原因时不能人工设置静音|解除原声保留必须填写原因/,
  );
});

test('保存结果不写入 HotIngest 源目录，且可重新加载', async () => {
  const { root } = await createFixtureProject();
  const hotingest = await fs.mkdtemp(path.join(os.tmpdir(), 'hotingest-readonly-'));
  const before = await fs.readdir(hotingest);
  await saveEditorialReview(root, {
    reviews: {
      img_1: {
        captions: {
          'cap-img': {
            reviewStatus: 'approved',
            approvedText: '等着瞧……',
          },
        },
      },
    },
  });
  const after = await fs.readdir(hotingest);
  assert.deepEqual(after, before);
  const reviewPath = path.join(root, EDITORIAL_REVIEW_FILE);
  const exists = await fs.stat(reviewPath);
  assert.equal(exists.isFile(), true);
  const reloaded = await buildEditorialReviewModel(root);
  assert.equal(
    reloaded.items.find((item) => item.assetId === 'img_1').captions[0].reviewStatus,
    'approved',
  );
});

test('损坏的单条审核记录不会使整个项目崩溃，不存在的 assetId 被拒绝', async () => {
  const { root } = await createFixtureProject();
  await fs.writeFile(
    path.join(root, EDITORIAL_REVIEW_FILE),
    `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      reviews: {
        vid_1: {
          assetId: 'vid_1',
          reviewStatus: 'approved',
          captions: {
            'cap-vid': {
              captionId: 'cap-vid',
              reviewStatus: 'approved',
              approvedText: '你好世界',
              approvedStartTime: 1,
              approvedEndTime: 3,
            },
          },
        },
        bad: null,
      },
    }, null, 2)}\n`,
  );
  const model = await buildEditorialReviewModel(root);
  assert.equal(model.available, true);
  assert.ok(model.items.some((item) => item.assetId === 'vid_1'));
  await assert.rejects(
    () => saveEditorialReview(root, {
      reviews: {
        missing_asset: {
          reviewStatus: 'approved',
        },
      },
    }),
    /拒绝不存在的 assetId/,
  );
});

test('点击视频字幕建议可生成合法 seek 时间', () => {
  assert.equal(seekTimeForCaption({ seekTimeSec: 1.25 }), 1.25);
  assert.equal(seekTimeForCaption({ approvedStartTime: 2 }), 2);
  assert.equal(seekTimeForCaption({ displayTiming: { startTime: 3 } }), 3);
  assert.equal(seekTimeForCaption({ seekTimeSec: -1 }), null);
});

test('本阶段不会增加 FCP Title / Marker，也不会修改已有 FCPXML', async () => {
  const { root, analysis, status } = await createFixtureProject();
  const beforeMarkers = analysis.timeline.markers.length;
  const xmlPath = path.join(root, '03-导出', 'FCPXML', 'demo.fcpxml');
  await fs.mkdir(path.dirname(xmlPath), { recursive: true });
  const mappings = status.assetMappings.map((item) => ({
    ...item,
    projectAbsolutePath: path.join(root, item.projectRelativePath),
  }));
  const built = buildFcpxml({
    projectName: 'stage5d',
    analysis,
    assetMappings: mappings,
  });
  await fs.writeFile(xmlPath, typeof built === 'string' ? built : built.xml);
  const beforeXml = await fs.readFile(xmlPath, 'utf8');
  const beforeTitleCount = (beforeXml.match(/<title[\s>]/g) || []).length;

  await saveEditorialReview(root, {
    reviews: {
      vid_1: {
        captions: {
          'cap-vid': {
            reviewStatus: 'approved',
            approvedText: '你好世界',
            approvedStartTime: 1,
            approvedEndTime: 3,
          },
        },
      },
      img_1: {
        captions: {
          'cap-img': {
            reviewStatus: 'edited_approved',
            approvedText: '人工字幕',
          },
        },
      },
    },
  });

  const afterAnalysis = JSON.parse(
    await fs.readFile(path.join(root, '00-项目总控', 'Codex视频分析.json'), 'utf8'),
  );
  const afterXml = await fs.readFile(xmlPath, 'utf8');
  assert.equal(afterAnalysis.timeline.markers.length, beforeMarkers);
  assert.equal(afterXml, beforeXml);
  assert.equal((afterXml.match(/<title[\s>]/g) || []).length, beforeTitleCount);
  assert.equal(getConfirmedCaptions(await loadEditorialReviewFile(root)).length, 2);
});

test('时间校验辅助函数覆盖保留区间', () => {
  const errors = validateCaptionTimes({
    mediaType: 'video',
    startTime: 0,
    endTime: 2,
    sourceDuration: 10,
    preserveFullClip: false,
    proposedIn: 3,
    proposedOut: 8,
  });
  assert.ok(errors.some((item) => /保留区间之外/.test(item)));
});
