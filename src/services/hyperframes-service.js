const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { hashFile } = require('./pending-media-service');
const { probeMedia } = require('./media-tool-service');

const execFileAsync = promisify(execFile);
const GENERATED_ASSET_ID = 'generated_hyperframes_title_card';
const GENERATED_SHOT_ID = 'generated-hyperframes-title-card';
const REQUIRED_DOCTOR_CHECKS = ['Node.js', 'FFmpeg', 'FFprobe', 'Chrome'];
const SUPPORTED_QUALITIES = new Set(['draft', 'standard', 'high']);
const SYSTEM_BROWSER_PATHS = process.platform === 'darwin'
  ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  : [];

function createHyperframesError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function positiveNumber(value, fallback, label) {
  const number = value == null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw createHyperframesError('INVALID_HYPERFRAMES_OPTIONS', `${label} 必须是正数。`);
  }
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw createHyperframesError('INVALID_HYPERFRAMES_OPTIONS', `${label} 必须是正整数。`);
  }
  return number;
}

function normalizeRenderOptions(options = {}) {
  const width = positiveInteger(options.width, 'HyperFrames width');
  const height = positiveInteger(options.height, 'HyperFrames height');
  const fps = positiveNumber(options.fps, 30, 'HyperFrames fps');
  const durationSec = positiveNumber(options.durationSec, 2, 'HyperFrames duration');
  const quality = String(options.quality || 'standard').trim();
  if (!SUPPORTED_QUALITIES.has(quality)) {
    throw createHyperframesError(
      'INVALID_HYPERFRAMES_OPTIONS',
      'HyperFrames quality 必须是 draft、standard 或 high。',
    );
  }
  return {
    width,
    height,
    fps,
    durationSec: Number(durationSec.toFixed(3)),
    quality,
  };
}

function titleFontSize(title, width, height) {
  const length = [...String(title || '')].length;
  const base = Math.min(width, height);
  const ratio = length > 48 ? 0.07 : length > 28 ? 0.085 : 0.105;
  return Math.max(28, Math.min(104, Math.round(base * ratio)));
}

function subtitleFontSize(width, height) {
  return Math.max(18, Math.min(42, Math.round(Math.min(width, height) * 0.038)));
}

function hyperframesFpsArgument(fps) {
  const value = Number(fps);
  if (Math.abs(value - 23.976) < 0.01) return '24000/1001';
  if (Math.abs(value - 29.97) < 0.01) return '30000/1001';
  if (Math.abs(value - 59.94) < 0.01) return '60000/1001';
  if (Number.isInteger(value)) return String(value);
  const denominator = 1000;
  const numerator = Math.round(value * denominator);
  const gcd = (left, right) => (right ? gcd(right, left % right) : Math.abs(left) || 1);
  const divisor = gcd(numerator, denominator);
  return `${numerator / divisor}/${denominator / divisor}`;
}

