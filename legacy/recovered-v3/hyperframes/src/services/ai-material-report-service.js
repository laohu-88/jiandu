const fs = require('node:fs/promises');
const path = require('node:path');

const {
  AI_ANALYSIS_FILE,
  AI_MATERIAL_REPORT_FILE,
  ASSETS_FILE,
} = require('../constants');

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'srt', 'vtt', 'csv', 'json']);
const ROLE_LABELS = {
  opening: '开头',
  process: '过程',
  result: '结果',
  transition: '转场',
  reference: '参考',
  unused: '不使用',
};
const TYPE_LABELS = {
  video: '视频',
  image: '图片',
  audio: '音频',
  text: '文本',
  other: '其他',
};
const REVIEW_LABELS = {
  keep: '保留',
  maybe: '待定',
  reject: '淘汰',
  unreviewed: '未筛选',
};
const RISK_PRIORITY = { high: 0, medium: 1, low: 2, unknown: 3 };
const REVIEW_PRIORITY = { keep: 0, maybe: 1, unreviewed: 2, reject: 3 };

function cleanText(value) {
  return String(value ?? '')
    .replace(/\r?\n|\r|\t/g, ' ')
    .replace(/(^|[\s(（:：])\/(?:[^\s|)）]+\/)*[^\s|),），。；;]*/g, '$1[绝对路径已省略]')
    .replace(/[A-Za-z]:\\(?:[^\s|]+\\)*[^\s|]*/g, '[绝对路径已省略]')
    .replace(/\s+/g, ' ')
    .trim();
}

function tableText(value, fallback = '—') {
  const text = cleanText(value);
  if (!text) return fallback;
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|');
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanText).filter(Boolean);
}

function naturalCompare(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

function getAssetType(asset = {}) {
  if (['video', 'image', 'audio'].includes(asset.type)) return asset.type;
  const ext = String(asset.ext || path.extname(asset.filename || '').slice(1)).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext) || asset.type === 'text') return 'text';
  return 'other';
}

function getAnalyses(aiAnalysis) {
  if (!aiAnalysis || typeof aiAnalysis !== 'object' || Array.isArray(aiAnalysis)) return {};
  const analyses = aiAnalysis.analyses;
  return analyses && typeof analyses === 'object' && !Array.isArray(analyses)
    ? analyses
    : {};
}

function deriveAiStatus(asset, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'not_analyzed';
  const aiStatus = String(record.aiStatus || 'not_analyzed');
  const sourceFingerprint = String(record.sourceFingerprint || '');
  const assetFingerprint = String(asset?.fingerprint || '');
  if (aiStatus === 'stale'
    || (aiStatus === 'done' && sourceFingerprint !== assetFingerprint)
    || (sourceFingerprint && assetFingerprint && sourceFingerprint !== assetFingerprint)) {
    return 'stale';
  }
  return aiStatus;
}

function mergeAssets(assets, aiAnalysis) {
  const list = Array.isArray(assets) ? assets : assets?.assets;
  const analyses = getAnalyses(aiAnalysis);
  return (Array.isArray(list) ? list : []).map((asset) => {
    const record = analyses[asset?.stableId] || null;
    return {
      asset: asset && typeof asset === 'object' ? asset : {},
      record,
      aiStatus: deriveAiStatus(asset, record),
      type: getAssetType(asset),
    };
  });
}

function formatList(value) {
  return tableText(stringList(value).join('、'));
}

function formatRoles(value) {
  if (!Array.isArray(value)) return '—';
  const labels = value.flatMap((item) => {
    if (typeof item === 'string') return cleanText(item) ? [cleanText(item)] : [];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const role = ROLE_LABELS[item.role] || cleanText(item.role);
    return role ? [role] : [];
  });
  return formatList(labels);
}

function formatSuggestedUses(value) {
  if (!Array.isArray(value)) return '—';
  const uses = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const role = ROLE_LABELS[item.role] || cleanText(item.role);
    const reason = cleanText(item.reason);
    if (!role && !reason) return [];
    return [role && reason ? `${role}：${reason}` : role || reason];
  });
  return formatList(uses);
}

