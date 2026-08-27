const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  buildCodexVideoProject,
  verifyCodexVideoProject,
} = require('../src/services/codex-video-service');
const { inspectHyperframesEnvironment } = require('../src/services/hyperframes-service');
const { runMediaTool } = require('../src/services/media-tool-service');
const {
  compareSourceSnapshots,
  preparePendingMedia,
  snapshotSource,
} = require('../src/services/pending-media-service');
const { resolveToolPath } = require('../src/services/media-tool-service');

async function prerequisitesAvailable() {
  if (!(await resolveToolPath('ffmpeg'))
    || !(await resolveToolPath('ffprobe'))
    || !(await resolveToolPath('xmllint'))) return null;
  try {
    const environment = await inspectHyperframesEnvironment();
    return environment.available ? environment : null;
  } catch {
    return null;
  }
}

async function createImage(outputPath) {
  await runMediaTool('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=0xf59e0b:s=640x360',
    '-vf', 'drawbox=x=70:y=55:w=500:h=250:color=white@0.72:t=fill',
    '-frames:v', '1',
    '-update', '1',
    outputPath,
  ], { timeoutMs: 60_000 });
}

async function frameFingerprint(filePath, timeSec) {
  const result = await runMediaTool('ffmpeg', [
    '-v', 'error',
    '-ss', String(timeSec),
    '-i', filePath,
    '-frames:v', '1',
    '-f', 'framemd5',
    '-',
  ], { timeoutMs: 60_000 });
  return result.stdout.split('\n').find((line) => line && !line.startsWith('#')) || '';
}

