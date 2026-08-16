'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  CODEX_VIDEO_ANALYSIS_FILE,
  CODEX_VIDEO_MANIFEST_FILE,
  CODEX_VIDEO_STATUS_FILE,
} = require('../constants');
const { readJsonFile } = require('./project-json-service');
const {
  buildEditorialReviewModel,
  getConfirmedCaptions,
} = require('./editorial-review-service');
const {
  MANAGED_CAPTION_NOTE_PREFIX,
  buildFcpxml,
  collectFcpTitles,
  enrichAssetMappingsFrameMetadata,
  extractManagedCaptionTitles,
  fcpTime,
  frameDuration,
  frameIndexToRational,
  planFrameAlignedTimeline,
  quantizeCaptionTiming,
  rationalToSeconds,
  secondsToFrameIndex,
  writeFcpxml,
} = require('./fcpxml-service');

const MIN_READABLE_CAPTION_SEC = 1.2;
const MIN_CHARS_PER_SEC = 4;
const TIME_EPSILON = 0.02;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundTime(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function isVideoType(type) {
  return type === 'video';
}

function isImageLikeType(type) {
  return type === 'image' || type === 'comic' || type === 'meme';
}

function buildTitleKey({ captionId, assetId, matchedShotId, segmentIndex = null }) {
  const base = [
    'vcp-lc',
    String(captionId || ''),
    String(assetId || ''),
    String(matchedShotId || ''),
  ].join(':');
  if (segmentIndex == null) return base;
  return `${base}:seg${segmentIndex}`;
}

function indexShots(shots) {
  let cursor = 0;
  return asArray(shots).map((shot, index) => {
    const timelineStart = cursor;
    const timelineEnd = cursor + Number(shot.durationSec || 0);
    cursor = timelineEnd;
    return {
      shot,
      index,
      timelineStart,
      timelineEnd,
      sourceIn: Number(shot.inSec),
      sourceOut: Number(shot.outSec),
      durationSec: Number(shot.durationSec),
    };
  });
}

function shotHasUnsupportedRetiming(entry) {
  const shot = entry.shot || {};
  if (shot.rate != null && Number(shot.rate) !== 1) return true;
  if (shot.speed != null && Number(shot.speed) !== 1) return true;
  if (shot.timeMap != null || shot.retiming != null) return true;
  if (Number.isFinite(entry.sourceIn)
    && Number.isFinite(entry.sourceOut)
    && Number.isFinite(entry.durationSec)
    && Math.abs((entry.sourceOut - entry.sourceIn) - entry.durationSec) > TIME_EPSILON) {
    return true;
  }
  return false;
}

function mediaTypeForAsset(assetId, analysis, manifest, mappings) {
  const asset = asArray(analysis?.assets).find((item) => item.assetId === assetId);
  if (asset?.type) return asset.type;
  const item = asArray(manifest?.items).find((entry) => entry.assetId === assetId);
  if (item?.type) return item.type;
  const mapping = asArray(mappings).find((entry) => entry.assetId === assetId);
  return mapping?.type || null;
}

function storyUnitIdForAsset(assetId, analysis, manifest) {
  const asset = asArray(analysis?.assets).find((item) => item.assetId === assetId);
  if (asset?.storyUnitId) return asset.storyUnitId;
  const item = asArray(manifest?.items).find((entry) => entry.assetId === assetId);
  return item?.storyUnitId || null;
}

function chapterIdForShot(shot, analysis) {
  return shot?.chapterId
    || asArray(analysis?.assets).find((asset) => asset.assetId === shot?.assetId)?.chapterId
    || null;
}

function suggestionLookup(analysis) {
  return new Map(asArray(analysis?.lightCaptionPlan).map((caption) => [caption.captionId, caption]));
}

function readingOrderForCaption(caption, suggestion, analysis) {
  if (Number.isInteger(suggestion?.readingOrder)) return suggestion.readingOrder;
  if (Number.isInteger(caption.readingOrder)) return caption.readingOrder;
  const basedOn = suggestion?.basedOn || caption.basedOn;
  if (!basedOn) return null;
  const asset = asArray(analysis?.assets).find((item) => item.assetId === caption.assetId);
  const textItems = asArray(asset?.visualTextAnalysis?.items);
  const match = textItems.find((item, index) => (
    basedOn === item.sourceText
    || basedOn === `text:${index}`
    || basedOn === item.textType
  ));
  return Number.isInteger(match?.readingOrder) ? match.readingOrder : null;
}

function validateExportPlanEntry(entry) {
  const errors = [];
  if (!entry.captionId) errors.push('缺少 captionId。');
  if (!entry.assetId) errors.push('缺少 assetId。');
  if (!stringOrNull(entry.approvedText)) errors.push('approvedText 为空。');
  if (!['approved', 'edited_approved'].includes(entry.reviewStatus)) {
    errors.push(`非法导出状态：${entry.reviewStatus}`);
  }
  if (entry.exportable) {
    if (!entry.matchedShotId) errors.push('缺少 matchedShotId。');
    if (!Number.isFinite(entry.timelineStartTime) || !Number.isFinite(entry.timelineEndTime)) {
      errors.push('时间线时间无效。');
    } else if (entry.timelineEndTime <= entry.timelineStartTime) {
      errors.push('字幕时长必须大于 0。');
    }
    if (!Number.isFinite(entry.timelineDuration) || entry.timelineDuration <= 0) {
      errors.push('字幕时长必须大于 0。');
    }
    if (isImageLikeType(entry.mediaType)
      && (entry.sourceStartTime != null || entry.sourceEndTime != null)) {
      errors.push('图片字幕不得伪造源视频时间。');
    }
  }
  return errors;
}

function mapVideoCaptionToShots(caption, shotEntries, mediaType) {
  const warnings = [];
  const start = finiteNumberOrNull(caption.startTime);
  const end = finiteNumberOrNull(caption.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return {
      exportable: false,
      segments: [],
      warnings: ['视频字幕缺少合法源时间。'],
      mappingReason: 'invalid_source_time',
    };
  }

  const matching = shotEntries.filter((entry) => entry.shot.assetId === caption.assetId);
  if (!matching.length) {
    return {
      exportable: false,
      segments: [],
      warnings: ['字幕所属视觉素材未进入最终时间线。'],
      mappingReason: 'asset_not_on_timeline',
    };
  }

  const segments = [];
  for (const entry of matching) {
    if (shotHasUnsupportedRetiming(entry)) {
      return {
        exportable: false,
        segments: [],
        warnings: ['镜头存在不支持的变速或速率映射，拒绝线性换算。'],
        mappingReason: 'unsupported_retiming',
      };
    }
    const overlapStart = Math.max(start, entry.sourceIn);
    const overlapEnd = Math.min(end, entry.sourceOut);
    if (overlapEnd - overlapStart <= TIME_EPSILON) continue;
    const partial = overlapStart > start + TIME_EPSILON || overlapEnd < end - TIME_EPSILON;
    if (partial) {
      warnings.push('字幕与镜头源区间仅部分重叠，已裁为实际重叠区间。');
    }
    const timelineStartTime = roundTime(entry.timelineStart + (overlapStart - entry.sourceIn));
    const timelineEndTime = roundTime(entry.timelineStart + (overlapEnd - entry.sourceIn));
    const timelineDuration = roundTime(timelineEndTime - timelineStartTime);
    if (timelineDuration <= 0) continue;
    if (timelineStartTime < entry.timelineStart - TIME_EPSILON
      || timelineEndTime > entry.timelineEnd + TIME_EPSILON) {
      warnings.push('映射后字幕越过镜头边界，已跳过。');
      continue;
    }
    segments.push({
      matchedShotId: entry.shot.id,
      matchedShotIndex: entry.index,
      chapterId: chapterIdForShot(entry.shot),
      sourceIn: entry.sourceIn,
      sourceOut: entry.sourceOut,
      sourceStartTime: roundTime(overlapStart),
      sourceEndTime: roundTime(overlapEnd),
      timelineStartTime,
      timelineEndTime,
      timelineDuration,
      mediaType,
      partialOverlap: partial,
    });
  }

  if (!segments.length) {
    return {
      exportable: false,
      segments: [],
      warnings: warnings.length ? warnings : ['字幕完全位于选用源区间外。'],
      mappingReason: 'outside_source_range',
    };
  }

  return {
    exportable: true,
    segments,
    warnings,
    mappingReason: segments.length > 1 ? 'split_across_shots' : 'video_source_mapped',
  };
}

function allocateImageCaptionWindows(captions, shotEntry, fps = 30) {
  const duration = shotEntry.durationSec;
  const count = captions.length;
  if (count === 0) return [];
  const sequenceFrameDuration = frameDuration(fps);
  const totalFrames = Math.max(
    1,
    Number.isInteger(shotEntry.durationFrames)
      ? shotEntry.durationFrames
      : secondsToFrameIndex(duration, sequenceFrameDuration, 'nearest'),
  );
  // Use whole-frame margins instead of 0.15s float insets.
  const marginFrames = Math.min(
    Math.max(1, secondsToFrameIndex(Math.min(0.15, duration * 0.05), sequenceFrameDuration, 'nearest')),
    Math.max(0, Math.floor((totalFrames - 1) / 2)),
  );

  if (count === 1) {
    if (totalFrames <= marginFrames * 2) {
      return [{
        caption: captions[0],
        timelineStartTime: shotEntry.timelineStart,
        timelineEndTime: shotEntry.timelineEnd,
        timelineDuration: duration,
        conflict: false,
        warnings: [],
      }];
    }
    const start = shotEntry.timelineStart
      + rationalSecondsFromFrames(marginFrames, sequenceFrameDuration);
    const end = shotEntry.timelineEnd
      - rationalSecondsFromFrames(marginFrames, sequenceFrameDuration);
    return [{
      caption: captions[0],
      timelineStartTime: start,
      timelineEndTime: end,
      timelineDuration: end - start,
      conflict: false,
      warnings: [],
    }];
  }

  const gapFrames = Math.max(1, secondsToFrameIndex(0.12, sequenceFrameDuration, 'nearest'));
  const totalGapFrames = gapFrames * (count - 1);
  const availableFrames = totalFrames - totalGapFrames;
  const eachFrames = Math.floor(availableFrames / count);
  if (eachFrames < secondsToFrameIndex(MIN_READABLE_CAPTION_SEC, sequenceFrameDuration, 'ceil')) {
    return captions.map((caption) => ({
      caption,
      timelineStartTime: null,
      timelineEndTime: null,
      timelineDuration: null,
      conflict: true,
      warnings: [`图片镜头时长不足以按可读速度排布 ${count} 条字幕，需重新审阅。`],
    }));
  }

  let cursorFrame = 0;
  return captions.map((caption, index) => {
    const startFrame = cursorFrame;
    const endFrame = index === count - 1
      ? totalFrames
      : startFrame + eachFrames;
    cursorFrame = endFrame + gapFrames;
    const start = shotEntry.timelineStart
      + rationalSecondsFromFrames(startFrame, sequenceFrameDuration);
    const end = shotEntry.timelineStart
      + rationalSecondsFromFrames(endFrame, sequenceFrameDuration);
    return {
      caption,
      timelineStartTime: start,
      timelineEndTime: end,
      timelineDuration: end - start,
      conflict: false,
      warnings: [],
    };
  });
}

function rationalSecondsFromFrames(frames, frameDur) {
  return rationalToSeconds(frameIndexToRational(frames, frameDur));
}

function mapImageCaptionsForAsset(captions, shotEntries, analysis) {
  const assetId = captions[0]?.caption?.assetId || captions[0]?.assetId;
  const matching = shotEntries.filter((entry) => entry.shot.assetId === assetId);
  if (!matching.length) {
    return captions.map((item) => ({
      caption: item.caption || item,
      exportable: false,
      segments: [],
      warnings: ['字幕所属视觉素材未进入最终时间线。'],
      mappingReason: 'asset_not_on_timeline',
    }));
  }

  const warningsShared = [];
  if (matching.length > 1) {
    warningsShared.push('同一图片在时间线出现多次，字幕映射到首次出现的镜头。');
  }
  const shotEntry = matching[0];
  if (shotHasUnsupportedRetiming(shotEntry)) {
    return captions.map((item) => ({
      caption: item.caption || item,
      exportable: false,
      segments: [],
      warnings: ['镜头存在不支持的变速或速率映射，拒绝导出。'],
      mappingReason: 'unsupported_retiming',
    }));
  }

  const ordered = captions.slice().sort((left, right) => {
    const leftCaption = left.caption || left;
    const rightCaption = right.caption || right;
    const leftSuggestion = left.suggestion || null;
    const rightSuggestion = right.suggestion || null;
    const leftOrder = readingOrderForCaption(leftCaption, leftSuggestion, analysis) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = readingOrderForCaption(rightCaption, rightSuggestion, analysis) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return String(leftCaption.captionId).localeCompare(String(rightCaption.captionId));
  });

  const windows = allocateImageCaptionWindows(
    ordered.map((item) => item.caption || item),
    shotEntry,
    analysis?.timeline?.fps || 30,
  );
  return windows.map((window, index) => {
    const source = ordered[index];
    const caption = source.caption || source;
    const warnings = [...warningsShared, ...window.warnings];
    if (window.conflict || !Number.isFinite(window.timelineDuration) || window.timelineDuration <= 0) {
      return {
        caption,
        suggestion: source.suggestion || null,
        exportable: false,
        segments: [],
        warnings,
        mappingReason: 'image_timing_conflict',
      };
    }
    if (window.timelineStartTime < shotEntry.timelineStart - TIME_EPSILON
      || window.timelineEndTime > shotEntry.timelineEnd + TIME_EPSILON) {
      return {
        caption,
        suggestion: source.suggestion || null,
        exportable: false,
        segments: [],
        warnings: [...warnings, '图片字幕越过镜头边界。'],
        mappingReason: 'outside_shot_bounds',
      };
    }
    return {
      caption,
      suggestion: source.suggestion || null,
      exportable: true,
      segments: [{
        matchedShotId: shotEntry.shot.id,
        matchedShotIndex: shotEntry.index,
        chapterId: chapterIdForShot(shotEntry.shot, analysis),
        sourceIn: shotEntry.sourceIn,
        sourceOut: shotEntry.sourceOut,
        sourceStartTime: null,
        sourceEndTime: null,
        timelineStartTime: window.timelineStartTime,
        timelineEndTime: window.timelineEndTime,
        timelineDuration: window.timelineDuration,
        mediaType: source.mediaType || 'image',
        partialOverlap: false,
      }],
      warnings,
      mappingReason: 'image_shot_mapped',
    };
  });
}

function readabilityWarnings(text, durationSec) {
  const warnings = [];
  const value = String(text || '');
  if (durationSec > 0 && durationSec < MIN_READABLE_CAPTION_SEC) {
    warnings.push(`字幕时长 ${durationSec} 秒偏短，可能不易阅读。`);
  }
  if (durationSec > 0 && value.length / durationSec > 12) {
    warnings.push('字幕文字相对显示时长偏长，可能不易阅读。');
  }
  if (value.length > 40) {
    warnings.push('字幕文字超过建议长度，未截断，请确认可读性。');
  }
  if (durationSec > 0 && value.length > 0 && durationSec < value.length / MIN_CHARS_PER_SEC) {
    warnings.push('按阅读速度估算显示时间不足。');
  }
  return warnings;
}

function detectPlanConflicts(entries) {
  const byCaption = new Map();
  const byTitleKey = new Map();
  const conflicts = [];

  for (const entry of entries) {
    byCaption.set(entry.captionId, (byCaption.get(entry.captionId) || 0) + 1);
    byTitleKey.set(entry.titleKey, (byTitleKey.get(entry.titleKey) || 0) + 1);
  }
  for (const [captionId, count] of byCaption) {
    if (count > 1) conflicts.push({ type: 'duplicate_captionId', captionId, message: `captionId 重复：${captionId}` });
  }
  for (const [titleKey, count] of byTitleKey) {
    if (count > 1) conflicts.push({ type: 'duplicate_titleKey', titleKey, message: `titleKey 重复：${titleKey}` });
  }

  const exportable = entries.filter((entry) => entry.exportable);
  for (let i = 0; i < exportable.length; i += 1) {
    for (let j = i + 1; j < exportable.length; j += 1) {
      const left = exportable[i];
      const right = exportable[j];
      if (left.matchedShotId !== right.matchedShotId) continue;
      const sameText = left.approvedText === right.approvedText;
      const sameRange = Math.abs(left.timelineStartTime - right.timelineStartTime) <= TIME_EPSILON
        && Math.abs(left.timelineEndTime - right.timelineEndTime) <= TIME_EPSILON;
      if (sameText && sameRange) {
        conflicts.push({
          type: 'identical_title',
          captionId: right.captionId,
          titleKey: right.titleKey,
          message: `同一镜头存在完全相同的字幕：${right.captionId}`,
        });
        right.exportable = false;
        right.warnings = [...asArray(right.warnings), '与同镜头字幕完全重复，已跳过。'];
        continue;
      }
      const overlapStart = Math.max(left.timelineStartTime, right.timelineStartTime);
      const overlapEnd = Math.min(left.timelineEndTime, right.timelineEndTime);
      const overlap = overlapEnd - overlapStart;
      if (overlap <= TIME_EPSILON) continue;
      const shorter = Math.min(left.timelineDuration, right.timelineDuration);
      if (overlap / shorter >= 0.8) {
        conflicts.push({
          type: 'severe_overlap',
          captionId: right.captionId,
          titleKey: right.titleKey,
          message: `同镜头字幕严重重叠：${left.captionId} 与 ${right.captionId}`,
        });
        right.exportable = false;
        right.warnings = [...asArray(right.warnings), '同镜头字幕严重重叠，已阻止导出。'];
      } else {
        left.warnings = [...asArray(left.warnings), `与 ${right.captionId} 存在部分时间重叠。`];
        right.warnings = [...asArray(right.warnings), `与 ${left.captionId} 存在部分时间重叠。`];
      }
    }
  }
  return conflicts;
}

/**
 * After timeline mapping, quantize managed-caption start/end onto the sequence
 * frame grid (actual frameDuration). Does not mutate confirmed source times in
 * editorial-review.json — only export timeline times used for FCPXML.
 */
function alignExportPlanToFrameBoundaries(entries, shotEntries, fps, assetMappings = []) {
  const conflicts = [];
  const sequenceFrameDuration = frameDuration(fps);
  const timelineEnd = shotEntries.length
    ? shotEntries[shotEntries.length - 1].timelineEnd
    : 0;
  const shotsById = new Map(shotEntries.map((entry) => [entry.shot.id, entry]));
  const plannedById = new Map();
  if (shotEntries.length && fps) {
    const plan = planFrameAlignedTimeline({
      analysis: {
        timeline: {
          fps,
          shots: shotEntries.map((entry) => entry.shot),
        },
      },
      assetMappings,
    });
    for (const planned of plan.shots) {
      plannedById.set(planned.shot.id, planned);
    }
  }

  for (const entry of entries) {
    if (!entry.exportable) continue;
    const shotEntry = shotsById.get(entry.matchedShotId);
    if (!shotEntry) {
      entry.exportable = false;
      entry.mappingReason = 'frame_alignment_missing_shot';
      entry.warnings = [...asArray(entry.warnings), '对齐帧边界时找不到所属镜头。'];
      conflicts.push({
        type: 'frame_alignment_missing_shot',
        captionId: entry.captionId,
        titleKey: entry.titleKey,
        message: `对齐帧边界时找不到镜头：${entry.matchedShotId}`,
      });
      continue;
    }

    const planned = plannedById.get(entry.matchedShotId);
    const hostSourceIn = planned ? planned.sourceInSec : shotEntry.sourceIn;
    const hostDurationSec = planned ? planned.durationSec : shotEntry.durationSec;
    const hostTimelineStart = planned ? planned.timelineStartSec : shotEntry.timelineStart;
    const hostTimelineEnd = planned
      ? planned.timelineEndSec
      : shotEntry.timelineEnd;
    const stillOffset = isImageLikeType(entry.mediaType) ? 3600 : 0;
    const sourceStart = shotEntry.sourceIn
      + (entry.timelineStartTime - shotEntry.timelineStart);
    const sourceEnd = shotEntry.sourceIn
      + (entry.timelineEndTime - shotEntry.timelineStart);
    const minOffset = stillOffset + hostSourceIn;
    const maxByShot = stillOffset + hostSourceIn + hostDurationSec;
    const maxByTimeline = stillOffset + hostSourceIn
      + Math.max(0, (planned ? planned.timelineEndSec : Math.max(timelineEnd, hostTimelineEnd)) - hostTimelineStart);
    const maxOffset = Math.min(maxByShot, maxByTimeline);

    const quantized = quantizeCaptionTiming({
      startSec: stillOffset + sourceStart,
      endSec: stillOffset + sourceEnd,
      minSec: minOffset,
      maxSec: maxOffset,
      frameDuration: sequenceFrameDuration,
    });

    if (!quantized.ok) {
      entry.exportable = false;
      entry.mappingReason = 'frame_alignment_insufficient';
      entry.warnings = [
        ...asArray(entry.warnings),
        quantized.message || '对齐帧边界后不足一帧，已阻止导出。',
      ];
      conflicts.push({
        type: 'frame_alignment_insufficient',
        captionId: entry.captionId,
        titleKey: entry.titleKey,
        message: quantized.message || '对齐帧边界后不足一帧，已阻止导出。',
      });
      continue;
    }

    const alignedSourceStart = quantized.startSec - stillOffset;
    const alignedSourceEnd = quantized.endSec - stillOffset;
    entry.timelineStartTime = hostTimelineStart + (alignedSourceStart - hostSourceIn);
    entry.timelineEndTime = hostTimelineStart + (alignedSourceEnd - hostSourceIn);
    entry.timelineDuration = entry.timelineEndTime - entry.timelineStartTime;
    entry.frameAlignment = {
      adjusted: quantized.adjusted === true,
      frameDuration: quantized.frameDuration,
      startFrame: quantized.startFrame,
      endFrame: quantized.endFrame,
      durationFrames: quantized.durationFrames,
      deltaStartSec: quantized.deltaStartSec,
      deltaEndSec: quantized.deltaEndSec,
      offsetTime: quantized.startTime,
      durationTime: quantized.durationTime,
    };

    if (quantized.adjusted) {
      entry.warnings = [
        ...asArray(entry.warnings),
        'frameAlignmentAdjusted: 字幕时间已吸附到项目帧边界（调整幅度小于半帧为正常）。',
      ];
    }

    // Re-validate after quantization.
    entry.validationErrors = validateExportPlanEntry(entry);
    if (entry.validationErrors.length) {
      entry.exportable = false;
      entry.mappingReason = 'frame_alignment_invalid';
    }
  }

  return conflicts;
}

function buildCaptionExportPlan({
  confirmedCaptions,
  analysis,
  manifest = null,
  assetMappings = [],
}) {
  const shotEntries = indexShots(analysis?.timeline?.shots);
  const suggestions = suggestionLookup(analysis);
  const knownAssets = new Set([
    ...asArray(analysis?.assets).map((asset) => asset.assetId),
    ...asArray(manifest?.items).map((item) => item.assetId),
    ...asArray(assetMappings).map((item) => item.assetId),
  ].filter(Boolean));

  const prepared = [];
  const imageGroups = new Map();

  for (const caption of asArray(confirmedCaptions)) {
    const mediaType = mediaTypeForAsset(caption.assetId, analysis, manifest, assetMappings);
    const suggestion = suggestions.get(caption.captionId) || null;
    const storyUnitId = caption.storyUnitId
      || suggestion?.storyUnitId
      || storyUnitIdForAsset(caption.assetId, analysis, manifest);
    const base = {
      caption,
      suggestion,
      mediaType,
      storyUnitId,
    };

    if (!caption.assetId || !knownAssets.has(caption.assetId)) {
      prepared.push({
        ...base,
        mapped: {
          exportable: false,
          segments: [],
          warnings: ['不存在的 assetId，已拦截。'],
          mappingReason: 'unknown_asset',
        },
      });
      continue;
    }
    if (!storyUnitId) {
      // Story Unit 缺失只警告，不单独阻断（素材可能仍在时间线）。
      base.storyUnitWarning = 'Story Unit 不存在。';
    }
    if (isImageLikeType(mediaType)) {
      const list = imageGroups.get(caption.assetId) || [];
      list.push(base);
      imageGroups.set(caption.assetId, list);
      continue;
    }
    if (!isVideoType(mediaType)) {
      prepared.push({
        ...base,
        mapped: {
          exportable: false,
          segments: [],
          warnings: [`不支持的媒体类型：${mediaType || 'unknown'}`],
          mappingReason: 'unsupported_media_type',
        },
      });
      continue;
    }
    prepared.push({
      ...base,
      mapped: mapVideoCaptionToShots(caption, shotEntries, mediaType),
    });
  }

  for (const group of imageGroups.values()) {
    const mappedGroup = mapImageCaptionsForAsset(group, shotEntries, analysis);
    for (const item of mappedGroup) {
      prepared.push({
        caption: item.caption,
        suggestion: item.suggestion || suggestions.get(item.caption.captionId) || null,
        mediaType: mediaTypeForAsset(item.caption.assetId, analysis, manifest, assetMappings),
        storyUnitId: item.caption.storyUnitId
          || storyUnitIdForAsset(item.caption.assetId, analysis, manifest),
        mapped: item,
      });
    }
  }

  const entries = [];
  for (const item of prepared) {
    const { caption, suggestion, mediaType, storyUnitId, mapped, storyUnitWarning } = item;
    const reviewRecordId = `${caption.assetId}:${caption.captionId}`;
    const segments = mapped.segments || [];
    if (!segments.length) {
      const entry = {
        captionId: caption.captionId,
        reviewRecordId,
        assetId: caption.assetId,
        storyUnitId: storyUnitId || null,
        reviewStatus: caption.reviewStatus,
        approvedText: caption.text || null,
        sourceStartTime: isVideoType(mediaType) ? finiteNumberOrNull(caption.startTime) : null,
        sourceEndTime: isVideoType(mediaType) ? finiteNumberOrNull(caption.endTime) : null,
        timelineStartTime: null,
        timelineEndTime: null,
        timelineDuration: null,
        matchedShotId: null,
        matchedShotIndex: null,
        chapterId: null,
        sourceIn: null,
        sourceOut: null,
        mediaType,
        titleKey: buildTitleKey({
          captionId: caption.captionId,
          assetId: caption.assetId,
          matchedShotId: 'unmatched',
        }),
        mappingReason: mapped.mappingReason || 'unmapped',
        warnings: [
          ...asArray(mapped.warnings),
          ...(storyUnitWarning ? [storyUnitWarning] : []),
        ],
        exportable: false,
        purpose: caption.purpose || suggestion?.purpose || null,
        basedOn: caption.basedOn || suggestion?.basedOn || null,
      };
      entry.validationErrors = validateExportPlanEntry(entry);
      entries.push(entry);
      continue;
    }

    segments.forEach((segment, segmentIndex) => {
      const multi = segments.length > 1;
      const titleKey = buildTitleKey({
        captionId: caption.captionId,
        assetId: caption.assetId,
        matchedShotId: segment.matchedShotId,
        segmentIndex: multi ? segmentIndex + 1 : null,
      });
      const warnings = [
        ...asArray(mapped.warnings),
        ...(storyUnitWarning ? [storyUnitWarning] : []),
        ...(multi ? [`字幕跨越多个连续镜头，已拆分为第 ${segmentIndex + 1}/${segments.length} 段。`] : []),
        ...readabilityWarnings(caption.text, segment.timelineDuration),
      ];
      const entry = {
        captionId: caption.captionId,
        reviewRecordId,
        assetId: caption.assetId,
        storyUnitId: storyUnitId || null,
        reviewStatus: caption.reviewStatus,
        approvedText: caption.text || null,
        sourceStartTime: segment.sourceStartTime,
        sourceEndTime: segment.sourceEndTime,
        timelineStartTime: segment.timelineStartTime,
        timelineEndTime: segment.timelineEndTime,
        timelineDuration: segment.timelineDuration,
        matchedShotId: segment.matchedShotId,
        matchedShotIndex: segment.matchedShotIndex,
        chapterId: segment.chapterId || chapterIdForShot(
          shotEntries[segment.matchedShotIndex]?.shot,
          analysis,
        ),
        sourceIn: segment.sourceIn,
        sourceOut: segment.sourceOut,
        mediaType: segment.mediaType || mediaType,
        titleKey,
        mappingReason: mapped.mappingReason || 'mapped',
        warnings,
        exportable: mapped.exportable === true,
        purpose: caption.purpose || suggestion?.purpose || null,
        basedOn: caption.basedOn || suggestion?.basedOn || null,
      };
      entry.validationErrors = validateExportPlanEntry(entry);
      if (entry.validationErrors.length) entry.exportable = false;
      entries.push(entry);
    });
  }

  const frameConflicts = alignExportPlanToFrameBoundaries(
    entries,
    shotEntries,
    analysis?.timeline?.fps,
    assetMappings,
  );
  const conflicts = [...frameConflicts, ...detectPlanConflicts(entries)];
  const exportableEntries = entries.filter((entry) => entry.exportable);
  return {
    entries,
    exportableEntries,
    conflicts,
    summary: {
      confirmedCount: asArray(confirmedCaptions).length,
      exportableCount: exportableEntries.length,
      skippedCount: entries.filter((entry) => !entry.exportable).length,
      unmatchedShotCount: entries.filter((entry) => entry.mappingReason === 'asset_not_on_timeline').length,
      mappingFailureCount: entries.filter((entry) => !entry.exportable && entry.mappingReason !== 'asset_not_on_timeline').length,
      conflictCount: conflicts.length,
      splitSegmentCount: entries.filter((entry) => /:seg\d+$/.test(entry.titleKey)).length,
      frameAlignmentAdjustedCount: exportableEntries.filter((entry) => entry.frameAlignment?.adjusted).length,
    },
  };
}

function toManagedCaptionTitles(exportableEntries) {
  return exportableEntries.map((entry, index) => ({
    kind: 'managed_light_caption',
    titleKey: entry.titleKey,
    captionId: entry.captionId,
    assetId: entry.assetId,
    matchedShotId: entry.matchedShotId,
    startSec: entry.timelineStartTime,
    durationSec: entry.timelineDuration,
    text: entry.approvedText,
    note: `${MANAGED_CAPTION_NOTE_PREFIX}${entry.titleKey}`,
    // Prefer exact frame-grid strings produced during plan alignment.
    offsetFcpTime: entry.frameAlignment?.offsetTime || null,
    durationFcpTime: entry.frameAlignment?.durationTime || null,
    frameAlignment: entry.frameAlignment || null,
    index,
  }));
}

function reconcileManagedTitles(previousManaged, nextManaged) {
  const previousByKey = new Map(asArray(previousManaged).map((item) => [item.titleKey, item]));
  const nextByKey = new Map(asArray(nextManaged).map((item) => [item.titleKey, item]));
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let removed = 0;
  const details = [];

  for (const [titleKey, next] of nextByKey) {
    const previous = previousByKey.get(titleKey);
    if (!previous) {
      added += 1;
      details.push({ titleKey, action: 'add', text: next.text });
      continue;
    }
    previousByKey.delete(titleKey);
    const sameText = String(previous.text || '') === String(next.text || '');
    let sameDuration = true;
    try {
      sameDuration = !previous.duration || previous.duration === fcpTime(next.durationSec);
    } catch {
      sameDuration = true;
    }
    if (sameText && sameDuration) {
      unchanged += 1;
      details.push({ titleKey, action: 'keep', text: next.text });
    } else {
      updated += 1;
      details.push({
        titleKey,
        action: 'update',
        text: next.text,
        previousText: previous.text,
      });
    }
  }
  for (const [titleKey, previous] of previousByKey) {
    removed += 1;
    details.push({ titleKey, action: 'remove', text: previous.text });
  }
  return { added, updated, unchanged, removed, details };
}

function summarizeXmlProtection(beforeXml, afterXml) {
  const beforeMarkers = [...(beforeXml || '').matchAll(/<marker\s+/g)].length;
  const afterMarkers = [...(afterXml || '').matchAll(/<marker\s+/g)].length;
  const beforeClips = [...(beforeXml || '').matchAll(/<(?:asset-clip|video)\s+/g)].length;
  const afterClips = [...(afterXml || '').matchAll(/<(?:asset-clip|video)\s+/g)].length;
  const beforeUnmanaged = extractManagedCaptionTitles(beforeXml || '').length;
  const afterUnmanagedCount = (() => {
    const titles = [...(afterXml || '').matchAll(/<title\s+([^>]+)>[\s\S]*?<\/title>/g)];
    const managed = extractManagedCaptionTitles(afterXml || '');
    return titles.length - managed.length;
  })();
  const beforeUnmanagedCount = (() => {
    const titles = [...(beforeXml || '').matchAll(/<title\s+([^>]+)>[\s\S]*?<\/title>/g)];
    return titles.length - beforeUnmanaged;
  })();
  const beforeMute = [...(beforeXml || '').matchAll(/adjust-volume amount="-96dB"/g)].length;
  const afterMute = [...(afterXml || '').matchAll(/adjust-volume amount="-96dB"/g)].length;
  return {
    markersUnchanged: beforeMarkers === afterMarkers,
    markerCountBefore: beforeMarkers,
    markerCountAfter: afterMarkers,
    clipsUnchanged: beforeClips === afterClips,
    clipCountBefore: beforeClips,
    clipCountAfter: afterClips,
    unmanagedTitlesUnchanged: beforeUnmanagedCount === afterUnmanagedCount,
    unmanagedTitleCountBefore: beforeUnmanagedCount,
    unmanagedTitleCountAfter: afterUnmanagedCount,
    muteCountUnchanged: beforeMute === afterMute,
    muteCountBefore: beforeMute,
    muteCountAfter: afterMute,
  };
}

async function loadProjectExportContext(projectPath) {
  const resolved = path.resolve(String(projectPath || ''));
  const [analysis, manifest, status, editorialModel] = await Promise.all([
    readJsonFile(path.join(resolved, CODEX_VIDEO_ANALYSIS_FILE), {
      optional: true,
      label: 'Codex 分析',
    }),
    readJsonFile(path.join(resolved, CODEX_VIDEO_MANIFEST_FILE), {
      optional: true,
      label: 'Codex 清单',
    }),
    readJsonFile(path.join(resolved, CODEX_VIDEO_STATUS_FILE), {
      optional: true,
      label: 'Codex 状态',
    }),
    buildEditorialReviewModel(resolved),
  ]);

  const effectiveAnalysis = status?.value?.effectiveAnalysis || analysis?.value || null;
  const assetMappings = asArray(status?.value?.assetMappings);
  const fcpxmlRelative = status?.value?.artifacts?.fcpxml || null;
  const fcpxmlPath = fcpxmlRelative ? path.join(resolved, fcpxmlRelative) : null;
  const existingXml = fcpxmlPath
    ? await fs.readFile(fcpxmlPath, 'utf8').catch(() => null)
    : null;
  const confirmedCaptions = getConfirmedCaptions(editorialModel, {
    analysis: effectiveAnalysis,
  });

  return {
    projectPath: resolved,
    analysis: effectiveAnalysis,
    manifest: manifest?.value || null,
    status: status?.value || null,
    editorialModel,
    assetMappings,
    fcpxmlRelative,
    fcpxmlPath,
    existingXml,
    confirmedCaptions,
  };
}

function buildBlockingErrors(context, plan, protection = null) {
  const errors = [];
  if (!context.analysis?.timeline?.shots?.length) {
    errors.push('项目缺少可用时间线镜头，无法导出字幕。');
  }
  if (!context.fcpxmlPath || !context.existingXml) {
    errors.push('项目尚无 FCPXML，无法更新轻字幕。');
  }
  if (!asArray(context.assetMappings).length) {
    errors.push('项目缺少 assetMappings。');
  }
  for (const entry of plan.exportableEntries) {
    const shot = asArray(context.analysis.timeline.shots)
      .find((item) => item.id === entry.matchedShotId);
    if (!shot) errors.push(`matchedShotId 不存在：${entry.matchedShotId}`);
    else if (shot.assetId !== entry.assetId) {
      errors.push(`镜头 ${entry.matchedShotId} 未引用字幕素材 ${entry.assetId}`);
    }
  }
  if (protection) {
    if (!protection.markersUnchanged) errors.push('导出后 Marker 数量发生变化。');
    if (!protection.clipsUnchanged) errors.push('导出后镜头数量发生变化。');
    if (!protection.unmanagedTitlesUnchanged) errors.push('导出后非受管 Title 数量发生变化。');
    if (!protection.muteCountUnchanged) errors.push('导出后原声静音状态发生变化。');
  }
  return errors;
}

function buildPreviewResult(context, plan, reconciliation, protectionPreview = null, nextManaged = []) {
  const blockingErrors = buildBlockingErrors(context, plan, protectionPreview);
  const previousManaged = extractManagedCaptionTitles(context.existingXml || '');
  const noOp = asArray(nextManaged).length === 0 && previousManaged.length === 0;

  return {
    ok: blockingErrors.length === 0,
    canWrite: blockingErrors.length === 0 && !noOp,
    noOp,
    projectPath: context.projectPath,
    fcpxmlPath: context.fcpxmlPath,
    fcpxmlRelative: context.fcpxmlRelative,
    confirmedCount: plan.summary.confirmedCount,
    exportableCount: plan.summary.exportableCount,
    unmatchedShotCount: plan.summary.unmatchedShotCount,
    mappingFailureCount: plan.summary.mappingFailureCount,
    willAdd: reconciliation.added,
    willUpdate: reconciliation.updated,
    willRemove: reconciliation.removed,
    willKeep: reconciliation.unchanged,
    skippedCount: plan.summary.skippedCount,
    conflictCount: plan.summary.conflictCount,
    conflicts: plan.conflicts,
    warnings: plan.entries.flatMap((entry) => (
      asArray(entry.warnings).map((warning) => ({
        captionId: entry.captionId,
        titleKey: entry.titleKey,
        warning,
      }))
    )),
    skipped: plan.entries.filter((entry) => !entry.exportable).map((entry) => ({
      captionId: entry.captionId,
      titleKey: entry.titleKey,
      reason: entry.mappingReason,
      warnings: entry.warnings,
      validationErrors: entry.validationErrors,
    })),
    changesMarkers: false,
    changesUnmanagedTitles: false,
    changesVideoOrAudio: false,
    blockingErrors,
    planSummary: plan.summary,
    reconciliation,
  };
}

async function previewConfirmedCaptionFcpxmlExport(projectPath) {
  const context = await loadProjectExportContext(projectPath);
  const assetMappings = await enrichAssetMappingsFrameMetadata(context.assetMappings || []);
  const plan = buildCaptionExportPlan({
    confirmedCaptions: context.confirmedCaptions,
    analysis: context.analysis,
    manifest: context.manifest,
    assetMappings,
  });
  const nextManaged = toManagedCaptionTitles(plan.exportableEntries);
  const previousManaged = extractManagedCaptionTitles(context.existingXml || '');
  const reconciliation = reconcileManagedTitles(previousManaged, nextManaged);

  let protectionPreview = null;
  if (context.analysis && assetMappings.length && context.existingXml) {
    const draftXml = buildFcpxml({
      projectName: context.status?.projectName
        || context.manifest?.projectName
        || path.basename(context.projectPath),
      analysis: context.analysis,
      assetMappings,
      managedCaptionTitles: nextManaged,
    });
    protectionPreview = summarizeXmlProtection(context.existingXml, draftXml);
  }

  return buildPreviewResult(
    { ...context, assetMappings },
    plan,
    reconciliation,
    protectionPreview,
    nextManaged,
  );
}

async function exportConfirmedCaptionsToFcpxml(projectPath, options = {}) {
  const preview = options.preview || await previewConfirmedCaptionFcpxmlExport(projectPath);
  if (preview.noOp) {
    return {
      ok: true,
      written: false,
      noOp: true,
      message: '无已确认字幕且无受管 Title，未修改 FCPXML。',
      preview,
    };
  }
  if (!preview.canWrite || !preview.ok) {
    return {
      ok: false,
      written: false,
      noOp: false,
      message: preview.blockingErrors[0] || '预览存在阻塞错误，已拒绝写入。',
      preview,
    };
  }

  const context = await loadProjectExportContext(projectPath);
  const assetMappings = await enrichAssetMappingsFrameMetadata(context.assetMappings || []);
  const plan = buildCaptionExportPlan({
    confirmedCaptions: context.confirmedCaptions,
    analysis: context.analysis,
    manifest: context.manifest,
    assetMappings,
  });
  const managedCaptionTitles = toManagedCaptionTitles(plan.exportableEntries);
  const previousManaged = extractManagedCaptionTitles(context.existingXml || '');
  const reconciliation = reconcileManagedTitles(previousManaged, managedCaptionTitles);
  const projectName = context.status?.projectName
    || context.manifest?.projectName
    || path.basename(context.projectPath);

  const markerTitles = collectFcpTitles(context.analysis);
  const expectedTitleCount = markerTitles.length + managedCaptionTitles.length;
  const writeResult = await writeFcpxml(context.fcpxmlPath, {
    projectName,
    analysis: context.analysis,
    assetMappings,
    managedCaptionTitles,
  }, {
    expectedTitleCount,
    atomic: true,
    backupExisting: true,
  });

  const writtenXml = await fs.readFile(context.fcpxmlPath, 'utf8');
  const protection = summarizeXmlProtection(context.existingXml, writtenXml);
  const blockingErrors = buildBlockingErrors(context, plan, protection);
  if (blockingErrors.length) {
    // Restore previous XML if protection checks fail after write.
    if (context.existingXml) {
      await fs.writeFile(context.fcpxmlPath, context.existingXml, 'utf8');
    }
    return {
      ok: false,
      written: false,
      noOp: false,
      message: blockingErrors[0],
      blockingErrors,
      preview,
      protection,
    };
  }

  let xmllint = { ok: null, message: null };
  try {
    const { runMediaTool } = require('./media-tool-service');
    await runMediaTool('xmllint', ['--noout', context.fcpxmlPath], { timeoutMs: 30_000 });
    xmllint = { ok: true, message: null };
  } catch (error) {
    xmllint = { ok: false, message: error.message };
  }

  // Refresh the persisted verification too.  Otherwise a previously generated
  // project can keep showing the "caption not exported" warning even after the
  // native Title was successfully written.
  try {
    const statusPath = path.join(context.projectPath, CODEX_VIDEO_STATUS_FILE);
    const status = context.status || {};
    let verification = null;
    try {
      // Loaded lazily to keep the export service independent during initial
      // project construction and to make a verification failure non-destructive.
      const { verifyCodexVideoProject } = require('./codex-video-service');
      verification = await verifyCodexVideoProject(context.projectPath);
    } catch {
      // The FCPXML write and its structural report remain useful even when a
      // full read-only verification cannot run in this environment.
    }
    const nextStatus = {
      ...status,
      ...(verification ? {
        status: verification.ok ? 'verified' : status.status,
        verifiedAt: verification.verifiedAt,
        verification,
      } : {}),
      fcpxmlReport: writeResult.report,
      captionExport: {
        updatedAt: new Date().toISOString(),
        added: reconciliation.added,
        updated: reconciliation.updated,
        removed: reconciliation.removed,
        unchanged: reconciliation.unchanged,
        skipped: plan.summary.skippedCount,
        conflicts: plan.summary.conflictCount,
        exportable: plan.summary.exportableCount,
        confirmed: plan.summary.confirmedCount,
      },
    };
    const tempPath = path.join(
      path.dirname(statusPath),
      `.${path.basename(statusPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    await fs.writeFile(tempPath, `${JSON.stringify(nextStatus, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.rename(tempPath, statusPath);
    await fs.rm(tempPath, { force: true }).catch(() => {});
  } catch {
    // Status update failure must not undo a validated FCPXML write.
  }

  return {
    ok: xmllint.ok !== false,
    written: true,
    noOp: false,
    message: '已生成或更新 FCP 轻字幕。',
    outputPath: context.fcpxmlPath,
    fcpxmlRelative: context.fcpxmlRelative,
    report: writeResult.report,
    reconciliation,
    protection,
    xmllint,
    summary: {
      added: reconciliation.added,
      updated: reconciliation.updated,
      removed: reconciliation.removed,
      unchanged: reconciliation.unchanged,
      skipped: plan.summary.skippedCount,
      conflicts: plan.summary.conflictCount,
      errors: 0,
      exportable: plan.summary.exportableCount,
      confirmed: plan.summary.confirmedCount,
    },
    skipped: plan.entries.filter((entry) => !entry.exportable),
    preview,
  };
}

module.exports = {
  MIN_READABLE_CAPTION_SEC,
  alignExportPlanToFrameBoundaries,
  buildCaptionExportPlan,
  buildTitleKey,
  exportConfirmedCaptionsToFcpxml,
  indexShots,
  mapVideoCaptionToShots,
  previewConfirmedCaptionFcpxmlExport,
  reconcileManagedTitles,
  toManagedCaptionTitles,
};
