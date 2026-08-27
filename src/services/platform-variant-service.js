'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  VIDEO_ANALYSIS_FILE,
  VIDEO_MANIFEST_FILE,
  VIDEO_STATUS_FILE,
  DOUYIN_PLATFORM_PROFILE_FILE,
  EDITORIAL_REVIEW_FILE,
  INTERNAL_VIDEO_ANALYSIS_FILE,
  INTERNAL_VIDEO_MANIFEST_FILE,
  INTERNAL_VIDEO_STATUS_FILE,
  INTERNAL_PLATFORM_VARIANTS_FILE,
  INTERNAL_ARTIFACT_DIRS,
  PLATFORM_VARIANTS_DIR,
  PLATFORM_VARIANTS_FILE,
} = require('../constants');
const { internalArtifactRoot, resolveProjectArtifactRoot } = require('./project-artifact-paths');
const {
  assetNeedsLightCaption,
  listEligibleVisualItems,
} = require('./editing-contract-service');
const {
  buildEditorialReviewModel,
  getConfirmedCaptions,
} = require('./editorial-review-service');
const {
  frameDuration,
  sanitizeFcpFilename,
  validateFcpxmlStructure,
  writeFcpxml,
} = require('./fcpxml-service');
const { probeMedia, runMediaTool } = require('./media-tool-service');
const {
  compareSourceSnapshots,
  hashFile,
  snapshotSource,
} = require('./pending-media-service');
const { inferFps } = require('./video-format-service');
const {
  analyzeMediaSubjectTracking,
  normalizeTracking,
  validateTracking,
} = require('./subject-tracking-service');

const PLATFORM_VARIANT_SCHEMA_VERSION = 1;
const DOUYIN_PLAN_SCHEMA_VERSION = 1;
const DOUYIN_DECISIONS = new Set(['selected', 'separate', 'excluded']);
const DOUYIN_LAYOUT_MODES = new Set([
  'native_vertical',
  'center_crop',
  'landscape_card',
  'landscape_card_blur',
  'screen_focus',
  'screen_split',
  'segmented_focus',
  'subject_track',
]);
const DOUYIN_WARNING_TYPES = new Set([
  'watermark',
  'qr_code',
  'sensitive_content',
  'readability',
  'safe_zone',
  'critical_crop',
  'manual_review',
  'other',
]);
const DOUYIN_CAPTION_KINDS = new Set([
  'content',
  'context',
  'chapter_conclusion',
]);
const FORBIDDEN_DURATION_KEYS = new Set([
  'targetduration',
  'targetdurationsec',
  'durationrange',
  'suggestedduration',
  'suggesteddurationrange',
  'maxduration',
  'maxdurationsec',
  'targetshotcount',
  'fixedshotcount',
  'targetvideocount',
  'fixedvideocount',
  'maxvideos',
]);
const SELECTION_FACTOR_KEYS = Object.freeze([
  'visualAppeal',
  'standaloneStrength',
  'themeConsistency',
  'mobileFit',
  'verticalPerformance',
  'contextCost',
  'visualChange',
  'originalAudioValue',
  'repetition',
]);

function variantError(code, message, details = []) {
  return Object.assign(new Error(message), { code, details });
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmpty(value, maxLength = Infinity) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function safeId(value, fallback = '') {
  const normalized = String(value || fallback).trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(normalized)) {
    throw variantError('INVALID_PLATFORM_VARIANT_ID', `平台变体 ID 无效：${normalized || '空'}`);
  }
  return normalized;
}

function recordId(value, fallback = '') {
  const normalized = String(value || fallback).trim();
  if (!nonEmpty(normalized, 100) || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw variantError('INVALID_PLATFORM_VARIANT_RECORD_ID', '抖音规划记录 ID 无效。');
  }
  return normalized;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function readJson(filePath, label = path.basename(filePath)) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw variantError('INVALID_PLATFORM_VARIANT_JSON', `无法读取 ${label}：${error.message}`);
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function assertProjectDirectory(projectPath) {
  const resolved = path.resolve(String(projectPath || ''));
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw variantError('PROJECT_NOT_FOUND', `正式项目目录不存在：${resolved}`);
  }
  return resolved;
}

function validateProfile(profile) {
  const errors = [];
  if (profile?.schemaVersion !== 1) errors.push('抖音平台档案 schemaVersion 必须为 1。');
  if (profile?.platform !== 'douyin') errors.push('抖音平台档案 platform 必须为 douyin。');
  const format = profile?.format || {};
  if (format.aspectRatio !== '9:16'
    || format.orientation !== 'vertical'
    || format.width !== 1080
    || format.height !== 1920) {
    errors.push('抖音平台档案必须是 1080×1920、9:16 竖屏。');
  }
  if (format.dynamicRange !== 'SDR' || format.colorSpace !== 'Rec. 709') {
    errors.push('抖音平台档案必须是 SDR / Rec. 709。');
  }
  for (const key of ['subtitle', 'subject']) {
    const zone = profile?.safeZones?.[key];
    if (!validRect(zone)) errors.push(`safeZones.${key} 必须是 0–1 范围内的矩形。`);
  }
  for (const zone of asArray(profile?.uiOcclusionZones)) {
    if (!nonEmpty(zone?.id, 100) || !validRect(zone)) {
      errors.push('uiOcclusionZones 必须包含 ID 和有效矩形。');
    }
  }
  for (const mode of DOUYIN_LAYOUT_MODES) {
    if (!profile?.layouts?.[mode] && !profile?.advancedLayouts?.[mode]) {
      errors.push(`平台档案缺少布局：${mode}`);
    }
  }
  if (errors.length) {
    throw variantError('INVALID_DOUYIN_PROFILE', errors[0], errors);
  }
  return profile;
}

async function loadDouyinProfile(options = {}) {
  const profilePath = path.resolve(
    options.profilePath
      || path.join(__dirname, '..', '..', DOUYIN_PLATFORM_PROFILE_FILE),
  );
  const profile = validateProfile(await readJson(profilePath, '抖音平台档案'));
  return { profile, profilePath };
}

async function loadProjectBundle(projectPath, options = {}) {
  const resolved = await assertProjectDirectory(projectPath);
  const artifactRoot = await resolveProjectArtifactRoot(resolved);
  const internal = artifactRoot !== resolved
    && path.resolve(artifactRoot) !== path.resolve(path.join(resolved, '00-项目总控'));
  const names = internal ? {
    analysis: INTERNAL_VIDEO_ANALYSIS_FILE,
    manifest: INTERNAL_VIDEO_MANIFEST_FILE,
    status: INTERNAL_VIDEO_STATUS_FILE,
  } : {
    analysis: path.basename(VIDEO_ANALYSIS_FILE),
    manifest: path.basename(VIDEO_MANIFEST_FILE),
    status: path.basename(VIDEO_STATUS_FILE),
  };
  const [manifest, analysis, status, profileRecord] = await Promise.all([
    readJson(path.join(artifactRoot, names.manifest), 'Codex 视频素材清单'),
    readJson(path.join(artifactRoot, names.analysis), 'Codex 视频分析'),
    readJson(path.join(artifactRoot, names.status), 'Codex 视频状态'),
    loadDouyinProfile(options),
  ]);
  const mappings = asArray(status.assetMappings).filter((item) => item?.origin !== 'hyperframes');
  return {
    projectPath: resolved,
    artifactRoot,
    manifest,
    analysis,
    status,
    mappings,
    profile: profileRecord.profile,
    profilePath: profileRecord.profilePath,
  };
}

function defaultRegistry(projectPath) {
  return {
    schemaVersion: PLATFORM_VARIANT_SCHEMA_VERSION,
    projectPath,
    updatedAt: null,
    defaultMain: {
      storage: 'legacy-main',
      analysis: VIDEO_ANALYSIS_FILE,
      status: VIDEO_STATUS_FILE,
      untouchedByPlatformVariants: true,
    },
    variants: [],
  };
}

function validateRegistry(registry, projectPath) {
  if (!isObject(registry) || registry.schemaVersion !== PLATFORM_VARIANT_SCHEMA_VERSION) {
    throw variantError('INVALID_PLATFORM_VARIANTS', 'platform-variants.json schemaVersion 无效。');
  }
  if (!Array.isArray(registry.variants)) {
    throw variantError('INVALID_PLATFORM_VARIANTS', 'platform-variants.json variants 必须是数组。');
  }
  const ids = new Set();
  for (const variant of registry.variants) {
    const id = safeId(variant?.variantId);
    if (ids.has(id)) {
      throw variantError('INVALID_PLATFORM_VARIANTS', `平台变体 ID 重复：${id}`);
    }
    ids.add(id);
  }
  return {
    ...registry,
    projectPath,
    defaultMain: {
      ...defaultRegistry(projectPath).defaultMain,
      ...(registry.defaultMain || {}),
      untouchedByPlatformVariants: true,
    },
  };
}

async function readPlatformVariants(projectPath) {
  const resolved = await assertProjectDirectory(projectPath);
  const artifactRoot = await resolveProjectArtifactRoot(resolved);
  const internal = artifactRoot === internalArtifactRoot(resolved);
  const filePath = path.join(artifactRoot, internal ? INTERNAL_PLATFORM_VARIANTS_FILE : PLATFORM_VARIANTS_FILE);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return defaultRegistry(resolved);
  return validateRegistry(await readJson(filePath, 'platform-variants.json'), resolved);
}

async function writeRegistry(projectPath, registry) {
  const resolved = await assertProjectDirectory(projectPath);
  const artifactRoot = await resolveProjectArtifactRoot(resolved);
  const internal = artifactRoot === internalArtifactRoot(resolved);
  const payload = validateRegistry({
    ...registry,
    projectPath: resolved,
    updatedAt: new Date().toISOString(),
  }, resolved);
  await atomicWriteJson(path.join(artifactRoot, internal ? INTERNAL_PLATFORM_VARIANTS_FILE : PLATFORM_VARIANTS_FILE), payload);
  return payload;
}

function findVariant(registry, variantId) {
  const id = safeId(variantId);
  const variant = registry.variants.find((item) => item.variantId === id);
  if (!variant) {
    throw variantError('PLATFORM_VARIANT_NOT_FOUND', `找不到平台变体：${id}`);
  }
  return variant;
}

function findForbiddenPlanningKeys(value, trail = [], findings = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenPlanningKeys(item, [...trail, index], findings));
    return findings;
  }
  if (!isObject(value)) return findings;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
    if (FORBIDDEN_DURATION_KEYS.has(normalized) && child !== false) {
      findings.push([...trail, key].join('.'));
    }
    findForbiddenPlanningKeys(child, [...trail, key], findings);
  }
  return findings;
}

function validRect(rect) {
  if (!isObject(rect)) return false;
  const values = ['x', 'y', 'width', 'height'].map((key) => Number(rect[key]));
  if (!values.every(Number.isFinite)) return false;
  const [x, y, width, height] = values;
  return x >= 0 && y >= 0 && width > 0 && height > 0
    && x + width <= 1.000001 && y + height <= 1.000001;
}

