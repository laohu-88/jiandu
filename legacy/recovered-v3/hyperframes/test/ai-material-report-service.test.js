const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  AI_ANALYSIS_FILE,
  AI_MATERIAL_REPORT_FILE,
  ASSETS_FILE,
} = require('../src/constants');
const {
  buildAiMaterialReportMarkdown,
  deriveAiStatus,
  generateAiMaterialReport,
  writeAiMaterialReport,
} = require('../src/services/ai-material-report-service');

function asset(stableId, filename, overrides = {}) {
  return {
    stableId,
    filename,
    relativePath: path.join('01-精选素材', filename),
    type: 'unknown',
    ext: path.extname(filename).slice(1),
    availability: 'available',
    fingerprint: `fingerprint-${stableId}`,
    reviewStatus: 'unreviewed',
    rating: 0,
    tags: [],
    note: '',
    ...overrides,
  };
}

function doneRecord(stableId, overrides = {}) {
  return {
    stableId,
    sourceFingerprint: `fingerprint-${stableId}`,
    aiStatus: 'done',
    aiSummary: '',
    aiTags: [],
    aiRisk: { level: 'low', flags: [], reason: '' },
    aiCaptionIdeas: [],
    aiSuggestedUse: [],
    ...overrides,
  };
}

async function makeProject(assets) {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-material-report-'));
  await fs.mkdir(path.join(projectPath, '00-项目总控'), { recursive: true });
  await fs.writeFile(
    path.join(projectPath, ASSETS_FILE),
    `${JSON.stringify({ schemaVersion: 2, assets }, null, 2)}\n`,
    'utf8',
  );
  return projectPath;
}

function reportSection(markdown, currentHeading, nextHeading) {
  return markdown.split(currentHeading)[1].split(nextHeading)[0];
}

