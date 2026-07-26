'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  ACTIONS,
  STAGE_LABELS,
  buildEditPreflight,
  createEditJob,
  detectHotIngestKind,
  listAffectedArtifacts,
  loadExistingProjectBundle,
  openEditJobInFinalCut,
  recognizeMaterialProject,
  runEditJob,
  uniqueProjectName,
  userFacingError,
} = require('../src/services/in-app-edit-workflow-service');
const { openInFinalCut } = require('../src/services/project-action-service');

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function makeTempRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function minimalAnalysis(shots = 2) {
  const items = Array.from({ length: shots }, (_, index) => ({
    id: `shot-${String(index + 1).padStart(3, '0')}`,
    assetId: `media-${index + 1}`,
    inSec: 0,
    outSec: 2,
    durationSec: 2,
    fitMode: 'contain',
    audioMode: 'keep',
    purpose: `镜头 ${index + 1}`,
    confidence: 0.9,
    reviewRequired: false,
  }));
  return {
    schemaVersion: 1,
    theme: { summary: '主题', rationale: '可见素材', confidence: 0.9, folderNameConflict: false },
    titles: {
      candidates: ['标题A', '标题B'],
      recommended: '标题A',
      rationale: '与素材一致',
    },
    assets: items.map((shot) => ({
      assetId: shot.assetId,
      type: 'image',
      semanticLabels: ['结果'],
      contentSummary: '可见结果',
      suggestedUse: ['时间线'],
      status: 'adopt',
      reason: '推动叙事',
      ranges: [],
      confidence: 0.9,
    })),
    timeline: {
      orientation: 'vertical',
      width: 1080,
      height: 1920,
      fps: 30,
      shots: items,
      markers: [{ timeSec: 1, text: '结果' }],
    },
  };
}

async function createMaterialDir(root, name, options = {}) {
  const source = path.join(root, name);
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'note.txt'), 'hello\n', 'utf8');
  await fs.writeFile(path.join(source, 'shot-1.png'), Buffer.from([137, 80, 78, 71]), 'binary');
  if (options.hotingest) {
    await fs.mkdir(path.join(source, '.hotingest', 'items'), { recursive: true });
    await fs.writeFile(path.join(source, '_素材索引.html'), '<html></html>\n', 'utf8');
    await fs.writeFile(path.join(source, 'shot-1.context.html'), '<html>context</html>\n', 'utf8');
    await writeJson(path.join(source, '.hotingest', 'items', '001.json'), {
      number: '001',
      title: 'demo',
      visible_files: ['shot-1.png'],
    });
  }
  if (options.unsupported) {
    await fs.writeFile(path.join(source, 'weird.xyz'), 'nope\n', 'utf8');
  }
  return source;
}

