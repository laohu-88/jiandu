const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');

const {
  ASSETS_DIR,
  ASSETS_FILE,
  BRIEF_FILE,
} = require('../constants');
const { writeProjectState } = require('./project-service');
const { resolveToolPath } = require('./media-tool-service');

const execFileAsync = promisify(execFile);

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.tif', '.tiff', '.bmp',
]);
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mts', '.m2ts',
]);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac']);
const ASSET_ID_PATTERN = /^(A\d{3})(?:[-_\s.]|$)/i;
const FINGERPRINT_MODE = 'size-mtime-path-v1';
const LEGACY_FINGERPRINT_MODE = 'legacy-size-path-v1';
const REVIEW_STATUSES = new Set(['unreviewed', 'keep', 'maybe', 'reject']);
const REVIEW_PATCH_FIELDS = new Set(['reviewStatus', 'rating', 'tags', 'note']);
const TEXT_PREVIEW_EXTENSIONS = new Set(['.txt', '.md', '.srt', '.vtt', '.csv', '.json']);
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;

function getAssetType(ext) {
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return 'unknown';
}

function getOrientation(width, height) {
  if (!width || !height) return 'unknown';
  if (width === height) return 'square';
  return width > height ? 'horizontal' : 'vertical';
}

function getAspectRatio(width, height) {
  if (!width || !height) return null;
  return Number((width / height).toFixed(4));
}

async function detectFfprobePath() {
  const ffprobePath = await resolveToolPath('ffprobe');
  if (!ffprobePath) return null;
  try {
    await execFileAsync(ffprobePath, ['-version'], { timeout: 5000 });
    return ffprobePath;
  } catch {
    return null;
  }
}

async function readImageDimensions(filePath) {
  try {
    const { stdout } = await execFileAsync(
      'sips',
      ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]) || null;
    const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]) || null;
    return { width, height };
  } catch {
    return { width: null, height: null };
  }
}

async function readAvMetadata(filePath, ffprobePath) {
  const { stdout } = await execFileAsync(
    ffprobePath,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_entries',
      'format=duration:stream=codec_type,width,height',
      filePath,
    ],
    { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout);
  const videoStream = data.streams?.find((stream) => stream.codec_type === 'video');
  const duration = Number(data.format?.duration);
  return {
    width: Number(videoStream?.width) || null,
    height: Number(videoStream?.height) || null,
    durationSec: Number.isFinite(duration) ? Number(duration.toFixed(3)) : null,
  };
}

function getId(filename) {
  return filename.match(ASSET_ID_PATTERN)?.[1]?.toUpperCase() || null;
}

function createStableId() {
  return `asset_${randomUUID()}`;
}

function createFingerprint(sizeBytes, mtimeMs, relativePath) {
  return `${sizeBytes}:${mtimeMs}:${relativePath}`;
}

function getAssetRelativePath(asset) {
  if (asset?.relativePath) return asset.relativePath;
  if (asset?.filename) return path.join(ASSETS_DIR, asset.filename);
  return null;
}

