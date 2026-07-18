const ASSET_STATUSES = new Set(['adopt', 'candidate', 'reject']);
const FIT_MODES = new Set(['contain', 'cover']);
const AUDIO_MODES = new Set(['keep', 'mute']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value, maxLength = Infinity) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isConfidence(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
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
  if (!value.every((item) => isNonEmptyString(item, options.itemMaxLength || 200))) {
    errors.push(`${field} 只能包含非空字符串。`);
  }
}

function timelineDuration(shots) {
  return Number(shots.reduce((sum, shot) => sum + Number(shot.durationSec || 0), 0).toFixed(3));
}

function validateVideoAnalysis(analysis, manifest) {
  const errors = [];
  if (!isObject(analysis)) {
    throw Object.assign(new Error('分析结果必须是 JSON 对象。'), {
      code: 'INVALID_VIDEO_ANALYSIS',
      details: ['根节点必须是对象。'],
    });
  }
  if (analysis.schemaVersion !== 1) errors.push('schemaVersion 必须为 1。');

  if (!isObject(analysis.theme)) {
    errors.push('theme 必须是对象。');
  } else {
    if (!isNonEmptyString(analysis.theme.summary, 200)) errors.push('theme.summary 必须是非空字符串。');
    if (!isNonEmptyString(analysis.theme.rationale, 1000)) errors.push('theme.rationale 必须说明素材依据。');
    if (!isConfidence(analysis.theme.confidence)) errors.push('theme.confidence 必须在 0 到 1 之间。');
    if (typeof analysis.theme.folderNameConflict !== 'boolean') {
      errors.push('theme.folderNameConflict 必须是布尔值。');
    }
  }

  if (!isObject(analysis.titles)) {
    errors.push('titles 必须是对象。');
  } else {
    validateStringList(analysis.titles.candidates, 'titles.candidates', errors, {
      minimum: 2,
      maximum: 6,
      itemMaxLength: 80,
    });
    if (!isNonEmptyString(analysis.titles.recommended, 80)) {
      errors.push('titles.recommended 必须是非空字符串。');
    } else if (Array.isArray(analysis.titles.candidates)
      && !analysis.titles.candidates.includes(analysis.titles.recommended)) {
      errors.push('titles.recommended 必须来自 titles.candidates。');
    }
    if (!isNonEmptyString(analysis.titles.rationale, 1000)) {
      errors.push('titles.rationale 必须说明标题与素材的对应关系。');
    }
  }

  const manifestItems = Array.isArray(manifest?.items) ? manifest.items : [];
  const manifestById = new Map(manifestItems.map((item) => [item.assetId, item]));
  const analysisAssets = Array.isArray(analysis.assets) ? analysis.assets : [];
  const analysisById = new Map();
  if (!Array.isArray(analysis.assets)) {
    errors.push('assets 必须是数组。');
  }
  for (const [index, asset] of analysisAssets.entries()) {
    const field = `assets[${index}]`;
    if (!isObject(asset)) {
      errors.push(`${field} 必须是对象。`);
      continue;
    }
    if (!isNonEmptyString(asset.assetId, 100)) errors.push(`${field}.assetId 无效。`);
    if (analysisById.has(asset.assetId)) errors.push(`${field}.assetId 重复。`);
    analysisById.set(asset.assetId, asset);
    const source = manifestById.get(asset.assetId);
    if (!source) errors.push(`${field}.assetId 不在素材清单中。`);
    if (source && asset.type !== source.type) errors.push(`${field}.type 与素材清单不一致。`);
    validateStringList(asset.semanticLabels, `${field}.semanticLabels`, errors, {
      minimum: 1,
      maximum: 12,
      itemMaxLength: 50,
    });
    if (!isNonEmptyString(asset.contentSummary, 1000)) errors.push(`${field}.contentSummary 无效。`);
    validateStringList(asset.suggestedUse, `${field}.suggestedUse`, errors, {
      maximum: 5,
      itemMaxLength: 200,
    });
    if (!ASSET_STATUSES.has(asset.status)) errors.push(`${field}.status 无效。`);
    if (!isNonEmptyString(asset.reason, 1000)) errors.push(`${field}.reason 无效。`);
    if (!isConfidence(asset.confidence)) errors.push(`${field}.confidence 必须在 0 到 1 之间。`);
    if (!Array.isArray(asset.ranges)) {
      errors.push(`${field}.ranges 必须是数组。`);
    } else {
      asset.ranges.forEach((range, rangeIndex) => {
        const rangeField = `${field}.ranges[${rangeIndex}]`;
        if (!isObject(range)
          || !Number.isFinite(range.startSec)
          || !Number.isFinite(range.endSec)
          || range.startSec < 0
          || range.endSec <= range.startSec) {
          errors.push(`${rangeField} 必须包含有效的 startSec 和 endSec。`);
          return;
        }
        if (!isConfidence(range.confidence)) errors.push(`${rangeField}.confidence 必须在 0 到 1 之间。`);
        if (range.reviewRequired != null && typeof range.reviewRequired !== 'boolean') {
          errors.push(`${rangeField}.reviewRequired 必须是布尔值。`);
        }
        if (source?.type === 'video'
          && Number.isFinite(source.metadata?.durationSec)
          && range.endSec > source.metadata.durationSec + 0.05) {
          errors.push(`${rangeField}.endSec 超出视频时长。`);
        }
      });
    }
  }
  for (const item of manifestItems) {
    if (!analysisById.has(item.assetId)) errors.push(`缺少素材 ${item.assetId} 的分析记录。`);
  }

  if (!isObject(analysis.timeline)) {
    errors.push('timeline 必须是对象。');
  } else {
    if (!Number.isInteger(analysis.timeline.width)
      || analysis.timeline.width < 320
      || analysis.timeline.width % 2 !== 0) {
      errors.push('timeline.width 必须是大于等于 320 的偶数。');
    }
    if (!Number.isInteger(analysis.timeline.height)
      || analysis.timeline.height < 320
      || analysis.timeline.height % 2 !== 0) {
      errors.push('timeline.height 必须是大于等于 320 的偶数。');
    }
    if (!Number.isFinite(analysis.timeline.fps)
      || analysis.timeline.fps < 1
      || analysis.timeline.fps > 120) {
      errors.push('timeline.fps 必须在 1 到 120 之间。');
    }
    const shots = Array.isArray(analysis.timeline.shots) ? analysis.timeline.shots : [];
    if (!Array.isArray(analysis.timeline.shots) || shots.length === 0) {
      errors.push('timeline.shots 至少需要一个镜头。');
    }
    const shotIds = new Set();
    for (const [index, shot] of shots.entries()) {
      const field = `timeline.shots[${index}]`;
      if (!isObject(shot)) {
        errors.push(`${field} 必须是对象。`);
        continue;
      }
      if (!isNonEmptyString(shot.id, 100)) errors.push(`${field}.id 无效。`);
      if (shotIds.has(shot.id)) errors.push(`${field}.id 重复。`);
      shotIds.add(shot.id);
      const source = manifestById.get(shot.assetId);
      const analyzed = analysisById.get(shot.assetId);
      if (!source) errors.push(`${field}.assetId 不在素材清单中。`);
      if (analyzed?.status === 'reject') errors.push(`${field} 使用了已淘汰素材。`);
      if (!Number.isFinite(shot.inSec) || shot.inSec < 0) errors.push(`${field}.inSec 无效。`);
      if (!Number.isFinite(shot.outSec) || shot.outSec <= shot.inSec) errors.push(`${field}.outSec 无效。`);
      if (!Number.isFinite(shot.durationSec) || shot.durationSec <= 0) {
        errors.push(`${field}.durationSec 无效。`);
      } else if (Number.isFinite(shot.inSec)
        && Number.isFinite(shot.outSec)
        && Math.abs((shot.outSec - shot.inSec) - shot.durationSec) > 0.02) {
        errors.push(`${field}.durationSec 必须等于 outSec - inSec。`);
      }
      if (source?.type === 'video'
        && Number.isFinite(source.metadata?.durationSec)
        && shot.outSec > source.metadata.durationSec + 0.05) {
        errors.push(`${field}.outSec 超出视频时长。`);
      }
      if (!FIT_MODES.has(shot.fitMode)) errors.push(`${field}.fitMode 无效。`);
      if (!AUDIO_MODES.has(shot.audioMode)) errors.push(`${field}.audioMode 无效。`);
      if (!isNonEmptyString(shot.purpose, 500)) errors.push(`${field}.purpose 无效。`);
      if (!isConfidence(shot.confidence)) errors.push(`${field}.confidence 必须在 0 到 1 之间。`);
      if (shot.reviewRequired != null && typeof shot.reviewRequired !== 'boolean') {
        errors.push(`${field}.reviewRequired 必须是布尔值。`);
      }
    }

    const duration = timelineDuration(shots);
    const markers = Array.isArray(analysis.timeline.markers) ? analysis.timeline.markers : [];
    if (!Array.isArray(analysis.timeline.markers)) errors.push('timeline.markers 必须是数组。');
    if (markers.length > 12) errors.push('timeline.markers 最多 12 条。');
    markers.forEach((marker, index) => {
      const field = `timeline.markers[${index}]`;
      if (!isObject(marker)
        || !Number.isFinite(marker.timeSec)
        || marker.timeSec < 0
        || marker.timeSec >= duration) {
        errors.push(`${field}.timeSec 必须位于时间线范围内。`);
      }
      if (!isNonEmptyString(marker?.text, 30)) errors.push(`${field}.text 必须是 1 到 30 字的轻字幕。`);
    });
  }

  if (errors.length > 0) {
    throw Object.assign(new Error(`Codex 视频分析协议校验失败：${errors[0]}`), {
      code: 'INVALID_VIDEO_ANALYSIS',
      details: errors,
    });
  }
  return analysis;
}

module.exports = {
  ASSET_STATUSES,
  AUDIO_MODES,
  FIT_MODES,
  timelineDuration,
  validateVideoAnalysis,
};