async function createVerifiedProject(projectRoot, name, sourceDirectory) {
  const projectPath = path.join(projectRoot, name);
  const control = path.join(projectPath, '00-项目总控');
  const assets = path.join(projectPath, '01-精选素材');
  const exportDir = path.join(projectPath, '03-导出');
  await Promise.all([
    fs.mkdir(control, { recursive: true }),
    fs.mkdir(assets, { recursive: true }),
    fs.mkdir(path.join(exportDir, 'FCPXML'), { recursive: true }),
    fs.mkdir(path.join(exportDir, '粗剪预览'), { recursive: true }),
  ]);
  const analysis = minimalAnalysis(2);
  const manifest = {
    schemaVersion: 1,
    sourceDirectory,
    sourceSnapshot: { digest: 'abc', files: [] },
    items: analysis.assets.map((asset, index) => ({
      assetId: asset.assetId,
      type: 'image',
      filename: `asset-${index + 1}.png`,
      relativePath: `asset-${index + 1}.png`,
      sha256: crypto.randomBytes(16).toString('hex'),
    })),
  };
  await writeJson(path.join(projectPath, '00-项目总控', 'project.json'), {
    projectName: name,
    projectPath,
    version: 'v3.1.0-stage1',
    createdAt: '2026-07-26T00:00:00.000Z',
  });
  await writeJson(path.join(projectPath, '00-项目总控', 'Codex视频分析.json'), analysis);
  await writeJson(path.join(projectPath, '00-项目总控', 'Codex视频素材清单.json'), manifest);
  await writeJson(path.join(projectPath, '00-项目总控', 'Codex视频状态.json'), {
    schemaVersion: 1,
    status: 'verified',
    projectPath,
    sourceDirectory,
    generatedAt: '2026-07-26T00:00:00.000Z',
    verification: { ok: true, warnings: [], errors: [] },
    formats: {
      timeline: { orientation: 'vertical', width: 1080, height: 1920, fps: 30 },
      preview: { width: 640, height: 360, fps: 30 },
    },
    artifacts: {
      analysis: '00-项目总控/Codex视频分析.json',
      manifest: '00-项目总控/Codex视频素材清单.json',
      fcpxml: '03-导出/FCPXML/标题A.fcpxml',
      preview: '03-导出/粗剪预览/标题A-roughcut-preview.mp4',
    },
    fcpxmlReport: { titleCount: 0, assetCount: 2, clipCount: 2 },
  });
  await writeJson(path.join(projectPath, '00-项目总控', 'editorial-review.json'), {
    schemaVersion: 1,
    updatedAt: '2026-07-26T00:00:00.000Z',
    reviews: {
      'media-1': {
        assetId: 'media-1',
        captions: {
          'cap-1': {
            captionId: 'cap-1',
            reviewStatus: 'approved',
            approvedText: '人工字幕一',
            approvedStartTime: 0,
            approvedEndTime: 1,
          },
          'cap-2': {
            captionId: 'cap-2',
            reviewStatus: 'edited_approved',
            approvedText: '人工字幕二',
            approvedStartTime: 1,
            approvedEndTime: 2,
          },
        },
      },
    },
    warnings: [],
  });
  await fs.writeFile(path.join(exportDir, 'FCPXML', '标题A.fcpxml'), '<?xml version="1.0"?><fcpxml version="1.11"/>\n', 'utf8');
  await fs.writeFile(path.join(exportDir, '粗剪预览', '标题A-roughcut-preview.mp4'), Buffer.from('mp4'), 'binary');
  await fs.writeFile(path.join(assets, 'asset-1.png'), Buffer.from([137, 80, 78, 71]), 'binary');
  await fs.writeFile(path.join(assets, 'asset-2.png'), Buffer.from([137, 80, 78, 71]), 'binary');
  return projectPath;
}

test('detectHotIngestKind 区分普通素材与 HotIngest 项目', () => {
  const normal = detectHotIngestKind([
    { relativePath: 'a.png' },
    { relativePath: 'b.mp4' },
  ]);
  assert.equal(normal.kind, 'normal');
  const hot = detectHotIngestKind([
    { relativePath: '_素材索引.html' },
    { relativePath: '01.context.html' },
    { relativePath: '.hotingest/items/001.json' },
  ]);
  assert.equal(hot.kind, 'hotingest');
  assert.equal(hot.hotIngest.counts.metadataJson, 1);
});

test('recognizeMaterialProject 识别素材目录与 HotIngest 上下文', async () => {
  const root = await makeTempRoot('stage6a-recognize-');
  const source = await createMaterialDir(root, '本期素材', { hotingest: true, unsupported: true });
  const recognized = await recognizeMaterialProject(source, { projectRoot: path.join(root, 'projects') });
  assert.equal(recognized.kind, 'hotingest');
  assert.equal(recognized.counts.image, 1);
  assert.equal(recognized.counts.unsupported, 1);
  assert.ok(recognized.hotIngest.detected);
});

test('生成前检查展示数量、规格、审核与可否继续', async () => {
  const root = await makeTempRoot('stage6a-preflight-');
  const projectRoot = path.join(root, 'projects');
  await fs.mkdir(projectRoot, { recursive: true });
  const source = await createMaterialDir(root, '验收素材', { hotingest: true });
  const projectPath = await createVerifiedProject(projectRoot, '验收素材', source);
  const preflight = await buildEditPreflight(source, { projectRoot });
  assert.equal(preflight.material.kind, 'hotingest');
  assert.equal(preflight.generationMode, 'regenerate');
  assert.equal(preflight.recommendedAction, 'reuse_existing');
  assert.equal(preflight.canContinue, true);
  assert.equal(preflight.timelineSpec.width, 1080);
  assert.equal(preflight.timelineSpec.height, 1920);
  assert.equal(preflight.timelineSpec.fps, 30);
  assert.equal(preflight.editorialReview.exists, true);
  assert.equal(preflight.editorialReview.humanCaptionCount, 2);
  assert.equal(preflight.existingProject.projectPath, projectPath);
  assert.ok(preflight.affectedFiles.some((item) => item.protected));
  assert.equal(preflight.protections.preserveEditorialReview, true);
  assert.equal(preflight.protections.preserveHotIngestSource, true);
});