async function readAssetsIndex(outputPath) {
  try {
    const payload = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function normalizeTags(tags) {
  const normalized = [];
  const seen = new Set();

  for (const tag of tags) {
    const value = tag.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function getReviewFields(asset) {
  const hasValidTags = Array.isArray(asset?.tags)
    && asset.tags.every((tag) => typeof tag === 'string');
  return {
    reviewStatus: REVIEW_STATUSES.has(asset?.reviewStatus) ? asset.reviewStatus : 'unreviewed',
    rating: Number.isInteger(asset?.rating) && asset.rating >= 0 && asset.rating <= 5
      ? asset.rating
      : 0,
    tags: hasValidTags ? normalizeTags(asset.tags) : [],
    note: typeof asset?.note === 'string' ? asset.note : '',
    reviewUpdatedAt: typeof asset?.reviewUpdatedAt === 'string' ? asset.reviewUpdatedAt : null,
  };
}

function validateReviewPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('审核内容必须是对象。');
  }

  const fields = Object.keys(patch);
  const unsupportedFields = fields.filter((field) => !REVIEW_PATCH_FIELDS.has(field));
  if (unsupportedFields.length > 0) {
    throw new Error(`审核更新包含不允许修改的字段：${unsupportedFields.join('、')}。`);
  }
  if (fields.length === 0) {
    throw new Error('请至少提供一个审核字段。');
  }

  const normalized = {};
  if (Object.hasOwn(patch, 'reviewStatus')) {
    if (!REVIEW_STATUSES.has(patch.reviewStatus)) {
      throw new Error('reviewStatus 必须是 unreviewed、keep、maybe 或 reject。');
    }
    normalized.reviewStatus = patch.reviewStatus;
  }
  if (Object.hasOwn(patch, 'rating')) {
    if (!Number.isInteger(patch.rating) || patch.rating < 0 || patch.rating > 5) {
      throw new Error('rating 必须是 0 到 5 的整数。');
    }
    normalized.rating = patch.rating;
  }
  if (Object.hasOwn(patch, 'tags')) {
    if (!Array.isArray(patch.tags)
      || !patch.tags.every((tag) => typeof tag === 'string')) {
      throw new Error('tags 必须是字符串数组。');
    }
    normalized.tags = normalizeTags(patch.tags);
  }
  if (Object.hasOwn(patch, 'note')) {
    if (typeof patch.note !== 'string') {
      throw new Error('note 必须是字符串。');
    }
    normalized.note = patch.note;
  }

  return normalized;
}

async function listAssetFiles(assetsPath) {
  const entries = await fs.readdir(assetsPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }));
}

async function buildAsset(projectPath, filename, ffprobePath) {
  const filePath = path.join(projectPath, ASSETS_DIR, filename);
  const stat = await fs.stat(filePath);
  const ext = path.extname(filename).toLowerCase();
  const type = getAssetType(ext);
  const relativePath = path.join(ASSETS_DIR, filename);

  let width = null;
  let height = null;
  let durationSec = null;

  if (type === 'image') {
    ({ width, height } = await readImageDimensions(filePath));
  } else if ((type === 'video' || type === 'audio') && ffprobePath) {
    try {
      ({ width, height, durationSec } = await readAvMetadata(filePath, ffprobePath));
    } catch {
      // 文件仍会进入列表；损坏或不兼容的媒体信息保持为空。
    }
  }

  return {
    id: getId(filename),
    filename,
    relativePath,
    type,
    ext: ext.replace(/^\./, ''),
    sizeBytes: stat.size,
    width,
    height,
    aspectRatio: getAspectRatio(width, height),
    orientation: getOrientation(width, height),
    durationSec: type === 'image' ? null : durationSec,
    fingerprint: createFingerprint(stat.size, stat.mtimeMs, relativePath),
    fingerprintMode: FINGERPRINT_MODE,
  };
}

function mergeAssetIndex(currentAssets, previousPayload, scannedAt) {
  const previousAssets = Array.isArray(previousPayload?.assets) ? previousPayload.assets : [];
  const previousByPath = new Map();

  for (const asset of previousAssets) {
    const relativePath = getAssetRelativePath(asset);
    if (relativePath) previousByPath.set(relativePath, asset);
  }

  const currentPaths = new Set();
  const assets = currentAssets.map((asset) => {
    const previous = previousByPath.get(asset.relativePath);
    currentPaths.add(asset.relativePath);
    return {
      ...asset,
      ...getReviewFields(previous),
      stableId: previous?.stableId || createStableId(),
      availability: 'available',
      firstSeenAt: previous?.firstSeenAt || previousPayload?.generatedAt || scannedAt,
      lastSeenAt: scannedAt,
      missingSince: null,
    };
  });

  for (const previous of previousAssets) {
    const relativePath = getAssetRelativePath(previous);
    if (relativePath && currentPaths.has(relativePath)) continue;

    assets.push({
      ...previous,
      ...getReviewFields(previous),
      relativePath,
      stableId: previous.stableId || createStableId(),
      availability: 'missing',
      firstSeenAt: previous.firstSeenAt || previousPayload?.generatedAt || scannedAt,
      lastSeenAt: previous.lastSeenAt || previousPayload?.generatedAt || scannedAt,
      missingSince: previous.missingSince || scannedAt,
      fingerprint: previous.fingerprint
        || createFingerprint(previous.sizeBytes ?? '', '', relativePath || ''),
      fingerprintMode: previous.fingerprintMode || LEGACY_FINGERPRINT_MODE,
    });
  }

  return assets;
}

