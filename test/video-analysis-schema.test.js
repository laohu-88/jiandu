const test = require('node:test');
const assert = require('node:assert/strict');

const { validateVideoAnalysis } = require('../src/services/video-analysis-schema');

const manifest = {
  items: [
    { assetId: 'media-video', type: 'video', metadata: { durationSec: 8 } },
    { assetId: 'media-image', type: 'image', metadata: { durationSec: null } },
  ],
};

function validAnalysis() {
  return {
    schemaVersion: 1,
    theme: {
      summary: '从操作过程到最终结果',
      rationale: '视频显示操作，截图显示结果。',
      confidence: 0.9,
      folderNameConflict: true,
    },
    titles: {
      candidates: ['把功能真正跑通', '从操作到结果'],
      recommended: '从操作到结果',
      rationale: '同时对应过程和结果画面。',
    },
    assets: [
      {
        assetId: 'media-video',
        type: 'video',
        semanticLabels: ['操作过程'],
        contentSummary: '录屏显示设置操作。',
        suggestedUse: ['过程'],
        status: 'adopt',
        reason: '过程清楚。',
        ranges: [{ startSec: 1, endSec: 5, confidence: 0.8, reviewRequired: false }],
        confidence: 0.8,
      },
      {
        assetId: 'media-image',
        type: 'image',
        semanticLabels: ['最终结果'],
        contentSummary: '截图显示最终页面。',
        suggestedUse: ['结果'],
        status: 'adopt',
        reason: '结果明确。',
        ranges: [],
        confidence: 0.95,
      },
    ],
    timeline: {
      orientation: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 30,
      shots: [
        {
          id: 'shot-1', assetId: 'media-video', inSec: 1, outSec: 4,
          durationSec: 3, fitMode: 'contain', audioMode: 'keep',
          purpose: '显示操作', confidence: 0.8, reviewRequired: false,
        },
        {
          id: 'shot-2', assetId: 'media-image', inSec: 0, outSec: 2,
          durationSec: 2, fitMode: 'contain', audioMode: 'mute',
          purpose: '显示结果', confidence: 0.95, reviewRequired: false,
        },
      ],
      markers: [{ timeSec: 3.5, text: '结果确认' }],
    },
  };
}

test('Codex 视频分析协议接受完整无口播镜头方案', () => {
  const analysis = validAnalysis();
  assert.equal(validateVideoAnalysis(analysis, manifest), analysis);
});

test('协议接受可选轻字幕扩展且旧 Marker 保持兼容', () => {
  const analysis = validAnalysis();
  analysis.timeline.markers[0] = {
    id: 'marker-result',
    timeSec: 3.5,
    text: '结果确认',
    type: 'light-subtitle',
    subtitle: {
      enabled: true,
      text: '结果已写入本地',
      durationSec: 1.8,
      position: 'bottom-safe',
      purpose: '解释最终结果',
      renderAsFcpTitle: true,
    },
  };
  assert.equal(validateVideoAnalysis(analysis, manifest), analysis);
  delete analysis.timeline.markers[0].subtitle;
  assert.equal(validateVideoAnalysis(analysis, manifest), analysis);
});

test('协议拒绝超过两行、重复 ID 和无效位置的轻字幕扩展', () => {
  const analysis = validAnalysis();
  analysis.timeline.markers = [
    {
      id: 'duplicate', timeSec: 1, text: 'A', type: 'light-subtitle',
      subtitle: {
        enabled: true, text: '三行\n字幕\n不行', durationSec: 2, position: 'floating',
        purpose: '测试', renderAsFcpTitle: true,
      },
    },
    { id: 'duplicate', timeSec: 2, text: 'B' },
  ];
  assert.throws(
    () => validateVideoAnalysis(analysis, manifest),
    (error) => error.details.some((message) => /最多两行/.test(message))
      && error.details.some((message) => /position 无效/.test(message))
      && error.details.some((message) => /id 重复/.test(message)),
  );
});

test('协议允许省略格式字段，交由构建阶段按主要素材解析默认值', () => {
  const analysis = validAnalysis();
  delete analysis.timeline.orientation;
  delete analysis.timeline.width;
  delete analysis.timeline.height;
  delete analysis.timeline.fps;
  assert.equal(validateVideoAnalysis(analysis, manifest), analysis);
});

test('协议拒绝越过真实视频时长的有效区间', () => {
  const analysis = validAnalysis();
  analysis.assets[0].ranges[0].endSec = 9;
  assert.throws(
    () => validateVideoAnalysis(analysis, manifest),
    (error) => error.code === 'INVALID_VIDEO_ANALYSIS'
      && error.details.some((message) => /超出视频时长/.test(message)),
  );
});

test('协议拒绝时间线引用已淘汰素材', () => {
  const analysis = validAnalysis();
  analysis.assets[0].status = 'reject';
  assert.throws(
    () => validateVideoAnalysis(analysis, manifest),
    (error) => error.details.some((message) => /已淘汰素材/.test(message)),
  );
});

test('协议拒绝时间线直接引用 Final Cut Pro 不支持的 WebM 素材', () => {
  const analysis = validAnalysis();
  manifest.items[0].extension = 'webm';
  try {
    assert.throws(
      () => validateVideoAnalysis(analysis, manifest),
      (error) => error.details.some((message) => /Final Cut Pro 不支持的 \.webm/.test(message)),
    );
  } finally {
    delete manifest.items[0].extension;
  }
});

test('协议要求建议标题来自候选并限制 marker 范围', () => {
  const analysis = validAnalysis();
  analysis.titles.recommended = '不存在的候选';
  analysis.timeline.markers[0].timeSec = 99;
  assert.throws(
    () => validateVideoAnalysis(analysis, manifest),
    (error) => error.details.some((message) => /必须来自/.test(message))
      && error.details.some((message) => /时间线范围/.test(message)),
  );
});
