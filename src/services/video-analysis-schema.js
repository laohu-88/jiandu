const ASSET_STATUSES = new Set(['adopt', 'candidate', 'reject']);
const FIT_MODES = new Set(['contain', 'cover']);
const AUDIO_MODES = new Set(['keep', 'mute']);
const SUBTITLE_POSITIONS = new Set(['bottom-safe', 'top-safe', 'center']);
const TIMELINE_ORIENTATIONS = new Set(['horizontal', 'vertical']);
const FCP_UNSUPPORTED_SOURCE_EXTENSIONS = new Set(['webm']);
const NARRATIVE_ROLES = new Set([
  'hook', 'setup', 'context', 'process', 'evidence', 'transition',
  'result', 'comparison', 'conclusion', 'supporting',
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

function computeChapterSegments(shots) {
  const segments = [];
  let cursor = 0;
  for (const shot of shots) {
    const startSec = cursor;
    cursor = Number((cursor + Number(shot.durationSec || 0)).toFixed(3));
    const current = segments.at(-1);
    if (current && current.chapterId === shot.chapterId) {
      current.endShotId = shot.id;
      current.endSec = cursor;
      current.shotCount += 1;
    } else {
      segments.push({
        chapterId: shot.chapterId,
        startShotId: shot.id,
        endShotId: shot.id,
        startSec,
        endSec: cursor,
        shotCount: 1,
      });
    }
  }
  return segments;
}

function sameScalar(left, right, tolerance = 0.02) {
  if (Number.isFinite(left) && Number.isFinite(right)) return Math.abs(left - right) <= tolerance;
  return left === right;
}

function validateNarrativeAnalysis(analysis, manifest, errors) {
  const manifestChapters = Array.isArray(manifest?.chapters) ? manifest.chapters : [];
  if (manifestChapters.length === 0 || manifest.narrative?.enforceChapterValidation === false) return;
  const manifestById = new Map(manifest.items.map((item) => [item.assetId, item]));
  const chapterOrder = new Map(manifestChapters.map((chapter) => [
    chapter.chapterId,
    chapter.chapterOrder,
  ]));
  const subchapterOrder = new Map();
  for (const chapter of manifestChapters) {
    for (const subchapter of chapter.subchapters || []) {
      subchapterOrder.set(
        `${chapter.chapterId}:${subchapter.subchapterId}`,
        subchapter.subchapterOrder,
      );
    }
  }

  if (!Array.isArray(analysis.chapters)) {
    errors.push('多章节素材要求 analysis.chapters。');
  } else {
    const actual = analysis.chapters.map((chapter) => ({
      chapterId: chapter?.chapterId,
      chapterName: chapter?.chapterName,
      chapterOrder: chapter?.chapterOrder,
      relativePath: chapter?.relativePath,
      subchapters: Array.isArray(chapter?.subchapters)
        ? chapter.subchapters.map((subchapter) => ({
          subchapterId: subchapter?.subchapterId,
          subchapterName: subchapter?.subchapterName,
          subchapterOrder: subchapter?.subchapterOrder,
          relativePath: subchapter?.relativePath,
        }))
        : null,
    }));
    const expected = manifestChapters.map((chapter) => ({
      chapterId: chapter.chapterId,
      chapterName: chapter.chapterName,
      chapterOrder: chapter.chapterOrder,
      relativePath: chapter.relativePath,
      subchapters: (chapter.subchapters || []).map((subchapter) => ({
        subchapterId: subchapter.subchapterId,
        subchapterName: subchapter.subchapterName,
        subchapterOrder: subchapter.subchapterOrder,
        relativePath: subchapter.relativePath,
      })),
    }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push('analysis.chapters 与素材清单检测到的章节/子章节顺序不一致。');
    }
    analysis.chapters.forEach((chapter, index) => {
      if (!isNonEmptyString(chapter?.purpose, 500)) {
        errors.push(`chapters[${index}].purpose 必须说明该章的叙事任务。`);
      }
    });
  }

  if (manifest.projectBrief) {
    if (!isObject(analysis.projectBrief)) {
      errors.push('检测到根目录本期说明，analysis.projectBrief 不能为空。');
    } else {
      const expectedHard = manifest.projectBrief.hardConstraints;
      if (JSON.stringify(analysis.projectBrief.hardConstraints) !== JSON.stringify(expectedHard)) {
        errors.push('analysis.projectBrief 未保留本期说明的章节硬约束。');
      }
      const expectedDocuments = manifest.projectBrief.sourceDocuments || [];
      const actualDocuments = analysis.projectBrief.sourceDocuments || [];
      for (const relativePath of expectedDocuments) {
        if (!actualDocuments.includes(relativePath)) {
          errors.push(`analysis.projectBrief 未记录已读取的说明文件：${relativePath}`);
        }
      }
    }
    const used = Array.isArray(analysis.contextDocumentsUsed)
      ? analysis.contextDocumentsUsed.map((item) => item?.relativePath)
      : [];
    for (const relativePath of manifest.projectBrief.sourceDocuments || []) {
      if (!used.includes(relativePath)) {
        errors.push(`contextDocumentsUsed 未记录说明文件用途：${relativePath}`);
      }
    }
  }

  const analysisById = new Map((analysis.assets || []).map((asset) => [asset.assetId, asset]));
  for (const item of manifest.items) {
    const asset = analysisById.get(item.assetId);
    if (!asset) continue;
    if (asset.chapterId !== item.chapterId) {
      errors.push(`素材 ${item.assetId} 的 chapterId 与目录章节不一致。`);
    }
    if ((asset.subchapterId ?? null) !== (item.subchapterId ?? null)) {
      errors.push(`素材 ${item.assetId} 的 subchapterId 与目录子章节不一致。`);
    }
  }

  const shots = Array.isArray(analysis.timeline?.shots) ? analysis.timeline.shots : [];
  let previousChapterOrder = -Infinity;
  const previousSubchapterByChapter = new Map();
  const adoptedChapterIds = new Set();
  for (const [index, shot] of shots.entries()) {
    const source = manifestById.get(shot.assetId);
    if (!isNonEmptyString(shot.chapterId, 100)) {
      errors.push(`timeline.shots[${index}].chapterId 不能为空。`);
      continue;
    }
    if (source && shot.chapterId !== source.chapterId) {
      errors.push(`timeline.shots[${index}].chapterId 与素材所属章节不一致。`);
    }
    if (source && (shot.subchapterId ?? null) !== (source.subchapterId ?? null)) {
      errors.push(`timeline.shots[${index}].subchapterId 与素材所属子章节不一致。`);
    }
    const order = chapterOrder.get(shot.chapterId);
    if (!Number.isFinite(order)) {
      errors.push(`timeline.shots[${index}].chapterId 不在章节计划中。`);
      continue;
    }
    if (manifest.narrative?.allowChapterInterleave !== true && order < previousChapterOrder) {
      errors.push(`章节交叉：${shot.chapterId} 在后续章节开始后再次出现。`);
    }
    previousChapterOrder = Math.max(previousChapterOrder, order);
    adoptedChapterIds.add(shot.chapterId);
    if (shot.subchapterId) {
      const subOrder = subchapterOrder.get(`${shot.chapterId}:${shot.subchapterId}`);
      if (!Number.isFinite(subOrder)) {
        errors.push(`timeline.shots[${index}].subchapterId 不在子章节计划中。`);
      } else {
        const previous = previousSubchapterByChapter.get(shot.chapterId) || -Infinity;
        if (subOrder < previous) {
          errors.push(`子章节交叉：${shot.subchapterId} 在后续子章节开始后再次出现。`);
        }
        previousSubchapterByChapter.set(shot.chapterId, Math.max(previous, subOrder));
      }
    }
  }
  for (const chapter of manifestChapters.filter((item) => item.required !== false)) {
    if (!adoptedChapterIds.has(chapter.chapterId)) {
      errors.push(`要求章节 ${chapter.chapterId} 至少需要一个有效镜头。`);
    }
  }

  const computedSegments = computeChapterSegments(shots);
  if (!Array.isArray(analysis.timeline?.chapterSegments)) {
    errors.push('多章节时间线必须记录 timeline.chapterSegments。');
  } else {
    const actualSegments = analysis.timeline.chapterSegments;
    if (actualSegments.length !== computedSegments.length) {
      errors.push('timeline.chapterSegments 数量与镜头章节边界不一致。');
    } else {
      computedSegments.forEach((expected, index) => {
        const actual = actualSegments[index] || {};
        for (const key of ['chapterId', 'startShotId', 'endShotId', 'shotCount']) {
          if (actual[key] !== expected[key]) {
            errors.push(`timeline.chapterSegments[${index}].${key} 与镜头顺序不一致。`);
          }
        }
        for (const key of ['startSec', 'endSec']) {
          if (!sameScalar(actual[key], expected[key])) {
            errors.push(`timeline.chapterSegments[${index}].${key} 与镜头时长不一致。`);
          }
        }
      });
    }
  }

  const expectedPolicy = manifest.narrative?.durationPolicy;
  const actualPolicy = analysis.timeline?.durationPolicy;
  if (!isObject(actualPolicy)) {
    errors.push('多章节时间线必须记录 timeline.durationPolicy。');
  } else if (expectedPolicy && (
    !sameScalar(actualPolicy.minSec, expectedPolicy.minSec)
    || !sameScalar(actualPolicy.maxSec, expectedPolicy.maxSec)
    || actualPolicy.source !== expectedPolicy.source
  )) {
    errors.push('timeline.durationPolicy 与素材扫描阶段的多章节策略不一致。');
  }
  if (expectedPolicy) {
    const duration = timelineDuration(shots);
    const outside = duration < expectedPolicy.minSec - 0.02
      || duration > expectedPolicy.maxSec + 0.02;
    if (outside && !isNonEmptyString(analysis.timeline?.durationException, 1000)) {
      errors.push(
        `时间线总时长 ${duration} 秒不在允许范围 `
        + `${expectedPolicy.minSec}–${expectedPolicy.maxSec} 秒，且没有明确解释。`,
      );
    }
  }
}

function validateEvidenceDecision(value, field, errors) {
  if (!isObject(value)) {
    errors.push(`${field} 必须是对象。`);
    return;
  }
  validateStringList(value.visualEvidenceUsed, `${field}.visualEvidenceUsed`, errors, {
    maximum: 12,
    itemMaxLength: 500,
  });
  validateStringList(value.contextEvidenceUsed, `${field}.contextEvidenceUsed`, errors, {
    maximum: 12,
    itemMaxLength: 500,
  });
  validateStringList(value.inference, `${field}.inference`, errors, {
    maximum: 12,
    itemMaxLength: 500,
  });
}

function validateStoryUnitAnalysis(analysis, manifest, errors, analysisById) {
  const manifestUnits = Array.isArray(manifest?.storyUnits) ? manifest.storyUnits : [];
  if (manifestUnits.length === 0) return;
  if (!Array.isArray(analysis.storyUnits)) {
    errors.push('含上下文的 Stage 5B 素材要求 analysis.storyUnits。');
    return;
  }
  const manifestById = new Map(manifest.items.map((item) => [item.assetId, item]));
  const expectedById = new Map(manifestUnits.map((unit) => [unit.storyUnitId, unit]));
  const actualById = new Map();
  for (const [index, unit] of analysis.storyUnits.entries()) {
    const field = `storyUnits[${index}]`;
    if (!isObject(unit)) {
      errors.push(`${field} 必须是对象。`);
      continue;
    }
    if (!isNonEmptyString(unit.storyUnitId, 100)) errors.push(`${field}.storyUnitId 无效。`);
    if (actualById.has(unit.storyUnitId)) errors.push(`${field}.storyUnitId 重复。`);
    actualById.set(unit.storyUnitId, unit);
    const expected = expectedById.get(unit.storyUnitId);
    if (!expected) errors.push(`${field}.storyUnitId 不在 manifest.storyUnits 中。`);
    validateStringList(unit.assetIds, `${field}.assetIds`, errors, {
      minimum: 1,
      maximum: expected?.assetIds?.length || manifest.items.length,
      itemMaxLength: 100,
    });
    const assetIds = Array.isArray(unit.assetIds) ? unit.assetIds : [];
    for (const assetId of assetIds) {
      if (!manifestById.has(assetId)) errors.push(`${field}.assetIds 引用了不存在的素材 ${assetId}。`);
      if (expected && !expected.assetIds.includes(assetId)) {
        errors.push(`${field}.assetIds 包含不属于该 Story Unit 的素材 ${assetId}。`);
      }
    }
    if (expected && JSON.stringify([...assetIds].sort()) !== JSON.stringify([...expected.assetIds].sort())) {
      errors.push(`${field}.assetIds 必须完整保留 manifest 的 Story Unit 成员。`);
    }
    const expectedContextFiles = expected?.evidence?.contextSourceFiles || [];
    validateStringList(unit.contextSourceFiles, `${field}.contextSourceFiles`, errors, {
      minimum: expectedContextFiles.length > 0 ? 1 : 0,
      maximum: expectedContextFiles.length,
      itemMaxLength: 1000,
    });
    for (const relativePath of unit.contextSourceFiles || []) {
      if (!expectedContextFiles.includes(relativePath)) {
        errors.push(`${field}.contextSourceFiles 包含未绑定的上下文：${relativePath}`);
      }
    }
    if ((expected?.chapterIds || []).length === 1
      && unit.chapterId !== expected.chapterIds[0]) {
      errors.push(`${field}.chapterId 必须服从素材所属顶层章节。`);
    }
    if ((expected?.chapterIds || []).length > 1 && unit.chapterId != null) {
      errors.push(`${field}.chapterId 在跨章节 Story Unit 中必须为 null，并保留警告。`);
    }
    const classificationKeys = [
      'representativeAssetIds', 'supportingAssetIds', 'alternateAssetIds',
      'duplicateAssetIds', 'unusableAssetIds',
    ];
    for (const key of classificationKeys) {
      validateStringList(unit[key], `${field}.${key}`, errors, {
        minimum: key === 'representativeAssetIds' ? 1 : 0,
        maximum: assetIds.length,
        itemMaxLength: 100,
      });
      for (const assetId of Array.isArray(unit[key]) ? unit[key] : []) {
        if (!assetIds.includes(assetId)) {
          errors.push(`${field}.${key} 的 ${assetId} 不属于该 Story Unit。`);
        }
      }
    }
    const classified = classificationKeys.flatMap((key) => unit[key] || []);
    if (new Set(classified).size !== classified.length) {
      errors.push(`${field} 的 representative/supporting/alternate/duplicate/unusable 分类不能重叠。`);
    }
    if (assetIds.some((assetId) => !classified.includes(assetId))) {
      errors.push(`${field} 必须为每个视觉素材记录变体选择分类。`);
    }
    if (!isNonEmptyString(unit.selectionReason, 1000)) {
      errors.push(`${field}.selectionReason 必须解释代表素材选择。`);
    }
    if (!NARRATIVE_ROLES.has(unit.narrativeRole)) {
      errors.push(`${field}.narrativeRole 无效。`);
    }
    if (!isConfidence(unit.confidence)) errors.push(`${field}.confidence 必须在 0 到 1 之间。`);
    validateStringList(unit.conflicts, `${field}.conflicts`, errors, {
      maximum: 20,
      itemMaxLength: 500,
    });
    validateStringList(unit.warnings, `${field}.warnings`, errors, {
      maximum: 20,
      itemMaxLength: 500,
    });
    for (const warning of expected?.warnings || []) {
      if (!(unit.warnings || []).includes(warning)) {
        errors.push(`${field}.warnings 未保留 manifest 中的归组警告。`);
      }
    }
    validateEvidenceDecision(unit.evidence, `${field}.evidence`, errors);
  }
  for (const expected of manifestUnits) {
    if (!actualById.has(expected.storyUnitId)) {
      errors.push(`缺少 Story Unit ${expected.storyUnitId} 的分析记录。`);
    }
  }

  for (const item of manifest.items) {
    const asset = analysisById.get(item.assetId);
    if (!asset) continue;
    if (asset.storyUnitId !== item.storyUnitId) {
      errors.push(`素材 ${item.assetId} 的 storyUnitId 与 manifest 不一致。`);
    }
    if (!NARRATIVE_ROLES.has(asset.narrativeRole)) {
      errors.push(`素材 ${item.assetId} 的 narrativeRole 无效。`);
    }
    if (!isNonEmptyString(asset.selectionReason, 1000)) {
      errors.push(`素材 ${item.assetId} 缺少 selectionReason。`);
    }
    validateStringList(asset.conflicts, `素材 ${item.assetId}.conflicts`, errors, {
      maximum: 20,
      itemMaxLength: 500,
    });
    validateStringList(asset.warnings, `素材 ${item.assetId}.warnings`, errors, {
      maximum: 20,
      itemMaxLength: 500,
    });
    validateEvidenceDecision(asset.evidence, `素材 ${item.assetId}.evidence`, errors);
    for (const conflict of item.semanticProfile?.conflicts || []) {
      if (!(asset.conflicts || []).includes(conflict)) {
        errors.push(`素材 ${item.assetId}.conflicts 未保留上下文冲突。`);
      }
    }
    for (const warning of item.semanticProfile?.warnings || []) {
      if (!(asset.warnings || []).includes(warning)) {
        errors.push(`素材 ${item.assetId}.warnings 未保留上下文警告。`);
      }
    }
  }

  const analyzedUnits = new Map(analysis.storyUnits.map((unit) => [unit.storyUnitId, unit]));
  for (const [index, shot] of (analysis.timeline?.shots || []).entries()) {
    const field = `timeline.shots[${index}]`;
    const source = manifestById.get(shot.assetId);
    const unit = analyzedUnits.get(shot.storyUnitId);
    if (!source?.storyUnitId || shot.storyUnitId !== source.storyUnitId || !unit) {
      errors.push(`${field}.storyUnitId 无法追溯到真实视觉素材。`);
    }
    if (!NARRATIVE_ROLES.has(shot.narrativeRole)) errors.push(`${field}.narrativeRole 无效。`);
    if (!isNonEmptyString(shot.selectionReason, 1000)) {
      errors.push(`${field}.selectionReason 必须解释镜头选择。`);
    }
    validateEvidenceDecision(shot.evidence, `${field}.evidence`, errors);
    if (unit && !(unit.representativeAssetIds || []).includes(shot.assetId)
      && !(unit.supportingAssetIds || []).includes(shot.assetId)) {
      errors.push(`${field} 使用了未列为 representative/supporting 的 Story Unit 素材。`);
    }
    const conflicts = [
      ...(Array.isArray(unit?.conflicts) ? unit.conflicts : []),
      ...(Array.isArray(analysisById.get(shot.assetId)?.conflicts)
        ? analysisById.get(shot.assetId).conflicts : []),
    ];
    if (conflicts.length > 0 && (shot.reviewRequired !== true || shot.confidence > 0.6)) {
      errors.push(`${field} 存在上下文/画面冲突，必须降低 confidence 并标记 reviewRequired。`);
    }
  }
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
    const contextFiles = Array.isArray(source?.context?.files)
      ? source.context.files.map((entry) => entry?.relativePath).filter(Boolean)
      : [];
    if (contextFiles.length > 0) {
      const usage = asset.contextUsage;
      if (!isObject(usage)) {
        errors.push(`${field}.contextUsage 必须记录 HotIngest 上下文是否使用。`);
      } else {
        if (typeof usage.used !== 'boolean') {
          errors.push(`${field}.contextUsage.used 必须是布尔值。`);
        }
        validateStringList(usage.sourceFiles, `${field}.contextUsage.sourceFiles`, errors, {
          minimum: usage.used === true ? 1 : 0,
          maximum: contextFiles.length,
          itemMaxLength: 1000,
        });
        for (const relativePath of Array.isArray(usage.sourceFiles) ? usage.sourceFiles : []) {
          if (!contextFiles.includes(relativePath)) {
            errors.push(`${field}.contextUsage.sourceFiles 包含未绑定的上下文：${relativePath}`);
          }
        }
        if (!isNonEmptyString(usage.visualEvidence, 1000)) {
          errors.push(`${field}.contextUsage.visualEvidence 必须单独说明画面可见事实。`);
        }
        if (!isNonEmptyString(usage.contextEvidence, 1000)) {
          errors.push(`${field}.contextUsage.contextEvidence 必须说明上下文用途或未使用原因。`);
        }
      }
    }
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
  validateStoryUnitAnalysis(analysis, manifest, errors, analysisById);

  if (!isObject(analysis.timeline)) {
    errors.push('timeline 必须是对象。');
  } else {
    if (analysis.timeline.orientation != null
      && !TIMELINE_ORIENTATIONS.has(analysis.timeline.orientation)) {
      errors.push('timeline.orientation 必须是 horizontal 或 vertical。');
    }
    if (analysis.timeline.width != null && (!Number.isInteger(analysis.timeline.width)
      || analysis.timeline.width < 320
      || analysis.timeline.width % 2 !== 0)) {
      errors.push('timeline.width 必须是大于等于 320 的偶数。');
    }
    if (analysis.timeline.height != null && (!Number.isInteger(analysis.timeline.height)
      || analysis.timeline.height < 320
      || analysis.timeline.height % 2 !== 0)) {
      errors.push('timeline.height 必须是大于等于 320 的偶数。');
    }
    if (analysis.timeline.fps != null && (!Number.isFinite(analysis.timeline.fps)
      || analysis.timeline.fps < 1
      || analysis.timeline.fps > 120)) {
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
      if (source && FCP_UNSUPPORTED_SOURCE_EXTENSIONS.has(
        String(source.extension || '').toLowerCase(),
      )) {
        errors.push(`${field} 使用了 Final Cut Pro 不支持的 .${source.extension} 素材。`);
      }
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
    const markerIds = new Set();
    markers.forEach((marker, index) => {
      const field = `timeline.markers[${index}]`;
      if (!isObject(marker)
        || !Number.isFinite(marker.timeSec)
        || marker.timeSec < 0
        || marker.timeSec >= duration) {
        errors.push(`${field}.timeSec 必须位于时间线范围内。`);
      }
      if (!isNonEmptyString(marker?.text, 30)) errors.push(`${field}.text 必须是 1 到 30 字的轻字幕。`);
      if (marker?.id != null) {
        if (!isNonEmptyString(marker.id, 100)) errors.push(`${field}.id 无效。`);
        if (markerIds.has(marker.id)) errors.push(`${field}.id 重复。`);
        markerIds.add(marker.id);
      }
      if (marker?.type != null && !isNonEmptyString(marker.type, 50)) {
        errors.push(`${field}.type 无效。`);
      }
      if (marker?.subtitle != null) {
        const subtitle = marker.subtitle;
        if (!isObject(subtitle)) {
          errors.push(`${field}.subtitle 必须是对象。`);
        } else {
          if (typeof subtitle.enabled !== 'boolean') errors.push(`${field}.subtitle.enabled 必须是布尔值。`);
          if (!isNonEmptyString(subtitle.text, 30) || /[\r\n]/.test(subtitle.text || '')) {
            errors.push(`${field}.subtitle.text 必须是一行 1 到 30 字的轻字幕。`);
          }
          if (!Number.isFinite(subtitle.durationSec) || subtitle.durationSec <= 0) {
            errors.push(`${field}.subtitle.durationSec 必须大于 0。`);
          }
          if (!SUBTITLE_POSITIONS.has(subtitle.position)) {
            errors.push(`${field}.subtitle.position 无效。`);
          }
          if (!isNonEmptyString(subtitle.purpose, 200)) {
            errors.push(`${field}.subtitle.purpose 无效。`);
          }
          if (typeof subtitle.renderAsFcpTitle !== 'boolean') {
            errors.push(`${field}.subtitle.renderAsFcpTitle 必须是布尔值。`);
          }
        }
      }
    });
  }
  validateNarrativeAnalysis(analysis, manifest, errors);

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
  FCP_UNSUPPORTED_SOURCE_EXTENSIONS,
  FIT_MODES,
  NARRATIVE_ROLES,
  SUBTITLE_POSITIONS,
  TIMELINE_ORIENTATIONS,
  computeChapterSegments,
  timelineDuration,
  validateVideoAnalysis,
};