function table(headers, rows, emptyText = '暂无符合条件的素材。') {
  if (!rows.length) return [emptyText, ''];
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
  ];
}

function recommendationSort(left, right) {
  const reviewDiff = (REVIEW_PRIORITY[left.asset.reviewStatus] ?? 2)
    - (REVIEW_PRIORITY[right.asset.reviewStatus] ?? 2);
  if (reviewDiff) return reviewDiff;
  const ratingDiff = (Number(right.asset.rating) || 0) - (Number(left.asset.rating) || 0);
  if (ratingDiff) return ratingDiff;
  const doneDiff = Number(right.aiStatus === 'done') - Number(left.aiStatus === 'done');
  return doneDiff || naturalCompare(left.asset.filename, right.asset.filename);
}

function roleSectionSort(left, right) {
  const reviewDiff = (REVIEW_PRIORITY[left.asset.reviewStatus] ?? 2)
    - (REVIEW_PRIORITY[right.asset.reviewStatus] ?? 2);
  if (reviewDiff) return reviewDiff;
  const ratingDiff = (Number(right.asset.rating) || 0) - (Number(left.asset.rating) || 0);
  return ratingDiff || naturalCompare(left.asset.filename, right.asset.filename);
}

function buildRoleSection(items, roles, limit) {
  const rows = items
    .filter((item) => item.aiStatus === 'done' && item.asset.reviewStatus !== 'reject')
    .map((item) => {
      const matchingUses = (item.record?.aiSuggestedUse || [])
        .filter((use) => roles.has(use?.role));
      const reasons = matchingUses
        .map((use) => cleanText(use.reason))
        .filter(Boolean)
        .filter((reason, index, list) => list.indexOf(reason) === index);
      return { item, reasons, hasMatchingUse: matchingUses.length > 0 };
    })
    .filter(({ hasMatchingUse }) => hasMatchingUse)
    .sort((left, right) => roleSectionSort(left.item, right.item))
    .slice(0, limit)
    .map(({ item, reasons }) => [
        tableText(item.asset.filename),
        tableText(item.record.aiSummary),
        tableText(reasons.join('；')),
        tableText(REVIEW_LABELS[item.asset.reviewStatus] || item.asset.reviewStatus || '未筛选'),
        tableText(Number.isInteger(item.asset.rating) ? item.asset.rating : 0),
      ]);
  return table(['文件名', 'AI 摘要', 'reason', '人工状态', '评分'], rows);
}

function manualJudgmentDetails(item) {
  const reasons = [];
  let priority = 99;
  if (item.asset.reviewStatus === 'maybe') {
    reasons.push('人工状态为待定');
    priority = Math.min(priority, 0);
  }
  if (item.aiStatus === 'failed') {
    reasons.push('AI 分析失败');
    priority = Math.min(priority, 1);
  }
  if (item.aiStatus === 'stale') {
    reasons.push('AI 分析已过期');
    priority = Math.min(priority, 2);
  }
  if (item.asset.reviewStatus === 'keep' && item.aiStatus === 'not_analyzed') {
    reasons.push('人工保留但尚未 AI 分析');
    priority = Math.min(priority, 3);
  }
  if (item.asset.reviewStatus === 'unreviewed' && item.aiStatus === 'done') {
    reasons.push('AI 已分析，但尚未人工筛选');
    priority = Math.min(priority, 4);
  }
  return { reasons, priority };
}

