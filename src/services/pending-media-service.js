const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { probeMediaSafe, runMediaTool } = require('./media-tool-service');
const {
  buildAnalysisContextPayload,
  classifyHotIngestFile,
  ingestHotIngestContexts,
} = require('./hotingest-context-service');
const {
  CONTEXT_EXTENSIONS,
  chapterForRelativePath,
  computeDurationPolicy,
  detectNarrativeStructure,
  summarizeChapters,
} = require('./narrative-structure-service');

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.tif', '.tiff', '.bmp',
]);
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mts', '.m2ts',
]);
const FOCUS_FILENAME = '本期重点.txt';
const MAX_FOCUS_BYTES = 64 * 1024;
const MAX_SCENE_FRAMES = 12;
const MAX_TIMED_FRAMES = 10;
const MAX_DENSE_FRAMES = 60;
const MANIFEST_SCHEMA_VERSION = 4;
let drawtextSupportPromise = null;

function isFinderMetadata(relativePath) {
  const parts = String(relativePath || '').split(path.sep);
  return parts.some((part) => (
    part === '.DS_Store'
    || part.startsWith('._')
    || ['.Spotlight-V100', '.Trashes', '.fseventsd'].includes(part)
  ));
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function getMediaType(extension) {
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return null;
}

async function walkRegularFiles(directory, rootDirectory = directory, files = []) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(rootDirectory, absolutePath);
    if (isFinderMetadata(relativePath)) continue;
    if (entry.isDirectory()) {
      await walkRegularFiles(absolutePath, rootDirectory, files);
    } else if (entry.isFile()) {
      files.push({
        absolutePath,
        relativePath,
      });
    }
  }
  return files;
}

async function snapshotSource(sourceDirectory) {
  const resolved = path.resolve(String(sourceDirectory || '').trim());
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw Object.assign(new Error('指定的一期素材路径不是有效目录。'), {
      code: 'INVALID_SOURCE_DIRECTORY',
    });
  }
  const files = await walkRegularFiles(resolved);
  const entries = [];
  for (const file of files) {
    const fileStat = await fs.stat(file.absolutePath);
    entries.push({
      relativePath: file.relativePath,
      sizeBytes: fileStat.size,
      mtimeMs: Number(fileStat.mtimeMs.toFixed(3)),
      sha256: await hashFile(file.absolutePath),
    });
  }
  const digest = sha256Text(JSON.stringify(entries.map((entry) => ({
    relativePath: entry.relativePath,
    sizeBytes: entry.sizeBytes,
    mtimeMs: entry.mtimeMs,
    sha256: entry.sha256,
  }))));
  return {
    sourceDirectory: resolved,
    fileCount: entries.length,
    digest,
    entries,
  };
}

function compareSourceSnapshots(before, after) {
  const errors = [];
  const beforeByPath = new Map((before?.entries || [])
    .filter((entry) => !isFinderMetadata(entry.relativePath))
    .map((entry) => [entry.relativePath, entry]));
  const afterByPath = new Map((after?.entries || [])
    .filter((entry) => !isFinderMetadata(entry.relativePath))
    .map((entry) => [entry.relativePath, entry]));
  for (const [relativePath, entry] of beforeByPath) {
    const current = afterByPath.get(relativePath);
    if (!current) {
      errors.push(`原始素材已缺失：${relativePath}`);
      continue;
    }
    if (entry.sizeBytes !== current.sizeBytes || entry.sha256 !== current.sha256) {
      errors.push(`原始素材内容已变化：${relativePath}`);
    }
    if (entry.mtimeMs !== current.mtimeMs) {
      errors.push(`原始素材修改时间已变化：${relativePath}`);
    }
  }
  for (const relativePath of afterByPath.keys()) {
    if (!beforeByPath.has(relativePath)) errors.push(`原始素材目录新增文件：${relativePath}`);
  }
  return {
    unchanged: errors.length === 0,
    errors,
    beforeDigest: before?.digest || null,
    afterDigest: after?.digest || null,
  };
}

function createAssetId(relativePath, sha256) {
  return `media_${sha256Text(`${relativePath}\0${sha256}`).slice(0, 16)}`;
}

