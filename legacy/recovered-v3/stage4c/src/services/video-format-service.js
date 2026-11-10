const TIMELINE_ORIENTATIONS = new Set(['horizontal', 'vertical']);

const PRODUCTION_FORMATS = Object.freeze({
  horizontal: Object.freeze({ width: 1920, height: 1080 }),
  vertical: Object.freeze({ width: 1080, height: 1920 }),
});

const DEFAULT_PREVIEW_FORMAT = Object.freeze({ width: 640, height: 360, fps: 30 });
const STANDARD_FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

function invalidFormat(message) {
  return Object.assign(new Error(message), { code: 'INVALID_TIMELINE_FORMAT' });
}

function optionalNumber(value, label) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw invalidFormat(`${label} 必须是数字。`);
  return parsed;
}

function validateDimension(value, label) {
  if (!Number.isInteger(value) || value < 320 || value % 2 !== 0) {
    throw invalidFormat(`${label} 必须是大于等于 320 的偶数。`);
  }
  return value;
}

function validateFps(value, label = 'fps') {
  if (!Number.isFinite(value) || value < 1 || value > 120) {
    throw invalidFormat(`${label} 必须在 1 到 120 之间。`);
  }
  return value;
}

function normalizeOrientation(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  const aliases = {
    landscape: 'horizontal',
    portrait: 'vertical',
    '横屏': 'horizontal',
    '竖屏': 'vertical',
  };
  const orientation = aliases[normalized] || normalized;
  if (!TIMELINE_ORIENTATIONS.has(orientation)) {
    throw invalidFormat('orientation 必须是 horizontal 或 vertical。');
  }
  return orientation;
}

function dimensionsFromMetadata(metadata = {}) {
  const width = Number(metadata.displayWidth || metadata.width);
  const height = Number(metadata.displayHeight || metadata.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

function orientationFromDimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width === height) return null;
  return width > height ? 'horizontal' : 'vertical';
}

function primaryVideo(manifest, analysis) {
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  const itemById = new Map(items.map((item) => [item.assetId, item]));
  const durations = new Map();
  for (const shot of analysis?.timeline?.shots || []) {
    const item = itemById.get(shot.assetId);
    if (item?.type !== 'video') continue;
    durations.set(shot.assetId, (durations.get(shot.assetId) || 0) + Number(shot.durationSec || 0));
  }
  return [...durations.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([assetId]) => itemById.get(assetId))
    .find(Boolean)
    || items.find((item) => item.type === 'video')
    || null;
}

function inferOrientation(manifest, analysis) {
  const video = primaryVideo(manifest, analysis);
  const videoDimensions = dimensionsFromMetadata(video?.metadata);
  const videoOrientation = videoDimensions
    ? orientationFromDimensions(videoDimensions.width, videoDimensions.height)
    : null;
  if (videoOrientation) return videoOrientation;

  const itemById = new Map((manifest?.items || []).map((item) => [item.assetId, item]));
  const scores = { horizontal: 0, vertical: 0 };
  for (const shot of analysis?.timeline?.shots || []) {
    const dimensions = dimensionsFromMetadata(itemById.get(shot.assetId)?.metadata);
    const orientation = dimensions
      ? orientationFromDimensions(dimensions.width, dimensions.height)
      : null;
    if (orientation) scores[orientation] += Number(shot.durationSec || 0);
  }
  return scores.vertical > scores.horizontal ? 'vertical' : 'horizontal';
}

function inferFps(manifest, analysis) {
  const candidate = Number(primaryVideo(manifest, analysis)?.metadata?.frameRate);
  if (!Number.isFinite(candidate)) return 30;
  const standard = STANDARD_FRAME_RATES
    .map((value) => ({ value, distance: Math.abs(value - candidate) }))
    .sort((left, right) => left.distance - right.distance)[0];
  return standard?.distance <= 0.15 ? standard.value : 30;
}

function resolveTimelineFormat(analysis, manifest, overrides = {}) {
  const timeline = analysis?.timeline || {};
  const overrideOrientation = normalizeOrientation(overrides.orientation);
  const declaredOrientation = normalizeOrientation(timeline.orientation);
  const overrideWidth = optionalNumber(overrides.width, 'width');
  const overrideHeight = optionalNumber(overrides.height, 'height');
  const declaredWidth = optionalNumber(timeline.width, 'timeline.width');
  const declaredHeight = optionalNumber(timeline.height, 'timeline.height');

  let width = overrideWidth;
  let height = overrideHeight;
  if (!overrideOrientation || overrideWidth != null || overrideHeight != null) {
    width ??= declaredWidth;
    height ??= declaredHeight;
  }

  const orientation = overrideOrientation
    || declaredOrientation
    || orientationFromDimensions(width, height)
    || inferOrientation(manifest, analysis);
  const productionDefault = PRODUCTION_FORMATS[orientation];
  width = validateDimension(width ?? productionDefault.width, 'timeline.width');
  height = validateDimension(height ?? productionDefault.height, 'timeline.height');
  const dimensionOrientation = orientationFromDimensions(width, height);
  if (dimensionOrientation && dimensionOrientation !== orientation) {
    throw invalidFormat(`timeline.orientation 为 ${orientation}，但 ${width}×${height} 的方向不一致。`);
  }

  const fpsOverride = optionalNumber(overrides.fps, 'fps');
  const declaredFps = optionalNumber(timeline.fps, 'timeline.fps');
  const fps = validateFps(fpsOverride ?? declaredFps ?? inferFps(manifest, analysis), 'timeline.fps');
  return { orientation, width, height, fps };
}

function resolvePreviewFormat(overrides = {}) {
  const width = optionalNumber(overrides.width, 'preview-width') ?? DEFAULT_PREVIEW_FORMAT.width;
  const height = optionalNumber(overrides.height, 'preview-height') ?? DEFAULT_PREVIEW_FORMAT.height;
  const fps = optionalNumber(overrides.fps, 'preview-fps') ?? DEFAULT_PREVIEW_FORMAT.fps;
  return {
    width: validateDimension(width, 'preview-width'),
    height: validateDimension(height, 'preview-height'),
    fps: validateFps(fps, 'preview-fps'),
  };
}

function resolveVideoFormats(analysis, manifest, options = {}) {
  const timeline = resolveTimelineFormat(analysis, manifest, options.timeline);
  const preview = resolvePreviewFormat(options.preview);
  return {
    analysis: {
      ...analysis,
      timeline: { ...analysis.timeline, ...timeline },
    },
    timeline,
    preview,
  };
}

module.exports = {
  DEFAULT_PREVIEW_FORMAT,
  PRODUCTION_FORMATS,
  STANDARD_FRAME_RATES,
  TIMELINE_ORIENTATIONS,
  inferFps,
  inferOrientation,
  resolvePreviewFormat,
  resolveTimelineFormat,
  resolveVideoFormats,
};
