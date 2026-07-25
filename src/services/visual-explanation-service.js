'use strict';

const MAX_VISUAL_TEXT_ITEMS_PER_ASSET = 40;
const MAX_OCR_TEXT_LENGTH = 500;
const MAX_EXPLANATION_FIELD_LENGTH = 1000;
const MAX_LIGHT_CAPTIONS_PER_STORY_UNIT = 8;
const MAX_LIGHT_CAPTIONS_PER_PROJECT = 40;
const MAX_PROTECTED_RANGES = 24;
const SHORT_KEEP_RATIO_FLOOR = 0.35;
const SHORT_ABSOLUTE_FLOOR_SEC = 2;
const ALLOWED_TRIM_REASON_PREFIXES = [
  'black_frame',
  'static_silence',
  'duplicate_story_unit',
  'irrelevant_intro',
  'irrelevant_outro',
  'technical_wait',
  'undecodable',
  'user_brief',
  'project_brief',
];
const TEXT_TYPES = new Set([
  'subtitle', 'speech_bubble', 'narration', 'title', 'label', 'sign',
  'chat', 'ui', 'sound_effect', 'caption', 'other', 'uncertain',
]);
const EXPLANATION_NEEDS = new Set([
  'none', 'background', 'translate_on_screen_text', 'humor_or_twist',
  'multi_panel_dialogue', 'insufficient_evidence',
]);
const CAPTION_PURPOSES = new Set([
  'translate', 'background', 'humor', 'twist', 'dialogue', 'clarify', 'none',
]);
const AUDIO_ROLES = new Set([
  'dialogue', 'ambient', 'music', 'reaction', 'mixed', 'none', 'unknown',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value, maxLength = Infinity) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isConfidence(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function sameScalar(left, right, tolerance = 0.05) {
  if (Number.isFinite(left) && Number.isFinite(right)) return Math.abs(left - right) <= tolerance;
  return left === right;
}

function validateStringList(value, field, errors, options = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${field} 必须是数组。`);
    return;
  }
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? Infinity;
  if (value.length < minimum || value.length > maximum) {
    errors.push(`${field} 数量必须在 ${minimum} 到 ${maximum} 之间。`);
  }
  if (!value.every((item) => isNonEmptyString(item, options.itemMaxLength || 500))) {
    errors.push(`${field} 只能包含非空字符串。`);
  }
}

function normalizeSubtitleText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,!?;:'"“”‘’，。！？；：、…·\-—_/\\()[\]{}<>]/g, '')
    .toLowerCase();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = i - 1;
    rows[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = rows[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[j] = Math.min(rows[j] + 1, rows[j - 1] + 1, previous + cost);
      previous = current;
    }
  }
  return rows[b.length];
}

function subtitleSimilarity(left, right) {
  const a = normalizeSubtitleText(left);
  const b = normalizeSubtitleText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }
  const distance = levenshtein(a, b);
  const maxLength = Math.max(a.length, b.length);
  return 1 - (distance / maxLength);
}

function textsAreSameSubtitle(left, right, threshold = 0.88) {
  return subtitleSimilarity(left, right) >= threshold;
}

function rangesOverlap(left, right, tolerance = 0.02) {
  return left.start < right.end - tolerance && right.start < left.end - tolerance;
}

function rangeFullyContains(outer, inner, tolerance = 0.05) {
  return outer.start <= inner.start + tolerance && outer.end >= inner.end - tolerance;
}

function mergeVisualTextIntervals(entries, options = {}) {
  const gapToleranceSec = options.gapToleranceSec ?? 0.35;
  const similarityThreshold = options.similarityThreshold ?? 0.88;
  const sorted = [...(entries || [])]
    .filter((entry) => isObject(entry))
    .sort((left, right) => Number(left.startTime || 0) - Number(right.startTime || 0));
  const merged = [];
  for (const entry of sorted) {
    const previous = merged.at(-1);
    const canMerge = previous
      && (previous.textType || 'subtitle') === (entry.textType || 'subtitle')
      && textsAreSameSubtitle(previous.sourceText, entry.sourceText, similarityThreshold)
      && Number.isFinite(previous.endTime)
      && Number.isFinite(entry.startTime)
      && entry.startTime <= previous.endTime + gapToleranceSec;
    if (canMerge) {
      previous.endTime = Math.max(previous.endTime, Number(entry.endTime));
      previous.confidence = Math.min(
        Number(previous.confidence ?? 1),
        Number(entry.confidence ?? 1),
      );
      previous.frameEvidence = [...new Set([
        ...(Array.isArray(previous.frameEvidence) ? previous.frameEvidence : []),
        ...(Array.isArray(entry.frameEvidence) ? entry.frameEvidence : []),
      ])].slice(0, 8);
      if (entry.warnings?.length) {
        previous.warnings = [...new Set([
          ...(previous.warnings || []),
          ...entry.warnings,
        ])].slice(0, 12);
      }
      continue;
    }
    merged.push({
      ...entry,
      sourceText: entry.sourceText,
      startTime: entry.startTime,
      endTime: entry.endTime,
      frameEvidence: Array.isArray(entry.frameEvidence) ? [...entry.frameEvidence] : [],
      warnings: Array.isArray(entry.warnings) ? [...entry.warnings] : [],
    });
  }
  return merged;
}

function collectContextTextSnippets(item) {
  const snippets = [];
  const context = item?.context || item?.semanticProfile || {};
  for (const key of ['title', 'body', 'translation', 'description', 'mediaDescription']) {
    if (isNonEmptyString(context[key], 5000)) snippets.push(String(context[key]));
  }
  if (Array.isArray(context.comments)) {
    for (const comment of context.comments) {
      if (isNonEmptyString(comment, 2000)) snippets.push(String(comment));
      if (isObject(comment) && isNonEmptyString(comment.text, 2000)) snippets.push(comment.text);
    }
  }
  if (Array.isArray(context.tags)) {
    for (const tag of context.tags) {
      if (isNonEmptyString(tag, 200)) snippets.push(String(tag));
    }
  }
  return snippets;
}

function contextMasqueradesAsVisualText(sourceText, item) {
  const normalized = normalizeSubtitleText(sourceText);
  if (!normalized || normalized.length < 8) return false;
  return collectContextTextSnippets(item).some((snippet) => {
    const normalizedSnippet = normalizeSubtitleText(snippet);
    if (!normalizedSnippet) return false;
    if (normalizedSnippet === normalized) return true;
    return normalizedSnippet.includes(normalized) && normalized.length >= 12;
  });
}

function validateTimePair(start, end, field, errors, options = {}) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    errors.push(`${field} 必须包含合法的 start/end 时间。`);
    return false;
  }
  if (Number.isFinite(options.durationSec) && end > options.durationSec + 0.05) {
    errors.push(`${field} 超出源时长 ${options.durationSec} 秒。`);
    return false;
  }
  return true;
}

function validateProtectedRanges(ranges, field, errors, durationSec) {
  if (ranges == null) return;
  if (!Array.isArray(ranges)) {
    errors.push(`${field} 必须是数组。`);
    return;
  }
  if (ranges.length > MAX_PROTECTED_RANGES) {
    errors.push(`${field} 最多 ${MAX_PROTECTED_RANGES} 段。`);
  }
  const normalized = [];
  ranges.forEach((range, index) => {
    const rangeField = `${field}[${index}]`;
    if (!isObject(range)
      || !Number.isFinite(range.startSec)
      || !Number.isFinite(range.endSec)) {
      errors.push(`${rangeField} 必须包含 startSec/endSec。`);
      return;
    }
    if (!validateTimePair(range.startSec, range.endSec, rangeField, errors, { durationSec })) return;
    for (const previous of normalized) {
      if (rangesOverlap(
        { start: previous.startSec, end: previous.endSec },
        { start: range.startSec, end: range.endSec },
      ) && !(
        sameScalar(previous.startSec, range.startSec)
        && sameScalar(previous.endSec, range.endSec)
      )) {
        // Overlap is allowed for different categories recorded separately, but
        // identical illegal inversions are already rejected above. Warn only on
        // inverted containment conflicts that would make trim validation ambiguous.
        if (range.startSec < previous.startSec && range.endSec < previous.endSec
          && range.endSec > previous.startSec) {
          errors.push(`${rangeField} 与已有保护区间形成非法交错重叠。`);
        }
      }
    }
    normalized.push(range);
  });
}

function validateVisualTextItem(item, field, errors, source) {
  if (!isObject(item)) {
    errors.push(`${field} 必须是对象。`);
    return;
  }
  if (!isNonEmptyString(item.sourceText, MAX_OCR_TEXT_LENGTH)) {
    errors.push(`${field}.sourceText 必须是不超过 ${MAX_OCR_TEXT_LENGTH} 字的原文。`);
  }
  if (!isNonEmptyString(item.language, 32)) errors.push(`${field}.language 无效。`);
  if (item.translatedText != null && !isNonEmptyString(item.translatedText, MAX_OCR_TEXT_LENGTH)) {
    errors.push(`${field}.translatedText 无效。`);
  }
  if (item.meaning != null && !isNonEmptyString(item.meaning, MAX_EXPLANATION_FIELD_LENGTH)) {
    errors.push(`${field}.meaning 无效。`);
  }
  if (!TEXT_TYPES.has(item.textType)) errors.push(`${field}.textType 无效。`);
  if (item.readingOrder != null && (!Number.isInteger(item.readingOrder) || item.readingOrder < 1)) {
    errors.push(`${field}.readingOrder 必须是从 1 开始的整数。`);
  }
  if (item.speakerOrRegion != null && !isNonEmptyString(item.speakerOrRegion, 200)) {
    errors.push(`${field}.speakerOrRegion 无效。`);
  }
  if (!isConfidence(item.confidence)) errors.push(`${field}.confidence 必须在 0 到 1 之间。`);
  if (item.textType === 'uncertain' && item.confidence > 0.6) {
    errors.push(`${field} 标记 uncertain 时 confidence 不得高于 0.6。`);
  }
  validateStringList(item.frameEvidence, `${field}.frameEvidence`, errors, {
    maximum: 8,
    itemMaxLength: 200,
  });
  validateStringList(item.warnings, `${field}.warnings`, errors, {
    maximum: 12,
    itemMaxLength: 500,
  });

  const hasStart = item.startTime != null;
  const hasEnd = item.endTime != null;
  if (source?.type === 'image') {
    if (hasStart || hasEnd) errors.push(`${field} 图片不得返回视频时间范围。`);
  } else if (source?.type === 'video') {
    if (hasStart || hasEnd) {
      validateTimePair(
        item.startTime,
        item.endTime,
        field,
        errors,
        { durationSec: source.metadata?.durationSec },
      );
    }
  }

  if (source && contextMasqueradesAsVisualText(item.sourceText, source)) {
    errors.push(`${field}.sourceText 疑似把 HotIngest context 伪装成画面文字。`);
  }
}

function validateVisualTextAnalysis(asset, source, errors) {
  const analysis = asset.visualTextAnalysis;
  if (analysis == null) return;
  if (!isObject(analysis)) {
    errors.push(`素材 ${asset.assetId}.visualTextAnalysis 必须是对象。`);
    return;
  }
  if (!Array.isArray(analysis.items)) {
    errors.push(`素材 ${asset.assetId}.visualTextAnalysis.items 必须是数组。`);
    return;
  }
  if (analysis.items.length > MAX_VISUAL_TEXT_ITEMS_PER_ASSET) {
    errors.push(`素材 ${asset.assetId} 的画面文字条目超过上限 ${MAX_VISUAL_TEXT_ITEMS_PER_ASSET}。`);
  }
  analysis.items.forEach((item, index) => {
    validateVisualTextItem(item, `素材 ${asset.assetId}.visualTextAnalysis.items[${index}]`, errors, source);
  });
  if (typeof analysis.panelCount === 'number' && (!Number.isInteger(analysis.panelCount) || analysis.panelCount < 0)) {
    errors.push(`素材 ${asset.assetId}.visualTextAnalysis.panelCount 无效。`);
  }
  if (analysis.readingDirection != null
    && !['ltr', 'rtl', 'ttb', 'btt', 'unknown'].includes(analysis.readingDirection)) {
    errors.push(`素材 ${asset.assetId}.visualTextAnalysis.readingDirection 无效。`);
  }
  if (analysis.readingOrderUncertain === true) {
    const warnings = analysis.warnings || [];
    if (!warnings.some((warning) => /readingOrderUncertain|阅读顺序/i.test(warning))) {
      errors.push(`素材 ${asset.assetId} 阅读顺序不确定时必须写入 warning。`);
    }
  }
  validateStringList(analysis.warnings, `素材 ${asset.assetId}.visualTextAnalysis.warnings`, errors, {
    maximum: 20,
    itemMaxLength: 500,
  });
  if (Array.isArray(analysis.items) && analysis.items.length >= 2) {
    const ordered = analysis.items
      .filter((item) => Number.isInteger(item.readingOrder))
      .map((item) => item.readingOrder);
    const unique = new Set(ordered);
    if (ordered.length > 0 && unique.size !== ordered.length) {
      errors.push(`素材 ${asset.assetId} 的 readingOrder 不得重复。`);
    }
  }
}

function validateExplanationPlan(asset, source, errors) {
  const plan = asset.explanationPlan;
  if (plan == null) return;
  if (!isObject(plan)) {
    errors.push(`素材 ${asset.assetId}.explanationPlan 必须是对象。`);
    return;
  }
  if (plan.assetId !== asset.assetId) {
    errors.push(`素材 ${asset.assetId}.explanationPlan.assetId 必须与素材一致。`);
  }
  if (source?.storyUnitId && plan.storyUnitId && plan.storyUnitId !== source.storyUnitId) {
    errors.push(`素材 ${asset.assetId}.explanationPlan.storyUnitId 与 manifest 不一致。`);
  }
  for (const key of ['visualSummary', 'explanationReason', 'keyPoint']) {
    if (!isNonEmptyString(plan[key], MAX_EXPLANATION_FIELD_LENGTH)) {
      errors.push(`素材 ${asset.assetId}.explanationPlan.${key} 无效。`);
    }
  }
  for (const key of [
    'visualTextSummary', 'audioSummary', 'contextSummary',
    'translatedMeaning', 'setup', 'payoffOrResult', 'humorOrConflict',
  ]) {
    if (plan[key] == null || plan[key] === '') continue;
    if (!isNonEmptyString(plan[key], MAX_EXPLANATION_FIELD_LENGTH)) {
      errors.push(`素材 ${asset.assetId}.explanationPlan.${key} 无效。`);
    }
  }
  if (!EXPLANATION_NEEDS.has(plan.audienceNeedsExplanation)) {
    errors.push(`素材 ${asset.assetId}.explanationPlan.audienceNeedsExplanation 无效。`);
  }
  if (!isConfidence(plan.confidence)) {
    errors.push(`素材 ${asset.assetId}.explanationPlan.confidence 必须在 0 到 1 之间。`);
  }
  validateStringList(plan.visualEvidenceUsed, `素材 ${asset.assetId}.explanationPlan.visualEvidenceUsed`, errors, {
    maximum: 12,
    itemMaxLength: 500,
  });
  validateStringList(plan.visualTextEvidenceUsed, `素材 ${asset.assetId}.explanationPlan.visualTextEvidenceUsed`, errors, {
    maximum: 12,
    itemMaxLength: 500,
  });
  validateStringList(plan.audioEvidenceUsed, `素材 ${asset.assetId}.explanationPlan.audioEvidenceUsed`, errors, {
    maximum: 12,
    itemMaxLength: 500,
  });
  validateStringList(plan.contextEvidenceUsed, `素材 ${asset.assetId}.explanationPlan.contextEvidenceUsed`, errors, {
    maximum: 12,
    itemMaxLength: 500,
  });
  validateStringList(plan.inference, `素材 ${asset.assetId}.explanationPlan.inference`, errors, {
    maximum: 12,
    itemMaxLength: 500,
  });
  validateStringList(plan.warnings, `素材 ${asset.assetId}.explanationPlan.warnings`, errors, {
    maximum: 20,
    itemMaxLength: 500,
  });

  const contextEvidence = plan.contextEvidenceUsed || [];
  const visualTextEvidence = plan.visualTextEvidenceUsed || [];
  for (const evidence of visualTextEvidence) {
    if (contextEvidence.includes(evidence)) {
      errors.push(`素材 ${asset.assetId} 的 contextEvidence 不得填入 visualTextEvidence。`);
    }
  }
  if (plan.audienceNeedsExplanation === 'insufficient_evidence' && plan.confidence > 0.6) {
    errors.push(`素材 ${asset.assetId} 证据不足时 confidence 不得高于 0.6。`);
  }
}

function validateAudioAnalysis(asset, source, errors) {
  const audio = asset.audioAnalysis;
  if (audio == null) return;
  if (!isObject(audio)) {
    errors.push(`素材 ${asset.assetId}.audioAnalysis 必须是对象。`);
    return;
  }
  if (source?.type === 'image') {
    if (audio.audioAvailable === true) {
      errors.push(`素材 ${asset.assetId} 图片不得伪造 audioAvailable=true。`);
    }
    if (audio.speechPresent === true || audio.musicPresent === true) {
      errors.push(`素材 ${asset.assetId} 图片不得伪造音频内容标记。`);
    }
  }
  for (const key of [
    'audioAvailable', 'audioEnabled', 'speechPresent', 'musicPresent',
    'soundEffectPresent', 'audioNeededForUnderstanding', 'preserveOriginalAudio',
  ]) {
    if (audio[key] != null && typeof audio[key] !== 'boolean') {
      errors.push(`素材 ${asset.assetId}.audioAnalysis.${key} 必须是布尔值。`);
    }
  }
  if (audio.audioRole != null && !AUDIO_ROLES.has(audio.audioRole)) {
    errors.push(`素材 ${asset.assetId}.audioAnalysis.audioRole 无效。`);
  }
  if (audio.audioSummary != null && !isNonEmptyString(audio.audioSummary, MAX_EXPLANATION_FIELD_LENGTH)) {
    errors.push(`素材 ${asset.assetId}.audioAnalysis.audioSummary 无效。`);
  }
  if (audio.muteReason != null && !isNonEmptyString(audio.muteReason, 500)) {
    errors.push(`素材 ${asset.assetId}.audioAnalysis.muteReason 无效。`);
  }
  validateStringList(audio.warnings, `素材 ${asset.assetId}.audioAnalysis.warnings`, errors, {
    maximum: 12,
    itemMaxLength: 500,
  });

  if (source?.type === 'video') {
    const hasAudio = source.metadata?.hasAudio === true;
    if (audio.audioAvailable === true && source.metadata && source.metadata.hasAudio === false) {
      errors.push(`素材 ${asset.assetId} 探测无音频流，不得标记 audioAvailable=true。`);
    }
    if (audio.audioAvailable === false && hasAudio) {
      errors.push(`素材 ${asset.assetId} 探测有音频流，不得标记 audioAvailable=false。`);
    }
    if (audio.preserveOriginalAudio === true && audio.audioEnabled === false && !isNonEmptyString(audio.muteReason, 500)) {
      errors.push(`素材 ${asset.assetId} 保留原声为 true 时不得在缺少 muteReason 的情况下禁用音频。`);
    }
    if (audio.audioEnabled === false && !isNonEmptyString(audio.muteReason, 500)) {
      errors.push(`素材 ${asset.assetId} 静音缺少 muteReason。`);
    }
    if (audio.preserveOriginalAudio !== false && hasAudio) {
      // Default preservation stance for Stage 5C aware assets.
      if (audio.preserveOriginalAudio == null) {
        errors.push(`素材 ${asset.assetId}.audioAnalysis.preserveOriginalAudio 在 Stage 5C 中必须显式给出。`);
      }
    }
  }
}

function trimReasonAllowed(reason) {
  if (!isNonEmptyString(reason, 500)) return false;
  return ALLOWED_TRIM_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix) || reason.includes(prefix));
}

function validateVideoPreservationPlan(asset, source, errors) {
  const plan = asset.videoPreservationPlan;
  if (plan == null) return;
  if (!isObject(plan)) {
    errors.push(`素材 ${asset.assetId}.videoPreservationPlan 必须是对象。`);
    return;
  }
  if (source?.type === 'image') {
    errors.push(`素材 ${asset.assetId} 图片不得提供 videoPreservationPlan。`);
    return;
  }
  if (plan.assetId !== asset.assetId) {
    errors.push(`素材 ${asset.assetId}.videoPreservationPlan.assetId 必须与素材一致。`);
  }
  const durationSec = Number(source?.metadata?.durationSec);
  if (!Number.isFinite(plan.sourceDuration) || plan.sourceDuration <= 0) {
    errors.push(`素材 ${asset.assetId}.videoPreservationPlan.sourceDuration 无效。`);
  } else if (Number.isFinite(durationSec) && !sameScalar(plan.sourceDuration, durationSec, 0.05)) {
    errors.push(`素材 ${asset.assetId}.videoPreservationPlan.sourceDuration 与探测时长不一致。`);
  }
  if (!validateTimePair(plan.proposedIn, plan.proposedOut, `素材 ${asset.assetId}.videoPreservationPlan`, errors, {
    durationSec: Number.isFinite(durationSec) ? durationSec : plan.sourceDuration,
  })) {
    return;
  }
  const selectedDuration = Number((plan.proposedOut - plan.proposedIn).toFixed(3));
  if (Number.isFinite(plan.selectedDuration) && !sameScalar(plan.selectedDuration, selectedDuration, 0.02)) {
    errors.push(`素材 ${asset.assetId}.videoPreservationPlan.selectedDuration 必须等于 proposedOut - proposedIn。`);
  }
  if (Number.isFinite(plan.keepRatio)) {
    const expectedRatio = selectedDuration / plan.sourceDuration;
    if (!sameScalar(plan.keepRatio, expectedRatio, 0.02)) {
      errors.push(`素材 ${asset.assetId}.videoPreservationPlan.keepRatio 与裁剪结果不一致。`);
    }
  }
  if (typeof plan.preserveFullClip !== 'boolean') {
    errors.push(`素材 ${asset.assetId}.videoPreservationPlan.preserveFullClip 必须是布尔值。`);
  }
  if (plan.preserveFullClip === true) {
    if (!sameScalar(plan.proposedIn, 0, 0.05)
      || (Number.isFinite(durationSec) && !sameScalar(plan.proposedOut, durationSec, 0.05))) {
      errors.push(`素材 ${asset.assetId} preserveFullClip=true 时必须使用完整有效区间。`);
    }
  } else {
    if (!trimReasonAllowed(plan.trimReason)) {
      errors.push(`素材 ${asset.assetId} 裁剪缺少明确且允许的 trimReason。`);
    }
    const keepRatio = selectedDuration / plan.sourceDuration;
    if (keepRatio < SHORT_KEEP_RATIO_FLOOR
      && selectedDuration < Math.max(SHORT_ABSOLUTE_FLOOR_SEC, plan.sourceDuration * 0.2)
      && !trimReasonAllowed(plan.trimReason)) {
      errors.push(`素材 ${asset.assetId} 无理由的极短视频区间被拒绝。`);
    }
    if (keepRatio < 0.2 && selectedDuration < SHORT_ABSOLUTE_FLOOR_SEC) {
      errors.push(`素材 ${asset.assetId} 提出的入出点过短，程序侧拒绝无理由极短片段。`);
    }
  }
  validateProtectedRanges(plan.protectedTimeRanges, `素材 ${asset.assetId}.videoPreservationPlan.protectedTimeRanges`, errors, durationSec);
  validateProtectedRanges(plan.subtitleTimeRanges, `素材 ${asset.assetId}.videoPreservationPlan.subtitleTimeRanges`, errors, durationSec);
  validateProtectedRanges(plan.audioCriticalTimeRanges, `素材 ${asset.assetId}.videoPreservationPlan.audioCriticalTimeRanges`, errors, durationSec);
  validateStringList(plan.criticalMoments, `素材 ${asset.assetId}.videoPreservationPlan.criticalMoments`, errors, {
    maximum: 20,
    itemMaxLength: 500,
  });
  validateStringList(plan.warnings, `素材 ${asset.assetId}.videoPreservationPlan.warnings`, errors, {
    maximum: 20,
    itemMaxLength: 500,
  });

  if (plan.preserveFullClip === false) {
    const selected = { start: plan.proposedIn, end: plan.proposedOut };
    const protectedGroups = [
      plan.protectedTimeRanges,
      plan.subtitleTimeRanges,
      plan.audioCriticalTimeRanges,
    ];
    for (const group of protectedGroups) {
      for (const range of group || []) {
        const protectedRange = { start: range.startSec, end: range.endSec };
        if (!rangeFullyContains(selected, protectedRange)) {
          errors.push(`素材 ${asset.assetId} 裁剪不得跨越受保护的字幕、动作或音频区间。`);
        }
      }
    }
  }
}

function validateLightCaptionPlan(analysis, manifest, errors, analysisById) {
  const plan = analysis.lightCaptionPlan;
  if (plan == null) return;
  if (!Array.isArray(plan)) {
    errors.push('lightCaptionPlan 必须是数组。');
    return;
  }
  if (plan.length > MAX_LIGHT_CAPTIONS_PER_PROJECT) {
    errors.push(`lightCaptionPlan 超过项目上限 ${MAX_LIGHT_CAPTIONS_PER_PROJECT}。`);
  }
  const manifestById = new Map((manifest?.items || []).map((item) => [item.assetId, item]));
  const ids = new Set();
  const perStoryUnit = new Map();
  plan.forEach((caption, index) => {
    const field = `lightCaptionPlan[${index}]`;
    if (!isObject(caption)) {
      errors.push(`${field} 必须是对象。`);
      return;
    }
    if (!isNonEmptyString(caption.captionId, 100)) errors.push(`${field}.captionId 无效。`);
    if (ids.has(caption.captionId)) errors.push(`${field}.captionId 重复。`);
    ids.add(caption.captionId);
    if (!manifestById.has(caption.assetId)) errors.push(`${field}.assetId 不存在。`);
    const source = manifestById.get(caption.assetId);
    if (source?.storyUnitId && caption.storyUnitId && caption.storyUnitId !== source.storyUnitId) {
      errors.push(`${field}.storyUnitId 与素材归属不一致。`);
    }
    if (caption.storyUnitId) {
      const count = (perStoryUnit.get(caption.storyUnitId) || 0) + 1;
      perStoryUnit.set(caption.storyUnitId, count);
      if (count > MAX_LIGHT_CAPTIONS_PER_STORY_UNIT) {
        errors.push(`${field} 超过单 Story Unit 轻字幕上限 ${MAX_LIGHT_CAPTIONS_PER_STORY_UNIT}。`);
      }
    }
    if (!isNonEmptyString(caption.text, 40)) {
      errors.push(`${field}.text 必须是简洁中文（最多 40 字）。`);
    }
    if (/\n/.test(caption.text || '')) {
      const lines = String(caption.text).split(/\n/).filter(Boolean);
      if (lines.length > 2) errors.push(`${field}.text 最多两行。`);
    }
    if (!CAPTION_PURPOSES.has(caption.purpose)) errors.push(`${field}.purpose 无效。`);
    if (!isNonEmptyString(caption.basedOn, 500)) errors.push(`${field}.basedOn 无效。`);
    if (!isConfidence(caption.confidence)) errors.push(`${field}.confidence 无效。`);
    if (typeof caption.reviewRequired !== 'boolean') errors.push(`${field}.reviewRequired 必须是布尔值。`);
    validateStringList(caption.warnings, `${field}.warnings`, errors, {
      maximum: 8,
      itemMaxLength: 500,
    });
    if (source?.type === 'video') {
      validateTimePair(
        caption.startTime,
        caption.endTime,
        field,
        errors,
        { durationSec: source.metadata?.durationSec },
      );
    } else if (source?.type === 'image') {
      if (caption.startTime != null || caption.endTime != null) {
        // Image captions may use display-relative timing on the eventual shot,
        // but must not claim source-video timestamps.
        if (caption.startTime < 0 || (caption.endTime != null && caption.endTime <= caption.startTime)) {
          errors.push(`${field} 图片轻字幕时间无效。`);
        }
      }
    }
    if (caption.confidence < 0.55 && caption.reviewRequired !== true) {
      errors.push(`${field} 低置信度结果必须 reviewRequired=true。`);
    }
    const asset = analysisById.get(caption.assetId);
    if (asset?.explanationPlan?.audienceNeedsExplanation === 'none' && caption.purpose !== 'none') {
      errors.push(`${field} 与 explanationPlan 的无需字幕判断冲突。`);
    }
  });
}

function validateShotAgainstStage5C(shot, field, asset, source, errors) {
  const audio = asset?.audioAnalysis;
  const preservation = asset?.videoPreservationPlan;
  if (audio) {
    if (source?.type === 'video' && source.metadata?.hasAudio && audio.preserveOriginalAudio === true) {
      if (shot.audioMode !== 'keep') {
        errors.push(`${field} preserveOriginalAudio=true 时 audioMode 必须为 keep。`);
      }
    }
    if (shot.audioMode === 'mute') {
      if (source?.type === 'video' && source.metadata?.hasAudio && !isNonEmptyString(audio.muteReason, 500)) {
        errors.push(`${field} 静音没有 muteReason 时被拒绝。`);
      }
      if (audio.preserveOriginalAudio === true && source?.metadata?.hasAudio) {
        errors.push(`${field} 不得在保留原声为 true 时静音。`);
      }
    }
  }
  if (preservation && source?.type === 'video') {
    if (preservation.preserveFullClip === true) {
      if (!sameScalar(shot.inSec, preservation.proposedIn, 0.05)
        || !sameScalar(shot.outSec, preservation.proposedOut, 0.05)) {
        errors.push(`${field} preserveFullClip=true 时镜头入出点必须使用完整有效区间。`);
      }
    } else if (Number.isFinite(preservation.proposedIn) && Number.isFinite(preservation.proposedOut)) {
      if (shot.inSec < preservation.proposedIn - 0.05 || shot.outSec > preservation.proposedOut + 0.05) {
        errors.push(`${field} 镜头区间超出 videoPreservationPlan 允许范围。`);
      }
      for (const range of [
        ...(preservation.protectedTimeRanges || []),
        ...(preservation.subtitleTimeRanges || []),
        ...(preservation.audioCriticalTimeRanges || []),
      ]) {
        if (!rangeFullyContains(
          { start: shot.inSec, end: shot.outSec },
          { start: range.startSec, end: range.endSec },
        )) {
          errors.push(`${field} 裁剪后未保留受保护区间。`);
        }
      }
    }
    const selectedDuration = shot.outSec - shot.inSec;
    const sourceDuration = source.metadata?.durationSec;
    if (Number.isFinite(sourceDuration)
      && sourceDuration >= 5
      && selectedDuration < SHORT_ABSOLUTE_FLOOR_SEC
      && selectedDuration / sourceDuration < SHORT_KEEP_RATIO_FLOOR
      && !trimReasonAllowed(preservation.trimReason)) {
      errors.push(`${field} 无理由的极短视频区间被拒绝或纠正。`);
    }
  }
}

function validateDurationConflictReporting(analysis, manifest, errors, analysisById) {
  const policy = analysis.timeline?.durationPolicy || manifest?.narrative?.durationPolicy;
  if (!policy || !Array.isArray(analysis.timeline?.shots)) return;
  const shots = analysis.timeline.shots;
  const duration = Number(shots.reduce((sum, shot) => sum + Number(shot.durationSec || 0), 0).toFixed(3));
  const hasFullPreserveVideo = shots.some((shot) => {
    const asset = analysisById.get(shot.assetId);
    return asset?.videoPreservationPlan?.preserveFullClip === true;
  });
  if (duration > policy.maxSec + 0.02 && hasFullPreserveVideo) {
    if (!isNonEmptyString(analysis.timeline?.durationException, 1000)) {
      errors.push('目标时长不足时优先报告冲突，而不是静默大幅裁剪视频。');
    }
  }
}

function validateEvidenceBoundary(asset, errors) {
  const evidence = asset.evidence;
  if (!isObject(evidence)) return;
  if (evidence.visualTextEvidenceUsed != null) {
    validateStringList(evidence.visualTextEvidenceUsed, `素材 ${asset.assetId}.evidence.visualTextEvidenceUsed`, errors, {
      maximum: 12,
      itemMaxLength: 500,
    });
  }
  if (evidence.audioEvidenceUsed != null) {
    validateStringList(evidence.audioEvidenceUsed, `素材 ${asset.assetId}.evidence.audioEvidenceUsed`, errors, {
      maximum: 12,
      itemMaxLength: 500,
    });
  }
  const context = evidence.contextEvidenceUsed || [];
  for (const item of evidence.visualTextEvidenceUsed || []) {
    if (context.includes(item)) {
      errors.push(`素材 ${asset.assetId} 的 contextEvidence 不得填入 visualTextEvidence。`);
    }
  }
}

function validateStage5CAnalysis(analysis, manifest, errors, analysisById) {
  const hasStage5C = (analysis.assets || []).some((asset) => (
    asset.visualTextAnalysis
    || asset.explanationPlan
    || asset.audioAnalysis
    || asset.videoPreservationPlan
  )) || analysis.lightCaptionPlan != null
    || analysis.visualExplanationSummary != null;
  if (!hasStage5C) return;

  const manifestById = new Map((manifest?.items || []).map((item) => [item.assetId, item]));
  for (const asset of analysis.assets || []) {
    const source = manifestById.get(asset.assetId);
    validateVisualTextAnalysis(asset, source, errors);
    validateExplanationPlan(asset, source, errors);
    validateAudioAnalysis(asset, source, errors);
    validateVideoPreservationPlan(asset, source, errors);
    validateEvidenceBoundary(asset, errors);
  }
  validateLightCaptionPlan(analysis, manifest, errors, analysisById);
  validateDurationConflictReporting(analysis, manifest, errors, analysisById);

  for (const [index, shot] of (analysis.timeline?.shots || []).entries()) {
    const asset = analysisById.get(shot.assetId);
    const source = manifestById.get(shot.assetId);
    validateShotAgainstStage5C(shot, `timeline.shots[${index}]`, asset, source, errors);
  }

  if (analysis.visualExplanationSummary != null) {
    const summary = analysis.visualExplanationSummary;
    if (!isObject(summary)) {
      errors.push('visualExplanationSummary 必须是对象。');
    } else {
      for (const key of [
        'assetsWithVisualText', 'assetsWithLightCaptions', 'assetsWithoutCaptions',
        'assetsNeedingReview', 'videosPreservedFull', 'videosSuggestedTrim',
        'videosPreserveOriginalAudio', 'videosSuggestedMute',
      ]) {
        if (summary[key] != null && (!Number.isInteger(summary[key]) || summary[key] < 0)) {
          errors.push(`visualExplanationSummary.${key} 必须是非负整数。`);
        }
      }
    }
  }
}

function buildDefaultAudioAnalysis(item) {
  if (item.type === 'image') {
    return {
      audioAvailable: false,
      audioEnabled: false,
      audioRole: 'none',
      speechPresent: false,
      musicPresent: false,
      soundEffectPresent: false,
      audioSummary: '图片素材无音频流。',
      audioNeededForUnderstanding: false,
      preserveOriginalAudio: false,
      muteReason: 'no_audio_stream',
      warnings: [],
    };
  }
  const hasAudio = item.metadata?.hasAudio === true;
  if (!hasAudio) {
    return {
      audioAvailable: false,
      audioEnabled: false,
      audioRole: 'none',
      speechPresent: false,
      musicPresent: false,
      soundEffectPresent: false,
      audioSummary: '探测不到可解码音频流。',
      audioNeededForUnderstanding: false,
      preserveOriginalAudio: false,
      muteReason: 'no_audio_stream',
      warnings: [],
    };
  }
  return {
    audioAvailable: true,
    audioEnabled: true,
    audioRole: 'unknown',
    speechPresent: false,
    musicPresent: false,
    soundEffectPresent: false,
    audioSummary: '已探测到音频流；内容理解待多模态审阅，未伪造语音转写。',
    audioNeededForUnderstanding: true,
    preserveOriginalAudio: true,
    muteReason: null,
    warnings: [],
  };
}

function buildDefaultVideoPreservationPlan(item) {
  const durationSec = Number(item.metadata?.durationSec);
  if (item.type !== 'video' || !Number.isFinite(durationSec) || durationSec <= 0) return null;
  return {
    assetId: item.assetId,
    sourceDuration: durationSec,
    proposedIn: 0,
    proposedOut: durationSec,
    selectedDuration: durationSec,
    keepRatio: 1,
    preserveFullClip: true,
    trimReason: null,
    criticalMoments: [],
    protectedTimeRanges: [],
    subtitleTimeRanges: [],
    audioCriticalTimeRanges: [],
    warnings: [],
  };
}

function summarizeVisualExplanation(analysis, manifest = null) {
  const assets = Array.isArray(analysis?.assets) ? analysis.assets : [];
  const captions = Array.isArray(analysis?.lightCaptionPlan) ? analysis.lightCaptionPlan : [];
  const captionAssetIds = new Set(captions.map((item) => item.assetId));
  const manifestById = new Map((manifest?.items || []).map((item) => [item.assetId, item]));
  let assetsWithVisualText = 0;
  let assetsWithoutCaptions = 0;
  let assetsNeedingReview = 0;
  let videosPreservedFull = 0;
  let videosSuggestedTrim = 0;
  let videosPreserveOriginalAudio = 0;
  let videosSuggestedMute = 0;

  for (const asset of assets) {
    const items = asset.visualTextAnalysis?.items || [];
    if (items.length > 0) assetsWithVisualText += 1;
    const needs = asset.explanationPlan?.audienceNeedsExplanation;
    if (needs === 'none' || (needs && needs !== 'insufficient_evidence' && !captionAssetIds.has(asset.assetId))) {
      if (needs === 'none') assetsWithoutCaptions += 1;
    }
    if (asset.explanationPlan?.audienceNeedsExplanation === 'insufficient_evidence'
      || captions.some((caption) => caption.assetId === asset.assetId && caption.reviewRequired)
      || (asset.visualTextAnalysis?.items || []).some((item) => item.textType === 'uncertain' || item.confidence < 0.55)) {
      assetsNeedingReview += 1;
    }
    const source = manifestById.get(asset.assetId);
    if ((source?.type || asset.type) === 'video') {
      if (asset.videoPreservationPlan?.preserveFullClip === true) videosPreservedFull += 1;
      if (asset.videoPreservationPlan?.preserveFullClip === false) videosSuggestedTrim += 1;
      if (asset.audioAnalysis?.preserveOriginalAudio === true) videosPreserveOriginalAudio += 1;
      if (asset.audioAnalysis?.audioEnabled === false && asset.audioAnalysis?.muteReason) {
        videosSuggestedMute += 1;
      }
    }
  }

  return {
    assetsWithVisualText,
    assetsWithLightCaptions: captionAssetIds.size,
    assetsWithoutCaptions,
    assetsNeedingReview,
    videosPreservedFull,
    videosSuggestedTrim,
    videosPreserveOriginalAudio,
    videosSuggestedMute,
    lightCaptionCount: captions.length,
  };
}

function shotShouldKeepOriginalAudio(shot, assetAnalysis, mapping) {
  if (mapping?.type === 'image') return false;
  if (!mapping?.metadata?.hasAudio) return false;
  const audio = assetAnalysis?.audioAnalysis;
  if (audio?.preserveOriginalAudio === true) return true;
  if (audio?.audioEnabled === false && isNonEmptyString(audio?.muteReason, 500)) return false;
  return shot.audioMode === 'keep';
}

function fcpxmlShouldMuteShot(shot, assetAnalysis, mapping) {
  if (!mapping?.metadata?.hasAudio) return false;
  if (assetAnalysis?.audioAnalysis?.preserveOriginalAudio === true) return false;
  if (shot.audioMode !== 'mute') return false;
  if (assetAnalysis?.audioAnalysis && !isNonEmptyString(assetAnalysis.audioAnalysis.muteReason, 500)) {
    return false;
  }
  return true;
}

const ANALYSIS_BUDGET = {
  maxSceneFrames: 12,
  maxTimedFrames: 10,
  maxDenseFrames: 60,
  maxVisualTextItemsPerAsset: MAX_VISUAL_TEXT_ITEMS_PER_ASSET,
  maxOcrTextLength: MAX_OCR_TEXT_LENGTH,
  maxExplanationFieldLength: MAX_EXPLANATION_FIELD_LENGTH,
  maxLightCaptionsPerStoryUnit: MAX_LIGHT_CAPTIONS_PER_STORY_UNIT,
  maxLightCaptionsPerProject: MAX_LIGHT_CAPTIONS_PER_PROJECT,
};

module.exports = {
  ANALYSIS_BUDGET,
  ALLOWED_TRIM_REASON_PREFIXES,
  AUDIO_ROLES,
  CAPTION_PURPOSES,
  EXPLANATION_NEEDS,
  MAX_LIGHT_CAPTIONS_PER_PROJECT,
  MAX_LIGHT_CAPTIONS_PER_STORY_UNIT,
  MAX_OCR_TEXT_LENGTH,
  MAX_VISUAL_TEXT_ITEMS_PER_ASSET,
  TEXT_TYPES,
  buildDefaultAudioAnalysis,
  buildDefaultVideoPreservationPlan,
  contextMasqueradesAsVisualText,
  fcpxmlShouldMuteShot,
  mergeVisualTextIntervals,
  normalizeSubtitleText,
  rangesOverlap,
  shotShouldKeepOriginalAudio,
  subtitleSimilarity,
  summarizeVisualExplanation,
  textsAreSameSubtitle,
  trimReasonAllowed,
  validateStage5CAnalysis,
};
