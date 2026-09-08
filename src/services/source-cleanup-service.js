const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { probeMedia, runMediaTool } = require('./media-tool-service');

const CLEANUP_DECISIONS = new Set([
  'none',
  'crop_reframe',
  'derived_media',
  'fallback_preserve',
]);
const CLEANUP_METHODS = new Set([
  'none',
  'fcpxml_crop',
  'fcpxml_reframe',
  'ffmpeg_mask_blur',
  'preserve',
]);
const CLEANUP_PROVIDERS = new Set([
  'none',
  'fcpxml',
  'ffmpeg-mask-blur',
  'inpainting',
  'unavailable',
]);
const OVERLAY_TYPES = new Set([
  'foreign_title',
  'ranking_number',
  'symbol',
  'platform_sticker',
  'watermark',
  'other_overlay',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value, maximum = Infinity) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function clampNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeZone(zone) {
  if (!isObject(zone)) return null;
  const normalized = {
    x: clampNumber(zone.x),
    y: clampNumber(zone.y),
    width: clampNumber(zone.width),
    height: clampNumber(zone.height),
  };
  if (normalized.width <= 0 || normalized.height <= 0) return null;
  if (normalized.x < 0 || normalized.y < 0
    || normalized.x + normalized.width > 1.000001
    || normalized.y + normalized.height > 1.000001) return null;
  return normalized;
}

function normalizeCleanupPlan(plan) {
  if (!isObject(plan)) return null;
  const result = {
    decision: typeof plan.decision === 'string' ? plan.decision : 'none',
    overlayTypes: Array.isArray(plan.overlayTypes) ? [...plan.overlayTypes] : [],
    rationale: typeof plan.rationale === 'string' ? plan.rationale.trim() : '',
    method: typeof plan.method === 'string' ? plan.method : 'none',
    provider: typeof plan.provider === 'string' ? plan.provider : 'none',
    zones: Array.isArray(plan.zones) ? plan.zones.map(normalizeZone).filter(Boolean) : [],
    layout: isObject(plan.layout) ? structuredClone(plan.layout) : null,
    fallback: plan.fallback === 'crop_reframe' ? 'crop_reframe' : 'preserve',
    fallbackLayout: isObject(plan.fallbackLayout) ? structuredClone(plan.fallbackLayout) : null,
    reviewRequired: plan.reviewRequired === true,
    warnings: Array.isArray(plan.warnings)
      ? plan.warnings.filter((item) => typeof item === 'string' && item.trim())
      : [],
  };
  return result;
}

function validateCleanupPlan(plan, field = 'cleanup', errors = []) {
  if (plan == null) return errors;
  if (!isObject(plan)) {
    errors.push(`${field} 必须是对象。`);
    return errors;
  }
  if (!CLEANUP_DECISIONS.has(plan.decision)) errors.push(`${field}.decision 无效。`);
  if (!Array.isArray(plan.overlayTypes)
    || plan.overlayTypes.length > 8
    || !plan.overlayTypes.every((item) => OVERLAY_TYPES.has(item))) {
    errors.push(`${field}.overlayTypes 必须是 0 到 8 个受支持的覆盖物类型。`);
  }
  if (!isNonEmptyString(plan.rationale, 1000)) errors.push(`${field}.rationale 无效。`);
  if (!CLEANUP_METHODS.has(plan.method)) errors.push(`${field}.method 无效。`);
  if (!CLEANUP_PROVIDERS.has(plan.provider)) errors.push(`${field}.provider 无效。`);
  if (plan.decision === 'none'
    && (plan.method !== 'none' || plan.provider !== 'none')) {
    errors.push(`${field}.decision 为 none 时 method/provider 必须为 none。`);
  }
  if (plan.decision === 'crop_reframe'
    && !['fcpxml_crop', 'fcpxml_reframe'].includes(plan.method)) {
    errors.push(`${field}.decision 为 crop_reframe 时必须使用 FCPXML crop/reframe。`);
  }
  if (plan.decision === 'derived_media'
    && !['ffmpeg_mask_blur', 'preserve'].includes(plan.method)) {
    errors.push(`${field}.decision 为 derived_media 时 method 必须是 ffmpeg_mask_blur 或 preserve。`);
  }
  if (plan.decision === 'derived_media'
    && plan.method === 'ffmpeg_mask_blur'
    && plan.provider === 'ffmpeg-mask-blur'
    && (!Array.isArray(plan.zones) || plan.zones.length === 0)) {
    errors.push(`${field}.zones 至少需要一个有效的非关键背景区域。`);
  }
  if (!Array.isArray(plan.zones) || plan.zones.some((zone) => normalizeZone(zone) == null)) {
    errors.push(`${field}.zones 必须使用 0 到 1 范围内的 x/y/width/height。`);
  }
  if (typeof plan.reviewRequired !== 'boolean') errors.push(`${field}.reviewRequired 必须是布尔值。`);
  if (plan.layout != null && !isObject(plan.layout)) errors.push(`${field}.layout 必须是对象。`);
  if (plan.fallbackLayout != null && !isObject(plan.fallbackLayout)) {
    errors.push(`${field}.fallbackLayout 必须是对象。`);
  }
  if (!Array.isArray(plan.warnings)
    || plan.warnings.length > 20
    || !plan.warnings.every((item) => isNonEmptyString(item, 500))) {
    errors.push(`${field}.warnings 必须是 0 到 20 条非空字符串。`);
  }
  return errors;
}

function resolveCleanupPlan(shot, assetAnalysis) {
  return normalizeCleanupPlan(shot?.cleanup || assetAnalysis?.cleanup || null);
}

function mergeCleanupLayout(shot, cleanup) {
  if (!cleanup?.layout || !isObject(cleanup.layout)) return shot;
  return {
    ...shot,
    layout: {
      ...(isObject(shot.layout) ? shot.layout : {}),
      ...structuredClone(cleanup.layout),
    },
  };
}

function cleanupFingerprint(mapping, cleanup) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      sourceSha256: mapping.sourceSha256,
      decision: cleanup.decision,
      method: cleanup.method,
      provider: cleanup.provider,
      zones: cleanup.zones,
    }))
    .digest('hex')
    .slice(0, 16);
}