function buildAiMaterialReportMarkdown({ assets, aiAnalysis, generatedAt }) {
  const items = mergeAssets(assets, aiAnalysis);
  const available = items.filter((item) => item.asset.availability !== 'missing').length;
  const missing = items.length - available;
  const typeCounts = Object.fromEntries(
    Object.keys(TYPE_LABELS).map((type) => [type, items.filter((item) => item.type === type).length]),
  );
  const reviewCounts = Object.fromEntries(
    Object.keys(REVIEW_LABELS).map((status) => [
      status,
      items.filter((item) => {
        const reviewStatus = Object.hasOwn(REVIEW_LABELS, item.asset.reviewStatus)
          ? item.asset.reviewStatus
          : 'unreviewed';
        return reviewStatus === status;
      }).length,
    ]),
  );
  const aiCount = (status) => items.filter((item) => item.aiStatus === status).length;
  const lines = [
    '# AI素材报告',
    '',
    '## 1. 项目概览',
    '',
    `- 生成时间：${tableText(generatedAt || new Date().toISOString())}`,
    `- 素材总数：${items.length}`,
    `- 可用素材数：${available}`,
    `- missing 素材数：${missing}`,
    `- 类型：视频 ${typeCounts.video} / 图片 ${typeCounts.image} / 音频 ${typeCounts.audio} / 文本 ${typeCounts.text} / 其他 ${typeCounts.other}`,
    `- 人工审核：保留 ${reviewCounts.keep} / 待定 ${reviewCounts.maybe} / 淘汰 ${reviewCounts.reject} / 未筛选 ${reviewCounts.unreviewed}`,
    `- AI 状态：已分析 ${aiCount('done')} / 失败 ${aiCount('failed')} / 过期 stale ${aiCount('stale')} / 未分析 ${aiCount('not_analyzed')}`,
    '',
    '## 2. 推荐优先使用素材',
    '',
  ];

  const recommended = items
    .filter((item) => item.asset.availability !== 'missing'
      && ['keep', 'maybe'].includes(item.asset.reviewStatus))
    .sort(recommendationSort)
    .slice(0, 20)
    .map((item) => [
      tableText(item.asset.filename),
      tableText(TYPE_LABELS[item.type]),
      tableText(Number.isInteger(item.asset.rating) ? item.asset.rating : 0),
      formatList(item.asset.tags),
      formatList(item.record?.aiTags),
      tableText(item.record?.aiSummary),
      formatSuggestedUses(item.record?.aiSuggestedUse),
      tableText(item.asset.note),
    ]);
  lines.push(...table(
    ['文件名', '类型', '评分', '人工标签', 'AI 标签', 'AI 摘要', 'AI 建议用途', '人工备注'],
    recommended,
    '暂无人工保留或待定素材，请先完成粗筛。',
  ));

  lines.push('## 3. 适合开头的素材', '');
  lines.push(...buildRoleSection(items, new Set(['opening']), 10));
  lines.push('## 4. 适合过程展示的素材', '');
  lines.push(...buildRoleSection(items, new Set(['process', 'transition', 'reference']), 20));
  lines.push('## 5. 适合结果展示的素材', '');
  lines.push(...buildRoleSection(items, new Set(['result']), 10));

  lines.push('## 6. 风险提示汇总', '');
  const risks = items
    .filter((item) => item.aiStatus === 'done')
    .filter((item) => ['medium', 'high'].includes(item.record?.aiRisk?.level)
      || stringList(item.record?.aiRisk?.flags).length > 0)
    .sort((left, right) => {
      const riskDiff = (RISK_PRIORITY[left.record?.aiRisk?.level] ?? 3)
        - (RISK_PRIORITY[right.record?.aiRisk?.level] ?? 3);
      return riskDiff || naturalCompare(left.asset.filename, right.asset.filename);
    })
    .map((item) => [
      tableText(item.asset.filename),
      tableText(item.asset.reviewStatus === 'reject'
        ? '已淘汰'
        : REVIEW_LABELS[item.asset.reviewStatus] || item.asset.reviewStatus || '未筛选'),
      tableText(item.record?.aiRisk?.level || 'unknown'),
      formatList(item.record?.aiRisk?.flags),
      tableText(item.record?.aiRisk?.reason),
    ]);
  lines.push(...table(
    ['文件名', '人工状态', '风险等级', 'flags', 'reason'],
    risks,
    '暂无风险提示。',
  ));

  lines.push('## 7. 轻字幕建议汇总', '');
  let remainingCaptions = 20;
  const captions = items
    .filter((item) => item.aiStatus === 'done'
      && ['keep', 'maybe'].includes(item.asset.reviewStatus)
      && stringList(item.record?.aiCaptionIdeas).length)
    .sort(roleSectionSort)
    .flatMap((item) => {
      if (remainingCaptions <= 0) return [];
      const ideas = stringList(item.record.aiCaptionIdeas)
        .slice(0, Math.min(2, remainingCaptions));
      remainingCaptions -= ideas.length;
      return ideas.length
        ? [[tableText(item.asset.filename), formatList(ideas)]]
        : [];
    });
  lines.push(...table(
    ['文件名', '建议字幕列表'],
    captions,
    '暂无已保留/待定素材的轻字幕建议。',
  ));

  lines.push('## 8. 仍需人工判断', '');
  const judgment = items
    .map((item) => ({ item, ...manualJudgmentDetails(item) }))
    .filter(({ reasons }) => reasons.length)
    .sort((left, right) => left.priority - right.priority
      || naturalCompare(left.item.asset.filename, right.item.asset.filename))
    .filter((() => {
      let unreviewedDoneCount = 0;
      return ({ item }) => {
        if (item.asset.reviewStatus !== 'unreviewed' || item.aiStatus !== 'done') return true;
        unreviewedDoneCount += 1;
        return unreviewedDoneCount <= 20;
      };
    })())
    .map(({ item, reasons }) => [
      tableText(item.asset.filename),
      formatList(reasons),
      tableText(REVIEW_LABELS[item.asset.reviewStatus] || item.asset.reviewStatus || '未筛选'),
      tableText(item.aiStatus),
    ]);
  lines.push(...table(['文件名', '原因', '当前人工状态', 'AI 状态'], judgment, '暂无待人工判断项。'));

  lines.push('## 9. 完整素材清单', '');
  const inventory = [...items]
    .sort((left, right) => naturalCompare(left.asset.filename, right.asset.filename))
    .map((item) => [
      tableText(item.asset.filename),
      tableText(TYPE_LABELS[item.type]),
      tableText(item.asset.availability || 'available'),
      tableText(item.asset.reviewStatus || 'unreviewed'),
      tableText(Number.isInteger(item.asset.rating) ? item.asset.rating : 0),
      formatList(item.asset.tags),
      tableText(item.asset.note),
      tableText(item.aiStatus),
      tableText(item.record?.aiSummary),
      tableText(item.record?.aiRisk?.level || 'unknown'),
      formatRoles(item.record?.aiSuggestedUse),
    ]);
  lines.push(...table([
    '文件名', '类型', 'availability', 'reviewStatus', 'rating', 'tags', 'note',
    'aiStatus', 'aiSummary', 'aiRisk.level', 'aiSuggestedUse roles',
  ], inventory, '暂无素材。'));

  return `${lines.join('\n').trimEnd()}\n`;
}

