const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  ASSETS_DIR,
  ASSETS_FILE,
  VIDEO_ANALYSIS_FILE,
  VIDEO_MANIFEST_FILE,
  VIDEO_STATUS_FILE,
  CONTROL_DIR,
  EXPORT_DIR,
  INTERNAL_ASSETS_FILE,
  INTERNAL_VIDEO_ANALYSIS_FILE,
  INTERNAL_VIDEO_MANIFEST_FILE,
  INTERNAL_VIDEO_STATUS_FILE,
  INTERNAL_PROJECT_FILE,
  PROJECT_FILE,
} = require('../constants');
const { readJsonFile } = require('./project-json-service');
const { verifyCodexVideoProject } = require('./codex-video-service');
const { createMarkerViewModel } = require('./marker-view-model');
const { buildEditorialReviewModel } = require('./editorial-review-service');
const { readPlatformVariants } = require('./platform-variant-service');
const { internalArtifactRoot, resolveProjectArtifactRoot } = require('./project-artifact-paths');

const PROJECT_RESULT_STATUS = Object.freeze({
  VERIFIED: 'verified',
  WARNING: 'warning',
  FAILED: 'failed',
  INCOMPLETE: 'incomplete',
  LEGACY: 'legacy',
  CORRUPT: 'corrupt',
});

const STATUS_LABELS = Object.freeze({
  verified: '可用且验证通过',
  warning: '可用但有警告',
  failed: '验证或构建失败',
  incomplete: '不完整项目',
  legacy: '旧版项目',
  corrupt: 'JSON 损坏项目',
});

function isInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveProjectPath(projectPath, candidate, options = {}) {
  const root = path.resolve(String(projectPath || ''));
  const value = String(candidate || '');
  if (!value || path.isAbsolute(value)) {
    throw Object.assign(new Error('产物路径必须是项目内的相对路径。'), {
      code: 'UNSAFE_PROJECT_PATH',
    });
  }
  const resolved = path.resolve(root, value);
  if (!isInside(root, resolved)) {
    throw Object.assign(new Error(`拒绝项目外路径：${value}`), {
      code: 'UNSAFE_PROJECT_PATH',
    });
  }
  const stat = await fs.stat(resolved).catch(() => null);
  if (stat) {
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(resolved)]);
    if (!isInside(realRoot, realTarget)) {
      throw Object.assign(new Error(`拒绝通过链接访问项目外路径：${value}`), {
        code: 'UNSAFE_PROJECT_PATH',
      });
    }
  }
  if (options.kind === 'file' && stat && !stat.isFile()) {
    throw Object.assign(new Error(`项目产物不是文件：${value}`), { code: 'INVALID_ARTIFACT_TYPE' });
  }
  if (options.kind === 'directory' && stat && !stat.isDirectory()) {
    throw Object.assign(new Error(`项目产物不是目录：${value}`), { code: 'INVALID_ARTIFACT_TYPE' });
  }
  return { path: resolved, exists: Boolean(stat), stat };
}

async function makeArtifact(projectPath, relativePath, kind = 'file') {
  if (!relativePath) return null;
  if (path.isAbsolute(String(relativePath))) {
    const absolute = path.resolve(String(relativePath));
    const stat = await fs.stat(absolute).catch(() => null);
    if (kind === 'file' && stat && !stat.isFile()) {
      throw Object.assign(new Error(`项目产物不是文件：${absolute}`), { code: 'INVALID_ARTIFACT_TYPE' });
    }
    if (kind === 'directory' && stat && !stat.isDirectory()) {
      throw Object.assign(new Error(`项目产物不是目录：${absolute}`), { code: 'INVALID_ARTIFACT_TYPE' });
    }
    return {
      relativePath: absolute,
      path: absolute,
      exists: Boolean(stat),
      fileUrl: stat?.isFile() && kind === 'file' ? pathToFileURL(absolute).href : null,
    };
  }
  const resolved = await resolveProjectPath(projectPath, relativePath, { kind });
  return {
    relativePath,
    path: resolved.path,
    exists: resolved.exists,
    fileUrl: resolved.exists && kind === 'file' ? pathToFileURL(resolved.path).href : null,
  };
}

