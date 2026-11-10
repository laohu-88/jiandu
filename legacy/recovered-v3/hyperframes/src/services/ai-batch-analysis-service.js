const path = require('node:path');

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.srt', '.vtt', '.csv', '.json']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);
const BATCH_MODES = new Set(['unanalyzed', 'kept']);

function getAssetExtension(asset = {}) {
  const filename = asset.filename || asset.relativePath || '';
  const ext = asset.ext || path.extname(filename);
  return String(ext || '').toLowerCase().replace(/^\.?/, '.');
}

function getBatchAssetType(asset) {
  const ext = getAssetExtension(asset);
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return null;
}

function getAnalysisRecord(aiAnalysis, stableId) {
  if (!stableId || !aiAnalysis?.analyses || Array.isArray(aiAnalysis.analyses)) return null;
  const record = aiAnalysis.analyses[stableId];
  return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
}

function addReason(reasons, reason) {
  reasons[reason] = (reasons[reason] || 0) + 1;
}

function createResult(asset, status, reason) {
  return {
    stableId: asset?.stableId || null,
    filename: asset?.filename || asset?.relativePath || '',
    status,
    reason,
  };
}

function selectBatchCandidates(assets, aiAnalysis, mode) {
  if (!BATCH_MODES.has(mode)) {
    throw new Error('批量分析 mode 只能是 unanalyzed 或 kept。');
  }

  const queued = [];
  const skipped = [];
  const reasons = {};

  for (const asset of Array.isArray(assets) ? assets : []) {
    let skippedReason = null;
    if (mode === 'kept' && asset?.reviewStatus !== 'keep') {
      skippedReason = 'not_kept';
    } else if (asset?.availability === 'missing') {
      skippedReason = 'missing';
    }

    const assetType = getBatchAssetType(asset);
    if (!skippedReason && (!assetType || !asset?.stableId)) {
      skippedReason = 'unsupported_type';
    }

    const record = getAnalysisRecord(aiAnalysis, asset?.stableId);
    const fingerprintMatches = Boolean(
      record
      && record.sourceFingerprint === String(asset?.fingerprint || ''),
    );
    if (!skippedReason && record?.aiStatus === 'done' && fingerprintMatches) {
      skippedReason = 'already_done';
    }

    if (skippedReason) {
      skipped.push(createResult(asset, 'skipped', skippedReason));
      addReason(reasons, skippedReason);
      continue;
    }

    let inclusionReason = null;
    if (record?.aiStatus === 'failed') {
      inclusionReason = 'failed_retry_included';
    } else if (record && (record.aiStatus === 'stale' || !fingerprintMatches)) {
      inclusionReason = 'stale_included';
    }
    if (inclusionReason) addReason(reasons, inclusionReason);

    queued.push({
      stableId: asset.stableId,
      filename: asset.filename || asset.relativePath || '',
      assetType,
      sourceFingerprint: String(asset.fingerprint || ''),
      sourceType: assetType === 'image' ? 'image' : `text/${getAssetExtension(asset).slice(1)}`,
      reason: inclusionReason,
    });
  }

  return {
    queued,
    skipped,
    reasons,
    noMatchingAssets: queued.length === 0,
  };
}

function getAiEnvironmentIssue(environment, queued) {
  if (!queued.length) return null;
  if (!environment?.python?.ok) return 'Python 环境不可用。';
  if (environment.python.arch !== 'arm64') return 'Python 环境不是 arm64。';
  if (!environment?.packages?.mlx?.ok) return 'mlx 不可用。';
  if (queued.some((item) => item.assetType === 'text')
    && !environment?.packages?.mlx_lm?.ok) {
    return 'mlx_lm 不可用。';
  }
  if (queued.some((item) => item.assetType === 'image')
    && !environment?.packages?.mlx_vlm?.ok) {
    return 'mlx_vlm 不可用。';
  }
  return null;
}

function failureReason(error, assetType) {
  const code = typeof error?.code === 'string' ? error.code.trim() : '';
  if (code && /^[A-Z0-9_]+$/.test(code)) return code;
  return assetType === 'image' ? 'IMAGE_ANALYSIS_FAILED' : 'TEXT_ANALYSIS_FAILED';
}

async function notifyProgress(onProgress, progress) {
  if (typeof onProgress !== 'function') return;
  try {
    await onProgress(progress);
  } catch {
    // UI 进度通知失败不能中断批量分析。
  }
}

async function analyzeBatchAssets(args, options = {}) {
  const {
    projectPath,
    assets,
    aiAnalysis,
    mode,
  } = args || {};
  const analyzeTextImpl = options.analyzeTextImpl;
  const analyzeImageImpl = options.analyzeImageImpl;
  if (typeof analyzeTextImpl !== 'function' || typeof analyzeImageImpl !== 'function') {
    throw new Error('批量分析需要文本和图片分析函数。');
  }

  const selection = options.selection || selectBatchCandidates(assets, aiAnalysis, mode);
  const results = [...selection.skipped];
  const summary = {
    total: selection.queued.length,
    success: 0,
    failed: 0,
    skipped: selection.skipped.length,
  };

  await notifyProgress(options.onProgress, {
    phase: 'started',
    current: 0,
    filename: '',
    ...summary,
  });

  for (let index = 0; index < selection.queued.length; index += 1) {
    const item = selection.queued[index];
    const current = index + 1;
    await notifyProgress(options.onProgress, {
      phase: 'running',
      current,
      filename: item.filename,
      ...summary,
    });

    try {
      const analyzeImpl = item.assetType === 'image' ? analyzeImageImpl : analyzeTextImpl;
      await analyzeImpl({ projectPath, stableId: item.stableId });
      summary.success += 1;
      results.push(createResult(item, 'done', item.reason));
    } catch (error) {
      summary.failed += 1;
      if (typeof options.recordFailureImpl === 'function') {
        try {
          await options.recordFailureImpl(item, error);
        } catch {
          // 记录失败信息出错时仍继续后续素材。
        }
      }
      results.push(createResult(item, 'failed', failureReason(error, item.assetType)));
    }

    await notifyProgress(options.onProgress, {
      phase: 'completed',
      current,
      filename: item.filename,
      ...summary,
    });
  }

  return { ...summary, results };
}

module.exports = {
  BATCH_MODES,
  IMAGE_EXTENSIONS,
  TEXT_EXTENSIONS,
  analyzeBatchAssets,
  getAiEnvironmentIssue,
  getBatchAssetType,
  selectBatchCandidates,
};
