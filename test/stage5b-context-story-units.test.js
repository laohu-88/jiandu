const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_ANALYSIS_CONTEXT_TOTAL_CHARS,
  buildAnalysisContextPayload,
  buildStoryUnits,
} = require('../src/services/hotingest-context-service');
const { collectFcpTitles } = require('../src/services/fcpxml-service');
const {
  compareSourceSnapshots,
  snapshotSource,
} = require('../src/services/pending-media-service');
const { validateVideoAnalysis } = require('../src/services/video-analysis-schema');

function visual(assetId, filename, context = {}) {
  return {
    assetId,
    type: path.extname(filename).toLowerCase() === '.mp4' ? 'video' : 'image',
    filename,
    relativePath: filename,
    extension: path.extname(filename).slice(1).toLowerCase(),
    metadata: {},
    context: {
      files: [{ relativePath: `${path.parse(filename).name}.context.html`, type: 'context-html' }],
      fieldSources: {},
      warnings: [],
      tags: [],
      ...context,
    },
  };
}

function evidence(visualText = '画面可见主体', contextText = 'sidecar 提供事件背景') {
  return {
    visualEvidenceUsed: visualText ? [visualText] : [],
    contextEvidenceUsed: contextText ? [contextText] : [],
    inference: ['该素材适合承担当前叙事角色'],
  };
}

function analysisFor(manifest) {
  const units = manifest.storyUnits.map((unit) => ({
    storyUnitId: unit.storyUnitId,
    topic: unit.topic,
    eventKey: unit.eventKey,
    sourceItemKey: unit.sourceItemKey,
    assetIds: unit.assetIds,
    contextSourceFiles: unit.evidence.contextSourceFiles,
    representativeAssetIds: unit.representativeAssetIds,
    supportingAssetIds: [],
    alternateAssetIds: [],
    duplicateAssetIds: unit.assetIds.filter(
      (assetId) => !unit.representativeAssetIds.includes(assetId),
    ),
    unusableAssetIds: [],
    sourcePlatform: unit.sourcePlatform,
    sourceUrl: unit.sourceUrl,
    reliablePublishedAt: unit.reliablePublishedAt,
    chapterId: unit.chapterIds.length === 1 ? unit.chapterIds[0] : null,
    narrativeRole: 'context',
    selectionReason: '代表素材包含该叙事单元最完整、最清晰的可见信息。',
    evidence: evidence(),
    confidence: 0.88,
    conflicts: [],
    warnings: [],
  }));
  const representativeIds = new Set(units.flatMap((unit) => unit.representativeAssetIds));
  const assets = manifest.items.map((item) => ({
    assetId: item.assetId,
    type: item.type,
    semanticLabels: ['事件'],
    contentSummary: '画面显示事件主体。',
    suggestedUse: ['上下文说明'],
    status: representativeIds.has(item.assetId) ? 'adopt' : 'reject',
    reason: representativeIds.has(item.assetId)
      ? '作为代表素材。'
      : '与代表素材画面重复，不进入时间线。',
    ranges: [],
    confidence: 0.88,
    contextUsage: {
      used: true,
      sourceFiles: item.context.files.map((file) => file.relativePath),
      visualEvidence: '画面显示事件主体。',
      contextEvidence: 'sidecar 提供事件标题与背景。',
    },
    storyUnitId: item.storyUnitId,
    narrativeRole: representativeIds.has(item.assetId) ? 'context' : 'supporting',
    selectionReason: representativeIds.has(item.assetId)
      ? '在同一 Story Unit 中作为主要可见证据。'
      : '与代表素材重复，暂不进入时间线。',
    evidence: evidence(),
    conflicts: [],
    warnings: [],
  }));
  const chosen = manifest.items.find((item) => representativeIds.has(item.assetId));
  const lightCaptionPlan = manifest.items
    .filter((item) => representativeIds.has(item.assetId) && item.context?.translation)
    .map((item, index) => ({
      captionId: `cap-context-${index + 1}`,
      assetId: item.assetId,
      text: '补充理解',
      purpose: 'clarify',
      basedOn: 'HotIngest 翻译仅生成轻字幕建议，不自动写 Marker/Title',
      confidence: 0.8,
      reviewRequired: false,
      warnings: [],
    }));
  return {
    schemaVersion: 1,
    theme: {
      summary: '上下文参与的事件叙事',
      rationale: '画面事实和 sidecar 背景分开记录后共同支持剪辑判断。',
      confidence: 0.88,
      folderNameConflict: false,
    },
    titles: {
      candidates: ['上下文参与的事件叙事', '从画面到事件背景'],
      recommended: '上下文参与的事件叙事',
      rationale: '标题与素材语义一致。',
    },
    storyUnits: units,
    assets,
    lightCaptionPlan,
    timeline: {
      shots: [{
        id: 'shot-1',
        assetId: chosen.assetId,
        inSec: 0,
        outSec: 2,
        durationSec: 2,
        fitMode: 'contain',
        audioMode: 'mute',
        purpose: '用代表素材建立事件背景',
        confidence: 0.88,
        reviewRequired: false,
        storyUnitId: chosen.storyUnitId,
        narrativeRole: 'context',
        selectionReason: '只使用该 Story Unit 的代表素材，避免连续重复变体。',
        evidence: evidence(),
      }],
      markers: [],
    },
  };
}

