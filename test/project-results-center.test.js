const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  readCodexProjectResult,
  resolveProjectPath,
} = require('../src/services/codex-project-result-service');
const {
  assertCatalogProject,
  scanProjectCatalog,
} = require('../src/services/project-catalog-service');
const {
  FINAL_CUT_APP_PATH,
  FINAL_CUT_BUNDLE_ID,
  openInFinalCut,
} = require('../src/services/project-action-service');
const { openProject } = require('../src/services/project-service');

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function analysis(shots = 2) {
  const items = Array.from({ length: shots }, (_, index) => ({
    id: `shot-${String(index + 1).padStart(3, '0')}`,
    assetId: `media-${index + 1}`,
    inSec: 0,
    outSec: 2,
    durationSec: 2,
    fitMode: 'contain',
    audioMode: 'mute',
    purpose: `镜头 ${index + 1}`,
    confidence: 0.9,
    reviewRequired: false,
  }));
  return {
    schemaVersion: 1,
    theme: { summary: '结构化主题', rationale: '来自可见素材。', confidence: 0.9, folderNameConflict: false },
    titles: {
      candidates: ['建议标题', '候选标题'],
      recommended: '建议标题',
      rationale: '与素材一致。',
    },
    assets: items.map((shot, index) => ({
      assetId: shot.assetId,
      type: 'image',
      semanticLabels: ['结果'],
      contentSummary: '可见结果',
      suggestedUse: ['时间线'],
      status: index === shots - 1 ? 'candidate' : 'adopt',
      reason: index === shots - 1 ? '可选补充' : '推动叙事',
      ranges: [],
      confidence: 0.9,
    })),
    timeline: {
      orientation: 'horizontal',
      width: 1920,
      height: 1080,
      fps: 30,
      shots: items,
      markers: [{ timeSec: 1, text: '结果' }],
    },
  };
}

