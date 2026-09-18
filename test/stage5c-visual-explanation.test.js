'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectFcpTitles, buildFcpxml, validateFcpxmlStructure } = require('../src/services/fcpxml-service');
const { validateVideoAnalysis } = require('../src/services/video-analysis-schema');
const { inspectedNoneCleanup } = require('../src/services/source-cleanup-service');
const {
  buildDefaultAudioAnalysis,
  buildDefaultVideoPreservationPlan,
  contextMasqueradesAsVisualText,
  fcpxmlShouldMuteShot,
  mergeVisualTextIntervals,
  summarizeVisualExplanation,
  textsAreSameSubtitle,
} = require('../src/services/visual-explanation-service');

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
      summary: 'Stage 5C 视觉解释与素材保留',
      rationale: '匿名最小 fixture 验证画面文字、解释与保留策略。',
      confidence: 0.9,
      folderNameConflict: false,
    },
    titles: {
      candidates: ['画面文字与原声保留', '解释规划不写进 FCP'],
      recommended: '画面文字与原声保留',
      rationale: '对应 Stage 5C 目标。',
    },
    assets,
    lightCaptionPlan: extras.lightCaptionPlan || [],
    visualExplanationSummary: extras.visualExplanationSummary,
    timeline: {
      orientation: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 30,
      shots,
      markers: extras.markers || [],
      durationPolicy: extras.durationPolicy,
      durationException: extras.durationException,
      chapterSegments: extras.chapterSegments,
    },
    storyUnits: extras.storyUnits,
    chapters: extras.chapters,
  };
}

function videoItem(assetId, durationSec = 10, extras = {}) {
  return {
    assetId,
    type: 'video',
    filename: `${assetId}.mp4`,
    relativePath: `${assetId}.mp4`,
    extension: 'mp4',
    metadata: {
      durationSec,
      hasAudio: extras.hasAudio !== false,
      audioChannels: 2,
      sampleRate: 48000,
      width: 1280,
      height: 720,
    },
    context: extras.context,
    storyUnitId: extras.storyUnitId,
    semanticProfile: extras.semanticProfile,
  };
}

function imageItem(assetId, extras = {}) {
  return {
    assetId,
    type: 'image',
    filename: `${assetId}.jpg`,
    relativePath: `${assetId}.jpg`,
    extension: 'jpg',
    metadata: { width: 1280, height: 720, hasAudio: false },
    context: extras.context,
    storyUnitId: extras.storyUnitId,
    semanticProfile: extras.semanticProfile,
  };
}

function videoAsset(assetId, overrides = {}) {
  return {
    assetId,
    type: 'video',
    semanticLabels: ['事件'],
    contentSummary: '视频展示事件过程。',
    suggestedUse: ['过程'],
    status: 'adopt',
    reason: '关键过程。',
    cleanup: inspectedNoneCleanup(),
    ranges: [{ startSec: 0, endSec: 10, confidence: 0.9, reviewRequired: false }],
    confidence: 0.9,
    audioAnalysis: buildDefaultAudioAnalysis(videoItem(assetId, 10)),
    videoPreservationPlan: buildDefaultVideoPreservationPlan(videoItem(assetId, 10)),
    ...overrides,
  };
}

function imageAsset(assetId, overrides = {}) {
  return {
    assetId,
    type: 'image',
    semanticLabels: ['截图'],
    contentSummary: '图片展示静态画面。',
    suggestedUse: ['结果'],
    status: 'adopt',
    reason: '静态证据。',
    cleanup: inspectedNoneCleanup(),
    ranges: [],
    confidence: 0.92,
    audioAnalysis: buildDefaultAudioAnalysis(imageItem(assetId)),
    ...overrides,
  };
}

function shot(id, assetId, overrides = {}) {
  return {
    id,
    assetId,
    inSec: 0,
    outSec: 10,
    durationSec: 10,
    fitMode: 'contain',
    audioMode: 'keep',
    purpose: '保留完整内容',
    confidence: 0.9,
    reviewRequired: false,
    ...overrides,
  };
}

