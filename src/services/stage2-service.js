const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const {
  APP_VERSION,
  CONTROL_DIR,
  VOICE_DIR,
  VIDEO_PLAN_FILE,
  SEGMENTS_FILE,
} = require('../constants');
const { writeProjectState } = require('./project-service');
const { backupCoreProjectJson } = require('./backup-service');
const {
  compileTimeline,
  getSegmentDuration,
  parsePauseDirectives,
} = require('./timeline-engine');

const execFileAsync = promisify(execFile);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac']);

const VOICE_LABELS = ['口播文案', '配音文案', '旁白', '口播', '文案'];
const ASSET_LABELS = ['素材建议', '建议素材', '画面素材', '素材需求', '可用素材'];
const ALL_FIELD_LABELS = [...VOICE_LABELS, ...ASSET_LABELS];

function normalizeText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').trim();
}

function parseHeading(line) {
  const clean = line.trim();
  let match = clean.match(/^#{0,6}\s*【\s*第?\s*(\d{1,2})\s*段?\s*】\s*(.*)$/);
  if (!match) {
    match = clean.match(/^#{0,6}\s*第\s*(\d{1,2})\s*段\s*(?:[：:｜|、.\-—]\s*)?(.*)$/);
  }
  if (!match) {
    match = clean.match(/^#{0,6}\s*(\d{1,2})\s*(?:[｜|]|[.\-、：:])\s*(.+)$/);
  }
  if (!match) return null;

  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < 1 || index > 99) return null;
  return {
    index,
    title: String(match[2] || '').replace(/^[-—：:｜|\s]+/, '').trim() || `第 ${index} 段`,
  };
}

function cleanFieldValue(value) {
  return value
    .join('\n')
    .replace(/^\s*[-*]\s*/gm, '')
    .trim();
}

function extractFields(rawText) {
  const lines = rawText.split('\n');
  const values = {
    voice: [],
    assets: [],
  };
  let activeField = null;

  for (const line of lines.slice(1)) {
    const labelMatch = line.match(
      new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*{1,2})?(${ALL_FIELD_LABELS.join('|')})(?:\\*{1,2})?\\s*[：:]?\\s*(.*)$`),
    );
    if (labelMatch) {
      activeField = VOICE_LABELS.includes(labelMatch[1]) ? 'voice' : 'assets';
      if (labelMatch[2].trim()) values[activeField].push(labelMatch[2].trim());
      continue;
    }

    if (activeField) {
      const otherField = line.match(/^\s*(?:[-*]\s*)?[\u4e00-\u9fa5A-Za-z]{2,12}\s*[：:]/);
      if (otherField) {
        activeField = null;
      } else {
        values[activeField].push(line);
      }
    }
  }

  return {
    voiceoverText: cleanFieldValue(values.voice),
    suggestedAssetsText: cleanFieldValue(values.assets),
  };
}

function inferVoiceover(rawText) {
  const lines = rawText.split('\n').slice(1);
  const candidates = [];
  let skippingAssets = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      skippingAssets = false;
      continue;
    }

    const assetLabel = ASSET_LABELS.find((label) =>
      new RegExp(`^(?:[-*]\\s*)?(?:\\*{1,2})?${label}(?:\\*{1,2})?\\s*[：:]?`).test(trimmed));
    if (assetLabel) {
      skippingAssets = true;
      continue;
    }
    if (skippingAssets) continue;

    const genericLabel = trimmed.match(/^(?:[-*]\s*)?(?:\*{1,2})?[\u4e00-\u9fa5A-Za-z]{2,12}(?:\*{1,2})?\s*[：:]\s*(.*)$/);
    if (genericLabel) {
      if (genericLabel[1]) candidates.push(genericLabel[1]);
      continue;
    }

    candidates.push(trimmed.replace(/^[-*]\s*/, ''));
  }

  return candidates.join('\n').trim() || rawText.trim();
}

function parseVideoPlan(planText, existingSegments = []) {
  const text = normalizeText(planText);
  if (!text) throw new Error('请先粘贴视频方案。');

  const lines = text.split('\n');
  const headings = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const heading = parseHeading(lines[lineIndex]);
    if (heading) headings.push({ ...heading, lineIndex });
  }

  if (headings.length === 0) {
    throw new Error('未识别到分段标题。请使用“第1段：标题”或“01｜标题”等格式后重试。');
  }

  const now = new Date().toISOString();
  const seenIndexes = new Set();
  const segments = headings.map((heading, position) => {
    if (seenIndexes.has(heading.index)) {
      throw new Error(`检测到重复分段编号：${String(heading.index).padStart(2, '0')}。`);
    }
    seenIndexes.add(heading.index);

    const endLine = headings[position + 1]?.lineIndex ?? lines.length;
    const rawText = lines.slice(heading.lineIndex, endLine).join('\n').trim();
    const fields = extractFields(rawText);
    const existing = existingSegments.find((segment) => segment.index === heading.index);
    const voiceoverText = fields.voiceoverText || inferVoiceover(rawText);
    const voiceFiles = existing?.voiceFiles || (existing?.voiceFile ? [existing.voiceFile] : []);
    const voiceTrack = existing?.voiceTrack || null;
    const initialTimeline = compileTimeline({
      voiceFile: existing?.voiceFile || null,
      voiceFiles,
      voiceTrack,
      voiceoverText,
    });

    return {
      id: String(heading.index).padStart(2, '0'),
      index: heading.index,
      title: heading.title,
      rawText,
      voiceoverText,
      suggestedAssetsText: fields.suggestedAssetsText,
      durationSec: getSegmentDuration({ timeline: initialTimeline }),
      voiceFile: existing?.voiceFile ?? null,
      voiceFiles,
      voiceTrack,
      timeline: initialTimeline,
      voiceStatus: existing?.voiceStatus || 'unmatched',
      voiceError: existing?.voiceError || null,
      voiceCandidates: existing?.voiceCandidates || [],
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
  });

  return {
    segments: segments.sort((a, b) => a.index - b.index),
    charCount: text.replace(/\s/g, '').length,
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function createSegmentsPayload(projectPath, segments, existing = {}) {
  const now = new Date().toISOString();
  return {
    version: APP_VERSION,
    projectPath,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    ffprobeAvailable: existing.ffprobeAvailable ?? null,
    segments,
    unmatchedVoiceFiles: existing.unmatchedVoiceFiles || [],
    voiceConflicts: existing.voiceConflicts || [],
  };
}

async function loadStage2State(projectPath) {
  const planPath = path.join(projectPath, VIDEO_PLAN_FILE);
  const segmentsPath = path.join(projectPath, SEGMENTS_FILE);
  const planText = await fs.readFile(planPath, 'utf8').catch(() => '');
  const payload = await readJson(segmentsPath);
  return {
    planText,
    segmentsPayload: payload,
  };
}

async function importVideoPlan(projectPath, planText) {
  const text = normalizeText(planText);
  const segmentsPath = path.join(projectPath, SEGMENTS_FILE);
  const existing = await readJson(segmentsPath);
  const parsed = parseVideoPlan(text, existing?.segments || []);
  const payload = createSegmentsPayload(projectPath, parsed.segments, existing || {});

  await backupCoreProjectJson(projectPath);
  await fs.mkdir(path.join(projectPath, CONTROL_DIR), { recursive: true });
  await fs.writeFile(path.join(projectPath, VIDEO_PLAN_FILE), `${text}\n`, 'utf8');
  await fs.writeFile(segmentsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeProjectState(projectPath);

  return {
    ...payload,
    charCount: parsed.charCount,
    planPath: path.join(projectPath, VIDEO_PLAN_FILE),
    segmentsPath,
    warning: parsed.segments.length >= 4 && parsed.segments.length <= 8
      ? null
      : `当前解析出 ${parsed.segments.length} 段；建议视频方案使用 4–8 段。`,
  };
}

async function hasFfprobe() {
  try {
    await execFileAsync('ffprobe', ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function readAudioDuration(filePath) {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ],
    { timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration)) throw new Error('ffprobe 未返回有效时长。');
  return Number(duration.toFixed(2));
}

function getVoiceSegmentIndex(filename) {
  const match = filename.match(/^(\d{1,2})(?=\D|$)/);
  if (!match) return null;
  const index = Number(match[1]);
  return index > 0 ? index : null;
}

async function scanVoiceFiles(projectPath) {
  const segmentsPath = path.join(projectPath, SEGMENTS_FILE);
  const existing = await readJson(segmentsPath);
  if (!existing?.segments?.length) {
    throw new Error('尚未导入视频方案，请先导入并解析方案。');
  }

  const voicePath = path.join(projectPath, VOICE_DIR);
  const voiceStat = await fs.stat(voicePath).catch(() => null);
  if (!voiceStat?.isDirectory()) {
    throw new Error('缺少“02-配音”目录，请先补齐项目目录。');
  }
  await backupCoreProjectJson(projectPath);

  const entries = await fs.readdir(voicePath, { withFileTypes: true });
  const filenames = entries
    .filter((entry) =>
      entry.isFile()
      && !entry.name.startsWith('.')
      && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }));

  const candidatesByIndex = new Map();
  const unmatchedVoiceFiles = [];
  const validIndexes = new Set(existing.segments.map((segment) => segment.index));

  for (const filename of filenames) {
    const index = getVoiceSegmentIndex(filename);
    if (!index || !validIndexes.has(index)) {
      unmatchedVoiceFiles.push(path.join(VOICE_DIR, filename));
      continue;
    }
    const candidates = candidatesByIndex.get(index) || [];
    candidates.push(filename);
    candidatesByIndex.set(index, candidates);
  }

  const ffprobeAvailable = await hasFfprobe();
  const voiceConflicts = [];
  const now = new Date().toISOString();
  const segments = [];

  for (const oldSegment of existing.segments) {
    const segment = {
      ...oldSegment,
      durationSec: null,
      voiceFile: null,
      voiceFiles: [],
      voiceTrack: null,
      timeline: [],
      voiceStatus: 'unmatched',
      voiceError: null,
      voiceCandidates: [],
      updatedAt: now,
    };
    const candidates = candidatesByIndex.get(segment.index) || [];

    if (candidates.length >= 1) {
      segment.voiceFiles = candidates.map((filename) => path.join(VOICE_DIR, filename));
      segment.voiceFile = segment.voiceFiles[0];
      if (!ffprobeAvailable) {
        segment.voiceStatus = 'read_failed';
        segment.voiceError = '找不到 ffprobe，无法读取配音时长。';
      } else {
        try {
          const voiceDurations = await Promise.all(
            candidates.map((filename) => readAudioDuration(path.join(voicePath, filename))),
          );
          segment.voiceTrack = {
            type: 'audio',
            clips: segment.voiceFiles.map((file, index) => ({
              file,
              durationSec: voiceDurations[index],
            })),
          };
          segment.timeline = compileTimeline(segment);
          segment.durationSec = getSegmentDuration(segment);
          segment.voiceStatus = 'matched';
        } catch (error) {
          segment.voiceStatus = 'read_failed';
          segment.voiceError = `配音时长读取失败：${error.message}`;
        }
      }
    }
    segments.push(segment);
  }

  const payload = {
    ...existing,
    version: APP_VERSION,
    projectPath,
    updatedAt: now,
    ffprobeAvailable,
    segments,
    unmatchedVoiceFiles,
    voiceConflicts,
  };
  await fs.writeFile(segmentsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeProjectState(projectPath);

  return {
    ...payload,
    matchedCount: segments.filter((segment) => segment.voiceStatus === 'matched').length,
    warning: ffprobeAvailable ? null : '找不到 ffprobe，无法读取配音时长。',
  };
}

module.exports = {
  parseHeading,
  parseVideoPlan,
  getVoiceSegmentIndex,
  parsePauseDirectives,
  loadStage2State,
  importVideoPlan,
  scanVoiceFiles,
};