async function createFixture(root, name, options = {}) {
  const projectPath = path.join(root, name);
  const control = path.join(projectPath, '00-项目总控');
  const assetsDir = path.join(projectPath, '01-精选素材');
  const exportDir = path.join(projectPath, '03-导出');
  await Promise.all([
    fs.mkdir(control, { recursive: true }),
    fs.mkdir(assetsDir, { recursive: true }),
    fs.mkdir(path.join(exportDir, 'FCPXML'), { recursive: true }),
    fs.mkdir(path.join(exportDir, '粗剪预览'), { recursive: true }),
  ]);
  const base = analysis(options.baseShots || 2);
  const effective = options.hyperframes ? analysis(options.effectiveShots || 3) : null;
  if (options.hyperframes) {
    effective.timeline.shots.at(-1).assetId = 'generated_hyperframes_asset';
    effective.timeline.shots.at(-1).durationSec = 5;
    effective.timeline.shots.at(-1).outSec = 5;
    effective.timeline.markers[0].timeSec = 6;
  }
  const generatedAt = options.generatedAt || '2026-07-19T01:00:00.000Z';
  const mappings = base.timeline.shots.map((shot, index) => ({
    assetId: shot.assetId,
    projectFilename: `asset-${index + 1}.png`,
    projectRelativePath: `01-精选素材/asset-${index + 1}.png`,
    projectStableId: `stable-${index + 1}`,
  }));
  if (options.hyperframes) {
    mappings.push({
      assetId: 'generated_hyperframes_asset',
      origin: 'hyperframes',
      projectFilename: 'flow.mp4',
      projectRelativePath: '01-精选素材/flow.mp4',
      projectStableId: 'stable-hf',
      sourceSha256: 'hf-sha',
      metadata: { durationSec: 5, displayWidth: 1920, displayHeight: 1080, frameRate: 30 },
    });
  }
  await Promise.all(mappings.map((mapping) =>
    fs.writeFile(path.join(projectPath, mapping.projectRelativePath), 'asset')));
  await writeJson(path.join(control, 'project.json'), {
    projectName: name,
    projectPath,
    version: 'v3.1.0-stage1',
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:01.000Z',
  });
  await writeJson(path.join(control, 'assets.json'), {
    assets: mappings.map((mapping) => ({
      stableId: mapping.projectStableId,
      filename: mapping.projectFilename,
      relativePath: mapping.projectRelativePath,
      availability: 'available',
    })),
  });
  await writeJson(path.join(control, 'Codex视频素材清单.json'), {
    items: base.assets.map((item, index) => ({
      assetId: item.assetId,
      filename: `source-${index + 1}.png`,
      type: 'image',
      sha256: `sha-${index + 1}`,
      sizeBytes: index + 10,
      mtimeMs: index + 20,
    })),
    sourceSnapshot: { digest: 'source-digest' },
    warnings: options.manifestWarning ? ['素材清单警告'] : [],
  });
  if (options.corruptAnalysis) {
    await fs.writeFile(path.join(control, 'Codex视频分析.json'), '{bad', 'utf8');
  } else {
    await writeJson(path.join(control, 'Codex视频分析.json'), base);
  }
  const artifacts = {
    fcpxml: '03-导出/FCPXML/timeline.fcpxml',
    preview: '03-导出/粗剪预览/preview.mp4',
  };
  if (options.traversal) artifacts.preview = '../outside.mp4';
  if (options.hyperframes) artifacts.hyperframesMp4 = '01-精选素材/flow.mp4';
  if (!options.missingArtifacts) {
    await fs.writeFile(path.join(exportDir, 'FCPXML', 'timeline.fcpxml'), '<fcpxml/>');
    await fs.writeFile(path.join(exportDir, '粗剪预览', 'preview.mp4'), 'preview');
  }
  await writeJson(path.join(control, 'Codex视频状态.json'), {
    status: options.failed ? 'failed' : 'verified',
    createdAt: '2026-07-19T00:00:00.000Z',
    generatedAt,
    verifiedAt: generatedAt,
    assetMappings: mappings,
    artifacts,
    effectiveAnalysis: effective,
    formats: {
      timeline: { orientation: 'horizontal', width: 1920, height: 1080, fps: 30 },
      preview: { width: 640, height: 360, fps: 30 },
    },
    previewMetadata: { durationSec: options.hyperframes ? 9 : 4, displayWidth: 640, displayHeight: 360, frameRate: 30, hasVideo: true },
    fcpxmlReport: { ok: true, assetCount: mappings.length, clipCount: mappings.length, markerCount: 1 },
    sourceVerification: { unchanged: true, beforeDigest: 'source-digest', afterDigest: 'source-digest', errors: [] },
    verification: { ok: !options.failed, errors: options.failed ? ['构建失败'] : [], warnings: [], xmlSyntax: { ok: true } },
    hyperframes: options.hyperframes ? {
      enabled: true,
      version: '0.7.63',
      kind: 'process-flow',
      sha256: 'hf-sha',
      metadata: { durationSec: 5, displayWidth: 1920, displayHeight: 1080, frameRate: 30 },
      flow: { insertAfterShotId: 'shot-002', reason: '真实流程解释' },
      check: { ok: true },
    } : null,
    error: options.failed ? { message: '构建失败' } : null,
  });
  return projectPath;
}

async function fingerprint(filePath) {
  const [buffer, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
  return {
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

test('项目库不存在、空目录和普通目录均返回可理解空状态', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-catalog-empty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const missing = await scanProjectCatalog(path.join(root, 'missing'));
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.projects, []);
  const empty = await scanProjectCatalog(root);
  assert.equal(empty.exists, true);
  assert.deepEqual(empty.projects, []);
  await fs.mkdir(path.join(root, '普通目录'));
  const ordinary = await scanProjectCatalog(root);
  assert.deepEqual(ordinary.projects, []);
  assert.equal(ordinary.ignoredCount, 1);
});

test('项目扫描分类正常、警告、失败、不完整、旧版和损坏项目且单点异常不阻断', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-catalog-status-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await createFixture(root, '正常项目', { generatedAt: '2026-07-19T06:00:00.000Z' });
  await createFixture(root, '较早项目', { generatedAt: '2026-07-18T06:00:00.000Z' });
  await createFixture(root, '警告项目', { manifestWarning: true });
  await createFixture(root, '失败项目', { failed: true });
  const incomplete = path.join(root, '不完整项目');
  await fs.mkdir(path.join(incomplete, '00-项目总控'), { recursive: true });
  await writeJson(path.join(incomplete, '00-项目总控/project.json'), { projectName: '不完整项目', projectPath: incomplete });
  const legacy = path.join(root, '旧版项目');
  await fs.mkdir(path.join(legacy, '02-配音'), { recursive: true });
  await writeJson(path.join(legacy, '00-项目总控/project.json'), { projectName: '旧版项目', projectPath: legacy });
  await createFixture(root, '损坏分析', { corruptAnalysis: true });
  const corruptProject = await createFixture(root, '损坏项目');
  await fs.writeFile(path.join(corruptProject, '00-项目总控/project.json'), '{broken', 'utf8');

  const catalog = await scanProjectCatalog(root);
  const byName = new Map(catalog.projects.map((item) => [item.projectName, item]));
  assert.equal(byName.get('正常项目').status, 'verified');
  assert.equal(byName.get('警告项目').status, 'warning');
  assert.equal(byName.get('失败项目').status, 'failed');
  assert.equal(byName.get('不完整项目').status, 'incomplete');
  assert.equal(byName.get('旧版项目').status, 'legacy');
  assert.equal(byName.get('损坏分析').status, 'corrupt');
  assert.equal(byName.get('损坏项目').status, 'corrupt');
  assert.ok(
    catalog.projects.findIndex((item) => item.projectName === '正常项目')
      < catalog.projects.findIndex((item) => item.projectName === '较早项目'),
  );
  assert.ok(catalog.errors.length >= 2);
});