test('图片外文文字能生成原文、翻译和解释', () => {
  const item = imageItem('img_en', {
    context: {
      files: [{ relativePath: 'img_en.context.html', type: 'context-html' }],
      title: 'Sidecar event title about cats',
      body: 'A long post body that must not become OCR.',
    },
  });
  const asset = imageAsset('img_en', {
    visualTextAnalysis: {
      items: [{
        sourceText: 'Wait for it...',
        language: 'en',
        translatedText: '等着瞧……',
        meaning: '画面标题在铺垫即将出现的反转。',
        textType: 'title',
        readingOrder: 1,
        confidence: 0.91,
        frameEvidence: ['imagePreview'],
        warnings: [],
      }],
      warnings: [],
    },
    explanationPlan: {
      assetId: 'img_en',
      storyUnitId: null,
      visualSummary: '梗图顶部英文标题。',
      visualTextSummary: 'Wait for it...',
      audioSummary: '无音频。',
      contextSummary: 'sidecar 提供事件背景。',
      translatedMeaning: '观众需要知道这是反转铺垫。',
      audienceNeedsExplanation: 'translate_on_screen_text',
      explanationReason: '外文标题本身是笑点铺垫。',
      keyPoint: '铺垫反转',
      setup: 'Wait for it...',
      payoffOrResult: '',
      humorOrConflict: '预期与结果反差',
      confidence: 0.9,
      visualEvidenceUsed: ['顶部标题条'],
      visualTextEvidenceUsed: ['Wait for it...'],
      audioEvidenceUsed: [],
      contextEvidenceUsed: ['sidecar 提供事件背景'],
      inference: ['需要一条翻译轻字幕'],
      warnings: [],
    },
    contextUsage: {
      used: true,
      sourceFiles: ['img_en.context.html'],
      visualEvidence: '画面顶部有英文标题。',
      contextEvidence: 'sidecar 说明事件背景，不作为 OCR。',
    },
  });
  const analysis = baseAnalysis([asset], [
    shot('shot-1', 'img_en', { inSec: 0, outSec: 2.5, durationSec: 2.5, audioMode: 'mute' }),
  ], {
    lightCaptionPlan: [{
      captionId: 'cap-1',
      assetId: 'img_en',
      storyUnitId: null,
      startTime: 0,
      endTime: 2,
      text: '等着瞧……',
      purpose: 'translate',
      basedOn: 'visualText:Wait for it...',
      confidence: 0.9,
      reviewRequired: false,
      warnings: [],
    }],
  });
  assert.doesNotThrow(() => validateVideoAnalysis(analysis, baseManifest([item])));
  assert.equal(asset.visualTextAnalysis.items[0].sourceText, 'Wait for it...');
  assert.equal(asset.visualTextAnalysis.items[0].translatedText, '等着瞧……');
  assert.match(asset.explanationPlan.meaning || asset.explanationPlan.translatedMeaning, /反转|铺垫/);
});

