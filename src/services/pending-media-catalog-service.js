const fs = require('node:fs/promises');
const path = require('node:path');

const {
  CODEX_VIDEO_MANIFEST_FILE,
  CODEX_VIDEO_STATUS_FILE,
} = require('../constants');
const { probeMediaSafe } = require('./media-tool-service');
const { snapshotSource } = require('./pending-media-service');
const {
  chapterForRelativePath,
  computeDurationPolicy,
  detectNarrativeStructure,
  summarizeChapters,
} = require('./narrative-structure-service');

const DEFAULT_PENDING_ROOT = '/Users/example/Desktop/视频待处理';
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.tif', '.tiff', '.bmp',
]);
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mts', '.m2ts',
]);
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.m4a', '.aac', '.flac', '.aiff', '.aif', '.ogg', '.opus',
]);
const SUPPORT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.html', '.htm', '.csv', '.tsv', '.srt', '.vtt', '.xml', '.yaml', '.yml', '.pdf',
]);

function isInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function mediaKind(extension) {
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (SUPPORT_EXTENSIONS.has(extension)) return 'support';
  return 'unsupported';
}

async function walkEpisodeFiles(directory, rootDirectory = directory, output = [], warnings = []) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    warnings.push(`无法读取目录 ${path.relative(rootDirectory, directory) || '.'}：${error.message}`);
    return output;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      warnings.push(`已忽略符号链接：${path.relative(rootDirectory, absolutePath)}`);
      continue;
    }
    if (entry.isDirectory()) {
      await walkEpisodeFiles(absolutePath, rootDirectory, output, warnings);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.stat(absolutePath);
      await fs.access(absolutePath, fs.constants.R_OK);
      output.push({
        absolutePath,
        relativePath: path.relative(rootDirectory, absolutePath),
        extension: path.extname(entry.name).toLowerCase(),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch (error) {
      warnings.push(`无法读取文件 ${path.relative(rootDirectory, absolutePath)}：${error.message}`);
    }
  }
  return output;
}

async function readExistingProjectSources(projectRoot) {
  const root = path.resolve(String(projectRoot || ''));
  const rootStat = await fs.stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectPath = path.join(root, entry.name);
    try {
      const [manifest, status, stat] = await Promise.all([
        fs.readFile(path.join(projectPath, CODEX_VIDEO_MANIFEST_FILE), 'utf8').then(JSON.parse),
        fs.readFile(path.join(projectPath, CODEX_VIDEO_STATUS_FILE), 'utf8').then(JSON.parse),
        fs.stat(projectPath),
      ]);
      if (!manifest?.sourceDirectory) continue;
      const sourceRealPath = await fs.realpath(manifest.sourceDirectory).catch(
        () => path.resolve(manifest.sourceDirectory),
      );
      results.push({
        projectPath,
        sourceDirectory: path.resolve(manifest.sourceDirectory),
        sourceDirectoryRealPath: sourceRealPath,
        sourceDigest: manifest.sourceSnapshot?.digest || null,
        status: status?.status || 'unknown',
        generatedAt: status?.generatedAt || stat.mtime.toISOString(),
      });
    } catch {
      // An incomplete/corrupt project is handled by the project catalog, not source matching.
    }
  }
  return results.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
}

function matchExistingProject(source, projectSources) {
  const matches = projectSources.filter((project) => {
    const sameRealPath = project.sourceDirectoryRealPath === source.sourceDirectoryRealPath;
    const sameDigest = source.sourceSnapshot?.digest
      && project.sourceDigest === source.sourceSnapshot.digest;
    const sameNormalizedPath = path.resolve(project.sourceDirectory) === path.resolve(source.sourceDirectory);
    return sameRealPath || sameDigest || sameNormalizedPath;
  });
  return matches[0] || null;
}

function matchLatestTask(source, tasks) {
  return (tasks || []).find((task) => task.sourceDirectoryRealPath === source.sourceDirectoryRealPath
    || (task.sourceSnapshot?.digest && task.sourceSnapshot.digest === source.sourceSnapshot?.digest)) || null;
}

function classifyEpisode(item) {
  if (item.unreadable) return 'unreadable';
  if (item.empty) return 'empty';
  if (item.latestTask) {
    if (item.latestTask.status === 'completed') return 'completed';
    if (item.latestTask.status === 'completed_with_warnings') return 'completed_with_warnings';
    if (item.latestTask.status === 'failed') return 'failed';
    if (item.latestTask.status === 'awaiting_user_send'
      || item.latestTask.status === 'ready'
      || item.latestTask.status === 'launching_codex') return 'awaiting_user_send';
    if (!['draft', 'cancelled'].includes(item.latestTask.status)) return 'processing';
  }
  if (item.existingProject) return 'existing_result';
  if (item.warningCount > 0) return 'warning';
  return 'pending';
}

