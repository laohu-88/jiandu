#!/usr/bin/env node
// 剪渡 媒体工具运行时：外部命令解析、执行、环境探测的唯一实现。
const { constants: fsConstants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const TOOL_SEARCH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

async function resolveToolPath(toolName) {
  const command = String(toolName || '').trim();
  if (!command) return null;

  const candidates = path.isAbsolute(command)
    ? [command]
    : [
      ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean),
      ...TOOL_SEARCH_DIRS,
    ].map((directory) => path.resolve(directory, command));

  for (const candidate of new Set(candidates)) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // 继续尝试下一个 PATH 或常见安装位置。
    }
  }
  return null;
}

function createToolError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function formatCommand(command, args) {
  return [command, ...args.map((value) => JSON.stringify(String(value)))].join(' ');
}

async function runMediaTool(command, args, options = {}) {
  const executable = await resolveToolPath(command);
  if (!executable) {
    throw createToolError(
      'MEDIA_TOOL_NOT_FOUND',
      `找不到 ${command}，请先安装或配置项目现有媒体工具。`,
      { tool: command },
    );
  }

  try {
    const result = await execFileAsync(executable, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs || 10 * 60 * 1000,
      maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
    });
    return {
      executable,
      command: formatCommand(executable, args),
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } catch (error) {
    const stderr = String(error.stderr || '').trim();
    throw createToolError(
      'MEDIA_TOOL_FAILED',
      stderr.split('\n').filter(Boolean).at(-1) || error.message,
      {
        tool: command,
        command: formatCommand(executable, args),
        stderr: error.stderr || error.message,
      },
    );
  }
}

function parseFrameRate(value) {
  if (typeof value !== 'string') return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  const fps = numerator / denominator;
  return fps > 0 ? Number(fps.toFixed(6)) : null;
}


async function probeMedia(filePath) {
  const result = await runMediaTool('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], { timeoutMs: 60_000 });
  const payload = JSON.parse(result.stdout);
  const videoStream = payload.streams?.find((stream) => stream.codec_type === 'video');
  const audioStream = payload.streams?.find((stream) => stream.codec_type === 'audio');
  const duration = Number(payload.format?.duration ?? videoStream?.duration);
  const width = Number(videoStream?.width) || null;
  const height = Number(videoStream?.height) || null;
  const rotation = Number(
    videoStream?.tags?.rotate
      ?? videoStream?.side_data_list?.find((entry) => entry.rotation != null)?.rotation,
  );
  const normalizedRotation = Number.isFinite(rotation) ? rotation : 0;
  const rotated = Math.abs(normalizedRotation) % 180 === 90;
  const displayWidth = rotated ? height : width;
  const displayHeight = rotated ? width : height;

  return {
    durationSec: Number.isFinite(duration) && duration >= 0
      ? Number(duration.toFixed(3))
      : null,
    width,
    height,
    displayWidth,
    displayHeight,
    orientation: displayWidth && displayHeight
      ? (displayWidth === displayHeight ? 'square' : displayWidth > displayHeight ? 'horizontal' : 'vertical')
      : 'unknown',
    rotation: normalizedRotation,
    frameRate: parseFrameRate(videoStream?.avg_frame_rate)
      || parseFrameRate(videoStream?.r_frame_rate),
    avgFrameRate: videoStream?.avg_frame_rate || null,
    rFrameRate: videoStream?.r_frame_rate || null,
    frameCount: (() => {
      const counted = Number(videoStream?.nb_frames);
      if (Number.isFinite(counted) && counted > 0) return Math.round(counted);
      return null;
    })(),
    durationTs: Number.isFinite(Number(videoStream?.duration_ts))
      ? Number(videoStream.duration_ts)
      : null,
    timeBase: videoStream?.time_base || null,
    videoCodec: videoStream?.codec_name || null,
    audioCodec: audioStream?.codec_name || null,
    pixelFormat: videoStream?.pix_fmt || null,
    sampleRate: Number(audioStream?.sample_rate) || null,
    audioChannels: Number(audioStream?.channels) || null,
    formatName: payload.format?.format_name || null,
    bitRate: Number(payload.format?.bit_rate) || null,
    creationTime: payload.format?.tags?.creation_time
      || videoStream?.tags?.creation_time
      || null,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
  };
}

async function probeMediaSafe(filePath) {
  try {
    return { ok: true, metadata: await probeMedia(filePath), error: null };
  } catch (error) {
    return {
      ok: false,
      metadata: null,
      error: {
        code: error.code || 'MEDIA_PROBE_FAILED',
        message: error.message,
      },
    };
  }
}

module.exports = {
  createToolError,
  parseFrameRate,
  probeMedia,
  probeMediaSafe,
  runMediaTool,
};

async function checkExecutable(command, args = ['-version']) {
  const commandPath = await resolveToolPath(command);
  if (!commandPath) {
    return {
      available: false,
      message: '不可用',
      detail: `未在 PATH 或常见安装位置找到 ${command}。`,
    };
  }
  try {
    const result = await execFileAsync(commandPath, args, {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return {
      available: true,
      message: '可用',
      detail: String(result.stdout || result.stderr || '').split('\n')[0],
      executablePath: commandPath,
    };
  } catch (error) {
    return {
      available: false,
      message: '不可用',
      detail: error.stderr || error.message,
    };
  }
}

async function checkSubtitleCommand(command = 'ww') {
  const cleanCommand = String(command || '').trim() || 'ww';
  if (!/^[\w./-]+$/.test(cleanCommand)) {
    return {
      available: false,
      message: '可能不可用',
      detail: '字幕命令包含空格或特殊字符。请填写真实命令路径或脚本路径。',
    };
  }
  const commandPath = await resolveToolPath(cleanCommand);
  if (!commandPath) {
    return {
      available: false,
      message: '可能不可用',
      detail: '未找到可执行文件。可以手动生成 raw.srt 后用“整理已有 SRT”。',
    };
  }
  return {
    available: true,
    message: '可用',
    detail: commandPath,
    executablePath: commandPath,
  };
}

async function detectEnvironment(subtitleCommand = 'ww') {
  const [ffmpeg, ffprobe, subtitle] = await Promise.all([
    checkExecutable('ffmpeg'),
    checkExecutable('ffprobe'),
    checkSubtitleCommand(subtitleCommand),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    ffmpeg,
    ffprobe,
    subtitleCommand: {
      command: subtitleCommand || 'ww',
      ...subtitle,
    },
    notes: [
      'ffmpeg / ffprobe 不可用时，粗剪生成和视频信息读取会受影响。',
      '字幕命令不可用时，可以先手动生成 raw.srt，再用“整理已有 SRT”。',
    ],
  };
}

module.exports = {
  checkExecutable,
  checkSubtitleCommand,
  createToolError,
  detectEnvironment,
  parseFrameRate,
  probeMedia,
  probeMediaSafe,
  resolveToolPath,
  runMediaTool,
};