test('视频重复字幕帧合并，不同字幕不误合并，时间不超出源时长', () => {
  const merged = mergeVisualTextIntervals([
    {
      sourceText: 'Hello!!!',
      textType: 'subtitle',
      startTime: 1.2,
      endTime: 1.8,
      confidence: 0.9,
      frameEvidence: ['t1.2'],
    },
    {
      sourceText: 'Hello!',
      textType: 'subtitle',
      startTime: 1.85,
      endTime: 2.4,
      confidence: 0.88,
      frameEvidence: ['t1.85'],
    },
    {
      sourceText: 'Hello!',
      textType: 'subtitle',
      startTime: 2.45,
      endTime: 3.8,
      confidence: 0.87,
      frameEvidence: ['t2.45'],
    },
    {
      sourceText: 'Plot twist',
      textType: 'subtitle',
      startTime: 4.1,
      endTime: 6.2,
      confidence: 0.86,
      frameEvidence: ['t4.1'],
    },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(textsAreSameSubtitle('Hello!!!', 'Hello!'), true);
  assert.equal(textsAreSameSubtitle('Hello!', 'Plot twist'), false);
  assert.equal(merged[0].startTime, 1.2);
  assert.equal(merged[0].endTime, 3.8);
  assert.equal(merged[1].sourceText, 'Plot twist');

  const item = videoItem('vid_sub', 8);
  const asset = videoAsset('vid_sub', {
    ranges: [{ startSec: 0, endSec: 8, confidence: 0.9, reviewRequired: false }],
    audioAnalysis: buildDefaultAudioAnalysis(item),
    videoPreservationPlan: buildDefaultVideoPreservationPlan(item),
    visualTextAnalysis: {
      items: merged.map((entry) => ({
        ...entry,
        language: 'en',
        translatedText: entry.sourceText === 'Plot twist' ? '剧情反转' : '你好',
        meaning: entry.sourceText === 'Plot twist' ? '反转字幕出现' : '开场招呼字幕',
        warnings: [],
      })),
      warnings: [],
    },
  });
  const analysis = baseAnalysis([asset], [
    shot('shot-1', 'vid_sub', { outSec: 8, durationSec: 8 }),
  ]);
  assert.doesNotThrow(() => validateVideoAnalysis(analysis, baseManifest([item])));

  const tooLate = structuredClone(analysis);
  tooLate.assets[0].visualTextAnalysis.items[1].endTime = 9.5;
  assert.throws(
    () => validateVideoAnalysis(tooLate, baseManifest([item])),
    /超出源时长/,
  );
});

test('漫画气泡按阅读顺序输出；不确定时产生 warning', () => {
  const item = imageItem('comic');
  const ordered = imageAsset('comic', {
    visualTextAnalysis: {
      panelCount: 2,
      readingDirection: 'ltr',
      readingOrderUncertain: false,
      items: [
        {
          sourceText: 'Did you finish?',
          language: 'en',
          translatedText: '你做完了吗？',
          meaning: '左侧角色提问。',
          textType: 'speech_bubble',
          readingOrder: 1,
          speakerOrRegion: 'left-panel',
          confidence: 0.9,
          frameEvidence: ['panel-1'],
          warnings: [],
        },
        {
          sourceText: 'Nope.',
          language: 'en',
          translatedText: '没有。',
          meaning: '右侧角色回答，形成反差。',
          textType: 'speech_bubble',
          readingOrder: 2,
          speakerOrRegion: 'right-panel',
          confidence: 0.9,
          frameEvidence: ['panel-2'],
          warnings: [],
        },
      ],
      warnings: [],
    },
  });
  assert.doesNotThrow(() => validateVideoAnalysis(
    baseAnalysis([ordered], [shot('s1', 'comic', { outSec: 3, durationSec: 3, audioMode: 'mute' })]),
    baseManifest([item]),
  ));

  const uncertain = structuredClone(ordered);
  uncertain.visualTextAnalysis.readingOrderUncertain = true;
  uncertain.visualTextAnalysis.readingDirection = 'unknown';
  uncertain.visualTextAnalysis.warnings = [];
  assert.throws(
    () => validateVideoAnalysis(
      baseAnalysis([uncertain], [shot('s1', 'comic', { outSec: 3, durationSec: 3, audioMode: 'mute' })]),
      baseManifest([item]),
    ),
    /阅读顺序不确定/,
  );
});

test('visualTextEvidence 与 contextEvidence 分离；context 不能伪装成画面文字', () => {
  const item = imageItem('ctx_img', {
    context: {
      files: [{ relativePath: 'ctx_img.context.html', type: 'context-html' }],
      title: 'UniqueSidecarHeadlineXYZ',
      body: 'UniqueSidecarBodyTextXYZ that should never become OCR.',
    },
  });
  assert.equal(
    contextMasqueradesAsVisualText('UniqueSidecarHeadlineXYZ', item),
    true,
  );
  assert.equal(
    contextMasqueradesAsVisualText('ON SCREEN LABEL', item),
    false,
  );

  const asset = imageAsset('ctx_img', {
    contextUsage: {
      used: true,
      sourceFiles: ['ctx_img.context.html'],
      visualEvidence: '画面有标签文字。',
      contextEvidence: 'sidecar 提供事件标题。',
    },
    visualTextAnalysis: {
      items: [{
        sourceText: 'UniqueSidecarHeadlineXYZ',
        language: 'en',
        translatedText: '侧车标题',
        meaning: '错误地把 context 当 OCR。',
        textType: 'title',
        confidence: 0.4,
        frameEvidence: [],
        warnings: [],
      }],
      warnings: [],
    },
    explanationPlan: {
      assetId: 'ctx_img',
      visualSummary: '截图',
      audienceNeedsExplanation: 'background',
      explanationReason: '需要背景',
      keyPoint: '背景',
      confidence: 0.7,
      visualEvidenceUsed: ['截图主体'],
      visualTextEvidenceUsed: ['sidecar 提供事件标题'],
      contextEvidenceUsed: ['sidecar 提供事件标题'],
      inference: ['冲突'],
      warnings: [],
    },
  });
  assert.throws(
    () => validateVideoAnalysis(
      baseAnalysis([asset], [shot('s1', 'ctx_img', { outSec: 2, durationSec: 2, audioMode: 'mute' })]),
      baseManifest([item]),
    ),
    /伪装成画面文字|contextEvidence 不得填入 visualTextEvidence/,
  );
});

test('自解释素材可无需字幕；外文素材可生成轻字幕且不增加 FCP Title/Marker', () => {
  const selfItem = imageItem('self');
  const foreignItem = videoItem('foreign', 6);
  const selfAsset = imageAsset('self', {
    explanationPlan: {
      assetId: 'self',
      visualSummary: '中文界面截图。',
      visualTextSummary: '设置已保存',
      audienceNeedsExplanation: 'none',
      explanationReason: '画面中文已经足够清楚。',
      keyPoint: '设置已保存',
      confidence: 0.95,
      visualEvidenceUsed: ['中文提示'],
      visualTextEvidenceUsed: ['设置已保存'],
      audioEvidenceUsed: [],
      contextEvidenceUsed: [],
      inference: ['无需轻字幕'],
      warnings: [],
    },
  });
  const foreignAsset = videoAsset('foreign', {
    ranges: [{ startSec: 0, endSec: 6, confidence: 0.9, reviewRequired: false }],
    audioAnalysis: buildDefaultAudioAnalysis(foreignItem),
    videoPreservationPlan: buildDefaultVideoPreservationPlan(foreignItem),
    visualTextAnalysis: {
      items: [{
        sourceText: 'He actually won',
        language: 'en',
        translatedText: '他竟然赢了',
        meaning: '结果反转字幕。',
        textType: 'subtitle',
        startTime: 3.2,
        endTime: 5.0,
        confidence: 0.9,
        frameEvidence: ['t3.2'],
        warnings: [],
      }],
      warnings: [],
    },
    explanationPlan: {
      assetId: 'foreign',
      visualSummary: '外文短视频反转。',
      visualTextSummary: 'He actually won',
      audioSummary: '保留原声反应。',
      audienceNeedsExplanation: 'humor_or_twist',
      explanationReason: '外文反转字幕需要简短中文提示。',
      keyPoint: '反转结果',
      setup: '前文铺垫',
      payoffOrResult: '竟然赢了',
      humorOrConflict: '结果出人意料',
      confidence: 0.9,
      visualEvidenceUsed: ['反转瞬间'],
      visualTextEvidenceUsed: ['He actually won'],
      audioEvidenceUsed: ['结尾反应声'],
      contextEvidenceUsed: [],
      inference: ['建议一条轻字幕'],
      warnings: [],
    },
  });
  const analysis = baseAnalysis(
    [selfAsset, foreignAsset],
    [
      shot('s1', 'self', { outSec: 2, durationSec: 2, audioMode: 'mute' }),
      shot('s2', 'foreign', { outSec: 6, durationSec: 6 }),
    ],
    {
      lightCaptionPlan: [{
        captionId: 'cap-foreign',
        assetId: 'foreign',
        startTime: 3.2,
        endTime: 5.0,
        text: '他竟然赢了',
        purpose: 'twist',
        basedOn: 'visualText+audio reaction',
        confidence: 0.9,
        reviewRequired: false,
        warnings: [],
      }],
      markers: [],
    },
  );
  assert.doesNotThrow(() => validateVideoAnalysis(
    analysis,
    baseManifest([selfItem, foreignItem]),
  ));
  assert.equal(collectFcpTitles(analysis).length, 0);
  assert.equal(analysis.timeline.markers.length, 0);
  const xml = buildFcpxml({
    projectName: 'stage5c',
    analysis,
    assetMappings: [
      {
        assetId: 'self',
        type: 'image',
        projectFilename: 'self.jpg',
        projectAbsolutePath: '/tmp/self.jpg',
        projectStableId: 'p1',
        sourceSha256: 'c'.repeat(64),
        metadata: selfItem.metadata,
      },
      {
        assetId: 'foreign',
        type: 'video',
        projectFilename: 'foreign.mp4',
        projectAbsolutePath: '/tmp/foreign.mp4',
        projectStableId: 'p2',
        sourceSha256: 'd'.repeat(64),
        metadata: foreignItem.metadata,
      },
    ],
  });
  assert.equal((xml.match(/<title\b/g) || []).length, 0);
  assert.equal((xml.match(/<marker\b/g) || []).length, 0);
  assert.doesNotMatch(xml, /subtitle|caption-track/i);
});

test('视频默认完整保留与原声；无理由极短区间与越界裁剪被拒绝', () => {
  const item = videoItem('keep_vid', 12);
  const asset = videoAsset('keep_vid', {
    ranges: [{ startSec: 0, endSec: 12, confidence: 0.9, reviewRequired: false }],
    audioAnalysis: buildDefaultAudioAnalysis(item),
    videoPreservationPlan: buildDefaultVideoPreservationPlan(item),
  });
  assert.equal(asset.videoPreservationPlan.preserveFullClip, true);
  assert.equal(asset.audioAnalysis.preserveOriginalAudio, true);
  assert.doesNotThrow(() => validateVideoAnalysis(
    baseAnalysis([asset], [shot('s1', 'keep_vid', { outSec: 12, durationSec: 12 })]),
    baseManifest([item]),
  ));

  const short = structuredClone(asset);
  short.videoPreservationPlan = {
    ...asset.videoPreservationPlan,
    preserveFullClip: false,
    proposedIn: 0,
    proposedOut: 1.2,
    selectedDuration: 1.2,
    keepRatio: 0.1,
    trimReason: null,
    protectedTimeRanges: [{ startSec: 4, endSec: 6 }],
    subtitleTimeRanges: [{ startSec: 4.1, endSec: 5.8 }],
  };
  assert.throws(
    () => validateVideoAnalysis(
      baseAnalysis([short], [shot('s1', 'keep_vid', { outSec: 1.2, durationSec: 1.2 })]),
      baseManifest([item]),
    ),
    /trimReason|极短|受保护/,
  );

  const trimmedOk = structuredClone(asset);
  trimmedOk.videoPreservationPlan = {
    ...asset.videoPreservationPlan,
    preserveFullClip: false,
    proposedIn: 1,
    proposedOut: 11,
    selectedDuration: 10,
    keepRatio: 10 / 12,
    trimReason: 'irrelevant_intro: 片头黑场',
    protectedTimeRanges: [{ startSec: 4, endSec: 6 }],
    subtitleTimeRanges: [{ startSec: 4.1, endSec: 5.8 }],
    audioCriticalTimeRanges: [{ startSec: 5, endSec: 6 }],
  };
  assert.doesNotThrow(() => validateVideoAnalysis(
    baseAnalysis([trimmedOk], [shot('s1', 'keep_vid', { inSec: 1, outSec: 11, durationSec: 10 })]),
    baseManifest([item]),
  ));

  const cutsProtected = structuredClone(trimmedOk);
  cutsProtected.videoPreservationPlan.proposedOut = 4.5;
  cutsProtected.videoPreservationPlan.selectedDuration = 3.5;
  cutsProtected.videoPreservationPlan.keepRatio = 3.5 / 12;
  assert.throws(
    () => validateVideoAnalysis(
      baseAnalysis(
        [cutsProtected],
        [shot('s1', 'keep_vid', { inSec: 1, outSec: 4.5, durationSec: 3.5 })],
      ),
      baseManifest([item]),
    ),
    /受保护/,
  );
});

test('原声在 FCPXML 中保持启用；无 muteReason 静音被拒绝；无音频流可合法标记', () => {
  const withAudio = videoItem('aud_on', 5, { hasAudio: true });
  const noAudio = videoItem('aud_off', 5, { hasAudio: false });
  const onAsset = videoAsset('aud_on', {
    ranges: [{ startSec: 0, endSec: 5, confidence: 0.9, reviewRequired: false }],
    audioAnalysis: buildDefaultAudioAnalysis(withAudio),
    videoPreservationPlan: buildDefaultVideoPreservationPlan(withAudio),
  });
  const offAsset = videoAsset('aud_off', {
    ranges: [{ startSec: 0, endSec: 5, confidence: 0.9, reviewRequired: false }],
    audioAnalysis: buildDefaultAudioAnalysis(noAudio),
    videoPreservationPlan: buildDefaultVideoPreservationPlan(noAudio),
  });
  assert.equal(offAsset.audioAnalysis.audioAvailable, false);
  assert.equal(offAsset.audioAnalysis.muteReason, 'no_audio_stream');

  const mutedNoReason = structuredClone(onAsset);
  mutedNoReason.audioAnalysis = {
    ...onAsset.audioAnalysis,
    audioEnabled: false,
    preserveOriginalAudio: false,
    muteReason: null,
  };
  assert.throws(
    () => validateVideoAnalysis(
      baseAnalysis(
        [mutedNoReason],
        [shot('s1', 'aud_on', { outSec: 5, durationSec: 5, audioMode: 'mute' })],
      ),
      baseManifest([withAudio]),
    ),
    /muteReason/,
  );

  const keepAnalysis = baseAnalysis(
    [onAsset, offAsset],
    [
      shot('s1', 'aud_on', { outSec: 5, durationSec: 5, audioMode: 'keep' }),
      shot('s2', 'aud_off', { outSec: 5, durationSec: 5, audioMode: 'mute' }),
    ],
  );
  assert.doesNotThrow(() => validateVideoAnalysis(
    keepAnalysis,
    baseManifest([withAudio, noAudio]),
  ));
  assert.equal(fcpxmlShouldMuteShot(
    keepAnalysis.timeline.shots[0],
    onAsset,
    { type: 'video', metadata: withAudio.metadata },
  ), false);
  const xml = buildFcpxml({
    projectName: 'audio-keep',
    analysis: keepAnalysis,
    assetMappings: [
      {
        assetId: 'aud_on',
        type: 'video',
        projectFilename: 'aud_on.mp4',
        projectAbsolutePath: '/tmp/aud_on.mp4',
        projectStableId: 'a1',
        sourceSha256: 'e'.repeat(64),
        metadata: withAudio.metadata,
      },
      {
        assetId: 'aud_off',
        type: 'video',
        projectFilename: 'aud_off.mp4',
        projectAbsolutePath: '/tmp/aud_off.mp4',
        projectStableId: 'a2',
        sourceSha256: 'f'.repeat(64),
        metadata: noAudio.metadata,
      },
    ],
  });
  assert.doesNotMatch(xml, /adjust-volume amount="-96dB"/);
  assert.match(xml, /audioRole="dialogue"/);
});

test('图片不生成音频或视频时间字段；目标时长冲突优先报告', () => {
  const image = imageItem('still');
  const video = videoItem('long_vid', 40);
  const imageAst = imageAsset('still', {
    visualTextAnalysis: {
      items: [{
        sourceText: 'DONE',
        language: 'en',
        translatedText: '完成',
        meaning: '结果标签',
        textType: 'label',
        startTime: 1,
        endTime: 2,
        confidence: 0.8,
        frameEvidence: [],
        warnings: [],
      }],
      warnings: [],
    },
  });
  assert.throws(
    () => validateVideoAnalysis(
      baseAnalysis(
        [imageAst],
        [shot('s1', 'still', { outSec: 2, durationSec: 2, audioMode: 'mute' })],
      ),
      baseManifest([image]),
    ),
    /图片不得返回视频时间范围/,
  );

  const videoAst = videoAsset('long_vid', {
    ranges: [{ startSec: 0, endSec: 40, confidence: 0.9, reviewRequired: false }],
    audioAnalysis: buildDefaultAudioAnalysis(video),
    videoPreservationPlan: buildDefaultVideoPreservationPlan(video),
  });
  const overlong = baseAnalysis(
    [videoAst],
    [shot('s1', 'long_vid', { outSec: 40, durationSec: 40 })],
    {
      durationPolicy: {
        minSec: 15,
        maxSec: 20,
        source: 'test',
        rationale: '短演示策略',
      },
    },
  );
  assert.throws(
    () => validateVideoAnalysis(overlong, baseManifest([video], {
      narrative: {
        enforceChapterValidation: false,
        durationPolicy: overlong.timeline.durationPolicy,
      },
    })),
    /优先报告冲突|没有明确解释/,
  );
  overlong.timeline.durationException = '完整保留反转过程导致总时长超出短演示策略，优先保留内容完整性。';
  assert.doesNotThrow(() => validateVideoAnalysis(overlong, baseManifest([video], {
    narrative: {
      enforceChapterValidation: false,
      durationPolicy: overlong.timeline.durationPolicy,
    },
  })));
});

test('普通非 HotIngest 项目与旧 analysis 兼容；WebM 仍拦截', () => {
  const plainVideo = videoItem('plain', 4);
  const plainImage = imageItem('plain_img');
  const oldAnalysis = {
    schemaVersion: 1,
    theme: {
      summary: '旧协议兼容',
      rationale: '没有 Stage 5C 字段也应通过。',
      confidence: 0.8,
      folderNameConflict: false,
    },
    titles: {
      candidates: ['旧协议兼容', '普通项目仍可用'],
      recommended: '旧协议兼容',
      rationale: '无 sidecar。',
    },
    assets: [
      {
        assetId: 'plain',
        type: 'video',
        semanticLabels: ['过程'],
        contentSummary: '普通录屏。',
        suggestedUse: ['过程'],
        status: 'adopt',
        reason: '唯一视频。',
        ranges: [{ startSec: 0, endSec: 4, confidence: 0.8, reviewRequired: false }],
        confidence: 0.8,
      },
      {
        assetId: 'plain_img',
        type: 'image',
        semanticLabels: ['结果'],
        contentSummary: '普通截图。',
        suggestedUse: ['结果'],
        status: 'adopt',
        reason: '收尾。',
        ranges: [],
        confidence: 0.9,
      },
    ],
    timeline: {
      shots: [
        shot('s1', 'plain', { outSec: 4, durationSec: 4 }),
        shot('s2', 'plain_img', { outSec: 2, durationSec: 2, audioMode: 'mute' }),
      ],
      markers: [],
    },
  };
  assert.doesNotThrow(() => validateVideoAnalysis(
    oldAnalysis,
    baseManifest([plainVideo, plainImage]),
  ));

  const webm = {
    ...plainVideo,
    assetId: 'bad_webm',
    filename: 'bad_webm.webm',
    relativePath: 'bad_webm.webm',
    extension: 'webm',
  };
  const webmAnalysis = structuredClone(oldAnalysis);
  webmAnalysis.assets[0].assetId = 'bad_webm';
  webmAnalysis.timeline.shots[0].assetId = 'bad_webm';
  assert.throws(
    () => validateVideoAnalysis(
      webmAnalysis,
      baseManifest([webm, plainImage]),
    ),
    /webm/i,
  );
});

test('visualExplanationSummary 统计可生成；FCPXML 结构仍有效', () => {
  const video = videoItem('sum_vid', 5);
  const image = imageItem('sum_img');
  const assets = [
    videoAsset('sum_vid', {
      ranges: [{ startSec: 0, endSec: 5, confidence: 0.9, reviewRequired: false }],
      audioAnalysis: buildDefaultAudioAnalysis(video),
      videoPreservationPlan: buildDefaultVideoPreservationPlan(video),
      visualTextAnalysis: {
        items: [{
          sourceText: 'Wow',
          language: 'en',
          translatedText: '哇',
          meaning: '惊叹',
          textType: 'subtitle',
          startTime: 1,
          endTime: 2,
          confidence: 0.8,
          frameEvidence: ['t1'],
          warnings: [],
        }],
        warnings: [],
      },
      explanationPlan: {
        assetId: 'sum_vid',
        visualSummary: '短视频',
        audienceNeedsExplanation: 'translate_on_screen_text',
        explanationReason: '外文',
        keyPoint: '惊叹',
        confidence: 0.8,
        visualEvidenceUsed: ['表情'],
        visualTextEvidenceUsed: ['Wow'],
        audioEvidenceUsed: [],
        contextEvidenceUsed: [],
        inference: ['建议字幕'],
        warnings: [],
      },
    }),
    imageAsset('sum_img', {
      explanationPlan: {
        assetId: 'sum_img',
        visualSummary: '结果图',
        audienceNeedsExplanation: 'none',
        explanationReason: '自解释',
        keyPoint: '结果',
        confidence: 0.95,
        visualEvidenceUsed: ['结果'],
        visualTextEvidenceUsed: [],
        audioEvidenceUsed: [],
        contextEvidenceUsed: [],
        inference: ['无需字幕'],
        warnings: [],
      },
    }),
  ];
  const analysis = baseAnalysis(
    assets,
    [
      shot('s1', 'sum_vid', { outSec: 5, durationSec: 5 }),
      shot('s2', 'sum_img', { outSec: 2, durationSec: 2, audioMode: 'mute' }),
    ],
    {
      lightCaptionPlan: [{
        captionId: 'c1',
        assetId: 'sum_vid',
        startTime: 1,
        endTime: 2,
        text: '哇',
        purpose: 'translate',
        basedOn: 'OCR',
        confidence: 0.8,
        reviewRequired: false,
        warnings: [],
      }],
    },
  );
  const summary = summarizeVisualExplanation(analysis, baseManifest([video, image]));
  assert.equal(summary.assetsWithVisualText, 1);
  assert.equal(summary.assetsWithLightCaptions, 1);
  assert.equal(summary.assetsWithoutCaptions, 1);
  assert.equal(summary.videosPreservedFull, 1);
  assert.equal(summary.videosPreserveOriginalAudio, 1);
  analysis.visualExplanationSummary = summary;
  assert.doesNotThrow(() => validateVideoAnalysis(analysis, baseManifest([video, image])));
  const xml = buildFcpxml({
    projectName: 'summary',
    analysis,
    assetMappings: [
      {
        assetId: 'sum_vid',
        type: 'video',
        projectFilename: 'sum_vid.mp4',
        projectAbsolutePath: '/tmp/sum_vid.mp4',
        projectStableId: 's1',
        sourceSha256: '1'.repeat(64),
        metadata: video.metadata,
      },
      {
        assetId: 'sum_img',
        type: 'image',
        projectFilename: 'sum_img.jpg',
        projectAbsolutePath: '/tmp/sum_img.jpg',
        projectStableId: 's2',
        sourceSha256: '2'.repeat(64),
        metadata: image.metadata,
      },
    ],
  });
  const report = validateFcpxmlStructure(xml, { assetCount: 2, shotCount: 2, markerCount: 0 });
  assert.equal(report.ok, true, report.errors.join('；'));
});

test('Stage 5C 分析请求预算字段写入 prepare 产物约定常量', async () => {
  const { ANALYSIS_BUDGET } = require('../src/services/visual-explanation-service');
  assert.equal(ANALYSIS_BUDGET.maxVisualTextItemsPerAsset, 40);
  assert.equal(ANALYSIS_BUDGET.maxLightCaptionsPerStoryUnit, 8);
  assert.equal(ANALYSIS_BUDGET.maxSceneFrames, 12);
  // Touch tmp to keep async test harness happy without writing HotIngest.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stage5c-budget-'));
  await fs.writeFile(path.join(dir, 'ok.txt'), 'ok\n');
  assert.equal(await fs.readFile(path.join(dir, 'ok.txt'), 'utf8'), 'ok\n');
});
