const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { resolveToolPath } = require('./stage7-service');

const execFileAsync = promisify(execFile);

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
