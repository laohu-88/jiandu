'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BASIC_TITLE_STYLE,
  buildFcpxml,
  extractManagedCaptionTitles,
  validateFcpxmlStructure,
} = require('../src/services/fcpxml-service');
const {
  buildManagedCaptionTitlesFromAnalysis,
  DEFAULT_CAPTION_FONT_SIZE,
  planLightCaptionExport,
  summarizeLightCaptionExport,
} = require('../src/services/light-caption-export-service');
const { validateRequiredLightCaptions } = require('../src/services/editing-contract-service');
const { inspectedNoneCleanup } = require('../src/services/source-cleanup-service');

function mapping(assetId, type = 'video') {
  return {
    assetId,
    type,
    projectFilename: `${assetId}.${type === 'image' ? 'jpg' : 'mp4'}`,
    projectAbsolutePath: `/tmp/${assetId}.${type === 'image' ? 'jpg' : 'mp4'}`,
    projectStableId: `p-${assetId}`,
    sourceSha256: assetId.padEnd(64, '0').slice(0, 64),
    metadata: type === 'video'
      ? {
        durationSec: 12, width: 1280, height: 720, frameRate: 30,
        hasAudio: true, audioChannels: 1, sampleRate: 48000,
      }
      : { width: 1280, height: 720, hasAudio: false },
  };
}

function analysisWithCaptions(overrides = {}) {
  return {
    schemaVersion: 1,
    titles: { recommended: '字幕交付' },
    assets: overrides.assets || [
      {
        assetId: 'keep_en',
        type: 'video',
        status: 'adopt',
        reason: '外文片段',
        cleanup: inspectedNoneCleanup({ inspectedFrames: ['start.jpg'] }),
        explanationPlan: { audienceNeedsExplanation: 'translate_on_screen_text' },
      },
      {
        assetId: 'omit_en',
        type: 'video',
        status: 'reject',
        reason: '烧录覆盖物压在主体上，无法高质量净化，不使用该素材。',
        cleanup: {
          ...inspectedNoneCleanup({ inspectedFrames: ['start.jpg'] }),
          decision: 'omit',
          overlayTypes: ['foreign_title'],
          rationale: '覆盖物压在主体上，omit。',
          method: 'omit',
          provider: 'none',
        },
      },
      {
        assetId: 'crop_en',
        type: 'video',
        status: 'adopt',
        reason: '边缘标题可裁',
        cleanup: {
          decision: 'crop_reframe',
          overlayTypes: ['foreign_title'],
          rationale: '顶部标题裁出画面。',
          method: 'fcpxml_crop',
          provider: 'fcpxml',
          zones: [{ x: 0, y: 0, width: 1, height: 0.2 }],
          inspectedFrames: ['start.jpg'],
          reviewRequired: false,
          warnings: [],
        },
        explanationPlan: { audienceNeedsExplanation: 'humor_or_twist' },
      },
    ],
    lightCaptionPlan: overrides.lightCaptionPlan || [
      {
        captionId: 'cap-keep',
        assetId: 'keep_en',
        text: '猫终于接受主人的朋友了',
        startTime: 0,
        endTime: 5,
        purpose: 'translate',
        basedOn: 'HotIngest 中文翻译',
        confidence: 0.9,
        reviewRequired: false,
        warnings: [],
      },
      {
        captionId: 'cap-keep-2',
        assetId: 'keep_en',
        text: '下一秒又开始任性了',
        startTime: 8,
        endTime: 12,
        purpose: 'translate',
        basedOn: 'HotIngest 中文翻译',
        confidence: 0.9,
        reviewRequired: false,
        warnings: [],
      },
      {
        captionId: 'cap-omit',
        assetId: 'omit_en',
        text: '整篇 HTML 不该出现',
        startTime: 0,
        endTime: 10,
        purpose: 'translate',
        basedOn: '不应导出',
        confidence: 0.9,
        reviewRequired: false,
        warnings: [],
      },
      {
        captionId: 'cap-crop',
        assetId: 'crop_en',
        text: '顶部大标题已裁走',
        startTime: 0,
        endTime: 6,
        purpose: 'humor',
        basedOn: 'HotIngest 中文翻译',
        confidence: 0.9,
        reviewRequired: false,
        warnings: [],
      },
    ],
    timeline: {
      orientation: overrides.orientation || 'vertical',
      width: overrides.width || 1080,
      height: overrides.height || 1920,
      fps: 30,
      shots: overrides.shots || [
        {
          id: 'shot-keep', assetId: 'keep_en', inSec: 0, outSec: 12, durationSec: 12,
          fitMode: 'contain', audioMode: 'keep',
        },
        {
          id: 'shot-crop', assetId: 'crop_en', inSec: 0, outSec: 6, durationSec: 6,
          fitMode: 'cover', audioMode: 'keep',
          layout: {
            mode: 'center_crop',
            scale: 1.12,
            position: { x: 0, y: 0.04 },
            crop: { left: 0, top: 0.2, right: 0, bottom: 0.16 },
          },
        },
      ],
      markers: overrides.markers || [
        {
          timeSec: 0,
          text: '猫终于接受主人的朋友了',
          subtitle: {
            enabled: true,
            renderAsFcpTitle: true,
            text: '猫终于接受主人的朋友了',
            durationSec: 3,
            position: 'bottom-safe',
          },
        },
      ],
    },
  };
}

