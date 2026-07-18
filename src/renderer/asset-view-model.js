(function createAssetViewModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.AssetViewModel = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const TEXT_ASSET_EXTENSIONS = new Set(['txt', 'md', 'srt', 'vtt', 'csv', 'json']);
  const IMAGE_ASSET_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
  const PREVIEW_TYPES = new Set(['video', 'image', 'audio', 'text']);
  const REVIEW_STATUSES = new Set(['keep', 'maybe', 'reject']);

  function getAssetUiKey(asset = {}) {
    return asset.stableId || asset.relativePath || asset.id || asset.filename;
  }

  function getAssetTypeCategory(asset = {}) {
    if (['video', 'image', 'audio'].includes(asset.type)) return asset.type;
    const ext = String(asset.ext || asset.filename?.split('.').pop() || '')
      .toLowerCase()
      .replace(/^\./, '');
    if (IMAGE_ASSET_EXTENSIONS.has(ext)) return 'image';
    if (asset.type === 'text' || TEXT_ASSET_EXTENSIONS.has(ext)) return 'text';
    return 'other';
  }

  function getAssetReviewCategory(asset = {}) {
    if (asset.availability === 'missing') return 'missing';
    return REVIEW_STATUSES.has(asset.reviewStatus) ? asset.reviewStatus : 'unreviewed';
  }

  function assetMatchesFilters(asset, filters = {}) {
    const searchQuery = String(filters.searchQuery || '').trim().toLowerCase();
    const typeFilter = filters.typeFilter || 'all';
    const reviewFilter = filters.reviewFilter || 'all';
    const matchesSearch = !searchQuery
      || String(asset?.filename || '').toLowerCase().includes(searchQuery);
    const matchesType = typeFilter === 'all'
      || getAssetTypeCategory(asset) === typeFilter;
    const matchesReview = reviewFilter === 'all'
      || getAssetReviewCategory(asset) === reviewFilter;
    return matchesSearch && matchesType && matchesReview;
  }

  function parseAssetReviewTags(value) {
    return String(value || '').split(',').map((tag) => tag.trim()).filter(Boolean);
  }

  function getAssetPreviewType(asset) {
    const type = getAssetTypeCategory(asset);
    return PREVIEW_TYPES.has(type) ? type : 'unsupported';
  }

  function getAssetRatingValue(rating) {
    return Number.isInteger(rating) && rating >= 0 && rating <= 5 ? rating : 0;
  }

  function getAiAnalysisRecord(payload, stableId) {
    if (typeof stableId !== 'string' || !stableId) return null;
    const analyses = payload?.analyses;
    if (!analyses || typeof analyses !== 'object' || Array.isArray(analyses)) return null;
    const record = analyses[stableId];
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  }

  function getAiAnalysisForAsset(payload, asset) {
    const stableId = typeof asset === 'string' ? asset : asset?.stableId;
    return getAiAnalysisRecord(payload, stableId);
  }

  function formatAiList(items) {
    if (!Array.isArray(items)) return '—';
    const values = items
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
    return values.length ? values.join('、') : '—';
  }

  function formatAiRisk(risk) {
    if (!risk || typeof risk !== 'object' || Array.isArray(risk)) return '—';
    const level = {
      unknown: '',
      low: '低风险',
      medium: '中风险',
      high: '高风险',
      critical: '严重风险',
    }[risk.level] || String(risk.level || '').trim();
    const flags = formatAiList(risk.flags);
    const parts = [level, flags === '—' ? '' : flags, String(risk.reason || '').trim()]
      .filter(Boolean);
    return parts.length ? parts.join('｜') : '—';
  }

  function formatAiError(error) {
    if (!error || typeof error !== 'object' || Array.isArray(error)) return '—';
    const code = String(error.code || '').trim();
    const message = String(error.message || '').trim();
    const occurredAt = String(error.occurredAt || '').trim();
    let text = code && message ? `${code}：${message}` : code || message || '未知错误';
    if (error.retryable === true) text += '（可重试）';
    if (occurredAt) text += `｜${occurredAt}`;
    return text;
  }

  function formatAiSuggestedUse(items) {
    if (!Array.isArray(items)) return '—';
    const roleLabels = {
      opening: '开场',
      process: '过程',
      result: '结果',
      transition: '转场',
      reference: '参考',
      unused: '不使用',
    };
    const values = items.flatMap((item) => {
      if (typeof item === 'string') return item.trim() ? [item.trim()] : [];
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const role = roleLabels[item.role] || String(item.role || '').trim();
      const reason = String(item.reason || '').trim();
      if (!role && !reason) return [];
      return [role && reason ? `${role}：${reason}` : role || reason];
    });
    return values.length ? values.join('、') : '—';
  }

  function getTextAnalysisAvailability(asset = {}) {
    if (!asset || !Object.keys(asset).length) {
      return { allowed: false, reason: '请先选择素材。' };
    }
    if (asset.availability === 'missing') {
      return { allowed: false, reason: 'missing 素材不能分析。' };
    }
    if (!asset.stableId) {
      return { allowed: false, reason: '素材缺少 stableId，请重新扫描。' };
    }
    if (getAssetTypeCategory(asset) !== 'text') {
      return { allowed: false, reason: '当前阶段只支持文本/SRT 素材。' };
    }
    return { allowed: true, reason: '' };
  }

  function getImageAnalysisAvailability(asset = {}) {
    if (!asset || !Object.keys(asset).length) {
      return { allowed: false, reason: '请先选择素材。' };
    }
    if (asset.availability === 'missing') {
      return { allowed: false, reason: 'missing 素材不能分析。' };
    }
    if (!asset.stableId) {
      return { allowed: false, reason: '素材缺少 stableId，请重新扫描。' };
    }
    if (getAssetTypeCategory(asset) !== 'image') {
      return { allowed: false, reason: '当前阶段只支持图片素材。' };
    }
    return { allowed: true, reason: '' };
  }

  function getAiAnalysisViewData(asset, payload) {
    const record = getAiAnalysisForAsset(payload, asset);
    if (!record) {
      return {
        hasAnalysis: false,
        isStale: false,
        status: 'not_analyzed',
        statusText: '尚未分析',
        summaryText: '—',
        tagsText: '—',
        riskText: '—',
        captionIdeasText: '—',
        suggestedUseText: '—',
        modelText: '—',
        analyzedAtText: '—',
        errorText: '—',
      };
    }

    const fingerprintChanged = Boolean(
      record.sourceFingerprint
      && asset?.fingerprint
      && record.sourceFingerprint !== asset.fingerprint,
    );
    const isStale = record.aiStatus === 'stale' || fingerprintChanged;
    const status = isStale ? 'stale' : record.aiStatus || 'not_analyzed';
    const statusText = {
      not_analyzed: '尚未分析',
      queued: '等待分析',
      running: '分析中',
      done: '已完成',
      failed: '分析失败',
      cancelled: '已取消',
      interrupted: '已中断',
      skipped: '已跳过',
      stale: '素材已变化，建议重新分析',
    }[status] || '尚未分析';

    return {
      hasAnalysis: true,
      isStale,
      status,
      statusText,
      summaryText: String(record.aiSummary || '').trim() || '—',
      tagsText: formatAiList(record.aiTags),
      riskText: formatAiRisk(record.aiRisk),
      captionIdeasText: formatAiList(record.aiCaptionIdeas),
      suggestedUseText: formatAiSuggestedUse(record.aiSuggestedUse),
      modelText: String(record.aiModel || '').trim() || '—',
      analyzedAtText: String(record.aiAnalyzedAt || '').trim() || '—',
      errorText: formatAiError(record.aiError),
    };
  }

  return {
    assetMatchesFilters,
    formatAiList,
    formatAiSuggestedUse,
    getAiAnalysisForAsset,
    getAiAnalysisRecord,
    getAiAnalysisViewData,
    getImageAnalysisAvailability,
    getAssetPreviewType,
    getAssetRatingValue,
    getAssetReviewCategory,
    getAssetTypeCategory,
    getAssetUiKey,
    getTextAnalysisAvailability,
    parseAssetReviewTags,
  };
}));