test('普通项目使用基础 analysis，HyperFrames 使用 effectiveAnalysis 且规格不混淆', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-result-aggregate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const normalPath = await createFixture(root, '普通项目');
  const hyperPath = await createFixture(root, 'HyperFrames项目', { hyperframes: true });
  const normal = await readCodexProjectResult(normalPath);
  const hyper = await readCodexProjectResult(hyperPath);
  assert.equal(normal.timeline.shotCount, 2);
  assert.equal(normal.timeline.totalDurationSec, 4);
  assert.equal(hyper.timeline.shotCount, 3);
  assert.equal(hyper.timeline.totalDurationSec, 9);
  assert.equal(hyper.timeline.shots.at(-1).hyperframes, true);
  assert.deepEqual(hyper.formats.timeline, { orientation: 'horizontal', width: 1920, height: 1080, fps: 30 });
  assert.deepEqual(hyper.formats.preview, { width: 640, height: 360, fps: 30 });
  assert.equal(hyper.summary.recommendedTitle, '建议标题');
  assert.equal(hyper.decisions.adopt.length, 1);
  assert.equal(hyper.decisions.candidate.length, 1);
  assert.equal(hyper.hyperframes.version, '0.7.63');
  assert.equal(hyper.hyperframes.kind, 'process-flow');
  assert.equal(hyper.hyperframes.insertAfterShotId, 'shot-002');
  assert.equal(hyper.hyperframes.file.exists, true);
  assert.equal(normal.subtitles.source, 'analysis');
  assert.equal(normal.subtitles.items[0].durationSec, null);
  assert.equal(hyper.subtitles.source, 'effectiveAnalysis');
  assert.equal(hyper.subtitles.items[0].timeSec, 6);
  assert.equal(hyper.subtitles.items[0].timeAdjustedByHyperframes, true);
});

test('缺少可选产物降级展示，项目路径穿越和非项目路径被拒绝', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-result-security-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const missing = await createFixture(root, '缺少产物', { missingArtifacts: true });
  const result = await readCodexProjectResult(missing);
  assert.equal(result.artifacts.preview.exists, false);
  await assert.rejects(resolveProjectPath(missing, '../secret'), { code: 'UNSAFE_PROJECT_PATH' });
  const traversal = await createFixture(root, '路径穿越', { traversal: true });
  await assert.rejects(readCodexProjectResult(traversal), { code: 'UNSAFE_PROJECT_PATH' });
  await assert.rejects(assertCatalogProject(root, path.join(root, 'not-project')), {
    code: 'NOT_A_VIDEO_PROJECT',
  });
  await assert.rejects(assertCatalogProject(root, path.dirname(root)), {
    code: 'PROJECT_OUTSIDE_CATALOG',
  });
});

