const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const {
  chapterForRelativePath,
  computeDurationPolicy,
  detectNarrativeStructure,
} = require('../src/services/narrative-structure-service');
const { walkEpisodeFiles } = require('../src/services/pending-media-catalog-service');
const {
  computeChapterSegments,
  validateVideoAnalysis,
} = require('../src/services/video-analysis-schema');
const {
  buildFcpxml,
  validateFcpxmlStructure,
} = require('../src/services/fcpxml-service');

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'narrative-')));
  const setup = path.join(root, 'HotIngest搭建过程');
  const first = path.join(root, 'HotIngest两期成果', '2026-07-20');
  const second = path.join(root, 'HotIngest两期成果', '2026-07-23');
  await Promise.all([
    fs.mkdir(setup, { recursive: true }),
    fs.mkdir(first, { recursive: true }),
    fs.mkdir(second, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(root, '00-本期说明.md'), [
      '# 本期视频说明',
      '## 视频主题',
      '将 HotIngest 的搭建过程与两次正式采集成果合并。',
      '## 建议叙事顺序',
      '1. HotIngest 为什么搭建',
      '2. 搭建和运行过程',
      '3. 第一次正式采集及审核结果',
      '4. 第二次采集或当前阶段成果',
      '## 重要要求',
      '- 保持无口播、轻字幕的记录型视频风格',
    ].join('\n')),
    fs.writeFile(path.join(setup, 'setup.png'), 'image'),
    fs.writeFile(path.join(first, 'first.mp4'), 'video'),
    fs.writeFile(path.join(first, 'first.context.html'), '<p>第一期审核完成</p>'),
    fs.writeFile(path.join(second, 'second.mp4'), 'video'),
  ]);
  const files = await walkEpisodeFiles(root);
  return { root, files };
}

test('一级目录识别为章节，根目录本期说明形成硬顺序并覆盖自然排序', async () => {
  const { root, files } = await fixture();
  const narrative = await detectNarrativeStructure(root, files);
  assert.deepEqual(narrative.chapters.map((item) => item.chapterName), [
    'HotIngest搭建过程',
    'HotIngest两期成果',
  ]);
  assert.deepEqual(narrative.chapters.map((item) => item.chapterId), ['chapter-1', 'chapter-2']);
  assert.equal(narrative.chapters[0].orderSource, 'project-brief');
  assert.deepEqual(narrative.projectBrief.hardConstraints, {
    chapterOrder: ['chapter-1', 'chapter-2'],
    allowChapterInterleave: false,
  });
  assert.deepEqual(narrative.briefFilesUsed, ['00-本期说明.md']);
});

test('二级目录识别为有序子章节，HotIngest sidecar 留给单素材绑定而不是章节上下文', async () => {
  const { root, files } = await fixture();
  const narrative = await detectNarrativeStructure(root, files);
  const results = narrative.chapters[1];
  assert.deepEqual(results.subchapters.map((item) => item.subchapterName), [
    '2026-07-20',
    '2026-07-23',
  ]);
  assert.equal(
    narrative.contextDocuments.some((item) => item.relativePath.endsWith('.context.html')),
    false,
  );
});

test('扁平素材仍保留 relativePath，并获得兼容的默认章节', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'narrative-flat-')));
  await fs.writeFile(path.join(root, 'clip.mp4'), 'video');
  const files = await walkEpisodeFiles(root);
  const narrative = await detectNarrativeStructure(root, files);
  assert.equal(files[0].relativePath, 'clip.mp4');
  assert.equal(narrative.chapters.length, 1);
  assert.equal(narrative.chapters[0].relativePath, '.');
  assert.deepEqual(chapterForRelativePath(narrative.chapters, files[0].relativePath), {
    chapterId: 'chapter-1',
    subchapterId: null,
  });
});

test('无说明文件时仍按数字前缀和自然目录顺序运行', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'narrative-no-brief-')));
  await Promise.all([
    fs.mkdir(path.join(root, '02-成果')),
    fs.mkdir(path.join(root, '01-过程')),
  ]);
  await Promise.all([
    fs.writeFile(path.join(root, '02-成果', 'b.png'), 'b'),
    fs.writeFile(path.join(root, '01-过程', 'a.png'), 'a'),
  ]);
  const files = await walkEpisodeFiles(root);
  const narrative = await detectNarrativeStructure(root, files);
  assert.equal(narrative.projectBrief, null);
  assert.deepEqual(narrative.chapters.map((item) => item.chapterName), ['01-过程', '02-成果']);
});