function rectsIntersect(left, right) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function rectInside(inner, outer) {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

function normalizeCrop(crop) {
  const source = isObject(crop) ? crop : {};
  return {
    left: Number.isFinite(Number(source.left)) ? Number(source.left) : 0,
    top: Number.isFinite(Number(source.top)) ? Number(source.top) : 0,
    right: Number.isFinite(Number(source.right)) ? Number(source.right) : 0,
    bottom: Number.isFinite(Number(source.bottom)) ? Number(source.bottom) : 0,
  };
}

function normalizeRect(rect) {
  return validRect(rect) ? {
    x: Number(rect.x),
    y: Number(rect.y),
    width: Number(rect.width),
    height: Number(rect.height),
  } : null;
}

function normalizeLayout(layout, mode = 'native_vertical') {
  const source = isObject(layout) ? layout : {};
  const position = isObject(source.position) ? source.position : {};
  return {
    mode: DOUYIN_LAYOUT_MODES.has(source.mode) ? source.mode : mode,
    scale: Number.isFinite(Number(source.scale)) ? Number(source.scale) : 1,
    position: {
      x: Number.isFinite(Number(position.x)) ? Number(position.x) : 0,
      y: Number.isFinite(Number(position.y)) ? Number(position.y) : 0,
    },
    crop: normalizeCrop(source.crop),
    secondaryCrop: normalizeCrop(source.secondaryCrop),
    splitRatio: Number.isFinite(Number(source.splitRatio))
      ? Number(source.splitRatio)
      : 0.5,
    subjectBounds: normalizeRect(source.subjectBounds),
    sourceTextBounds: asArray(source.sourceTextBounds).map(normalizeRect).filter(Boolean),
    minReadableTextHeightPx: source.minReadableTextHeightPx != null
      && Number.isFinite(Number(source.minReadableTextHeightPx))
      ? Number(source.minReadableTextHeightPx)
      : null,
    agentNote: String(source.agentNote || '').trim(),
    tracking: normalizeTracking(source.tracking),
  };
}

function normalizeDouyinPlan(rawPlan) {
  const plan = structuredClone(rawPlan || {});
  plan.schemaVersion = plan.schemaVersion ?? DOUYIN_PLAN_SCHEMA_VERSION;
  plan.platform = 'douyin';
  plan.profileId = String(plan.profileId || 'douyin-vertical-v1');
  plan.planningPolicy = {
    fixedTargetDuration: false,
    fixedShotCount: false,
    fixedVideoCount: false,
    selectionDrivenByContent: true,
    ...(isObject(plan.planningPolicy) ? plan.planningPolicy : {}),
    fixedTargetDuration: false,
    fixedShotCount: false,
    fixedVideoCount: false,
  };
  plan.selection = asArray(plan.selection).map((item) => ({
    assetId: String(item?.assetId || ''),
    decision: String(item?.decision || ''),
    reason: String(item?.reason || '').trim(),
    selectedRanges: asArray(item?.selectedRanges).map((range) => ({
      startSec: Number(range?.startSec),
      endSec: Number(range?.endSec),
      reason: String(range?.reason || '').trim(),
    })),
    factors: Object.fromEntries(SELECTION_FACTOR_KEYS.map((key) => [
      key,
      Number.isFinite(Number(item?.factors?.[key])) ? Number(item.factors[key]) : 3,
    ])),
  }));
  plan.videos = asArray(plan.videos).map((video, videoIndex) => ({
    videoId: safeId(video?.videoId || `douyin-${videoIndex + 1}`),
    theme: String(video?.theme || '').trim(),
    rationale: String(video?.rationale || '').trim(),
    openingAssetId: String(video?.openingAssetId || ''),
    naturalEnding: String(video?.naturalEnding || '').trim(),
    shots: asArray(video?.shots).map((shot, shotIndex) => ({
      shotId: recordId(shot?.shotId || `${video?.videoId || `douyin-${videoIndex + 1}`}-shot-${shotIndex + 1}`),
      assetId: String(shot?.assetId || ''),
      inSec: Number(shot?.inSec),
      outSec: Number(shot?.outSec),
      purpose: String(shot?.purpose || '').trim(),
      audioMode: shot?.audioMode === 'mute' ? 'mute' : 'keep',
      muteReason: shot?.audioMode === 'mute'
        ? String(shot?.muteReason || '').trim()
        : null,
      layout: normalizeLayout(shot?.layout),
      agentLayout: normalizeLayout(shot?.agentLayout || shot?.layout),
    })),
    lightCaptions: asArray(video?.lightCaptions).map((caption, captionIndex) => ({
      captionId: recordId(caption?.captionId || `${video?.videoId || `douyin-${videoIndex + 1}`}-caption-${captionIndex + 1}`),
      assetId: String(caption?.assetId || ''),
      shotId: String(caption?.shotId || ''),
      text: String(caption?.text || '').trim(),
      offsetSec: Number(caption?.offsetSec),
      durationSec: Number(caption?.durationSec),
      position: String(caption?.position || 'bottom-safe'),
      purpose: String(caption?.purpose || 'clarify'),
      kind: DOUYIN_CAPTION_KINDS.has(caption?.kind)
        ? caption.kind
        : (/章节|结论|收束/.test(String(caption?.purpose || ''))
          ? 'chapter_conclusion'
          : (/背景|上下文|解释|翻译/.test(String(caption?.purpose || ''))
            ? 'context'
            : 'content')),
      basedOn: String(caption?.basedOn || '基础分析').trim(),
      required: caption?.required !== false,
      sourceLocked: caption?.sourceLocked === true,
    })),
    warnings: asArray(video?.warnings).map((warning, warningIndex) => ({
      warningId: recordId(warning?.warningId || `${video?.videoId || `douyin-${videoIndex + 1}`}-warning-${warningIndex + 1}`),
      type: DOUYIN_WARNING_TYPES.has(warning?.type) ? warning.type : 'other',
      assetId: warning?.assetId ? String(warning.assetId) : null,
      message: String(warning?.message || '').trim(),
    })),
  }));
  plan.createdBy = String(plan.createdBy || 'agent-shared-contract');
  plan.updatedAt = String(plan.updatedAt || new Date().toISOString());
  return plan;
}

function validateDouyinPlan(rawPlan, context = {}) {
  const plan = normalizeDouyinPlan(rawPlan);
  synchronizeAutomaticWarnings(plan, context);
  const errors = [];
  const manifest = context.manifest || { items: [] };
  const analysis = context.analysis || { assets: [] };
  const profile = context.profile;
  if (plan.schemaVersion !== DOUYIN_PLAN_SCHEMA_VERSION) {
    errors.push('抖音规划 schemaVersion 必须为 1。');
  }
  if (profile && plan.profileId !== profile.profileId) {
    errors.push(`抖音规划 profileId 必须为 ${profile.profileId}。`);
  }
  const forbidden = findForbiddenPlanningKeys(rawPlan);
  if (forbidden.length) {
    errors.push(`抖音规划不得包含固定时长、固定镜头数或固定成片数：${forbidden.join('、')}`);
  }
  if (plan.planningPolicy.fixedTargetDuration !== false
    || plan.planningPolicy.fixedShotCount !== false
    || plan.planningPolicy.fixedVideoCount !== false) {
    errors.push('抖音规划不得按固定目标时长、镜头数或成片数反推选材。');
  }

  const eligible = listEligibleVisualItems(manifest);
  const eligibleById = new Map(eligible.map((item) => [item.assetId, item]));
  const baseById = new Map(asArray(analysis.assets).map((item) => [item.assetId, item]));
  const selectionById = new Map();
  for (const [index, selection] of plan.selection.entries()) {
    if (!eligibleById.has(selection.assetId)) {
      errors.push(`selection[${index}].assetId 不在可用视觉素材中。`);
    }
    if (selectionById.has(selection.assetId)) errors.push(`素材 ${selection.assetId} 存在重复选材记录。`);
    selectionById.set(selection.assetId, selection);
    if (!DOUYIN_DECISIONS.has(selection.decision)) {
      errors.push(`素材 ${selection.assetId} 的 decision 无效。`);
    }
    if (!nonEmpty(selection.reason, 1000)) {
      errors.push(`素材 ${selection.assetId} 必须记录选用、另拆或排除原因。`);
    }
    for (const key of SELECTION_FACTOR_KEYS) {
      const value = selection.factors[key];
      if (!Number.isFinite(value) || value < 1 || value > 5) {
        errors.push(`素材 ${selection.assetId} 的 ${key} 必须是 1–5。`);
      }
    }
    for (const range of selection.selectedRanges) {
      if (!Number.isFinite(range.startSec)
        || !Number.isFinite(range.endSec)
        || range.startSec < 0
        || range.endSec <= range.startSec
        || !nonEmpty(range.reason, 500)) {
        errors.push(`素材 ${selection.assetId} 的使用时间范围无效或缺少原因。`);
      }
      const duration = Number(eligibleById.get(selection.assetId)?.metadata?.durationSec);
      if (Number.isFinite(duration) && range.endSec > duration + 0.05) {
        errors.push(`素材 ${selection.assetId} 的使用时间范围超出真实时长。`);
      }
    }
  }
  for (const item of eligible) {
    if (!selectionById.has(item.assetId)) errors.push(`素材 ${item.assetId} 缺少抖音选材结论。`);
  }

  if (plan.videos.length < 1) errors.push('抖音规划至少需要一条成片。');
  const videoIds = new Set();
  const shotIds = new Set();
  const usedIds = new Set();
  const requiredCaptionAssetIds = new Set(asArray(context.requiredCaptionAssetIds));
  for (const [videoIndex, video] of plan.videos.entries()) {
    const field = `videos[${videoIndex}]`;
    if (videoIds.has(video.videoId)) errors.push(`${field}.videoId 重复。`);
    videoIds.add(video.videoId);
    if (!nonEmpty(video.theme, 200)) errors.push(`${field}.theme 不能为空。`);
    if (!nonEmpty(video.rationale, 1000)) errors.push(`${field}.rationale 必须说明主题依据。`);
    if (!nonEmpty(video.naturalEnding, 500)) errors.push(`${field}.naturalEnding 必须记录自然结束点。`);
    if (video.shots.length < 1) errors.push(`${field}.shots 至少需要一个镜头。`);
    if (video.shots[0]?.assetId !== video.openingAssetId) {
      errors.push(`${field}.openingAssetId 必须等于第一个镜头素材。`);
    }
    const localShotIds = new Set();
    for (const [shotIndex, shot] of video.shots.entries()) {
      const shotField = `${field}.shots[${shotIndex}]`;
      if (shotIds.has(shot.shotId)) errors.push(`${shotField}.shotId 在变体中必须唯一。`);
      shotIds.add(shot.shotId);
      localShotIds.add(shot.shotId);
      const source = eligibleById.get(shot.assetId);
      if (!source) errors.push(`${shotField}.assetId 不在可用视觉素材中。`);
      usedIds.add(shot.assetId);
      if (!Number.isFinite(shot.inSec)
        || !Number.isFinite(shot.outSec)
        || shot.inSec < 0
        || shot.outSec <= shot.inSec) {
        errors.push(`${shotField} 的 inSec/outSec 无效。`);
      }
      if (source?.type === 'video'
        && Number.isFinite(source.metadata?.durationSec)
        && shot.outSec > source.metadata.durationSec + 0.05) {
        errors.push(`${shotField}.outSec 超出视频时长。`);
      }
      if (!nonEmpty(shot.purpose, 500)) errors.push(`${shotField}.purpose 不能为空。`);
      if (!DOUYIN_LAYOUT_MODES.has(shot.layout.mode)) errors.push(`${shotField}.layout.mode 无效。`);
      if (!Number.isFinite(shot.layout.scale) || shot.layout.scale < 0.1 || shot.layout.scale > 8) {
        errors.push(`${shotField}.layout.scale 必须在 0.1–8。`);
      }
      for (const key of ['x', 'y']) {
        if (!Number.isFinite(shot.layout.position[key])
          || Math.abs(shot.layout.position[key]) > 1) {
          errors.push(`${shotField}.layout.position.${key} 必须在 -1–1。`);
        }
      }
      const crop = shot.layout.crop;
      if (Object.values(crop).some((value) => !Number.isFinite(value) || value < 0 || value >= 1)
        || crop.left + crop.right >= 1
        || crop.top + crop.bottom >= 1) {
        errors.push(`${shotField}.layout.crop 是无效裁切。`);
      }
      const secondaryCrop = shot.layout.secondaryCrop;
      if (Object.values(secondaryCrop).some((value) => !Number.isFinite(value) || value < 0 || value >= 1)
        || secondaryCrop.left + secondaryCrop.right >= 1
        || secondaryCrop.top + secondaryCrop.bottom >= 1) {
        errors.push(`${shotField}.layout.secondaryCrop 是无效裁切。`);
      }
      if (!Number.isFinite(shot.layout.splitRatio)
        || shot.layout.splitRatio < 0.25
        || shot.layout.splitRatio > 0.75) {
        errors.push(`${shotField}.layout.splitRatio 必须在 0.25–0.75。`);
      }
      if (shot.layout.minReadableTextHeightPx != null
        && (!Number.isFinite(shot.layout.minReadableTextHeightPx)
          || shot.layout.minReadableTextHeightPx <= 0
          || shot.layout.minReadableTextHeightPx > 1000)) {
        errors.push(`${shotField}.layout.minReadableTextHeightPx 无效。`);
      }
      if (shot.layout.mode === 'subject_track') {
        if (!shot.layout.tracking) {
          errors.push(`${shotField}.layout.tracking 是动态主体跟踪布局的必填数据。`);
        } else {
          const trackingValidation = validateTracking(shot.layout.tracking, {
            fps: Number(context.fps) || Number(context.analysis?.timeline?.fps) || 30,
            inSec: shot.inSec,
            outSec: shot.outSec,
          });
          errors.push(...trackingValidation.errors.map((message) => `${shotField}：${message}`));
        }
      }
      if (source?.type === 'video' && source.metadata?.hasAudio && shot.audioMode === 'mute'
        && !nonEmpty(shot.muteReason, 500)) {
        errors.push(`${shotField} 静音必须记录明确原因。`);
      }
    }
    for (let shotIndex = 1; shotIndex < video.shots.length; shotIndex += 1) {
      const previous = video.shots[shotIndex - 1];
      const shot = video.shots[shotIndex];
      if (previous.assetId === shot.assetId
        && (previous.layout.mode === 'segmented_focus' || shot.layout.mode === 'segmented_focus')
        && Math.abs(previous.outSec - shot.inSec) > 0.001) {
        errors.push(
          `${field}.shots[${shotIndex - 1}] 与 shots[${shotIndex}] 是同源分段局部放大，源时间码必须连续。`,
        );
      }
    }
    const captionAssetIds = new Set();
    const captionIds = new Set();
    for (const [captionIndex, caption] of video.lightCaptions.entries()) {
      const captionField = `${field}.lightCaptions[${captionIndex}]`;
      if (captionIds.has(caption.captionId)) errors.push(`${captionField}.captionId 重复。`);
      captionIds.add(caption.captionId);
      const shot = video.shots.find((item) => item.shotId === caption.shotId);
      if (!shot || shot.assetId !== caption.assetId) {
        errors.push(`${captionField} 必须绑定本条成片中的对应镜头和素材。`);
      }
      if (!nonEmpty(caption.text, 40) || /[\r\n]/.test(caption.text)) {
        errors.push(`${captionField}.text 必须是一行 1–40 字轻字幕。`);
      }
      if (!Number.isFinite(caption.offsetSec) || caption.offsetSec < 0
        || !Number.isFinite(caption.durationSec) || caption.durationSec <= 0
        || (shot && caption.offsetSec + caption.durationSec > shot.outSec - shot.inSec + 0.05)) {
        errors.push(`${captionField} 的字幕时间超出所属镜头。`);
      }
      if (!profile?.subtitlePlacements?.[caption.position]) {
        errors.push(`${captionField}.position 不在平台档案中。`);
      }
      if (!DOUYIN_CAPTION_KINDS.has(caption.kind)) {
        errors.push(`${captionField}.kind 无效。`);
      }
      captionAssetIds.add(caption.assetId);
    }
    for (const assetId of new Set(video.shots.map((shot) => shot.assetId))) {
      if (requiredCaptionAssetIds.has(assetId) && !captionAssetIds.has(assetId)) {
        errors.push(`${field} 的素材 ${assetId} 应生成轻字幕但没有生成。`);
      }
    }
    const warningIds = new Set();
    for (const warning of video.warnings) {
      if (warningIds.has(warning.warningId)) errors.push(`${field}.warnings warningId 重复。`);
      warningIds.add(warning.warningId);
      if (!DOUYIN_WARNING_TYPES.has(warning.type) || !nonEmpty(warning.message, 1000)) {
        errors.push(`${field}.warnings 必须包含有效类型和人工确认说明。`);
      }
      if (warning.assetId && !eligibleById.has(warning.assetId)) {
        errors.push(`${field}.warnings 引用了不存在的素材。`);
      }
    }
  }

  for (const selection of plan.selection) {
    if (selection.decision === 'selected' && !usedIds.has(selection.assetId)) {
      errors.push(`素材 ${selection.assetId} 标为选用，但没有进入任何抖音成片。`);
    }
    if (selection.decision !== 'selected' && usedIds.has(selection.assetId)) {
      errors.push(`素材 ${selection.assetId} 标为另拆或排除，却进入了抖音成片。`);
    }
    const item = eligibleById.get(selection.assetId);
    if (item?.type === 'video' && selection.decision === 'selected') {
      const selectedShots = plan.videos.flatMap((video) => video.shots)
        .filter((shot) => shot.assetId === selection.assetId);
      const fullDuration = Number(item.metadata?.durationSec);
      const isTrimmed = Number.isFinite(fullDuration)
        && selectedShots.some((shot) => shot.inSec > 0.02 || shot.outSec < fullDuration - 0.02);
      if (isTrimmed && selection.selectedRanges.length === 0) {
        errors.push(`视频 ${selection.assetId} 使用精彩片段时必须在 selection.selectedRanges 记录范围和原因。`);
      }
    }
    const base = baseById.get(selection.assetId);
    if (selection.decision === 'excluded' && base?.status === 'adopt'
      && /时长|秒数|镜头数|成片数|不要太长/.test(selection.reason)) {
      errors.push(`素材 ${selection.assetId} 不得因固定时长或数量目标被排除。`);
    }
  }

  if (errors.length) {
    throw variantError('INVALID_DOUYIN_PLAN', `抖音规划校验失败：${errors[0]}`, errors);
  }
  return plan;
}

function isAdvancedScreenLayout(mode) {
  return mode === 'screen_focus' || mode === 'screen_split' || mode === 'segmented_focus';
}

function isDynamicTrackingLayout(mode) {
  return mode === 'subject_track';
}

function effectiveSourceTextHeightPx(layout, profile) {
  if (!Number.isFinite(layout.minReadableTextHeightPx)) return null;
  const cropHeight = Math.max(0.01, 1 - layout.crop.top - layout.crop.bottom);
  const displayRatio = layout.mode === 'screen_split'
    ? layout.splitRatio
    : 1;
  return layout.minReadableTextHeightPx * layout.scale * displayRatio / cropHeight;
}

function warningRecord(video, shot, type, suffix, message) {
  return {
    warningId: `${video.videoId}-${shot.shotId}-${suffix}`.slice(0, 100),
    type,
    assetId: shot.assetId,
    message,
  };
}

function automaticWarningsForVideo(video, context = {}) {
  const profile = context.profile || {};
  const analysisById = new Map(asArray(context.analysis?.assets)
    .map((item) => [item.assetId, item]));
  const warnings = [];
  for (const shot of video.shots) {
    const layout = shot.layout;
    if (isDynamicTrackingLayout(layout.mode) && layout.tracking) {
      const tracking = layout.tracking;
      if (tracking.status === 'low_confidence') {
        warnings.push(warningRecord(
          video,
          shot,
          'manual_review',
          'tracking-low-confidence',
          `镜头 ${shot.shotId} 的主体跟踪置信度为 ${tracking.confidence.toFixed(2)}；必须人工确认、修正或切换静态布局。`,
        ));
      }
      if (tracking.status === 'failed') {
        warnings.push(warningRecord(
          video,
          shot,
          'manual_review',
          'tracking-failed',
          `镜头 ${shot.shotId} 主体跟踪失败：${tracking.fallback.reason || '没有可靠轨迹'}。`,
        ));
      }
      if (tracking.status === 'fallback') {
        warnings.push(warningRecord(
          video,
          shot,
          'manual_review',
          'tracking-fallback',
          `镜头 ${shot.shotId} 已安全降级为 ${tracking.fallback.mode}：${tracking.fallback.reason}`,
        ));
      }
    }
    if (isAdvancedScreenLayout(layout.mode) && !layout.subjectBounds) {
      warnings.push(warningRecord(
        video,
        shot,
        'critical_crop',
        'critical-crop',
        `镜头 ${shot.shotId} 使用高级录屏布局，但尚未标记关键区域；需人工确认关键文字和操作没有被裁切。`,
      ));
    }
    const readableHeight = effectiveSourceTextHeightPx(layout, profile);
    if (readableHeight != null && readableHeight < 24) {
      warnings.push(warningRecord(
        video,
        shot,
        'readability',
        'small-text',
        `镜头 ${shot.shotId} 的界面小字预计仅约 ${readableHeight.toFixed(1)}px，手机上可能不可读。`,
      ));
    } else if (isAdvancedScreenLayout(layout.mode) && readableHeight == null) {
      warnings.push(warningRecord(
        video,
        shot,
        'readability',
        'unknown-text-size',
        `镜头 ${shot.shotId} 的界面文字尺寸无法可靠判断，需在手机尺寸预览中人工确认。`,
      ));
    }
    if ((layout.mode === 'landscape_card' || layout.mode === 'landscape_card_blur')
      && layout.scale < 0.85) {
      warnings.push(warningRecord(
        video,
        shot,
        'readability',
        'small-card',
        `镜头 ${shot.shotId} 的横屏卡片有效显示面积偏小，需人工确认界面文字可读。`,
      ));
    }
    const base = analysisById.get(shot.assetId);
    const text = [
      base?.contentSummary,
      ...asArray(base?.warnings),
      ...asArray(base?.visualTextAnalysis?.warnings),
    ].filter(Boolean).join(' ');
    if (/(?:\/Users\/|\/home\/|[A-Z]:\\|账号|邮箱|email|token|api.?key|密钥|手机号|身份证|密码|credential)/i.test(text)) {
      warnings.push(warningRecord(
        video,
        shot,
        'sensitive_content',
        'sensitive-screen',
        `镜头 ${shot.shotId} 的开发录屏可能暴露路径、账号或凭据；不得自动删除，需人工查看原画确认。`,
      ));
    }
  }
  return warnings;
}

function synchronizeAutomaticWarnings(plan, context = {}) {
  for (const video of plan.videos) {
    const manual = video.warnings.filter((warning) => (
      !/-(?:critical-crop|small-text|unknown-text-size|small-card|sensitive-screen)$/
        .test(warning.warningId)
    ));
    const automatic = automaticWarningsForVideo(video, context);
    const byId = new Map([...manual, ...automatic].map((warning) => [warning.warningId, warning]));
    video.warnings = [...byId.values()];
  }
  return plan;
}

function orientationOf(item) {
  const width = Number(item?.metadata?.displayWidth || item?.metadata?.width);
  const height = Number(item?.metadata?.displayHeight || item?.metadata?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 'unknown';
  if (height > width) return 'vertical';
  if (width > height) return 'horizontal';
  return 'square';
}

function looksLikeScreenRecording(item, baseAsset) {
  return item?.type === 'video' && /录屏|屏幕录制|screen.?record|ide|终端|terminal/i.test([
    item?.filename,
    baseAsset?.contentSummary,
    ...asArray(baseAsset?.semanticLabels),
    ...asArray(baseAsset?.suggestedUse),
  ].filter(Boolean).join(' '));
}

function defaultLayoutForItem(item, baseAsset) {
  const orientation = orientationOf(item);
  if (orientation === 'vertical') return normalizeLayout({ mode: 'native_vertical' });
  if (orientation === 'horizontal' && looksLikeScreenRecording(item, baseAsset)) {
    const layout = normalizeLayout({
      mode: 'screen_focus',
      crop: { left: 0.08, top: 0.08, right: 0.08, bottom: 0.08 },
      subjectBounds: null,
      agentNote: '检测为横屏录屏；建议在规划确认页把裁切框对准本镜头的关键操作区域。',
    });
    return layout;
  }
  if (orientation === 'horizontal') return normalizeLayout({ mode: 'landscape_card_blur' });
  return normalizeLayout({
    mode: 'landscape_card_blur',
    agentNote: '素材方向不确定，先完整显示并保留人工确认，不自动假设中央裁切安全。',
  });
}

function defaultSelectionFactors(item, baseAsset) {
  const confidence = Number(baseAsset?.confidence);
  const contextFiles = asArray(item?.context?.files).length;
  const vertical = orientationOf(item) === 'vertical';
  const duplicate = /重复|duplicate/i.test(String(baseAsset?.reason || ''));
  return {
    visualAppeal: Number.isFinite(confidence) ? Math.max(1, Math.min(5, Math.round(confidence * 5))) : 3,
    standaloneStrength: contextFiles > 1 ? 2 : 4,
    themeConsistency: baseAsset?.status === 'adopt' ? 5 : 3,
    mobileFit: vertical ? 5 : 3,
    verticalPerformance: vertical ? 5 : 3,
    contextCost: contextFiles > 1 ? 2 : 4,
    visualChange: item?.type === 'video' ? 4 : 3,
    originalAudioValue: item?.metadata?.hasAudio ? 5 : 1,
    repetition: duplicate ? 1 : 4,
  };
}

function selectionDecision(baseAsset) {
  if (baseAsset?.status === 'reject') return 'excluded';
  if (baseAsset?.status === 'candidate') return 'separate';
  return 'selected';
}

function selectionReason(item, baseAsset, decision) {
  const baseReason = String(baseAsset?.reason || '').trim();
  if (decision === 'selected') {
    return `${baseReason || '基础分析确认可用'}；画面可独立成立，并可通过竖屏布局适配手机观看。`;
  }
  if (decision === 'separate') {
    return `${baseReason || '与当前主题关联较弱'}；建议另拆一条，避免强行与当前主题拼接。`;
  }
  return `${baseReason || '画面吸引力、主题一致性或重复程度不适合本次抖音成片'}；排除原因与固定时长、镜头数和成片数无关。`;
}

function baseShotsForAsset(analysis, item) {
  const shots = asArray(analysis?.timeline?.shots).filter((shot) => shot.assetId === item.assetId);
  if (shots.length) return shots;
  const duration = item.type === 'video' && Number.isFinite(Number(item.metadata?.durationSec))
    ? Number(item.metadata.durationSec)
    : 2;
  return [{
    id: `${item.assetId}-source`,
    assetId: item.assetId,
    inSec: 0,
    outSec: duration,
    durationSec: duration,
    audioMode: 'keep',
    purpose: '展示素材',
  }];
}

function buildRequiredCaptions(bundle, selectedIds, confirmedCaptions = []) {
  const selected = new Set(selectedIds);
  const confirmedByKey = new Map(
    confirmedCaptions.map((caption) => [`${caption.assetId}:${caption.captionId}`, caption]),
  );
  const captions = [];
  for (const suggestion of asArray(bundle.analysis.lightCaptionPlan)) {
    if (!selected.has(suggestion.assetId)) continue;
    const confirmed = confirmedByKey.get(`${suggestion.assetId}:${suggestion.captionId}`);
    if (confirmed) {
      captions.push({
        ...suggestion,
        text: confirmed.text,
        startTime: confirmed.startTime ?? suggestion.startTime ?? 0,
        endTime: confirmed.endTime ?? suggestion.endTime ?? null,
        basedOn: confirmed.basedOn || suggestion.basedOn || '人工审核字幕',
        sourceLocked: true,
      });
      confirmedByKey.delete(`${suggestion.assetId}:${suggestion.captionId}`);
    } else {
      captions.push({ ...suggestion, sourceLocked: false });
    }
  }
  for (const confirmed of confirmedByKey.values()) {
    if (!selected.has(confirmed.assetId)) continue;
    captions.push({
      captionId: confirmed.captionId,
      assetId: confirmed.assetId,
      text: confirmed.text,
      startTime: confirmed.startTime ?? 0,
      endTime: confirmed.endTime ?? null,
      purpose: confirmed.purpose || 'clarify',
      basedOn: confirmed.basedOn || '人工审核字幕',
      sourceLocked: true,
    });
  }
  return captions;
}

function captionKindForPurpose(purpose) {
  return /章节|结论|收束/.test(String(purpose || ''))
    ? 'chapter_conclusion'
    : (/背景|上下文|解释|翻译/.test(String(purpose || ''))
      ? 'context'
      : 'content');
}

function recommendedCaptionPosition(profile, shot, kind) {
  if (kind === 'chapter_conclusion') return 'center';
  if (kind === 'context' || shot.layout.mode === 'screen_split') return 'top-safe';
  const bottom = profile.subtitlePlacements['bottom-safe'];
  if (shot.layout.sourceTextBounds.some((rect) => rectsIntersect(rect, bottom))) return 'top-safe';
  return 'bottom-safe';
}

async function createAutomaticDouyinPlan(bundle) {
  const editorialModel = await buildEditorialReviewModel(bundle.projectPath, {
    analysis: bundle.analysis,
    manifest: bundle.manifest,
    status: bundle.status,
  }).catch(() => null);
  const confirmed = editorialModel
    ? getConfirmedCaptions(editorialModel, { analysis: bundle.analysis })
    : [];
  const eligible = listEligibleVisualItems(bundle.manifest);
  const baseById = new Map(asArray(bundle.analysis.assets).map((item) => [item.assetId, item]));
  const selection = eligible.map((item) => {
    const base = baseById.get(item.assetId);
    const decision = selectionDecision(base);
    const ranges = decision === 'selected' && item.type === 'video'
      ? baseShotsForAsset(bundle.analysis, item)
        .filter((shot) => {
          const duration = Number(item.metadata?.durationSec);
          return Number.isFinite(duration)
            && (Number(shot.inSec) > 0.02 || Number(shot.outSec) < duration - 0.02);
        })
        .map((shot) => ({
          startSec: Number(shot.inSec),
          endSec: Number(shot.outSec),
          reason: base?.videoPreservationPlan?.trimReason
            || '基础分析已记录为精彩片段，抖音变体沿用该实际时间范围。',
        }))
      : [];
    return {
      assetId: item.assetId,
      decision,
      reason: selectionReason(item, base, decision),
      selectedRanges: ranges,
      factors: defaultSelectionFactors(item, base),
    };
  });
  const selected = selection.filter((item) => item.decision === 'selected').map((item) => item.assetId);
  const eligibleById = new Map(eligible.map((item) => [item.assetId, item]));
  const selectedItems = selected.map((assetId) => eligibleById.get(assetId)).filter(Boolean);
  const chapterKeys = [...new Set(selectedItems.map((item) => item.chapterId || 'single-theme'))];
  const groups = chapterKeys.map((chapterId) => ({
    chapterId,
    items: selectedItems.filter((item) => (item.chapterId || 'single-theme') === chapterId),
  })).filter((group) => group.items.length > 0);
  const baseChapterById = new Map(asArray(bundle.analysis.chapters)
    .map((chapter) => [chapter.chapterId, chapter]));
  const requiredCaptions = buildRequiredCaptions(bundle, selected, confirmed);
  const videos = groups.map((group, groupIndex) => {
    const videoId = `douyin-${groupIndex + 1}`;
    const itemIds = new Set(group.items.map((item) => item.assetId));
    const shots = asArray(bundle.analysis.timeline?.shots)
      .filter((shot) => itemIds.has(shot.assetId))
      .map((shot, shotIndex) => {
        const item = eligibleById.get(shot.assetId);
        const source = baseById.get(shot.assetId);
        return {
          shotId: `${videoId}-shot-${shotIndex + 1}`,
          assetId: shot.assetId,
          inSec: Number(shot.inSec),
          outSec: Number(shot.outSec),
          purpose: shot.purpose || source?.contentSummary || '展示画面',
          audioMode: item?.type === 'video' && item.metadata?.hasAudio
            ? (shot.audioMode === 'mute' ? 'mute' : 'keep')
            : 'keep',
          muteReason: shot.audioMode === 'mute'
            ? source?.audioAnalysis?.muteReason || '基础分析明确要求静音'
            : null,
          layout: defaultLayoutForItem(item, source),
        };
      });
    if (!shots.length) {
      for (const item of group.items) {
        for (const sourceShot of baseShotsForAsset(bundle.analysis, item)) {
          shots.push({
            shotId: `${videoId}-shot-${shots.length + 1}`,
            assetId: item.assetId,
            inSec: Number(sourceShot.inSec),
            outSec: Number(sourceShot.outSec),
            purpose: sourceShot.purpose || '展示画面',
            audioMode: item.type === 'video' && item.metadata?.hasAudio ? 'keep' : 'keep',
            muteReason: null,
            layout: defaultLayoutForItem(item, baseById.get(item.assetId)),
          });
        }
      }
    }
    const chapter = baseChapterById.get(group.chapterId);
    const theme = chapter?.chapterName
      || (groups.length === 1 ? bundle.analysis.theme?.summary : `主题 ${groupIndex + 1}`)
      || `抖音成片 ${groupIndex + 1}`;
    const lightCaptions = [];
    for (const caption of requiredCaptions.filter((item) => itemIds.has(item.assetId))) {
      const shot = shots.find((item) => (
        item.assetId === caption.assetId
        && Number(caption.startTime ?? 0) >= item.inSec - 0.05
        && Number(caption.startTime ?? 0) < item.outSec + 0.05
      )) || shots.find((item) => item.assetId === caption.assetId);
      if (!shot) continue;
      const offsetSec = Math.max(0, Number(caption.startTime ?? shot.inSec) - shot.inSec);
      const maxDuration = Math.max(0.2, shot.outSec - shot.inSec - offsetSec);
      const requestedDuration = Number(caption.endTime) > Number(caption.startTime)
        ? Number(caption.endTime) - Number(caption.startTime)
        : 2;
      const kind = captionKindForPurpose(caption.purpose);
      lightCaptions.push({
        captionId: recordId(caption.captionId),
        assetId: caption.assetId,
        shotId: shot.shotId,
        text: String(caption.text || '').slice(0, 40),
        offsetSec,
        durationSec: Math.min(requestedDuration, maxDuration),
        position: recommendedCaptionPosition(bundle.profile, shot, kind),
        purpose: caption.purpose || 'clarify',
        kind,
        basedOn: caption.basedOn || '基础分析',
        required: true,
        sourceLocked: caption.sourceLocked === true,
      });
    }
    const warnings = [];
    for (const item of group.items) {
      const base = baseById.get(item.assetId);
      const warningText = [
        ...asArray(base?.warnings),
        ...asArray(base?.visualTextAnalysis?.warnings),
        String(base?.contentSummary || ''),
      ].join(' ');
      const type = /二维码|qr.?code/i.test(warningText)
        ? 'qr_code'
        : /水印|watermark/i.test(warningText)
          ? 'watermark'
          : /敏感|隐私|暴力|裸露|sensitive/i.test(warningText)
            ? 'sensitive_content'
            : null;
      if (type) {
        warnings.push({
          warningId: `${videoId}-warning-${warnings.length + 1}`,
          type,
          assetId: item.assetId,
          message: `${item.filename} 检测到需要人工确认的${type === 'qr_code' ? '二维码' : type === 'watermark' ? '水印' : '敏感内容'}风险。`,
        });
      }
    }
    return {
      videoId,
      theme,
      rationale: groups.length > 1
        ? '按素材章节与主题独立成立程度拆分，避免把 HotIngest 趣味素材与开发记录强行拼接。'
        : '围绕共享基础分析中的一致主题组织，不按固定时长或镜头数删减。',
      openingAssetId: shots[0]?.assetId || '',
      naturalEnding: shots.length
        ? `以 ${eligibleById.get(shots.at(-1).assetId)?.filename || shots.at(-1).assetId} 的完整信息点自然结束。`
        : '在主题信息完成处自然结束。',
      shots,
      lightCaptions,
      warnings,
    };
  });
  return normalizeDouyinPlan({
    schemaVersion: DOUYIN_PLAN_SCHEMA_VERSION,
    platform: 'douyin',
    profileId: bundle.profile.profileId,
    planningPolicy: {
      fixedTargetDuration: false,
      fixedShotCount: false,
      fixedVideoCount: false,
      selectionDrivenByContent: true,
    },
    selection,
    videos,
    createdBy: 'local-shared-analysis',
  });
}

function requiredCaptionAssetIds(bundle, confirmed = []) {
  const required = new Set(confirmed.map((caption) => caption.assetId));
  const baseById = new Map(asArray(bundle.analysis.assets).map((item) => [item.assetId, item]));
  for (const item of listEligibleVisualItems(bundle.manifest)) {
    if (assetNeedsLightCaption(baseById.get(item.assetId), item)) required.add(item.assetId);
  }
  return [...required];
}

async function planValidationContext(bundle) {
  const editorialModel = await buildEditorialReviewModel(bundle.projectPath, {
    analysis: bundle.analysis,
    manifest: bundle.manifest,
    status: bundle.status,
  }).catch(() => null);
  const confirmed = editorialModel
    ? getConfirmedCaptions(editorialModel, { analysis: bundle.analysis })
    : [];
  return {
    manifest: bundle.manifest,
    analysis: bundle.analysis,
    profile: bundle.profile,
    requiredCaptionAssetIds: requiredCaptionAssetIds(bundle, confirmed),
  };
}

async function createDouyinVariant(projectPath, options = {}) {
  const bundle = await loadProjectBundle(projectPath, options);
  const registry = await readPlatformVariants(bundle.projectPath);
  const variantId = safeId(options.variantId || 'douyin');
  if (registry.variants.some((item) => item.variantId === variantId)) {
    throw variantError('PLATFORM_VARIANT_EXISTS', `平台变体已存在：${variantId}`);
  }
  const sourcePlan = options.plan
    || bundle.analysis?.platformVariants?.douyin
    || await createAutomaticDouyinPlan(bundle);
  const plan = validateDouyinPlan(sourcePlan, await planValidationContext(bundle));
  const now = new Date().toISOString();
  const variant = {
    schemaVersion: PLATFORM_VARIANT_SCHEMA_VERSION,
    variantId,
    platform: 'douyin',
    profileId: bundle.profile.profileId,
    profilePath: DOUYIN_PLATFORM_PROFILE_FILE,
    revision: 1,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    createdBy: plan.createdBy,
    plan,
    approval: null,
    outputs: [],
    previousOutputs: [],
  };
  const next = await writeRegistry(bundle.projectPath, {
    ...registry,
    variants: [...registry.variants, variant],
  });
  return findVariant(next, variantId);
}

async function readDouyinVariant(projectPath, variantId = 'douyin', options = {}) {
  const bundle = await loadProjectBundle(projectPath, options);
  const registry = await readPlatformVariants(bundle.projectPath);
  const variant = findVariant(registry, variantId);
  if (variant.platform !== 'douyin') {
    throw variantError('INVALID_PLATFORM_VARIANT', `${variant.variantId} 不是抖音变体。`);
  }
  return {
    ...variant,
    profile: bundle.profile,
    projectPath: bundle.projectPath,
    assets: listEligibleVisualItems(bundle.manifest).map((item) => {
      const mapping = bundle.mappings.find((entry) => entry.assetId === item.assetId);
      const mediaPath = mapping?.projectAbsolutePath || null;
      return {
        assetId: item.assetId,
        type: item.type,
        filename: item.filename || mapping?.projectFilename || item.assetId,
        metadata: item.metadata || {},
        mediaPath,
        fileUrl: mediaPath ? pathToFileURL(mediaPath).href : null,
      };
    }),
  };
}

async function saveDouyinVariantDraft(projectPath, variantId, rawPlan, options = {}) {
  const bundle = await loadProjectBundle(projectPath, options);
  const registry = await readPlatformVariants(bundle.projectPath);
  const current = findVariant(registry, variantId);
  if (options.expectedRevision != null && Number(options.expectedRevision) !== current.revision) {
    throw variantError('PLATFORM_VARIANT_REVISION_CONFLICT', '抖音规划已被其他操作更新，请刷新后重试。');
  }
  const plan = validateDouyinPlan(rawPlan, await planValidationContext(bundle));
  const nextVariant = {
    ...current,
    revision: current.revision + 1,
    status: 'draft',
    updatedAt: new Date().toISOString(),
    plan,
    approval: null,
    previousOutputs: [
      ...asArray(current.previousOutputs),
      ...(asArray(current.outputs).length ? [{
        revision: current.revision,
        outputs: current.outputs,
        archivedAt: new Date().toISOString(),
      }] : []),
    ],
    outputs: [],
  };
  const next = await writeRegistry(bundle.projectPath, {
    ...registry,
    variants: registry.variants.map((item) => (
      item.variantId === current.variantId ? nextVariant : item
    )),
  });
  return findVariant(next, current.variantId);
}

function allWarningIds(plan) {
  return plan.videos.flatMap((video) => video.warnings.map((warning) => warning.warningId));
}

async function approveDouyinVariant(projectPath, variantId = 'douyin', options = {}) {
  const bundle = await loadProjectBundle(projectPath, options);
  const registry = await readPlatformVariants(bundle.projectPath);
  const current = findVariant(registry, variantId);
  const plan = validateDouyinPlan(current.plan, await planValidationContext(bundle));
  const approvedWarningIds = [...new Set(asArray(options.approvedWarningIds).map(String))];
  const missingWarnings = allWarningIds(plan).filter((id) => !approvedWarningIds.includes(id));
  if (missingWarnings.length) {
    throw variantError(
      'DOUYIN_WARNINGS_NOT_APPROVED',
      `仍有人工确认警告未批准：${missingWarnings.join('、')}`,
      missingWarnings,
    );
  }
  const approval = {
    approvedAt: new Date().toISOString(),
    approvedBy: String(options.approvedBy || 'app-user'),
    revision: current.revision,
    planHash: stableHash(plan),
    approvedWarningIds,
  };
  const nextVariant = {
    ...current,
    status: 'approved',
    updatedAt: approval.approvedAt,
    plan,
    approval,
  };
  const next = await writeRegistry(bundle.projectPath, {
    ...registry,
    variants: registry.variants.map((item) => (
      item.variantId === current.variantId ? nextVariant : item
    )),
  });
  return findVariant(next, current.variantId);
}

function cutAnalysis(bundle, variant, video, fps) {
  const baseById = new Map(asArray(bundle.analysis.assets).map((item) => [item.assetId, item]));
  const usedIds = [...new Set(video.shots.map((shot) => shot.assetId))];
  let cursor = 0;
  const shotStarts = new Map();
  const shots = video.shots.map((shot) => {
    const durationSec = Number((shot.outSec - shot.inSec).toFixed(6));
    shotStarts.set(shot.shotId, cursor);
    cursor += durationSec;
    return {
      id: shot.shotId,
      assetId: shot.assetId,
      inSec: shot.inSec,
      outSec: shot.outSec,
      durationSec,
      fitMode: shot.layout.mode === 'center_crop' ? 'cover' : 'contain',
      audioMode: shot.audioMode,
      purpose: shot.purpose,
      confidence: 1,
      reviewRequired: false,
      layout: shot.layout,
    };
  });
  const markers = video.lightCaptions.map((caption) => ({
    id: caption.captionId,
    timeSec: Number((shotStarts.get(caption.shotId) + caption.offsetSec).toFixed(6)),
    text: caption.text.slice(0, 30),
    type: 'light-subtitle',
  }));
  return {
    schemaVersion: 1,
    theme: {
      summary: video.theme,
      rationale: video.rationale,
      confidence: 1,
      folderNameConflict: false,
    },
    titles: {
      candidates: [video.theme, `${video.theme} · 抖音`],
      recommended: video.theme,
      rationale: video.rationale,
    },
    assets: usedIds.map((assetId) => ({
      ...(baseById.get(assetId) || {}),
      assetId,
      status: 'adopt',
      reason: variant.plan.selection.find((item) => item.assetId === assetId)?.reason
        || baseById.get(assetId)?.reason
        || '抖音规划已批准选用。',
    })),
    lightCaptionPlan: video.lightCaptions.map((caption) => ({
      captionId: caption.captionId,
      assetId: caption.assetId,
      text: caption.text,
      purpose: caption.purpose,
      basedOn: caption.basedOn,
      required: caption.required,
      sourceLocked: caption.sourceLocked,
    })),
    timeline: {
      orientation: 'vertical',
      width: bundle.profile.format.width,
      height: bundle.profile.format.height,
      fps,
      shots,
      markers,
    },
  };
}

function managedTitlesForCut(profile, video, analysis) {
  const shotStarts = new Map();
  let cursor = 0;
  for (const shot of analysis.timeline.shots) {
    shotStarts.set(shot.id, cursor);
    cursor += shot.durationSec;
  }
  return video.lightCaptions.map((caption) => {
    const placement = profile.subtitlePlacements[caption.position];
    const fontSize = caption.kind === 'chapter_conclusion'
      ? 68
      : caption.kind === 'context'
        ? 50
        : 58;
    return {
      titleKey: `douyin:${video.videoId}:${caption.captionId}`,
      captionId: caption.captionId,
      assetId: caption.assetId,
      matchedShotId: caption.shotId,
      startSec: Number((shotStarts.get(caption.shotId) + caption.offsetSec).toFixed(6)),
      durationSec: caption.durationSec,
      text: caption.text,
      position: caption.position,
      captionKind: caption.kind,
      fontSize,
      transform: placement.fcpTransform,
      note: `vcp-managed-caption:douyin:${video.videoId}:${caption.captionId}`,
    };
  });
}

function cropFilter(layoutOrCrop) {
  const crop = layoutOrCrop?.crop || layoutOrCrop;
  if (![crop.left, crop.top, crop.right, crop.bottom].some((value) => value > 0)) return '';
  const width = Number((1 - crop.left - crop.right).toFixed(6));
  const height = Number((1 - crop.top - crop.bottom).toFixed(6));
  return `crop=iw*${width}:ih*${height}:iw*${crop.left}:ih*${crop.top},`;
}

function overlayExpression(layout, width, height) {
  const xOffset = Number((layout.position.x * width * 0.5).toFixed(4));
  const yOffset = Number((layout.position.y * height * 0.5).toFixed(4));
  return {
    x: `(W-w)/2+${xOffset}`,
    y: `(H-h)/2+${yOffset}`,
  };
}

function interpolateTrackingExpression(keyframes, valueAt, fallback, sourceInSec) {
  if (!keyframes.length) return String(fallback);
  if (keyframes.length === 1) return String(valueAt(keyframes[0]));
  const segments = [];
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const left = keyframes[index];
    const right = keyframes[index + 1];
    const start = Number((left.sourceTimeSec - sourceInSec).toFixed(6));
    const end = Number((right.sourceTimeSec - sourceInSec).toFixed(6));
    const leftValue = Number(valueAt(left).toFixed(6));
    const rightValue = Number(valueAt(right).toFixed(6));
    const duration = Math.max(0.000001, end - start);
    segments.push({
      end,
      expression: `${leftValue}+(${rightValue}-${leftValue})*(t-${start})/${duration}`,
    });
  }
  let expression = String(Number(valueAt(keyframes.at(-1)).toFixed(6)));
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    expression = `if(lt(t,${segments[index].end}),${segments[index].expression},${expression})`;
  }
  return expression;
}

