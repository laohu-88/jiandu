const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const {
  APP_VERSION,
  PROJECT_FILE,
  SEGMENTS_FILE,
  ASSIGNMENTS_FILE,
  ROUGHCUT_DIR,
  ROUGHCUT_STATUS_FILE,
  ROUGHCUT_ERROR_FILE,
  ROUGHCUT_TMP_DIR,
} = require('../constants');
const { writeProjectState } = require('./project-service');
const { safeFilename } = require('./stage3-service');
const { compileTimeline, getSegmentDuration } = require('./timeline-engine');
const { backupCoreProjectJson } = require('./backup-service');
const { resolveToolPath } = require('./stage7-service');

const execFileAsync = promisify(execFile);
const VALID_FIT_MODES = new Set(['contain', 'cover', 'blur', 'push_in']);
const VALID_AUDIO_MODES = new Set(['none', 'keep', 'duck', 'smart_duck']);

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

function projectFilePath(projectPath, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath);
}

function quoteArg(value) {
  const text = String(value);
  return /[\s"'\\]/.test(text) ? JSON.stringify(text) : text;
}

function commandText(command, args) {
  return [command, ...args.map(quoteArg)].join(' ');
}

async function runCommand(command, args, options = {}) {
  const executable = command === 'ffmpeg' || command === 'ffprobe'
    ? await resolveToolPath(command) || command
    : command;
  try {
    const result = await execFileAsync(executable, args, {
      cwd: options.cwd,
      timeout: options.timeout || 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      command: commandText(executable, args),
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } catch (error) {
    const wrapped = new Error(error.stderr?.trim() || error.message);
    wrapped.command = commandText(executable, args);
    wrapped.stderr = error.stderr || error.message;
    throw wrapped;
  }
}

async function toolAvailable(command) {
  try {
    await runCommand(command, ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function validatePauseDsl(voiceoverText) {
  const errors = [];
  const directives = String(voiceoverText || '').match(/\[pause[^\]]*\]/gi) || [];
  for (const directive of directives) {
    const match = directive.match(/^\[pause\s*:\s*([^\]]+)\]$/i);
    const duration = Number(match?.[1]);
    if (!match || !Number.isFinite(duration) || duration <= 0) {
      errors.push(`停顿指令不合法：${directive}，duration 必须大于 0。`);
    }
  }
  return errors;
}

async function validateSegmentForRender(projectPath, segmentId) {
  const report = { ok: false, errors: [], warnings: [] };
  const cleanProjectPath = String(projectPath || '').trim();
  const projectStat = cleanProjectPath
    ? await fs.stat(cleanProjectPath).catch(() => null)
    : null;
  if (!projectStat?.isDirectory()) {
    report.errors.push('项目未打开或项目路径无效。');
    return report;
  }
  if (!(await pathIsFile(path.join(cleanProjectPath, PROJECT_FILE)))) {
    report.errors.push('项目未正确打开：缺少 00-项目总控/project.json。');
  }

  const segmentsPath = path.join(cleanProjectPath, SEGMENTS_FILE);
  const assignmentsPath = path.join(cleanProjectPath, ASSIGNMENTS_FILE);
  const segmentsExists = await pathIsFile(segmentsPath);
  const assignmentsExists = await pathIsFile(assignmentsPath);
  if (!segmentsExists) report.errors.push('缺少 segments.json，请先导入视频方案。');
  if (!assignmentsExists) report.errors.push('缺少 segment-assignments.json，请先完成素材编排。');

  const [segmentsPayload, assignmentsPayload] = await Promise.all([
    segmentsExists ? readJson(segmentsPath) : null,
    assignmentsExists ? readJson(assignmentsPath) : null,
  ]);
  if (segmentsExists && !segmentsPayload?.segments) {
    report.errors.push('segments.json 无法读取或格式不正确。');
  }
  if (assignmentsExists && !assignmentsPayload?.segments) {
    report.errors.push('segment-assignments.json 无法读取或格式不正确。');
  }

  const segment = segmentsPayload?.segments?.find((entry) => entry.id === segmentId);
  const assignment = assignmentsPayload?.segments?.find(
    (entry) => entry.segmentId === segmentId,
  );
  if (segmentsPayload?.segments && !segment) {
    report.errors.push(`segments.json 中找不到分段 ${segmentId}。`);
  }
  if (assignmentsPayload?.segments && !assignment) {
    report.errors.push(`找不到第 ${segmentId} 段的素材编排。`);
  }

  let timeline = null;
  if (segment) {
    report.errors.push(...validatePauseDsl(segment.voiceoverText));
    try {
      timeline = compileTimeline({ ...segment, items: assignment?.items || [] });
      if (!(getSegmentDuration({ timeline }) > 0)) {
        report.errors.push('本段 timeline.duration 必须大于 0。');
      }
      const invalidPauses = timeline.items.filter(
        (item) => item.type === 'pause'
          && (!Number.isFinite(Number(item.durationSec)) || Number(item.durationSec) <= 0),
      );
      for (const pause of invalidPauses) {
        report.errors.push(`pause 节点 ${pause.id || ''} 的 duration 必须大于 0。`.trim());
      }
    } catch (error) {
      report.errors.push(`timeline 编译失败：${error.message}`);
    }
  }

  const declaredVoiceFiles = new Set([
    ...(segment?.voiceFiles || []),
    ...((segment?.voiceTrack?.clips || []).map((clip) => clip.file).filter(Boolean)),
  ]);
  const timelineVoiceFiles = timeline?.items
    ?.filter((item) => item.type === 'audio')
    .map((item) => item.file)
    .filter(Boolean) || [];
  if (!declaredVoiceFiles.size && !timelineVoiceFiles.length) {
    report.errors.push('本段缺少配音文件，请先扫描配音。');
  }
  if (declaredVoiceFiles.size && !timelineVoiceFiles.length) {
    report.errors.push('本段配音未进入 timeline，请重新扫描配音。');
  }
  for (const voiceFile of new Set([...declaredVoiceFiles, ...timelineVoiceFiles])) {
    if (!(await pathIsFile(projectFilePath(cleanProjectPath, voiceFile)))) {
      report.errors.push(`配音文件不存在：${voiceFile}`);
    }
  }

  if (!assignment?.items?.length) {
    report.errors.push('本段没有素材 items，无法生成粗剪。');
  }
  for (const item of assignment?.items || []) {
    if (!item.relativePath) {
      report.errors.push(`素材 ${item.assetId || item.filename || '未知素材'} 缺少源文件路径。`);
    } else if (!(await pathIsFile(projectFilePath(cleanProjectPath, item.relativePath)))) {
      report.errors.push(`素材源文件不存在：${item.relativePath}`);
    }
  }

  if (timeline && timeline.voiceDuration > 0 && timeline.visualDuration > 0) {
    const difference = Number((timeline.visualDuration - timeline.voiceDuration).toFixed(3));
    if (Math.abs(difference) > 0.05) {
      report.errors.push(
        `素材总时长 ${timeline.visualDuration.toFixed(2)} 秒与配音时长 `
        + `${timeline.voiceDuration.toFixed(2)} 秒未对齐。`,
      );
    }
  }

  if (!(await toolAvailable('ffmpeg'))) report.errors.push('找不到 ffmpeg，无法生成分段粗剪。');
  if (!(await toolAvailable('ffprobe'))) report.errors.push('找不到 ffprobe，无法生成分段粗剪。');
  report.ok = report.errors.length === 0;
  return report;
}

function validateSegmentPlan(segment, assignment) {
  if (!segment) throw new Error('segments.json 中找不到该分段。');
  const timeline = compileTimeline({ ...segment, items: assignment?.items || [] });
  const voiceFiles = timeline.items
    .filter((item) => item.type === 'audio')
    .map((item) => item.file);
  if (!voiceFiles.length) throw new Error('本段缺少配音文件，请先扫描配音。');
  const targetDuration = timeline.voiceDuration;
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
    throw new Error('本段缺少有效配音时长，请重新扫描配音。');
  }
  if (!assignment?.items?.length) throw new Error('本段没有素材编排，无法生成粗剪。');

  const totalDuration = timeline.visualDuration;
  const difference = Number((totalDuration - targetDuration).toFixed(3));
  if (Math.abs(difference) > 0.05) {
    throw new Error(
      `素材总时长 ${totalDuration.toFixed(2)} 秒与配音时长 `
      + `${targetDuration.toFixed(2)} 秒未对齐。`,
    );
  }
  return { totalDuration, difference, targetDuration, timeline };
}

function getAudioVolume(audioMode) {
  return {
    none: 0,
    keep: 0.9,
    duck: 0.25,
    smart_duck: 0.25,
  }[audioMode] ?? 0;
}

function getVideoFilter(fitMode, type, durationSec) {
  const duration = Number(durationSec).toFixed(3);
  const mode = VALID_FIT_MODES.has(fitMode) ? fitMode : 'contain';
  let filter;

  if (mode === 'cover') {
    filter = 'scale=1920:1080:force_original_aspect_ratio=increase,'
      + 'crop=1920:1080,setsar=1,fps=30';
  } else if (mode === 'blur') {
    filter = 'split=2[bg][fg];'
      + '[bg]scale=1920:1080:force_original_aspect_ratio=increase,'
      + 'crop=1920:1080,boxblur=20:10[bg2];'
      + '[fg]scale=1920:1080:force_original_aspect_ratio=decrease[fg2];'
      + '[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30';
  } else if (mode === 'push_in' && type === 'image') {
    filter = 'scale=1920:1080:force_original_aspect_ratio=decrease,'
      + 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,'
      + "zoompan=z='min(1+0.0005*on,1.05)':"
      + "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
      + 'd=1:s=1920x1080:fps=30,setsar=1';
  } else {
    filter = 'scale=1920:1080:force_original_aspect_ratio=decrease,'
      + 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30';
  }

  return `${filter},tpad=stop_mode=clone:stop_duration=${duration},`
    + `trim=duration=${duration},setpts=PTS-STARTPTS`;
}

function buildRoughcutPlan(segment, assignment, projectPath) {
  const validation = validateSegmentPlan(segment, assignment);
  const timeline = compileTimeline({ ...segment, items: assignment.items });
  const sortedItems = timeline.items.filter(
    (item) => item.type === 'video' && item.track === 'visual',
  );
  const voiceFiles = timeline.items
    .filter((item) => item.type === 'audio')
    .map((item) => item.file);
  return {
    segmentId: segment.id,
    title: segment.title,
    voiceFile: segment.voiceFile,
    voiceFiles,
    timeline,
    pauseMode: 'freeze_frame',
    outputFile: path.join(
      ROUGHCUT_DIR,
      `${segment.id}-${safeFilename(segment.title)}.mp4`,
    ),
    items: sortedItems.map((item, index) => {
      const fitMode = VALID_FIT_MODES.has(item.fitMode) ? item.fitMode : 'contain';
      const audioMode = VALID_AUDIO_MODES.has(item.audioMode) ? item.audioMode : 'none';
      const sourceType = item.sourceType || item.type;
      return {
        ...item,
        type: sourceType,
        fitMode,
        audioMode,
        audioVolume: sourceType === 'image' ? 0 : getAudioVolume(audioMode),
        videoFilter: getVideoFilter(fitMode, sourceType, item.durationSec),
        sourcePath: path.join(projectPath, item.relativePath),
        partFilename: `part-${String(index + 1).padStart(3, '0')}.mp4`,
      };
    }),
  };
}

async function probeHasAudio(filePath) {
  const result = await runCommand('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    filePath,
  ]);
  return Boolean(result.stdout.trim());
}

function commonEncodeArgs(outputPath, durationSec) {
  return [
    '-t', Number(durationSec).toFixed(3),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    outputPath,
  ];
}

async function buildItemPart(itemPlan, outputPath) {
  const duration = Number(itemPlan.durationSec).toFixed(3);
  const args = ['-y'];
  if (itemPlan.type === 'image') {
    args.push('-loop', '1', '-framerate', '30', '-i', itemPlan.sourcePath);
  } else {
    args.push('-ss', String(itemPlan.startOffsetSec || 0), '-i', itemPlan.sourcePath);
  }
  args.push(
    '-f', 'lavfi',
    '-t', duration,
    '-i', 'anullsrc=r=48000:cl=stereo',
  );

  let hasSourceAudio = false;
  if (itemPlan.type === 'video' && itemPlan.audioVolume > 0) {
    hasSourceAudio = await probeHasAudio(itemPlan.sourcePath);
  }

  const filters = [`[0:v]${itemPlan.videoFilter}[v]`];
  let audioMap = '1:a';
  if (hasSourceAudio) {
    filters.push(
      `[0:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,`
      + `volume=${itemPlan.audioVolume},apad=pad_dur=${duration},`
      + `atrim=duration=${duration}[a]`,
    );
    audioMap = '[a]';
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[v]',
    '-map', audioMap,
    ...commonEncodeArgs(outputPath, itemPlan.durationSec),
  );
  return runCommand('ffmpeg', args);
}

function escapeConcatPath(filePath) {
  return filePath.replace(/'/g, "'\\''");
}

async function concatParts(partPaths, concatListPath, outputPath) {
  const content = partPaths.map((filePath) => `file '${escapeConcatPath(filePath)}'`).join('\n');
  await fs.writeFile(concatListPath, `${content}\n`, 'utf8');
  return runCommand('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-c', 'copy',
    outputPath,
  ]);
}

async function mixVoice(concatPath, voicePath, durationSec, outputPath) {
  const duration = Number(durationSec).toFixed(3);
  const filter = `[0:v]tpad=stop_mode=clone:stop_duration=${duration},`
    + `trim=duration=${duration},setpts=PTS-STARTPTS[v];`
    + `[0:a]aresample=48000,atrim=duration=${duration},`
    + `apad=pad_dur=${duration},atrim=duration=${duration}[bed];`
    + `[1:a]aresample=48000,asetpts=PTS-STARTPTS,`
    + `apad=pad_dur=${duration},atrim=duration=${duration}[voice];`
    + '[bed][voice]amix=inputs=2:duration=longest:dropout_transition=0,'
    + `alimiter=limit=0.95,atrim=duration=${duration}[a]`;

  return runCommand('ffmpeg', [
    '-y',
    '-i', concatPath,
    '-i', voicePath,
    '-filter_complex', filter,
    '-map', '[v]',
    '-map', '[a]',
    ...commonEncodeArgs(outputPath, durationSec),
  ]);
}

async function buildMergedVoiceTrack(projectPath, voiceTimeline, outputPath) {
  const args = ['-y'];
  const filters = [];
  const labels = [];
  let inputIndex = 0;

  voiceTimeline.forEach((item, timelineIndex) => {
    const duration = Number(item.durationSec).toFixed(3);
    const label = `voice_part_${timelineIndex}`;
    if (item.type === 'audio') {
      args.push('-i', path.join(projectPath, item.file));
      filters.push(
        `[${inputIndex}:a]aresample=48000,atrim=duration=${duration},`
        + `asetpts=PTS-STARTPTS,apad=pad_dur=${duration},`
        + `atrim=duration=${duration}[${label}]`,
      );
      inputIndex += 1;
    } else {
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${duration},`
        + `asetpts=PTS-STARTPTS[${label}]`,
      );
    }
    labels.push(`[${label}]`);
  });

  filters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[voice]`);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[voice]',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '48000',
    '-ac', '2',
    outputPath,
  );
  return runCommand('ffmpeg', args);
}

async function probeDuration(filePath) {
  const result = await runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration)) throw new Error('ffprobe 未返回有效输出时长。');
  return Number(duration.toFixed(2));
}

async function loadGenerationData(projectPath) {
  const segmentsPath = path.join(projectPath, SEGMENTS_FILE);
  const assignmentsPath = path.join(projectPath, ASSIGNMENTS_FILE);
  const [segmentsPayload, assignmentsPayload] = await Promise.all([
    readJson(segmentsPath),
    readJson(assignmentsPath),
  ]);
  if (!segmentsPayload?.segments) throw new Error('找不到 segments.json，请先导入视频方案。');
  if (!assignmentsPayload?.segments) {
    throw new Error('找不到 segment-assignments.json，请先完成素材编排。');
  }
  return { segmentsPayload, assignmentsPayload };
}

async function validateRuntime(projectPath, plan) {
  if (!(await toolAvailable('ffmpeg'))) throw new Error('找不到 ffmpeg，无法生成分段粗剪。');
  if (!(await toolAvailable('ffprobe'))) throw new Error('找不到 ffprobe，无法生成分段粗剪。');
  for (const voiceFile of plan.voiceFiles) {
    if (!(await pathIsFile(path.join(projectPath, voiceFile)))) {
      throw new Error(`配音文件不存在：${voiceFile}`);
    }
  }
  for (const item of plan.items) {
    if (!(await pathIsFile(item.sourcePath))) {
      throw new Error(`素材源文件不存在：${item.relativePath}`);
    }
  }
}

function createStatusPayload(projectPath, segments, existing = {}) {
  const existingById = new Map(
    (existing.segments || []).map((segment) => [segment.segmentId, segment]),
  );
  return {
    version: APP_VERSION,
    projectPath,
    updatedAt: new Date().toISOString(),
    segments: segments.map((segment) => existingById.get(segment.id) || {
      segmentId: segment.id,
      status: 'pending',
      outputFile: null,
      durationSec: null,
      generatedAt: null,
      error: null,
    }),
  };
}

async function writeStatus(projectPath, payload) {
  payload.version = APP_VERSION;
  payload.updatedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(projectPath, ROUGHCUT_STATUS_FILE),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
  await writeProjectState(projectPath);
  return payload;
}

async function loadRoughcutStatus(projectPath) {
  const { segmentsPayload } = await loadGenerationData(projectPath).catch(() => ({
    segmentsPayload: { segments: [] },
  }));
  const existing = await readJson(path.join(projectPath, ROUGHCUT_STATUS_FILE));
  const payload = createStatusPayload(projectPath, segmentsPayload.segments, existing || {});
  return writeStatus(projectPath, payload);
}

function updateStatusEntry(payload, segmentId, patch) {
  let entry = payload.segments.find((segment) => segment.segmentId === segmentId);
  if (!entry) {
    entry = { segmentId };
    payload.segments.push(entry);
  }
  Object.assign(entry, patch);
  return entry;
}

function errorSummary(error) {
  return String(error?.stderr || error?.message || error || '未知错误')
    .split(/\r?\n/)
    .slice(0, 12)
    .join('\n')
    .slice(0, 4000);
}

async function appendErrorLog(projectPath, segment, assignment, error, commands = []) {
  let timeline = error?.plan?.timeline || null;
  if (!timeline && segment) {
    try {
      timeline = compileTimeline({ ...segment, items: assignment?.items || [] });
    } catch {
      timeline = null;
    }
  }
  const voiceFiles = timeline?.items
    ?.filter((item) => item.type === 'audio')
    .map((item) => item.file) || segment?.voiceFiles || [];
  const pauses = timeline?.items
    ?.filter((item) => item.type === 'pause')
    .map((item) => ({
      id: item.id,
      startSec: item.startSec,
      endSec: item.endSec,
      durationSec: item.durationSec,
    })) || [];
  const assets = (assignment?.items || []).map((item) => ({
    assetId: item.assetId,
    filename: item.filename,
    relativePath: item.relativePath,
  }));
  const lines = [
    '',
    '============================================================',
    `时间：${new Date().toISOString()}`,
    `segmentId：${segment?.id || 'unknown'}`,
    `segment title：${segment?.title || 'unknown'}`,
    `timeline.duration：${getSegmentDuration({ timeline }) ?? '无法编译'}`,
    `voiceFiles：${JSON.stringify(voiceFiles)}`,
    `pause 节点：${JSON.stringify(pauses)}`,
    `素材列表：${JSON.stringify(assets)}`,
    `临时目录：${error?.tempDir || path.join(projectPath, ROUGHCUT_TMP_DIR, segment?.id || 'unknown')}`,
    '命令或关键参数：',
    ...(commands.length ? commands : [error.command || '未执行 ffmpeg 命令']),
    'ffmpeg stderr 摘要：',
    errorSummary(error),
    '',
  ];
  await fs.appendFile(
    path.join(projectPath, ROUGHCUT_ERROR_FILE),
    lines.join('\n'),
    'utf8',
  );
}

async function generateSegmentInternal(projectPath, segment, assignment) {
  const plan = buildRoughcutPlan(segment, assignment, projectPath);
  await validateRuntime(projectPath, plan);

  const tmpRoot = path.join(projectPath, ROUGHCUT_TMP_DIR);
  const segmentTmp = path.join(tmpRoot, segment.id);
  const tempOutputPath = path.join(
    tmpRoot,
    `${segment.id}-${safeFilename(segment.title)}.tmp.mp4`,
  );
  const outputPath = path.join(projectPath, plan.outputFile);
  await fs.rm(segmentTmp, { recursive: true, force: true });
  await fs.rm(tempOutputPath, { force: true });
  await fs.mkdir(segmentTmp, { recursive: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const commands = [];
  try {
    const partPaths = [];
    for (const item of plan.items) {
      const partPath = path.join(segmentTmp, item.partFilename);
      const result = await buildItemPart(item, partPath);
      commands.push(result.command);
      partPaths.push(partPath);
    }
    const concatPath = path.join(segmentTmp, 'concat.mp4');
    const concatResult = await concatParts(
      partPaths,
      path.join(segmentTmp, 'concat.txt'),
      concatPath,
    );
    commands.push(concatResult.command);

    const voiceTimeline = plan.timeline.items.filter(
      (item) => item.type === 'audio' || item.type === 'pause',
    );
    const needsMergedVoiceTrack = plan.voiceFiles.length > 1
      || voiceTimeline.some((item) => item.type === 'pause');
    let voicePath = path.join(projectPath, plan.voiceFiles[0]);
    if (needsMergedVoiceTrack) {
      voicePath = path.join(segmentTmp, 'voice-track.m4a');
      const voiceTrackResult = await buildMergedVoiceTrack(
        projectPath,
        voiceTimeline,
        voicePath,
      );
      commands.push(voiceTrackResult.command);
    }

    const finalResult = await mixVoice(
      concatPath,
      voicePath,
      getSegmentDuration(plan),
      tempOutputPath,
    );
    commands.push(finalResult.command);
    const outputDuration = await probeDuration(tempOutputPath);
    await fs.rename(tempOutputPath, outputPath);
    await fs.rm(segmentTmp, { recursive: true, force: true });
    return { plan, outputDuration, commands };
  } catch (error) {
    error.commands = [...commands, error.command].filter(Boolean);
    error.plan = plan;
    error.tempDir = segmentTmp;
    error.tempOutputPath = tempOutputPath;
    throw error;
  }
}

async function getStatusForGeneration(projectPath, segments) {
  const existing = await readJson(path.join(projectPath, ROUGHCUT_STATUS_FILE));
  return createStatusPayload(projectPath, segments, existing || {});
}

async function findPreservedRoughcut(projectPath, segment, statusEntry) {
  const expected = path.join(
    ROUGHCUT_DIR,
    `${segment.id}-${safeFilename(segment.title)}.mp4`,
  );
  const candidates = [statusEntry?.outputFile, expected].filter(Boolean);
  for (const outputFile of candidates) {
    if (await pathIsFile(path.join(projectPath, outputFile))) return outputFile;
  }
  return null;
}

function renderFailureMessage(summary, oldFilePreserved) {
  return oldFilePreserved
    ? `${summary}；本次生成失败，已保留旧粗剪文件。`
    : summary;
}

async function recordSegmentFailure({
  projectPath,
  status,
  segment,
  assignment,
  error,
}) {
  const previousEntry = status.segments.find((entry) => entry.segmentId === segment.id);
  const preservedOutputFile = await findPreservedRoughcut(
    projectPath,
    segment,
    previousEntry,
  );
  const oldFilePreserved = Boolean(preservedOutputFile);
  const summary = error.message.split('\n')[0];
  const message = renderFailureMessage(summary, oldFilePreserved);
  const entry = updateStatusEntry(status, segment.id, {
    status: 'failed',
    outputFile: preservedOutputFile,
    durationSec: oldFilePreserved ? previousEntry?.durationSec ?? null : null,
    generatedAt: oldFilePreserved ? previousEntry?.generatedAt ?? null : null,
    lastAttemptAt: new Date().toISOString(),
    oldFilePreserved,
    error: message,
  });
  await writeStatus(projectPath, status);
  await appendErrorLog(projectPath, segment, assignment, error, error.commands);
  return { entry, message };
}

async function generateOneSegment(projectPath, segmentId) {
  const validation = await validateSegmentForRender(projectPath, segmentId);
  const generationData = await loadGenerationData(projectPath).catch(() => null);
  if (!generationData) {
    throw new Error(validation.errors.join('；') || '粗剪生成前检查失败。');
  }
  const { segmentsPayload, assignmentsPayload } = generationData;
  const segment = segmentsPayload.segments.find((entry) => entry.id === segmentId);
  const assignment = assignmentsPayload.segments.find((entry) => entry.segmentId === segmentId);
  if (!segment) {
    throw new Error(validation.errors.join('；') || `找不到分段 ${segmentId}。`);
  }
  const status = await getStatusForGeneration(projectPath, segmentsPayload.segments);

  if (!validation.ok) {
    const error = new Error(validation.errors.join('；'));
    error.validationReport = validation;
    const failed = await recordSegmentFailure({
      projectPath,
      status,
      segment,
      assignment,
      error,
    });
    throw new Error(failed.message);
  }

  try {
    const result = await generateSegmentInternal(projectPath, segment, assignment);
    const entry = updateStatusEntry(status, segmentId, {
      status: 'success',
      outputFile: result.plan.outputFile,
      durationSec: result.outputDuration,
      generatedAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      oldFilePreserved: false,
      error: null,
    });
    await writeStatus(projectPath, status);
    return { entry, statusPayload: status };
  } catch (error) {
    const failed = await recordSegmentFailure({
      projectPath,
      status,
      segment,
      assignment,
      error,
    });
    throw new Error(failed.message);
  }
}

async function generateAllSegments(projectPath) {
  const { segmentsPayload, assignmentsPayload } = await loadGenerationData(projectPath);
  await backupCoreProjectJson(projectPath);
  const status = await getStatusForGeneration(projectPath, segmentsPayload.segments);
  const results = [];

  for (const segment of segmentsPayload.segments) {
    const assignment = assignmentsPayload.segments.find(
      (entry) => entry.segmentId === segment.id,
    );
    const validation = await validateSegmentForRender(projectPath, segment.id);
    if (!validation.ok) {
      const error = new Error(validation.errors.join('；'));
      error.validationReport = validation;
      const failed = await recordSegmentFailure({
        projectPath,
        status,
        segment,
        assignment,
        error,
      });
      results.push(failed.entry);
      continue;
    }

    try {
      const generated = await generateSegmentInternal(projectPath, segment, assignment);
      const entry = updateStatusEntry(status, segment.id, {
        status: 'success',
        outputFile: generated.plan.outputFile,
        durationSec: generated.outputDuration,
        generatedAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        oldFilePreserved: false,
        error: null,
      });
      results.push(entry);
    } catch (error) {
      const failed = await recordSegmentFailure({
        projectPath,
        status,
        segment,
        assignment,
        error,
      });
      results.push(failed.entry);
    }
    await writeStatus(projectPath, status);
  }

  await writeStatus(projectPath, status);
  return {
    statusPayload: status,
    results,
    successCount: results.filter((entry) => entry.status === 'success').length,
    skippedCount: results.filter((entry) => entry.status === 'skipped').length,
    failedCount: results.filter((entry) => entry.status === 'failed').length,
    preservedCount: results.filter((entry) => entry.oldFilePreserved).length,
  };
}

module.exports = {
  getAudioVolume,
  getVideoFilter,
  validateSegmentPlan,
  validateSegmentForRender,
  buildRoughcutPlan,
  buildMergedVoiceTrack,
  loadRoughcutStatus,
  generateOneSegment,
  generateAllSegments,
};