function xmlFor(analysis, extraMappings = []) {
  const ids = [...new Set(analysis.timeline.shots.map((shot) => shot.assetId))];
  const assetMappings = ids.map((id) => {
    const found = extraMappings.find((item) => item.assetId === id);
    if (found) return found;
    return mapping(id, id.includes('img') ? 'image' : 'video');
  });
  return buildFcpxml({
    projectName: '字幕交付测试',
    analysis,
    assetMappings,
  });
}

test('analysis 有字幕时 build 必须产生对应 FCP Title，且不依赖 Marker.subtitle', () => {
  const analysis = analysisWithCaptions();
  const xml = xmlFor(analysis);
  const titles = extractManagedCaptionTitles(xml);
  assert.equal(titles.length, 3);
  assert.ok(titles.some((item) => item.text === '猫终于接受主人的朋友了'));
  assert.ok(titles.some((item) => item.text === '下一秒又开始任性了'));
  assert.ok(titles.some((item) => item.text === '顶部大标题已裁走'));
  assert.equal((xml.match(/<title\b/g) || []).length, 3);
  const report = validateFcpxmlStructure(xml, {
    shotCount: 2,
    assetCount: 2,
    markerCount: 1,
    titleCount: 3,
    width: 1080,
    height: 1920,
    fps: 30,
  });
  assert.equal(report.ok, true, report.errors.join('；'));
  assert.equal(report.version, '1.14');
});

test('外文 shot 缺字幕时不能静默 PASS', () => {
  const analysis = analysisWithCaptions({
    lightCaptionPlan: [],
  });
  const errors = [];
  validateRequiredLightCaptions(analysis, {
    items: [
      { assetId: 'keep_en', type: 'video', filename: 'keep.mp4', context: { translation: '中文' } },
      { assetId: 'omit_en', type: 'video', filename: 'omit.mp4' },
      { assetId: 'crop_en', type: 'video', filename: 'crop.mp4', context: { translation: '中文' } },
    ],
  }, errors);
  assert.ok(errors.some((item) => /应生成轻字幕/.test(item)));
  assert.ok(errors.join('；').includes('keep_en'));
  assert.ok(errors.join('；').includes('crop_en'));
  assert.ok(!errors.join('；').includes('omit_en'));
});

test('omit 后不生成孤立字幕', () => {
  const planned = planLightCaptionExport({ analysis: analysisWithCaptions() });
  assert.equal(planned.titles.some((item) => item.assetId === 'omit_en'), false);
  assert.ok(planned.skipped.some((item) => item.assetId === 'omit_en' && item.reason === 'omitted'));
  const xml = xmlFor(analysisWithCaptions());
  assert.doesNotMatch(xml, /整篇 HTML 不该出现/);
  const summary = summarizeLightCaptionExport({
    analysis: analysisWithCaptions(),
    actualTitles: extractManagedCaptionTitles(xml),
  });
  assert.equal(summary.complete, true);
  assert.equal(summary.orphans.length, 0);
});

test('revision 换片段后仍保留未 omit 字幕，并丢弃被去掉的镜头字幕', () => {
  const original = analysisWithCaptions();
  const first = buildManagedCaptionTitlesFromAnalysis({ analysis: original });
  assert.equal(first.length, 3);
  const revised = analysisWithCaptions({
    shots: [
      {
        id: 'shot-keep', assetId: 'keep_en', inSec: 8, outSec: 12, durationSec: 4,
        fitMode: 'contain', audioMode: 'keep',
      },
    ],
  });
  const second = buildManagedCaptionTitlesFromAnalysis({ analysis: revised });
  assert.equal(second.length, 1);
  assert.equal(second[0].captionId, 'cap-keep-2');
  assert.equal(second[0].text, '下一秒又开始任性了');
  assert.ok(!second.some((item) => item.captionId === 'cap-omit'));
  const xml = xmlFor(revised);
  assert.match(xml, /下一秒又开始任性了/);
  assert.doesNotMatch(xml, /顶部大标题已裁走/);
});

