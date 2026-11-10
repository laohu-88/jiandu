const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFcpxml } = require('../src/services/fcpxml-service');
const {
  createMarkerViewModel,
  formatFcpTimecode,
  locateShot,
} = require('../src/services/marker-view-model');

function marker(id, timeSec, text) {
  return {
    id,
    timeSec,
    text,
    type: 'light-subtitle',
    subtitle: {
      enabled: true,
      text,
      durationSec: 2,
      position: 'bottom-safe',
      purpose: '解释关键切换',
      renderAsFcpTitle: true,
    },
  };
}

const baseAnalysis = {
  titles: { recommended: 'Marker View Model' },
  timeline: {
    orientation: 'horizontal', width: 1920, height: 1080, fps: 30,
    shots: [
      { id: 'shot-001', assetId: 'image-a', inSec: 0, outSec: 6, durationSec: 6, fitMode: 'contain', audioMode: 'mute' },
      { id: 'shot-002', assetId: 'image-b', inSec: 0, outSec: 6, durationSec: 6, fitMode: 'contain', audioMode: 'mute' },
    ],
    markers: [marker('marker-a', 1, '第一条'), marker('marker-b', 5.2, '切换工具')],
  },
};

const mappings = [
  { assetId: 'image-a', type: 'image', projectFilename: 'A.png', projectAbsolutePath: '/tmp/A.png', sourceSha256: 'a'.repeat(64), metadata: { width: 1920, height: 1080 } },
  { assetId: 'image-b', type: 'image', projectFilename: 'B.png', projectAbsolutePath: '/tmp/B.png', sourceSha256: 'b'.repeat(64), metadata: { width: 1920, height: 1080 } },
];
const manifest = { items: [
  { assetId: 'image-a', type: 'image', filename: '源 A.png' },
  { assetId: 'image-b', type: 'image', filename: '源 B.png' },
] };

test('30fps 时间码处理非整数帧、起点、终点和越界钳制', () => {
  assert.equal(formatFcpTimecode(0, 30, 12), '00:00:00:00');
  assert.equal(formatFcpTimecode(10.2, 30, 12), '00:00:10:06');
  assert.equal(formatFcpTimecode(1.019, 30, 12), '00:00:01:01');
  assert.equal(formatFcpTimecode(12, 30, 12), '00:00:12:00');
  assert.equal(formatFcpTimecode(99, 30, 12), '00:00:12:00');
  assert.equal(locateShot(baseAnalysis.timeline.shots, 6).shot.id, 'shot-002');
  assert.equal(locateShot(baseAnalysis.timeline.shots, 12).shot.id, 'shot-002');
});

test('普通 analysis Marker 聚合文案、镜头、素材、时长、位置和 FCPXML 状态', () => {
  const xml = buildFcpxml({ projectName: '普通项目', analysis: baseAnalysis, assetMappings: mappings });
  const view = createMarkerViewModel({
    analysis: baseAnalysis,
    manifest,
    status: { assetMappings: mappings, formats: { timeline: { fps: 30 } } },
    fcpxml: xml,
  });
  assert.equal(view.source, 'analysis');
  assert.equal(view.markerCount, 2);
  assert.equal(view.enabledSubtitleCount, 2);
  assert.equal(view.fcpTitleCount, 2);
  assert.equal(view.allMarkersWritten, true);
  assert.equal(view.allRequestedTitlesGenerated, true);
  assert.equal(view.items[1].shotId, 'shot-001');
  assert.equal(view.items[1].assetFilename, '源 A.png');
  assert.equal(view.items[1].durationSec, 2);
  assert.equal(view.items[1].position, 'bottom-safe');
  assert.equal(view.items[1].writtenToFcpxmlMarker, true);
  assert.equal(view.items[1].generatedFcpTitle, true);
});

test('effectiveAnalysis 只使用最终 Marker 时间并标记 HyperFrames 平移', () => {
  const effective = structuredClone(baseAnalysis);
  effective.timeline.markers[1].timeSec = 10.2;
  const xml = buildFcpxml({ projectName: 'HyperFrames 项目', analysis: effective, assetMappings: mappings });
  const status = {
    hyperframes: { enabled: true },
    effectiveAnalysis: effective,
    assetMappings: mappings,
    formats: { timeline: { fps: 30 } },
  };
  const view = createMarkerViewModel({ analysis: effective, baseAnalysis, manifest, status, fcpxml: xml });
  assert.equal(view.source, 'effectiveAnalysis');
  assert.equal(view.hyperframesAdjusted, true);
  assert.equal(view.items[1].timeSec, 10.2);
  assert.equal(view.items[1].timecode, '00:00:10:06');
  assert.equal(view.items[1].shotId, 'shot-002');
  assert.equal(view.items[1].timeAdjustedByHyperframes, true);
});

test('旧项目缺少扩展字段时保持可读且不伪造缺失信息', () => {
  const legacy = structuredClone(baseAnalysis);
  legacy.timeline.markers = [{ timeSec: 1, text: '旧 Marker' }];
  const view = createMarkerViewModel({
    analysis: legacy,
    manifest,
    status: { assetMappings: mappings },
    fcpxml: '',
  });
  assert.equal(view.items[0].id, null);
  assert.equal(view.items[0].type, null);
  assert.equal(view.items[0].durationSec, null);
  assert.equal(view.items[0].position, null);
  assert.equal(view.items[0].enabled, false);
  assert.equal(view.items[0].shouldGenerateFcpTitle, false);
  assert.equal(view.items[0].generatedFcpTitle, false);
});
