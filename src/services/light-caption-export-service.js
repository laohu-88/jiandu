'use strict';

/**
 * Map analysis.lightCaptionPlan onto Final Cut Pro native Titles.
 * Build exports these automatically; Results Center review is an optional overlay,
 * not a required confirmation gate.
 */

const SKIPPED_CAPTION_REVIEW_STATUSES = Object.freeze(new Set([
  'not_needed',
  'rejected',
]));

const DEFAULT_CAPTION_FONT_SIZE = 63;
const MANAGED_CAPTION_NOTE_PREFIX = 'vcp-managed-caption:';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isVerticalTimeline(analysis) {
  const timeline = analysis?.timeline || {};
  return timeline.orientation === 'vertical'
    || Number(timeline.height) > Number(timeline.width);
}

function defaultCaptionTransform(analysis, position = 'bottom-safe') {
  const vertical = isVerticalTimeline(analysis);
  if (position === 'center') return { x: 0, y: 0 };
  if (position === 'top-safe') return { x: 0, y: vertical ? 620 : 360 };
  return { x: 0, y: vertical ? -620 : -360 };
}

function captionKindForPurpose(purpose) {
  const value = String(purpose || '');
  if (/章节|结论|收束|chapter|conclusion/i.test(value)) return 'chapter_conclusion';
  if (/背景|上下文|解释|翻译|background|translate|clarify/i.test(value)) return 'context';
  return 'content';
}

function shotSourceAssetId(shot) {
  return shot?.sourceAssetId || shot?.assetId;
}

function timelineStarts(shots) {
  let cursor = 0;
  return asArray(shots).map((shot) => {
    const timelineStartSec = cursor;
    const durationSec = Number(shot?.durationSec);
    cursor += Number.isFinite(durationSec) ? durationSec : 0;
    return { shot, timelineStartSec, durationSec: Number.isFinite(durationSec) ? durationSec : 0 };
  });
}