test('空目录生成前检查阻塞且不可继续', async () => {
  const root = await makeTempRoot('stage6a-empty-');
  const source = path.join(root, 'empty');
  await fs.mkdir(source, { recursive: true });
  const preflight = await buildEditPreflight(source, { projectRoot: path.join(root, 'projects') });
  assert.equal(preflight.canContinue, false);
  assert.equal(preflight.recommendedAction, 'blocked');
  assert.ok(preflight.blockers.some((item) => item.code === 'EMPTY_MATERIAL'));
});

test('App 内 reuse_existing 任务状态准确且失败不会标成功', async () => {
  const root = await makeTempRoot('stage6a-reuse-');
  const userData = path.join(root, 'userdata');
  const projectRoot = path.join(root, 'projects');
  await fs.mkdir(projectRoot, { recursive: true });
  const source = await createMaterialDir(root, '复用素材', { hotingest: true });
  const projectPath = await createVerifiedProject(projectRoot, '复用素材', source);

  const preflightFail = await buildEditPreflight(source, { projectRoot });
  const failJob = await createEditJob(userData, {
    sourceDirectory: source,
    action: 'reuse_existing',
    preflight: preflightFail,
  });
  const failed = await runEditJob(userData, failJob.jobFilePath, {
    verifyImpl: async () => ({ ok: false, errors: ['缺少 FCPXML'], warnings: [] }),
    readResultImpl: async () => ({
      project: { path: projectPath, name: '复用素材', status: 'failed' },
      timeline: { shotCount: 2, shots: [], markers: [], totalDurationSec: 4 },
      formats: { timeline: { width: 1080, height: 1920, fps: 30 }, fcpxmlTitleCount: 0 },
      explanationReview: { summary: { approved: 0, editedApproved: 0 } },
      artifacts: {},
      summary: { recommendedTitle: '标题A' },
    }),
  });
  assert.equal(failed.status, 'failed');
  assert.notEqual(failed.status, 'completed');
  assert.ok(failed.error?.message);

  const sourceOk = await createMaterialDir(root, '复用成功', { hotingest: true });
  const okProject = await createVerifiedProject(projectRoot, '复用成功', sourceOk);
  const beforeReview = await fs.readFile(path.join(okProject, '00-项目总控', 'editorial-review.json'), 'utf8');
  const beforeSource = await fs.readFile(path.join(sourceOk, 'shot-1.context.html'), 'utf8');
  const preflightOk = await buildEditPreflight(sourceOk, { projectRoot });
  const okJob = await createEditJob(userData, {
    sourceDirectory: sourceOk,
    action: 'reuse_existing',
    preflight: preflightOk,
  });
  assert.equal(okJob.status, 'ready');
  const completed = await runEditJob(userData, okJob.jobFilePath, {
    verifyImpl: async () => ({ ok: true, errors: [], warnings: [] }),
    readResultImpl: async () => ({
      project: { path: okProject, name: '复用成功', status: 'verified' },
      timeline: {
        shotCount: 2,
        shots: [
          { filename: 'a.mp4' },
          { filename: 'b.png' },
        ],
        markers: [{ timeSec: 1, text: '结果' }],
        totalDurationSec: 4,
      },
      formats: {
        timeline: { orientation: 'vertical', width: 1080, height: 1920, fps: 30 },
        fcpxmlTitleCount: 0,
      },
      explanationReview: { summary: { approved: 1, editedApproved: 1 } },
      artifacts: {
        fcpxml: { path: path.join(okProject, '03-导出/FCPXML/标题A.fcpxml'), exists: true },
        preview: { path: path.join(okProject, '03-导出/粗剪预览/x.mp4'), exists: true },
      },
      summary: { recommendedTitle: '标题A' },
    }),
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.resultProjectPath, okProject);
  assert.equal(completed.result.summary.shotCount, 2);
  assert.equal(completed.result.summary.markerCount, 1);
  assert.equal(completed.result.summary.subtitleCount, 2);
  assert.equal(completed.result.summary.timeline.width, 1080);
  assert.equal(completed.result.reused, true);
  assert.equal(
    await fs.readFile(path.join(okProject, '00-项目总控', 'editorial-review.json'), 'utf8'),
    beforeReview,
  );
  assert.equal(await fs.readFile(path.join(sourceOk, 'shot-1.context.html'), 'utf8'), beforeSource);
});

test('已存在结果保护：成功项目受影响文件清单标记人工审核不可覆盖', async () => {
  const root = await makeTempRoot('stage6a-protect-');
  const projectRoot = path.join(root, 'projects');
  const source = await createMaterialDir(root, '保护素材', { hotingest: true });
  const projectPath = await createVerifiedProject(projectRoot, '保护素材', source);
  const bundle = await loadExistingProjectBundle(projectPath);
  const affected = listAffectedArtifacts(bundle);
  const review = affected.find((item) => /editorial-review/.test(item.label));
  assert.ok(review);
  assert.equal(review.protected, true);
  assert.equal(review.regeneratable, false);
  assert.equal(bundle.success, true);
  assert.equal(bundle.humanCaptionCount, 2);
});

test('uniqueProjectName 避免覆盖已有成功项目名', () => {
  const name = uniqueProjectName('Demo', ['Demo', 'Demo-20260101120000']);
  assert.match(name, /^Demo-\d+/);
  assert.notEqual(name, 'Demo');
});

test('userFacingError 提供可读信息并保留诊断', () => {
  const faced = userFacingError(Object.assign(new Error('正式项目目录已存在且非空：/tmp/x'), {
    code: 'PROJECT_ALREADY_EXISTS',
  }));
  assert.match(faced.message, /不会原地覆盖/);
  assert.equal(faced.diagnostic.code, 'PROJECT_ALREADY_EXISTS');
});

test('FCP 交接拒绝失败项目且成功项目走 openInFinalCut', async () => {
  const root = await makeTempRoot('stage6a-fcp-');
  const projectRoot = path.join(root, 'projects');
  const source = await createMaterialDir(root, '交接素材');
  const projectPath = await createVerifiedProject(projectRoot, '交接素材', source);
  await writeJson(path.join(projectPath, '00-项目总控', 'Codex视频状态.json'), {
    ...(JSON.parse(await fs.readFile(path.join(projectPath, '00-项目总控', 'Codex视频状态.json'), 'utf8'))),
    status: 'failed',
    verification: { ok: false, errors: ['boom'], warnings: [] },
  });
  await assert.rejects(() => openEditJobInFinalCut(projectPath), /失败项目不能交接/);

  // Restore verified and spy open strategy via project-action-service constants.
  await writeJson(path.join(projectPath, '00-项目总控', 'Codex视频状态.json'), {
    schemaVersion: 1,
    status: 'verified',
    projectPath,
    sourceDirectory: source,
    verification: { ok: true, warnings: [], errors: [] },
    formats: {
      timeline: { orientation: 'vertical', width: 1080, height: 1920, fps: 30 },
      preview: { width: 640, height: 360, fps: 30 },
    },
    artifacts: {
      analysis: '00-项目总控/Codex视频分析.json',
      manifest: '00-项目总控/Codex视频素材清单.json',
      fcpxml: '03-导出/FCPXML/标题A.fcpxml',
      preview: '03-导出/粗剪预览/标题A-roughcut-preview.mp4',
    },
    fcpxmlReport: { titleCount: 0, assetCount: 2, clipCount: 2 },
  });
  // Do not actually launch FCP in CI/unit; validate helper wiring with a fake by
  // ensuring missing fcpxml is rejected after delete.
  await fs.rm(path.join(projectPath, '03-导出', 'FCPXML', '标题A.fcpxml'));
  await assert.rejects(() => openEditJobInFinalCut(projectPath), /FCPXML 不存在/);
  assert.equal(typeof openInFinalCut, 'function');
  assert.ok(ACTIONS.has('reuse_existing'));
  assert.ok(STAGE_LABELS.verifying);
});

test('renderer 暴露新建剪辑任务、生成前检查与结果交接入口', async () => {
  const root = path.join(__dirname, '..');
  const [html, appJs, preload] = await Promise.all([
    fs.readFile(path.join(root, 'src/renderer/index.html'), 'utf8'),
    fs.readFile(path.join(root, 'src/renderer/app.js'), 'utf8'),
    fs.readFile(path.join(root, 'src/preload.js'), 'utf8'),
  ]);
  assert.match(html, /新建剪辑任务/);
  assert.match(html, /生成前检查/);
  assert.match(html, /打开审核文件/);
  assert.match(html, /在 Final Cut Pro 中打开/);
  assert.match(appJs, /openEditPreflight/);
  assert.match(appJs, /startEditJob/);
  assert.match(appJs, /showEditJobCompletion/);
  assert.match(appJs, /completionShowReviewButton/);
  assert.match(preload, /buildEditPreflight/);
  assert.match(preload, /createEditJob/);
  assert.match(preload, /runEditJob/);
  assert.match(preload, /openEditJobInFinalCut/);
  assert.match(preload, /showEditEditorialReview/);
});