test('多章节过程加成果采用 75–110 秒策略，单目录继续使用短片策略', () => {
  const multi = computeDurationPolicy([
    { chapterName: '搭建过程' },
    { chapterName: '两期成果' },
  ], { imageCount: 8, videoCount: 13, totalVideoDurationSec: 303 });
  assert.deepEqual([multi.minSec, multi.maxSec], [75, 110]);
  const single = computeDurationPolicy([{ chapterName: '单一演示' }], {
    imageCount: 1, videoCount: 1, totalVideoDurationSec: 20,
  });
  assert.deepEqual([single.minSec, single.maxSec], [15, 60]);
});

function narrativeManifest() {
  return {
    schemaVersion: 2,
    projectBrief: {
      sourceDocuments: ['00-本期说明.md'],
      hardConstraints: {
        chapterOrder: ['chapter-1', 'chapter-2'],
        allowChapterInterleave: false,
      },
    },
    narrative: {
      allowChapterInterleave: false,
      durationPolicy: {
        minSec: 6,
        maxSec: 12,
        source: 'multi-chapter-policy',
        rationale: '测试',
      },
    },
    chapters: [
      {
        chapterId: 'chapter-1', chapterName: '搭建过程', chapterOrder: 1,
        relativePath: '搭建过程', required: true, subchapters: [],
      },
      {
        chapterId: 'chapter-2', chapterName: '两期成果', chapterOrder: 2,
        relativePath: '两期成果', required: true,
        subchapters: [
          {
            subchapterId: 'subchapter-1', subchapterName: '第一期',
            subchapterOrder: 1, relativePath: '两期成果/第一期',
          },
          {
            subchapterId: 'subchapter-2', subchapterName: '第二期',
            subchapterOrder: 2, relativePath: '两期成果/第二期',
          },
        ],
      },
    ],
    items: [
      {
        assetId: 'setup', type: 'image', chapterId: 'chapter-1',
        subchapterId: null, metadata: {},
      },
      {
        assetId: 'first', type: 'image', chapterId: 'chapter-2',
        subchapterId: 'subchapter-1', metadata: {},
      },
      {
        assetId: 'second', type: 'image', chapterId: 'chapter-2',
        subchapterId: 'subchapter-2', metadata: {},
      },
    ],
  };
}

function narrativeAnalysis() {
  const manifest = narrativeManifest();
  const shots = [
    {
      id: 'shot-setup', assetId: 'setup', chapterId: 'chapter-1', subchapterId: null,
      inSec: 0, outSec: 3, durationSec: 3, fitMode: 'contain', audioMode: 'mute',
      purpose: '搭建', confidence: 1, reviewRequired: false,
    },
    {
      id: 'shot-first', assetId: 'first', chapterId: 'chapter-2', subchapterId: 'subchapter-1',
      inSec: 0, outSec: 3, durationSec: 3, fitMode: 'contain', audioMode: 'mute',
      purpose: '第一期', confidence: 1, reviewRequired: false,
    },
    {
      id: 'shot-second', assetId: 'second', chapterId: 'chapter-2', subchapterId: 'subchapter-2',
      inSec: 0, outSec: 3, durationSec: 3, fitMode: 'contain', audioMode: 'mute',
      purpose: '第二期', confidence: 1, reviewRequired: false,
    },
  ];
  return {
    schemaVersion: 1,
    projectBrief: {
      sourceDocuments: ['00-本期说明.md'],
      hardConstraints: manifest.projectBrief.hardConstraints,
    },
    contextDocumentsUsed: [
      { relativePath: '00-本期说明.md', purpose: '确定章节硬顺序' },
    ],
    chapters: manifest.chapters.map((chapter) => ({
      chapterId: chapter.chapterId,
      chapterName: chapter.chapterName,
      chapterOrder: chapter.chapterOrder,
      relativePath: chapter.relativePath,
      subchapters: chapter.subchapters,
      purpose: chapter.chapterName,
    })),
    theme: {
      summary: '搭建到成果', rationale: '真实素材', confidence: 1, folderNameConflict: false,
    },
    titles: {
      candidates: ['搭建到成果', '完整工作流'],
      recommended: '搭建到成果',
      rationale: '匹配内容',
    },
    assets: manifest.items.map((item) => ({
      assetId: item.assetId,
      type: item.type,
      chapterId: item.chapterId,
      subchapterId: item.subchapterId,
      semanticLabels: ['测试'],
      contentSummary: '测试素材',
      suggestedUse: ['测试'],
      status: 'adopt',
      reason: '测试',
      ranges: [],
      confidence: 1,
    })),
    timeline: {
      orientation: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 30,
      durationPolicy: manifest.narrative.durationPolicy,
      chapterSegments: computeChapterSegments(shots),
      shots,
      markers: [],
    },
  };
}

