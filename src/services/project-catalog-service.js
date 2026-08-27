const fs = require('node:fs/promises');
const path = require('node:path');

const {
  VIDEO_ANALYSIS_FILE,
  VIDEO_MANIFEST_FILE,
  VIDEO_STATUS_FILE,
  LEGACY_PROJECT_DIRS,
  PROJECT_FILE,
} = require('../constants');
const {
  PROJECT_RESULT_STATUS,
  STATUS_LABELS,
  readCodexProjectResult,
} = require('./codex-project-result-service');

function isDirectChild(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
    && path.dirname(relative) === '.';
}

async function looksLikeProject(directoryPath) {
  const markers = [
    PROJECT_FILE,
    VIDEO_STATUS_FILE,
    VIDEO_ANALYSIS_FILE,
    VIDEO_MANIFEST_FILE,
    ...LEGACY_PROJECT_DIRS,
  ];
  for (const marker of markers) {
    if (await fs.stat(path.join(directoryPath, marker)).catch(() => null)) return true;
  }
  const flatOutputs = await fs.readdir(directoryPath).catch(() => []);
  if (flatOutputs.some((name) => /\.fcpxml$/i.test(name) || /\.mp4$/i.test(name))) return true;
  return false;
}

async function hasLegacyLayout(directoryPath) {
  for (const marker of LEGACY_PROJECT_DIRS.slice(2)) {
    if (await fs.stat(path.join(directoryPath, marker)).catch(() => null)) return true;
  }
  return false;
}

function sortTimestamp(entry) {
  return Date.parse(entry.generatedAt || entry.createdAt || entry.filesystemTime || 0) || 0;
}

async function scanProjectCatalog(rootPath) {
  const root = path.resolve(String(rootPath || ''));
  const rootStat = await fs.stat(root).catch(() => null);
  if (!rootStat) {
    return { rootPath: root, exists: false, projects: [], ignoredCount: 0, errors: [] };
  }
  if (!rootStat.isDirectory()) {
    throw Object.assign(new Error('项目库路径不是目录。'), { code: 'INVALID_PROJECT_ROOT' });
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  const projects = [];
  const errors = [];
  let ignoredCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectPath = path.join(root, entry.name);
    if (!(await looksLikeProject(projectPath))) {
      ignoredCount += 1;
      continue;
    }
    const stat = await fs.stat(projectPath);
    try {
      const result = await readCodexProjectResult(projectPath);
      const resultStatus = result.project.status === PROJECT_RESULT_STATUS.LEGACY
        && !(await hasLegacyLayout(projectPath))
        ? PROJECT_RESULT_STATUS.INCOMPLETE
        : result.project.status;
      projects.push({
        projectName: result.project.name,
        projectPath,
        createdAt: result.project.createdAt,
        generatedAt: result.project.generatedAt,
        verifiedAt: result.project.verifiedAt,
        filesystemTime: stat.birthtime?.toISOString?.() || stat.mtime.toISOString(),
        status: resultStatus,
        statusLabel: STATUS_LABELS[resultStatus],
        recommendedTitle: result.summary.recommendedTitle,
        shotCount: result.timeline.shotCount,
        totalDurationSec: result.timeline.totalDurationSec,
        timelineFormat: result.formats.timeline,
        hyperframesEnabled: result.hyperframes.enabled,
        warningCount: result.verification.warnings.length,
        errorCount: result.verification.errors.length,
        legacy: resultStatus === PROJECT_RESULT_STATUS.LEGACY,
      });
    } catch (error) {
      const corrupt = error.code === 'PROJECT_JSON_CORRUPT';
      const resultStatus = corrupt ? PROJECT_RESULT_STATUS.CORRUPT : PROJECT_RESULT_STATUS.INCOMPLETE;
      projects.push({
        projectName: entry.name,
        projectPath,
        createdAt: null,
        generatedAt: null,
        verifiedAt: null,
        filesystemTime: stat.birthtime?.toISOString?.() || stat.mtime.toISOString(),
        status: resultStatus,
        statusLabel: STATUS_LABELS[resultStatus],
        recommendedTitle: null,
        shotCount: null,
        totalDurationSec: null,
        timelineFormat: null,
        hyperframesEnabled: false,
        warningCount: 0,
        errorCount: 1,
        error: error.message,
      });
      errors.push({ projectPath, code: error.code || 'PROJECT_SCAN_FAILED', message: error.message });
    }
  }
  projects.sort((a, b) => sortTimestamp(b) - sortTimestamp(a)
    || a.projectName.localeCompare(b.projectName, 'zh-CN'));
  return { rootPath: root, exists: true, projects, ignoredCount, errors };
}

async function assertCatalogProject(rootPath, projectPath) {
  const root = path.resolve(String(rootPath || ''));
  const candidate = path.resolve(String(projectPath || ''));
  if (!isDirectChild(root, candidate)) {
    throw Object.assign(new Error('所选路径不是项目库中的直属项目。'), {
      code: 'PROJECT_OUTSIDE_CATALOG',
    });
  }
  if (!(await looksLikeProject(candidate))) {
    throw Object.assign(new Error('所选目录不是可识别的视频项目。'), {
      code: 'NOT_A_VIDEO_PROJECT',
    });
  }
  return candidate;
}

module.exports = { assertCatalogProject, scanProjectCatalog };
