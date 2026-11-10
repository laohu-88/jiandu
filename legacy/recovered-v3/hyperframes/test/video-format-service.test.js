const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolvePreviewFormat,
  resolveTimelineFormat,
  resolveVideoFormats,
} = require('../src/services/video-format-service');

function planFor(metadata, timeline = {}) {
  return {
    manifest: {
      items: [{ assetId: 'main-video', type: 'video', metadata }],
    },
    analysis: {
      timeline: {
        ...timeline,
        shots: [{ assetId: 'main-video', durationSec: 3 }],
      },
    },
  };
}

test('未显式指定时，横屏主视频使用 1920×1080 生产格式', () => {
  const { manifest, analysis } = planFor({
    displayWidth: 2272, displayHeight: 1760, frameRate: 29.97,
  });
  assert.deepEqual(resolveTimelineFormat(analysis, manifest), {
    orientation: 'horizontal', width: 1920, height: 1080, fps: 29.97,
  });
});

test('未显式指定时，竖屏主视频使用 1080×1920 生产格式', () => {
  const { manifest, analysis } = planFor({
    displayWidth: 1080, displayHeight: 1920, frameRate: 30,
  });
  assert.deepEqual(resolveTimelineFormat(analysis, manifest), {
    orientation: 'vertical', width: 1080, height: 1920, fps: 30,
  });
});

test('不可靠变帧率回退到 30 fps，且不受第一张图片影响', () => {
  const manifest = {
    items: [
      { assetId: 'first-image', type: 'image', metadata: { width: 1080, height: 1920 } },
      { assetId: 'main-video', type: 'video', metadata: { width: 2272, height: 1760, frameRate: 27.887324 } },
    ],
  };
  const analysis = {
    timeline: {
      shots: [
        { assetId: 'first-image', durationSec: 2 },
        { assetId: 'main-video', durationSec: 1.5 },
      ],
    },
  };
  assert.deepEqual(resolveTimelineFormat(analysis, manifest), {
    orientation: 'horizontal', width: 1920, height: 1080, fps: 30,
  });
});

test('CLI 或结构化分析可显式覆盖方向、尺寸和帧率', () => {
  const { manifest, analysis } = planFor(
    { width: 1920, height: 1080, frameRate: 30 },
    { orientation: 'horizontal', width: 1920, height: 1080, fps: 30 },
  );
  assert.deepEqual(resolveTimelineFormat(analysis, manifest, {
    orientation: 'vertical', width: 1440, height: 2560, fps: 60,
  }), {
    orientation: 'vertical', width: 1440, height: 2560, fps: 60,
  });
});

test('显式方向与尺寸冲突时拒绝构建', () => {
  const { manifest, analysis } = planFor(
    { width: 1920, height: 1080, frameRate: 30 },
    { orientation: 'vertical', width: 1920, height: 1080, fps: 30 },
  );
  assert.throws(
    () => resolveTimelineFormat(analysis, manifest),
    (error) => error.code === 'INVALID_TIMELINE_FORMAT' && /方向不一致/.test(error.message),
  );
});

test('粗剪预览默认保持 640×360，与正式时间线解耦', () => {
  const { manifest, analysis } = planFor({ width: 1920, height: 1080, frameRate: 30 });
  const resolved = resolveVideoFormats(analysis, manifest);
  assert.deepEqual(resolved.timeline, {
    orientation: 'horizontal', width: 1920, height: 1080, fps: 30,
  });
  assert.deepEqual(resolved.preview, resolvePreviewFormat());
  assert.deepEqual(resolved.preview, { width: 640, height: 360, fps: 30 });
});