test('同一 HotIngest 编号和平台的多媒体归入同一 Story Unit，并只给一个代表素材', () => {
  const result = buildStoryUnits([
    visual('video', '004_youtube_Event_01.mp4', { platform: 'youtube' }),
    visual('image', '004_youtube_Event_02.jpg', { platform: 'youtube' }),
  ]);
  assert.equal(result.storyUnits.length, 1);
  assert.deepEqual(result.storyUnits[0].assetIds.sort(), ['image', 'video']);
  assert.deepEqual(result.storyUnits[0].representativeAssetIds, ['video']);
  assert.deepEqual(result.storyUnits[0].supportingAssetIds, ['image']);
});

test('相同编号但不同平台不合并，001 与 010 也不串联', () => {
  const crossPlatform = buildStoryUnits([
    visual('a', '001_alpha_A.jpg', { platform: 'alpha' }),
    visual('b', '001_beta_B.jpg', { platform: 'beta' }),
  ]);
  assert.equal(crossPlatform.storyUnits.length, 2);
  const crossNumber = buildStoryUnits([
    visual('one', '001_alpha_A.jpg', { platform: 'alpha' }),
    visual('ten', '010_alpha_B.jpg', { platform: 'alpha' }),
  ]);
  assert.equal(crossNumber.storyUnits.length, 2);
});

test('不同 HotIngest 日期目录的同平台同序号不会误合并', () => {
  const first = visual('first', '001_alpha_A.jpg', { platform: 'alpha' });
  first.relativePath = path.join('2026-07-20', first.filename);
  const second = visual('second', '001_alpha_B.jpg', { platform: 'alpha' });
  second.relativePath = path.join('2026-07-23', second.filename);
  assert.equal(buildStoryUnits([first, second]).storyUnits.length, 2);
});

test('精确 source URL 可稳定归组，稳定来源 item key 的优先级更高', () => {
  const byUrl = buildStoryUnits([
    visual('a', 'A.jpg', { sourceUrl: 'https://example.invalid/post/42' }),
    visual('b', 'B.jpg', { sourceUrl: 'https://example.invalid/post/42' }),
  ]);
  assert.equal(byUrl.storyUnits.length, 1);
  assert.equal(byUrl.storyUnits[0].evidence.groupingBasis, 'exact-source-url');

  const stableKey = buildStoryUnits([
    visual('c', 'C.jpg', {
      platform: 'alpha', sourceItemKey: '42', sourceUrl: 'https://example.invalid/a',
    }),
    visual('d', 'D.jpg', {
      platform: 'alpha', sourceItemKey: '42', sourceUrl: 'https://example.invalid/b',
    }),
  ]);
  assert.equal(stableKey.storyUnits.length, 1);
  assert.equal(stableKey.storyUnits[0].evidence.groupingBasis, 'stable-source-item');
});