test('打开、扫描、读取和切换项目保持核心项目文件哈希与 mtime 不变，损坏 project.json 不被覆盖', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-result-readonly-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await createFixture(root, '项目一');
  const second = await createFixture(root, '项目二');
  const files = [
    '00-项目总控/project.json',
    '00-项目总控/assets.json',
    '00-项目总控/Codex视频分析.json',
    '00-项目总控/Codex视频状态.json',
    '00-项目总控/Codex视频素材清单.json',
    '03-导出/FCPXML/timeline.fcpxml',
    '03-导出/粗剪预览/preview.mp4',
  ].map((relative) => path.join(first, relative));
  const before = await Promise.all(files.map(fingerprint));
  await openProject(first);
  await scanProjectCatalog(root);
  await readCodexProjectResult(first);
  await readCodexProjectResult(second);
  const after = await Promise.all(files.map(fingerprint));
  assert.deepEqual(after, before);

  const corruptPath = path.join(root, '损坏只读项目');
  await fs.mkdir(path.join(corruptPath, '00-项目总控'), { recursive: true });
  const projectFile = path.join(corruptPath, '00-项目总控/project.json');
  await fs.writeFile(projectFile, '{broken-json', 'utf8');
  const corruptBefore = await fingerprint(projectFile);
  await assert.rejects(openProject(corruptPath), { code: 'PROJECT_JSON_CORRUPT' });
  assert.deepEqual(await fingerprint(projectFile), corruptBefore);
});

test('Final Cut Pro 优先 Bundle ID 并使用参数数组，失败后回退实际应用路径', async () => {
  const calls = [];
  const first = await openInFinalCut('/tmp/test.fcpxml', {
    execFileImpl: async (command, args) => calls.push({ command, args }),
  });
  assert.equal(first.strategy, 'bundle-id');
  assert.deepEqual(calls[0], {
    command: '/usr/bin/open',
    args: ['-b', FINAL_CUT_BUNDLE_ID, '/tmp/test.fcpxml'],
  });

  let count = 0;
  const fallbackCalls = [];
  const fallback = await openInFinalCut('/tmp/test.fcpxml', {
    execFileImpl: async (command, args) => {
      fallbackCalls.push({ command, args });
      count += 1;
      if (count === 1) throw new Error('bundle unavailable');
    },
  });
  assert.equal(fallback.strategy, 'application-path');
  assert.deepEqual(fallbackCalls[1].args, ['-a', FINAL_CUT_APP_PATH, '/tmp/test.fcpxml']);
  assert.equal(FINAL_CUT_BUNDLE_ID, 'com.apple.FinalCutApp');
});

test('preload 不暴露文件系统、任意 shell 命令或任意绝对路径打开 API', async () => {
  const preloadRoot = path.join(__dirname, '../src/preload');
  const preloadFiles = await fs.readdir(preloadRoot);
  const preload = [
    await fs.readFile(path.join(__dirname, '../src/preload.js'), 'utf8'),
    ...(await Promise.all(
      preloadFiles
        .filter((name) => name.endsWith('.js'))
        .map((name) => fs.readFile(path.join(preloadRoot, name), 'utf8')),
    )),
  ].join('\n');
  assert.doesNotMatch(preload, /node:fs|child_process|execFile|spawn/);
  assert.doesNotMatch(preload, /openFolder:\s*\(folderPath\)/);
  assert.doesNotMatch(preload, /showItemInFolder:\s*\(itemPath\)/);
  assert.match(preload, /runProjectArtifactAction/);
  assert.match(preload, /openProjectFcpxmlInFinalCut/);
});

test('Electron 结果中心提供 Marker 列表、seek、高亮、字幕叠加与只读时间线且不暴露写项目操作', async () => {
  const [playback, explanation, stylesIndex, stylesPlayback] = await Promise.all([
    fs.readFile(path.join(__dirname, '../src/renderer/modules/workspace/result-playback.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '../src/renderer/explanation-review-ui.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '../src/renderer/styles/index.css'), 'utf8'),
    fs.readFile(path.join(__dirname, '../src/renderer/styles/pages/results-playback.css'), 'utf8'),
  ]);
  const renderer = `${playback}\n${explanation}`;
  const styles = `${stylesIndex}\n${stylesPlayback}`;
  assert.match(renderer, /轻字幕建议/);
  assert.match(renderer, /跳到此处/);
  assert.match(renderer, /预览字幕/);
  assert.match(renderer, /关闭预览/);
  assert.match(renderer, /video\.currentTime\s*=/);
  assert.match(renderer, /loadedmetadata.*timeupdate.*seeked.*ended/s);
  assert.match(renderer, /activeMarkerKey/);
  assert.match(renderer, /currentTimelineShot/);
  assert.match(renderer, /readonly-timeline/);
  assert.match(renderer, /不会烧录进粗剪视频/);
  assert.match(styles, /\.result-subtitle-overlay/);
  assert.match(styles, /\.readonly-playhead/);
  assert.doesNotMatch(renderer, /save.*Marker|update.*Marker|write.*Marker/i);
});
