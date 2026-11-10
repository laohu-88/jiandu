const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const {
  ASSETS_DIR,
  ASSETS_FILE,
  BRIEF_FILE,
} = require('../constants');
const { writeProjectState } = require('./project-service');

const execFileAsync = promisify(execFile);

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac']);
const ASSET_ID_PATTERN = /^(A\d{3})(?:[-_\s.]|$)/i;

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

async function hasFfprobe() {
  try {
    await execFileAsync('ffprobe', ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
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

async function readAvMetadata(filePath) {
  const { stdout } = await execFileAsync(
    'ffprobe',
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

function nextAvailableId(usedIds) {
  for (let index = 1; index <= 999; index += 1) {
    const id = `A${String(index).padStart(3, '0')}`;
    if (!usedIds.has(id)) return id;
  }
  throw new Error('素材编号已超过 A999，无法继续自动编号。');
}

async function listAssetFiles(assetsPath) {
  const entries = await fs.readdir(assetsPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }));
}

async function assignAssetIds(assetsPath, filenames) {
  const usedIds = new Set();
  const duplicateIds = new Set();

  for (const filename of filenames) {
    const id = getId(filename);
    if (!id) continue;
    if (usedIds.has(id)) duplicateIds.add(id);
    usedIds.add(id);
  }

  if (duplicateIds.size > 0) {
    throw new Error(
      `检测到重复素材编号：${[...duplicateIds].join('、')}。请修改重复文件名后重新扫描。`,
    );
  }

  const renamed = [];
  for (const filename of filenames) {
    if (getId(filename)) {
      renamed.push(filename);
      continue;
    }

    const id = nextAvailableId(usedIds);
    const targetName = `${id}-${filename}`;
    await fs.rename(path.join(assetsPath, filename), path.join(assetsPath, targetName));
    usedIds.add(id);
    renamed.push(targetName);
  }

  return renamed.sort((a, b) => {
    const idCompare = (getId(a) || '').localeCompare(getId(b) || '');
    return idCompare || a.localeCompare(b, 'zh-CN', { numeric: true });
  });
}

async function buildAsset(projectPath, filename, ffprobeAvailable) {
  const filePath = path.join(projectPath, ASSETS_DIR, filename);
  const stat = await fs.stat(filePath);
  const ext = path.extname(filename).toLowerCase();
  const type = getAssetType(ext);

  let width = null;
  let height = null;
  let durationSec = null;

  if (type === 'image') {
    ({ width, height } = await readImageDimensions(filePath));
  } else if ((type === 'video' || type === 'audio') && ffprobeAvailable) {
    try {
      ({ width, height, durationSec } = await readAvMetadata(filePath));
    } catch {
      // 文件仍会进入列表；损坏或不兼容的媒体信息保持为空。
    }
  }

  return {
    id: getId(filename),
    filename,
    relativePath: path.join(ASSETS_DIR, filename),
    type,
    ext: ext.replace(/^\./, ''),
    sizeBytes: stat.size,
    width,
    height,
    aspectRatio: getAspectRatio(width, height),
    orientation: getOrientation(width, height),
    durationSec: type === 'image' ? null : durationSec,
    note: '',
  };
}

async function scanAssets(projectPath) {
  const assetsPath = path.join(projectPath, ASSETS_DIR);
  const stat = await fs.stat(assetsPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error('缺少“01-精选素材”目录，请先补齐项目目录。');
  }

  const filenames = await listAssetFiles(assetsPath);
  const assignedFilenames = await assignAssetIds(assetsPath, filenames);
  const ffprobeAvailable = await hasFfprobe();
  const assets = [];

  for (const filename of assignedFilenames) {
    assets.push(await buildAsset(projectPath, filename, ffprobeAvailable));
  }

  const payload = {
    projectPath,
    generatedAt: new Date().toISOString(),
    ffprobeAvailable,
    assets,
  };

  const outputPath = path.join(projectPath, ASSETS_FILE);
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
    '以下是本项目可用素材。请根据视频方向，帮我设计分段视频方案、分段口播文案、每段建议使用哪些素材。',
    '',
  );

  const outputPath = path.join(projectPath, BRIEF_FILE);
  await fs.writeFile(outputPath, lines.join('\n'), 'utf8');
  await writeProjectState(projectPath);
  return { outputPath };
}

module.exports = {
  getAssetType,
  getOrientation,
  getAspectRatio,
  getId,
  formatDuration,
  scanAssets,
  generateBrief,
};