test('真实 HyperFrames A/B：独立 MP4 登记进 v3 并作为独立镜头进入 FCPXML', {
  timeout: 240_000,
}, async (t) => {
  const environment = await prerequisitesAvailable();
  if (!environment) {
    t.skip('本机缺少 HyperFrames 本地渲染或 v3 媒体验证前置条件。');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperframes-v3-e2e-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, '真实 对比 素材');
  const cacheRoot = path.join(root, '分析缓存');
  const projectRoot = path.join(root, '项目库');
  await fs.mkdir(source, { recursive: true });
  await createImage(path.join(source, '最终结果.png'));
  const sourceBefore = await snapshotSource(source);
  const prepared = await preparePendingMedia(source, { cacheRoot });
  const image = prepared.items[0];
  const analysis = {
    schemaVersion: 1,
    theme: {
      summary: '验证 HyperFrames 独立素材进入现有 v3 时间线',
      rationale: '源图片提供结果画面，建议标题用于生成可独立编辑的片头。',
      confidence: 0.98,
      folderNameConflict: false,
    },
    titles: {
      candidates: ['HyperFrames 接入 v3', '独立 MP4 进入 FCPXML'],
      recommended: '独立 MP4 进入 FCPXML',
      rationale: '对应本次真实验收的产物和接入方式。',
    },
    assets: [{
      assetId: image.assetId,
      type: 'image',
      semanticLabels: ['最终结果', '对比基线'],
      contentSummary: '橙色结果画面作为无 HyperFrames 的基线镜头。',
      suggestedUse: ['结果确认'],
      status: 'adopt',
      reason: '用于建立真实 A/B 基线。',
      ranges: [],
      confidence: 0.98,
    }],
    timeline: {
      orientation: 'horizontal',
      width: 640,
      height: 360,
      fps: 30,
      shots: [{
        id: 'shot-source',
        assetId: image.assetId,
        inSec: 0,
        outSec: 1,
        durationSec: 1,
        fitMode: 'contain',
        audioMode: 'mute',
        purpose: '展示原始结果画面',
        confidence: 0.98,
        reviewRequired: false,
      }],
      markers: [{ timeSec: 0.4, text: '原始结果' }],
    },
  };
  const analysisPath = path.join(root, 'analysis.json');
  await fs.writeFile(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');

  const baseline = await buildCodexVideoProject({
    manifestPath: prepared.manifestPath,
    analysisPath,
    projectRoot,
    projectName: 'A-基线',
  });
  let enhanced;
  try {
    enhanced = await buildCodexVideoProject({
      manifestPath: prepared.manifestPath,
      analysisPath,
      projectRoot,
      projectName: 'B-HyperFrames',
      hyperframes: {
        enabled: true,
        durationSec: 1,
        quality: 'draft',
        executablePath: environment.executable,
        browserPath: environment.browserPath,
      },
    });
  } catch (error) {
    if (error.code === 'HYPERFRAMES_COMMAND_FAILED') {
      t.skip(`既有 HyperFrames 环境失败，不计入本次回归：${error.message}`);
      return;
    }
    throw error;
  }

  assert.equal(baseline.verification.fcpxml.assetCount, 1);
  assert.equal(baseline.verification.fcpxml.clipCount, 1);
  assert.equal(baseline.verification.previewMetadata.durationSec, 1);
  assert.equal(enhanced.hyperframes.enabled, true);
  assert.equal(enhanced.hyperframes.check.ok, true);
  assert.equal(enhanced.verification.hyperframes.enabled, true);
  assert.equal(enhanced.verification.fcpxml.assetCount, 2);
  assert.equal(enhanced.verification.fcpxml.clipCount, 2);
  assert.equal(enhanced.verification.previewMetadata.durationSec, 2);
  assert.equal(enhanced.assetMappings.length, 2);
  const generated = enhanced.assetMappings.find((mapping) => mapping.origin === 'hyperframes');
  assert.ok(generated);
  assert.equal(generated.metadata.displayWidth, 640);
  assert.equal(generated.metadata.displayHeight, 360);
  assert.equal(generated.metadata.frameRate, 30);
  assert.equal(generated.metadata.durationSec, 1);
  assert.equal(generated.metadata.hasAudio, false);

  const xml = await fs.readFile(enhanced.artifacts.fcpxmlPath, 'utf8');
  assert.match(xml, /HyperFrames-片头-独立 MP4 进入 FCPXML\.mp4/);
  assert.doesNotMatch(xml, /roughcut-preview\.mp4/);
  const status = JSON.parse(await fs.readFile(enhanced.artifacts.statusPath, 'utf8'));
  assert.equal(status.effectiveAnalysis.timeline.shots.length, 2);
  assert.equal(status.effectiveAnalysis.timeline.shots[0].assetId, generated.assetId);
  assert.equal(status.effectiveAnalysis.timeline.markers[0].timeSec, 1.4);
  const assets = JSON.parse(await fs.readFile(
    path.join(enhanced.projectPath, '00-项目总控', 'assets.json'),
    'utf8',
  ));
  assert.ok(assets.assets.some((asset) => asset.stableId === generated.projectStableId));

  const baselineFrame = await frameFingerprint(baseline.artifacts.previewPath, 0.2);
  const enhancedFrame = await frameFingerprint(enhanced.artifacts.previewPath, 0.2);
  assert.ok(baselineFrame);
  assert.ok(enhancedFrame);
  assert.notEqual(enhancedFrame, baselineFrame);
  const reverified = await verifyCodexVideoProject(enhanced.projectPath);
  assert.equal(reverified.ok, true);
  assert.equal(reverified.hyperframes.checkOk, true);

  const releaseAnalysis = structuredClone(analysis);
  releaseAnalysis.timeline.markers[0] = {
    id: 'marker-release',
    timeSec: 0.4,
    text: '原始结果',
    type: 'light-subtitle',
    subtitle: {
      enabled: true,
      text: '原始结果写入本地',
      durationSec: 0.5,
      position: 'bottom-safe',
      purpose: '确认结果',
      renderAsFcpTitle: true,
    },
  };
  const releaseAnalysisPath = path.join(root, 'release-analysis.json');
  await fs.writeFile(
    releaseAnalysisPath,
    `${JSON.stringify(releaseAnalysis, null, 2)}\n`,
    'utf8',
  );
  const release = await buildCodexVideoProject({
    manifestPath: prepared.manifestPath,
    analysisPath: releaseAnalysisPath,
    projectRoot,
    projectName: 'C-发布精修',
    hyperframes: { reuseProjectPath: enhanced.projectPath },
  });
  assert.equal(release.hyperframes.enabled, true);
  assert.equal(release.hyperframes.reusedFromProject, enhanced.projectPath);
  assert.equal(release.verification.fcpxml.clipCount, 2);
  assert.equal(release.verification.fcpxml.markerCount, 1);
  assert.equal(release.verification.fcpxml.titleCount, 1);
  assert.equal(release.verification.fcpxml.version, '1.14');
  const releaseStatus = JSON.parse(await fs.readFile(release.artifacts.statusPath, 'utf8'));
  assert.equal(releaseStatus.effectiveAnalysis.timeline.markers[0].timeSec, 1.4);
  assert.equal(releaseStatus.hyperframes.sha256, generated.sourceSha256);
  assert.match(releaseStatus.hyperframes.commands.reuse, /只读复用已验收项目/);
  assert.equal(releaseStatus.assetMappings.find((item) => item.origin === 'hyperframes').sourceSha256, generated.sourceSha256);
  const sourceAfter = await snapshotSource(source);
  assert.deepEqual(compareSourceSnapshots(sourceBefore, sourceAfter), {
    unchanged: true,
    errors: [],
    beforeDigest: sourceBefore.digest,
    afterDigest: sourceAfter.digest,
  });
});
