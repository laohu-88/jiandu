const fs = require('node:fs/promises');
const path = require('node:path');

const {
  CODEX_VIDEO_ANALYSIS_FILE,
  CODEX_VIDEO_MANIFEST_FILE,
  CODEX_VIDEO_STATUS_FILE,
  INTERNAL_ASSETS_FILE,
  INTERNAL_CODEX_VIDEO_ANALYSIS_FILE,
  INTERNAL_CODEX_VIDEO_MANIFEST_FILE,
  INTERNAL_CODEX_VIDEO_STATUS_FILE,
  INTERNAL_EDITORIAL_REVIEW_FILE,
  INTERNAL_PLATFORM_VARIANTS_FILE,
  INTERNAL_PROJECT_FILE,
  INTERNAL_PROJECTS_DIR,
  internalProjectRoot,
  PLATFORM_VARIANTS_FILE,
} = require('../constants');

const INTERNAL_ARTIFACT_FILES = Object.freeze({
  project: INTERNAL_PROJECT_FILE,
  assets: INTERNAL_ASSETS_FILE,
  manifest: INTERNAL_CODEX_VIDEO_MANIFEST_FILE,
  analysis: INTERNAL_CODEX_VIDEO_ANALYSIS_FILE,
  status: INTERNAL_CODEX_VIDEO_STATUS_FILE,
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
  if (await isFile(path.join(internal, INTERNAL_ARTIFACT_FILES.status))) return internal;
  const legacy = legacyArtifactRoot(resolved);
  if (await isFile(path.join(legacy, path.basename(CODEX_VIDEO_STATUS_FILE)))) return legacy;
  if (await isFile(path.join(resolved, path.basename(CODEX_VIDEO_STATUS_FILE)))) return resolved;
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
    manifest: CODEX_VIDEO_MANIFEST_FILE,
    analysis: CODEX_VIDEO_ANALYSIS_FILE,
    status: CODEX_VIDEO_STATUS_FILE,
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
