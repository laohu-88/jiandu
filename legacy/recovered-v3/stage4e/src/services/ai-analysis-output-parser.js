const ALLOWED_RISK_LEVELS = new Set(['low', 'medium', 'high', 'unknown']);
const ALLOWED_ROLES = new Set([
  'opening', 'process', 'result', 'transition', 'reference', 'unused',
]);

function createOutputError(message) {
  return Object.assign(new Error(message), {
    code: 'INVALID_MODEL_OUTPUT',
    retryable: true,
  });
}

function extractFirstJsonObject(output) {
  const text = String(output || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '');
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
  }
  throw createOutputError('模型输出不是可解析的 JSON。');
}

function normalizeStringArray(value, limit) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length === limit) break;
  }
  return result;
}

function parseModelOutput(output) {
  let payload;
  try {
    payload = JSON.parse(extractFirstJsonObject(output));
  } catch (error) {
    if (error.code === 'INVALID_MODEL_OUTPUT') throw error;
    throw createOutputError('模型输出的 JSON 格式无效。');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw createOutputError('模型输出的 JSON 结构无效。');
  }
  const risk = payload.aiRisk && typeof payload.aiRisk === 'object'
    && !Array.isArray(payload.aiRisk) ? payload.aiRisk : {};
  const suggestedUse = Array.isArray(payload.aiSuggestedUse)
    ? payload.aiSuggestedUse.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const role = ALLOWED_ROLES.has(item.role) ? item.role : 'reference';
      const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
      return [{ role, reason }];
    }).slice(0, 5)
    : [];
  return {
    aiSummary: typeof payload.aiSummary === 'string' ? payload.aiSummary.trim() : '',
    aiTags: normalizeStringArray(payload.aiTags, 12),
    aiRisk: {
      level: ALLOWED_RISK_LEVELS.has(risk.level) ? risk.level : 'unknown',
      flags: normalizeStringArray(risk.flags, 12),
      reason: typeof risk.reason === 'string' ? risk.reason.trim() : '',
    },
    aiCaptionIdeas: normalizeStringArray(payload.aiCaptionIdeas, 3),
    aiSuggestedUse: suggestedUse,
  };
}

module.exports = {
  extractFirstJsonObject,
  normalizeStringArray,
  parseModelOutput,
};
