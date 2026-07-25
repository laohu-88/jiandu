'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  CODEX_VIDEO_ANALYSIS_FILE,
  CODEX_VIDEO_MANIFEST_FILE,
  CODEX_VIDEO_STATUS_FILE,
  EDITORIAL_REVIEW_FILE,
} = require('../constants');
const { readJsonFile } = require('./project-json-service');

function isInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveSafeProjectFile(projectPath, candidate) {
  const root = path.resolve(String(projectPath || ''));
  const value = String(candidate || '');
  if (!value || path.isAbsolute(value)) {
    throw Object.assign(new Error('产物路径必须是项目内的相对路径。'), {
      code: 'UNSAFE_PROJECT_PATH',
    });
  }
  const resolved = path.resolve(root, value);
  if (!isInside(root, resolved)) {
    throw Object.assign(new Error(`拒绝项目外路径：${value}`), {
      code: 'UNSAFE_PROJECT_PATH',
    });
  }
  const stat = await fs.stat(resolved).catch(() => null);
  if (stat) {
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(resolved)]);
    if (!isInside(realRoot, realTarget)) {
      throw Object.assign(new Error(`拒绝通过链接访问项目外路径：${value}`), {
        code: 'UNSAFE_PROJECT_PATH',
      });
    }
  }
  return { path: resolved, exists: Boolean(stat), stat };
}

const EDITORIAL_REVIEW_SCHEMA_VERSION = 1;
const REVIEWED_BY = 'local-user';
const MAX_CAPTION_TEXT_LENGTH = 40;
const MAX_USER_NOTES_LENGTH = 1000;
const MAX_UNLOCK_REASON_LENGTH = 500;

const REVIEW_STATUSES = Object.freeze([
  'pending',
  'approved',
  'edited_approved',
  'not_needed',
  'rejected',
  'needs_review',
  'stale',
]);

const CONFIRMED_CAPTION_STATUSES = Object.freeze(new Set([
  'approved',
  'edited_approved',
]));

const REVIEW_FILTERS = Object.freeze([
  'all',
  'pending',
  'confirmed',
  'not_needed',
  'warnings',
  'video',
  'image',
]);

const REVIEW_STATUS_SET = new Set(REVIEW_STATUSES);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