function escapeFilterNumber(value) {
  return Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

function maskBlurFilter(zones) {
  let current = '[0:v]';
  const filters = [];
  zones.forEach((zone, index) => {
    const base = `clean_base_${index}`;
    const patch = `clean_patch_${index}`;
    const blurred = `clean_blurred_${index}`;
    const output = `clean_output_${index}`;
    filters.push(
      `${current}split=2[${base}][${patch}]`,
      `[${patch}]crop=iw*${escapeFilterNumber(zone.width)}:ih*${escapeFilterNumber(zone.height)}`
        + `:iw*${escapeFilterNumber(zone.x)}:ih*${escapeFilterNumber(zone.y)}`
        + `,boxblur=luma_radius=12:luma_power=2:chroma_radius=6:chroma_power=2[${blurred}]`,
      `[${base}][${blurred}]overlay=x=main_w*${escapeFilterNumber(zone.x)}`
        + `:y=main_h*${escapeFilterNumber(zone.y)}[${output}]`,
    );
    current = `[${output}]`;
  });
  return { filter: filters.join(';'), output: current };
}

async function materializeCleanMedia({ artifactRoot, mapping, cleanup }) {
  const normalized = normalizeCleanupPlan(cleanup);
  if (!normalized || normalized.decision !== 'derived_media') {
    return { status: 'not_requested', mapping, cleanup: normalized };
  }
  if (normalized.provider !== 'ffmpeg-mask-blur' || normalized.method !== 'ffmpeg_mask_blur') {
    return {
      status: 'fallback',
      reason: `清理 provider ${normalized.provider || 'unknown'} 不可用，未伪造像素级修复。`,
      mapping,
      cleanup: normalized,
    };
  }
  if (!normalized.zones.length) {
    return {
      status: 'fallback',
      reason: '没有可靠的非关键背景区域，未生成派生媒体。',
      mapping,
      cleanup: normalized,
    };
  }

  const mediaType = mapping.type;
  if (!['video', 'image'].includes(mediaType)) {
    return { status: 'fallback', reason: `不支持对 ${mediaType} 生成清理媒体。`, mapping, cleanup: normalized };
  }
  const cleanDirectory = path.join(path.resolve(artifactRoot), 'cache', 'clean-media');
  const fingerprint = cleanupFingerprint(mapping, normalized);
  const extension = mediaType === 'image' ? '.png' : '.mp4';
  const outputPath = path.join(cleanDirectory, `${mapping.assetId}-${fingerprint}${extension}`);
  await fs.mkdir(cleanDirectory, { recursive: true });
  const existing = await fs.stat(outputPath).catch(() => null);
  if (!existing?.isFile()) {
    const graph = maskBlurFilter(normalized.zones);
    const args = ['-y', '-i', mapping.projectAbsolutePath, '-filter_complex', `${graph.filter};${graph.output}null[cleanout]`, '-map', '[cleanout]'];
    if (mediaType === 'image') {
      args.push('-frames:v', '1', '-c:v', 'png', outputPath);
    } else {
      args.push('-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', outputPath);
    }
    try {
      await runMediaTool('ffmpeg', args, { timeoutMs: 15 * 60 * 1000 });
    } catch (error) {
      return {
        status: 'fallback',
        reason: `清理媒体生成失败，保留原素材：${error.message}`,
        mapping,
        cleanup: normalized,
      };
    }
  }
  const metadata = await probeMedia(outputPath).catch(() => null);
  if (!metadata?.hasVideo) {
    return {
      status: 'fallback',
      reason: '派生媒体无法通过媒体探测，保留原素材。',
      mapping,
      cleanup: normalized,
    };
  }
  const bytes = await fs.readFile(outputPath);
  const sourceSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    status: 'generated',
    mapping: {
      ...mapping,
      origin: 'cleanup',
      projectFilename: path.basename(outputPath),
      projectRelativePath: null,
      projectAbsolutePath: outputPath,
      sourceSha256,
      sourceAssetSha256: mapping.sourceSha256,
      metadata,
      cleanupSourceAssetId: mapping.assetId,
    },
    cleanup: normalized,
    outputPath,
  };
}

module.exports = {
  CLEANUP_DECISIONS,
  CLEANUP_METHODS,
  CLEANUP_PROVIDERS,
  OVERLAY_TYPES,
  cleanupFingerprint,
  maskBlurFilter,
  materializeCleanMedia,
  mergeCleanupLayout,
  normalizeCleanupPlan,
  resolveCleanupPlan,
  validateCleanupPlan,
};
