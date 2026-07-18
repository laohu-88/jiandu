#!/usr/bin/env node

const path = require('node:path');

const {
  buildCodexVideoProject,
  validateAnalysisFile,
  verifyCodexVideoProject,
} = require('../src/services/codex-video-service');
const {
  inspectVideoRange,
  preparePendingMedia,
} = require('../src/services/pending-media-service');
const { inspectHyperframesEnvironment } = require('../src/services/hyperframes-service');

const BOOLEAN_OPTIONS = new Set(['json', 'open-fcpxml', 'hyperframes', 'help']);

function parseArguments(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { command: 'help', options: { help: true } };
  }
  const [command, ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new Error(`无法识别的参数：${token}`);
    const key = token.slice(2);
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    const value = tokens[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`参数 --${key} 缺少值。`);
    options[key] = value;
    index += 1;
  }
  return { command: command || 'help', options };
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`缺少必填参数 --${key}。`), { code: 'MISSING_ARGUMENT' });
  }
  return value;
}

function formatOptions(options) {
  return {
    timeline: {
      orientation: options.orientation,
      width: options.width,
      height: options.height,
      fps: options.fps,
    },
    preview: {
      width: options['preview-width'],
      height: options['preview-height'],
      fps: options['preview-fps'],
    },
  };
}

function hyperframesOptions(options) {
  return {
    enabled: options.hyperframes === true,
    executablePath: options['hyperframes-executable'],
    browserPath: options['hyperframes-browser'],
    durationSec: options['hyperframes-duration'],
    quality: options['hyperframes-quality'],
  };
}

function helpText() {
  return `视频剪辑编排器 v3 Codex CLI

用法：
  video-skill --help
  video-skill prepare --source <一期素材目录> [--cache-root <目录>] [--json]
  video-skill inspect-range --manifest <manifest.json> --asset-id <ID> --start <秒> --end <秒> [--interval <秒>] [--json]
  video-skill validate-analysis --manifest <manifest.json> --analysis <analysis.json> [--orientation horizontal|vertical] [--width <像素>] [--height <像素>] [--fps <帧率>] [--json]
  video-skill hyperframes-doctor [--hyperframes-executable <路径>] [--hyperframes-browser <路径>] [--json]
  video-skill build --manifest <manifest.json> --analysis <analysis.json> --project-root <目录> --project-name <名称> [--orientation horizontal|vertical] [--width <像素>] [--height <像素>] [--fps <帧率>] [--preview-width <像素>] [--preview-height <像素>] [--preview-fps <帧率>] [--hyperframes] [--hyperframes-duration <秒>] [--hyperframes-quality draft|standard|high] [--hyperframes-executable <路径>] [--hyperframes-browser <路径>] [--open-fcpxml] [--json]
  video-skill verify --project <v3 正式项目目录> [--json]

CLI 不调用外部模型。prepare 只准备可供 Codex 查看和推理的媒体；build 只接受通过协议校验的分析结果。正式时间线默认使用生产规格，粗剪预览默认保持 640×360。
`;
}

