const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assetUid,
  buildFcpxml,
  fcpTime,
  validateFcpxmlStructure,
} = require('../src/services/fcpxml-service');

const analysis = {
  titles: { recommended: '中文 标题' },
  timeline: {
    orientation: 'horizontal',
    width: 1920,
    height: 1080,
    fps: 30,
    shots: [
      {
        id: 'shot-video', assetId: 'video', inSec: 0.5, outSec: 2.5,
        durationSec: 2, fitMode: 'contain', audioMode: 'keep',
      },
      {
        id: 'shot-image', assetId: 'image', inSec: 0, outSec: 1.5,
        durationSec: 1.5, fitMode: 'cover', audioMode: 'mute',
      },
    ],
    markers: [
      { timeSec: 0.25, text: '开始调整' },
      { timeSec: 2.25, text: '完成' },
    ],
  },
};

const mappings = [
  {
    assetId: 'video', type: 'video', projectFilename: '屏幕 录制.mov',
    projectAbsolutePath: '/tmp/中文 路径/屏幕 录制.mov',
    projectStableId: 'asset_project_video',
    sourceSha256: 'a'.repeat(64),
    metadata: {
      durationSec: 4, width: 1280, height: 720, frameRate: 30,
      hasAudio: true, audioChannels: 1, sampleRate: 48000,
    },
  },
  {
    assetId: 'image', type: 'image', projectFilename: '结果 & 对比.png',
    projectAbsolutePath: '/tmp/中文 路径/结果 & 对比.png',
    projectStableId: 'asset_project_image',
    sourceSha256: 'b'.repeat(64),
    metadata: { width: 1280, height: 720, hasAudio: false },
  },
];

test('FCP 时间使用有理数并保持 30fps 精度', () => {
  assert.equal(fcpTime(0), '0s');
  assert.equal(fcpTime(1 / 30), '1/30s');
  assert.equal(fcpTime(1.5), '3/2s');
});

test('FCPXML 真实素材按内容复用，HyperFrames 素材按项目隔离旧媒体', () => {
  assert.equal(
    assetUid(mappings[0]),
    `com.openai.video-cut-planner.asset.${'a'.repeat(64)}`,
  );
  assert.notEqual(assetUid(mappings[0]), assetUid(mappings[1]));
  assert.equal(assetUid(mappings[0]), assetUid({ ...mappings[0], projectAbsolutePath: '/tmp/copy.mov' }));
  assert.equal(assetUid(mappings[0]), assetUid({ ...mappings[0], projectStableId: 'asset_other_project' }));

  const generated = { ...mappings[0], origin: 'hyperframes' };
  assert.equal(assetUid(generated), assetUid({ ...generated, projectAbsolutePath: '/tmp/copy.mov' }));
  assert.notEqual(assetUid(generated), assetUid({ ...generated, projectStableId: 'asset_other_project' }));
});

test('FCPXML 为视频和静态图片生成 Final Cut Pro 兼容的独立镜头', () => {
  const xml = buildFcpxml({ projectName: '中文 项目', analysis, assetMappings: mappings });
  const report = validateFcpxmlStructure(xml, { assetCount: 2, shotCount: 2, markerCount: 2 });
  assert.equal(report.ok, true, report.errors.join('；'));
  assert.equal(report.assetCount, 2);
  assert.equal(report.clipCount, 2);
  assert.deepEqual(report.sequenceFormat, {
    id: 'r1', width: 1920, height: 1080, frameDuration: '1/30s',
  });
  assert.match(xml, /file:\/\/\/tmp\/%E4%B8%AD%E6%96%87%20%E8%B7%AF%E5%BE%84/);
  assert.match(xml, new RegExp(`uid="${assetUid(mappings[0]).replaceAll('.', '\\.')}"`));
  assert.match(xml, new RegExp(`uid="${assetUid(mappings[1]).replaceAll('.', '\\.')}"`));
  assert.match(xml, /结果 &amp; 对比\.png/);
  assert.match(xml, /<adjust-conform type="fill"\/>/);
  assert.match(xml, /audioChannels="1" audioRate="48000"/);
  assert.match(xml, /asset-clip name="屏幕 录制\.mov"[^>]*audioRole="dialogue"/);
  assert.match(xml, /<asset[^>]*name="结果 &amp; 对比\.png"[^>]*duration="0s"/);
  assert.match(xml, /<video name="结果 &amp; 对比\.png"[^>]*start="3600\/1s"/);
  assert.doesNotMatch(xml, /asset-clip name="结果 &amp; 对比\.png"/);
  assert.doesNotMatch(xml, /roughcut-preview/);
});

test('竖屏正式项目默认为 1080×1920，混合静态图片和视频仍保持独立镜头', () => {
  const verticalAnalysis = {
    ...analysis,
    timeline: {
      ...analysis.timeline,
      orientation: 'vertical',
      width: undefined,
      height: undefined,
    },
  };
  const xml = buildFcpxml({
    projectName: '竖屏项目',
    analysis: verticalAnalysis,
    assetMappings: mappings,
  });
  const report = validateFcpxmlStructure(xml, {
    assetCount: 2,
    shotCount: 2,
    markerCount: 2,
    width: 1080,
    height: 1920,
    fps: 30,
  });
  assert.equal(report.ok, true, report.errors.join('；'));
  assert.equal(report.clipCount, 2);
  assert.equal(report.sequenceFormat.width, 1080);
  assert.equal(report.sequenceFormat.height, 1920);
  assert.match(xml, /<adjust-conform type="fit"\/>/);
});