function formatTimecode(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const milliseconds = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    + `:${String(wholeSeconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

function parseShowInfoTimes(stderr) {
  return [...String(stderr || '').matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
}

async function listMatchingFiles(directory, prefix) {
  const entries = await fs.readdir(directory).catch(() => []);
  return entries
    .filter((name) => name.startsWith(prefix) && /\.jpe?g$/i.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

async function extractSceneFrames(item, outputDirectory, warnings) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const pattern = path.join(outputDirectory, 'scene-%03d.jpg');
  let result;
  try {
    result = await runMediaTool('ffmpeg', [
      '-y',
      '-i', item.originalPath,
      '-vf', 'select=gt(scene\\,0.28),showinfo,scale=960:-2',
      '-fps_mode', 'vfr',
      '-frames:v', String(MAX_SCENE_FRAMES),
      '-q:v', '3',
      pattern,
    ], { timeoutMs: 5 * 60 * 1000 });
  } catch (error) {
    warnings.push(`${item.filename} 场景抽帧失败：${error.message}`);
    return [];
  }
  const files = await listMatchingFiles(outputDirectory, 'scene-');
  const times = parseShowInfoTimes(result.stderr);
  return files.map((filePath, index) => ({
    kind: 'scene',
    timeSec: Number.isFinite(times[index]) ? Number(times[index].toFixed(3)) : null,
    timecode: Number.isFinite(times[index]) ? formatTimecode(times[index]) : '时间码未知',
    path: filePath,
  }));
}

function createTimedSamplePoints(durationSec, intervalOverride = null, range = null) {
  const start = range?.startSec ?? 0;
  const end = range?.endSec ?? durationSec;
  const span = Math.max(0, end - start);
  const interval = intervalOverride || Math.max(2, Math.min(30, span / 8 || 2));
  const maximum = range ? MAX_DENSE_FRAMES : MAX_TIMED_FRAMES;
  const points = [];
  for (let value = start; value < end - 0.02 && points.length < maximum; value += interval) {
    points.push(Number(value.toFixed(3)));
  }
  const last = Math.max(start, end - 0.05);
  if (points.length === 0) points.push(Number(start.toFixed(3)));
  if (points.length < maximum && last - points.at(-1) > Math.min(interval / 2, 1)) {
    points.push(Number(last.toFixed(3)));
  }
  return points;
}

async function extractTimedFrames(item, outputDirectory, options, warnings) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const times = createTimedSamplePoints(
    item.metadata.durationSec,
    options.intervalSec,
    options.range,
  );
  const frames = [];
  for (const [index, timeSec] of times.entries()) {
    const outputPath = path.join(outputDirectory, `timed-${String(index + 1).padStart(3, '0')}.jpg`);
    try {
      await runMediaTool('ffmpeg', [
        '-y',
        '-ss', String(timeSec),
        '-i', item.originalPath,
        '-frames:v', '1',
        '-vf', 'scale=960:-2',
        '-q:v', '3',
        outputPath,
      ], { timeoutMs: 60_000 });
      frames.push({
        kind: options.range ? 'dense' : 'timed',
        timeSec,
        timecode: formatTimecode(timeSec),
        path: outputPath,
      });
    } catch (error) {
      warnings.push(`${item.filename} 在 ${formatTimecode(timeSec)} 抽帧失败：${error.message}`);
    }
  }
  return frames;
}

function escapeDrawText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

async function supportsDrawtext() {
  if (!drawtextSupportPromise) {
    drawtextSupportPromise = runMediaTool('ffmpeg', ['-hide_banner', '-filters'], {
      timeoutMs: 30_000,
    }).then((result) => /\bdrawtext\b/.test(result.stdout)).catch(() => false);
  }
  return drawtextSupportPromise;
}

async function createStoryboard(assetId, frames, outputPath, warnings) {
  if (frames.length === 0) return null;
  const selected = [];
  for (const frame of [...frames]
    .sort((left, right) => (left.timeSec ?? Infinity) - (right.timeSec ?? Infinity))) {
    const previous = selected.at(-1);
    if (!previous
      || frame.timeSec == null
      || previous.timeSec == null
      || Math.abs(frame.timeSec - previous.timeSec) >= 0.5) {
      selected.push(frame);
    }
    if (selected.length === 12) break;
  }
  const columns = Math.min(3, selected.length);
  const inputs = selected.flatMap((frame) => ['-i', frame.path]);
  const createFilters = (withLabels) => selected.map((frame, index) => {
    const label = escapeDrawText(`${assetId} ${frame.timecode}`);
    return `[${index}:v]scale=480:270:force_original_aspect_ratio=decrease,`
      + 'pad=480:300:(ow-iw)/2:0:black,'
      + (withLabels
        ? `drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:text='${label}':`
          + 'fontcolor=white:fontsize=18:box=1:boxcolor=black@0.65:x=10:y=h-24'
        : 'null')
      + `[cell${index}]`;
  });
  const layout = selected.map((_, index) => `${(index % columns) * 480}_${Math.floor(index / columns) * 300}`);
  const stackFilter = selected.length === 1
    ? '[cell0]null[storyboard]'
    : `${selected.map((_, index) => `[cell${index}]`).join('')}`
      + `xstack=inputs=${selected.length}:layout=${layout.join('|')}:fill=black[storyboard]`;
  const render = async (withLabels) => runMediaTool('ffmpeg', [
    '-y',
    ...inputs,
    '-filter_complex', [...createFilters(withLabels), stackFilter].join(';'),
    '-map', '[storyboard]',
    '-frames:v', '1',
    '-q:v', '3',
    outputPath,
  ], { timeoutMs: 2 * 60 * 1000 });
  if (await supportsDrawtext()) {
    try {
      await render(true);
    } catch (error) {
      warnings.push(`${assetId} 故事板文字标签失败，时间码改存配套 legend.json：${error.message}`);
      await render(false);
    }
  } else {
    try {
      await render(false);
      warnings.push(`${assetId} 的 ffmpeg 未启用 drawtext，故事板时间码保存在配套 legend.json。`);
    } catch (error) {
      warnings.push(`${assetId} 故事板生成失败，仍可查看单帧：${error.message}；${error.command || ''}`);
      return null;
    }
  }
  await fs.writeFile(`${outputPath}.legend.json`, `${JSON.stringify({
    assetId,
    cells: selected.map((frame, index) => ({
      cell: index + 1,
      timeSec: frame.timeSec,
      timecode: frame.timecode,
      framePath: frame.path,
    })),
  }, null, 2)}\n`, 'utf8');
  return outputPath;
}

async function createImagePreview(item, outputPath, warnings) {
  try {
    await runMediaTool('ffmpeg', [
      '-y',
      '-i', item.originalPath,
      '-frames:v', '1',
      '-vf', 'scale=1600:-2:force_original_aspect_ratio=decrease',
      '-q:v', '2',
      outputPath,
    ], { timeoutMs: 60_000 });
    return outputPath;
  } catch (ffmpegError) {
    try {
      await runMediaTool('sips', [
        '-s', 'format', 'jpeg',
        '--resampleWidth', '1600',
        item.originalPath,
        '--out', outputPath,
      ], { timeoutMs: 60_000 });
      return outputPath;
    } catch (sipsError) {
      warnings.push(`${item.filename} 无法生成可查看预览：${sipsError.message || ffmpegError.message}`);
      return null;
    }
  }
}

async function prepareItem(item, cacheDirectory, warnings) {
  const probe = await probeMediaSafe(item.originalPath);
  const prepared = {
    ...item,
    metadata: probe.metadata || {
      durationSec: null,
      width: null,
      height: null,
      displayWidth: null,
      displayHeight: null,
      orientation: 'unknown',
      frameRate: null,
      videoCodec: null,
      audioCodec: null,
      hasVideo: false,
      hasAudio: false,
    },
    metadataError: probe.error,
    analysisMedia: {
      imagePreview: null,
      sceneFrames: [],
      timedFrames: [],
      storyboard: null,
      storyboardLegend: null,
    },
  };
  if (!probe.ok) warnings.push(`${item.filename} 媒体探测失败：${probe.error.message}`);

  if (item.type === 'image') {
    const imageDirectory = path.join(cacheDirectory, 'images');
    await fs.mkdir(imageDirectory, { recursive: true });
    const previewPath = path.join(imageDirectory, `${item.assetId}.jpg`);
    prepared.analysisMedia.imagePreview = await createImagePreview(item, previewPath, warnings);
    return prepared;
  }

  if (!probe.ok || !probe.metadata?.hasVideo || !Number.isFinite(probe.metadata.durationSec)
    || probe.metadata.durationSec <= 0) {
    warnings.push(`${item.filename} 为空、损坏或不可解码，已保留清单记录但无法抽帧。`);
    return prepared;
  }
  if (probe.metadata.durationSec > 2 * 60 * 60) {
    warnings.push(`${item.filename} 超过 2 小时，定时抽帧间隔已限制为最多 30 秒；低可信度区间需人工复核。`);
  }
  const videoDirectory = path.join(cacheDirectory, 'videos', item.assetId);
  const sceneFrames = await extractSceneFrames(item, path.join(videoDirectory, 'scene'), warnings);
  const timedFrames = await extractTimedFrames(
    prepared,
    path.join(videoDirectory, 'timed'),
    { intervalSec: null, range: null },
    warnings,
  );
  const storyboard = await createStoryboard(
    item.assetId,
    [...sceneFrames, ...timedFrames],
    path.join(videoDirectory, 'storyboard.jpg'),
    warnings,
  );
  prepared.analysisMedia = {
    sceneFrames,
    timedFrames,
    storyboard,
    storyboardLegend: storyboard ? `${storyboard}.legend.json` : null,
    imagePreview: null,
  };
  return prepared;
}

async function readOptionalFocus(sourceDirectory) {
  const focusPath = path.join(sourceDirectory, FOCUS_FILENAME);
  const stat = await fs.stat(focusPath).catch(() => null);
  if (!stat?.isFile()) return null;
  if (stat.size > MAX_FOCUS_BYTES) {
    throw Object.assign(new Error(`${FOCUS_FILENAME} 超过 ${MAX_FOCUS_BYTES} 字节限制。`), {
      code: 'FOCUS_FILE_TOO_LARGE',
    });
  }
  return (await fs.readFile(focusPath, 'utf8')).trim() || null;
}

function manifestArtifactsExist(manifest) {
  return Promise.all((manifest.items || []).map(async (item) => {
    const paths = [
      item.analysisMedia?.imagePreview,
      item.analysisMedia?.storyboard,
      item.analysisMedia?.storyboard ? `${item.analysisMedia.storyboard}.legend.json` : null,
      ...(item.analysisMedia?.sceneFrames || []).map((frame) => frame.path),
      ...(item.analysisMedia?.timedFrames || []).map((frame) => frame.path),
    ].filter(Boolean);
    const results = await Promise.all(paths.map((filePath) => fs.stat(filePath).catch(() => null)));
    return results.every((stat) => stat?.isFile());
  })).then((results) => results.every(Boolean));
}

async function preparePendingMedia(sourceDirectory, options = {}) {
  const onStage = typeof options.onStage === 'function' ? options.onStage : async () => {};
  await onStage('scanning_media', '正在扫描一期素材并生成原始快照。');
  const before = await snapshotSource(sourceDirectory);
  const cacheRoot = path.resolve(options.cacheRoot || path.join(
    os.tmpdir(),
    'video-cut-planner-v3',
    'codex-video-cache',
  ));
  const cacheKey = sha256Text(`${before.sourceDirectory}\0${before.digest}`).slice(0, 24);
  const cacheDirectory = path.join(cacheRoot, cacheKey);
  const manifestPath = path.join(cacheDirectory, 'manifest.json');
  const cached = JSON.parse(await fs.readFile(manifestPath, 'utf8').catch(() => 'null'));
  if (cached?.schemaVersion === MANIFEST_SCHEMA_VERSION
    && cached?.sourceSnapshot?.digest === before.digest
    && await manifestArtifactsExist(cached)) {
    await onStage('analyzing_media', '素材缓存有效，等待 Codex 查看真实预览并分析。');
    return {
      ...cached,
      manifestPath,
      analysisRequestPath: path.join(cacheDirectory, 'analysis-request.json'),
      cached: true,
    };
  }

  await fs.mkdir(cacheDirectory, { recursive: true });
  const snapshotByPath = new Map(before.entries.map((entry) => [entry.relativePath, entry]));
  const allFiles = await walkRegularFiles(before.sourceDirectory);
  const narrative = await detectNarrativeStructure(before.sourceDirectory, allFiles);
  const mediaFiles = allFiles.filter((file) => getMediaType(path.extname(file.relativePath).toLowerCase()));
  if (mediaFiles.length === 0) {
    throw Object.assign(new Error('素材目录中没有支持的图片或视频。'), {
      code: 'NO_SUPPORTED_MEDIA',
    });
  }

  const warnings = [];
  let items = [];
  await onStage('extracting_metadata', '正在使用 ffprobe 读取素材元数据。');
  for (const file of mediaFiles) {
    const snapshot = snapshotByPath.get(file.relativePath);
    const type = getMediaType(path.extname(file.relativePath).toLowerCase());
    const chapter = chapterForRelativePath(narrative.chapters, file.relativePath);
    const item = {
      assetId: createAssetId(file.relativePath, snapshot.sha256),
      type,
      filename: path.basename(file.relativePath),
      relativePath: file.relativePath,
      chapterId: chapter.chapterId,
      subchapterId: chapter.subchapterId,
      originalPath: file.absolutePath,
      extension: path.extname(file.relativePath).slice(1).toLowerCase(),
      sizeBytes: snapshot.sizeBytes,
      sha256: snapshot.sha256,
    };
    items.push(await prepareItem(item, cacheDirectory, warnings));
    if (type === 'video' || type === 'image') {
      await onStage('extracting_frames', `正在准备可视化预览：${item.filename}`);
    }
  }

  const contextResult = await ingestHotIngestContexts(before.sourceDirectory, allFiles, items);
  items = contextResult.items;
  warnings.push(...contextResult.contextIngestion.warnings);

  const ignoredFiles = allFiles
    .filter((file) => path.basename(file.relativePath) !== FOCUS_FILENAME
      && !CONTEXT_EXTENSIONS.has(path.extname(file.relativePath).toLowerCase())
      && !classifyHotIngestFile(file.relativePath)
      && !getMediaType(path.extname(file.relativePath).toLowerCase()))
    .map((file) => file.relativePath);
  if (ignoredFiles.length > 0) warnings.push(`已忽略不支持的文件：${ignoredFiles.join('、')}`);
  warnings.push(...narrative.warnings);

  const after = await snapshotSource(before.sourceDirectory);
  const sourceVerification = compareSourceSnapshots(before, after);
  if (!sourceVerification.unchanged) {
    throw Object.assign(new Error(`素材准备过程中原始目录发生变化：${sourceVerification.errors[0]}`), {
      code: 'SOURCE_CHANGED_DURING_PREPARE',
      details: sourceVerification.errors,
    });
  }

  const chapters = summarizeChapters(narrative.chapters, items);
  const durationPolicy = computeDurationPolicy(chapters, {
    imageCount: items.filter((item) => item.type === 'image').length,
    videoCount: items.filter((item) => item.type === 'video').length,
    totalVideoDurationSec: items
      .filter((item) => item.type === 'video')
      .reduce((sum, item) => sum + Number(item.metadata?.durationSec || 0), 0),
  }, narrative.projectBrief);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    preparedAt: new Date().toISOString(),
    sourceDirectory: before.sourceDirectory,
    sourceFolderName: path.basename(before.sourceDirectory),
    optionalFocus: await readOptionalFocus(before.sourceDirectory),
    projectBrief: narrative.projectBrief,
    contextDocuments: narrative.contextDocuments,
    contextIngestion: contextResult.contextIngestion,
    storyUnits: contextResult.storyUnits,
    chapters,
    narrative: {
      chapterCount: chapters.length,
      allowChapterInterleave: narrative.allowChapterInterleave,
      enforceChapterValidation: narrative.enforceChapterValidation,
      briefFilesUsed: narrative.briefFilesUsed,
      durationPolicy,
    },
    sourceSnapshot: before,
    sourceVerification,
    cacheDirectory,
    warnings,
    items,
  };
  const analysisRequestPath = path.join(cacheDirectory, 'analysis-request.json');
  const analysisContext = buildAnalysisContextPayload(items);
  const analysisRequest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    manifestPath,
    analysisSchemaPath: path.resolve(__dirname, '../../schemas/codex-video-analysis.schema.json'),
    priority: [
      '视频、截图和图片中的实际内容',
      '每个视觉素材 context 中明确标注的 HotIngest 标题、正文、翻译、来源和事件背景',
      'projectBrief 的硬约束、章节顺序和说明文件上下文',
      '素材的 chapterId、subchapterId 和 relativePath',
      '素材之间的共同主题、操作先后和结果变化',
      '明确可用的项目文档、运行结果或 Git 上下文',
      FOCUS_FILENAME,
      '单个素材文件名',
      '素材文件夹名称',
    ],
    instruction: [
      '请用当前会话查看 imagePreview、storyboard 和单帧，并结合每个素材的 context 填写协议；不要调用外部模型 API。',
      '必须区分“画面实际可见内容”、画面内文字、视频原声和“上下文文件提供的信息”；上下文不得冒充画面文字或 OCR。',
      '有 context 的素材必须填写 contextUsage，标明是否使用及实际使用的 sourceFiles。',
      '可用视觉素材（图片/视频）默认全部进入时间线，每一项至少使用一次；不得为控制总时长跳过普通素材。',
      '仅真实画面重复可写入 duplicateAssetIds，损坏/无真实视觉实体/图标头像/无效下载可写入 unusableAssetIds；不得把普通可用素材标成 alternate 后整段淘汰。',
      '每个 Story Unit 的全部 assetIds 必须不重叠地分入 representativeAssetIds、supportingAssetIds、alternateAssetIds、duplicateAssetIds 或 unusableAssetIds。',
      '每个 Story Unit 必须保留 contextSourceFiles，并填写服从项目结构的 chapterId；跨顶层章节的异常归组使用 null 并保留 warning。',
      '每个最终镜头必须填写 storyUnitId、narrativeRole、selectionReason，以及 evidence.visualEvidenceUsed、evidence.contextEvidenceUsed 和 evidence.inference；contextEvidence 不得冒充 visualEvidence。',
      '为图片和视频填写 visualTextAnalysis：区分 sourceText、translatedText 与 meaning，保留 confidence；视频字幕需近似 startTime/endTime，并合并相邻重复字幕帧。',
      '为每个视觉素材填写 explanationPlan；当 audienceNeedsExplanation 为 background/translate_on_screen_text/humor_or_twist/multi_panel_dialogue，或存在 HotIngest 外文解释/人工字幕时，必须在 lightCaptionPlan 中生成对应轻字幕，不得遗漏。',
      'lightCaptionPlan 本阶段是建议，不得因 context 自动新增 Marker；但应生成却未生成时校验必须失败。人工字幕内容不得改写。',
      '视频默认 preserveFullClip=true 与 preserveOriginalAudio=true；普通视频默认完整使用。异常长视频可截取精彩片段但仍须进入时间线，并记录 trimReason 与时间范围；不设固定秒数阈值。',
      '不得设置或推断默认成片目标时长/上限，也不得以“不要太长”压缩素材。若本期说明明确给出时长范围则写入 durationPolicy；否则使用 unconstrained（maxSec=null）。',
      '不得因为存在背景音乐、字幕或其他视频而静音原视频；静音必须写 muteReason，且仅在人工明确要求时允许。',
      '上下文可改善素材相关性、章节内选择、叙事角色和章节内部顺序，但不得重排 chapters 的顶层顺序。',
      '上下文与画面冲突时必须保留 conflicts/warnings、降低 confidence，并将自动入选镜头标为 reviewRequired；不得静默覆盖。',
      'context 标题、正文、评论和翻译只用于理解，不能单独据此新增 Marker；但外文解释触发的轻字幕必须写入 lightCaptionPlan。',
    ].join(''),
    analysisBudget: {
      maxSceneFrames: MAX_SCENE_FRAMES,
      maxTimedFrames: MAX_TIMED_FRAMES,
      maxDenseFrames: MAX_DENSE_FRAMES,
      maxVisualTextItemsPerAsset: 40,
      maxOcrTextLength: 500,
      maxExplanationFieldLength: 1000,
      maxLightCaptionsPerStoryUnit: 8,
      maxLightCaptionsPerProject: 40,
      preservePriority: [
        '反转附近画面',
        '字幕变化时刻',
        'Story Unit 关键素材',
        '视频开始和结束',
        '有效音频区间',
        '用户明确保留的素材',
      ],
    },
    projectBrief: manifest.projectBrief,
    chapters: manifest.chapters,
    narrative: manifest.narrative,
    contextDocuments: manifest.contextDocuments,
    storyUnits: manifest.storyUnits,
    contextBudget: analysisContext.budget,
    items: items.map((item) => ({
      assetId: item.assetId,
      type: item.type,
      filename: item.filename,
      relativePath: item.relativePath,
      chapterId: item.chapterId,
      subchapterId: item.subchapterId,
      metadata: item.metadata,
      metadataError: item.metadataError,
      analysisMedia: item.analysisMedia,
      storyUnitId: item.storyUnitId || null,
      semanticProfile: analysisContext.semanticProfiles.get(item.assetId) || null,
      context: analysisContext.contexts.get(item.assetId) || null,
    })),
  };
  await Promise.all([
    fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    fs.writeFile(analysisRequestPath, `${JSON.stringify(analysisRequest, null, 2)}\n`, 'utf8'),
  ]);
  await onStage('analyzing_media', '抽帧与素材清单已就绪，等待 Codex 语义分析。');
  return {
    ...manifest,
    manifestPath,
    analysisRequestPath,
    cached: false,
  };
}

async function inspectVideoRange(manifestPath, assetId, startSec, endSec, intervalSec = 1) {
  const manifest = JSON.parse(await fs.readFile(path.resolve(manifestPath), 'utf8'));
  const item = manifest.items?.find((entry) => entry.assetId === assetId);
  if (!item) throw Object.assign(new Error(`素材清单中找不到 ${assetId}。`), { code: 'ASSET_NOT_FOUND' });
  if (item.type !== 'video' || !Number.isFinite(item.metadata?.durationSec)) {
    throw Object.assign(new Error(`${assetId} 不是可抽帧视频。`), { code: 'ASSET_NOT_DECODABLE_VIDEO' });
  }
  const start = Number(startSec);
  const end = Number(endSec);
  const interval = Number(intervalSec);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start
    || end > item.metadata.durationSec + 0.05) {
    throw Object.assign(new Error('加密抽帧区间无效或超出视频时长。'), { code: 'INVALID_INSPECTION_RANGE' });
  }
  if (!Number.isFinite(interval) || interval < 0.1 || interval > 30) {
    throw Object.assign(new Error('加密抽帧间隔必须在 0.1 到 30 秒之间。'), { code: 'INVALID_INSPECTION_INTERVAL' });
  }
  const warnings = [];
  const key = `${start.toFixed(3)}-${end.toFixed(3)}-${interval.toFixed(3)}`.replace(/\./g, '_');
  const outputDirectory = path.join(manifest.cacheDirectory, 'dense', assetId, key);
  const frames = await extractTimedFrames(
    item,
    outputDirectory,
    { intervalSec: interval, range: { startSec: start, endSec: end } },
    warnings,
  );
  const storyboard = await createStoryboard(
    assetId,
    frames,
    path.join(outputDirectory, 'storyboard.jpg'),
    warnings,
  );
  const result = { assetId, startSec: start, endSec: end, intervalSec: interval, frames, storyboard, warnings };
  await fs.writeFile(path.join(outputDirectory, 'range-manifest.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

module.exports = {
  FOCUS_FILENAME,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  compareSourceSnapshots,
  createTimedSamplePoints,
  getMediaType,
  hashFile,
  inspectVideoRange,
  isFinderMetadata,
  preparePendingMedia,
  snapshotSource,
};