test('语义画像保留翻译、来源和字段来源，不伪造视觉摘要', () => {
  const result = buildStoryUnits([visual('translated', '002_lemmy_Event.jpg', {
    title: 'Original event',
    translation: '事件的中文翻译',
    platform: 'lemmy',
    fieldSources: { translation: '002.text.html' },
  })]);
  const profile = result.items[0].semanticProfile;
  assert.equal(profile.translatedSummary, '事件的中文翻译');
  assert.equal(profile.sourcePlatform, 'lemmy');
  assert.deepEqual(profile.contextEvidence.find((item) => item.field === 'translation').sourceFiles, [
    '002.text.html',
  ]);
  assert.equal(Object.hasOwn(profile, 'visualSummary'), false);
});

test('Stage 5B 分析可把真实重复变体标为 duplicate 后仅代表素材入镜', () => {
  const grouped = buildStoryUnits([
    visual('video', '004_youtube_Event_01.mp4', { platform: 'youtube' }),
    visual('image', '004_youtube_Event_02.jpg', { platform: 'youtube' }),
  ]);
  const manifest = { items: grouped.items, storyUnits: grouped.storyUnits };
  const analysis = analysisFor(manifest);
  assert.equal(validateVideoAnalysis(analysis, manifest), analysis);
  assert.deepEqual(analysis.timeline.shots.map((shot) => shot.assetId), ['video']);
  assert.deepEqual(analysis.storyUnits[0].duplicateAssetIds, ['image']);
  assert.equal(analysis.storyUnits[0].narrativeRole, 'context');
  assert.equal(analysis.storyUnits[0].evidence.visualEvidenceUsed.length, 1);
  assert.equal(analysis.storyUnits[0].evidence.contextEvidenceUsed.length, 1);
  assert.equal(analysis.storyUnits[0].evidence.inference.length, 1);
});

test('模型返回不存在 assetId 或把非成员列为 representative 时会被拦截', () => {
  const grouped = buildStoryUnits([visual('real', '001_alpha_A.jpg', { platform: 'alpha' })]);
  const manifest = { items: grouped.items, storyUnits: grouped.storyUnits };
  const analysis = analysisFor(manifest);
  analysis.storyUnits[0].representativeAssetIds = ['missing'];
  assert.throws(
    () => validateVideoAnalysis(analysis, manifest),
    (error) => error.details.some((message) => /missing.*不属于/.test(message)),
  );
});

test('visualEvidence、contextEvidence 和 inference 缺一类就不能通过 Stage 5B 校验', () => {
  const grouped = buildStoryUnits([visual('real', '001_alpha_A.jpg', { platform: 'alpha' })]);
  const manifest = { items: grouped.items, storyUnits: grouped.storyUnits };
  const analysis = analysisFor(manifest);
  delete analysis.timeline.shots[0].evidence.contextEvidenceUsed;
  assert.throws(
    () => validateVideoAnalysis(analysis, manifest),
    (error) => error.details.some((message) => /contextEvidenceUsed/.test(message)),
  );
});

test('上下文与画面冲突时，自动入选必须降置信度并要求复核', () => {
  const grouped = buildStoryUnits([visual('real', '001_alpha_A.jpg', { platform: 'alpha' })]);
  const manifest = { items: grouped.items, storyUnits: grouped.storyUnits };
  const analysis = analysisFor(manifest);
  analysis.assets[0].conflicts = ['标题说 A，但画面明确显示 B。'];
  assert.throws(
    () => validateVideoAnalysis(analysis, manifest),
    (error) => error.details.some((message) => /必须降低 confidence/.test(message)),
  );
  analysis.timeline.shots[0].confidence = 0.55;
  analysis.timeline.shots[0].reviewRequired = true;
  assert.equal(validateVideoAnalysis(analysis, manifest), analysis);
});

