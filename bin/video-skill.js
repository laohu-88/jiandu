#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  DEFAULT_PENDING_ROOT,
  internalProjectRoot,
} = require('../src/constants');

const {
  buildCodexVideoProject,
  validateAnalysisFile,
  verifyCodexVideoProject,
  safeFilename,
} = require('../src/services/codex-video-service');
const {
  inspectVideoRange,
  preparePendingMedia,
} = require('../src/services/pending-media-service');
const { inspectHyperframesEnvironment } = require('../src/services/hyperframes-service');
const { readCodexProjectResult } = require('../src/services/codex-project-result-service');
const {
  readHandoffTask,
  updateHandoffTask,
} = require('../src/services/handoff-task-service');
const { openReturnUrl } = require('../src/protocol-service');
const {
  approveDouyinVariant,
  buildDouyinVariant,
  createDouyinVariant,
  saveDouyinVariantDraft,
  verifyDouyinVariant,
} = require('../src/services/platform-variant-service');

const BOOLEAN_OPTIONS = new Set(['json', 'open-fcpxml', 'hyperframes', 'help']);
const NON_FATAL_HANDOFF_COMMAND_ERRORS = new Set([
  'HANDOFF_TERMINAL_STATE',
  'INVALID_HANDOFF_TRANSITION',
  'LATE_ATTEMPT_WRITE',
]);

function shouldMarkHandoffFailed(error, context = {}) {
  if (NON_FATAL_HANDOFF_COMMAND_ERRORS.has(error?.code)) return false;
  if (context.command === 'validate-analysis' && error?.code === 'INVALID_VIDEO_ANALYSIS') {
    return false;
  }
  return true;
}

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

function assertPendingSource(sourcePath) {
  const root = path.resolve(DEFAULT_PENDING_ROOT);
  const source = path.resolve(String(sourcePath || '').trim());
  const relative = path.relative(root, source);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`素材输入必须位于唯一入口：${root}`), {
      code: 'INVALID_SOURCE_DIRECTORY',
    });
  }
  return source;
}

function optionalJson(value, label) {
  if (value == null) return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw Object.assign(new Error(`${label} 必须是有效 JSON：${error.message}`), {
      code: 'INVALID_ARGUMENT',
    });
  }
}

function handoffReporter(options) {
  const taskPath = options['handoff-task'];
  if (!taskPath) return async () => {};
  let attemptId = options['attempt-id'] || null;
  return async (status, stageMessage, patch = {}) => {
    const task = await readHandoffTask(taskPath);
    if (!attemptId) attemptId = task.currentAttempt?.attemptId || null;
    if (['completed', 'completed_with_warnings', 'failed', 'cancelled'].includes(task.status)
      && task.status !== status) return task;
    if (task.currentAttempt?.attemptId && attemptId && task.currentAttempt.attemptId !== attemptId) {
      return task;
    }
    try {
      return await updateHandoffTask(taskPath, {
        status,
        stageMessage,
        attemptId,
        ...patch,
      });
    } catch (error) {
      if (NON_FATAL_HANDOFF_COMMAND_ERRORS.has(error.code)) return task;
      throw error;
    }
  };
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
  const result = {
    enabled: options.hyperframes === true,
    executablePath: options['hyperframes-executable'],
    browserPath: options['hyperframes-browser'],
    durationSec: options['hyperframes-duration'],
    quality: options['hyperframes-quality'],
    flowSpecPath: options['hyperframes-flow'],
  };
  if (options['reuse-hyperframes-project']) {
    result.reuseProjectPath = options['reuse-hyperframes-project'];
  }
  return result;
}