function trackingExpressions(shot, width, height) {
  const keyframes = asArray(shot.layout.tracking?.keyframes)
    .filter((item) => Number.isFinite(item?.sourceTimeSec))
    .sort((left, right) => left.sourceTimeSec - right.sourceTimeSec);
  return {
    x: interpolateTrackingExpression(
      keyframes,
      (item) => item.position.x * width * 0.5,
      shot.layout.position.x * width * 0.5,
      shot.inSec,
    ),
    y: interpolateTrackingExpression(
      keyframes,
      (item) => item.position.y * height * 0.5,
      shot.layout.position.y * height * 0.5,
      shot.inSec,
    ),
    scale: interpolateTrackingExpression(
      keyframes,
      (item) => item.scale,
      shot.layout.scale,
      shot.inSec,
    ),
  };
}

function douyinVideoFilters(shot, width, height, fps, inputIndex) {
  const layout = shot.layout;
  const duration = Number((shot.outSec - shot.inSec).toFixed(6));
  const crop = cropFilter(layout);
  if (layout.mode === 'screen_split') {
    const topHeight = Math.max(2, Math.round(height * layout.splitRatio / 2) * 2);
    const bottomHeight = height - topHeight;
    const topCrop = cropFilter(layout.crop);
    const bottomCrop = cropFilter(layout.secondaryCrop);
    return [
      `[${inputIndex}:v]split=2[topraw${inputIndex}][bottomraw${inputIndex}]`,
      `[topraw${inputIndex}]${topCrop}scale=${width}:${topHeight}:force_original_aspect_ratio=increase,`
      + `crop=${width}:${topHeight},setsar=1[top${inputIndex}]`,
      `[bottomraw${inputIndex}]${bottomCrop}scale=${width}:${bottomHeight}:force_original_aspect_ratio=increase,`
      + `crop=${width}:${bottomHeight},setsar=1[bottom${inputIndex}]`,
      `[top${inputIndex}][bottom${inputIndex}]vstack=inputs=2,fps=${fps},trim=duration=${duration},`
      + `setpts=PTS-STARTPTS[v${inputIndex}]`,
    ];
  }
  if (layout.mode === 'center_crop'
    || layout.mode === 'screen_focus'
    || layout.mode === 'segmented_focus'
    || layout.mode === 'subject_track') {
    if (layout.mode === 'subject_track') {
      const dynamic = trackingExpressions(shot, width, height);
      return [
        `color=c=black:s=${width}x${height}:r=${fps}:d=${duration}[bg${inputIndex}]`,
        `[${inputIndex}:v]${crop}scale=${width}:${height}:force_original_aspect_ratio=increase,`
        + `scale=w='iw*${dynamic.scale}':h='ih*${dynamic.scale}':eval=frame[fg${inputIndex}]`,
        `[bg${inputIndex}][fg${inputIndex}]overlay=x='(W-w)/2+${dynamic.x}':y='(H-h)/2+${dynamic.y}':eval=frame,`
        + `setsar=1,fps=${fps},trim=duration=${duration},setpts=PTS-STARTPTS[v${inputIndex}]`,
      ];
    }
    const overlay = overlayExpression(layout, width, height);
    return [
      `color=c=black:s=${width}x${height}:r=${fps}:d=${duration}[bg${inputIndex}]`,
      `[${inputIndex}:v]${crop}scale=${width}:${height}:force_original_aspect_ratio=increase,`
      + `crop=${width}:${height},scale=iw*${layout.scale}:ih*${layout.scale}[fg${inputIndex}]`,
      `[bg${inputIndex}][fg${inputIndex}]overlay=x='${overlay.x}':y='${overlay.y}',`
      + `setsar=1,fps=${fps},trim=duration=${duration},setpts=PTS-STARTPTS[v${inputIndex}]`,
    ];
  }
  const overlay = overlayExpression(layout, width, height);
  const scaledForeground = `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
    + `scale=iw*${layout.scale}:ih*${layout.scale}`;
  if (layout.mode === 'landscape_card_blur') {
    return [
      `[${inputIndex}:v]${crop}split=2[bgraw${inputIndex}][fgraw${inputIndex}]`,
      `[bgraw${inputIndex}]scale=${width}:${height}:force_original_aspect_ratio=increase,`
      + `crop=${width}:${height},boxblur=20:5[bg${inputIndex}]`,
      `[fgraw${inputIndex}]${scaledForeground}[fg${inputIndex}]`,
      `[bg${inputIndex}][fg${inputIndex}]overlay=x='${overlay.x}':y='${overlay.y}',`
      + `setsar=1,fps=${fps},trim=duration=${duration},setpts=PTS-STARTPTS[v${inputIndex}]`,
    ];
  }
  return [
    `color=c=black:s=${width}x${height}:r=${fps}:d=${duration}[bg${inputIndex}]`,
    `[${inputIndex}:v]${crop}${scaledForeground}[fg${inputIndex}]`,
    `[bg${inputIndex}][fg${inputIndex}]overlay=x='${overlay.x}':y='${overlay.y}',`
    + `setsar=1,fps=${fps},trim=duration=${duration},setpts=PTS-STARTPTS[v${inputIndex}]`,
  ];
}

async function generateDouyinPreview(outputPath, analysis, mappings, profile) {
  const width = profile.format.width;
  const height = profile.format.height;
  const fps = analysis.timeline.fps;
  const mappingById = new Map(mappings.map((item) => [item.assetId, item]));
  const args = ['-y'];
  const filters = [];
  const concatInputs = [];
  for (const [index, shot] of analysis.timeline.shots.entries()) {
    const mapping = mappingById.get(shot.assetId);
    if (!mapping) throw variantError('DOUYIN_MISSING_MEDIA', `预览缺少素材映射：${shot.assetId}`);
    const duration = Number(shot.durationSec.toFixed(6));
    if (mapping.type === 'image') {
      args.push('-loop', '1', '-t', String(duration), '-i', mapping.projectAbsolutePath);
    } else {
      args.push('-ss', String(shot.inSec), '-t', String(duration), '-i', mapping.projectAbsolutePath);
    }
    filters.push(...douyinVideoFilters(shot, width, height, fps, index));
    if (mapping.type === 'video' && mapping.metadata?.hasAudio && shot.audioMode === 'keep') {
      filters.push(
        `[${index}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,`
        + `aformat=sample_rates=48000:channel_layouts=stereo[a${index}]`,
      );
    } else {
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${duration},`
        + `asetpts=PTS-STARTPTS[a${index}]`,
      );
    }
    concatInputs.push(`[v${index}][a${index}]`);
  }
  filters.push(`${concatInputs.join('')}concat=n=${analysis.timeline.shots.length}:v=1:a=1[vout][aout]`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${crypto.randomUUID()}.tmp.mp4`,
  );
  try {
    const result = await runMediaTool('ffmpeg', [
      ...args,
      '-filter_complex', filters.join(';'),
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '160k',
      '-ar', '48000',
      '-ac', '2',
      '-movflags', '+faststart',
      tempPath,
    ], { timeoutMs: 30 * 60 * 1000 });
    const metadata = await probeMedia(tempPath);
    if (!metadata.hasVideo
      || metadata.displayWidth !== width
      || metadata.displayHeight !== height) {
      throw variantError('INVALID_DOUYIN_PREVIEW', '抖音预览不是 1080×1920 可读视频。');
    }
    await fs.rename(tempPath, outputPath);
    return { outputPath, metadata, command: result.command };
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function snapshotProtectedFiles(bundle) {
  const paths = [
    path.join(bundle.projectPath, VIDEO_ANALYSIS_FILE),
    path.join(bundle.projectPath, VIDEO_MANIFEST_FILE),
    path.join(bundle.projectPath, VIDEO_STATUS_FILE),
    path.join(bundle.projectPath, EDITORIAL_REVIEW_FILE),
  ];
  const rows = [];
  for (const filePath of paths) {
    const stat = await fs.stat(filePath).catch(() => null);
    rows.push({
      path: filePath,
      exists: Boolean(stat?.isFile()),
      sha256: stat?.isFile() ? await hashFile(filePath) : null,
    });
  }
  return rows;
}

function compareProtectedFiles(before, after) {
  return before.filter((row, index) => (
    row.exists !== after[index]?.exists || row.sha256 !== after[index]?.sha256
  )).map((row) => row.path);
}

async function resolveInstalledFcpxmlDtd(version = '1.14') {
  const versionFile = `FCPXMLv${String(version).replace('.', '_')}.dtd`;
  const roots = ['/Applications', '/System/Applications'];
  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^Final Cut Pro.*\.app$/i.test(entry.name)) continue;
      const candidate = path.join(
        root,
        entry.name,
        'Contents',
        'Frameworks',
        'Interchange.framework',
        'Versions',
        'A',
        'Resources',
        versionFile,
      );
      const stat = await fs.stat(candidate).catch(() => null);
      if (stat?.isFile()) return candidate;
    }
  }
  return null;
}

function safeZoneIssues(profile, video, fps = 30) {
  const warnings = [];
  const errors = [];
  for (const caption of video.lightCaptions) {
    const placement = profile.subtitlePlacements[caption.position];
    if (!validRect(placement) || !rectInside(placement, profile.safeZones.subtitle)) {
      errors.push(`字幕 ${caption.captionId} 超出字幕安全区。`);
      continue;
    }
    const occlusion = profile.uiOcclusionZones.find((zone) => rectsIntersect(placement, zone));
    if (occlusion) errors.push(`字幕 ${caption.captionId} 与抖音界面遮挡区「${occlusion.label}」重叠。`);
    const shot = video.shots.find((item) => item.shotId === caption.shotId);
    if (shot?.layout?.sourceTextBounds?.some((rect) => rectsIntersect(placement, rect))) {
      warnings.push(`字幕 ${caption.captionId} 可能与原画界面文字重叠，需人工确认。`);
    }
    if (shot?.layout?.subjectBounds
      && isAdvancedScreenLayout(shot.layout.mode)
      && rectsIntersect(placement, shot.layout.subjectBounds)) {
      warnings.push(`字幕 ${caption.captionId} 可能与关键主体重叠，需人工确认。`);
    }
  }
  for (const shot of video.shots) {
    const dynamicTracking = isDynamicTrackingLayout(shot.layout.mode)
      && shot.layout.tracking;
    const cropBounds = {
      x: shot.layout.crop.left,
      y: shot.layout.crop.top,
      width: 1 - shot.layout.crop.left - shot.layout.crop.right,
      height: 1 - shot.layout.crop.top - shot.layout.crop.bottom,
    };
    if (!shot.layout.subjectBounds) {
      if (shot.layout.mode === 'center_crop'
        || isAdvancedScreenLayout(shot.layout.mode)
        || isDynamicTrackingLayout(shot.layout.mode)) {
        warnings.push(`镜头 ${shot.shotId} 使用中央裁切但未记录主体边界，需人工确认主体安全区。`);
      }
    } else {
      if (!rectInside(shot.layout.subjectBounds, cropBounds)) {
        warnings.push(`镜头 ${shot.shotId} 的关键区域可能被当前裁切框裁掉。`);
      }
      if (!dynamicTracking
        && !rectInside(shot.layout.subjectBounds, profile.safeZones.subject)) {
        warnings.push(`镜头 ${shot.shotId} 的关键主体可能超出主体安全区。`);
      }
      if (!dynamicTracking) {
        const occlusion = profile.uiOcclusionZones.find(
          (zone) => rectsIntersect(shot.layout.subjectBounds, zone),
        );
        if (occlusion) warnings.push(`镜头 ${shot.shotId} 的关键主体可能被「${occlusion.label}」遮挡。`);
      }
    }
    if (dynamicTracking) {
      const trackingValidation = validateTracking(shot.layout.tracking, {
        fps: Number(fps) || 30,
        inSec: shot.inSec,
        outSec: shot.outSec,
      });
      errors.push(...trackingValidation.errors.map((message) => `镜头 ${shot.shotId}：${message}`));
      warnings.push(...trackingValidation.warnings.map((message) => `镜头 ${shot.shotId}：${message}`));
      const safe = profile.safeZones.subject;
      const sourceAspect = Number(shot.layout.tracking.sourceAspect);
      const outputAspect = Number(shot.layout.tracking.outputAspect);
      const aspectFactors = sourceAspect > 0 && outputAspect > 0
        ? (sourceAspect >= outputAspect
          ? { x: sourceAspect / outputAspect, y: 1 }
          : { x: 1, y: outputAspect / sourceAspect })
        : { x: 1, y: 1 };
      for (const point of shot.layout.tracking.points) {
        if (!rectInside(point.bounds, {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        })) {
          errors.push(`镜头 ${shot.shotId} 的跟踪点 ${point.pointId} 越过源画面边界。`);
        }
        const headRisk = shot.layout.tracking.subjectType === 'person'
          && point.bounds.y <= 0.01;
        if (headRisk) {
          warnings.push(`镜头 ${shot.shotId} 的人物框贴近画面顶部，存在裁掉头部或面部风险。`);
        }
        if (point.bounds.width * aspectFactors.x > safe.width
          || point.bounds.height * aspectFactors.y > safe.height) {
          warnings.push(`镜头 ${shot.shotId} 的主体大于安全区，建议降低缩放或降级完整横屏卡片。`);
        }
        const keyframe = shot.layout.tracking.keyframes.find(
          (item) => item.pointId === point.pointId,
        );
        if (keyframe) {
          const sourceCenterX = point.bounds.x + point.bounds.width / 2;
          const sourceCenterY = point.bounds.y + point.bounds.height / 2;
          const transformed = {
            x: 0.5 + (sourceCenterX - 0.5) * aspectFactors.x * keyframe.scale
              + keyframe.position.x * 0.5
              - point.bounds.width * aspectFactors.x * keyframe.scale / 2,
            y: 0.5 + (sourceCenterY - 0.5) * aspectFactors.y * keyframe.scale
              + keyframe.position.y * 0.5
              - point.bounds.height * aspectFactors.y * keyframe.scale / 2,
            width: point.bounds.width * aspectFactors.x * keyframe.scale,
            height: point.bounds.height * aspectFactors.y * keyframe.scale,
          };
          const insetSafe = {
            x: safe.x + shot.layout.tracking.safeMargin,
            y: safe.y + shot.layout.tracking.safeMargin,
            width: Math.max(0.01, safe.width - shot.layout.tracking.safeMargin * 2),
            height: Math.max(0.01, safe.height - shot.layout.tracking.safeMargin * 2),
          };
          if (!rectInside(transformed, insetSafe)) {
            warnings.push(`镜头 ${shot.shotId} 在 ${point.sourceTime} 的主体可能未完整位于安全区。`);
          }
        }
      }
    }
    const readableHeight = effectiveSourceTextHeightPx(shot.layout, profile);
    if (readableHeight != null && readableHeight < 24) {
      warnings.push(`镜头 ${shot.shotId} 的界面文字预计小于手机可读阈值。`);
    }
    if ((shot.layout.mode === 'landscape_card' || shot.layout.mode === 'landscape_card_blur')
      && shot.layout.scale < 0.85) {
      warnings.push(`镜头 ${shot.shotId} 的横屏卡片有效显示面积过小。`);
    }
  }
  return { errors, warnings };
}

async function analyzeDouyinShotTracking(projectPath, variantId, videoId, shotId, options = {}) {
  const bundle = await loadProjectBundle(projectPath, options);
  const registry = await readPlatformVariants(bundle.projectPath);
  const current = findVariant(registry, variantId);
  const plan = normalizeDouyinPlan(current.plan);
  const video = plan.videos.find((item) => item.videoId === videoId);
  const shot = video?.shots.find((item) => item.shotId === shotId);
  if (!shot) {
    throw variantError('DOUYIN_SHOT_NOT_FOUND', `找不到抖音镜头：${videoId}/${shotId}`);
  }
  const mapping = bundle.mappings.find((item) => item.assetId === shot.assetId);
  if (!mapping || mapping.type !== 'video') {
    throw variantError('DOUYIN_TRACKING_VIDEO_REQUIRED', '动态主体跟踪只支持已登记的视频镜头。');
  }
  const fps = Number(bundle.status?.formats?.timeline?.fps)
    || Number(bundle.analysis?.timeline?.fps)
    || inferFps(bundle.manifest, bundle.analysis);
  const tracking = await analyzeMediaSubjectTracking({
    mediaPath: mapping.projectAbsolutePath,
    inSec: shot.inSec,
    outSec: shot.outSec,
    fps,
    subjectType: options.subjectType,
    safeMargin: options.safeMargin,
    safeZone: bundle.profile.safeZones.subject,
    scale: shot.layout.scale,
    crop: shot.layout.crop,
    sourceAspect: (Number(mapping.metadata?.displayWidth) || Number(mapping.metadata?.width))
      / (Number(mapping.metadata?.displayHeight) || Number(mapping.metadata?.height)),
    outputAspect: bundle.profile.format.width / bundle.profile.format.height,
    fallbackMode: options.fallbackMode,
    initialRegion: options.subjectType === 'user_region'
      ? shot.layout.subjectBounds
      : null,
  });
  shot.layout.tracking = tracking;
  shot.layout.mode = tracking.fallback.applied ? tracking.fallback.mode : 'subject_track';
  shot.layout.subjectBounds = tracking.points[0]?.bounds || shot.layout.subjectBounds;
  shot.agentLayout = structuredClone(shot.layout);
  synchronizeAutomaticWarnings(plan, await planValidationContext(bundle));
  return {
    variantId: current.variantId,
    revision: current.revision,
    videoId,
    shotId,
    tracking,
    proposedPlan: plan,
    requiresSave: true,
  };
}

async function validateGeneratedCut({
  bundle,
  variant,
  video,
  analysis,
  mappings,
  outputDirectory,
  fcpxmlPath,
  previewPath,
  fcpxmlResult,
  previewResult,
  sourceVerification,
  protectedFilesUnchanged,
}) {
  const errors = [];
  const warnings = [];
  if (bundle.profile.format.width !== 1080
    || bundle.profile.format.height !== 1920
    || bundle.profile.format.aspectRatio !== '9:16') {
    errors.push('抖音平台档案不是 1080×1920、9:16。');
  }
  for (const mapping of mappings) {
    const stat = await fs.stat(mapping.projectAbsolutePath).catch(() => null);
    if (!stat?.isFile()) errors.push(`缺失媒体：${mapping.projectAbsolutePath}`);
  }
  const xml = await fs.readFile(fcpxmlPath, 'utf8').catch(() => '');
  const fcpxmlReport = validateFcpxmlStructure(xml, {
    shotCount: analysis.timeline.shots.length,
    assetCount: mappings.length,
    markerCount: analysis.timeline.markers.length,
    titleCount: video.lightCaptions.length,
    width: 1080,
    height: 1920,
    fps: analysis.timeline.fps,
  });
  errors.push(...fcpxmlReport.errors);
  let xmlSyntax = { ok: false, message: '未执行 xmllint。' };
  try {
    await runMediaTool('xmllint', ['--noout', fcpxmlPath], { timeoutMs: 30_000 });
    xmlSyntax = { ok: true, message: 'xmllint 语法校验通过。' };
  } catch (error) {
    errors.push(`FCPXML XML 语法错误：${error.message}`);
    xmlSyntax = { ok: false, message: error.message };
  }
  const dtdPath = await resolveInstalledFcpxmlDtd(fcpxmlReport.version);
  let dtd = {
    ok: null,
    requiresFinalCutImport: true,
    path: null,
    message: `未找到本机 Final Cut Pro FCPXML ${fcpxmlReport.version} DTD；仍需人工导入确认。`,
  };
  if (dtdPath) {
    const temporaryDtdPath = path.join(
      os.tmpdir(),
      `video-cut-planner-fcpxml-${String(fcpxmlReport.version).replace('.', '_')}-${process.pid}-${crypto.randomUUID()}.dtd`,
    );
    try {
      // The DTD inside the signed app bundle may carry APFS compression and
      // cannot always be opened directly by sandboxed xmllint. Materialize its
      // bytes into a private temporary file before validation.
      await fs.writeFile(temporaryDtdPath, await fs.readFile(dtdPath), { flag: 'wx' });
      await runMediaTool('xmllint', [
        '--noout',
        '--dtdvalid', temporaryDtdPath,
        fcpxmlPath,
      ], { timeoutMs: 30_000 });
      dtd = {
        ok: true,
        requiresFinalCutImport: false,
        path: dtdPath,
        message: `已通过本机 Final Cut Pro FCPXML ${fcpxmlReport.version} DTD 校验。`,
      };
    } catch (error) {
      const dtdMessage = String(error.stderr || error.message).trim();
      errors.push(`FCPXML DTD 验证失败：${dtdMessage}`);
      dtd = {
        ok: false,
        requiresFinalCutImport: true,
        path: dtdPath,
        message: dtdMessage,
      };
    } finally {
      await fs.rm(temporaryDtdPath, { force: true }).catch(() => {});
    }
  }
  if (previewResult?.metadata
    && (previewResult.metadata.displayWidth !== 1080
      || previewResult.metadata.displayHeight !== 1920)) {
    errors.push('抖音预览分辨率不是 1080×1920。');
  }
  const actualOrder = analysis.timeline.shots.map((shot) => shot.assetId);
  const approvedOrder = video.shots.map((shot) => shot.assetId);
  if (JSON.stringify(actualOrder) !== JSON.stringify(approvedOrder)) {
    errors.push('实际镜头顺序与已批准抖音计划不一致。');
  }
  const selectedWithAudio = video.shots.filter((shot) => {
    const mapping = mappings.find((item) => item.assetId === shot.assetId);
    return mapping?.type === 'video' && mapping.metadata?.hasAudio;
  });
  for (const shot of selectedWithAudio) {
    if (shot.audioMode === 'mute' && !shot.muteReason) {
      errors.push(`镜头 ${shot.shotId} 静音状态不符合计划。`);
    }
  }
  const layeredAudioShots = selectedWithAudio.filter((shot) => shot.layout.mode === 'screen_split');
  const mutedLayerCount = (xml.match(/上下双层录屏 · 关键区域[\s\S]*?<adjust-volume amount="-96dB"\/>/g) || []).length;
  if (mutedLayerCount < layeredAudioShots.length) {
    errors.push('上下双层录屏的重复画面层没有全部静音，可能造成两路原声叠加。');
  }
  const trackingShots = video.shots.filter((shot) => shot.layout.mode === 'subject_track');
  const approvedTrackingKeyframes = trackingShots.flatMap(
    (shot) => shot.layout.tracking?.keyframes || [],
  );
  if (fcpxmlReport.transformKeyframeCount !== approvedTrackingKeyframes.length * 2) {
    errors.push('FCPXML transform 关键帧数量与批准计划不一致。');
  }
  for (const keyframe of approvedTrackingKeyframes) {
    const escapedTime = keyframe.sourceTime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const occurrences = (xml.match(new RegExp(`<keyframe time="${escapedTime}"`, 'g')) || []).length;
    if (occurrences !== 2) {
      errors.push(`FCPXML 缺少批准的 transform 关键帧：${keyframe.sourceTime}。`);
    }
  }
  if (video.lightCaptions.length > 0
    && fcpxmlReport.titleCount < video.lightCaptions.filter((item) => item.required).length) {
    errors.push('应有轻字幕没有全部生成 FCP 原生 Title。');
  }
  for (const selection of variant.plan.selection.filter((item) => item.decision !== 'selected')) {
    if (!selection.reason) errors.push(`未选素材 ${selection.assetId} 缺少明确原因。`);
  }
  const safety = safeZoneIssues(bundle.profile, video, analysis.timeline.fps);
  errors.push(...safety.errors);
  warnings.push(...safety.warnings);
  if (!sourceVerification.unchanged) errors.push(...sourceVerification.errors);
  if (!protectedFilesUnchanged) errors.push('默认主成片文件、人工字幕或 editorial-review.json 被修改。');
  if (fcpxmlReport.sequenceFrameDuration !== frameDuration(analysis.timeline.fps)) {
    errors.push('FCPXML 没有按实际 frameDuration 对齐。');
  }
  return {
    schemaVersion: 1,
    variantId: variant.variantId,
    revision: variant.revision,
    videoId: video.videoId,
    theme: video.theme,
    validatedAt: new Date().toISOString(),
    ok: errors.length === 0,
    fullySuccessful: errors.length === 0 && warnings.length === 0,
    errors,
    warnings,
    format: {
      aspectRatio: bundle.profile.format.aspectRatio,
      width: bundle.profile.format.width,
      height: bundle.profile.format.height,
      fps: analysis.timeline.fps,
      frameDuration: fcpxmlReport.sequenceFrameDuration,
      dynamicRange: bundle.profile.format.dynamicRange,
      colorSpace: bundle.profile.format.colorSpace,
    },
    approvedPlan: {
      revision: variant.approval.revision,
      planHash: variant.approval.planHash,
      actualPlanHash: stableHash(variant.plan),
      orderMatches: JSON.stringify(actualOrder) === JSON.stringify(approvedOrder),
    },
    selection: {
      selectedCount: variant.plan.selection.filter((item) => item.decision === 'selected').length,
      excludedCount: variant.plan.selection.filter((item) => item.decision === 'excluded').length,
      separateCount: variant.plan.selection.filter((item) => item.decision === 'separate').length,
      excludedReasonsComplete: variant.plan.selection
        .filter((item) => item.decision !== 'selected')
        .every((item) => Boolean(item.reason)),
      defaultMainCompletenessApplied: false,
    },
    audio: {
      selectedVideoShotCount: selectedWithAudio.length,
      keptOriginalAudioCount: selectedWithAudio.filter((shot) => shot.audioMode === 'keep').length,
      mutedWithReasonCount: selectedWithAudio.filter(
        (shot) => shot.audioMode === 'mute' && Boolean(shot.muteReason),
      ).length,
      matchesPlan: true,
      layeredShotCount: layeredAudioShots.length,
      mutedDuplicateLayerCount: mutedLayerCount,
      duplicateAudioPrevented: mutedLayerCount >= layeredAudioShots.length,
      subjectTrackingUsesDuplicateMediaLayer: false,
    },
    captions: {
      requiredCount: video.lightCaptions.filter((item) => item.required).length,
      plannedCount: video.lightCaptions.length,
      generatedFcpTitleCount: fcpxmlReport.titleCount,
      complete: video.lightCaptions.filter((item) => item.required).length <= fcpxmlReport.titleCount,
    },
    safety: {
      subtitleSafeZone: bundle.profile.safeZones.subtitle,
      subjectSafeZone: bundle.profile.safeZones.subject,
      uiOcclusionZones: bundle.profile.uiOcclusionZones,
      issues: [...safety.errors, ...safety.warnings],
      trackingShotCount: trackingShots.length,
      approvedTrackingKeyframeCount: approvedTrackingKeyframes.length,
    },
    sourceVerification,
    protectedFilesUnchanged,
    fcpxml: {
      ...fcpxmlReport,
      writeReport: fcpxmlResult.report,
      xmlSyntax,
      dtd,
    },
    preview: previewResult?.metadata || null,
    artifacts: {
      outputDirectory,
      fcpxmlPath,
      previewPath,
    },
  };
}

async function buildDouyinVariant(projectPath, variantId = 'douyin', options = {}) {
  const bundle = await loadProjectBundle(projectPath, options);
  const internal = bundle.artifactRoot === internalArtifactRoot(bundle.projectPath);
  const registry = await readPlatformVariants(bundle.projectPath);
  const current = findVariant(registry, variantId);
  if (current.status !== 'approved' || !current.approval) {
    throw variantError('DOUYIN_PLAN_NOT_APPROVED', '必须在规划确认页批准后才能生成抖音 FCPXML。');
  }
  const plan = validateDouyinPlan(current.plan, await planValidationContext(bundle));
  if (current.approval.revision !== current.revision
    || current.approval.planHash !== stableHash(plan)) {
    throw variantError('DOUYIN_APPROVAL_STALE', '抖音规划在批准后发生变化，请重新确认。');
  }
  const sourceBefore = await snapshotSource(bundle.manifest.sourceDirectory);
  const sourcePreflight = compareSourceSnapshots(bundle.manifest.sourceSnapshot, sourceBefore);
  if (!sourcePreflight.unchanged) {
    throw variantError('SOURCE_CHANGED_AFTER_PREPARE', sourcePreflight.errors[0], sourcePreflight.errors);
  }
  const protectedBefore = await snapshotProtectedFiles(bundle);
  const fps = Number(bundle.status?.formats?.timeline?.fps)
    || Number(bundle.analysis?.timeline?.fps)
    || inferFps(bundle.manifest, bundle.analysis);
  const mappingById = new Map(bundle.mappings.map((item) => [item.assetId, item]));
  const outputs = [];
  const baseOutputRoot = internal
    ? path.join(bundle.artifactRoot, INTERNAL_ARTIFACT_DIRS.variants, 'douyin', current.variantId, `r${current.revision}`)
    : path.join(bundle.projectPath, PLATFORM_VARIANTS_DIR, 'douyin', current.variantId, `r${current.revision}`);
  for (const video of plan.videos) {
    const outputDirectory = path.join(baseOutputRoot, safeId(video.videoId));
    if (!internal && !isInside(bundle.projectPath, outputDirectory)) {
      throw variantError('UNSAFE_PLATFORM_VARIANT_PATH', '抖音输出目录越过项目边界。');
    }
    const existing = await fs.readdir(outputDirectory).catch(() => []);
    if (existing.length) {
      throw variantError('DOUYIN_OUTPUT_EXISTS', `抖音成片目录已存在且非空：${outputDirectory}`);
    }
    await fs.mkdir(outputDirectory, { recursive: true });
    const analysis = cutAnalysis(bundle, { ...current, plan }, video, fps);
    const usedIds = [...new Set(video.shots.map((shot) => shot.assetId))];
    const mappings = usedIds.map((assetId) => mappingById.get(assetId));
    const missing = usedIds.filter((assetId, index) => !mappings[index]);
    if (missing.length) {
      throw variantError(
        'DOUYIN_MISSING_MEDIA',
        `抖音成片所选素材未在默认项目素材映射中：${missing.join('、')}`,
        missing,
      );
    }
    const editPlanPath = path.join(outputDirectory, 'edit-plan.json');
    const analysisPath = path.join(outputDirectory, 'analysis.json');
    const deliverableName = sanitizeFcpFilename(
      `${current.variantId}-${video.videoId}-${video.theme}`,
      `douyin-${video.videoId}`,
    );
    const fcpxmlPath = internal
      ? path.join(bundle.projectPath, `${deliverableName}.fcpxml`)
      : path.join(outputDirectory, 'timeline.fcpxml');
    const shouldGeneratePreview = options.generatePreview === true
      || (!internal && options.generatePreview !== false);
    const previewPath = shouldGeneratePreview
      ? path.join(outputDirectory, 'preview.mp4')
      : null;
    const validationPath = path.join(outputDirectory, 'validation-report.json');
    await Promise.all([
      atomicWriteJson(editPlanPath, {
        schemaVersion: 1,
        variantId: current.variantId,
        revision: current.revision,
        approval: current.approval,
        profileId: current.profileId,
        selection: plan.selection,
        video,
      }),
      atomicWriteJson(analysisPath, {
        ...analysis,
        platformVariant: {
          variantId: current.variantId,
          revision: current.revision,
          videoId: video.videoId,
          sharedManifest: path.join(
            bundle.artifactRoot,
            path.basename(internal ? INTERNAL_VIDEO_MANIFEST_FILE : VIDEO_MANIFEST_FILE),
          ),
          sharedBaseAnalysis: path.join(
            bundle.artifactRoot,
            path.basename(internal ? INTERNAL_VIDEO_ANALYSIS_FILE : VIDEO_ANALYSIS_FILE),
          ),
          baseAnalysisSha256: await hashFile(path.join(
            bundle.artifactRoot,
            path.basename(internal ? INTERNAL_VIDEO_ANALYSIS_FILE : VIDEO_ANALYSIS_FILE),
          )),
        },
      }),
    ]);
    const titles = managedTitlesForCut(bundle.profile, video, analysis);
    const writeFcpxmlImpl = options.writeFcpxmlImpl || writeFcpxml;
    const previewImpl = options.generatePreviewImpl || generateDouyinPreview;
    const fcpxmlResult = await writeFcpxmlImpl(fcpxmlPath, {
      projectName: `${path.basename(bundle.projectPath)} · 抖音 · ${video.theme}`,
      analysis,
      assetMappings: mappings,
      managedCaptionTitles: titles,
    }, { expectedTitleCount: titles.length });
    const previewResult = previewPath
      ? await previewImpl(previewPath, analysis, mappings, bundle.profile)
      : { metadata: null };
    const sourceAfter = await snapshotSource(bundle.manifest.sourceDirectory);
    const sourceVerification = compareSourceSnapshots(bundle.manifest.sourceSnapshot, sourceAfter);
    const protectedAfter = await snapshotProtectedFiles(bundle);
    const protectedChanges = compareProtectedFiles(protectedBefore, protectedAfter);
    const validation = await validateGeneratedCut({
      bundle,
      variant: { ...current, plan },
      video,
      analysis,
      mappings,
      outputDirectory,
      fcpxmlPath,
      previewPath,
      fcpxmlResult,
      previewResult,
      sourceVerification,
      protectedFilesUnchanged: protectedChanges.length === 0,
    });
    if (protectedChanges.length) validation.protectedFileChanges = protectedChanges;
    await atomicWriteJson(validationPath, validation);
    outputs.push({
      videoId: video.videoId,
      theme: video.theme,
      outputDirectory,
      relativeOutputDirectory: path.relative(bundle.projectPath, outputDirectory),
      specs: validation.format,
      shotCount: video.shots.length,
      assetCount: usedIds.length,
      subtitleCount: video.lightCaptions.length,
      originalAudio: validation.audio,
      validationStatus: validation.ok
        ? (validation.fullySuccessful ? 'verified' : 'warning')
        : 'failed',
      artifacts: {
        fcpxml: internal ? fcpxmlPath : path.relative(bundle.projectPath, fcpxmlPath),
        ...(previewPath ? { preview: internal ? previewPath : path.relative(bundle.projectPath, previewPath) } : {}),
        editPlan: internal ? editPlanPath : path.relative(bundle.projectPath, editPlanPath),
        analysis: internal ? analysisPath : path.relative(bundle.projectPath, analysisPath),
        validation: internal ? validationPath : path.relative(bundle.projectPath, validationPath),
      },
      validation,
    });
    if (!validation.ok) {
      throw variantError(
        'DOUYIN_VARIANT_VERIFICATION_FAILED',
        `抖音成片 ${video.videoId} 验证失败：${validation.errors[0]}`,
        validation.errors,
      );
    }
  }
  const nextVariant = {
    ...current,
    plan,
    status: outputs.some((output) => output.validationStatus === 'warning')
      ? 'generated_with_warnings'
      : 'generated',
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    outputs,
  };
  const next = await writeRegistry(bundle.projectPath, {
    ...registry,
    variants: registry.variants.map((item) => (
      item.variantId === current.variantId ? nextVariant : item
    )),
  });
  return findVariant(next, current.variantId);
}

async function verifyDouyinVariant(projectPath, variantId = 'douyin', options = {}) {
  const variant = await readDouyinVariant(projectPath, variantId, options);
  const reports = [];
  for (const output of asArray(variant.outputs)) {
    const resolveArtifact = (value) => path.isAbsolute(value)
      ? value
      : path.join(variant.projectPath, value);
    const validationPath = resolveArtifact(output.artifacts.validation);
    const report = await readJson(validationPath, 'validation-report.json');
    const required = Object.values(output.artifacts).filter(Boolean);
    const missing = [];
    for (const artifactPath of required) {
      const target = resolveArtifact(artifactPath);
      if ((!path.isAbsolute(artifactPath) && !isInside(variant.projectPath, target))
        || !(await fs.stat(target).catch(() => null))?.isFile()) {
        missing.push(artifactPath);
      }
    }
    reports.push({
      ...report,
      ok: report.ok === true && missing.length === 0,
      errors: [...asArray(report.errors), ...missing.map((item) => `缺少产物：${item}`)],
    });
  }
  return {
    ok: reports.length > 0 && reports.every((report) => report.ok),
    variantId: variant.variantId,
    status: variant.status,
    reports,
  };
}

module.exports = {
  DOUYIN_DECISIONS,
  DOUYIN_CAPTION_KINDS,
  DOUYIN_LAYOUT_MODES,
  DOUYIN_PLAN_SCHEMA_VERSION,
  DOUYIN_WARNING_TYPES,
  PLATFORM_VARIANT_SCHEMA_VERSION,
  SELECTION_FACTOR_KEYS,
  allWarningIds,
  approveDouyinVariant,
  analyzeDouyinShotTracking,
  buildDouyinVariant,
  createAutomaticDouyinPlan,
  createDouyinVariant,
  generateDouyinPreview,
  loadDouyinProfile,
  normalizeDouyinPlan,
  safeZoneIssues,
  readDouyinVariant,
  readPlatformVariants,
  saveDouyinVariantDraft,
  validateDouyinPlan,
  verifyDouyinVariant,
};