test('douyin variant 在未显式传入 managedCaptionTitles 时也能从 lightCaptionPlan 生成 Title', () => {
  const analysis = {
    titles: { recommended: '抖音竖屏' },
    lightCaptionPlan: [{
      captionId: 'cap-mobile',
      assetId: 'vertical-video',
      text: '这是移动端操作入口',
      startTime: 0.3,
      endTime: 2,
      purpose: 'clarify',
      basedOn: 'HotIngest 翻译',
    }],
    timeline: {
      orientation: 'vertical',
      width: 1080,
      height: 1920,
      fps: 30,
      shots: [{
        id: 'douyin-1-shot-1',
        assetId: 'vertical-video',
        inSec: 0,
        outSec: 3,
        durationSec: 3,
        fitMode: 'contain',
        audioMode: 'keep',
      }],
      markers: [],
    },
  };
  const xml = buildFcpxml({
    projectName: '抖音变体字幕',
    analysis,
    assetMappings: [mapping('vertical-video')],
  });
  assert.match(xml, /这是移动端操作入口/);
  assert.match(xml, /<param name="位置"[^>]*value="0 -620"\/>/);
  assert.equal(extractManagedCaptionTitles(xml).length, 1);
});

test('cleanup/reframe 后字幕仍映射到原素材 shot，且留在画面中下方', () => {
  const analysis = analysisWithCaptions({
    shots: [{
      id: 'shot-crop',
      assetId: 'crop_en__clean_abc',
      sourceAssetId: 'crop_en',
      inSec: 0,
      outSec: 6,
      durationSec: 6,
      fitMode: 'cover',
      audioMode: 'keep',
      layout: {
        mode: 'center_crop',
        scale: 1.2,
        position: { x: 0, y: -0.05 },
        crop: { left: 0, top: 0.22, right: 0, bottom: 0.18 },
      },
    }],
    lightCaptionPlan: [{
      captionId: 'cap-crop',
      assetId: 'crop_en',
      text: '顶部大标题已裁走',
      startTime: 0,
      endTime: 6,
      purpose: 'humor',
      basedOn: 'HotIngest 中文翻译',
    }],
    markers: [],
  });
  const titles = buildManagedCaptionTitlesFromAnalysis({ analysis });
  assert.equal(titles.length, 1);
  assert.equal(titles[0].matchedShotId, 'shot-crop');
  assert.equal(titles[0].position, 'bottom-safe');
  assert.deepEqual(titles[0].transform, { x: 0, y: -620 });
  const xml = xmlFor(analysis, [mapping('crop_en__clean_abc')]);
  assert.match(xml, /顶部大标题已裁走/);
  assert.match(xml, /<param name="位置"[^>]*value="0 -620"\/>/);
  assert.match(xml, /<adjust-crop/);
});

test('FCP Title 保持当前默认 3D文本/表面/外框/光晕/投影，且不烧录', () => {
  const xml = xmlFor(analysisWithCaptions({ markers: [] }));
  assert.match(xml, /<param name="展平"[^>]*value="0"\/>/);
  assert.match(xml, /strokeColor="0 0 0 0\.9" strokeWidth="-4"/);
  assert.match(xml, /shadowColor="0 0 0 0\.85" shadowOffset="0 -6" shadowBlurRadius="12"/);
  assert.match(xml, new RegExp(`fontSize="${DEFAULT_CAPTION_FONT_SIZE}"`));
  assert.doesNotMatch(xml, /<param name="(?:3D文本|表面|外框|光晕|投影)"/);
  assert.deepEqual(BASIC_TITLE_STYLE, {
    threeDText: true,
    surface: true,
    outline: true,
    glow: true,
    dropShadow: true,
  });
  assert.doesNotMatch(xml, /burn|srt|caption-track/i);
});

test('人工 not_needed 不导出；edited_approved 覆盖原文且不改其他字幕', () => {
  const analysis = analysisWithCaptions({ markers: [] });
  const editorialReview = {
    reviews: {
      keep_en: {
        assetId: 'keep_en',
        captions: {
          'cap-keep': {
            captionId: 'cap-keep',
            reviewStatus: 'edited_approved',
            approvedText: '猫终于接受了客人',
            approvedStartTime: 0,
            approvedEndTime: 4,
          },
          'cap-keep-2': {
            captionId: 'cap-keep-2',
            reviewStatus: 'not_needed',
          },
        },
      },
    },
  };
  const titles = buildManagedCaptionTitlesFromAnalysis({ analysis, editorialReview });
  assert.equal(titles.some((item) => item.captionId === 'cap-keep-2'), false);
  const edited = titles.find((item) => item.captionId === 'cap-keep');
  assert.equal(edited.text, '猫终于接受了客人');
  assert.equal(edited.durationSec, 4);
  assert.ok(titles.some((item) => item.captionId === 'cap-crop'));
});

test('横屏字幕落在中下方安全区', () => {
  const analysis = analysisWithCaptions({
    orientation: 'horizontal',
    width: 1920,
    height: 1080,
    markers: [],
  });
  const xml = xmlFor(analysis);
  assert.match(xml, /<param name="位置"[^>]*value="0 -360"\/>/);
});
