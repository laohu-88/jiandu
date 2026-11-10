const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const {
  APP_VERSION,
  PROJECT_FILE,
  SEGMENTS_FILE,
  ASSIGNMENTS_FILE,
  ROUGHCUT_STATUS_FILE,
  FCP_EXPORT_DIR,
  SUBTITLE_DIR,
  SUBTITLE_CONFIG_FILE,
  SUBTITLE_STATUS_FILE,
  SUBTITLE_ERROR_FILE,
  RAW_SRT_FILE,
  RAW_TXT_FILE,
  FINAL_CN_SRT_FILE,
  FINAL_CN_TXT_FILE,
  SUBTITLE_REPORT_FILE,
} = require('../constants');
const { writeProjectState } = require('./project-service');
const { compileTimeline } = require('./timeline-engine');
const { resolveToolPath } = require('./stage7-service');

const execFileAsync = promisify(execFile);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);
const GENERATED_EXTENSIONS = new Set(['.srt', '.txt', '.vtt', '.json', '.tsv']);
const PUNCTUATION_MAP = {
  ',': '，',
  '.': '。',
  '?': '？',
  '!': '！',
  ':': '：',
  ';': '；',
};
const CHINESE_PUNCTUATION = new Set(['，', '。', '？', '！', '：', '；']);

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function pathIsFile(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile());
}

async function ensureSubtitleDir(projectPath) {
  await fs.mkdir(path.join(projectPath, SUBTITLE_DIR), { recursive: true });
}

function normalizeProjectRelative(projectPath, filePath) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(projectPath, absolute);
  return relative.startsWith('..') || path.isAbsolute(relative)
    ? absolute
    : relative;
}

function getDefaultConfig(existing = {}) {
  return {
    command: existing.command || 'ww',
    outputDir: existing.outputDir || SUBTITLE_DIR,
    lastVideo: existing.lastVideo || '',
  };
}

async function writeSubtitleConfig(projectPath, configPatch = {}) {
  const configPath = path.join(projectPath, SUBTITLE_CONFIG_FILE);
  const existing = await readJson(configPath);
  const config = getDefaultConfig({ ...(existing || {}), ...configPatch });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await writeProjectState(projectPath);
  return config;
}

function createSubtitleStatus(patch = {}) {
  const now = new Date().toISOString();
  return {
    version: APP_VERSION,
    status: patch.status || 'pending',
    inputVideo: patch.inputVideo ?? '',
    rawSrt: patch.rawSrt ?? RAW_SRT_FILE,
    finalSrt: patch.finalSrt ?? null,
    finalTxt: patch.finalTxt ?? null,
    report: patch.report ?? null,
    rawCount: patch.rawCount ?? 0,
    finalCount: patch.finalCount ?? 0,
    splitCount: patch.splitCount ?? 0,
    generatedAt: patch.generatedAt ?? null,
    updatedAt: now,
    error: patch.error ?? null,
    timeline: patch.timeline ?? null,
  };
}

async function loadProjectTimeline(projectPath) {
  const [segmentsPayload, assignmentsPayload, roughcutStatusPayload] = await Promise.all([
    readJson(path.join(projectPath, SEGMENTS_FILE)),
    readJson(path.join(projectPath, ASSIGNMENTS_FILE)),
    readJson(path.join(projectPath, ROUGHCUT_STATUS_FILE)),
  ]);
  return compileTimeline({
    segments: (segmentsPayload?.segments || []).map((segment) => {
      const assignment = assignmentsPayload?.segments?.find(
        (entry) => entry.segmentId === segment.id,
      );
      const roughcut = roughcutStatusPayload?.segments?.find(
        (entry) => entry.segmentId === segment.id,
      );
      return {
        segment,
        items: assignment?.items || [],
        programFile: roughcut?.outputFile,
      };
    }),
  });
}