function buildTitleCardHtml(options) {
  const format = normalizeRenderOptions(options);
  const title = String(options.title || '').trim();
  const subtitle = String(options.subtitle || '').trim();
  if (!title) {
    throw createHyperframesError('INVALID_HYPERFRAMES_OPTIONS', 'HyperFrames 标题不能为空。');
  }
  const titleSize = titleFontSize(title, format.width, format.height);
  const subtitleSize = subtitleFontSize(format.width, format.height);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${format.width}, height=${format.height}" />
    <style>
      * { box-sizing: border-box; }
      html, body {
        width: ${format.width}px;
        height: ${format.height}px;
        margin: 0;
        overflow: hidden;
      }
      body {
        background: #07111f;
        color: #f8fafc;
        font-family: sans-serif;
      }
      #root {
        position: relative;
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        isolation: isolate;
      }
      #grid {
        position: absolute;
        inset: 0;
        background-image:
          linear-gradient(rgba(148, 163, 184, 0.08) 1px, transparent 1px),
          linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px);
        background-size: 8vw 8vw;
        mask-image: linear-gradient(to bottom, rgba(0,0,0,.85), transparent);
      }
      #glow {
        position: absolute;
        width: 72vmin;
        height: 72vmin;
        border-radius: 50%;
        background: #2563eb;
        filter: blur(20vmin);
        opacity: .48;
      }
      #card {
        position: relative;
        width: min(86%, 1400px);
        padding: clamp(28px, 5vmin, 76px);
        border: 1px solid rgba(255,255,255,.24);
        border-radius: clamp(22px, 3vmin, 48px);
        background: rgba(15, 23, 42, .82);
        box-shadow: 0 5vmin 14vmin rgba(2, 6, 23, .5);
      }
      #eyebrow {
        color: #93c5fd;
        font-size: ${Math.max(14, Math.round(subtitleSize * 0.72))}px;
        font-weight: 700;
        letter-spacing: .18em;
      }
      h1 {
        margin: .3em 0 .22em;
        max-width: 100%;
        color: #f8fafc;
        font-size: ${titleSize}px;
        line-height: 1.08;
        letter-spacing: -.035em;
        text-wrap: balance;
        overflow-wrap: anywhere;
      }
      p {
        display: -webkit-box;
        margin: 0;
        color: #cbd5e1;
        font-size: ${subtitleSize}px;
        line-height: 1.45;
        overflow: hidden;
        overflow-wrap: anywhere;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
      }
      #accent {
        width: clamp(54px, 9vw, 160px);
        height: clamp(5px, .7vmin, 10px);
        margin-top: clamp(22px, 4vmin, 56px);
        border-radius: 999px;
        background: linear-gradient(90deg, #60a5fa, #22d3ee);
      }
    </style>
  </head>
  <body>
    <main id="root" data-composition-id="main" data-no-timeline data-start="0"
      data-duration="${format.durationSec}" data-width="${format.width}"
      data-height="${format.height}" data-fps="${format.fps}">
      <div id="grid" class="clip" data-start="0" data-duration="${format.durationSec}" data-track-index="0"></div>
      <div id="glow" class="clip" data-start="0" data-duration="${format.durationSec}" data-track-index="1"></div>
      <section id="card" class="clip" data-start="0" data-duration="${format.durationSec}" data-track-index="2">
        <div id="eyebrow">VIDEO CUT PLANNER · HYPERFRAMES</div>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(subtitle)}</p>
        <div id="accent"></div>
      </section>
    </main>
  </body>
