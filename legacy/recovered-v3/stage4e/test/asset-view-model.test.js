const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assetMatchesFilters,
  formatAiList,
  formatAiSuggestedUse,
  getAiAnalysisForAsset,
  getAiAnalysisViewData,
  getImageAnalysisAvailability,
  getAssetPreviewType,
  getAssetRatingValue,
  getAssetReviewCategory,
  getAssetTypeCategory,
  getAssetUiKey,
  getTextAnalysisAvailability,
  parseAssetReviewTags,
} = require('../src/renderer/asset-view-model');

const AI_PAYLOAD = {
  schemaVersion: 1,
  updatedAt: '2026-06-30T10:00:00.000Z',
  analyses: {
    asset_ai_1: {
      stableId: 'asset_ai_1',
      sourceFingerprint: 'fingerprint-original',
      aiStatus: 'done',
      aiSummary: '适合用作城市夜景开场。',
      aiTags: ['城市', '夜景'],
      aiRisk: { level: 'medium', flags: ['品牌标识'], reason: '画面存在店铺招牌' },
      aiCaptionIdeas: ['城市亮起', '夜色正浓'],
      aiSuggestedUse: ['开场', '转场'],
      aiModel: 'test-model',
      aiAnalyzedAt: '2026-06-30T09:30:00.000Z',
      aiError: null,
    },
  },
};

test('素材主键按 stableId、relativePath、id、filename 的顺序选择', () => {
  assert.equal(getAssetUiKey({
    stableId: 'stable', relativePath: 'path/file.mov', id: 'A001', filename: 'file.mov',
  }), 'stable');
  assert.equal(getAssetUiKey({ relativePath: 'path/file.mov', id: 'A001', filename: 'file.mov' }), 'path/file.mov');
  assert.equal(getAssetUiKey({ id: 'A001', filename: 'file.mov' }), 'A001');
  assert.equal(getAssetUiKey({ filename: 'file.mov' }), 'file.mov');
});

test('文件名搜索支持中文且忽略英文大小写', () => {
  const asset = { filename: 'A001-上海Night景色.MOV', type: 'video' };
  assert.equal(assetMatchesFilters(asset, { searchQuery: '上海' }), true);
  assert.equal(assetMatchesFilters(asset, { searchQuery: 'night' }), true);
  assert.equal(assetMatchesFilters(asset, { searchQuery: '北京' }), false);
});

test('类型过滤覆盖全部、视频、图片、音频、文本和其他', () => {
  const cases = [
    [{ type: 'video', filename: 'a.mov' }, 'video'],
    [{ type: 'image', filename: 'a.png' }, 'image'],
    [{ type: 'audio', filename: 'a.wav' }, 'audio'],
    [{ type: 'unknown', filename: '字幕.SRT' }, 'text'],
    [{ type: 'unknown', filename: '素材.bin' }, 'other'],
  ];
  for (const [asset, category] of cases) {
    assert.equal(getAssetTypeCategory(asset), category);
    assert.equal(assetMatchesFilters(asset, { typeFilter: 'all' }), true);
    assert.equal(assetMatchesFilters(asset, { typeFilter: category }), true);
  }
  assert.equal(assetMatchesFilters(cases[0][0], { typeFilter: 'image' }), false);
});

test('审核状态过滤覆盖全部、未筛选、保留、待定、淘汰和缺失', () => {
  const cases = [
    [{ reviewStatus: 'unreviewed', availability: 'available' }, 'unreviewed'],
    [{ reviewStatus: 'keep', availability: 'available' }, 'keep'],
    [{ reviewStatus: 'maybe', availability: 'available' }, 'maybe'],
    [{ reviewStatus: 'reject', availability: 'available' }, 'reject'],
    [{ reviewStatus: 'keep', availability: 'missing' }, 'missing'],
  ];
  for (const [asset, category] of cases) {
    assert.equal(getAssetReviewCategory(asset), category);
    assert.equal(assetMatchesFilters(asset, { reviewFilter: 'all' }), true);
    assert.equal(assetMatchesFilters(asset, { reviewFilter: category }), true);
  }
  assert.equal(assetMatchesFilters(cases[1][0], { reviewFilter: 'reject' }), false);
});

test('搜索、类型和审核状态过滤需要同时匹配', () => {
  const asset = {
    filename: '上海夜景.mov', type: 'video', reviewStatus: 'keep', availability: 'available',
  };
  assert.equal(assetMatchesFilters(asset, {
    searchQuery: '上海', typeFilter: 'video', reviewFilter: 'keep',
  }), true);
  assert.equal(assetMatchesFilters(asset, {
    searchQuery: '上海', typeFilter: 'image', reviewFilter: 'keep',
  }), false);
});