async function writeSubtitleStatus(projectPath, payload) {
  const status = {
    ...payload,
    version: APP_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(projectPath, SUBTITLE_STATUS_FILE),
    `${JSON.stringify(status, null, 2)}\n`,
    'utf8',
  );
  await writeProjectState(projectPath);
  return status;
}

async function appendSubtitleErrorLog(projectPath, details) {
  const lines = [
    '',
    '============================================================',
    `时间：${new Date().toISOString()}`,
    `输入视频：${details.inputVideo || '—'}`,
    `输入 SRT：${details.inputSrt || '—'}`,
    `字幕命令：${details.command || '—'}`,
    'stderr 或错误原因：',
    details.stderr || details.error || '未知错误',
    '文件移动/收纳情况：',
    details.fileMoves || '—',
    '',
  ];
  await fs.appendFile(
    path.join(projectPath, SUBTITLE_ERROR_FILE),
    lines.join('\n'),
    'utf8',
  );
}

async function loadSubtitleState(projectPath) {
  await ensureSubtitleDir(projectPath);
  const config = await writeSubtitleConfig(projectPath);
  const existingStatus = await readJson(path.join(projectPath, SUBTITLE_STATUS_FILE));
  const timeline = await loadProjectTimeline(projectPath);
  const status = existingStatus
    ? {
      ...createSubtitleStatus(existingStatus),
      ...existingStatus,
      version: APP_VERSION,
      timeline,
    }
    : await writeSubtitleStatus(projectPath, createSubtitleStatus({
      inputVideo: config.lastVideo || '',
      timeline,
    }));

  return {
    config,
    status,
    timeline,
    files: {
      rawSrtExists: await pathIsFile(path.join(projectPath, RAW_SRT_FILE)),
      finalSrtExists: await pathIsFile(path.join(projectPath, FINAL_CN_SRT_FILE)),
      finalTxtExists: await pathIsFile(path.join(projectPath, FINAL_CN_TXT_FILE)),
      reportExists: await pathIsFile(path.join(projectPath, SUBTITLE_REPORT_FILE)),
    },
  };
}

function parseTimestamp(value) {
  const match = String(value).trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) throw new Error(`无效 SRT 时间码：${value}`);
  const [, hours, minutes, seconds, millis] = match.map(Number);
  return (((hours * 60 + minutes) * 60 + seconds) * 1000) + millis;
}

function formatTimestamp(ms) {
  const safeMs = Math.max(0, Math.round(ms));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1000);
  const millis = safeMs % 1000;
  return `${String(hours).padStart(2, '0')}:`
    + `${String(minutes).padStart(2, '0')}:`
    + `${String(seconds).padStart(2, '0')},`
    + `${String(millis).padStart(3, '0')}`;
}

function parseSrt(content) {
  const blocks = String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .filter(Boolean);

  return blocks.map((block, index) => {
    const lines = block.split('\n');
    const sequence = /^\d+$/.test(lines[0]?.trim()) ? lines.shift().trim() : String(index + 1);
    const timeLine = lines.shift();
    const timeMatch = timeLine?.match(
      /^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/,
    );
    if (!timeMatch) throw new Error(`第 ${index + 1} 条字幕缺少有效时间码。`);
    return {
      sequence,
      startMs: parseTimestamp(timeMatch[1]),
      endMs: parseTimestamp(timeMatch[2]),
      text: lines.join('\n').trim(),
    };
  });
}

function displayLength(text) {
  return Array.from(String(text || '').replace(/\s+/g, '')).length;
}