function helpText() {
  return `视频剪辑编排器 v3 Codex CLI

用法：
  video-skill --help
  video-skill prepare --source <一期素材目录> [--cache-root <目录>] [--json]
  video-skill inspect-range --manifest <manifest.json> --asset-id <ID> --start <秒> --end <秒> [--interval <秒>] [--json]
  video-skill validate-analysis --manifest <manifest.json> --analysis <analysis.json> [--orientation horizontal|vertical] [--width <像素>] [--height <像素>] [--fps <帧率>] [--json]
  video-skill hyperframes-doctor [--hyperframes-executable <路径>] [--hyperframes-browser <路径>] [--json]
  video-skill build --manifest <manifest.json> --analysis <analysis.json> --project-root <目录> --project-name <名称> [--orientation horizontal|vertical] [--width <像素>] [--height <像素>] [--fps <帧率>] [--preview-width <像素>] [--preview-height <像素>] [--preview-fps <帧率>] [--hyperframes] [--hyperframes-flow <流程 JSON>] [--reuse-hyperframes-project <已验收项目>] [--hyperframes-duration <秒>] [--hyperframes-quality draft|standard|high] [--hyperframes-executable <路径>] [--hyperframes-browser <路径>] [--open-fcpxml] [--json]
  video-skill verify --project <v3 正式项目目录> [--json]
  video-skill douyin-create --project <v3 正式项目目录> [--variant-id <ID>] [--plan <edit-plan.json>] [--json]
  video-skill douyin-update --project <v3 正式项目目录> --plan <edit-plan.json> [--variant-id <ID>] [--expected-revision <数字>] [--json]
  video-skill douyin-approve --project <v3 正式项目目录> [--variant-id <ID>] [--approved-warnings <JSON 数组>] [--json]
  video-skill douyin-build --project <v3 正式项目目录> [--variant-id <ID>] [--json]
  video-skill douyin-verify --project <v3 正式项目目录> [--variant-id <ID>] [--json]
  video-skill handoff-update --handoff-task <task.json> [--attempt-id <attemptId>] --stage <状态> [--message <说明>] [--hyperframes-decision <enabled|disabled|attempted-rejected>] [--hyperframes-reason <理由>] [--hyperframes-gap <表达缺口>] [--hyperframes-quality-review <复核结果>] [--json]
  video-skill handoff-complete --handoff-task <task.json> [--attempt-id <attemptId>] --project <v3 正式项目目录> [--json]
  video-skill handoff-return --handoff-task <task.json> [--json]

CLI 不调用外部模型。prepare 只准备可供 Codex 查看和推理的媒体；build 只接受通过协议校验的分析结果。用户项目根目录只写 FCPXML，默认不生成 MP4；机器文件和可选预览写入剪渡 Application Support。由 v3 发起时，把 --handoff-task 传给 prepare、validate-analysis、build 和 verify。
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
      `粗剪预览：${result.artifacts.previewPath || '未生成（默认交付 FCPXML）'}`,
      `正式时间线：${result.formats.timeline.width}×${result.formats.timeline.height} ${result.formats.timeline.fps}fps`,
      ...(result.artifacts.previewPath ? [`粗剪预览规格：${result.formats.preview.width}×${result.formats.preview.height} ${result.formats.preview.fps}fps`] : []),
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
  if (command === 'douyin-create' || command === 'douyin-update') {
    return `抖音规划已保存：${result.variantId}｜revision ${result.revision}｜${result.plan.videos.length} 条成片\n`;
  }
  if (command === 'douyin-approve') {
    return `抖音规划已批准：${result.variantId}｜revision ${result.revision}\n`;
  }
  if (command === 'douyin-build') {
    return `抖音独立产物已生成：${result.variantId}｜${result.outputs.length} 条成片｜${result.status}\n`;
  }
  if (command === 'douyin-verify') {
    return `抖音独立产物验证${result.ok ? '通过' : '失败'}：${result.variantId}｜${result.reports.length} 条成片\n`;
  }
  if (command === 'handoff-update') {
    return `交接任务已更新：${result.taskId}｜${result.stageMessage}\n`;
  }
  if (command === 'handoff-return') {
    return `已请求返回视频剪辑编排器 v3：${result.taskId}\n`;
  }
  if (command === 'handoff-complete') {
    return `交接任务已完成并写回验收结果：${result.resultProjectPath}\n`;
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
    const report = handoffReporter(options);
    const result = await preparePendingMedia(assertPendingSource(required(options, 'source')), {
      cacheRoot: options['cache-root'],
      onStage: report,
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
    const report = handoffReporter(options);
    const taskPath = options['handoff-task'];
    const beforeValidation = taskPath ? await readHandoffTask(taskPath) : null;
    await report(
      beforeValidation?.status === 'analysis_needs_correction' ? 'analysis_needs_correction' : 'planning_story',
      beforeValidation?.status === 'analysis_needs_correction'
        ? 'Agent 正在重新校验修正后的分析合同。'
        : '正在校验镜头编排、素材区间和轻字幕 Marker。',
    );
    let validated;
    try {
      validated = await validateAnalysisFile(
        required(options, 'manifest'),
        required(options, 'analysis'),
        formatOptions(options),
      );
    } catch (error) {
      if (taskPath && error?.code === 'INVALID_VIDEO_ANALYSIS') {
        await report('analysis_needs_correction', '分析合同校验未通过，正在等待 Agent 修正后再次校验。', {
          validationIssues: [{
            code: error.code,
            message: error.message,
            at: new Date().toISOString(),
          }],
        });
      }
      throw error;
    }
    let nextStage = 'deciding_hyperframes';
    let nextMessage = '真实素材初步时间线已通过协议校验，正在判断 HyperFrames。';
    if (taskPath) {
      const task = await readHandoffTask(taskPath);
      if (task.engine === 'cursor_agent') {
        nextStage = 'analysis_complete';
        nextMessage = 'Cursor Agent 分析已通过协议校验，等待 App 继续构建与验证。';
        await report(nextStage, nextMessage, {
          artifacts: {
            ...(task.artifacts || {}),
            manifestPath: validated.manifestPath,
            analysisPath: validated.analysisPath,
          },
          hyperframesDecision: task.hyperframesDecision || 'disabled',
          hyperframesReason: task.hyperframesReason
            || 'Stage 6B 默认由 App 继续构建；HyperFrames 保持关闭，除非后续显式启用。',
          hyperframesGap: task.hyperframesGap || '无',
          validationIssues: [],
        });
        return {
          command,
          options,
          result: {
            ok: true,
            engine: 'cursor_agent',
            status: 'analysis_complete',
            manifestPath: validated.manifestPath,
            analysisPath: validated.analysisPath,
            assetCount: validated.analysis.assets.length,
            shotCount: validated.analysis.timeline.shots.length,
            formats: validated.formats,
          },
        };
      }
    }
    await report(nextStage, nextMessage, { validationIssues: [] });
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
    const report = handoffReporter(options);
    const result = await buildCodexVideoProject({
      manifestPath: required(options, 'manifest'),
      analysisPath: required(options, 'analysis'),
      projectRoot: required(options, 'project-root'),
      projectName: required(options, 'project-name'),
      internalRoot: internalProjectRoot(path.join(
        required(options, 'project-root'),
        safeFilename(required(options, 'project-name')),
      )),
      generatePreview: false,
      openFcpxml: options['open-fcpxml'] === true,
      timelineFormat: formatOptions(options).timeline,
      previewFormat: formatOptions(options).preview,
      hyperframes: hyperframesOptions(options),
      onStage: report,
    });
    const warnings = result.verification?.warnings || [];
    const titleCount = result.verification?.fcpxml?.titleCount || 0;
    const markerCount = result.verification?.fcpxml?.markerCount || 0;
    const durationSec = result.verification?.previewMetadata?.durationSec || null;
    await report('verifying', '正式项目已生成并通过机器验证，等待 Codex 观看复核后完成交接。', {
        resultProjectPath: result.projectPath,
        resultProjectId: result.project?.projectId || result.project?.projectName || null,
        artifacts: {
          previewPath: result.artifacts.previewPath,
          fcpxmlPath: result.artifacts.fcpxmlPath,
          summaryPath: result.artifacts.summaryPath,
          hyperframesMp4Path: result.artifacts.hyperframesMp4Path,
        },
        verification: {
          ...result.verification,
          shotCount: result.assetMappings ? result.verification.fcpxml?.clipCount : null,
          durationSec,
          markerCount,
          titleCount,
          hyperframesCount: result.hyperframes?.enabled ? 1 : 0,
          timelineFormat: result.formats.timeline,
          previewFormat: result.formats.preview,
        },
        warnings,
      });
    return { command, options, result };
  }
  if (command === 'verify') {
    const report = handoffReporter(options);
    await report('verifying', '正在重新执行正式项目只读完整验证。');
    const result = await verifyCodexVideoProject(required(options, 'project'));
    return { command, options, result };
  }
  if (command === 'douyin-create') {
    const planPath = options.plan ? path.resolve(options.plan) : null;
    const plan = planPath ? JSON.parse(await fs.readFile(planPath, 'utf8')) : null;
    const result = await createDouyinVariant(required(options, 'project'), {
      variantId: options['variant-id'] || 'douyin',
      plan,
    });
    return { command, options, result };
  }
  if (command === 'douyin-update') {
    const planPath = path.resolve(required(options, 'plan'));
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
    const expectedRevision = options['expected-revision'] == null
      ? undefined
      : Number(options['expected-revision']);
    if (expectedRevision != null && !Number.isInteger(expectedRevision)) {
      throw Object.assign(new Error('--expected-revision 必须是整数。'), {
        code: 'INVALID_ARGUMENT',
      });
    }
    const result = await saveDouyinVariantDraft(
      required(options, 'project'),
      options['variant-id'] || 'douyin',
      plan,
      { expectedRevision },
    );
    return { command, options, result };
  }
  if (command === 'douyin-approve') {
    const result = await approveDouyinVariant(
      required(options, 'project'),
      options['variant-id'] || 'douyin',
      {
        approvedWarningIds: optionalJson(
          options['approved-warnings'] || '[]',
          '--approved-warnings',
        ),
        approvedBy: 'video-skill-cli',
      },
    );
    return { command, options, result };
  }
  if (command === 'douyin-build') {
    const result = await buildDouyinVariant(
      required(options, 'project'),
      options['variant-id'] || 'douyin',
      { generatePreview: false },
    );
    return { command, options, result };
  }
  if (command === 'douyin-verify') {
    const result = await verifyDouyinVariant(
      required(options, 'project'),
      options['variant-id'] || 'douyin',
    );
    return { command, options, result };
  }
  if (command === 'handoff-update') {
    const taskPath = required(options, 'handoff-task');
    const stage = required(options, 'stage');
    const attemptId = options['attempt-id'] || null;
    const result = await updateHandoffTask(taskPath, {
      status: stage,
      attemptId,
      stageMessage: options.message,
      hyperframesDecision: options['hyperframes-decision'],
      hyperframesReason: options['hyperframes-reason'],
      hyperframesGap: options['hyperframes-gap'],
      hyperframesQualityReview: options['hyperframes-quality-review'],
      warnings: optionalJson(options.warnings, '--warnings'),
      errors: optionalJson(options.errors, '--errors'),
    });
    return { command, options, result };
  }
  if (command === 'handoff-complete') {
    const taskPath = required(options, 'handoff-task');
    const projectPath = required(options, 'project');
    const task = await readHandoffTask(taskPath);
    const attemptId = options['attempt-id']
      || (task.currentAttempt?.generation > 1 ? null : task.currentAttempt?.attemptId);
    if (!task.hyperframesDecision || !task.hyperframesReason) {
      throw Object.assign(new Error('完成交接前必须记录 HyperFrames 决策与理由。'), {
        code: 'MISSING_HYPERFRAMES_DECISION',
      });
    }
    if (task.hyperframesDecision === 'enabled' && !task.hyperframesQualityReview) {
      throw Object.assign(new Error('启用 HyperFrames 时必须先实际观看并记录质量复核。'), {
        code: 'MISSING_HYPERFRAMES_REVIEW',
      });
    }
    const verification = await verifyCodexVideoProject(projectPath);
    const result = await readCodexProjectResult(projectPath);
    const warnings = [...new Set([
      ...(task.warnings || []),
      ...(verification.warnings || []),
      ...(result.verification.warnings || []),
    ])];
    const status = warnings.length ? 'completed_with_warnings' : 'completed';
    const completed = await updateHandoffTask(taskPath, {
      status,
      attemptId,
      stageMessage: warnings.length
        ? '正式项目已完成并通过验证，但存在需要确认的警告。'
        : '正式项目、粗剪、FCPXML、观看复核与完整验证均已完成。',
      resultProjectPath: result.project.path,
      resultProjectId: result.project.name,
      artifacts: {
        previewPath: result.artifacts.preview?.path || null,
        fcpxmlPath: result.artifacts.fcpxml?.path || null,
        summaryPath: task.artifacts?.summaryPath || null,
        hyperframesMp4Path: result.artifacts.hyperframesMp4?.path || null,
      },
      verification: {
        ...verification,
        shotCount: result.timeline.shotCount,
        durationSec: result.timeline.totalDurationSec,
        markerCount: result.timeline.markers.length,
        titleCount: result.formats.fcpxmlTitleCount,
        hyperframesCount: result.hyperframes.count || 0,
        timelineFormat: result.formats.timeline,
        previewFormat: result.formats.preview,
      },
      warnings,
    });
    return { command, options, result: completed };
  }
  if (command === 'handoff-return') {
    const taskPath = required(options, 'handoff-task');
    const task = await readHandoffTask(taskPath);
    if (!['completed', 'completed_with_warnings', 'failed', 'analysis_complete', 'analysis_needs_correction'].includes(task.status)) {
      throw Object.assign(new Error('只有完成、警告、失败或分析完成任务可以触发回流。'), {
        code: 'HANDOFF_NOT_TERMINAL',
      });
    }
    const result = await updateHandoffTask(taskPath, {
      status: task.status,
      attemptId: task.currentAttempt?.attemptId,
      returnState: {
        ...(task.returnState || {}),
        requestedAt: new Date().toISOString(),
      },
      stageMessage: task.stageMessage,
    });
    await openReturnUrl(result.taskId);
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
    try {
      const parsedArgs = parseArguments(process.argv.slice(2));
      const taskPath = parsedArgs.options?.['handoff-task'];
      if (taskPath) {
        const task = await readHandoffTask(taskPath);
        if (shouldMarkHandoffFailed(error, { command: parsedArgs.command })
          && !['completed', 'completed_with_warnings', 'failed', 'cancelled'].includes(task.status)) {
          await updateHandoffTask(taskPath, {
            status: 'failed',
            attemptId: task.currentAttempt?.attemptId,
            stageMessage: `处理失败：${error.message}`,
            errors: [{
              code: error.code || 'VIDEO_SKILL_FAILED',
              message: error.message,
              stage: task.stage,
              at: new Date().toISOString(),
            }],
          });
        }
      }
    } catch {
      // The original CLI error remains the primary failure.
    }
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
  shouldMarkHandoffFailed,
};
