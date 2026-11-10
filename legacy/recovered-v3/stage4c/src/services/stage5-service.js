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
  FINAL_ROUGHCUT_STATUS_FILE,
  FINAL_ROUGHCUT_ERROR_FILE,
  FINAL_ROUGHCUT_TMP_DIR,
  FCP_HANDOFF_FILE,
  FINAL_ROUGHCUT_FILE,
} = require('../constants');
const { writeProjectState } = require('./project-service');
const { compileTimeline, getSegmentDuration } = require('./timeline-engine');
const { backupCoreProjectJson } = require('./backup-service');
const { resolveToolPath } = require('./stage7-service');

const execFileAsync = promisify(execFile);

const FIT_LABELS = {
  contain: '完整显示',
  cover: '铺满裁切',
  blur: '背景模糊填充',
  push_in: '轻微推近',
};

const AUDIO_LABELS = {
  none: '无原声',
  keep: '保留原声',
  duck: '压低原声',
  smart_duck: '智能压低原声',
};

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

function escapeConcatPath(filePath) {
  return filePath.replace(/'/g, "'\\''");
}

function buildConcatListContent(inputPaths) {
  return inputPaths.map((filePath) => `file '${escapeConcatPath(filePath)}'`).join('\n') + '\n';
}

function sortSegments(segments = []) {
  return [...segments].sort((a, b) => {
    const left = Number.isFinite(a.index) ? a.index : Number(a.id);
    const right = Number.isFinite(b.index) ? b.index : Number(b.id);
    return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
  });
}

function segmentNumberText(segment) {
  const number = Number.isFinite(segment?.index) ? segment.index : Number(segment?.id);
  return Number.isFinite(number) ? `第 ${number} 段` : `分段 ${segment?.id || ''}`.trim();
}

async function loadFinalData(projectPath) {
  const [segmentsPayload, roughcutStatusPayload, assignmentsPayload] = await Promise.all([
    readJson(path.join(projectPath, SEGMENTS_FILE)),
    readJson(path.join(projectPath, ROUGHCUT_STATUS_FILE)),
    readJson(path.join(projectPath, ASSIGNMENTS_FILE)),
  ]);
  if (!segmentsPayload?.segments?.length) throw new Error('找不到 segments.json，请先导入视频方案。');
  if (!roughcutStatusPayload?.segments?.length) {
    throw new Error('找不到 roughcut-status.json，请先生成分段粗剪。');
  }
  return { segmentsPayload, roughcutStatusPayload, assignmentsPayload };
}

async function buildFinalRoughcutPlan(projectPath) {
  const { segmentsPayload, roughcutStatusPayload, assignmentsPayload } = await loadFinalData(projectPath);
  const roughcutById = new Map(
    roughcutStatusPayload.segments.map((entry) => [entry.segmentId, entry]),
  );
  const orderedSegments = sortSegments(segmentsPayload.segments);
  const inputs = [];

  for (const segment of orderedSegments) {
    const status = roughcutById.get(segment.id);
    if (!status || status.status !== 'success' || !status.outputFile) {
      const reason = status?.status === 'failed'
        ? '分段粗剪生成失败'
        : '缺少分段粗剪';
      throw new Error(`${segmentNumberText(segment)}${reason}，无法生成总粗剪。`);
    }
    const absolutePath = path.join(projectPath, status.outputFile);
    if (!(await pathIsFile(absolutePath))) {
      throw new Error(`${segmentNumberText(segment)}缺少分段粗剪，无法生成总粗剪。`);
    }
    const assignment = assignmentsPayload?.segments?.find(
      (entry) => entry.segmentId === segment.id,
    );
    const segmentTimeline = compileTimeline({ ...segment, items: assignment?.items || [] });
    inputs.push({
      segment,
      items: assignment?.items || [],
      relativePath: status.outputFile,
      absolutePath,
      timeline: segmentTimeline,
    });
  }

  const timeline = compileTimeline({
    segments: inputs.map((input) => ({
      segment: input.segment,
      items: input.items,
      programFile: input.relativePath,
    })),
  });

  const outputPath = path.join(projectPath, FINAL_ROUGHCUT_FILE);
  return {
    outputFile: FINAL_ROUGHCUT_FILE,
    outputPath,
    inputs,
    timeline,
    duration: getSegmentDuration({ timeline }),
    concatListContent: buildConcatListContent(inputs.map((entry) => entry.absolutePath)),
    overwritten: await pathIsFile(outputPath),
  };
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

function createFinalStatusPayload(projectPath, patch = {}) {
  const now = new Date().toISOString();
  return {
    version: APP_VERSION,
    status: patch.status || 'pending',
    outputFile: patch.outputFile ?? null,
    durationSec: patch.durationSec ?? null,
    segmentCount: patch.segmentCount ?? 0,
    generatedAt: patch.generatedAt ?? null,
    updatedAt: now,
    error: patch.error ?? null,
    timeline: patch.timeline ?? null,
    oldFilePreserved: patch.oldFilePreserved ?? false,
  };
}

async function writeFinalStatus(projectPath, payload) {
  const status = {
    ...payload,
    version: APP_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(projectPath, FINAL_ROUGHCUT_STATUS_FILE),
    `${JSON.stringify(status, null, 2)}\n`,
    'utf8',
  );
  await writeProjectState(projectPath);
  return status;
}

async function loadFinalRoughcutStatus(projectPath) {
  const existing = await readJson(path.join(projectPath, FINAL_ROUGHCUT_STATUS_FILE));
  if (existing) {
    return {
      ...existing,
      version: APP_VERSION,
      status: existing.status || 'pending',
    };
  }
  return writeFinalStatus(projectPath, createFinalStatusPayload(projectPath));
}

async function appendFinalErrorLog(projectPath, plan, error, commands = [], details = {}) {
  const lines = [
    '',
    '============================================================',
    `时间：${new Date().toISOString()}`,
    'concat 列表：',
    plan?.concatListContent || '未生成 concat 列表',
    `临时输出：${details.tempOutputPath || '未创建'}`,
    `旧总粗剪保留：${details.oldFilePreserved ? '是' : '否'}`,
    '命令或关键参数：',
    ...(commands.length ? commands : [error.command || '未执行 ffmpeg 命令']),
    'stderr：',
    error.stderr || error.stack || error.message,
    '',
  ];
  await fs.appendFile(
    path.join(projectPath, FINAL_ROUGHCUT_ERROR_FILE),
    lines.join('\n'),
    'utf8',
  );
}

function copyConcatArgs(concatListPath, outputPath) {
  return [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-c', 'copy',
    outputPath,
  ];
}

function reencodeConcatArgs(concatListPath, outputPath) {
  return [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
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

async function generateFinalRoughcut(projectPath) {
  let plan = null;
  const commands = [];
  let tempOutputPath = null;
  await backupCoreProjectJson(projectPath);
  const previousStatus = await readJson(path.join(projectPath, FINAL_ROUGHCUT_STATUS_FILE));
  const formalOutputPath = path.join(projectPath, FINAL_ROUGHCUT_FILE);
  const oldFileExistedBeforeAttempt = await pathIsFile(formalOutputPath);
  try {
    plan = await buildFinalRoughcutPlan(projectPath);
    if (!(await toolAvailable('ffmpeg'))) throw new Error('找不到 ffmpeg，无法生成总粗剪。');
    if (!(await toolAvailable('ffprobe'))) throw new Error('找不到 ffprobe，无法生成总粗剪。');

    await fs.mkdir(path.dirname(plan.outputPath), { recursive: true });
    const tmpDir = path.join(projectPath, FINAL_ROUGHCUT_TMP_DIR);
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });
    const concatListPath = path.join(tmpDir, 'concat.txt');
    tempOutputPath = path.join(tmpDir, 'full-roughcut.tmp.mp4');
    await fs.writeFile(concatListPath, plan.concatListContent, 'utf8');

    try {
      const copyResult = await runCommand('ffmpeg', copyConcatArgs(concatListPath, tempOutputPath));
      commands.push(copyResult.command);
    } catch (copyError) {
      commands.push(copyError.command);
      const reencodeResult = await runCommand(
        'ffmpeg',
        reencodeConcatArgs(concatListPath, tempOutputPath),
      );
      commands.push(reencodeResult.command);
    }

    const durationSec = await probeDuration(tempOutputPath);
    await fs.rename(tempOutputPath, plan.outputPath);
    await fs.rm(tmpDir, { recursive: true, force: true });

    const status = await writeFinalStatus(projectPath, createFinalStatusPayload(projectPath, {
      status: 'success',
      outputFile: plan.outputFile,
      durationSec,
      segmentCount: plan.inputs.length,
      timeline: plan.timeline,
      generatedAt: new Date().toISOString(),
      error: null,
    }));
    return {
      status,
      overwritten: plan.overwritten,
      message: plan.overwritten ? '已覆盖旧总粗剪。' : '总粗剪已生成。',
      commands,
    };
  } catch (error) {
    const summary = error.message.split('\n')[0];
    const oldFilePreserved = oldFileExistedBeforeAttempt && await pathIsFile(formalOutputPath);
    const message = oldFilePreserved
      ? `${summary}；本次生成失败，已保留旧总粗剪文件。`
      : `${summary}；本次生成失败，当前没有可保留的旧总粗剪文件。`;
    const status = await writeFinalStatus(projectPath, createFinalStatusPayload(projectPath, {
      status: 'failed',
      outputFile: oldFilePreserved ? FINAL_ROUGHCUT_FILE : null,
      durationSec: oldFilePreserved ? previousStatus?.durationSec ?? null : null,
      segmentCount: previousStatus?.segmentCount ?? plan?.inputs?.length ?? 0,
      timeline: plan?.timeline || previousStatus?.timeline || null,
      generatedAt: oldFilePreserved ? previousStatus?.generatedAt ?? null : null,
      oldFilePreserved,
      error: message,
    }));
    await appendFinalErrorLog(projectPath, plan, error, commands, {
      tempOutputPath,
      oldFilePreserved,
    });
    const wrapped = new Error(message);
    wrapped.status = status;
    throw wrapped;
  }
}

function indentText(text) {
  const clean = String(text || '').trim();
  if (!clean) return '  （无）';
  return clean.split(/\r?\n/).map((line) => `  ${line}`).join('\n');
}

function formatSeconds(seconds) {
  return Number.isFinite(seconds) ? `${Number(seconds).toFixed(2)} 秒` : '—';
}

function getAssignment(assignmentsPayload, segmentId) {
  return assignmentsPayload?.segments?.find((entry) => entry.segmentId === segmentId)
    || { segmentId, items: [] };
}

function getRoughcutEntry(roughcutStatusPayload, segmentId) {
  return roughcutStatusPayload?.segments?.find((entry) => entry.segmentId === segmentId);
}

function buildFcpHandoffMarkdown({
  project,
  segmentsPayload,
  assignmentsPayload,
  roughcutStatusPayload,
  finalStatus,
  generatedAt,
}) {
  const projectName = project?.projectName || '未命名项目';
  const orderedSegments = sortSegments(segmentsPayload?.segments || []);
  const finalPreview = finalStatus?.status === 'success' && finalStatus.outputFile
    ? finalStatus.outputFile
    : FINAL_ROUGHCUT_FILE;
  const lines = [
    '# FCP 交接清单',
    '',
    `项目：${projectName}`,
    `生成时间：${generatedAt}`,
    '',
    '## 推荐导入方式',
    '',
    '请将以下分段粗剪按顺序导入 Final Cut Pro 时间线：',
    '',
  ];

  orderedSegments.forEach((segment, index) => {
    const roughcut = getRoughcutEntry(roughcutStatusPayload, segment.id);
    lines.push(`${index + 1}. ${roughcut?.outputFile || path.join(ROUGHCUT_DIR, `${segment.id}-${segment.title}.mp4`)}`);
  });

  lines.push(
    '',
    '也可以先预览：',
    finalPreview,
    '',
    '## 每段信息',
    '',
  );

  for (const segment of orderedSegments) {
    const assignment = getAssignment(assignmentsPayload, segment.id);
    const roughcut = getRoughcutEntry(roughcutStatusPayload, segment.id);
    const timeline = compileTimeline({ ...segment, items: assignment.items });
    lines.push(
      `### ${segment.id} ${segment.title}`,
      `- 分段粗剪：${roughcut?.outputFile || '未生成'}`,
      `- 配音时长：${formatSeconds(timeline.voiceDuration)}`,
      '- 口播：',
      indentText(segment.voiceoverText),
      '- 使用素材：',
    );
    const visualItems = timeline.items
      .filter((item) => item.type === 'video' && item.track === 'visual')
      .sort((a, b) => a.order - b.order);
    const pauseItems = timeline.items.filter((item) => item.type === 'pause');
    if (!visualItems.length) {
      lines.push('  - （无）');
    } else {
      for (const item of visualItems) {
        lines.push(
          `  - ${item.filename}｜${formatSeconds(item.durationSec)}`
          + `｜${FIT_LABELS[item.fitMode] || item.fitMode || '未知显示方式'}`
          + `｜${AUDIO_LABELS[item.audioMode] || item.audioMode || '未知原声处理'}`,
        );
      }
    }
    for (const pause of pauseItems) {
      lines.push(`  - 停顿｜${formatSeconds(pause.durationSec)}｜冻结上一帧`);
    }
    lines.push('');
  }

  lines.push(
    '## FCP 精剪建议',
    '',
    '1. 按顺序导入每段粗剪。',
    '2. 检查段落衔接与节奏。',
    '3. 需要素材原声、猫叫、点击声时，到 03-分段素材包 对应分段中取原素材。',
    '4. 添加音乐、音效、转场。',
    '5. 精剪完成后导出最终视频到 06-FCP导出。',
    '6. 最终字幕不要分段生成，等整片导出后再统一生成字幕。',
    '',
  );
  return lines.join('\n');
}

async function generateFcpHandoff(projectPath) {
  const [
    project,
    segmentsPayload,
    assignmentsPayload,
    roughcutStatusPayload,
    finalStatus,
  ] = await Promise.all([
    readJson(path.join(projectPath, PROJECT_FILE)),
    readJson(path.join(projectPath, SEGMENTS_FILE)),
    readJson(path.join(projectPath, ASSIGNMENTS_FILE)),
    readJson(path.join(projectPath, ROUGHCUT_STATUS_FILE)),
    readJson(path.join(projectPath, FINAL_ROUGHCUT_STATUS_FILE)),
  ]);
  if (!segmentsPayload?.segments?.length) throw new Error('找不到 segments.json，请先导入视频方案。');
  if (!assignmentsPayload?.segments) throw new Error('找不到 segment-assignments.json，请先完成素材编排。');
  if (!roughcutStatusPayload?.segments) throw new Error('找不到 roughcut-status.json，请先生成分段粗剪。');

  const generatedAt = new Date().toISOString();
  const markdown = buildFcpHandoffMarkdown({
    project,
    segmentsPayload,
    assignmentsPayload,
    roughcutStatusPayload,
    finalStatus,
    generatedAt,
  });
  await fs.writeFile(path.join(projectPath, FCP_HANDOFF_FILE), markdown, 'utf8');
  await writeProjectState(projectPath);
  return {
    outputPath: FCP_HANDOFF_FILE,
    segmentCount: segmentsPayload.segments.length,
    generatedAt,
  };
}

module.exports = {
  FIT_LABELS,
  AUDIO_LABELS,
  buildConcatListContent,
  buildFinalRoughcutPlan,
  createFinalStatusPayload,
  writeFinalStatus,
  loadFinalRoughcutStatus,
  generateFinalRoughcut,
  buildFcpHandoffMarkdown,
  generateFcpHandoff,
  copyConcatArgs,
  reencodeConcatArgs,
};
