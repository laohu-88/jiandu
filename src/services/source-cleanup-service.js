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
      ? plan.inspectedFrames.filter((item) => isNonEmptyString(item, 200)).slice(0, 40)
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
    && !['ffmpeg_delogo', 'ffmpeg_mask_blur', 'preserve'].includes(plan.method)) {
    errors.push(`${field}.decision 为 derived_media 时 method 必须是 ffmpeg_delogo、ffmpeg_mask_blur 或 preserve。`);
  }
  if (plan.decision === 'derived_media'
    && ['ffmpeg_delogo', 'ffmpeg_mask_blur'].includes(plan.method)
    && ['ffmpeg-delogo', 'ffmpeg-mask-blur'].includes(plan.provider)
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
  const isDelogo = normalized.provider === 'ffmpeg-delogo' && normalized.method === 'ffmpeg_delogo';
  const isMaskBlur = normalized.provider === 'ffmpeg-mask-blur' && normalized.method === 'ffmpeg_mask_blur';
  if (!isDelogo && !isMaskBlur) {
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
    const graph = isDelogo
      ? delogoFilter(normalized.zones, { ...mapping.metadata, timeRanges: normalized.timeRanges })
      : maskBlurFilter(normalized.zones);
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
  await runMediaTool('ffmpeg', args, { timeoutMs: 60_000, maxBuffer: 2 * 1024 * 1024 });
  return fs.readFile(outputPath);
}

async function measurePixelChange(sourcePath, cleanPath, timeSec, width, height, tempDirectory) {
  const sourceFrame = path.join(tempDirectory, 'source.rgb');
  const cleanFrame = path.join(tempDirectory, 'clean.rgb');
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
  };
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

async function verifyCleanupResults({ artifactRoot, analysis, mappings, cleanupReports, fcpxml = '' }) {
  const mappingById = new Map(mappings.map((mapping) => [mapping.assetId, mapping]));
  const results = [];
  const tempDirectory = await fs.mkdtemp(path.join(path.resolve(artifactRoot), '.cleanup-verify-'));
  try {
    for (const report of cleanupReports || []) {
      const shot = analysis.timeline.shots.find((item) => item.id === report.shotId);
      const cleanup = resolveCleanupPlan(shot, analysis.assets.find((item) => item.assetId === report.assetId));
      const original = mappingById.get(report.assetId);
      const derived = report.derivedAssetId ? mappingById.get(report.derivedAssetId) : null;
      const result = {
        shotId: report.shotId,
        assetId: report.assetId,
        status: report.status,
        ok: true,
        checks: [],
        warnings: [],
      };
      if (report.status === 'inspected_no_overlay') {
        result.checks.push({ type: 'inspection', ok: cleanup?.inspectedFrames?.length > 0 });
        if (!cleanup?.inspectedFrames?.length) {
          result.ok = false;
          result.warnings.push('cleanup=none 缺少实际检查帧记录。');
        }
      } else if (report.decision === 'crop_reframe') {
        const hasCrop = Object.values(shot?.layout?.crop || {}).some((value) => Number(value) > 0);
        const covered = cleanup?.zones?.length > 0
          ? cleanup.zones.every((zone) => cropCoversZone(shot.layout, zone))
          : hasCrop;
        result.checks.push({ type: 'crop_reframe', ok: covered });
        if (!covered) {
          result.ok = false;
          result.status = 'unresolved';
          result.warnings.push('FCPXML crop/reframe 未证明已将目标区域移出最终构图。');
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
        if (source && clean && width > 0 && height > 0 && times.length) {
          const pixelChecks = [];
          for (const timeSec of times) {
            pixelChecks.push({ timeSec, ...(await measurePixelChange(source, clean, timeSec, width, height, tempDirectory)) });
          }
          const changed = pixelChecks.some((item) => item.changed);
          result.checks.push({ type: 'pixel_change', ok: changed, samples: pixelChecks });
          if (!changed) {
            result.ok = false;
            result.status = 'unresolved';
            result.warnings.push('派生媒体抽帧与原帧没有真实像素变化。');
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
      } else if (report.status === 'fallback' || report.status === 'preserved') {
        result.ok = false;
        result.status = 'unresolved';
        result.warnings.push('该区域未被清除，不能报告为 cleaned。');
      }
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
  OVERLAY_TYPES,
  cleanupFingerprint,
  maskBlurFilter,
  delogoFilter,
  materializeCleanMedia,
  measurePixelChange,
  mergeCleanupLayout,
  normalizeCleanupPlan,
  resolveCleanupPlan,
  verifyCleanupResults,
  validateCleanupPlan,
};
