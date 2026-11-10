const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractFirstJsonObject,
  parseModelOutput,
} = require('../src/services/ai-analysis-output-parser');

const VALID_OUTPUT = JSON.stringify({
  aiSummary: '画面展示城市夜景。',
  aiTags: ['城市', '夜景'],
  aiRisk: { level: 'low', flags: [], reason: '未发现明显风险' },
  aiCaptionIdeas: ['灯火初上', '夜色正浓'],
  aiSuggestedUse: [{ role: 'opening', reason: '适合建立场景' }],
});

test('共享解析器可解析标准 JSON', () => {
  assert.equal(parseModelOutput(VALID_OUTPUT).aiSummary, '画面展示城市夜景。');
});

test('共享解析器可解析 fenced JSON', () => {
  assert.equal(parseModelOutput(`\n\`\`\`json\n${VALID_OUTPUT}\n\`\`\`\n`).aiTags.length, 2);
});

test('共享解析器从杂文本中提取第一个完整 JSON 对象', () => {
  assert.equal(
    JSON.parse(extractFirstJsonObject(`前文 {"a":{"b":"}"}} 后文 {"c":2}`)).a.b,
    '}',
  );
});

test('共享解析器限制标签、轻字幕和用途建议数量', () => {
  const payload = JSON.parse(VALID_OUTPUT);
  payload.aiTags = Array.from({ length: 20 }, (_, index) => `标签${index}`);
  payload.aiCaptionIdeas = ['一', '二', '三', '四'];
  payload.aiSuggestedUse = Array.from(
    { length: 8 },
    (_, index) => ({ role: 'reference', reason: `用途${index}` }),
  );
  const parsed = parseModelOutput(JSON.stringify(payload));
  assert.equal(parsed.aiTags.length, 12);
  assert.equal(parsed.aiCaptionIdeas.length, 3);
  assert.equal(parsed.aiSuggestedUse.length, 5);
});

test('共享解析器拒绝非 JSON 输出', () => {
  assert.throws(
    () => parseModelOutput('没有 JSON'),
    (error) => error.code === 'INVALID_MODEL_OUTPUT',
  );
});
