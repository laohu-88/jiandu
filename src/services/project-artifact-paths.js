const fs = require('node:fs/promises');
const path = require('node:path');

const {
  LEGACY_VIDEO_ANALYSIS_FILENAME,
  LEGACY_VIDEO_MANIFEST_FILENAME,
  LEGACY_VIDEO_STATUS_FILENAME,
  LEGACY_VIDEO_SUMMARY_FILENAME,
  LEGACY_INTERNAL_VIDEO_ANALYSIS_FILE,
  LEGACY_INTERNAL_VIDEO_MANIFEST_FILE,
  LEGACY_INTERNAL_VIDEO_STATUS_FILE,
  LEGACY_INTERNAL_VIDEO_SUMMARY_FILE,
  VIDEO_ANALYSIS_FILE,
  VIDEO_MANIFEST_FILE,
  VIDEO_STATUS_FILE,
  INTERNAL_ASSETS_FILE,
  INTERNAL_VIDEO_ANALYSIS_FILE,
  INTERNAL_VIDEO_MANIFEST_FILE,
  INTERNAL_VIDEO_STATUS_FILE,
  INTERNAL_EDITORIAL_REVIEW_FILE,
  INTERNAL_PLATFORM_VARIANTS_FILE,
  INTERNAL_PROJECT_FILE,
  INTERNAL_PROJECTS_DIR,
  internalProjectRoot,
  PLATFORM_VARIANTS_FILE,
} = require('../constants');

// v3.2 命名迁移：读取侧把旧 Codex 前缀文件名一次性搬到中性名（幂等）。
const NEUTRAL_NAME_MIGRATIONS = Object.freeze([
  [LEGACY_INTERNAL_VIDEO_STATUS_FILE, INTERNAL_VIDEO_STATUS_FILE],
  [LEGACY_INTERNAL_VIDEO_ANALYSIS_FILE, INTERNAL_VIDEO_ANALYSIS_FILE],
  [LEGACY_INTERNAL_VIDEO_MANIFEST_FILE, INTERNAL_VIDEO_MANIFEST_FILE],
  [LEGACY_INTERNAL_VIDEO_SUMMARY_FILE, '视频项目摘要.md'],
]);

async function ensureNeutralArtifactNames(root) {
  for (const [legacyName, neutralName] of NEUTRAL_NAME_MIGRATIONS) {
    const target = path.join(root, neutralName);
    if (await isFile(target)) continue;
    const source = path.join(root, legacyName);
    if (await isFile(source)) {
      await fs.rename(source, target).catch(() => {});
    }
  }
}

// 旧版控制目录内同样存在 Codex 前缀命名的文件。
const LEGACY_CONTROL_MIGRATIONS = Object.freeze([
  [LEGACY_VIDEO_STATUS_FILENAME],
  [LEGACY_VIDEO_ANALYSIS_FILENAME],
  [LEGACY_VIDEO_MANIFEST_FILENAME],
  [LEGACY_VIDEO_SUMMARY_FILENAME],
]);

const INTERNAL_ARTIFACT_FILES = Object.freeze({
  project: INTERNAL_PROJECT_FILE,
  assets: INTERNAL_ASSETS_FILE,
  manifest: INTERNAL_VIDEO_MANIFEST_FILE,
  analysis: INTERNAL_VIDEO_ANALYSIS_FILE,
  status: INTERNAL_VIDEO_STATUS_FILE,
  editorialReview: INTERNAL_EDITORIAL_REVIEW_FILE,
  platformVariants: INTERNAL_PLATFORM_VARIANTS_FILE,
});

function legacyArtifactRoot(projectPath) {
  return path.join(path.resolve(projectPath), '00-项目总控');
}

function internalArtifactRoot(projectPath) {
  return internalProjectRoot(path.resolve(projectPath));
}

async function isFile(filePath) {
  return Boolean((await fs.stat(filePath).catch(() => null))?.isFile());
}

/**
 * New projects use an Application Support root. Legacy roots are accepted for
 * reading only so an existing project remains recoverable.
 */
async function resolveProjectArtifactRoot(projectPath) {
  const resolved = path.resolve(String(projectPath || ''));
  const internal = internalArtifactRoot(resolved);
  await ensureNeutralArtifactNames(internal);
  if (await isFile(path.join(internal, INTERNAL_ARTIFACT_FILES.status))) return internal;
  const legacy = legacyArtifactRoot(resolved);
  // 旧版目录里的 Codex 前缀名同样一次性迁移为中性名。
  for (const legacyName of [
    'Codex视频状态.json',
    'Codex视频分析.json',
    'Codex视频素材清单.json',
    'Codex视频项目摘要.md',
  ]) {
    const source = path.join(legacy, legacyName);
    if (!(await isFile(source))) continue;
    const neutralName = {
      'Codex视频状态.json': path.basename(VIDEO_STATUS_FILE),
      'Codex视频分析.json': path.basename(VIDEO_ANALYSIS_FILE),
      'Codex视频素材清单.json': path.basename(VIDEO_MANIFEST_FILE),
      'Codex视频项目摘要.md': '视频项目摘要.md',
    }[legacyName];
    const target = path.join(legacy, neutralName);
    if (!(await isFile(target))) await fs.rename(source, target).catch(() => {});
  }
  if (await isFile(path.join(legacy, path.basename(VIDEO_STATUS_FILE)))) return legacy;
  if (await isFile(path.join(resolved, path.basename(VIDEO_STATUS_FILE)))) return resolved;
  return internal;
}

function artifactFile(root, key) {
  const file = INTERNAL_ARTIFACT_FILES[key] || key;
  return path.join(root, file);
}

function artifactReference(projectPath, artifactRoot, filePath) {
  const resolvedProject = path.resolve(projectPath);
  const resolvedRoot = path.resolve(artifactRoot);
  const resolvedFile = path.resolve(filePath);
  return resolvedRoot === resolvedProject
    ? path.relative(resolvedProject, resolvedFile)
    : {
      root: resolvedRoot,
      relativePath: path.relative(resolvedRoot, resolvedFile),
    };
}

function isInternalArtifactRoot(projectPath, artifactRoot) {
  return path.resolve(artifactRoot) === internalArtifactRoot(projectPath);
}

function internalProjectDirectory(projectName) {
  return path.join(
    path.dirname(internalProjectRoot(path.join(INTERNAL_PROJECTS_DIR, String(projectName || '')))),
    String(projectName || ''),
  );
}

function legacyProjectFile(key) {
  const map = {
    manifest: VIDEO_MANIFEST_FILE,
    analysis: VIDEO_ANALYSIS_FILE,
    status: VIDEO_STATUS_FILE,
    platformVariants: PLATFORM_VARIANTS_FILE,
  };
  return map[key] || key;
}

module.exports = {
  INTERNAL_ARTIFACT_FILES,
  artifactFile,
  artifactReference,
  internalArtifactRoot,
  internalProjectDirectory,
  isInternalArtifactRoot,
  legacyArtifactRoot,
  legacyProjectFile,
  resolveProjectArtifactRoot,
};