async function optionalJson(projectPath, relativePath, label) {
  return readJsonFile(path.join(projectPath, relativePath), { optional: true, label });
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function timelineDuration(shots) {
  return asArray(shots).reduce((sum, shot) => sum + (Number(shot.durationSec) || 0), 0);
}

function collectWarnings(status, manifest) {
  return [
    ...asArray(status?.verification?.warnings),
    ...asArray(status?.warnings),
    ...asArray(manifest?.warnings),
    ...asArray(manifest?.degradationWarnings),
  ].filter(Boolean);
}

function collectErrors(status) {
  const errors = [
    ...asArray(status?.verification?.errors),
    ...asArray(status?.errors),
  ].filter(Boolean);
  if (status?.error?.message) errors.push(status.error.message);
  return errors;
}

function classifyResult({ project, status, analysis, manifest, warnings, errors }) {
  if (!status && !analysis && !manifest) return PROJECT_RESULT_STATUS.LEGACY;
  if (!project || !status || !analysis || !manifest) return PROJECT_RESULT_STATUS.INCOMPLETE;
  if (status.status === 'failed' || errors.length > 0) return PROJECT_RESULT_STATUS.FAILED;
  if (status.status === 'verified' || status.verification?.ok === true) {
    return warnings.length > 0 ? PROJECT_RESULT_STATUS.WARNING : PROJECT_RESULT_STATUS.VERIFIED;
  }
  if (status.status === 'generated') return PROJECT_RESULT_STATUS.WARNING;
  return PROJECT_RESULT_STATUS.INCOMPLETE;
}

async function readCodexProjectResult(projectPath) {
  const resolved = path.resolve(String(projectPath || ''));
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw Object.assign(new Error('项目目录不存在。'), { code: 'PROJECT_NOT_FOUND' });
  }

  const artifactRoot = await resolveProjectArtifactRoot(resolved);
  const internal = artifactRoot !== resolved
    && path.resolve(artifactRoot) !== path.resolve(path.join(resolved, '00-项目总控'));
  const names = internal ? {
    project: INTERNAL_PROJECT_FILE,
    assets: INTERNAL_ASSETS_FILE,
    manifest: INTERNAL_VIDEO_MANIFEST_FILE,
    analysis: INTERNAL_VIDEO_ANALYSIS_FILE,
    status: INTERNAL_VIDEO_STATUS_FILE,
  } : {
    project: path.basename(PROJECT_FILE),
    assets: path.basename(ASSETS_FILE),
    manifest: path.basename(VIDEO_MANIFEST_FILE),
    analysis: path.basename(VIDEO_ANALYSIS_FILE),
    status: path.basename(VIDEO_STATUS_FILE),
  };
  const [projectFile, assetsFile, manifestFile, analysisFile, statusFile] = await Promise.all([
    optionalJson(artifactRoot, names.project, 'project.json'),
    optionalJson(artifactRoot, names.assets, 'assets.json'),
    optionalJson(artifactRoot, names.manifest, 'Codex 视频素材清单'),
    optionalJson(artifactRoot, names.analysis, 'Codex 视频分析'),
    optionalJson(artifactRoot, names.status, 'Codex 视频状态'),
  ]);
  const project = projectFile.value || {
    projectName: path.basename(resolved),
    projectPath: resolved,
    createdAt: statusFile.value?.createdAt || null,
    generatedAt: statusFile.value?.generatedAt || null,
  };
  const assetsIndex = assetsFile.value;
  const manifest = manifestFile.value;
  const baseAnalysis = analysisFile.value;
  const status = statusFile.value;
  const warnings = collectWarnings(status, manifest);
  const errors = collectErrors(status);
  const classification = classifyResult({ project, status, analysis: baseAnalysis, manifest, warnings, errors });
  const hyperframesEnabled = status?.hyperframes?.enabled === true;
  const analysis = hyperframesEnabled && status?.effectiveAnalysis
    ? status.effectiveAnalysis
    : baseAnalysis;
  const shots = asArray(analysis?.timeline?.shots);
  const markers = asArray(analysis?.timeline?.markers);
  const manifestById = new Map(asArray(manifest?.items).map((item) => [item.assetId, item]));
  const mappingById = new Map(asArray(status?.assetMappings).map((item) => [item.assetId, item]));
  const generatedIds = new Set(asArray(status?.assetMappings)
    .filter((item) => item.origin === 'hyperframes')
    .map((item) => item.assetId));

  const decisions = [];
  for (const decision of asArray(baseAnalysis?.assets)) {
    const source = manifestById.get(decision.assetId);
    const mapping = mappingById.get(decision.assetId);
    decisions.push({
      assetId: decision.assetId,
      type: decision.type,
      filename: source?.filename || mapping?.projectFilename || decision.assetId,
      status: decision.status,
      reason: decision.reason || null,
      ranges: asArray(decision.ranges),
      selectedRelativePath: mapping?.projectRelativePath || null,
      selectedPath: mapping?.projectRelativePath
        ? await makeArtifact(resolved, mapping.projectRelativePath)
        : null,
    });
  }

  const artifactsSpec = status?.artifacts || {};
  const artifacts = {
    projectRoot: { path: resolved, relativePath: '.', exists: true },
    selectedAssets: internal ? null : await makeArtifact(resolved, ASSETS_DIR, 'directory'),
    exportDirectory: await makeArtifact(resolved, EXPORT_DIR, 'directory'),
    controlDirectory: internal ? null : await makeArtifact(resolved, CONTROL_DIR, 'directory'),
    fcpxml: artifactsSpec.fcpxml
      ? await makeArtifact(resolved, artifactsSpec.fcpxml)
      : null,
    preview: artifactsSpec.preview
      ? (path.isAbsolute(artifactsSpec.preview)
        ? { path: artifactsSpec.preview, relativePath: null, exists: Boolean(await fs.stat(artifactsSpec.preview).catch(() => null)) }
        : await makeArtifact(resolved, artifactsSpec.preview))
      : null,
    analysis: await makeArtifact(artifactRoot, names.analysis),
    status: await makeArtifact(artifactRoot, names.status),
    manifest: await makeArtifact(artifactRoot, names.manifest),
    hyperframesMp4: artifactsSpec.hyperframesMp4
      ? (path.isAbsolute(artifactsSpec.hyperframesMp4)
        ? { path: artifactsSpec.hyperframesMp4, relativePath: null, exists: Boolean(await fs.stat(artifactsSpec.hyperframesMp4).catch(() => null)) }
        : await makeArtifact(resolved, artifactsSpec.hyperframesMp4))
      : null,
  };

  const timelineFormat = status?.formats?.timeline || (analysis?.timeline ? {
    orientation: analysis.timeline.orientation ?? null,
    width: analysis.timeline.width ?? null,
    height: analysis.timeline.height ?? null,
    fps: analysis.timeline.fps ?? null,
  } : null);
  const previewMetadata = status?.previewMetadata || status?.verification?.previewMetadata || null;
  const previewFormat = status?.formats?.preview || (previewMetadata ? {
    width: previewMetadata.displayWidth ?? previewMetadata.width ?? null,
    height: previewMetadata.displayHeight ?? previewMetadata.height ?? null,
    fps: previewMetadata.frameRate ?? null,
  } : null);
  const sourceVerification = status?.verification?.sourceVerification
    || status?.sourceVerification
    || null;
  const fcpxmlText = artifacts.fcpxml?.exists
    ? await fs.readFile(artifacts.fcpxml.path, 'utf8').catch(() => '')
    : '';
  const subtitles = createMarkerViewModel({
    analysis,
    baseAnalysis,
    manifest,
    status,
    fcpxml: fcpxmlText,
  });
  const platformRegistry = await readPlatformVariants(resolved).catch((error) => ({
    ...defaultPlatformRegistry(resolved),
    error: error.message,
  }));
  const platformVariants = [];
  for (const variant of asArray(platformRegistry.variants)) {
    const outputs = [];
    for (const output of asArray(variant.outputs)) {
      outputs.push({
        ...output,
        outputDirectory: await makeArtifact(
          resolved,
          output.relativeOutputDirectory || null,
          'directory',
        ),
        artifacts: {
          fcpxml: await makeArtifact(resolved, output.artifacts?.fcpxml || null),
          preview: await makeArtifact(resolved, output.artifacts?.preview || null),
          editPlan: await makeArtifact(resolved, output.artifacts?.editPlan || null),
          analysis: await makeArtifact(resolved, output.artifacts?.analysis || null),
          validation: await makeArtifact(resolved, output.artifacts?.validation || null),
        },
      });
    }
    platformVariants.push({
      variantId: variant.variantId,
      platform: variant.platform,
      profileId: variant.profileId,
      revision: variant.revision,
      status: variant.status,
      createdAt: variant.createdAt,
      updatedAt: variant.updatedAt,
      generatedAt: variant.generatedAt || null,
      approval: variant.approval || null,
      plan: variant.plan || null,
      outputs,
    });
  }

  return {
    project: {
      name: project?.projectName || path.basename(resolved),
      path: resolved,
      version: project?.version || null,
      createdAt: project?.createdAt || status?.createdAt || null,
      generatedAt: status?.generatedAt || null,
      verifiedAt: status?.verifiedAt || status?.verification?.verifiedAt || null,
      status: classification,
      statusLabel: STATUS_LABELS[classification],
      isCodexProject: Boolean(status || baseAnalysis || manifest),
    },
    summary: {
      theme: baseAnalysis?.theme?.summary || null,
      themeRationale: baseAnalysis?.theme?.rationale || null,
      recommendedTitle: baseAnalysis?.titles?.recommended || null,
      titleCandidates: asArray(baseAnalysis?.titles?.candidates),
    },
    decisions: {
      adopt: decisions.filter((item) => item.status === 'adopt'),
      candidate: decisions.filter((item) => item.status === 'candidate'),
      reject: decisions.filter((item) => item.status === 'reject'),
    },
    timeline: {
      shotCount: shots.length,
      totalDurationSec: Number(timelineDuration(shots).toFixed(3)),
      shots: shots.map((shot, index) => ({
        order: index + 1,
        ...shot,
        filename: manifestById.get(shot.assetId)?.filename
          || mappingById.get(shot.assetId)?.projectFilename
          || shot.assetId,
        hyperframes: generatedIds.has(shot.assetId),
      })),
      markers,
    },
    formats: {
      timeline: timelineFormat,
      preview: previewFormat,
      previewMetadata,
      fcpxmlAssetCount: status?.fcpxmlReport?.assetCount
        ?? status?.verification?.fcpxml?.assetCount
        ?? null,
      fcpxmlClipCount: status?.fcpxmlReport?.clipCount
        ?? status?.verification?.fcpxml?.clipCount
        ?? null,
      fcpxmlTitleCount: status?.fcpxmlReport?.titleCount
        ?? status?.verification?.fcpxml?.titleCount
        ?? null,
    },
    subtitles,
    artifacts,
    platformVariants: {
      defaultMain: platformRegistry.defaultMain || defaultPlatformRegistry(resolved).defaultMain,
      variants: platformVariants,
      error: platformRegistry.error || null,
    },
    verification: {
      ok: status?.verification?.ok ?? (classification === PROJECT_RESULT_STATUS.VERIFIED),
      status: classification,
      statusLabel: STATUS_LABELS[classification],
      source: {
        unchanged: sourceVerification?.unchanged ?? null,
        beforeDigest: sourceVerification?.beforeDigest
          || manifest?.sourceSnapshot?.digest
          || null,
        afterDigest: sourceVerification?.afterDigest || null,
        files: asArray(manifest?.items).map((item) => ({
          assetId: item.assetId,
          filename: item.filename,
          sha256: item.sha256 || null,
          sizeBytes: item.sizeBytes ?? null,
          mtimeMs: item.mtimeMs ?? item.mtime ?? null,
        })),
      },
      fcpxml: status?.verification?.fcpxml || status?.fcpxmlReport || null,
      xmlSyntax: status?.verification?.xmlSyntax || null,
      preview: previewMetadata,
      hyperframes: status?.verification?.hyperframes || null,
      warnings,
      errors,
    },
    hyperframes: hyperframesEnabled ? {
      enabled: true,
      version: status.hyperframes.version || null,
      count: artifacts.hyperframesMp4 ? 1 : 0,
      kind: status.hyperframes.kind || null,
      reason: status.hyperframes.reason || status.hyperframes.flow?.reason || null,
      file: artifacts.hyperframesMp4,
      durationSec: status.hyperframes.metadata?.durationSec
        ?? status.hyperframes.format?.durationSec
        ?? null,
      width: status.hyperframes.metadata?.displayWidth
        ?? status.hyperframes.format?.width
        ?? null,
      height: status.hyperframes.metadata?.displayHeight
        ?? status.hyperframes.format?.height
        ?? null,
      fps: status.hyperframes.metadata?.frameRate
        ?? status.hyperframes.format?.fps
        ?? null,
      sha256: status.hyperframes.sha256 || null,
      stableId: asArray(status.assetMappings).find((item) => item.origin === 'hyperframes')?.projectStableId || null,
      assetId: asArray(status.assetMappings).find((item) => item.origin === 'hyperframes')?.assetId || null,
      insertAfterShotId: status.hyperframes.flow?.insertAfterShotId || null,
      checkOk: status.hyperframes.check?.ok ?? null,
    } : { enabled: false },
    explanationReview: await buildEditorialReviewModel(resolved, {
      analysis: baseAnalysis,
      manifest,
      status,
    }).catch((error) => ({
      available: false,
      message: '解释与轻字幕审阅数据加载失败',
      summary: {
        pending: 0,
        approved: 0,
        editedApproved: 0,
        notNeeded: 0,
        rejected: 0,
        needsReview: 0,
        stale: 0,
        withVisualText: 0,
        withWarnings: 0,
        fullClipLocked: 0,
        originalAudioLocked: 0,
        total: 0,
      },
      items: [],
      warnings: [error.message || '未知错误'],
      reviews: {},
    })),
    raw: {
      assetsCount: asArray(assetsIndex?.assets).length,
      manifestCount: asArray(manifest?.items).length,
    },
  };
}

function defaultPlatformRegistry(projectPath) {
  return {
    defaultMain: {
      storage: 'legacy-main',
      analysis: VIDEO_ANALYSIS_FILE,
      status: VIDEO_STATUS_FILE,
      untouchedByPlatformVariants: true,
    },
    projectPath,
    variants: [],
  };
}

async function verifyCodexProjectReadOnly(projectPath) {
  try {
    return await verifyCodexVideoProject(projectPath);
  } catch (error) {
    if (error.report) return error.report;
    throw error;
  }
}

module.exports = {
  PROJECT_RESULT_STATUS,
  STATUS_LABELS,
  readCodexProjectResult,
  resolveProjectPath,
  verifyCodexProjectReadOnly,
};