async function scanAssets(projectPath) {
  const assetsPath = path.join(projectPath, ASSETS_DIR);
  const stat = await fs.stat(assetsPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error('缺少“01-精选素材”目录，请先补齐项目目录。');
  }

  const outputPath = path.join(projectPath, ASSETS_FILE);
  const previousPayload = await readAssetsIndex(outputPath);
  const filenames = await listAssetFiles(assetsPath);
  const ffprobePath = await detectFfprobePath();
  const ffprobeAvailable = Boolean(ffprobePath);
  const currentAssets = [];

  for (const filename of filenames) {
    currentAssets.push(await buildAsset(projectPath, filename, ffprobePath));
  }

  const generatedAt = new Date().toISOString();
  const assets = mergeAssetIndex(currentAssets, previousPayload, generatedAt);
  const payload = {
    schemaVersion: 2,
    projectPath,
    generatedAt,
    ffprobeAvailable,
    assets,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeProjectState(projectPath);

  return {
    ...payload,
    outputPath,
    warning: ffprobeAvailable
      ? null
      : '未检测到 ffprobe：视频尺寸和时长无法读取。请安装 ffmpeg 后重新扫描。',
  };
}

async function loadAssetIndex(projectPath) {
  const outputPath = path.join(projectPath, ASSETS_FILE);
  try {
    return JSON.parse(await fs.readFile(outputPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        schemaVersion: 2,
        projectPath,
        generatedAt: null,
        ffprobeAvailable: null,
        assets: [],
      };
    }
    throw error;
  }
}

function isPathInside(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === ''
    || (!path.isAbsolute(relativePath)
      && relativePath !== '..'
      && !relativePath.startsWith(`..${path.sep}`));
}

async function resolvePreviewAsset(projectPath, stableId) {
  if (typeof projectPath !== 'string' || !projectPath) {
    throw new Error('projectPath 不能为空。');
  }
  if (typeof stableId !== 'string' || !stableId) {
    throw new Error('stableId 不能为空。');
  }

  const payload = await loadAssetIndex(projectPath);
  const asset = Array.isArray(payload.assets)
    ? payload.assets.find((item) => item.stableId === stableId)
    : null;
  if (!asset) {
    throw new Error(`未找到 stableId 为 ${stableId} 的素材。`);
  }
  if (asset.availability === 'missing') {
    throw new Error(`素材 ${stableId} 已标记为 missing，无法预览。`);
  }

  const relativePath = getAssetRelativePath(asset);
  if (!relativePath) {
    throw new Error(`素材 ${stableId} 缺少有效路径，无法预览。`);
  }

  const resolvedProjectPath = path.resolve(projectPath);
  const resolvedAssetPath = path.resolve(resolvedProjectPath, relativePath);
  if (!isPathInside(resolvedProjectPath, resolvedAssetPath)) {
    throw new Error(`素材 ${stableId} 的路径位于项目目录外，拒绝访问。`);
  }

  let realProjectPath;
  let absolutePath;
  try {
    realProjectPath = await fs.realpath(resolvedProjectPath);
    absolutePath = await fs.realpath(resolvedAssetPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`素材 ${stableId} 的文件不存在，无法预览。`);
    }
    throw error;
  }
  if (!isPathInside(realProjectPath, absolutePath)) {
    throw new Error(`素材 ${stableId} 的真实路径位于项目目录外，拒绝访问。`);
  }

  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`素材 ${stableId} 不是普通文件，无法预览。`);
  }

  return { asset, absolutePath, stat };
}

async function getAssetPreview(projectPath, stableId) {
  const { asset, absolutePath, stat } = await resolvePreviewAsset(projectPath, stableId);
  const filename = asset.filename || path.basename(absolutePath);
  return {
    stableId: asset.stableId,
    type: asset.type || 'unknown',
    filename,
    absolutePath,
    fileUrl: pathToFileURL(absolutePath).href,
    ext: asset.ext || path.extname(filename).replace(/^\./, '').toLowerCase(),
    sizeBytes: asset.sizeBytes ?? stat.size,
    durationSec: asset.durationSec ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
    metadataError: asset.metadataError ?? null,
  };
}