async function scanEpisode(directoryPath, options = {}) {
  const sourceDirectory = path.resolve(directoryPath);
  const sourceDirectoryRealPath = await fs.realpath(sourceDirectory);
  const warnings = [];
  const files = await walkEpisodeFiles(sourceDirectory, sourceDirectory, [], warnings);
  const narrative = await detectNarrativeStructure(sourceDirectory, files, { includeContext: false });
  warnings.push(...narrative.warnings);
  const counts = { image: 0, video: 0, audio: 0, support: 0, unsupported: 0 };
  let totalSizeBytes = 0;
  let totalVideoDurationSec = 0;
  let latestModifiedMs = 0;
  const mediaFacts = [];
  for (const file of files) {
    const kind = mediaKind(file.extension);
    const chapter = chapterForRelativePath(narrative.chapters, file.relativePath);
    counts[kind] += 1;
    totalSizeBytes += file.sizeBytes;
    latestModifiedMs = Math.max(latestModifiedMs, file.mtimeMs);
    if (kind === 'video') {
      const probe = await (options.probeMediaSafeImpl || probeMediaSafe)(file.absolutePath);
      if (probe.ok && Number.isFinite(probe.metadata?.durationSec)) {
        totalVideoDurationSec += probe.metadata.durationSec;
        mediaFacts.push({
          ...file,
          type: 'video',
          chapterId: chapter.chapterId,
          subchapterId: chapter.subchapterId,
          metadata: probe.metadata,
        });
      } else {
        warnings.push(`视频无法读取元数据：${file.relativePath}`);
      }
    } else if (kind === 'image') {
      mediaFacts.push({
        ...file,
        type: 'image',
        chapterId: chapter.chapterId,
        subchapterId: chapter.subchapterId,
        metadata: null,
      });
    }
  }
  const chapters = summarizeChapters(narrative.chapters, mediaFacts);
  const durationPolicy = computeDurationPolicy(chapters, {
    imageCount: counts.image,
    videoCount: counts.video,
    totalVideoDurationSec,
  }, narrative.projectBrief);
  let sourceSnapshot = null;
  try {
    sourceSnapshot = await (options.snapshotSourceImpl || snapshotSource)(sourceDirectoryRealPath);
  } catch (error) {
    warnings.push(`无法生成原始素材快照：${error.message}`);
  }
  const base = {
    name: path.basename(sourceDirectory),
    sourceDirectory,
    sourceDirectoryRealPath,
    safePathSummary: sourceDirectoryRealPath,
    counts,
    chapters,
    mediaFacts,
    projectBrief: narrative.projectBrief,
    briefFilesUsed: narrative.briefFilesUsed,
    durationPolicy,
    allowChapterInterleave: narrative.allowChapterInterleave,
    enforceChapterValidation: narrative.enforceChapterValidation,
    totalFileCount: files.length,
    totalVideoDurationSec: Number(totalVideoDurationSec.toFixed(3)),
    totalSizeBytes,
    latestModifiedAt: latestModifiedMs ? new Date(latestModifiedMs).toISOString() : null,
    unreadable: warnings.some((warning) => /^无法读取/.test(warning)),
    empty: files.length === 0,
    hasUnsupported: counts.unsupported > 0,
    warnings,
    warningCount: warnings.length + (counts.unsupported > 0 ? 1 : 0),
    sourceSnapshot,
  };
  const existingProject = matchExistingProject(base, options.projectSources || []);
  const latestTask = matchLatestTask(base, options.tasks || []);
  const result = { ...base, existingProject, latestTask };
  result.status = classifyEpisode(result);
  return result;
}

async function scanPendingMediaCatalog(options = {}) {
  const rootPath = path.resolve(options.rootPath || DEFAULT_PENDING_ROOT);
  const rootStat = await fs.stat(rootPath).catch(() => null);
  if (!rootStat) return { rootPath, exists: false, episodes: [], errors: [] };
  if (!rootStat.isDirectory()) {
    throw Object.assign(new Error('待处理素材根路径不是目录。'), { code: 'INVALID_PENDING_ROOT' });
  }
  const rootReal = await fs.realpath(rootPath);
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const projectSources = await readExistingProjectSources(options.projectRoot);
  const episodes = [];
  const errors = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
    if (!entry.isDirectory()) continue;
    const directoryPath = path.join(rootPath, entry.name);
    try {
      const realPath = await fs.realpath(directoryPath);
      if (!isInside(rootReal, realPath) || path.dirname(path.relative(rootReal, realPath)) !== '.') {
        errors.push({ sourceDirectory: directoryPath, message: '符号链接或路径越过待处理素材根目录。' });
        continue;
      }
      episodes.push(await scanEpisode(directoryPath, {
        ...options,
        projectSources,
      }));
    } catch (error) {
      errors.push({ sourceDirectory: directoryPath, message: error.message });
    }
  }
  return { rootPath, exists: true, episodes, errors };
}

module.exports = {
  AUDIO_EXTENSIONS,
  DEFAULT_PENDING_ROOT,
  IMAGE_EXTENSIONS,
  SUPPORT_EXTENSIONS,
  VIDEO_EXTENSIONS,
  classifyEpisode,
  matchExistingProject,
  mediaKind,
  readExistingProjectSources,
  scanEpisode,
  scanPendingMediaCatalog,
  walkEpisodeFiles,
};