async function writeAiMaterialReport(projectPath, markdown) {
  const reportPath = path.join(projectPath, AI_MATERIAL_REPORT_FILE);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, String(markdown), 'utf8');
  return reportPath;
}

async function readJson(filePath, missingValue) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && missingValue !== undefined) return missingValue;
    throw error;
  }
}

async function generateAiMaterialReport(projectPath) {
  const assetsPath = path.join(projectPath, ASSETS_FILE);
  let assets;
  try {
    assets = await readJson(assetsPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('尚未生成 assets.json，请先扫描精选素材。');
    throw error;
  }
  if (!Array.isArray(assets?.assets)) {
    throw new Error('assets.json 格式无效。');
  }
  const aiAnalysis = await readJson(
    path.join(projectPath, AI_ANALYSIS_FILE),
    { schemaVersion: 1, updatedAt: null, analyses: {} },
  );
  const items = mergeAssets(assets, aiAnalysis);
  const markdown = buildAiMaterialReportMarkdown({
    assets,
    aiAnalysis,
    generatedAt: new Date().toISOString(),
  });
  const reportPath = await writeAiMaterialReport(projectPath, markdown);
  const count = (status) => items.filter((item) => item.aiStatus === status).length;
  return {
    ok: true,
    reportPath,
    summary: {
      totalAssets: items.length,
      analyzed: count('done'),
      failed: count('failed'),
      stale: count('stale'),
      notAnalyzed: count('not_analyzed'),
    },
  };
}

module.exports = {
  buildAiMaterialReportMarkdown,
  deriveAiStatus,
  generateAiMaterialReport,
  writeAiMaterialReport,
};
