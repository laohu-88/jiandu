const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const {
  APP_VERSION,
  SEGMENTS_FILE,
  ASSIGNMENTS_FILE,
  ROUGHCUT_DIR,
  ROUGHCUT_STATUS_FILE,
  ROUGHCUT_ERROR_FILE,
  ROUGHCUT_TMP_DIR,
} = require('../constants');
const { writeProjectState } = require('./project-service');
const { safeFilename, getTotalDuration } = require('./stage3-service');

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

function quoteArg(value) {
  const text = String(value);
  return /[\s"'\\]/.test(text) ? JSON.stringify(text) : text;
}

function commandText(command, args) {
  return [command, ...args.map(quoteArg)].join(' ');
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeout || 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      command: commandText(command, args),
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } catch (error) {
    const wrapped = new Error(error.stderr?.trim() || error.message);
    wrapped.command = commandText(command, args);
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

function validateSegmentPlan(segment, assignment) {
  if (!segment) throw new Error('segments.json 中找不到该分段。');
  if (!segment.voiceFile) throw new Error('本段缺少配音文件，请先扫描配音。');
  if (!Number.isFinite(segment.durationSec)) {
    throw new Error('本段缺少有效配音时长，请重新扫描配音。');
  }
  if (!assignment?.items?.length) throw new Error('本段没有素材编排，无法生成粗剪。');

  const totalDuration = getTotalDuration(assignment.items);
  const difference = Number((totalDuration - segment.durationSec).toFixed(3));
  if (Math.abs(difference) > 0.05) {
    throw new Error(
      `素材总时长 ${totalDuration.toFixed(2)} 秒与配音时长 `
      + `${segment.durationSec.toFixed(2)} 秒未对齐。`,
    );
  }
  return { totalDuration, difference };
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
  validateSegmentPlan(segment, assignment);
  const sortedItems = [...assignment.items].sort((a, b) => a.order - b.order);
  return {
    segmentId: segment.id,
    title: segment.title,
    voiceFile: segment.voiceFile,
    voiceDurationSec: segment.durationSec,
    outputFile: path.join(
      ROUGHCUT_DIR,
      `${segment.id}-${safeFilename(segment.title)}.mp4`,
    ),
    items: sortedItems.map((item, index) => {
      const fitMode = VALID_FIT_MODES.has(item.fitMode) ? item.fitMode : 'contain';
      const audioMode = VALID_AUDIO_MODES.has(item.audioMode) ? item.audioMode : 'none';
      return {
        ...item,
        fitMode,
        audioMode,
        audioVolume: item.type === 'image' ? 0 : getAudioVolume(audioMode),
        videoFilter: getVideoFilter(fitMode, item.type, item.durationSec),
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
  if (!(await pathIsFile(path.join(projectPath, plan.voiceFile)))) {
    throw new Error(`配音文件不存在：${plan.voiceFile}`);
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

async function appendErrorLog(projectPath, segment, error, commands = []) {
  const lines = [
    '',
    '============================================================',
    `时间：${new Date().toISOString()}`,
    `segmentId：${segment?.id || 'unknown'}`,
    `segment title：${segment?.title || 'unknown'}`,
    '命令或关键参数：',
    ...(commands.length ? commands : [error.command || '未执行 ffmpeg 命令']),
    'stderr：',
    error.stderr || error.stack || error.message,
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

  const segmentTmp = path.join(projectPath, ROUGHCUT_TMP_DIR, segment.id);
  const outputPath = path.join(projectPath, plan.outputFile);
  await fs.rm(segmentTmp, { recursive: true, force: true });
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

    const finalResult = await mixVoice(
      concatPath,
      path.join(projectPath, plan.voiceFile),
      plan.voiceDurationSec,
      outputPath,
    );
    commands.push(finalResult.command);
    const outputDuration = await probeDuration(outputPath);
    await fs.rm(segmentTmp, { recursive: true, force: true });
    return { plan, outputDuration, commands };
  } catch (error) {
    error.commands = [...commands, error.command].filter(Boolean);
    throw error;
  }
}

async function getStatusForGeneration(projectPath, segments) {
  const existing = await readJson(path.join(projectPath, ROUGHCUT_STATUS_FILE));
  return createStatusPayload(projectPath, segments, existing || {});
}

async function generateOneSegment(projectPath, segmentId) {
  const { segmentsPayload, assignmentsPayload } = await loadGenerationData(projectPath);
  const segment = segmentsPayload.segments.find((entry) => entry.id === segmentId);
  const assignment = assignmentsPayload.segments.find((entry) => entry.segmentId === segmentId);
  const status = await getStatusForGeneration(projectPath, segmentsPayload.segments);

  try {
    const result = await generateSegmentInternal(projectPath, segment, assignment);
    const entry = updateStatusEntry(status, segmentId, {
      status: 'success',
      outputFile: result.plan.outputFile,
      durationSec: result.outputDuration,
      generatedAt: new Date().toISOString(),
      error: null,
    });
    await writeStatus(projectPath, status);
    return { entry, statusPayload: status };
  } catch (error) {
    const summary = error.message.split('\n')[0];
    updateStatusEntry(status, segmentId, {
      status: 'failed',
      outputFile: null,
      durationSec: null,
      generatedAt: null,
      error: summary,
    });
    await writeStatus(projectPath, status);
    await appendErrorLog(projectPath, segment, error, error.commands);
    throw new Error(summary);
  }
}

async function generateAllSegments(projectPath) {
  const { segmentsPayload, assignmentsPayload } = await loadGenerationData(projectPath);
  const status = await getStatusForGeneration(projectPath, segmentsPayload.segments);
  const results = [];

  for (const segment of segmentsPayload.segments) {
    const assignment = assignmentsPayload.segments.find(
      (entry) => entry.segmentId === segment.id,
    );
    try {
      validateSegmentPlan(segment, assignment);
    } catch (error) {
      const entry = updateStatusEntry(status, segment.id, {
        status: 'skipped',
        outputFile: null,
        durationSec: null,
        generatedAt: null,
        error: error.message,
      });
      results.push(entry);
      continue;
    }

    try {
      const generated = await generateSegmentInternal(projectPath, segment, assignment);
      const entry = updateStatusEntry(status, segment.id, {
        status: 'success',
        outputFile: generated.plan.outputFile,
        durationSec: generated.outputDuration,
        generatedAt: new Date().toISOString(),
        error: null,
      });
      results.push(entry);
    } catch (error) {
      const summary = error.message.split('\n')[0];
      const entry = updateStatusEntry(status, segment.id, {
        status: 'failed',
        outputFile: null,
        durationSec: null,
        generatedAt: null,
        error: summary,
      });
      results.push(entry);
      await appendErrorLog(projectPath, segment, error, error.commands);
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
  };
}

module.exports = {
  getAudioVolume,
  getVideoFilter,
  validateSegmentPlan,
  buildRoughcutPlan,
  loadRoughcutStatus,
  generateOneSegment,
  generateAllSegments,
};