function captionOverridesFromEditorial(editorialReview) {
  const overrides = new Map();
  for (const review of Object.values(editorialReview?.reviews || {})) {
    for (const caption of Object.values(review?.captions || {})) {
      if (!caption?.captionId) continue;
      overrides.set(caption.captionId, {
        reviewStatus: caption.reviewStatus,
        text: caption.approvedText,
        startTime: caption.approvedStartTime,
        endTime: caption.approvedEndTime,
      });
    }
  }
  return overrides;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function planLightCaptionExport({
  analysis,
  editorialReview = null,
  titleKeyPrefix = 'main',
} = {}) {
  const shots = asArray(analysis?.timeline?.shots);
  const planned = timelineStarts(shots);
  const onTimeline = new Set(planned.map(({ shot }) => shotSourceAssetId(shot)));
  const overrides = captionOverridesFromEditorial(editorialReview);
  const titles = [];
  const skipped = [];

  for (const caption of asArray(analysis?.lightCaptionPlan)) {
    const captionId = typeof caption?.captionId === 'string' ? caption.captionId.trim() : '';
    const assetId = typeof caption?.assetId === 'string' ? caption.assetId.trim() : '';
    const override = captionId ? overrides.get(captionId) : null;
    if (override && SKIPPED_CAPTION_REVIEW_STATUSES.has(override.reviewStatus)) {
      skipped.push({ captionId, assetId, reason: 'review_skipped' });
      continue;
    }
    const text = String(override?.text || caption?.text || '').trim();
    if (!captionId || !assetId || !text) {
      skipped.push({ captionId, assetId, reason: 'empty_text' });
      continue;
    }
    const matches = planned.filter(({ shot }) => shotSourceAssetId(shot) === assetId);
    if (!matches.length) {
      skipped.push({
        captionId,
        assetId,
        reason: onTimeline.has(assetId) ? 'no_shot' : 'omitted',
      });
      continue;
    }

    const sourceStart = finiteOrNull(override?.startTime ?? caption.startTime);
    const sourceEnd = finiteOrNull(override?.endTime ?? caption.endTime);
    let overlapping = matches.filter(({ shot }) => {
      const capStart = sourceStart == null ? shot.inSec : sourceStart;
      const capEnd = sourceEnd == null ? shot.outSec : sourceEnd;
      return capStart < Number(shot.outSec) + 0.05 && capEnd > Number(shot.inSec) - 0.05;
    });
    if (!overlapping.length) {
      // Shorten/swap left the original range off the remaining clip: keep the
      // caption on the first remaining shot of that asset, clamped to the shot.
      overlapping = [matches[0]];
    }

    const position = typeof caption.position === 'string' && caption.position.trim()
      ? caption.position.trim()
      : 'bottom-safe';
    const kind = captionKindForPurpose(caption.purpose);
    for (const { shot, timelineStartSec } of overlapping) {
      const capStart = sourceStart == null ? Number(shot.inSec) : sourceStart;
      const capEnd = sourceEnd != null && sourceEnd > capStart
        ? sourceEnd
        : Number(shot.outSec);
      const overlapStart = Math.max(Number(shot.inSec), capStart);
      const overlapEnd = Math.min(Number(shot.outSec), capEnd);
      const durationSec = overlapEnd - overlapStart;
      if (!(durationSec > 0)) {
        skipped.push({ captionId, assetId, shotId: shot.id, reason: 'no_overlap' });
        continue;
      }
      const titleKey = `${titleKeyPrefix}:${captionId}:${shot.id}`;
      titles.push({
        titleKey,
        captionId,
        assetId,
        matchedShotId: shot.id,
        startSec: Number((timelineStartSec + (overlapStart - Number(shot.inSec))).toFixed(6)),
        durationSec: Number(durationSec.toFixed(6)),
        text,
        position,
        captionKind: kind,
        fontSize: Number.isFinite(Number(caption.fontSize))
          ? Number(caption.fontSize)
          : DEFAULT_CAPTION_FONT_SIZE,
        transform: defaultCaptionTransform(analysis, position),
        note: `${MANAGED_CAPTION_NOTE_PREFIX}${titleKey}`,
      });
    }
  }

  return { titles, skipped };
}

function buildManagedCaptionTitlesFromAnalysis(options) {
  return planLightCaptionExport(options).titles;
}

function summarizeLightCaptionExport({
  analysis,
  editorialReview = null,
  actualTitles = [],
} = {}) {
  const planned = planLightCaptionExport({ analysis, editorialReview });
  const actual = asArray(actualTitles);
  const actualKeys = new Set(actual.map((item) => item.titleKey).filter(Boolean));
  const actualTexts = new Set(actual.map((item) => String(item.text || '').trim()).filter(Boolean));
  const missing = planned.titles.filter((title) => (
    !actualKeys.has(title.titleKey) && !actualTexts.has(title.text)
  ));
  const omittedAssetIds = new Set(
    planned.skipped.filter((item) => item.reason === 'omitted').map((item) => item.assetId),
  );
  const orphans = actual.filter((item) => {
    const key = String(item.titleKey || item.note || '');
    return [...omittedAssetIds].some((assetId) => key.includes(assetId));
  });
  const errors = [];
  if (missing.length) {
    errors.push(
      `分析结果含 ${planned.titles.length} 条应导出轻字幕，但 FCPXML 缺少 ${missing.length} 条原生 Title：`
      + missing.map((item) => item.captionId || item.text).join('、'),
    );
  }
  if (orphans.length) {
    errors.push(
      `FCPXML 含 ${orphans.length} 条落在已 omit 素材上的孤立字幕。`,
    );
  }
  return {
    expectedCount: planned.titles.length,
    actualCount: actual.length,
    missing,
    orphans,
    skipped: planned.skipped,
    titles: planned.titles,
    complete: missing.length === 0 && orphans.length === 0,
    errors,
  };
}

module.exports = {
  DEFAULT_CAPTION_FONT_SIZE,
  MANAGED_CAPTION_NOTE_PREFIX,
  SKIPPED_CAPTION_REVIEW_STATUSES,
  buildManagedCaptionTitlesFromAnalysis,
  captionKindForPurpose,
  defaultCaptionTransform,
  planLightCaptionExport,
  summarizeLightCaptionExport,
};
