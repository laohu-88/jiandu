const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { AI_ANALYSIS_FILE } = require('../constants');

const AI_ANALYSIS_SCHEMA_VERSION = 1;
const AI_STATUSES = new Set([
  'not_analyzed',
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
  'interrupted',
  'skipped',
  'stale',
]);
const AI_RECORD_FIELDS = new Set([
  'stableId',
  'sourceFingerprint',
  'sourceType',
  'aiStatus',
  'aiSummary',
  'aiTags',
  'aiRisk',
  'aiCaptionIdeas',
  'aiSuggestedUse',
  'aiModel',
  'aiAnalyzedAt',
  'aiError',
  'promptVersion',
  'preprocessVersion',
  'attempt',
  'queuedAt',
  'startedAt',
]);

function emptyAiAnalysis() {
  return {
    schemaVersion: AI_ANALYSIS_SCHEMA_VERSION,
    updatedAt: null,
    analyses: {},
  };
}

function stringOrDefault(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function nullableString(value) {
  return typeof value === 'string' ? value : null;
}

function normalizeStringList(value, limit) {
  if (!Array.isArray(value)) return [];

  const normalized = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
    if (normalized.length === limit) break;
  }
  return normalized;
}

function redactSensitivePaths(message) {
  return stringOrDefault(message)
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:'"<>|]+[\\/])*[^\s:'"<>|]*/g, '[redacted-path]');
}

function normalizeAiError(error) {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  return {
    code: stringOrDefault(error.code),
    message: redactSensitivePaths(error.message),
    retryable: error.retryable === true,
    occurredAt: nullableString(error.occurredAt),
  };
}

function normalizeAiRisk(risk) {
  const value = risk && typeof risk === 'object' && !Array.isArray(risk) ? risk : {};
  return {
    level: stringOrDefault(value.level, 'unknown'),
    flags: normalizeStringList(value.flags, 12),
    reason: stringOrDefault(value.reason),
  };
}

function normalizeSuggestedUse(value, limit = 5) {
  if (!Array.isArray(value)) return [];
  const allowedRoles = new Set([
    'opening', 'process', 'result', 'transition', 'reference', 'unused',
  ]);
  const normalized = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const reason = item.trim();
      if (reason) normalized.push({ role: 'reference', reason });
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      normalized.push({
        role: allowedRoles.has(item.role) ? item.role : 'reference',
        reason: stringOrDefault(item.reason).trim(),
      });
    }
    if (normalized.length === limit) break;
  }
  return normalized;
}

function normalizeAiAnalysisRecord(record = {}) {
  const value = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  return {
    stableId: stringOrDefault(value.stableId),
    sourceFingerprint: stringOrDefault(value.sourceFingerprint),
    sourceType: stringOrDefault(value.sourceType, 'unknown'),
    aiStatus: AI_STATUSES.has(value.aiStatus) ? value.aiStatus : 'not_analyzed',
    aiSummary: stringOrDefault(value.aiSummary),
    aiTags: normalizeStringList(value.aiTags, 12),
    aiRisk: normalizeAiRisk(value.aiRisk),
    aiCaptionIdeas: normalizeStringList(value.aiCaptionIdeas, 3),
    aiSuggestedUse: normalizeSuggestedUse(value.aiSuggestedUse, 5),
    aiModel: nullableString(value.aiModel),
    aiAnalyzedAt: nullableString(value.aiAnalyzedAt),
    aiError: normalizeAiError(value.aiError),
    promptVersion: stringOrDefault(value.promptVersion, 'asset-analysis-v1'),
    preprocessVersion: stringOrDefault(value.preprocessVersion, 'media-input-v1'),
    attempt: Number.isInteger(value.attempt) && value.attempt >= 0 ? value.attempt : 0,
    queuedAt: nullableString(value.queuedAt),
    startedAt: nullableString(value.startedAt),
  };
}

function validateStableId(stableId) {
  if (typeof stableId !== 'string' || !stableId.trim()) {
    throw new Error('stableId 必须是非空字符串。');
  }
  return stableId;
}

function normalizeAnalyses(analyses, { rejectMismatchedStableId = false } = {}) {
  if (!analyses || typeof analyses !== 'object' || Array.isArray(analyses)) return {};

  const normalized = {};
  for (const [stableId, record] of Object.entries(analyses)) {
    validateStableId(stableId);
    if (rejectMismatchedStableId
      && record?.stableId != null
      && record.stableId !== stableId) {
      throw new Error(`分析记录 ${stableId} 的 stableId 不一致。`);
    }
    normalized[stableId] = normalizeAiAnalysisRecord({ ...record, stableId });
  }
  return normalized;
}

async function loadAiAnalysis(projectPath) {
  const filePath = path.join(projectPath, AI_ANALYSIS_FILE);
  try {
    const payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return {
      schemaVersion: AI_ANALYSIS_SCHEMA_VERSION,
      updatedAt: nullableString(payload?.updatedAt),
      analyses: normalizeAnalyses(payload?.analyses),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyAiAnalysis();
    throw error;
  }
}

async function saveAiAnalysis(projectPath, data) {
  const filePath = path.join(projectPath, AI_ANALYSIS_FILE);
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const payload = {
    schemaVersion: AI_ANALYSIS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    analyses: normalizeAnalyses(data?.analyses, { rejectMismatchedStableId: true }),
  };

  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
  return payload;
}

async function getAiAnalysis(projectPath, stableId) {
  const id = validateStableId(stableId);
  const payload = await loadAiAnalysis(projectPath);
  return payload.analyses[id] || null;
}

function validateAiPatch(patch, stableId) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('AI 分析更新内容必须是对象。');
  }
  const unsupported = Object.keys(patch).filter((field) => !AI_RECORD_FIELDS.has(field));
  if (unsupported.length > 0) {
    throw new Error(`AI 分析更新包含不允许修改的字段：${unsupported.join('、')}。`);
  }
  if (Object.hasOwn(patch, 'stableId') && patch.stableId !== stableId) {
    throw new Error('patch.stableId 必须与目标 stableId 一致。');
  }
}

async function updateAiAnalysis(projectPath, stableId, patch) {
  const id = validateStableId(stableId);
  validateAiPatch(patch, id);

  const payload = await loadAiAnalysis(projectPath);
  const current = payload.analyses[id] || {};
  const updated = normalizeAiAnalysisRecord({
    ...current,
    ...patch,
    stableId: id,
  });
  await saveAiAnalysis(projectPath, {
    analyses: {
      ...payload.analyses,
      [id]: updated,
    },
  });
  return updated;
}

module.exports = {
  AI_ANALYSIS_SCHEMA_VERSION,
  AI_STATUSES,
  emptyAiAnalysis,
  loadAiAnalysis,
  saveAiAnalysis,
  getAiAnalysis,
  updateAiAnalysis,
  normalizeAiAnalysisRecord,
};