test('chapterId 保留且正确章节/子章节顺序通过 narrative validation', () => {
  const manifest = narrativeManifest();
  const analysis = narrativeAnalysis();
  assert.equal(validateVideoAnalysis(analysis, manifest), analysis);
});

test('章节交叉和子章节逆序都会令 build 前验证失败', () => {
  const manifest = narrativeManifest();
  const analysis = narrativeAnalysis();
  analysis.timeline.shots.push(analysis.timeline.shots.shift());
  analysis.timeline.chapterSegments = computeChapterSegments(analysis.timeline.shots);
  assert.throws(
    () => validateVideoAnalysis(analysis, manifest),
    (error) => error.details.some((message) => /章节交叉/.test(message)),
  );

  const subchapterCross = narrativeAnalysis();
  [subchapterCross.timeline.shots[1], subchapterCross.timeline.shots[2]] = [
    subchapterCross.timeline.shots[2],
    subchapterCross.timeline.shots[1],
  ];
  subchapterCross.timeline.chapterSegments = computeChapterSegments(subchapterCross.timeline.shots);
  assert.throws(
    () => validateVideoAnalysis(subchapterCross, manifest),
    (error) => error.details.some((message) => /子章节交叉/.test(message)),
  );
});

test('多章节时长越界没有明确解释会验证失败', () => {
  const manifest = narrativeManifest();
  const analysis = narrativeAnalysis();
  analysis.timeline.durationPolicy.minSec = 10;
  manifest.narrative.durationPolicy.minSec = 10;
  assert.throws(
    () => validateVideoAnalysis(analysis, manifest),
    (error) => error.details.some((message) => /不在允许范围/.test(message)),
  );
  analysis.timeline.durationException = '真实有效素材不足，已保留完整章节。';
  assert.equal(validateVideoAnalysis(analysis, manifest), analysis);
});

test('FCPXML clip 顺序必须与章节化 analysis 镜头顺序一致', () => {
  const analysis = narrativeAnalysis();
  const mappings = [
    ['setup', '/tmp/setup.png'],
    ['first', '/tmp/first.png'],
    ['second', '/tmp/second.png'],
  ].map(([assetId, projectAbsolutePath], index) => ({
    assetId,
    type: 'image',
    projectFilename: path.basename(projectAbsolutePath),
    projectAbsolutePath,
    projectStableId: `asset-${index}`,
    sourceSha256: String(index + 1).repeat(64),
    metadata: { width: 1920, height: 1080, hasAudio: false },
  }));
  const xml = buildFcpxml({ projectName: '章节项目', analysis, assetMappings: mappings });
  const expected = analysis.timeline.shots.map((shot) => pathToFileURL(
    mappings.find((item) => item.assetId === shot.assetId).projectAbsolutePath,
  ).href);
  assert.equal(validateFcpxmlStructure(xml, { clipMediaUrls: expected }).ok, true);
  const wrong = [...expected].reverse();
  const report = validateFcpxmlStructure(xml, { clipMediaUrls: wrong });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('；'), /镜头素材顺序/);
});

test('交接确认页包含章节预览、说明文件、时长范围和交叉状态', async () => {
  const [html, app] = await Promise.all([
    fs.readFile(path.join(__dirname, '../src/renderer/index.html'), 'utf8'),
    fs.readFile(path.join(__dirname, '../src/renderer/app.js'), 'utf8'),
  ]);
  assert.match(html, /id="handoffNarrativePreview"/);
  assert.match(app, /检测到的章节数/);
  assert.match(app, /使用的本期说明文件/);
  assert.match(app, /预计成片时长范围/);
  assert.match(app, /章节交叉/);
});