</html>
`;
}

async function executableFile(candidate) {
  if (!candidate) return null;
  try {
    await fs.access(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

async function resolveHyperframesExecutable(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(path.resolve(String(explicitPath)));
  if (process.env.HYPERFRAMES_BIN) candidates.push(path.resolve(process.env.HYPERFRAMES_BIN));
  candidates.push(path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'hyperframes'));
  for (const directory of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.resolve(directory, process.platform === 'win32' ? 'hyperframes.cmd' : 'hyperframes'));
  }
  for (const candidate of new Set(candidates)) {
    if (await executableFile(candidate)) return candidate;
  }
  return null;
}

async function resolveBrowserPath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.HYPERFRAMES_BROWSER_PATH,
    ...SYSTEM_BROWSER_PATHS,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await executableFile(candidate)) return candidate;
  }
  return null;
}

function formatCommand(executable, args) {
  return [executable, ...args.map((value) => JSON.stringify(String(value)))].join(' ');
}

async function runHyperframesCommand(executable, args, options = {}) {
  const env = {
    ...process.env,
    HYPERFRAMES_NO_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    HYPERFRAMES_FONT_CACHE_DIR: options.fontCacheDir
      || path.join(os.tmpdir(), 'video-cut-planner-v3-hyperframes-font-cache'),
  };
  const browserPath = await resolveBrowserPath(options.browserPath);
  if (browserPath) env.HYPERFRAMES_BROWSER_PATH = browserPath;
  try {
    const result = await execFileAsync(executable, args, {
      cwd: options.cwd,
      env,
      timeout: options.timeoutMs || 30 * 60 * 1000,
      maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    });
    return {
      command: formatCommand(executable, args),
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      browserPath,
    };
  } catch (error) {
    const stderr = String(error.stderr || '').trim();
    throw createHyperframesError(
      'HYPERFRAMES_COMMAND_FAILED',
      stderr.split('\n').filter(Boolean).at(-1) || error.message,
      {
        command: formatCommand(executable, args),
        stderr: error.stderr || error.message,
        stdout: error.stdout || '',
      },
    );
  }
}

function requiredDoctorReport(doctor = {}) {
  const checks = Array.isArray(doctor.checks) ? doctor.checks : [];
  const byName = new Map(checks.map((check) => [check.name, check]));
  const missing = REQUIRED_DOCTOR_CHECKS
    .map((name) => byName.get(name) || { name, ok: false, detail: '未返回检测结果。' })
    .filter((check) => !check.ok);
  const optionalWarnings = checks
    .filter((check) => !check.ok && !REQUIRED_DOCTOR_CHECKS.includes(check.name))
    .map((check) => `${check.name}：${check.detail}`);
  return {
    available: missing.length === 0,
    missing,
    optionalWarnings,
    requiredChecks: REQUIRED_DOCTOR_CHECKS.map((name) => byName.get(name) || {
      name,
      ok: false,
      detail: '未返回检测结果。',
    }),
  };
}

async function inspectHyperframesEnvironment(options = {}) {
  const executable = await resolveHyperframesExecutable(options.executablePath);
  if (!executable) {
    return {
      available: false,
      executable: null,
      version: null,
      requiredChecks: [],
      optionalWarnings: [],
      errors: ['未找到 HyperFrames CLI；请运行 npm install。'],
    };
  }
  const command = await runHyperframesCommand(executable, ['doctor', '--json'], {
    browserPath: options.browserPath,
    timeoutMs: 60_000,
  });
  let doctor;
  try {
    doctor = JSON.parse(command.stdout.trim());
  } catch (error) {
    throw createHyperframesError(
      'INVALID_HYPERFRAMES_DOCTOR_OUTPUT',
      `无法解析 HyperFrames doctor 输出：${error.message}`,
    );
  }
  const required = requiredDoctorReport(doctor);
  return {
    available: required.available,
    executable,
    version: doctor._meta?.version || null,
    requiredChecks: required.requiredChecks,
    optionalWarnings: required.optionalWarnings,
    errors: required.missing.map((check) => `${check.name}：${check.detail}`),
    browserPath: command.browserPath,
    doctorOk: doctor.ok === true,
  };
}

function parseCheckOutput(stdout) {
  try {
    return JSON.parse(String(stdout || '').trim());
  } catch (error) {
    throw createHyperframesError(
      'INVALID_HYPERFRAMES_CHECK_OUTPUT',
      `无法解析 HyperFrames check 输出：${error.message}`,
    );
  }
}

async function renderHyperframesTitleCard(options) {
  const format = normalizeRenderOptions(options);
  const compositionDirectory = path.resolve(options.compositionDirectory);
  const outputPath = path.resolve(options.outputPath);
  const existing = await fs.stat(outputPath).catch(() => null);
  if (existing) {
    throw createHyperframesError('HYPERFRAMES_OUTPUT_EXISTS', `HyperFrames 输出已存在：${outputPath}`);
  }
  const environment = options.environment || await inspectHyperframesEnvironment(options);
  if (!environment.available) {
    throw createHyperframesError(
      'HYPERFRAMES_UNAVAILABLE',
      `HyperFrames 本地渲染环境不可用：${environment.errors.join('；')}`,
      { environment },
    );
  }
  await fs.mkdir(compositionDirectory, { recursive: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const htmlPath = path.join(compositionDirectory, 'index.html');
  const inputPath = path.join(compositionDirectory, 'render-input.json');
  const input = {
    schemaVersion: 1,
    renderer: 'hyperframes',
    rendererVersion: environment.version,
    title: String(options.title || '').trim(),
    subtitle: String(options.subtitle || '').trim(),
    format,
  };
  await fs.writeFile(htmlPath, buildTitleCardHtml({ ...options, ...format }), 'utf8');
  await fs.writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, 'utf8');

  const checkCommand = await runHyperframesCommand(
    environment.executable,
    ['check', compositionDirectory, '--json'],
    {
      browserPath: environment.browserPath || options.browserPath,
      cwd: compositionDirectory,
      timeoutMs: 5 * 60 * 1000,
    },
  );
  const check = parseCheckOutput(checkCommand.stdout);
  if (!check.ok) {
    const findings = [
      ...(check.lint?.findings || []),
      ...(check.runtime?.findings || []),
      ...(check.layout?.findings || []),
      ...(check.contrast?.findings || []),
    ].filter((finding) => finding.severity === 'error');
    throw createHyperframesError(
      'HYPERFRAMES_CHECK_FAILED',
      `HyperFrames check 未通过：${findings[0]?.message || '未知错误'}`,
      { check },
    );
  }

  const tempPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.tmp.mp4`,
  );
  try {
    const renderCommand = await runHyperframesCommand(
      environment.executable,
      [
        'render',
        compositionDirectory,
        '--output', tempPath,
        '--fps', hyperframesFpsArgument(format.fps),
        '--quality', format.quality,
        '--workers', '1',
        '--quiet',
      ],
      {
        browserPath: environment.browserPath || options.browserPath,
        cwd: compositionDirectory,
        timeoutMs: 30 * 60 * 1000,
      },
    );
    const metadata = await probeMedia(tempPath);
    const errors = [];
    if (!metadata.hasVideo) errors.push('生成文件没有视频流。');
    if (metadata.displayWidth !== format.width || metadata.displayHeight !== format.height) {
      errors.push(`分辨率不是 ${format.width}×${format.height}。`);
    }
    if (!Number.isFinite(metadata.frameRate) || Math.abs(metadata.frameRate - format.fps) > 0.05) {
      errors.push(`帧率不是 ${format.fps} fps。`);
    }
    if (!Number.isFinite(metadata.durationSec)
      || Math.abs(metadata.durationSec - format.durationSec) > 0.2) {
      errors.push(`时长不是 ${format.durationSec}s。`);
    }
    if (errors.length) {
      throw createHyperframesError(
        'INVALID_HYPERFRAMES_OUTPUT',
        `HyperFrames 独立 MP4 验证失败：${errors[0]}`,
        { errors, metadata },
      );
    }
    const sha256 = await hashFile(tempPath);
    await fs.rename(tempPath, outputPath);
    return {
      outputPath,
      compositionDirectory,
      htmlPath,
      inputPath,
      sha256,
      metadata,
      format,
      environment,
      check,
      commands: {
        check: checkCommand.command,
        render: renderCommand.command,
      },
    };
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function addHyperframesTitleCard(analysis, mapping, durationSec) {
  const duration = positiveNumber(durationSec, mapping.metadata?.durationSec || 2, 'HyperFrames duration');
  const generatedAsset = {
    assetId: mapping.assetId,
    type: 'video',
    semanticLabels: ['HyperFrames', '独立片头', '建议标题'],
    contentSummary: `HyperFrames 根据现有分析生成标题卡：${analysis.titles.recommended}`,
    suggestedUse: ['独立片头素材'],
    status: 'adopt',
    reason: '作为可单独调整或删除的生成镜头进入 FCPXML。',
    ranges: [{
      startSec: 0,
      endSec: duration,
      confidence: 1,
      reviewRequired: false,
    }],
    confidence: 1,
  };
  const generatedShot = {
    id: GENERATED_SHOT_ID,
    assetId: mapping.assetId,
    inSec: 0,
    outSec: duration,
    durationSec: duration,
    fitMode: 'contain',
    audioMode: 'mute',
    purpose: '用分析建议标题建立主题，并保留为独立可编辑 MP4',
    confidence: 1,
    reviewRequired: false,
  };
  return {
    ...analysis,
    assets: [...analysis.assets, generatedAsset],
    timeline: {
      ...analysis.timeline,
      shots: [generatedShot, ...analysis.timeline.shots],
      markers: analysis.timeline.markers.map((marker) => ({
        ...marker,
        timeSec: Number((marker.timeSec + duration).toFixed(3)),
      })),
    },
  };
}

module.exports = {
  GENERATED_ASSET_ID,
  GENERATED_SHOT_ID,
  REQUIRED_DOCTOR_CHECKS,
  addHyperframesTitleCard,
  buildTitleCardHtml,
  escapeHtml,
  hyperframesFpsArgument,
  inspectHyperframesEnvironment,
  normalizeRenderOptions,
  renderHyperframesTitleCard,
  requiredDoctorReport,
  resolveBrowserPath,
  resolveHyperframesExecutable,
  runHyperframesCommand,
};