function finiteNumberOrNull(value) {
  // Number(null) === 0; treat null/undefined/'' as unset so pending captions
  // keep suggestion times instead of collapsing seek/display to 0s.
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function emptyEditorialReview() {
  return {
    schemaVersion: EDITORIAL_REVIEW_SCHEMA_VERSION,
    updatedAt: null,
    reviews: {},
    warnings: [],
  };
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function assetContentFingerprint(item, mapping) {
  const sha = stringOrNull(mapping?.sourceSha256)
    || stringOrNull(item?.sha256)
    || null;
  if (sha) return `sha256:${sha}`;
  const size = item?.sizeBytes ?? mapping?.metadata?.sizeBytes ?? null;
  const duration = item?.metadata?.durationSec ?? mapping?.metadata?.durationSec ?? null;
  const relative = item?.relativePath || mapping?.sourceRelativePath || mapping?.projectRelativePath || '';
  return `weak:${size ?? 'na'}:${duration ?? 'na'}:${relative}`;
}

function analysisStructureFingerprint(asset, captionsForAsset, storyUnit) {
  const captionIds = captionsForAsset
    .map((caption) => caption.captionId)
    .filter(Boolean)
    .sort();
  const textIds = asArray(asset?.visualTextAnalysis?.items)
    .map((item, index) => `${item.textType || 'other'}:${index}:${String(item.sourceText || '').slice(0, 40)}`)
    .sort();
  const payload = {
    assetId: asset?.assetId || null,
    storyUnitId: asset?.storyUnitId || storyUnit?.storyUnitId || null,
    storyUnitAssetIds: asArray(storyUnit?.assetIds).slice().sort(),
    explanationNeed: asset?.explanationPlan?.audienceNeedsExplanation || null,
    captionIds,
    textIds,
    preserveFullClip: asset?.videoPreservationPlan?.preserveFullClip ?? null,
    preserveOriginalAudio: asset?.audioAnalysis?.preserveOriginalAudio ?? null,
    sourceDuration: asset?.videoPreservationPlan?.sourceDuration
      ?? asset?.ranges?.[0]?.endSec
      ?? null,
  };
  return sha256Text(JSON.stringify(payload));
}

function cloneSuggestion(caption) {
  if (!isObject(caption)) return null;
  return {
    captionId: caption.captionId,
    assetId: caption.assetId,
    storyUnitId: caption.storyUnitId ?? null,
    text: caption.text,
    startTime: finiteNumberOrNull(caption.startTime),
    endTime: finiteNumberOrNull(caption.endTime),
    purpose: caption.purpose || null,
    basedOn: caption.basedOn || null,
    confidence: finiteNumberOrNull(caption.confidence),
    reviewRequired: caption.reviewRequired === true,
    warnings: asArray(caption.warnings).map(String),
  };
}

function normalizeCaptionReview(raw = {}, captionId) {
  const value = isObject(raw) ? raw : {};
  const status = REVIEW_STATUS_SET.has(value.reviewStatus) ? value.reviewStatus : 'pending';
  return {
    captionId: stringOrNull(value.captionId) || captionId,
    reviewStatus: status,
    reviewedAt: stringOrNull(value.reviewedAt),
    reviewedBy: stringOrNull(value.reviewedBy) || REVIEWED_BY,
    originalSuggestion: isObject(value.originalSuggestion)
      ? cloneSuggestion(value.originalSuggestion)
      : null,
    approvedText: stringOrNull(value.approvedText),
    approvedStartTime: finiteNumberOrNull(value.approvedStartTime),
    approvedEndTime: finiteNumberOrNull(value.approvedEndTime),
    timingMode: value.timingMode === 'image_shot' ? 'image_shot' : (value.timingMode === 'video_source' ? 'video_source' : null),
    userNotes: stringOrEmpty(value.userNotes).slice(0, MAX_USER_NOTES_LENGTH),
    warningsAcknowledged: asArray(value.warningsAcknowledged).map(String).slice(0, 20),
    staleReason: stringOrNull(value.staleReason),
    sourceMissing: value.sourceMissing === true,
  };
}

function normalizeAssetReview(raw = {}, assetId) {
  const value = isObject(raw) ? raw : {};
  const captions = {};
  const captionEntries = isObject(value.captions) ? value.captions : {};
  for (const [captionId, caption] of Object.entries(captionEntries)) {
    try {
      captions[captionId] = normalizeCaptionReview(caption, captionId);
    } catch {
      // Corrupt single caption records are skipped with a warning at load time.
    }
  }
  return {
    assetId: stringOrNull(value.assetId) || assetId,
    storyUnitId: stringOrNull(value.storyUnitId),
    sourceAnalysisFingerprint: stringOrNull(value.sourceAnalysisFingerprint),
    sourceAssetFingerprint: stringOrNull(value.sourceAssetFingerprint),
    reviewStatus: REVIEW_STATUS_SET.has(value.reviewStatus) ? value.reviewStatus : 'pending',
    reviewedAt: stringOrNull(value.reviewedAt),
    reviewedBy: stringOrNull(value.reviewedBy) || REVIEWED_BY,
    captions,
    preserveFullClipLocked: value.preserveFullClipLocked === true,
    preserveOriginalAudioLocked: value.preserveOriginalAudioLocked === true,
    trimNeedsHumanDecision: value.trimNeedsHumanDecision === true,
    audioNeedsHumanDecision: value.audioNeedsHumanDecision === true,
    unlockAudioReason: stringOrNull(value.unlockAudioReason),
    userNotes: stringOrEmpty(value.userNotes).slice(0, MAX_USER_NOTES_LENGTH),
    warningsAcknowledged: asArray(value.warningsAcknowledged).map(String).slice(0, 20),
    staleReason: stringOrNull(value.staleReason),
    schemaVersion: EDITORIAL_REVIEW_SCHEMA_VERSION,
  };
}

function normalizeStoredReview(payload) {
  if (!isObject(payload)) {
    return {
      ...emptyEditorialReview(),
      warnings: ['editorial-review.json 不是对象，已忽略损坏内容。'],
    };
  }
  const warnings = [];
  const reviews = {};
  const source = isObject(payload.reviews) ? payload.reviews : {};
  for (const [assetId, record] of Object.entries(source)) {
    try {
      if (!stringOrNull(assetId)) {
        warnings.push('跳过缺少 assetId 的审核记录。');
        continue;
      }
      reviews[assetId] = normalizeAssetReview(record, assetId);
    } catch (error) {
      warnings.push(`跳过损坏的审核记录 ${assetId}：${error.message || '未知错误'}`);
    }
  }
  return {
    schemaVersion: EDITORIAL_REVIEW_SCHEMA_VERSION,
    updatedAt: stringOrNull(payload.updatedAt),
    reviews,
    warnings: [
      ...asArray(payload.warnings).map(String),
      ...warnings,
    ].slice(0, 40),
  };
}

async function readOptionalProjectJson(projectPath, relativePath, label) {
  return readJsonFile(path.join(projectPath, relativePath), { optional: true, label });
}

async function loadEditorialReviewFile(projectPath) {
  const filePath = path.join(projectPath, EDITORIAL_REVIEW_FILE);
  try {
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return normalizeStoredReview(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return emptyEditorialReview();
    return {
      ...emptyEditorialReview(),
      warnings: [`editorial-review.json 损坏或无法解析：${error.message}`],
    };
  }
}

async function atomicWriteEditorialReview(projectPath, payload) {
  const filePath = path.join(projectPath, EDITORIAL_REVIEW_FILE);
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
  return filePath;
}

function findStoryUnit(analysis, manifest, storyUnitId, assetId) {
  const units = [
    ...asArray(analysis?.storyUnits),
    ...asArray(manifest?.storyUnits),
  ];
  if (storyUnitId) {
    const match = units.find((unit) => unit.storyUnitId === storyUnitId);
    if (match) return match;
  }
  return units.find((unit) => asArray(unit.assetIds).includes(assetId)) || null;
}

function collectCaptionsForAsset(analysis, assetId) {
  return asArray(analysis?.lightCaptionPlan).filter((caption) => caption?.assetId === assetId);
}

function isVideoType(type) {
  return type === 'video';
}

function isImageLikeType(type) {
  return type === 'image' || type === 'comic' || type === 'meme';
}

function effectivePreservation(assetReview, asset) {
  const plan = asset?.videoPreservationPlan || null;
  const audio = asset?.audioAnalysis || null;
  const preserveFullClip = assetReview?.preserveFullClipLocked === true
    ? true
    : plan?.preserveFullClip !== false;
  const preserveOriginalAudio = assetReview?.preserveOriginalAudioLocked === true
    ? true
    : audio?.preserveOriginalAudio !== false;
  return {
    preserveFullClip,
    preserveOriginalAudio,
    proposedIn: plan?.proposedIn ?? 0,
    proposedOut: plan?.proposedOut ?? plan?.sourceDuration ?? null,
    sourceDuration: plan?.sourceDuration ?? null,
    keepRatio: plan?.keepRatio ?? null,
    trimReason: plan?.trimReason ?? null,
    criticalMoments: asArray(plan?.criticalMoments),
    protectedTimeRanges: asArray(plan?.protectedTimeRanges),
    audioAvailable: audio?.audioAvailable ?? null,
    muteReason: audio?.muteReason ?? null,
  };
}

function validateCaptionTimes({
  mediaType,
  startTime,
  endTime,
  sourceDuration,
  preserveFullClip,
  proposedIn,
  proposedOut,
  excludedRanges = [],
}) {
  const errors = [];
  if (!isVideoType(mediaType)) {
    if (startTime != null || endTime != null) {
      // Image/comic captions may keep shot-relative display times, but must not
      // claim absolute video-source editing beyond the image shot convention.
      if (startTime != null && startTime < 0) errors.push('图片字幕开始时间不能小于 0。');
      if (endTime != null && startTime != null && endTime <= startTime) {
        errors.push('图片字幕结束时间必须大于开始时间。');
      }
    }
    return errors;
  }
  if (!Number.isFinite(startTime) || startTime < 0) {
    errors.push('视频字幕 startTime 不得小于 0。');
  }
  if (!Number.isFinite(endTime) || !(endTime > startTime)) {
    errors.push('视频字幕 endTime 必须大于 startTime。');
  }
  if (Number.isFinite(sourceDuration) && Number.isFinite(endTime) && endTime > sourceDuration + 0.05) {
    errors.push('视频字幕时间范围不得超过源视频时长。');
  }
  const keepIn = preserveFullClip ? 0 : (Number.isFinite(proposedIn) ? proposedIn : 0);
  const keepOut = preserveFullClip
    ? (Number.isFinite(sourceDuration) ? sourceDuration : proposedOut)
    : (Number.isFinite(proposedOut) ? proposedOut : sourceDuration);
  if (Number.isFinite(keepIn) && Number.isFinite(keepOut) && Number.isFinite(startTime) && Number.isFinite(endTime)) {
    if (startTime < keepIn - 0.05 || endTime > keepOut + 0.05) {
      errors.push('字幕时间范围不能位于最终保留区间之外。');
    }
  }
  for (const range of excludedRanges) {
    const left = Number(range.startSec ?? range.start);
    const right = Number(range.endSec ?? range.end);
    if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
    if (startTime < right - 0.02 && endTime > left + 0.02) {
      errors.push('字幕时间范围不得跨越已明确排除的片段。');
    }
  }
  return errors;
}

function validateCaptionDecision(captionReview, context) {
  const errors = [];
  const status = captionReview.reviewStatus;
  if (!REVIEW_STATUS_SET.has(status)) {
    errors.push(`未知审核状态：${status}`);
    return errors;
  }
  const text = status === 'edited_approved'
    ? stringOrNull(captionReview.approvedText)
    : (stringOrNull(captionReview.approvedText)
      || stringOrNull(captionReview.originalSuggestion?.text)
      || stringOrNull(context.suggestion?.text));

  if (CONFIRMED_CAPTION_STATUSES.has(status)) {
    if (!text) errors.push('已采用的字幕文本不能为空。');
    if (text && text.length > MAX_CAPTION_TEXT_LENGTH) {
      errors.push(`字幕文本长度不得超过 ${MAX_CAPTION_TEXT_LENGTH} 字。`);
    }
  }
  if (status === 'edited_approved' && !stringOrNull(captionReview.approvedText)) {
    errors.push('edited_approved 必须保存人工编辑后的文本。');
  }

  const startTime = status === 'edited_approved' || captionReview.approvedStartTime != null
    ? captionReview.approvedStartTime
    : captionReview.originalSuggestion?.startTime ?? context.suggestion?.startTime;
  const endTime = status === 'edited_approved' || captionReview.approvedEndTime != null
    ? captionReview.approvedEndTime
    : captionReview.originalSuggestion?.endTime ?? context.suggestion?.endTime;

  if (CONFIRMED_CAPTION_STATUSES.has(status) && isVideoType(context.mediaType)) {
    errors.push(...validateCaptionTimes({
      mediaType: context.mediaType,
      startTime,
      endTime,
      sourceDuration: context.sourceDuration,
      preserveFullClip: context.preserveFullClip,
      proposedIn: context.proposedIn,
      proposedOut: context.proposedOut,
      excludedRanges: context.excludedRanges,
    }));
  }

  if (isImageLikeType(context.mediaType) || context.mediaType === 'image') {
    if (captionReview.timingMode === 'video_source'
      && (captionReview.approvedStartTime != null || captionReview.approvedEndTime != null)
      && CONFIRMED_CAPTION_STATUSES.has(status)) {
      // Allow shot-relative times only.
      if (captionReview.approvedStartTime != null && captionReview.approvedStartTime < 0) {
        errors.push('图片不得保存非法视频源时间。');
      }
    }
    if (captionReview.forceVideoSourceTimes === true) {
      errors.push('图片不得保存非法视频源时间。');
    }
  }

  return errors;
}

function hasPersistedHumanDecision(review) {
  if (!review) return false;
  if (review.reviewStatus && review.reviewStatus !== 'pending') return true;
  if (review.preserveFullClipLocked || review.preserveOriginalAudioLocked) return true;
  if (review.trimNeedsHumanDecision || review.audioNeedsHumanDecision) return true;
  return Object.values(review.captions || {}).some((caption) => (
    caption.reviewStatus && caption.reviewStatus !== 'pending'
  ));
}

function markStale(review, reason) {
  if (!review) return review;
  if (!hasPersistedHumanDecision(review)) {
    return {
      ...review,
      staleReason: reason,
    };
  }
  const captions = Object.fromEntries(
    Object.entries(review.captions || {}).map(([captionId, caption]) => [
      captionId,
      caption.reviewStatus && caption.reviewStatus !== 'pending'
        ? {
          ...caption,
          reviewStatus: 'stale',
          staleReason: reason,
        }
        : caption,
    ]),
  );
  return {
    ...review,
    reviewStatus: 'stale',
    staleReason: reason,
    captions,
  };
}

function captionNeedsStale(captionReview, suggestion, mediaType, preservation) {
  if (!captionReview || captionReview.reviewStatus === 'pending') return null;
  if (!suggestion) return '原建议对应的关键分析结构不再存在。';
  if (!CONFIRMED_CAPTION_STATUSES.has(captionReview.reviewStatus)) return null;
  if (!isVideoType(mediaType)) return null;
  const start = captionReview.approvedStartTime ?? captionReview.originalSuggestion?.startTime;
  const end = captionReview.approvedEndTime ?? captionReview.originalSuggestion?.endTime;
  const errors = validateCaptionTimes({
    mediaType,
    startTime: start,
    endTime: end,
    sourceDuration: preservation.sourceDuration,
    preserveFullClip: preservation.preserveFullClip,
    proposedIn: preservation.proposedIn,
    proposedOut: preservation.proposedOut,
  });
  if (errors.length > 0) return '素材时长变化导致已确认时间范围无效。';
  return null;
}

function mergeEditorialReviews({
  stored,
  analysis,
  manifest,
  status,
}) {
  const warnings = [...asArray(stored?.warnings)];
  const analysisAssets = asArray(analysis?.assets);
  const hasStage5C = analysisAssets.some((asset) => (
    asset.visualTextAnalysis
    || asset.explanationPlan
    || asset.audioAnalysis
    || asset.videoPreservationPlan
  )) || asArray(analysis?.lightCaptionPlan).length > 0;

  const manifestById = new Map(asArray(manifest?.items).map((item) => [item.assetId, item]));
  const mappingById = new Map(asArray(status?.assetMappings).map((item) => [item.assetId, item]));
  const storyUnits = [
    ...asArray(analysis?.storyUnits),
    ...asArray(manifest?.storyUnits),
  ];
  const storyUnitById = new Map(storyUnits.map((unit) => [unit.storyUnitId, unit]));

  const nextReviews = {};
  const seenAssetIds = new Set();

  for (const asset of analysisAssets) {
    const assetId = asset.assetId;
    if (!assetId) continue;
    seenAssetIds.add(assetId);
    const item = manifestById.get(assetId);
    const mapping = mappingById.get(assetId);
    const mediaType = item?.type || mapping?.type || asset.type || 'unknown';
    const storyUnit = findStoryUnit(analysis, manifest, asset.storyUnitId, assetId);
    const captions = collectCaptionsForAsset(analysis, assetId);
    const contentFp = assetContentFingerprint(item, mapping);
    const analysisFp = analysisStructureFingerprint(asset, captions, storyUnit);
    const previous = stored?.reviews?.[assetId]
      ? normalizeAssetReview(stored.reviews[assetId], assetId)
      : null;

    let review = previous || {
      assetId,
      storyUnitId: asset.storyUnitId || storyUnit?.storyUnitId || null,
      sourceAnalysisFingerprint: analysisFp,
      sourceAssetFingerprint: contentFp,
      reviewStatus: 'pending',
      reviewedAt: null,
      reviewedBy: REVIEWED_BY,
      captions: {},
      preserveFullClipLocked: false,
      preserveOriginalAudioLocked: false,
      trimNeedsHumanDecision: false,
      audioNeedsHumanDecision: false,
      unlockAudioReason: null,
      userNotes: '',
      warningsAcknowledged: [],
      staleReason: null,
      schemaVersion: EDITORIAL_REVIEW_SCHEMA_VERSION,
    };

    const preservation = effectivePreservation(review, asset);
    const contentChanged = previous?.sourceAssetFingerprint
      && previous.sourceAssetFingerprint !== contentFp
      && !previous.sourceAssetFingerprint.startsWith('weak:');
    const storyUnitChanged = previous?.storyUnitId
      && storyUnit?.storyUnitId
      && previous.storyUnitId !== storyUnit.storyUnitId;
    const storyMembersChanged = previous?.storyUnitId
      && storyUnit
      && previous.sourceAnalysisFingerprint
      && previous.sourceAnalysisFingerprint !== analysisFp
      && JSON.stringify(asArray(storyUnitById.get(previous.storyUnitId)?.assetIds).slice().sort())
        !== JSON.stringify(asArray(storyUnit.assetIds).slice().sort());

    if (contentChanged) {
      review = markStale(review, '对应视觉素材内容发生变化或素材被替换。');
    } else if (storyUnitChanged || storyMembersChanged) {
      review = markStale(review, 'Story Unit 的真实来源映射发生变化。');
    }

    review.storyUnitId = asset.storyUnitId || storyUnit?.storyUnitId || review.storyUnitId || null;
    review.sourceAssetFingerprint = contentFp;
    // Keep prior analysis fingerprint for locked human decisions unless content/unit changed.
    if (!previous
      || review.reviewStatus === 'pending'
      || review.reviewStatus === 'needs_review'
      || contentChanged
      || storyUnitChanged) {
      review.sourceAnalysisFingerprint = analysisFp;
    }

    const nextCaptions = { ...review.captions };
    const seenCaptionIds = new Set();
    for (const suggestion of captions) {
      const captionId = suggestion.captionId;
      if (!captionId) continue;
      seenCaptionIds.add(captionId);
      const existing = nextCaptions[captionId]
        ? normalizeCaptionReview(nextCaptions[captionId], captionId)
        : null;
      if (!existing) {
        nextCaptions[captionId] = normalizeCaptionReview({
          captionId,
          reviewStatus: suggestion.reviewRequired ? 'needs_review' : 'pending',
          originalSuggestion: cloneSuggestion(suggestion),
          approvedText: null,
          approvedStartTime: null,
          approvedEndTime: null,
          timingMode: isVideoType(mediaType) ? 'video_source' : 'image_shot',
        }, captionId);
        continue;
      }

      const staleReason = captionNeedsStale(existing, suggestion, mediaType, preservation);
      const preserved = {
        ...existing,
        originalSuggestion: existing.originalSuggestion || cloneSuggestion(suggestion),
        sourceMissing: false,
      };
      // Human edited/approved text and times are never silently replaced.
      if (staleReason) {
        nextCaptions[captionId] = {
          ...markStale(preserved, staleReason),
          originalSuggestion: cloneSuggestion(suggestion),
        };
      } else {
        nextCaptions[captionId] = {
          ...preserved,
          originalSuggestion: existing.originalSuggestion || cloneSuggestion(suggestion),
        };
      }
    }

    for (const [captionId, captionReview] of Object.entries(nextCaptions)) {
      if (seenCaptionIds.has(captionId)) continue;
      if (captionReview.reviewStatus === 'pending' && !captionReview.approvedText) {
        // Pure pending suggestions that disappeared can remain marked missing.
        nextCaptions[captionId] = {
          ...captionReview,
          sourceMissing: true,
          staleReason: captionReview.staleReason || '原建议对应的关键分析结构不再存在。',
        };
        continue;
      }
      nextCaptions[captionId] = {
        ...markStale(captionReview, '原建议对应的关键分析结构不再存在。'),
        sourceMissing: true,
      };
    }

    review.captions = nextCaptions;
    nextReviews[assetId] = review;
  }

  // Preserve human records for assets that disappeared from analysis.
  for (const [assetId, previousRaw] of Object.entries(stored?.reviews || {})) {
    if (seenAssetIds.has(assetId)) continue;
    const previous = normalizeAssetReview(previousRaw, assetId);
    nextReviews[assetId] = {
      ...markStale(previous, '对应视觉素材已不在当前分析中。'),
      captions: Object.fromEntries(
        Object.entries(previous.captions).map(([captionId, caption]) => [
          captionId,
          {
            ...markStale(caption, '原建议对应的关键分析结构不再存在。'),
            sourceMissing: true,
          },
        ]),
      ),
    };
    warnings.push(`保留已消失素材 ${assetId} 的人工审核记录，并标记为 stale。`);
  }

  return {
    schemaVersion: EDITORIAL_REVIEW_SCHEMA_VERSION,
    updatedAt: stored?.updatedAt || null,
    reviews: nextReviews,
    warnings: warnings.slice(0, 40),
    hasStage5C,
  };
}

function summarizeEditorialReview(items) {
  const summary = {
    pending: 0,
    approved: 0,
    editedApproved: 0,
    notNeeded: 0,
    rejected: 0,
    needsReview: 0,
    stale: 0,
    withVisualText: 0,
    withWarnings: 0,
    fullClipLocked: 0,
    originalAudioLocked: 0,
    total: items.length,
  };
  for (const item of items) {
    const status = item.reviewStatus;
    if (status === 'pending') summary.pending += 1;
    if (status === 'approved') summary.approved += 1;
    if (status === 'edited_approved') summary.editedApproved += 1;
    if (status === 'not_needed') summary.notNeeded += 1;
    if (status === 'rejected') summary.rejected += 1;
    if (status === 'needs_review') summary.needsReview += 1;
    if (status === 'stale') summary.stale += 1;
    if (item.hasVisualText) summary.withVisualText += 1;
    if (item.warningCount > 0) summary.withWarnings += 1;
    if (item.preserveFullClipLocked) summary.fullClipLocked += 1;
    if (item.preserveOriginalAudioLocked) summary.originalAudioLocked += 1;
  }
  return summary;
}

function buildEvidenceSections(asset, item) {
  const explanation = asset?.explanationPlan || {};
  const visualText = asset?.visualTextAnalysis || { items: [], warnings: [] };
  const audio = asset?.audioAnalysis || null;
  const context = item?.context || asset?.contextUsage || null;
  return {
    visual: {
      visualSummary: explanation.visualSummary
        || asset?.contentSummary
        || null,
      visualEvidence: asArray(explanation.visualEvidenceUsed || asset?.evidence?.visualEvidenceUsed),
    },
    visualText: {
      items: asArray(visualText.items).map((entry) => ({
        sourceText: entry.sourceText || null,
        language: entry.language || null,
        translatedText: entry.translatedText || null,
        meaning: entry.meaning || null,
        textType: entry.textType || null,
        readingOrder: entry.readingOrder ?? null,
        speakerOrRegion: entry.speakerOrRegion || null,
        startTime: finiteNumberOrNull(entry.startTime),
        endTime: finiteNumberOrNull(entry.endTime),
        confidence: finiteNumberOrNull(entry.confidence),
        warnings: asArray(entry.warnings),
      })),
      panelCount: visualText.panelCount ?? null,
      readingDirection: visualText.readingDirection || null,
      warnings: asArray(visualText.warnings),
    },
    audio: audio ? {
      audioAvailable: audio.audioAvailable === true,
      speechPresent: audio.speechPresent === true,
      musicPresent: audio.musicPresent === true,
      soundEffectPresent: audio.soundEffectPresent === true,
      audioSummary: audio.audioSummary || null,
      audioNeededForUnderstanding: audio.audioNeededForUnderstanding === true,
      audioEvidence: asArray(asset?.evidence?.audioEvidenceUsed || audio.audioEvidence),
      preserveOriginalAudio: audio.preserveOriginalAudio === true,
      muteReason: audio.muteReason || null,
    } : null,
    context: {
      title: context?.title || context?.translatedTitle || null,
      body: context?.body || context?.summary || context?.translatedBody || null,
      translation: context?.translation || context?.translatedText || null,
      sourcePlatform: context?.sourcePlatform || context?.platform || null,
      contextEvidence: asArray(
        explanation.contextEvidenceUsed
        || asset?.evidence?.contextEvidenceUsed
        || (context?.contextEvidence ? [context.contextEvidence] : []),
      ),
      contextSourceFiles: asArray(
        asset?.contextUsage?.sourceFiles
        || context?.files
        || context?.sourceFiles,
      ),
    },
    explanation: {
      keyPoint: explanation.keyPoint || null,
      setup: explanation.setup || null,
      payoffOrResult: explanation.payoffOrResult || null,
      humorOrConflict: explanation.humorOrConflict || null,
      translatedMeaning: explanation.translatedMeaning || explanation.meaning || null,
      audienceNeedsExplanation: explanation.audienceNeedsExplanation || null,
      explanationReason: explanation.explanationReason || null,
      inference: asArray(explanation.inference || asset?.evidence?.inference),
      confidence: finiteNumberOrNull(explanation.confidence ?? asset?.confidence),
      warnings: asArray(explanation.warnings || asset?.warnings),
    },
  };
}

async function buildPreviewDescriptor(projectPath, mapping, item) {
  const relativePath = mapping?.projectRelativePath || null;
  if (!relativePath) {
    return {
      available: false,
      missing: true,
      message: '精选素材预览路径缺失。',
      fileUrl: null,
      relativePath: null,
      mediaType: item?.type || mapping?.type || 'unknown',
      hasAudio: mapping?.metadata?.hasAudio === true || item?.metadata?.hasAudio === true,
      durationSec: finiteNumberOrNull(mapping?.metadata?.durationSec ?? item?.metadata?.durationSec),
    };
  }
  try {
    const resolved = await resolveSafeProjectFile(projectPath, relativePath);
    if (!resolved.exists || (resolved.stat && !resolved.stat.isFile())) {
      return {
        available: false,
        missing: true,
        message: '源视觉素材或预览文件缺失。',
        fileUrl: null,
        relativePath,
        mediaType: item?.type || mapping?.type || 'unknown',
        hasAudio: mapping?.metadata?.hasAudio === true || item?.metadata?.hasAudio === true,
        durationSec: finiteNumberOrNull(mapping?.metadata?.durationSec ?? item?.metadata?.durationSec),
      };
    }
    return {
      available: true,
      missing: false,
      message: null,
      fileUrl: pathToFileURL(resolved.path).href,
      relativePath,
      mediaType: item?.type || mapping?.type || 'unknown',
      hasAudio: mapping?.metadata?.hasAudio === true || item?.metadata?.hasAudio === true,
      durationSec: finiteNumberOrNull(mapping?.metadata?.durationSec ?? item?.metadata?.durationSec),
    };
  } catch {
    return {
      available: false,
      missing: true,
      message: '预览路径无效或不安全。',
      fileUrl: null,
      relativePath,
      mediaType: item?.type || mapping?.type || 'unknown',
      hasAudio: false,
      durationSec: null,
    };
  }
}

function captionViewModel(captionReview, suggestion, mediaType, shotDurationSec) {
  const status = captionReview?.reviewStatus || 'pending';
  const original = captionReview?.originalSuggestion || cloneSuggestion(suggestion);
  const approvedText = captionReview?.approvedText
    || (status === 'approved' ? original?.text : null);
  const timingMode = isVideoType(mediaType) ? 'video_source' : 'image_shot';
  return {
    captionId: captionReview?.captionId || suggestion?.captionId,
    reviewStatus: status,
    suggestedText: original?.text || suggestion?.text || null,
    purpose: original?.purpose || suggestion?.purpose || null,
    basedOn: original?.basedOn || suggestion?.basedOn || null,
    confidence: original?.confidence ?? suggestion?.confidence ?? null,
    reviewRequired: original?.reviewRequired === true || suggestion?.reviewRequired === true,
    warnings: asArray(original?.warnings || suggestion?.warnings),
    approvedText,
    approvedStartTime: timingMode === 'video_source'
      ? (captionReview?.approvedStartTime ?? original?.startTime ?? suggestion?.startTime ?? null)
      : null,
    approvedEndTime: timingMode === 'video_source'
      ? (captionReview?.approvedEndTime ?? original?.endTime ?? suggestion?.endTime ?? null)
      : null,
    displayTiming: timingMode === 'video_source'
      ? {
        mode: 'video_source',
        startTime: captionReview?.approvedStartTime ?? original?.startTime ?? suggestion?.startTime ?? null,
        endTime: captionReview?.approvedEndTime ?? original?.endTime ?? suggestion?.endTime ?? null,
        label: null,
      }
      : {
        mode: 'image_shot',
        startTime: null,
        endTime: null,
        label: Number.isFinite(shotDurationSec)
          ? `在该图片镜头中显示（镜头约 ${shotDurationSec} 秒）`
          : '在该图片镜头中显示',
        shotDurationSec: Number.isFinite(shotDurationSec) ? shotDurationSec : null,
      },
    userNotes: captionReview?.userNotes || '',
    staleReason: captionReview?.staleReason || null,
    sourceMissing: captionReview?.sourceMissing === true,
    seekTimeSec: timingMode === 'video_source'
      ? finiteNumberOrNull(captionReview?.approvedStartTime ?? original?.startTime ?? suggestion?.startTime)
      : null,
  };
}

function assetWarningCount(asset, captions, review) {
  let count = asArray(asset?.warnings).length
    + asArray(asset?.explanationPlan?.warnings).length
    + asArray(asset?.visualTextAnalysis?.warnings).length
    + asArray(asset?.audioAnalysis?.warnings).length
    + asArray(asset?.videoPreservationPlan?.warnings).length;
  for (const caption of captions) count += asArray(caption.warnings).length;
  if (review?.staleReason) count += 1;
  if (review?.reviewStatus === 'stale') count += 1;
  return count;
}

function deriveAssetReviewStatus(review, captionsView) {
  if (review?.reviewStatus && review.reviewStatus !== 'pending') return review.reviewStatus;
  if (!captionsView.length) {
    return review?.reviewStatus || 'pending';
  }
  const statuses = captionsView.map((caption) => caption.reviewStatus);
  if (statuses.every((status) => status === 'not_needed')) return 'not_needed';
  if (statuses.every((status) => CONFIRMED_CAPTION_STATUSES.has(status) || status === 'not_needed' || status === 'rejected')) {
    if (statuses.some((status) => status === 'edited_approved')) return 'edited_approved';
    if (statuses.some((status) => status === 'approved')) return 'approved';
    if (statuses.every((status) => status === 'rejected')) return 'rejected';
  }
  if (statuses.some((status) => status === 'stale')) return 'stale';
  if (statuses.some((status) => status === 'needs_review')) return 'needs_review';
  if (statuses.every((status) => status === 'pending')) return 'pending';
  return review?.reviewStatus || 'pending';
}

async function buildEditorialReviewModel(projectPath, {
  analysis = null,
  manifest = null,
  status = null,
  stored = null,
} = {}) {
  const resolved = path.resolve(String(projectPath || ''));
  const [analysisFile, manifestFile, statusFile, storedFile] = await Promise.all([
    analysis ? Promise.resolve({ value: analysis }) : readOptionalProjectJson(resolved, CODEX_VIDEO_ANALYSIS_FILE, 'Codex 视频分析'),
    manifest ? Promise.resolve({ value: manifest }) : readOptionalProjectJson(resolved, CODEX_VIDEO_MANIFEST_FILE, 'Codex 视频素材清单'),
    status ? Promise.resolve({ value: status }) : readOptionalProjectJson(resolved, CODEX_VIDEO_STATUS_FILE, 'Codex 视频状态'),
    stored ? Promise.resolve(stored) : loadEditorialReviewFile(resolved),
  ]);

  const merged = mergeEditorialReviews({
    stored: storedFile,
    analysis: analysisFile.value,
    manifest: manifestFile.value,
    status: statusFile.value,
  });

  if (!merged.hasStage5C) {
    return {
      available: false,
      message: '暂无解释与轻字幕分析',
      schemaVersion: EDITORIAL_REVIEW_SCHEMA_VERSION,
      updatedAt: merged.updatedAt,
      relativePath: EDITORIAL_REVIEW_FILE,
      summary: summarizeEditorialReview([]),
      items: [],
      warnings: merged.warnings,
      reviews: merged.reviews,
    };
  }

  const analysisAssets = asArray(analysisFile.value?.assets);
  const manifestById = new Map(asArray(manifestFile.value?.items).map((item) => [item.assetId, item]));
  const mappingById = new Map(asArray(statusFile.value?.assetMappings).map((item) => [item.assetId, item]));
  const shots = asArray(analysisFile.value?.timeline?.shots);
  const items = [];

  for (const asset of analysisAssets) {
    const assetId = asset.assetId;
    if (!assetId) continue;
    try {
      const item = manifestById.get(assetId);
      const mapping = mappingById.get(assetId);
      const review = merged.reviews[assetId] || normalizeAssetReview({ assetId }, assetId);
      const mediaType = item?.type || mapping?.type || asset.type || 'unknown';
      const storyUnit = findStoryUnit(analysisFile.value, manifestFile.value, asset.storyUnitId, assetId);
      const captions = collectCaptionsForAsset(analysisFile.value, assetId);
      const shot = shots.find((entry) => entry.assetId === assetId);
      const preservation = effectivePreservation(review, asset);
      const captionsView = captions.map((suggestion) => {
        const captionReview = review.captions[suggestion.captionId]
          || normalizeCaptionReview({
            captionId: suggestion.captionId,
            reviewStatus: suggestion.reviewRequired ? 'needs_review' : 'pending',
            originalSuggestion: cloneSuggestion(suggestion),
          }, suggestion.captionId);
        return captionViewModel(captionReview, suggestion, mediaType, shot?.durationSec);
      });
      // Include orphaned human caption records.
      for (const [captionId, captionReview] of Object.entries(review.captions)) {
        if (captionsView.some((entry) => entry.captionId === captionId)) continue;
        captionsView.push(captionViewModel(captionReview, captionReview.originalSuggestion, mediaType, shot?.durationSec));
      }

      const preview = await buildPreviewDescriptor(resolved, mapping, item);
      const warningCount = assetWarningCount(asset, captions, review);
      const reviewStatus = deriveAssetReviewStatus(review, captionsView);
      items.push({
        assetId,
        storyUnitId: review.storyUnitId || asset.storyUnitId || storyUnit?.storyUnitId || null,
        storyUnitTheme: storyUnit?.theme || storyUnit?.title || storyUnit?.summary || null,
        filename: item?.filename || mapping?.projectFilename || assetId,
        mediaType,
        chapterId: asset.chapterId || item?.chapterId || storyUnit?.chapterId || null,
        narrativeRole: asset.narrativeRole || storyUnit?.narrativeRole || null,
        hasVisualText: asArray(asset.visualTextAnalysis?.items).length > 0,
        suggestsLightCaption: captions.length > 0,
        confidence: finiteNumberOrNull(asset.explanationPlan?.confidence ?? asset.confidence),
        reviewRequired: captions.some((caption) => caption.reviewRequired)
          || asset.explanationPlan?.audienceNeedsExplanation === 'insufficient_evidence',
        reviewStatus,
        warningCount,
        preserveFullClip: preservation.preserveFullClip,
        preserveFullClipLocked: review.preserveFullClipLocked === true,
        preserveOriginalAudio: preservation.preserveOriginalAudio,
        preserveOriginalAudioLocked: review.preserveOriginalAudioLocked === true,
        trimNeedsHumanDecision: review.trimNeedsHumanDecision === true,
        audioNeedsHumanDecision: review.audioNeedsHumanDecision === true,
        unlockAudioReason: review.unlockAudioReason,
        preservation,
        evidence: buildEvidenceSections(asset, item),
        captions: captionsView,
        preview,
        userNotes: review.userNotes || '',
        staleReason: review.staleReason,
        projectStableId: mapping?.projectStableId || null,
      });
    } catch (error) {
      merged.warnings.push(`素材 ${assetId} 审核模型构建失败：${error.message || '未知错误'}`);
    }
  }

  items.sort((left, right) => {
    const themeCompare = String(left.storyUnitTheme || '').localeCompare(String(right.storyUnitTheme || ''), 'zh');
    if (themeCompare !== 0) return themeCompare;
    return String(left.filename).localeCompare(String(right.filename), 'zh');
  });

  return {
    available: true,
    message: null,
    schemaVersion: EDITORIAL_REVIEW_SCHEMA_VERSION,
    updatedAt: merged.updatedAt,
    relativePath: EDITORIAL_REVIEW_FILE,
    summary: summarizeEditorialReview(items),
    items,
    warnings: merged.warnings,
    reviews: merged.reviews,
  };
}

function getConfirmedCaptions(editorialModelOrStored, {
  analysis = null,
} = {}) {
  const reviews = editorialModelOrStored?.reviews || {};
  const analysisCaptions = new Map(
    asArray(analysis?.lightCaptionPlan).map((caption) => [caption.captionId, caption]),
  );
  const confirmed = [];
  for (const review of Object.values(reviews)) {
    for (const caption of Object.values(review.captions || {})) {
      if (!CONFIRMED_CAPTION_STATUSES.has(caption.reviewStatus)) continue;
      const suggestion = caption.originalSuggestion || analysisCaptions.get(caption.captionId) || null;
      const text = caption.reviewStatus === 'edited_approved'
        ? caption.approvedText
        : (caption.approvedText || suggestion?.text || null);
      if (!text) continue;
      confirmed.push({
        captionId: caption.captionId,
        assetId: review.assetId,
        storyUnitId: review.storyUnitId || suggestion?.storyUnitId || null,
        reviewStatus: caption.reviewStatus,
        text,
        startTime: caption.approvedStartTime ?? suggestion?.startTime ?? null,
        endTime: caption.approvedEndTime ?? suggestion?.endTime ?? null,
        purpose: suggestion?.purpose || null,
        basedOn: suggestion?.basedOn || null,
        userNotes: caption.userNotes || '',
        warningsAcknowledged: asArray(caption.warningsAcknowledged),
      });
    }
  }
  return confirmed;
}

function assertKnownAssetIds(reviews, analysis, manifest, status) {
  const known = new Set([
    ...asArray(analysis?.assets).map((asset) => asset.assetId),
    ...asArray(manifest?.items).map((item) => item.assetId),
    ...asArray(status?.assetMappings).map((item) => item.assetId),
  ].filter(Boolean));
  for (const assetId of Object.keys(reviews || {})) {
    if (!known.has(assetId)) {
      throw Object.assign(new Error(`拒绝不存在的 assetId：${assetId}`), {
        code: 'UNKNOWN_ASSET_ID',
      });
    }
  }
}

function applyAssetPatch(existing, patch, context) {
  const next = normalizeAssetReview({ ...existing, ...patch, captions: existing.captions }, existing.assetId);
  if (Object.hasOwn(patch, 'reviewStatus')) {
    if (!REVIEW_STATUS_SET.has(patch.reviewStatus)) {
      throw new Error(`非法审核状态：${patch.reviewStatus}`);
    }
    next.reviewStatus = patch.reviewStatus;
  }
  if (Object.hasOwn(patch, 'preserveFullClipLocked')) {
    next.preserveFullClipLocked = patch.preserveFullClipLocked === true;
  }
  if (Object.hasOwn(patch, 'preserveOriginalAudioLocked')) {
    next.preserveOriginalAudioLocked = patch.preserveOriginalAudioLocked === true;
  }
  if (Object.hasOwn(patch, 'trimNeedsHumanDecision')) {
    next.trimNeedsHumanDecision = patch.trimNeedsHumanDecision === true;
  }
  if (Object.hasOwn(patch, 'audioNeedsHumanDecision')) {
    next.audioNeedsHumanDecision = patch.audioNeedsHumanDecision === true;
  }
  if (Object.hasOwn(patch, 'userNotes')) {
    next.userNotes = stringOrEmpty(patch.userNotes).slice(0, MAX_USER_NOTES_LENGTH);
  }
  if (Object.hasOwn(patch, 'unlockAudioReason')) {
    next.unlockAudioReason = stringOrNull(patch.unlockAudioReason);
  }
  if (Object.hasOwn(patch, 'warningsAcknowledged')) {
    next.warningsAcknowledged = asArray(patch.warningsAcknowledged).map(String).slice(0, 20);
  }

  // Prefer locking retain; unlocking original audio requires an explicit reason.
  if (next.preserveOriginalAudioLocked === false
    && context?.audio?.preserveOriginalAudio === true
    && existing.preserveOriginalAudioLocked === true) {
    if (!stringOrNull(next.unlockAudioReason)) {
      throw Object.assign(new Error('解除原声保留必须填写原因。'), {
        code: 'MUTE_REASON_REQUIRED',
      });
    }
  }
  if (patch.forceMute === true && !stringOrNull(patch.muteReason || next.unlockAudioReason)) {
    throw Object.assign(new Error('没有原因时不能人工设置静音。'), {
      code: 'MUTE_REASON_REQUIRED',
    });
  }

  next.reviewedAt = new Date().toISOString();
  next.reviewedBy = REVIEWED_BY;
  if (next.reviewStatus !== 'stale') next.staleReason = null;
  return next;
}

function applyCaptionPatch(existing, patch, context) {
  const next = normalizeCaptionReview({ ...existing, ...patch }, existing.captionId || patch.captionId);
  if (Object.hasOwn(patch, 'reviewStatus')) {
    if (!REVIEW_STATUS_SET.has(patch.reviewStatus)) {
      throw new Error(`非法字幕审核状态：${patch.reviewStatus}`);
    }
    next.reviewStatus = patch.reviewStatus;
  }
  if (Object.hasOwn(patch, 'approvedText')) {
    next.approvedText = stringOrNull(patch.approvedText);
  }
  if (Object.hasOwn(patch, 'approvedStartTime')) {
    next.approvedStartTime = finiteNumberOrNull(patch.approvedStartTime);
  }
  if (Object.hasOwn(patch, 'approvedEndTime')) {
    next.approvedEndTime = finiteNumberOrNull(patch.approvedEndTime);
  }
  if (Object.hasOwn(patch, 'userNotes')) {
    next.userNotes = stringOrEmpty(patch.userNotes).slice(0, MAX_USER_NOTES_LENGTH);
  }
  if (Object.hasOwn(patch, 'warningsAcknowledged')) {
    next.warningsAcknowledged = asArray(patch.warningsAcknowledged).map(String).slice(0, 20);
  }
  if (Object.hasOwn(patch, 'timingMode')) {
    next.timingMode = patch.timingMode === 'image_shot' ? 'image_shot' : 'video_source';
  }
  if (patch.forceVideoSourceTimes === true) next.forceVideoSourceTimes = true;

  if (!isVideoType(context.mediaType)) {
    next.timingMode = 'image_shot';
    if (patch.forceVideoSourceTimes === true) {
      throw Object.assign(new Error('图片不得保存非法视频源时间。'), {
        code: 'INVALID_IMAGE_TIMING',
      });
    }
  } else {
    next.timingMode = 'video_source';
  }

  const errors = validateCaptionDecision(next, context);
  if (errors.length > 0) {
    throw Object.assign(new Error(errors[0]), {
      code: 'INVALID_CAPTION_REVIEW',
      errors,
    });
  }
  next.reviewedAt = new Date().toISOString();
  next.reviewedBy = REVIEWED_BY;
  if (next.reviewStatus !== 'stale') next.staleReason = null;
  return next;
}

async function saveEditorialReview(projectPath, input = {}) {
  const resolved = path.resolve(String(projectPath || ''));
  const [analysisFile, manifestFile, statusFile, stored] = await Promise.all([
    readOptionalProjectJson(resolved, CODEX_VIDEO_ANALYSIS_FILE, 'Codex 视频分析'),
    readOptionalProjectJson(resolved, CODEX_VIDEO_MANIFEST_FILE, 'Codex 视频素材清单'),
    readOptionalProjectJson(resolved, CODEX_VIDEO_STATUS_FILE, 'Codex 视频状态'),
    loadEditorialReviewFile(resolved),
  ]);
  const merged = mergeEditorialReviews({
    stored,
    analysis: analysisFile.value,
    manifest: manifestFile.value,
    status: statusFile.value,
  });

  const patchReviews = isObject(input.reviews) ? input.reviews : {};
  assertKnownAssetIds(patchReviews, analysisFile.value, manifestFile.value, statusFile.value);

  const nextReviews = { ...merged.reviews };
  const analysisById = new Map(asArray(analysisFile.value?.assets).map((asset) => [asset.assetId, asset]));
  const manifestById = new Map(asArray(manifestFile.value?.items).map((item) => [item.assetId, item]));
  const mappingById = new Map(asArray(statusFile.value?.assetMappings).map((item) => [item.assetId, item]));

  for (const [assetId, patch] of Object.entries(patchReviews)) {
    const existing = nextReviews[assetId] || normalizeAssetReview({ assetId }, assetId);
    const asset = analysisById.get(assetId);
    const item = manifestById.get(assetId);
    const mapping = mappingById.get(assetId);
    const mediaType = item?.type || mapping?.type || asset?.type || 'unknown';
    const preservation = effectivePreservation(
      {
        ...existing,
        preserveFullClipLocked: patch.preserveFullClipLocked ?? existing.preserveFullClipLocked,
      },
      asset,
    );
    let updated = applyAssetPatch(existing, patch, {
      audio: asset?.audioAnalysis,
      mediaType,
      preservation,
    });

    if (isObject(patch.captions)) {
      const nextCaptions = { ...updated.captions };
      for (const [captionId, captionPatch] of Object.entries(patch.captions)) {
        const suggestion = asArray(analysisFile.value?.lightCaptionPlan)
          .find((caption) => caption.captionId === captionId && caption.assetId === assetId)
          || nextCaptions[captionId]?.originalSuggestion
          || null;
        if (!suggestion && !nextCaptions[captionId]) {
          throw Object.assign(new Error(`字幕建议不存在：${captionId}`), {
            code: 'UNKNOWN_CAPTION_ID',
          });
        }
        const current = nextCaptions[captionId] || normalizeCaptionReview({
          captionId,
          reviewStatus: 'pending',
          originalSuggestion: cloneSuggestion(suggestion),
        }, captionId);
        nextCaptions[captionId] = applyCaptionPatch(current, captionPatch, {
          mediaType,
          suggestion,
          sourceDuration: preservation.sourceDuration
            ?? finiteNumberOrNull(item?.metadata?.durationSec)
            ?? finiteNumberOrNull(mapping?.metadata?.durationSec),
          preserveFullClip: preservation.preserveFullClip,
          proposedIn: preservation.proposedIn,
          proposedOut: preservation.proposedOut,
          excludedRanges: asArray(asset?.videoPreservationPlan?.warnings).length
            ? []
            : [],
        });
      }
      updated = { ...updated, captions: nextCaptions };
    }
    nextReviews[assetId] = updated;
  }

  const payload = {
    schemaVersion: EDITORIAL_REVIEW_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    reviews: nextReviews,
    warnings: merged.warnings,
  };
  const filePath = await atomicWriteEditorialReview(resolved, payload);
  const model = await buildEditorialReviewModel(resolved, {
    analysis: analysisFile.value,
    manifest: manifestFile.value,
    status: statusFile.value,
    stored: payload,
  });
  return {
    ...model,
    saved: true,
    filePath,
    relativePath: EDITORIAL_REVIEW_FILE,
  };
}

function filterEditorialItems(items, filter = 'all', query = '') {
  const normalized = REVIEW_FILTERS.includes(filter) ? filter : 'all';
  const needle = String(query || '').trim().toLowerCase();
  return asArray(items).filter((item) => {
    if (normalized === 'pending' && !['pending', 'needs_review', 'stale'].includes(item.reviewStatus)) {
      return false;
    }
    if (normalized === 'confirmed' && !CONFIRMED_CAPTION_STATUSES.has(item.reviewStatus)) return false;
    if (normalized === 'not_needed' && item.reviewStatus !== 'not_needed') return false;
    if (normalized === 'warnings' && !(item.warningCount > 0)) return false;
    if (normalized === 'video' && item.mediaType !== 'video') return false;
    if (normalized === 'image' && !isImageLikeType(item.mediaType) && item.mediaType !== 'image') return false;
    if (!needle) return true;
    const haystack = [
      item.filename,
      item.storyUnitTheme,
      item.assetId,
      item.chapterId,
      item.narrativeRole,
      ...item.captions.map((caption) => caption.suggestedText || ''),
      ...item.captions.map((caption) => caption.approvedText || ''),
    ].join(' ').toLowerCase();
    return haystack.includes(needle);
  });
}

function seekTimeForCaption(caption) {
  if (!caption) return null;
  const seek = finiteNumberOrNull(caption.seekTimeSec ?? caption.approvedStartTime ?? caption.displayTiming?.startTime);
  if (seek == null || seek < 0) return null;
  return seek;
}

module.exports = {
  CONFIRMED_CAPTION_STATUSES,
  EDITORIAL_REVIEW_FILE,
  EDITORIAL_REVIEW_SCHEMA_VERSION,
  MAX_CAPTION_TEXT_LENGTH,
  REVIEW_FILTERS,
  REVIEW_STATUSES,
  REVIEWED_BY,
  analysisStructureFingerprint,
  assetContentFingerprint,
  buildEditorialReviewModel,
  emptyEditorialReview,
  filterEditorialItems,
  getConfirmedCaptions,
  loadEditorialReviewFile,
  mergeEditorialReviews,
  normalizeStoredReview,
  saveEditorialReview,
  seekTimeForCaption,
  summarizeEditorialReview,
  validateCaptionTimes,
};