test('manifest 已发现的上下文冲突和归组 warning 不能被分析静默丢弃', () => {
  const grouped = buildStoryUnits([visual('real', '001_alpha_A.jpg', { platform: 'alpha' })]);
  grouped.items[0].semanticProfile.conflicts = ['sidecar 字段互相冲突。'];
  grouped.items[0].semanticProfile.warnings = ['sidecar 字段互相冲突。'];
  grouped.storyUnits[0].warnings = ['归组证据需要复核。'];
  const manifest = { items: grouped.items, storyUnits: grouped.storyUnits };
  const analysis = analysisFor(manifest);
  assert.throws(
    () => validateVideoAnalysis(analysis, manifest),
    (error) => error.details.some((message) => /未保留/.test(message)),
  );
  analysis.assets[0].conflicts = ['sidecar 字段互相冲突。'];
  analysis.assets[0].warnings = ['sidecar 字段互相冲突。'];
  analysis.storyUnits[0].warnings = ['归组证据需要复核。'];
  analysis.timeline.shots[0].confidence = 0.55;
  analysis.timeline.shots[0].reviewRequired = true;
  assert.equal(validateVideoAnalysis(analysis, manifest), analysis);
});

test('context 标题和翻译不会自动产生 Marker 或 FCP Title，但必须写入轻字幕建议', () => {
  const grouped = buildStoryUnits([visual('real', '001_alpha_A.jpg', {
    platform: 'alpha',
    title: '应只用于理解',
    translation: '不能自动成为字幕',
  })]);
  const manifest = { items: grouped.items, storyUnits: grouped.storyUnits };
  const analysis = analysisFor(manifest);
  assert.equal(validateVideoAnalysis(analysis, manifest), analysis);
  assert.equal(analysis.lightCaptionPlan.length, 1);
  assert.deepEqual(analysis.timeline.markers, []);
  assert.equal(collectFcpTitles(analysis).length, 0);
});

test('Story Unit 的视觉 assetIds 只来自 manifest，不包含 sidecar 文件', () => {
  const grouped = buildStoryUnits([visual('real', '001_alpha_A.jpg', { platform: 'alpha' })]);
  assert.deepEqual(grouped.storyUnits[0].assetIds, ['real']);
  assert.ok(grouped.items[0].semanticProfile.contextSourceFiles.includes('001_alpha_A.context.html'));
  assert.ok(!grouped.storyUnits[0].assetIds.some((assetId) => /\.html?$|\.json$/i.test(assetId)));
});

test('上下文请求预算限制总文本，超量时裁剪低优先级正文', () => {
  const items = Array.from({ length: 80 }, (_, index) => visual(
    `asset-${index}`,
    `${String(index).padStart(3, '0')}_alpha_A.jpg`,
    { platform: 'alpha', body: '长正文'.repeat(4_000) },
  ));
  const payload = buildAnalysisContextPayload(items);
  assert.ok(payload.budget.usedChars <= MAX_ANALYSIS_CONTEXT_TOTAL_CHARS);
  assert.ok(payload.budget.maximumAssetChars <= payload.budget.maxCharsPerAsset);
  assert.ok(payload.budget.truncatedAssetCount > 0);
  assert.ok(payload.budget.omittedAssetCount > 0);
});

test('.DS_Store 和 AppleDouble 变化不影响源快照，业务文件变化仍会被检测', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stage5b-snapshot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'business.txt'), 'v1', 'utf8');
  const before = await snapshotSource(root);
  await fs.writeFile(path.join(root, '.DS_Store'), 'finder', 'utf8');
  await fs.writeFile(path.join(root, '._business.txt'), 'appledouble', 'utf8');
  const finderOnly = await snapshotSource(root);
  assert.equal(compareSourceSnapshots(before, finderOnly).unchanged, true);
  const legacySnapshotWithFinderMetadata = {
    ...before,
    entries: [...before.entries, {
      relativePath: '.DS_Store',
      sizeBytes: 6,
      mtimeMs: 1,
      sha256: 'legacy-finder-hash',
    }],
  };
  assert.equal(compareSourceSnapshots(legacySnapshotWithFinderMetadata, finderOnly).unchanged, true);
  await fs.writeFile(path.join(root, 'business.txt'), 'v2', 'utf8');
  const changed = compareSourceSnapshots(before, await snapshotSource(root));
  assert.equal(changed.unchanged, false);
  assert.ok(changed.errors.some((message) => /内容已变化/.test(message)));
});