test('没有 ai-analysis.json 时仍生成报告，且不创建 AI 分析文件', async () => {
  const projectPath = await makeProject([
    asset('text_1', '说明.srt', { reviewStatus: 'keep', rating: 5 }),
  ]);

  const result = await generateAiMaterialReport(projectPath);
  const markdown = await fs.readFile(path.join(projectPath, AI_MATERIAL_REPORT_FILE), 'utf8');

  assert.equal(result.ok, true);
  assert.equal(result.reportPath, path.join(projectPath, AI_MATERIAL_REPORT_FILE));
  assert.deepEqual(result.summary, {
    totalAssets: 1,
    analyzed: 0,
    failed: 0,
    stale: 0,
    notAnalyzed: 1,
  });
  assert.match(markdown, /# AI素材报告/);
  assert.match(markdown, /AI 状态：已分析 0 \/ 失败 0 \/ 过期 stale 0 \/ 未分析 1/);
  assert.match(markdown, /人工保留但尚未 AI 分析/);
  await assert.rejects(fs.access(path.join(projectPath, AI_ANALYSIS_FILE)), { code: 'ENOENT' });
});

test('报告汇总 done、stale、failed、风险、字幕、用途和人工字段', () => {
  const assets = [
    asset('image_1', 'A2-封面.png', {
      type: 'image', reviewStatus: 'keep', rating: 5,
      tags: ['主画面', '精选'], note: '优先查看\n避免裁切',
    }),
    asset('text_1', 'A10-过程.srt', { reviewStatus: 'maybe', rating: 3 }),
    asset('stale_1', '旧结果.png', { type: 'image', reviewStatus: 'keep', rating: 4 }),
    asset('failed_1', '失败.txt'),
    asset('missing_1', '缺失.mov', { type: 'video', availability: 'missing' }),
  ];
  const aiAnalysis = { analyses: {
    image_1: doneRecord('image_1', {
      aiSummary: '展示完成效果',
      aiTags: ['成品', '特写'],
      aiRisk: { level: 'medium', flags: ['品牌标识'], reason: '画面有商标' },
      aiCaptionIdeas: ['完成啦', '最终效果'],
      aiSuggestedUse: [
        { role: 'opening', reason: '快速建立主题' },
        { role: 'result', reason: '适合展示成品' },
      ],
    }),
    text_1: doneRecord('text_1', {
      aiSummary: '制作步骤说明',
      aiSuggestedUse: [{ role: 'process', reason: '按时间说明过程' }],
    }),
    stale_1: doneRecord('stale_1', { sourceFingerprint: 'old-fingerprint' }),
    failed_1: {
      stableId: 'failed_1',
      sourceFingerprint: 'fingerprint-failed_1',
      aiStatus: 'failed',
    },
  } };

  const markdown = buildAiMaterialReportMarkdown({
    assets: { assets },
    aiAnalysis,
    generatedAt: '2026-07-01T10:00:00.000Z',
  });

  assert.match(markdown, /missing 素材数：1/);
  assert.match(markdown, /视频 1 \/ 图片 2 \/ 音频 0 \/ 文本 2 \/ 其他 0/);
  assert.match(markdown, /展示完成效果/);
  assert.match(markdown, /成品、特写/);
  assert.match(markdown, /开头：快速建立主题/);
  assert.match(markdown, /快速建立主题/);
  assert.match(markdown, /按时间说明过程/);
  assert.match(markdown, /适合展示成品/);
  assert.match(markdown, /medium/);
  assert.match(markdown, /品牌标识/);
  assert.match(markdown, /完成啦、最终效果/);
  assert.match(markdown, /旧结果\.png[^\n]*stale/);
  assert.match(markdown, /失败\.txt[^\n]*AI 分析失败/);
  assert.match(markdown, /主画面、精选/);
  assert.match(markdown, /优先查看 避免裁切/);
  assert.equal(deriveAiStatus(assets[2], aiAnalysis.analyses.stale_1), 'stale');
  assert.equal(deriveAiStatus(assets[0], { aiStatus: 'done' }), 'stale');

  const recommended = markdown.split('## 2. 推荐优先使用素材')[1]
    .split('## 3. 适合开头的素材')[0];
  assert.ok(recommended.indexOf('A2-封面.png') < recommended.indexOf('A10-过程.srt'));
});

test('模型文本按纯文本写入，清理表格换行、HTML 字符和绝对路径', () => {
  const markdown = buildAiMaterialReportMarkdown({
    assets: [asset('safe_1', '安全.txt', { reviewStatus: 'keep' })],
    aiAnalysis: { analyses: {
      safe_1: doneRecord('safe_1', {
        aiSummary: '<script>alert(1)</script>\n读取 /Users/test/private/input.mov | 完成',
        aiCaptionIdeas: ['第一行\n第二行'],
      }),
    } },
    generatedAt: '2026-07-01T10:00:00.000Z',
  });

  assert.doesNotMatch(markdown, /<script>|<\/script>|\/Users\/test/);
  assert.match(markdown, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(markdown, /\[绝对路径已省略\]/);
  assert.match(markdown, /\\\| 完成/);
  assert.match(markdown, /第一行 第二行/);
});

test('收口推荐、用途、字幕和人工判断章节，并保留 reject 风险记录', () => {
  const assets = [
    asset('keep_1', 'A10-保留.png', { reviewStatus: 'keep', rating: 1, type: 'image' }),
    asset('maybe_1', 'A2-待定.png', { reviewStatus: 'maybe', rating: 5, type: 'image' }),
    asset('unreviewed_1', 'A1-未筛选.png', { rating: 5, type: 'image' }),
    asset('reject_1', 'A0-淘汰.png', { reviewStatus: 'reject', rating: 5, type: 'image' }),
  ];
  const sharedUses = [
    { role: 'opening', reason: '建立主题' },
    { role: 'opening', reason: '建立主题' },
    { role: 'process', reason: '展示步骤' },
    { role: 'transition', reason: '衔接画面' },
    { role: 'reference', reason: '展示步骤' },
    { role: 'result', reason: '展示成果' },
  ];
  const aiAnalysis = { analyses: Object.fromEntries(assets.map((item) => [
    item.stableId,
    doneRecord(item.stableId, {
      aiSummary: `${item.filename}摘要`,
      aiRisk: { level: 'medium', flags: ['标识'], reason: '需要记录' },
      aiCaptionIdeas: [`${item.filename}字幕1`, `${item.filename}字幕2`, `${item.filename}字幕3`],
      aiSuggestedUse: sharedUses,
    }),
  ])) };

  const markdown = buildAiMaterialReportMarkdown({ assets, aiAnalysis, generatedAt: 'now' });
  const recommended = reportSection(
    markdown,
    '## 2. 推荐优先使用素材',
    '## 3. 适合开头的素材',
  );
  assert.match(recommended, /A10-保留\.png/);
  assert.match(recommended, /A2-待定\.png/);
  assert.doesNotMatch(recommended, /A1-未筛选\.png|A0-淘汰\.png/);
  assert.ok(recommended.indexOf('A10-保留.png') < recommended.indexOf('A2-待定.png'));

  const opening = reportSection(markdown, '## 3. 适合开头的素材', '## 4. 适合过程展示的素材');
  const process = reportSection(markdown, '## 4. 适合过程展示的素材', '## 5. 适合结果展示的素材');
  const result = reportSection(markdown, '## 5. 适合结果展示的素材', '## 6. 风险提示汇总');
  for (const section of [opening, process, result]) {
    assert.doesNotMatch(section, /A0-淘汰\.png/);
    assert.ok(section.indexOf('A10-保留.png') < section.indexOf('A1-未筛选.png'));
  }
  assert.equal((opening.match(/^\| A10-保留\.png/gm) || []).length, 1);
  assert.equal((process.match(/^\| A10-保留\.png/gm) || []).length, 1);
  assert.equal((result.match(/^\| A10-保留\.png/gm) || []).length, 1);
  assert.match(process, /展示步骤；衔接画面/);

  const risks = reportSection(markdown, '## 6. 风险提示汇总', '## 7. 轻字幕建议汇总');
  assert.match(risks, /A0-淘汰\.png[^\n]*已淘汰/);

  const captions = reportSection(markdown, '## 7. 轻字幕建议汇总', '## 8. 仍需人工判断');
  assert.match(captions, /A10-保留\.png字幕1、A10-保留\.png字幕2/);
  assert.match(captions, /A2-待定\.png字幕1、A2-待定\.png字幕2/);
  assert.doesNotMatch(captions, /字幕3|A1-未筛选\.png|A0-淘汰\.png/);

  const judgment = reportSection(markdown, '## 8. 仍需人工判断', '## 9. 完整素材清单');
  assert.match(judgment, /A1-未筛选\.png[^\n]*AI 已分析，但尚未人工筛选/);

  const inventory = markdown.split('## 9. 完整素材清单')[1];
  for (const item of assets) assert.match(inventory, new RegExp(item.filename.replace('.', '\\.')));
});

test('章节数量上限生效，空推荐和空字幕显示明确提示', () => {
  const curatedAssets = Array.from({ length: 25 }, (_, index) => asset(
    `keep_${index + 1}`,
    `保留-${index + 1}.png`,
    { reviewStatus: 'keep', type: 'image' },
  ));
  const unreviewedAssets = Array.from({ length: 25 }, (_, index) => asset(
    `unreviewed_${index + 1}`,
    `未筛选-${index + 1}.png`,
    { type: 'image' },
  ));
  const assets = [...curatedAssets, ...unreviewedAssets];
  const aiAnalysis = { analyses: Object.fromEntries(assets.map((item) => [
    item.stableId,
    doneRecord(item.stableId, {
      aiCaptionIdeas: [`字幕-${item.stableId}-1`, `字幕-${item.stableId}-2`, `字幕-${item.stableId}-3`],
      aiSuggestedUse: [
        { role: 'opening', reason: '开头' },
        { role: 'process', reason: '过程' },
        { role: 'result', reason: '结果' },
      ],
    }),
  ])) };
  const markdown = buildAiMaterialReportMarkdown({ assets, aiAnalysis, generatedAt: 'now' });

  const recommended = reportSection(markdown, '## 2. 推荐优先使用素材', '## 3. 适合开头的素材');
  const opening = reportSection(markdown, '## 3. 适合开头的素材', '## 4. 适合过程展示的素材');
  const process = reportSection(markdown, '## 4. 适合过程展示的素材', '## 5. 适合结果展示的素材');
  const result = reportSection(markdown, '## 5. 适合结果展示的素材', '## 6. 风险提示汇总');
  const captions = reportSection(markdown, '## 7. 轻字幕建议汇总', '## 8. 仍需人工判断');
  const judgment = reportSection(markdown, '## 8. 仍需人工判断', '## 9. 完整素材清单');
  assert.equal((recommended.match(/^\| 保留-/gm) || []).length, 20);
  assert.equal((opening.match(/^\| 保留-/gm) || []).length, 10);
  assert.equal((process.match(/^\| 保留-/gm) || []).length, 20);
  assert.equal((result.match(/^\| 保留-/gm) || []).length, 10);
  assert.equal((captions.match(/字幕-keep_\d+-[12]/g) || []).length, 20);
  assert.doesNotMatch(captions, /字幕-keep_\d+-3/);
  assert.equal((judgment.match(/^\| 未筛选-/gm) || []).length, 20);

  const emptyMarkdown = buildAiMaterialReportMarkdown({
    assets: [asset('only_unreviewed', '未筛选.png')],
    aiAnalysis: { analyses: {
      only_unreviewed: doneRecord('only_unreviewed', { aiCaptionIdeas: ['不会展示'] }),
    } },
    generatedAt: 'now',
  });
  assert.match(emptyMarkdown, /暂无人工保留或待定素材，请先完成粗筛。/);
  assert.match(emptyMarkdown, /暂无已保留\/待定素材的轻字幕建议。/);
});

test('生成报告只写报告文件，不修改 assets.json 或 ai-analysis.json', async () => {
  const projectPath = await makeProject([
    asset('image_1', '图片.png', { type: 'image', reviewStatus: 'keep', rating: 5 }),
  ]);
  const assetsPath = path.join(projectPath, ASSETS_FILE);
  const aiPath = path.join(projectPath, AI_ANALYSIS_FILE);
  const aiRaw = `${JSON.stringify({
    schemaVersion: 1,
    analyses: { image_1: doneRecord('image_1', { aiSummary: '图片摘要' }) },
  }, null, 2)}\n`;
  await fs.writeFile(aiPath, aiRaw, 'utf8');
  const assetsBefore = await fs.readFile(assetsPath, 'utf8');

  await generateAiMaterialReport(projectPath);

  assert.equal(await fs.readFile(assetsPath, 'utf8'), assetsBefore);
  assert.equal(await fs.readFile(aiPath, 'utf8'), aiRaw);
});

test('writeAiMaterialReport 写入固定报告路径，服务不依赖模型模块', async () => {
  const projectPath = await makeProject([]);
  const reportPath = await writeAiMaterialReport(projectPath, '# 测试\n');
  assert.equal(reportPath, path.join(projectPath, AI_MATERIAL_REPORT_FILE));
  assert.equal(await fs.readFile(reportPath, 'utf8'), '# 测试\n');

  const source = await fs.readFile(
    path.join(__dirname, '../src/services/ai-material-report-service.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /ai-model-router|mlx|analyzeCurrent|execFile|child_process/i);
});
