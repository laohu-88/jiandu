const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { AI_ANALYSIS_FILE, ASSETS_FILE } = require('../src/constants');
const {
  loadAiAnalysis,
  saveAiAnalysis,
  getAiAnalysis,
  updateAiAnalysis,
  normalizeAiAnalysisRecord,
} = require('../src/services/ai-analysis-store');

async function makeProject() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-analysis-store-'));
  await fs.mkdir(path.join(projectPath, '00-项目总控'), { recursive: true });
  return projectPath;
}

test('ai-analysis.json 不存在时返回空结构且不创建文件', async () => {
  const projectPath = await makeProject();
  assert.deepEqual(await loadAiAnalysis(projectPath), {
    schemaVersion: 1,
    updatedAt: null,
    analyses: {},
  });
  await assert.rejects(fs.access(path.join(projectPath, AI_ANALYSIS_FILE)), { code: 'ENOENT' });
});

test('saveAiAnalysis 创建 ai-analysis.json 并更新 updatedAt', async () => {
  const projectPath = await makeProject();
  const saved = await saveAiAnalysis(projectPath, { analyses: {} });
  const written = JSON.parse(
    await fs.readFile(path.join(projectPath, AI_ANALYSIS_FILE), 'utf8'),
  );
  assert.equal(saved.schemaVersion, 1);
  assert.equal(typeof saved.updatedAt, 'string');
  assert.deepEqual(written, saved);
});

test('updateAiAnalysis 新增记录，getAiAnalysis 可按 stableId 读取', async () => {
  const projectPath = await makeProject();
  const updated = await updateAiAnalysis(projectPath, 'asset_new', {
    sourceFingerprint: 'fingerprint-1',
    sourceType: 'video',
    aiStatus: 'done',
    aiSummary: '城市夜景',
  });
  assert.equal(updated.stableId, 'asset_new');
  assert.equal(updated.aiStatus, 'done');
  assert.deepEqual(await getAiAnalysis(projectPath, 'asset_new'), updated);
  assert.equal(await getAiAnalysis(projectPath, 'asset_missing'), null);
});

test('updateAiAnalysis 不影响 assets.json', async () => {
  const projectPath = await makeProject();
  const assetsPath = path.join(projectPath, ASSETS_FILE);
  const original = '{"assets":[{"stableId":"asset_1","reviewStatus":"keep"}]}\n';
  await fs.writeFile(assetsPath, original, 'utf8');
  await updateAiAnalysis(projectPath, 'asset_1', { aiStatus: 'queued' });
  assert.equal(await fs.readFile(assetsPath, 'utf8'), original);
});

test('aiTags 去空、去重并限制最多 12 个', () => {
  const aiTags = [
    ' 风景 ', '', '夜景', '风景', '  ',
    ...Array.from({ length: 20 }, (_, index) => `标签${index}`),
  ];
  const normalized = normalizeAiAnalysisRecord({ aiTags });
  assert.equal(normalized.aiTags.length, 12);
  assert.deepEqual(normalized.aiTags.slice(0, 2), ['风景', '夜景']);
  assert.equal(new Set(normalized.aiTags).size, normalized.aiTags.length);
});

test('aiCaptionIdeas 最多保留 3 条', () => {
  const normalized = normalizeAiAnalysisRecord({
    aiCaptionIdeas: [' 第一条 ', '', '第二条', '第三条', '第四条'],
  });
  assert.deepEqual(normalized.aiCaptionIdeas, ['第一条', '第二条', '第三条']);
});

test('aiSuggestedUse 保留结构化 role/reason 并限制最多 5 条', () => {
  const normalized = normalizeAiAnalysisRecord({
    aiSuggestedUse: [
      { role: 'opening', reason: '建立主题' },
      { role: 'invalid', reason: '回退参考' },
      ...Array.from({ length: 8 }, () => ({ role: 'unused', reason: '' })),
    ],
  });
  assert.equal(normalized.aiSuggestedUse.length, 5);
  assert.deepEqual(normalized.aiSuggestedUse.slice(0, 2), [
    { role: 'opening', reason: '建立主题' },
    { role: 'reference', reason: '回退参考' },
  ]);
});

test('非法 aiStatus 明确规范化为 not_analyzed', () => {
  assert.equal(normalizeAiAnalysisRecord({ aiStatus: 'unknown-status' }).aiStatus, 'not_analyzed');
  assert.equal(normalizeAiAnalysisRecord({ aiStatus: 'running' }).aiStatus, 'running');
});

test('aiError 仅保留白名单字段，不保存 stack 和敏感路径', async () => {
  const projectPath = await makeProject();
  const updated = await updateAiAnalysis(projectPath, 'asset_error', {
    aiError: {
      code: 'MODEL_ERROR',
      message: '读取 /Users/example/secret/input.mov 失败',
      retryable: true,
      occurredAt: '2026-06-30T10:00:00.000Z',
      stack: 'Error at /Users/example/project/service.js:12',
      sourcePath: '/Users/example/secret/input.mov',
    },
  });
  assert.deepEqual(Object.keys(updated.aiError), [
    'code', 'message', 'retryable', 'occurredAt',
  ]);
  assert.equal(Object.hasOwn(updated.aiError, 'stack'), false);
  assert.equal(Object.hasOwn(updated.aiError, 'sourcePath'), false);
  assert.doesNotMatch(updated.aiError.message, /\/Users\/example/);

  const raw = await fs.readFile(path.join(projectPath, AI_ANALYSIS_FILE), 'utf8');
  assert.doesNotMatch(raw, /service\.js|\/Users\/example/);
});

test('stableId 不一致时拒绝，且不允许更新顶层结构或人工审核字段', async () => {
  const projectPath = await makeProject();
  await assert.rejects(
    () => updateAiAnalysis(projectPath, 'asset_1', { stableId: 'asset_2' }),
    /stableId.*一致/,
  );
  await assert.rejects(
    () => updateAiAnalysis(projectPath, 'asset_1', { analyses: {} }),
    /不允许修改的字段/,
  );
  await assert.rejects(
    () => updateAiAnalysis(projectPath, 'asset_1', { reviewStatus: 'keep' }),
    /不允许修改的字段/,
  );
});

test('原子写入完成后不残留临时文件', async () => {
  const projectPath = await makeProject();
  await saveAiAnalysis(projectPath, {
    analyses: { asset_1: { stableId: 'asset_1', aiStatus: 'done' } },
  });
  const entries = await fs.readdir(path.join(projectPath, '00-项目总控'));
  assert.deepEqual(entries, ['ai-analysis.json']);
});

test('normalizeAiAnalysisRecord 补齐 schema 默认字段', () => {
  assert.deepEqual(normalizeAiAnalysisRecord({ stableId: 'asset_1' }), {
    stableId: 'asset_1',
    sourceFingerprint: '',
    sourceType: 'unknown',
    aiStatus: 'not_analyzed',
    aiSummary: '',
    aiTags: [],
    aiRisk: { level: 'unknown', flags: [], reason: '' },
    aiCaptionIdeas: [],
    aiSuggestedUse: [],
    aiModel: null,
    aiAnalyzedAt: null,
    aiError: null,
    promptVersion: 'asset-analysis-v1',
    preprocessVersion: 'media-input-v1',
    attempt: 0,
    queuedAt: null,
    startedAt: null,
  });
});