test('tags 输入按英文逗号分隔、trim 并去空', () => {
  assert.deepEqual(
    parseAssetReviewTags(' 风景, ,夜景, 旅行 ,'),
    ['风景', '夜景', '旅行'],
  );
  assert.deepEqual(parseAssetReviewTags(''), []);
});

test('预览类型区分视频、图片、音频、文本和不支持类型', () => {
  assert.equal(getAssetPreviewType({ type: 'video' }), 'video');
  assert.equal(getAssetPreviewType({ type: 'image' }), 'image');
  assert.equal(getAssetPreviewType({ type: 'audio' }), 'audio');
  assert.equal(getAssetPreviewType({ filename: '说明.md', type: 'unknown' }), 'text');
  assert.equal(getAssetPreviewType({ filename: '归档.zip', type: 'unknown' }), 'unsupported');
});

test('rating 仅显示 0 到 5 的整数，其他值回退为 0', () => {
  for (let rating = 0; rating <= 5; rating += 1) {
    assert.equal(getAssetRatingValue(rating), rating);
  }
  for (const rating of [-1, 6, 1.5, '5', null, undefined]) {
    assert.equal(getAssetRatingValue(rating), 0);
  }
});

test('view-model 根据 stableId 取得对应 AI 分析记录', () => {
  assert.equal(
    getAiAnalysisForAsset(AI_PAYLOAD, { stableId: 'asset_ai_1' }),
    AI_PAYLOAD.analyses.asset_ai_1,
  );
  assert.equal(getAiAnalysisForAsset(AI_PAYLOAD, { stableId: 'asset_missing' }), null);
});

test('无 AI 分析记录时返回“尚未分析”状态数据', () => {
  assert.deepEqual(getAiAnalysisViewData({ stableId: 'asset_missing' }, AI_PAYLOAD), {
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
  });
});

test('AI 分析 sourceFingerprint 不一致时标记 stale', () => {
  const result = getAiAnalysisViewData({
    stableId: 'asset_ai_1',
    fingerprint: 'fingerprint-current',
  }, AI_PAYLOAD);
  assert.equal(result.isStale, true);
  assert.equal(result.status, 'stale');
  assert.equal(result.statusText, '素材已变化，建议重新分析');
});

test('AI 标签、轻字幕建议和用途建议格式化显示', () => {
  assert.equal(formatAiList([' 城市 ', '', '夜景']), '城市、夜景');
  const result = getAiAnalysisViewData({
    stableId: 'asset_ai_1',
    fingerprint: 'fingerprint-original',
  }, AI_PAYLOAD);
  assert.equal(result.tagsText, '城市、夜景');
  assert.equal(result.captionIdeasText, '城市亮起、夜色正浓');
  assert.equal(result.suggestedUseText, '开场、转场');
  assert.equal(result.riskText, '中风险｜品牌标识｜画面存在店铺招牌');
});

test('结构化用途建议显示角色中文名和原因', () => {
  assert.equal(formatAiSuggestedUse([
    { role: 'opening', reason: '建立主题' },
    { role: 'unused', reason: '内容重复' },
  ]), '开场：建立主题、不使用：内容重复');
});

test('文本分析按钮可用性拒绝未选中、missing 和非文本素材', () => {
  assert.equal(getTextAnalysisAvailability().allowed, false);
  assert.match(getTextAnalysisAvailability({
    stableId: 'asset_missing', filename: 'missing.srt', availability: 'missing',
  }).reason, /missing/);
  assert.match(getTextAnalysisAvailability({
    stableId: 'asset_video', filename: 'clip.mov', type: 'video', availability: 'available',
  }).reason, /只支持文本\/SRT/);
  assert.deepEqual(getTextAnalysisAvailability({
    stableId: 'asset_text', filename: 'notes.md', type: 'unknown', availability: 'available',
  }), { allowed: true, reason: '' });
});

test('图片分析按钮可用性拒绝未选中、missing 和非图片素材', () => {
  assert.equal(getImageAnalysisAvailability().allowed, false);
  assert.match(getImageAnalysisAvailability({
    stableId: 'asset_missing', filename: 'missing.jpg', availability: 'missing',
  }).reason, /missing/);
  assert.match(getImageAnalysisAvailability({
    stableId: 'asset_video', filename: 'clip.mov', type: 'video', availability: 'available',
  }).reason, /只支持图片素材/);
  assert.deepEqual(getImageAnalysisAvailability({
    stableId: 'asset_image', filename: 'photo.heif', type: 'unknown', availability: 'available',
  }), { allowed: true, reason: '' });
});