function humanOutput(command, result) {
  if (command === 'prepare') {
    const lines = [
      `素材准备完成：${result.items.length} 个媒体文件`,
      `素材清单：${result.manifestPath}`,
      `分析请求：${result.analysisRequestPath}`,
      `缓存：${result.cacheDirectory}${result.cached ? '（命中）' : ''}`,
      `原始素材未变化：${result.sourceVerification.unchanged ? '是' : '否'}`,
    ];
    if (result.warnings.length) lines.push(`降级或警告：${result.warnings.join('；')}`);
    return `${lines.join('\n')}\n`;
  }
  if (command === 'inspect-range') {
    return `加密抽帧完成：${result.frames.length} 帧\n故事板：${result.storyboard || '未生成'}\n`;
  }
  if (command === 'validate-analysis') {
    return `协议校验通过：${result.assetCount} 个素材，${result.shotCount} 个镜头。\n`;
  }
  if (command === 'build') {
    const lines = [
      `v3 正式项目已创建并验证：${result.projectPath}`,
      `主题：${result.theme.summary}`,
      `建议标题：${result.titles.recommended}`,
      `FCPXML：${result.artifacts.fcpxmlPath}`,
      `粗剪预览：${result.artifacts.previewPath}`,
      `正式时间线：${result.formats.timeline.width}×${result.formats.timeline.height} ${result.formats.timeline.fps}fps`,
      `粗剪预览规格：${result.formats.preview.width}×${result.formats.preview.height} ${result.formats.preview.fps}fps`,
      `摘要：${result.artifacts.summaryPath}`,
      '原始素材未变化：是',
    ];
    if (result.hyperframes?.enabled) {
      lines.push(
        `HyperFrames：${result.hyperframes.version}（check 通过）`,
        `HyperFrames 独立 MP4：${result.artifacts.hyperframesMp4Path}`,
      );
    }
    lines.push('');
    return lines.join('\n');
  }
  if (command === 'hyperframes-doctor') {
    const required = result.requiredChecks
      .map((check) => `${check.ok ? '可用' : '不可用'} ${check.name}：${check.detail}`)
      .join('\n');
    return `HyperFrames 本地渲染：${result.available ? '可用' : '不可用'}`
      + `\nCLI：${result.executable || '未找到'}\n版本：${result.version || '未知'}`
      + `\n${required}\n`;
  }
  if (command === 'verify') {
    return `项目完整性验证通过：${result.projectPath}\nFCPXML 独立镜头：${result.fcpxml.clipCount}\n`;
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}

function exitCodeFor(error) {
  if (/^(INVALID_|MISSING_|NO_SUPPORTED_MEDIA|FOCUS_)/.test(error.code || '')) return 2;
  if (error.code === 'PROJECT_VERIFICATION_FAILED') return 4;
  return 3;
}

async function execute(argv) {
  const { command, options } = parseArguments(argv);
  if (command === 'help' || options.help) return { command: 'help', options, result: helpText() };

  if (command === 'prepare') {
    const result = await preparePendingMedia(required(options, 'source'), {
      cacheRoot: options['cache-root'],
    });
    return { command, options, result };
  }
  if (command === 'inspect-range') {
    const result = await inspectVideoRange(
      required(options, 'manifest'),
      required(options, 'asset-id'),
      required(options, 'start'),
      required(options, 'end'),
      options.interval || 1,
    );
    return { command, options, result };
  }
  if (command === 'validate-analysis') {
    const validated = await validateAnalysisFile(
      required(options, 'manifest'),
      required(options, 'analysis'),
      formatOptions(options),
    );
    return {
      command,
      options,
      result: {
        ok: true,
        manifestPath: validated.manifestPath,
        analysisPath: validated.analysisPath,
        assetCount: validated.analysis.assets.length,
        shotCount: validated.analysis.timeline.shots.length,
        formats: validated.formats,
      },
    };
  }
  if (command === 'hyperframes-doctor') {
    const result = await inspectHyperframesEnvironment({
      executablePath: options['hyperframes-executable'],
      browserPath: options['hyperframes-browser'],
    });
    return { command, options, result };
  }
  if (command === 'build') {
    const result = await buildCodexVideoProject({
      manifestPath: required(options, 'manifest'),
      analysisPath: required(options, 'analysis'),
      projectRoot: required(options, 'project-root'),
      projectName: required(options, 'project-name'),
      openFcpxml: options['open-fcpxml'] === true,
      timelineFormat: formatOptions(options).timeline,
      previewFormat: formatOptions(options).preview,
      hyperframes: hyperframesOptions(options),
    });
    return { command, options, result };
  }
  if (command === 'verify') {
    const result = await verifyCodexVideoProject(required(options, 'project'));
    return { command, options, result };
  }
  throw Object.assign(new Error(`未知命令：${command}`), { code: 'INVALID_COMMAND' });
}

async function main() {
  let parsed;
  try {
    parsed = await execute(process.argv.slice(2));
    if (parsed.command === 'help') {
      process.stdout.write(parsed.result);
    } else if (parsed.options.json) {
      process.stdout.write(`${JSON.stringify(parsed.result, null, 2)}\n`);
    } else {
      process.stdout.write(humanOutput(parsed.command, parsed.result));
    }
  } catch (error) {
    const payload = {
      ok: false,
      error: {
        code: error.code || 'VIDEO_SKILL_FAILED',
        message: error.message,
        details: error.details || error.report?.errors || [],
      },
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = exitCodeFor(error);
  }
}

if (require.main === module) main();

module.exports = {
  execute,
  exitCodeFor,
  formatOptions,
  hyperframesOptions,
  humanOutput,
  parseArguments,
};
