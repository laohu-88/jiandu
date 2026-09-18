const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { probeMedia, runMediaTool } = require('./media-tool-service');

const CLEANUP_DECISIONS = new Set([
  'none',
  'crop_reframe',
  'derived_media',
  'fallback_preserve',
  'omit',
]);
const CLEANUP_METHODS = new Set([
  'none',
  'fcpxml_crop',
  'fcpxml_reframe',
  'ffmpeg_delogo',
  'ffmpeg_mask_blur',
  'preserve',
]);
const CLEANUP_PROVIDERS = new Set([
  'none',
  'fcpxml',
  'ffmpeg-delogo',
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
const CLEANUP_RESULT_STATUSES = new Set([
  'clean',
  'cleaned_by_reframe',
  'cleaned_by_derived_media',
  'unresolved',
]);
const PLACEHOLDER_INSPECTED_FRAMES = new Set([
  'storyboard.jpg',
  'timed key frames',
  'timed frames',
  '代表帧',
  '开头',
  '中段',
  '结尾',
  'contact sheet',
]);
const DELOGO_MAX_AREA = 0.04;
const DELOGO_MAX_WIDTH = 0.28;
const DELOGO_MAX_HEIGHT = 0.2;
const DELOGO_EDGE_MARGIN = 0.1;
const DELOGO_TOTAL_AREA = 0.06;
const ZONE_MIN_CHANGE_RATIO = 0.02;
const OUTSIDE_MAX_CHANGE_RATIO = 0.16;
const ENERGY_KEEP_RATIO = 0.35;
const MOSAIC_FLAT_SOURCE = 28;
const MOSAIC_FLAT_CLEAN = 10;

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

function inspectedNoneCleanup(overrides = {}) {
  return {
    decision: 'none',
    overlayTypes: [],
    rationale: '已实际检查代表帧，检查后未发现与本期无关的烧录覆盖物。',
    method: 'none',
    provider: 'none',
    zones: [],
    inspectedFrames: ['start.jpg', 'middle.jpg', 'end.jpg'],
    isCoreContent: false,
    reviewRequired: false,
    warnings: [],
    ...overrides,
  };
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

function isUsableInspectedFrame(value) {
  if (!isNonEmptyString(value, 400)) return false;
  const trimmed = value.trim();
  if (PLACEHOLDER_INSPECTED_FRAMES.has(trimmed.toLowerCase())) return false;
  if (PLACEHOLDER_INSPECTED_FRAMES.has(trimmed)) return false;
  return /\.(jpe?g|png|webp)$/i.test(trimmed) || trimmed.includes('/');
}

function hasPositiveCrop(crop) {
  if (!isObject(crop)) return false;
  return ['left', 'top', 'right', 'bottom'].some((edge) => Number(crop[edge]) > 0);
}

function zoneArea(zone) {
  return Math.max(0, Number(zone.width) * Number(zone.height));
}

function zoneTouchesEdge(zone, margin = DELOGO_EDGE_MARGIN) {
  return zone.x <= margin
    || zone.y <= margin
    || (zone.x + zone.width) >= 1 - margin
    || (zone.y + zone.height) >= 1 - margin;
}

function zoneHitsCenterSubject(zone) {
  const cx = zone.x + zone.width / 2;
  const cy = zone.y + zone.height / 2;
  return cx > 0.28 && cx < 0.72 && cy > 0.22 && cy < 0.78;
}

function delogoZoneEligible(zone) {
  if (!zone) return false;
  if (zoneArea(zone) > DELOGO_MAX_AREA) return false;
  if (zone.width > DELOGO_MAX_WIDTH || zone.height > DELOGO_MAX_HEIGHT) return false;
  if (!zoneTouchesEdge(zone)) return false;
  if (zoneHitsCenterSubject(zone)) return false;
  return true;
}

function delogoPlanEligible(plan) {
  const zones = Array.isArray(plan?.zones) ? plan.zones : [];
  if (!zones.length) return false;
  if (zones.some((zone) => !delogoZoneEligible(zone))) return false;
  const total = zones.reduce((sum, zone) => sum + zoneArea(zone), 0);
  return total <= DELOGO_TOTAL_AREA;
}

function delogoIneligibleReason(plan) {
  const zones = Array.isArray(plan?.zones) ? plan.zones : [];
  if (!zones.length) return '没有可用于 delogo 的小区域。';
  if (zones.some((zone) => zoneArea(zone) > DELOGO_MAX_AREA
    || zone.width > DELOGO_MAX_WIDTH
    || zone.height > DELOGO_MAX_HEIGHT)) {
    return '覆盖区域过大，ffmpeg-delogo 不能作为自动成功路径。';
  }
  if (zones.some((zone) => zoneHitsCenterSubject(zone))) {
    return '覆盖物压在画面中部主体上，禁止用 delogo / 模糊硬擦。';
  }
  if (zones.some((zone) => !zoneTouchesEdge(zone))) {
    return '覆盖物不在边缘小区域，ffmpeg-delogo 仅适用于简单静态背景的边角。';
  }
  return '覆盖区域不适合高质量 delogo。';
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
    timeRanges: Array.isArray(plan.timeRanges)
      ? plan.timeRanges
        .filter((range) => isObject(range))
        .map((range) => ({
          startSec: clampNumber(range.startSec),
          endSec: clampNumber(range.endSec),
          confidence: Number.isFinite(Number(range.confidence))
            ? Math.max(0, Math.min(1, Number(range.confidence)))
            : null,
        }))
        .filter((range) => range.endSec > range.startSec)
      : [],
    inspectedFrames: Array.isArray(plan.inspectedFrames)
      ? plan.inspectedFrames.filter((item) => isNonEmptyString(item, 400)).slice(0, 40)
      : [],
    confidence: Number.isFinite(Number(plan.confidence))
      ? Math.max(0, Math.min(1, Number(plan.confidence)))
      : null,
    isCoreContent: plan.isCoreContent === true,
    layout: isObject(plan.layout) ? structuredClone(plan.layout) : null,
    fallback: plan.fallback === 'crop_reframe' ? 'crop_reframe' : 'preserve',
    fallbackLayout: isObject(plan.fallbackLayout) ? structuredClone(plan.fallbackLayout) : null,
    reviewRequired: plan.reviewRequired === true,
    warnings: Array.isArray(plan.warnings)
      ? plan.warnings.filter((item) => typeof item === 'string' && item.trim())
      : [],
    resultStatus: CLEANUP_RESULT_STATUSES.has(plan.resultStatus) ? plan.resultStatus : null,
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
  if (!Array.isArray(plan.inspectedFrames)
    || plan.inspectedFrames.length === 0
    || !plan.inspectedFrames.every((item) => isUsableInspectedFrame(item))) {
    errors.push(`${field}.inspectedFrames 必须记录真实代表帧路径，不能用占位词代替实际检查。`);
  }
  if (plan.decision === 'none') {
    if (plan.method !== 'none' || plan.provider !== 'none') {
      errors.push(`${field}.decision 为 none 时 method/provider 必须为 none。`);
    }
    if (Array.isArray(plan.overlayTypes) && plan.overlayTypes.length > 0 && plan.isCoreContent !== true) {
      errors.push(`${field}.decision 为 none 时不能同时记录未处理的无关覆盖物；应 crop_reframe、换片段、omit 或标 unresolved。`);
    }
  }
  if (plan.decision === 'crop_reframe'
    && !['fcpxml_crop', 'fcpxml_reframe'].includes(plan.method)) {
    errors.push(`${field}.decision 为 crop_reframe 时必须使用 FCPXML crop/reframe。`);
  }
  if (plan.decision === 'crop_reframe') {
    const layout = isObject(plan.layout) ? plan.layout : {};
    if (!hasPositiveCrop(layout.crop)) {
      errors.push(`${field}.layout.crop 必须真正裁掉目标覆盖物，不能只写 crop_reframe。`);
    }
    if (!Array.isArray(plan.zones) || plan.zones.length === 0) {
      errors.push(`${field}.zones 必须标出要从最终构图移出的覆盖区域。`);
    } else if (plan.zones.every((zone) => normalizeZone(zone))
      && !plan.zones.every((zone) => cropCoversZone(layout, normalizeZone(zone)))) {
      errors.push(`${field}.layout.crop 未把全部目标区域移出最终可见画面。`);
    }
  }
  if (plan.decision === 'derived_media') {
    if (plan.method === 'ffmpeg_mask_blur' || plan.provider === 'ffmpeg-mask-blur') {
      errors.push(`${field} 不得把 mask/rectangle blur 或简单遮盖当作成功净化路径。`);
    }
    if (plan.method !== 'ffmpeg_delogo' || plan.provider !== 'ffmpeg-delogo') {
      errors.push(`${field}.decision 为 derived_media 时仅允许简单静态背景的 ffmpeg_delogo。`);
    }
    const zones = Array.isArray(plan.zones) ? plan.zones.map(normalizeZone) : [];
    if (!zones.length || zones.some((zone) => zone == null)) {
      errors.push(`${field}.zones 至少需要一个有效的边缘小区域。`);
    } else if (!delogoPlanEligible({ zones })) {
      errors.push(`${field}.zones ${delogoIneligibleReason({ zones })}`);
    }
  }
  if (plan.decision === 'omit') {
    if (!Array.isArray(plan.overlayTypes) || plan.overlayTypes.length === 0) {
      errors.push(`${field}.decision 为 omit 时必须记录无法安全去除的覆盖物类型。`);
    }
    if (!['preserve', 'none'].includes(plan.method)) {
      errors.push(`${field}.decision 为 omit 时 method 必须是 preserve 或 none。`);
    }
  }
  if (plan.decision === 'fallback_preserve' && plan.method !== 'preserve' && plan.method !== 'none') {
    errors.push(`${field}.decision 为 fallback_preserve 时不得伪造成功的像素修复方法。`);
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

function requireVisualCleanupPlans(analysis, errors = []) {
  for (const [index, asset] of (analysis?.assets || []).entries()) {
    if (!asset || !['image', 'video'].includes(asset.type)) continue;
    const field = `assets[${index}].cleanup`;
    if (asset.cleanup == null) {
      errors.push(`${field} 必须记录实际检查结果，不能省略后静默进入 build。`);
      continue;
    }
    validateCleanupPlan(asset.cleanup, field, errors);
  }
  return errors;
}

function resolveCleanupPlan(shot, assetAnalysis) {
  return normalizeCleanupPlan(shot?.cleanup || assetAnalysis?.cleanup || null);
}

function mergeCleanupLayout(shot, cleanup) {
  if (!cleanup?.layout || !isObject(cleanup.layout)) return shot;
  const incoming = structuredClone(cleanup.layout);
  const existing = isObject(shot.layout) ? shot.layout : null;
  const crop = {
    ...(isObject(existing?.crop) ? existing.crop : {}),
    ...(isObject(incoming.crop) ? incoming.crop : {}),
  };
  const shouldFill = hasPositiveCrop(crop);
  if (!existing) {
    return {
      ...shot,
      fitMode: shouldFill ? 'cover' : shot.fitMode,
      layout: {
        mode: incoming.mode || (shouldFill ? 'center_crop' : 'native_vertical'),
        ...incoming,
        crop,
      },
    };
  }
  return {
    ...shot,
    fitMode: shouldFill && !existing.mode ? 'cover' : shot.fitMode,
    layout: {
      ...existing,
      ...incoming,
      mode: existing.mode || incoming.mode || (shouldFill ? 'center_crop' : existing.mode),
      crop,
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
      timeRanges: cleanup.timeRanges,
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

function delogoFilter(zones, metadata = {}) {
  const width = Number(metadata.width || metadata.displayWidth);
  const height = Number(metadata.height || metadata.displayHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const timeRanges = Array.isArray(metadata.timeRanges) ? metadata.timeRanges : [];
  const enable = timeRanges.length > 0
    ? `:enable='${timeRanges.map((range) => `between(t,${escapeFilterNumber(range.startSec)},${escapeFilterNumber(range.endSec)})`).join('+')}'`
    : '';
  let current = '[0:v]';
  const filters = [];
  zones.forEach((zone, index) => {
    const output = `clean_delogo_${index}`;
    const x = Math.max(0, Math.round(zone.x * width));
    const y = Math.max(0, Math.round(zone.y * height));
    const w = Math.max(1, Math.round(zone.width * width));
    const h = Math.max(1, Math.round(zone.height * height));
    filters.push(`${current}delogo=x=${x}:y=${y}:w=${w}:h=${h}:show=0${enable}[${output}]`);
    current = `[${output}]`;
  });
  return { filter: filters.join(';'), output: current };
}

async function materializeCleanMedia({ artifactRoot, mapping, cleanup }) {
  const normalized = normalizeCleanupPlan(cleanup);
  if (!normalized || normalized.decision !== 'derived_media') {
    return { status: 'not_requested', mapping, cleanup: normalized };
  }
  if (normalized.method === 'ffmpeg_mask_blur' || normalized.provider === 'ffmpeg-mask-blur') {
    return {
      status: 'fallback',
      reason: 'mask/rectangle blur 已降级，不得作为复杂覆盖物的自动成功路径。',
      mapping,
      cleanup: normalized,
    };
  }
  const isDelogo = normalized.provider === 'ffmpeg-delogo' && normalized.method === 'ffmpeg_delogo';
  if (!isDelogo) {
    return {
      status: 'fallback',
      reason: `清理 provider ${normalized.provider || 'unknown'} 不可用或未达到可用质量，未伪造像素级修复。`,
      mapping,
      cleanup: normalized,
    };
  }
  if (!delogoPlanEligible(normalized)) {
    return {
      status: 'fallback',
      reason: delogoIneligibleReason(normalized),
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
    const graph = delogoFilter(normalized.zones, { ...mapping.metadata, timeRanges: normalized.timeRanges });
    if (!graph) {
      return {
        status: 'fallback',
        reason: '无法从媒体元数据解析 delogo 区域，保留原素材。',
        mapping,
        cleanup: normalized,
      };
    }
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

async function extractRawFrame(filePath, timeSec, outputPath) {
  const args = ['-y'];
  if (Number.isFinite(Number(timeSec)) && Number(timeSec) > 0) args.push('-ss', String(timeSec));
  args.push('-i', filePath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', outputPath);
  await runMediaTool('ffmpeg', args, { timeoutMs: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return fs.readFile(outputPath);
}

function lumaAt(bytes, width, x, y) {
  const index = (y * width + x) * 3;
  return (bytes[index] * 299 + bytes[index + 1] * 587 + bytes[index + 2] * 114) / 1000;
}

function regionRect(zone, width, height) {
  const x0 = Math.max(0, Math.floor(zone.x * width));
  const y0 = Math.max(0, Math.floor(zone.y * height));
  const x1 = Math.min(width, Math.ceil((zone.x + zone.width) * width));
  const y1 = Math.min(height, Math.ceil((zone.y + zone.height) * height));
  return { x0, y0, x1, y1 };
}

function inRect(x, y, rect) {
  return x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1;
}

function gradientEnergy(bytes, width, height, rect) {
  let energy = 0;
  let count = 0;
  for (let y = rect.y0 + 1; y < rect.y1 - 1; y += 1) {
    for (let x = rect.x0 + 1; x < rect.x1 - 1; x += 1) {
      const gx = lumaAt(bytes, width, x + 1, y) - lumaAt(bytes, width, x - 1, y);
      const gy = lumaAt(bytes, width, x, y + 1) - lumaAt(bytes, width, x, y - 1);
      energy += Math.abs(gx) + Math.abs(gy);
      count += 1;
    }
  }
  return count ? energy / count : 0;
}

function flattenedBlockRatio(sourceBytes, cleanBytes, width, height, rect, block = 8) {
  let blocks = 0;
  let flattened = 0;
  for (let y = rect.y0; y + block <= rect.y1; y += block) {
    for (let x = rect.x0; x + block <= rect.x1; x += block) {
      let sourceMin = 255;
      let sourceMax = 0;
      let cleanMin = 255;
      let cleanMax = 0;
      for (let by = 0; by < block; by += 1) {
        for (let bx = 0; bx < block; bx += 1) {
          const source = lumaAt(sourceBytes, width, x + bx, y + by);
          const clean = lumaAt(cleanBytes, width, x + bx, y + by);
          sourceMin = Math.min(sourceMin, source);
          sourceMax = Math.max(sourceMax, source);
          cleanMin = Math.min(cleanMin, clean);
          cleanMax = Math.max(cleanMax, clean);
        }
      }
      blocks += 1;
      if ((sourceMax - sourceMin) >= MOSAIC_FLAT_SOURCE && (cleanMax - cleanMin) <= MOSAIC_FLAT_CLEAN) {
        flattened += 1;
      }
    }
  }
  return blocks ? flattened / blocks : 0;
}

function measureRegionChange(sourceBytes, cleanBytes, width, height, zones) {
  const rects = zones.map((zone) => regionRect(zone, width, height));
  let zoneChanged = 0;
  let zonePixels = 0;
  let outsideChanged = 0;
  let outsidePixels = 0;
  let zoneDelta = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      const delta = Math.abs(sourceBytes[index] - cleanBytes[index])
        + Math.abs(sourceBytes[index + 1] - cleanBytes[index + 1])
        + Math.abs(sourceBytes[index + 2] - cleanBytes[index + 2]);
      const inside = rects.some((rect) => inRect(x, y, rect));
      if (inside) {
        zonePixels += 1;
        zoneDelta += delta;
        if (delta >= 12) zoneChanged += 1;
      } else {
        outsidePixels += 1;
        if (delta >= 12) outsideChanged += 1;
      }
    }
  }
  const energySource = rects.reduce((sum, rect) => sum + gradientEnergy(sourceBytes, width, height, rect), 0) / Math.max(1, rects.length);
  const energyClean = rects.reduce((sum, rect) => sum + gradientEnergy(cleanBytes, width, height, rect), 0) / Math.max(1, rects.length);
  const mosaicRatio = rects.reduce((sum, rect) => (
    sum + flattenedBlockRatio(sourceBytes, cleanBytes, width, height, rect)
  ), 0) / Math.max(1, rects.length);
  return {
    zoneChangedRatio: zonePixels ? zoneChanged / zonePixels : 0,
    outsideChangedRatio: outsidePixels ? outsideChanged / outsidePixels : 0,
    meanZoneDelta: zonePixels ? zoneDelta / zonePixels / 3 : 0,
    energySource,
    energyClean,
    energyRatio: energySource > 1 ? energyClean / energySource : 1,
    mosaicRatio,
  };
}

async function measurePixelChange(sourcePath, cleanPath, timeSec, width, height, tempDirectory) {
  const sourceFrame = path.join(tempDirectory, `source-${timeSec}.rgb`);
  const cleanFrame = path.join(tempDirectory, `clean-${timeSec}.rgb`);
  const [sourceBytes, cleanBytes] = await Promise.all([
    extractRawFrame(sourcePath, timeSec, sourceFrame),
    extractRawFrame(cleanPath, timeSec, cleanFrame),
  ]);
  const expectedBytes = Math.max(1, Math.round(Number(width) * Number(height) * 3));
  if (sourceBytes.length !== cleanBytes.length || sourceBytes.length !== expectedBytes) {
    return { changed: false, changedRatio: 0, reason: '抽帧尺寸不一致。' };
  }
  let changed = 0;
  let totalDelta = 0;
  for (let index = 0; index < sourceBytes.length; index += 3) {
    const delta = Math.abs(sourceBytes[index] - cleanBytes[index])
      + Math.abs(sourceBytes[index + 1] - cleanBytes[index + 1])
      + Math.abs(sourceBytes[index + 2] - cleanBytes[index + 2]);
    if (delta >= 3) changed += 1;
    totalDelta += delta;
  }
  const pixelCount = sourceBytes.length / 3;
  return {
    changed: changed > 0,
    changedRatio: Number((changed / pixelCount).toFixed(6)),
    meanAbsoluteDelta: Number((totalDelta / pixelCount / 3).toFixed(4)),
    sourceBytes,
    cleanBytes,
  };
}

function assessDerivedQuality(sample, zones, width, height) {
  if (!sample?.sourceBytes || !sample?.cleanBytes) {
    return { ok: false, reason: '缺少可用于质量复检的抽帧。' };
  }
  const metrics = measureRegionChange(sample.sourceBytes, sample.cleanBytes, width, height, zones);
  if (metrics.zoneChangedRatio < ZONE_MIN_CHANGE_RATIO) {
    return { ok: false, reason: '目标覆盖区域几乎没有被处理。', metrics };
  }
  if (metrics.outsideChangedRatio > OUTSIDE_MAX_CHANGE_RATIO) {
    return { ok: false, reason: '像素修复溢出到主体区域。', metrics };
  }
  const smallEdgeLogo = delogoPlanEligible({ zones });
  if (!smallEdgeLogo) {
    if (metrics.energySource >= 8 && metrics.energyRatio < ENERGY_KEEP_RATIO) {
      return { ok: false, reason: '修复区域出现大块模糊、涂抹或细节塌陷。', metrics };
    }
    if (metrics.mosaicRatio >= 0.35) {
      return { ok: false, reason: '修复区域出现马赛克或块状涂抹。', metrics };
    }
  } else if (metrics.energySource >= 22 && metrics.energyRatio < 0.18 && metrics.mosaicRatio >= 0.6) {
    return { ok: false, reason: '即使是边角小区域，修复结果仍出现明显涂抹或马赛克。', metrics };
  }
  return { ok: true, metrics };
}

function cropCoversZone(layout, zone) {
  const crop = layout?.crop || {};
  const left = Number(crop.left) || 0;
  const top = Number(crop.top) || 0;
  const right = Number(crop.right) || 0;
  const bottom = Number(crop.bottom) || 0;
  return zone.x >= 0 && zone.y >= 0
    && (zone.x + zone.width <= left + 1e-6
      || zone.y + zone.height <= top + 1e-6
      || zone.x >= 1 - right - 1e-6
      || zone.y >= 1 - bottom - 1e-6);
}

function resultStatusFor(report, ok) {
  if (!ok) return 'unresolved';
  if (report.status === 'inspected_no_overlay' || report.decision === 'none') return 'clean';
  if (report.decision === 'crop_reframe') return 'cleaned_by_reframe';
  if (report.status === 'generated' && report.decision === 'derived_media') return 'cleaned_by_derived_media';
  return 'unresolved';
}

async function verifyCleanupResults({ artifactRoot, analysis, mappings, cleanupReports, fcpxml = '' }) {
  const mappingById = new Map(mappings.map((mapping) => [mapping.assetId, mapping]));
  const results = [];
  const tempDirectory = await fs.mkdtemp(path.join(path.resolve(artifactRoot), '.cleanup-verify-'));
  try {
    for (const report of cleanupReports || []) {
      const shot = analysis.timeline.shots.find((item) => item.id === report.shotId);
      const cleanup = resolveCleanupPlan(shot, analysis.assets.find((item) => (
        item.assetId === report.assetId || item.sourceAssetId === report.assetId
      )));
      const original = mappingById.get(report.assetId);
      const derived = report.derivedAssetId ? mappingById.get(report.derivedAssetId) : null;
      const result = {
        shotId: report.shotId,
        assetId: report.assetId,
        status: report.status,
        resultStatus: 'unresolved',
        ok: true,
        checks: [],
        warnings: [],
      };
      if (report.status === 'missing') {
        result.ok = false;
        result.status = 'unresolved';
        result.warnings.push('入选素材缺少 cleanup plan，不能静默继续 build。');
      } else if (report.status === 'inspected_no_overlay') {
        const framesOk = (cleanup?.inspectedFrames || []).every((item) => isUsableInspectedFrame(item))
          && (cleanup?.inspectedFrames || []).length > 0;
        result.checks.push({ type: 'inspection', ok: framesOk });
        if (!framesOk) {
          result.ok = false;
          result.warnings.push('cleanup=none 缺少真实检查帧，不能视为 clean。');
        }
        if ((cleanup?.overlayTypes || []).length && cleanup.isCoreContent !== true) {
          result.ok = false;
          result.warnings.push('记录了无关覆盖物却写成 none/cleaned。');
        }
      } else if (report.decision === 'crop_reframe') {
        const layout = shot?.layout || cleanup?.layout || {};
        const hasCrop = hasPositiveCrop(layout.crop);
        const covered = (cleanup?.zones || []).length > 0
          ? cleanup.zones.every((zone) => cropCoversZone(layout, zone))
          : false;
        const xmlHasCrop = /<adjust-crop\b/.test(fcpxml);
        result.checks.push({ type: 'crop_reframe', ok: covered && hasCrop });
        result.checks.push({ type: 'fcpxml_crop', ok: xmlHasCrop });
        if (!covered || !hasCrop) {
          result.ok = false;
          result.status = 'unresolved';
          result.warnings.push('FCPXML crop/reframe 未证明已将目标区域移出最终构图。');
        }
        if (!xmlHasCrop) {
          result.ok = false;
          result.status = 'unresolved';
          result.warnings.push('最终 FCPXML 未写入 crop/reframe。');
        }
      } else if (report.status === 'generated') {
        const source = original?.projectAbsolutePath;
        const clean = derived?.projectAbsolutePath;
        const width = Number(original?.metadata?.width || original?.metadata?.displayWidth);
        const height = Number(original?.metadata?.height || original?.metadata?.displayHeight);
        const times = (cleanup?.timeRanges || [])
          .flatMap((range) => [range.startSec, Math.max(range.startSec, range.endSec - 0.05)])
          .filter((value, index, list) => Number.isFinite(value) && list.indexOf(value) === index)
          .slice(0, 4);
        if (!times.length && shot) {
          times.push(Number(shot.inSec) || 0);
          if (Number(shot.outSec) > Number(shot.inSec)) {
            times.push(Math.max(Number(shot.inSec) || 0, Number(shot.outSec) - 0.05));
          }
        }
        if (report.method === 'ffmpeg_mask_blur' || report.provider === 'ffmpeg-mask-blur') {
          result.ok = false;
          result.status = 'unresolved';
          result.warnings.push('低质量 blur/遮盖不得判定为 cleaned。');
        } else if (source && clean && width > 0 && height > 0 && times.length) {
          const pixelChecks = [];
          let qualityOk = true;
          let qualityReason = '';
          for (const timeSec of times) {
            const sample = await measurePixelChange(source, clean, timeSec, width, height, tempDirectory);
            const quality = assessDerivedQuality(sample, cleanup?.zones || [], width, height);
            pixelChecks.push({
              timeSec,
              changed: sample.changed,
              changedRatio: sample.changedRatio,
              qualityOk: quality.ok,
              reason: quality.reason || sample.reason,
              metrics: quality.metrics || null,
            });
            if (!quality.ok) {
              qualityOk = false;
              qualityReason = quality.reason || '派生媒体未通过质量复检。';
            }
          }
          result.checks.push({ type: 'pixel_change', ok: pixelChecks.some((item) => item.changed), samples: pixelChecks });
          result.checks.push({ type: 'visual_quality', ok: qualityOk, samples: pixelChecks });
          if (!qualityOk) {
            result.ok = false;
            result.status = 'unresolved';
            result.warnings.push(qualityReason);
          }
        } else {
          result.ok = false;
          result.status = 'unresolved';
          result.warnings.push('缺少可用于复检的派生媒体、尺寸或时间范围。');
        }
        const expectedUrl = derived?.projectAbsolutePath
          ? pathToFileURL(derived.projectAbsolutePath).href
            .replaceAll('&', '&amp;')
          : '';
        const referenced = Boolean(expectedUrl && fcpxml.includes(expectedUrl));
        result.checks.push({ type: 'fcpxml_reference', ok: referenced });
        if (!referenced) {
          result.ok = false;
          result.status = 'unresolved';
          result.warnings.push('最终 FCPXML 未引用 clean-media 派生媒体。');
        }
      } else if (report.decision === 'omit') {
        const onTimeline = Boolean(shot);
        result.ok = !onTimeline;
        result.status = 'unresolved';
        result.warnings.push(onTimeline
          ? '已决定不使用该素材，却仍出现在时间线。'
          : '覆盖物无法高质量净化，已不使用该素材。');
      } else if (report.status === 'fallback' || report.status === 'preserved' || report.decision === 'fallback_preserve') {
        result.ok = false;
        result.status = 'unresolved';
        result.warnings.push('该区域未被高质量清除，不能报告为 cleaned。');
      }
      result.resultStatus = resultStatusFor({ ...report, status: result.status }, result.ok);
      results.push(result);
    }
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
  return {
    ok: results.every((result) => result.ok),
    results,
    verifiedAt: new Date().toISOString(),
  };
}

module.exports = {
  CLEANUP_DECISIONS,
  CLEANUP_METHODS,
  CLEANUP_PROVIDERS,
  CLEANUP_RESULT_STATUSES,
  OVERLAY_TYPES,
  assessDerivedQuality,
  cleanupFingerprint,
  cropCoversZone,
  delogoFilter,
  delogoPlanEligible,
  inspectedNoneCleanup,
  isUsableInspectedFrame,
  maskBlurFilter,
  materializeCleanMedia,
  measurePixelChange,
  mergeCleanupLayout,
  normalizeCleanupPlan,
  requireVisualCleanupPlans,
  resolveCleanupPlan,
  verifyCleanupResults,
  validateCleanupPlan,
};