async function readTextPreview(projectPath, stableId, maxBytes = MAX_TEXT_PREVIEW_BYTES) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_TEXT_PREVIEW_BYTES) {
    throw new Error(`maxBytes 必须是 1 到 ${MAX_TEXT_PREVIEW_BYTES} 之间的整数。`);
  }

  const { asset, absolutePath, stat } = await resolvePreviewAsset(projectPath, stableId);
  const ext = path.extname(absolutePath).toLowerCase();
  if (!TEXT_PREVIEW_EXTENSIONS.has(ext)) {
    throw new Error(`素材 ${stableId} 不是支持的文本类型，拒绝读取二进制内容。`);
  }

  const handle = await fs.open(absolutePath, 'r');
  let readResult;
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    readResult = await handle.read(buffer, 0, buffer.length, 0);
    const bytesRead = Math.min(readResult.bytesRead, maxBytes);
    return {
      stableId: asset.stableId,
      filename: asset.filename || path.basename(absolutePath),
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: readResult.bytesRead > maxBytes || stat.size > maxBytes,
      bytesRead,
    };
  } finally {
    await handle.close();
  }
}

async function updateAssetReview(projectPath, stableId, patch) {
  const normalizedPatch = validateReviewPatch(patch);
  const outputPath = path.join(projectPath, ASSETS_FILE);
  const payload = await readAssetsIndex(outputPath);
  if (!payload || !Array.isArray(payload.assets)) {
    throw new Error('尚未生成 assets.json，请先扫描精选素材。');
  }

  const assetIndex = payload.assets.findIndex((asset) => asset.stableId === stableId);
  if (assetIndex < 0) {
    throw new Error(`未找到 stableId 为 ${stableId} 的素材。`);
  }

  const asset = {
    ...payload.assets[assetIndex],
    ...normalizedPatch,
    reviewUpdatedAt: new Date().toISOString(),
  };
  const assets = [...payload.assets];
  assets[assetIndex] = asset;
  await fs.writeFile(outputPath, `${JSON.stringify({ ...payload, assets }, null, 2)}\n`, 'utf8');

  return { asset, outputPath };
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remaining.toFixed(2).padStart(5, '0')}`;
}

function displayType(type) {
  return {
    image: '图片',
    video: '视频',
    audio: '音频',
    unknown: '未知',
  }[type] || '未知';
}

function displayOrientation(orientation) {
  return {
    horizontal: '横屏',
    vertical: '竖屏',
    square: '方形',
    unknown: '未知',
  }[orientation] || '未知';
}

function stripIdPrefix(filename) {
  return filename.replace(/^A\d{3}[-_\s.]?/i, '');
}

async function generateBrief(projectPath) {
  const assetsJsonPath = path.join(projectPath, ASSETS_FILE);
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(assetsJsonPath, 'utf8'));
  } catch {
    throw new Error('尚未生成 assets.json，请先扫描精选素材。');
  }

  const projectName = path.basename(projectPath);
  const lines = [
    '# 素材简报',
    '',
    `项目：${projectName}`,
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '## 素材列表',
    '',
  ];

  if (!payload.assets?.length) {
    lines.push('暂无素材');
  } else {
    for (const asset of payload.assets) {
      const size = asset.width && asset.height ? `${asset.width}x${asset.height}` : '尺寸未知';
      const fields = [
        asset.id,
        displayType(asset.type),
        displayOrientation(asset.orientation),
        size,
      ];
      if (asset.type === 'video' || asset.type === 'audio') {
        fields.push(asset.durationSec == null ? '时长未知' : formatDuration(asset.durationSec));
      }
      fields.push(stripIdPrefix(asset.filename));
      lines.push(fields.join('｜'));
    }
  }

  lines.push(
    '',
    '## 给 GPT 的使用说明',
    '',
    '以下是本项目可用素材。请根据实际画面设计无口播视觉叙事，判断素材用途、镜头顺序和少量轻字幕建议。',
    '',
  );

  const outputPath = path.join(projectPath, BRIEF_FILE);
  await fs.writeFile(outputPath, lines.join('\n'), 'utf8');
  await writeProjectState(projectPath);
  return { outputPath };
}

module.exports = {
  createStableId,
  getAssetType,
  getOrientation,
  getAspectRatio,
  getId,
  formatDuration,
  scanAssets,
  loadAssetIndex,
  resolvePreviewAsset,
  getAssetPreview,
  readTextPreview,
  updateAssetReview,
  generateBrief,
};