function normalizeSubtitleText(text) {
  let conversionCount = 0;
  const converted = Array.from(String(text || '').replace(/\s*\n+\s*/g, ' ').trim())
    .map((char) => {
      if (PUNCTUATION_MAP[char]) {
        conversionCount += 1;
        return PUNCTUATION_MAP[char];
      }
      return char;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return { text: converted, conversionCount };
}

function splitLongPhrase(phrase, maxChars = 36) {
  const tokens = String(phrase || '').match(/[A-Za-z0-9+#]+|\s+|./gu) || [];
  const chunks = [];
  let current = '';
  for (const token of tokens) {
    const candidate = `${current}${token}`;
    if (current && displayLength(candidate) > maxChars) {
      chunks.push(current.trim());
      current = token.trimStart();
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.flatMap((chunk) => {
    if (displayLength(chunk) <= maxChars) return [chunk];
    const chars = Array.from(chunk);
    const result = [];
    let current = '';
    for (const char of chars) {
      if (current && displayLength(current + char) > maxChars) {
        result.push(current.trim());
        current = char;
      } else {
        current += char;
      }
    }
    if (current.trim()) result.push(current.trim());
    return result;
  });
}

function splitByPunctuation(text) {
  const pieces = [];
  let current = '';
  for (const char of Array.from(text)) {
    current += char;
    if (CHINESE_PUNCTUATION.has(char)) {
      pieces.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

function splitIntoSubtitleChunks(text, maxChars = 36) {
  const punctuationPieces = splitByPunctuation(text);
  const pieces = punctuationPieces.flatMap((piece) =>
    (displayLength(piece) > maxChars ? splitLongPhrase(piece, maxChars) : [piece]));
  const chunks = [];
  let current = '';

  for (const piece of pieces) {
    const candidate = `${current}${piece}`;
    if (current && displayLength(candidate) > maxChars) {
      chunks.push(current.trim());
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [''];
}

function findLineBreakIndex(text, maxLineChars = 18) {
  const chars = Array.from(text);
  const length = displayLength(text);
  if (length <= maxLineChars) return -1;
  let visible = 0;
  const candidates = [];

  for (let index = 0; index < chars.length; index += 1) {
    if (!/\s/.test(chars[index])) visible += 1;
    if (visible > maxLineChars) break;
    if (CHINESE_PUNCTUATION.has(chars[index]) || /\s/.test(chars[index])) {
      candidates.push(index + 1);
    }
  }
  const half = length / 2;
  if (candidates.length) {
    return candidates.sort((a, b) =>
      Math.abs(displayLength(text.slice(0, a)) - half)
      - Math.abs(displayLength(text.slice(0, b)) - half))[0];
  }

  visible = 0;
  for (let index = 0; index < chars.length; index += 1) {
    if (!/\s/.test(chars[index])) visible += 1;
    if (visible >= Math.min(maxLineChars, Math.ceil(half))) return index + 1;
  }
  return -1;
}

function formatSubtitleLines(text, maxLineChars = 18) {
  const clean = String(text || '').trim();
  if (displayLength(clean) <= maxLineChars) return [clean];
  const breakIndex = findLineBreakIndex(clean, maxLineChars);
  if (breakIndex < 0) return [clean];
  const first = clean.slice(0, breakIndex).trim();
  const second = clean.slice(breakIndex).trim();
  return [first, second].filter(Boolean).slice(0, 2);
}

function allocateDurations(totalMs, weights, minMs = 600) {
  const count = weights.length;
  if (count <= 1) return [totalMs];
  const totalWeight = weights.reduce((sum, value) => sum + Math.max(1, value), 0);
  if (totalMs < count * minMs) {
    const durations = weights.map((weight) => totalMs * (Math.max(1, weight) / totalWeight));
    const rounded = durations.map(Math.round);
    rounded[rounded.length - 1] += totalMs - rounded.reduce((sum, value) => sum + value, 0);
    return rounded;
  }

  const durations = new Array(count).fill(null);
  let remainingMs = totalMs;
  let remainingWeight = totalWeight;
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < count; index += 1) {
      if (durations[index] !== null) continue;
      const proposed = remainingMs * (Math.max(1, weights[index]) / remainingWeight);
      if (proposed < minMs) {
        durations[index] = minMs;
        remainingMs -= minMs;
        remainingWeight -= Math.max(1, weights[index]);
        changed = true;
      }
    }
  }
  for (let index = 0; index < count; index += 1) {
    if (durations[index] === null) {
      durations[index] = remainingMs * (Math.max(1, weights[index]) / remainingWeight);
    }
  }
  const rounded = durations.map(Math.round);
  rounded[rounded.length - 1] += totalMs - rounded.reduce((sum, value) => sum + value, 0);
  return rounded;
}

function processSrtContent(content) {
  const rawEntries = parseSrt(content);
  const finalEntries = [];
  let splitCount = 0;
  let punctuationConversionCount = 0;

  for (const entry of rawEntries) {
    const normalized = normalizeSubtitleText(entry.text);
    punctuationConversionCount += normalized.conversionCount;
    const chunks = splitIntoSubtitleChunks(normalized.text, 36);
    if (chunks.length > 1) splitCount += 1;
    const weights = chunks.map((chunk) => displayLength(chunk));
    const durations = allocateDurations(entry.endMs - entry.startMs, weights);
    let cursor = entry.startMs;

    chunks.forEach((chunk, index) => {
      const startMs = cursor;
      const endMs = index === chunks.length - 1
        ? entry.endMs
        : Math.min(entry.endMs, cursor + durations[index]);
      cursor = endMs;
      finalEntries.push({
        startMs,
        endMs,
        lines: formatSubtitleLines(chunk, 18),
      });
    });
  }

  const metrics = {
    rawCount: rawEntries.length,
    finalCount: finalEntries.length,
    splitCount,
    punctuationConversionCount,
    longestChars: finalEntries.reduce(
      (max, entry) => Math.max(max, displayLength(entry.lines.join(''))),
      0,
    ),
    hasOverTwoLines: finalEntries.some((entry) => entry.lines.length > 2),
    hasOver36Chars: finalEntries.some((entry) => displayLength(entry.lines.join('')) > 36),
  };

  return { rawEntries, finalEntries, metrics };
}

function renderSrt(entries) {
  return `${entries.map((entry, index) => [
    String(index + 1),
    `${formatTimestamp(entry.startMs)} --> ${formatTimestamp(entry.endMs)}`,
    ...entry.lines,
  ].join('\n')).join('\n\n')}\n`;
}

function renderTxt(entries) {
  return `${entries.map((entry) => entry.lines.join(' ')).join('\n')}\n`;
}

function renderReport({
  rawSrt,
  finalSrt,
  finalTxt,
  processedAt,
  metrics,
}) {
  return [
    '# 字幕整理报告',
    '',
    `原始字幕文件：${rawSrt}`,
    `输出字幕文件：${finalSrt}`,
    `输出纯文本：${finalTxt}`,
    `处理时间：${processedAt}`,
    '',
    '## 统计',
    '',
    `- 原始字幕条数：${metrics.rawCount}`,
    `- 整理后字幕条数：${metrics.finalCount}`,
    `- 被拆分的长字幕数量：${metrics.splitCount}`,
    `- 最长单条字幕字数：${metrics.longestChars}`,
    `- 是否发现超过 2 行的字幕：${metrics.hasOverTwoLines ? '是' : '否'}`,
    `- 是否发现超过 36 字的字幕：${metrics.hasOver36Chars ? '是' : '否'}`,
    `- 中文标点转换数量：${metrics.punctuationConversionCount}`,
    '',
    '## 提醒',
    '',
    '请将 final-cn.srt 导入 FCP，必要时在 FCP 中微调样式和位置。',
    '',
  ].join('\n');
}

function extractRawText(rawEntries) {
  return `${rawEntries.map((entry) => entry.text.replace(/\s*\n+\s*/g, ' ').trim()).join('\n')}\n`;
}

async function organizeSrtFile(projectPath, inputSrtPath = null, inputVideo = '') {
  await ensureSubtitleDir(projectPath);
  const sourcePath = inputSrtPath || path.join(projectPath, RAW_SRT_FILE);
  if (!(await pathIsFile(sourcePath))) {
    throw new Error('找不到 raw.srt，请先生成字幕，或选择一个已有 SRT 文件。');
  }

  const rawTargetPath = path.join(projectPath, RAW_SRT_FILE);
  if (path.resolve(sourcePath) !== path.resolve(rawTargetPath)) {
    await fs.copyFile(sourcePath, rawTargetPath);
  }

  const content = await fs.readFile(rawTargetPath, 'utf8');
  const processed = processSrtContent(content);
  const timeline = await loadProjectTimeline(projectPath);
  const processedAt = new Date().toISOString();

  await fs.writeFile(rawTargetPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  await fs.writeFile(path.join(projectPath, RAW_TXT_FILE), extractRawText(processed.rawEntries), 'utf8');
  await fs.writeFile(path.join(projectPath, FINAL_CN_SRT_FILE), renderSrt(processed.finalEntries), 'utf8');
  await fs.writeFile(path.join(projectPath, FINAL_CN_TXT_FILE), renderTxt(processed.finalEntries), 'utf8');
  await fs.writeFile(path.join(projectPath, SUBTITLE_REPORT_FILE), renderReport({
    rawSrt: RAW_SRT_FILE,
    finalSrt: FINAL_CN_SRT_FILE,
    finalTxt: FINAL_CN_TXT_FILE,
    processedAt,
    metrics: processed.metrics,
  }), 'utf8');

  const status = await writeSubtitleStatus(projectPath, createSubtitleStatus({
    status: 'success',
    inputVideo: inputVideo || '',
    rawSrt: RAW_SRT_FILE,
    finalSrt: FINAL_CN_SRT_FILE,
    finalTxt: FINAL_CN_TXT_FILE,
    report: SUBTITLE_REPORT_FILE,
    rawCount: processed.metrics.rawCount,
    finalCount: processed.metrics.finalCount,
    splitCount: processed.metrics.splitCount,
    generatedAt: processedAt,
    error: null,
    timeline,
  }));

  return {
    status,
    metrics: processed.metrics,
    outputFiles: {
      rawSrt: RAW_SRT_FILE,
      rawTxt: RAW_TXT_FILE,
      finalSrt: FINAL_CN_SRT_FILE,
      finalTxt: FINAL_CN_TXT_FILE,
      report: SUBTITLE_REPORT_FILE,
    },
  };
}

function commandNotFoundMessage(command) {
  return `${command} 可能是 iTerm2/zsh alias，Electron 无法直接识别。`
    + '请在设置里填写真实命令路径或脚本路径。';
}

async function snapshotGeneratedFiles(dirs) {
  const files = new Map();
  for (const dir of dirs) {
    const entries = await fs.readdir(dir).catch(() => []);
    for (const entry of entries) {
      const filePath = path.join(dir, entry);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat?.isFile() && GENERATED_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
        files.set(filePath, stat.mtimeMs);
      }
    }
  }
  return files;
}

async function collectGeneratedFiles(projectPath, before, startedAtMs, dirs) {
  const subtitlePath = path.join(projectPath, SUBTITLE_DIR);
  const moved = [];
  const found = [];
  for (const dir of dirs) {
    const entries = await fs.readdir(dir).catch(() => []);
    for (const entry of entries) {
      const filePath = path.join(dir, entry);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile() || !GENERATED_EXTENSIONS.has(path.extname(entry).toLowerCase())) continue;
      const oldMtime = before.get(filePath);
      if (stat.mtimeMs < startedAtMs - 2000 && oldMtime === stat.mtimeMs) continue;

      let targetPath = filePath;
      if (path.resolve(dir) !== path.resolve(subtitlePath)) {
        targetPath = path.join(subtitlePath, entry);
        await fs.rename(filePath, targetPath).catch(async () => {
          await fs.copyFile(filePath, targetPath);
          await fs.rm(filePath, { force: true });
        });
        moved.push(`${filePath} -> ${targetPath}`);
      }
      found.push(targetPath);
    }
  }
  return { found, moved };
}

async function generateSubtitlesFromVideo(projectPath, inputVideo, command = 'ww') {
  await ensureSubtitleDir(projectPath);
  const cleanCommand = String(command || '').trim() || 'ww';
  const videoPath = path.isAbsolute(inputVideo)
    ? inputVideo
    : path.join(projectPath, inputVideo);
  const videoExt = path.extname(videoPath).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(videoExt)) {
    throw new Error('请选择 mp4、mov 或 m4v 格式的最终整片视频。');
  }
  if (!(await pathIsFile(videoPath))) throw new Error(`最终视频不存在：${inputVideo}`);

  const relativeVideo = normalizeProjectRelative(projectPath, videoPath);
  await writeSubtitleConfig(projectPath, {
    command: cleanCommand,
    outputDir: SUBTITLE_DIR,
    lastVideo: relativeVideo,
  });

  const subtitlePath = path.join(projectPath, SUBTITLE_DIR);
  const desktopPath = path.join(os.homedir(), 'Desktop');
  const watchDirs = [subtitlePath, desktopPath];
  const before = await snapshotGeneratedFiles(watchDirs);
  const startedAtMs = Date.now();
  let commandOutput = null;
  let collected = { found: [], moved: [] };

  try {
    const executable = await resolveToolPath(cleanCommand);
    if (!executable) throw new Error(commandNotFoundMessage(cleanCommand));
    commandOutput = await execFileAsync(executable, [videoPath], {
      cwd: subtitlePath,
      timeout: 60 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
    });

    collected = await collectGeneratedFiles(projectPath, before, startedAtMs, watchDirs);
    const generatedSrt = collected.found
      .filter((filePath) => path.extname(filePath).toLowerCase() === '.srt')
      .sort((a, b) => a.localeCompare(b, 'zh-Hans'))[0];
    if (!generatedSrt) {
      throw new Error('字幕命令已执行，但无法确认本次生成的 SRT 文件。请手动放入 07-字幕/raw.srt 后点击“整理已有 SRT”。');
    }
    await fs.copyFile(generatedSrt, path.join(projectPath, RAW_SRT_FILE));
    return organizeSrtFile(projectPath, path.join(projectPath, RAW_SRT_FILE), relativeVideo);
  } catch (error) {
    const stderr = error.stderr || commandOutput?.stderr || error.message;
    const message = /command not found|not found|找不到命令/i.test(stderr)
      ? commandNotFoundMessage(cleanCommand)
      : error.message;
    const status = await writeSubtitleStatus(projectPath, createSubtitleStatus({
      status: 'failed',
      inputVideo: relativeVideo,
      error: message,
    }));
    await appendSubtitleErrorLog(projectPath, {
      inputVideo: relativeVideo,
      command: cleanCommand,
      stderr,
      error: message,
      fileMoves: collected.moved.join('\n'),
    });
    const wrapped = new Error(message);
    wrapped.status = status;
    throw wrapped;
  }
}

async function organizeExistingSrt(projectPath, selectedSrtPath = null) {
  try {
    return await organizeSrtFile(projectPath, selectedSrtPath);
  } catch (error) {
    const status = await writeSubtitleStatus(projectPath, createSubtitleStatus({
      status: 'failed',
      error: error.message,
    }));
    await appendSubtitleErrorLog(projectPath, {
      inputSrt: selectedSrtPath || RAW_SRT_FILE,
      error: error.message,
    });
    const wrapped = new Error(error.message);
    wrapped.status = status;
    throw wrapped;
  }
}

module.exports = {
  VIDEO_EXTENSIONS,
  PUNCTUATION_MAP,
  parseSrt,
  formatTimestamp,
  displayLength,
  normalizeSubtitleText,
  splitIntoSubtitleChunks,
  formatSubtitleLines,
  processSrtContent,
  renderSrt,
  renderTxt,
  renderReport,
  createSubtitleStatus,
  writeSubtitleStatus,
  writeSubtitleConfig,
  loadSubtitleState,
  organizeSrtFile,
  organizeExistingSrt,
  generateSubtitlesFromVideo,
  commandNotFoundMessage,
  loadProjectTimeline,
};
