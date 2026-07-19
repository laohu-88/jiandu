const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const {
  ASSETS_DIR,
  ASSETS_FILE,
  CODEX_VIDEO_ANALYSIS_FILE,
  CODEX_VIDEO_FCPXML_DIR,
  CODEX_VIDEO_HYPERFRAMES_DIR,
  CODEX_VIDEO_MANIFEST_FILE,
  CODEX_VIDEO_PREVIEW_DIR,
  CODEX_VIDEO_STATUS_FILE,
  CODEX_VIDEO_SUMMARY_FILE,
  PROJECT_FILE,
} = require('../constants');
const { createProject } = require('./project-service');
const { loadAssetIndex, scanAssets, updateAssetReview } = require('./media-service');
const { probeMedia, runMediaTool } = require('./media-tool-service');
const {
  compareSourceSnapshots,
  hashFile,
  snapshotSource,
} = require('./pending-media-service');
const { timelineDuration, validateVideoAnalysis } = require('./video-analysis-schema');
const { resolvePreviewFormat, resolveVideoFormats } = require('./video-format-service');
const { collectFcpTitles, validateFcpxmlStructure, writeFcpxml } = require('./fcpxml-service');
const {
  GENERATED_ASSET_ID,
  addHyperframesAsset,
  inspectHyperframesEnvironment,
  normalizeFlowSpec,
  renderHyperframesAsset,
} = require('./hyperframes-service');

const execFileAsync = promisify(execFile);

function safeFilename(value, fallback = 'video-project') {
  const clean = String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|\0]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 100)
    .trim();
  return clean || fallback;
}

function hyperframesFlowFingerprint(flow, visualSources = {}, projectIdentity = null) {
  const visuals = Object.fromEntries(Object.keys(visualSources).sort().map((key) => [
    key,
    visualSources[key]?.sha256 || visualSources[key]?.assetId || null,
  ]));
  return crypto.createHash('sha256')
    .update(JSON.stringify({ flow, visuals, projectIdentity }))
    .digest('hex')
    .slice(0, 10);
}

function hyperframesOutputFilename(analysis, flow, visualSources, projectIdentity) {
  const rawBase = flow
    ? `HyperFrames-流程解释-${analysis.titles.recommended}`
    : `HyperFrames-片头-${analysis.titles.recommended}`;
  const fallback = flow ? 'HyperFrames-process-flow' : 'HyperFrames-title-card';
  const safeBase = safeFilename(rawBase, fallback);
  if (!flow) return `${safeBase}.mp4`;
  const suffix = `-${hyperframesFlowFingerprint(flow, visualSources, projectIdentity)}`;
  return `${safeBase.slice(0, 100 - suffix.length).trim()}${suffix}.mp4`;
}

async function readJson(filePath, label = path.basename(filePath)) {
  try {
    return JSON.parse(await fs.readFile(path.resolve(filePath), 'utf8'));
  } catch (error) {
    throw Object.assign(new Error(`无法读取 ${label}：${error.message}`), {
      code: 'INVALID_JSON_INPUT',
    });
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function validateAnalysisFile(manifestPath, analysisPath, formatOptions = {}) {
  const [manifest, rawAnalysis] = await Promise.all([
    readJson(manifestPath, '素材清单'),
    readJson(analysisPath, 'Codex 分析结果'),
  ]);
  const resolved = resolveVideoFormats(rawAnalysis, manifest, formatOptions);
  const analysis = resolved.analysis;
  validateVideoAnalysis(analysis, manifest);
  return {
    manifest,
    analysis,
    formats: { timeline: resolved.timeline, preview: resolved.preview },
    manifestPath: path.resolve(manifestPath),
    analysisPath: path.resolve(analysisPath),
  };
}

async function assertProjectTargetAvailable(projectRoot, projectName) {
  const root = path.resolve(String(projectRoot || '').trim());
  const name = safeFilename(projectName, '');
  if (!root || !name) {
    throw Object.assign(new Error('projectRoot 和 projectName 不能为空。'), {
      code: 'INVALID_PROJECT_TARGET',
    });
  }
  const target = path.join(root, name);
  const stat = await fs.stat(target).catch(() => null);
  if (stat) {
    const entries = stat.isDirectory() ? await fs.readdir(target) : ['not-a-directory'];
    if (entries.length > 0) {
      throw Object.assign(new Error(`正式项目目录已存在且非空：${target}`), {
        code: 'PROJECT_ALREADY_EXISTS',
      });
    }
  }
  return { root, name, target };
}

async function chooseDestinationName(assetsPath, item) {
  const preferred = safeFilename(item.filename, `${item.assetId}.${item.extension || 'bin'}`);
  const preferredPath = path.join(assetsPath, preferred);
  const stat = await fs.stat(preferredPath).catch(() => null);
  if (!stat) return preferred;
  if (stat.isFile() && await hashFile(preferredPath) === item.sha256) return preferred;
  return `${item.assetId}-${preferred}`;
}

async function syncTimelineAssets(projectPath, manifest, analysis) {
  const selectedIds = [...new Set(analysis.timeline.shots.map((shot) => shot.assetId))];
  const manifestById = new Map(manifest.items.map((item) => [item.assetId, item]));
  const analysisById = new Map(analysis.assets.map((item) => [item.assetId, item]));
  const assetsPath = path.join(projectPath, ASSETS_DIR);
  const mappings = [];
  for (const assetId of selectedIds) {
    const item = manifestById.get(assetId);
    if (!item) throw new Error(`素材清单中缺少 ${assetId}。`);
    const projectFilename = await chooseDestinationName(assetsPath, item);
    const projectAbsolutePath = path.join(assetsPath, projectFilename);
    const existing = await fs.stat(projectAbsolutePath).catch(() => null);
    if (!existing) await fs.copyFile(item.originalPath, projectAbsolutePath);
    const copiedHash = await hashFile(projectAbsolutePath);
    if (copiedHash !== item.sha256) {
      throw Object.assign(new Error(`素材同步校验失败：${item.filename}`), {
        code: 'ASSET_COPY_MISMATCH',
      });
    }
    mappings.push({
      assetId,
      type: item.type,
      sourceRelativePath: item.relativePath,
      sourceSha256: item.sha256,
      projectFilename,
      projectRelativePath: path.join(ASSETS_DIR, projectFilename),
      projectAbsolutePath,
      metadata: item.metadata,
      analysis: analysisById.get(assetId),
    });
  }

  const assetIndex = await scanAssets(projectPath);
  for (const mapping of mappings) {
    const registered = assetIndex.assets.find((item) => item.relativePath === mapping.projectRelativePath);
    if (!registered) throw new Error(`v3 素材索引未登记 ${mapping.projectFilename}。`);
    mapping.projectStableId = registered.stableId;
    await updateAssetReview(projectPath, registered.stableId, {
      reviewStatus: 'keep',
      rating: 5,
      tags: mapping.analysis.semanticLabels,
      note: `${mapping.analysis.contentSummary}\n采用理由：${mapping.analysis.reason}`,
    });
  }
  return mappings;
}

async function registerHyperframesAsset(projectPath, rendered, analysis, flow = null) {
  const projectRelativePath = path.relative(projectPath, rendered.outputPath);
  const assetIndex = await scanAssets(projectPath);
  const registered = assetIndex.assets.find((item) => item.relativePath === projectRelativePath);
  if (!registered) throw new Error('v3 素材索引未登记 HyperFrames 独立 MP4。');
  await updateAssetReview(projectPath, registered.stableId, {
    reviewStatus: 'keep',
    rating: 5,
    tags: flow
      ? ['HyperFrames', '流程解释', '独立生成素材']
      : ['HyperFrames', '独立片头', '生成素材'],
    note: flow
      ? `${flow.reason}\n流程：${flow.nodes.join(' → ')}`
      : `根据现有 Codex 分析生成：${analysis.titles.recommended}`,
  });
  return {
    assetId: GENERATED_ASSET_ID,
    type: 'video',
    origin: 'hyperframes',
    sourceRelativePath: null,
    sourceSha256: rendered.sha256,
    projectFilename: path.basename(rendered.outputPath),
    projectRelativePath,
    projectAbsolutePath: rendered.outputPath,
    metadata: rendered.metadata,
    analysis: null,
    projectStableId: registered.stableId,
    generator: {
      name: 'hyperframes',
      version: rendered.environment.version,
      compositionRelativePath: path.relative(projectPath, rendered.compositionDirectory),
      inputRelativePath: path.relative(projectPath, rendered.inputPath),
      outputRecordRelativePath: path.relative(projectPath, rendered.outputRecordPath),
      kind: flow?.kind || 'title-card',
      reason: flow?.reason || '根据既有分析生成可选独立标题素材。',
    },
  };
}

function assertContainedPath(rootPath, candidate, label) {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, String(candidate || ''));
  const relative = path.relative(root, resolved);
  if (!candidate || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`${label} 路径不在复用项目内。`), {
      code: 'INVALID_HYPERFRAMES_REUSE',
    });
  }
  return { resolved, relative };
}

async function copyReusableHyperframes(projectPath, sourceProjectPath) {
  const sourceRoot = path.resolve(String(sourceProjectPath || ''));
  const sourceStatus = await readJson(
    path.join(sourceRoot, CODEX_VIDEO_STATUS_FILE),
    '复用项目 Codex 视频状态',
  );
  if (sourceStatus.status !== 'verified'
    || sourceStatus.hyperframes?.enabled !== true
    || sourceStatus.hyperframes.check?.ok !== true) {
    throw Object.assign(new Error('复用项目不是已验证且 HyperFrames check 通过的正式项目。'), {
      code: 'INVALID_HYPERFRAMES_REUSE',
    });
  }
  const sourceMapping = (sourceStatus.assetMappings || []).find(
    (mapping) => mapping.origin === 'hyperframes',
  );
  if (!sourceMapping) {
    throw Object.assign(new Error('复用项目缺少 HyperFrames 独立素材映射。'), {
      code: 'INVALID_HYPERFRAMES_REUSE',
    });
  }
  const sourceMedia = assertContainedPath(
    sourceRoot,
    sourceMapping.projectRelativePath,
    'HyperFrames MP4',
  );
  const actualHash = await hashFile(sourceMedia.resolved).catch(() => null);
  if (!actualHash || actualHash !== sourceMapping.sourceSha256) {
    throw Object.assign(new Error('复用项目 HyperFrames MP4 缺失或哈希不一致。'), {
      code: 'INVALID_HYPERFRAMES_REUSE',
    });
  }
  const outputFilename = safeFilename(sourceMapping.projectFilename, 'HyperFrames-process-flow.mp4');
  const outputPath = path.join(projectPath, ASSETS_DIR, outputFilename);
  await fs.copyFile(sourceMedia.resolved, outputPath);
  if (await hashFile(outputPath) !== sourceMapping.sourceSha256) {
    throw Object.assign(new Error('复用 HyperFrames MP4 复制校验失败。'), {
      code: 'ASSET_COPY_MISMATCH',
    });
  }

  const composition = assertContainedPath(
    sourceRoot,
    sourceStatus.artifacts.hyperframesComposition,
    'HyperFrames composition',
  );
  const input = assertContainedPath(
    sourceRoot,
    sourceStatus.artifacts.hyperframesInput,
    'HyperFrames input',
  );
  const outputRecord = assertContainedPath(
    sourceRoot,
    sourceStatus.artifacts.hyperframesOutputRecord,
    'HyperFrames output record',
  );
  const compositionDirectory = path.join(projectPath, composition.relative);
  await fs.cp(composition.resolved, compositionDirectory, { recursive: true, errorOnExist: true });
  const inputPath = path.join(projectPath, input.relative);
  const outputRecordPath = path.join(projectPath, outputRecord.relative);
  for (const artifactPath of [inputPath, outputRecordPath]) {
    if (!(await fs.stat(artifactPath).catch(() => null))?.isFile()) {
      throw Object.assign(new Error('复用 HyperFrames composition 缺少构建记录。'), {
        code: 'INVALID_HYPERFRAMES_REUSE',
      });
    }
  }
  return {
    sourceProjectPath: sourceRoot,
    flow: sourceStatus.hyperframes.flow || null,
    rendered: {
      outputPath,
      compositionDirectory,
      inputPath,
      outputRecordPath,
      sha256: sourceMapping.sourceSha256,
      metadata: sourceMapping.metadata,
      format: sourceStatus.hyperframes.format || {
        width: sourceMapping.metadata?.displayWidth,
        height: sourceMapping.metadata?.displayHeight,
        fps: sourceMapping.metadata?.frameRate,
        durationSec: sourceMapping.metadata?.durationSec,
      },
      environment: {
        version: sourceStatus.hyperframes.version,
        requiredChecks: sourceStatus.hyperframes.requiredChecks || [],
        optionalWarnings: sourceStatus.hyperframes.optionalWarnings || [],
      },
      check: sourceStatus.hyperframes.check,
      commands: {
        reuse: `只读复用已验收项目：${sourceRoot}`,
      },
    },
  };
}

function resolveHyperframesVisualSources(flow, mappings) {
  if (!flow?.visuals) return null;
  const mappingById = new Map(mappings.map((mapping) => [mapping.assetId, mapping]));
  return Object.fromEntries(Object.entries(flow.visuals).map(([key, assetId]) => {
    const mapping = mappingById.get(assetId);
    if (!mapping || mapping.type !== 'image') {
      throw Object.assign(new Error(`HyperFrames 视觉素材未进入本期精选素材：${key}（${assetId}）`), {
        code: 'INVALID_HYPERFRAMES_FLOW',
      });
    }
    return [key, {
      assetId,
      sourcePath: mapping.projectAbsolutePath,
      sha256: mapping.sourceSha256,
    }];
  }));
}

function previewVideoFilter(shot, width, height, fps, inputIndex) {
  const scale = shot.fitMode === 'cover'
    ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
    : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;
  const duration = Number(shot.durationSec.toFixed(3));
  return `[${inputIndex}:v]${scale},setsar=1,fps=${fps},trim=duration=${duration},`
    + `setpts=PTS-STARTPTS[v${inputIndex}]`;
}

async function generateRoughcutPreview(outputPath, analysis, assetMappings, previewFormat = {}) {
  const format = resolvePreviewFormat(previewFormat);
  const mappingById = new Map(assetMappings.map((mapping) => [mapping.assetId, mapping]));
  const args = ['-y'];
  const filters = [];
  const concatInputs = [];
  for (const [index, shot] of analysis.timeline.shots.entries()) {
    const mapping = mappingById.get(shot.assetId);
    if (!mapping) throw new Error(`粗剪预览缺少素材映射：${shot.assetId}`);
    const duration = Number(shot.durationSec.toFixed(3));
    if (mapping.type === 'image') {
      args.push('-loop', '1', '-t', String(duration), '-i', mapping.projectAbsolutePath);
    } else {
      args.push(
        '-ss', String(shot.inSec),
        '-t', String(duration),
        '-i', mapping.projectAbsolutePath,
      );
    }
    filters.push(previewVideoFilter(
      shot,
      format.width,
      format.height,
      format.fps,
      index,
    ));
    if (mapping.type === 'video' && mapping.metadata?.hasAudio && shot.audioMode === 'keep') {
      filters.push(
        `[${index}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,`
        + `aformat=sample_rates=48000:channel_layouts=stereo[a${index}]`,
      );
    } else {
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${duration},`
        + `asetpts=PTS-STARTPTS[a${index}]`,
      );
    }
    concatInputs.push(`[v${index}][a${index}]`);
  }
  filters.push(
    `${concatInputs.join('')}concat=n=${analysis.timeline.shots.length}:v=1:a=1[vout][aout]`,
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.tmp.mp4`,
  );
  try {
    const result = await runMediaTool('ffmpeg', [
      ...args,
      '-filter_complex', filters.join(';'),
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '160k',
      '-ar', '48000',
      '-ac', '2',
      '-movflags', '+faststart',
      tempPath,
    ], { timeoutMs: 30 * 60 * 1000 });
    const metadata = await probeMedia(tempPath);
    if (!metadata.hasVideo || !Number.isFinite(metadata.durationSec) || metadata.durationSec <= 0) {
      throw new Error('ffmpeg 生成的粗剪预览不可读取。');
    }
    await fs.rename(tempPath, outputPath);
    return { outputPath, metadata, format, command: result.command };
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function buildHumanSummary({
  projectPath,
  analysis,
  timelineAnalysis = analysis,
  manifest,
  mappings,
  fcpxmlPath,
  previewPath,
  formats,
  sourceVerification,
  hyperframes = null,
}) {
  const analysisById = new Map(analysis.assets.map((item) => [item.assetId, item]));
  const manifestById = new Map(manifest.items.map((item) => [item.assetId, item]));
  const mappingById = new Map(mappings.map((item) => [item.assetId, item]));
  const lines = [
    '# Codex 视频项目摘要',
    '',
    `- 正式项目：${projectPath}`,
    `- 主题：${analysis.theme.summary}`,
    `- 主题可信度：${analysis.theme.confidence}`,
    `- 主题依据：${analysis.theme.rationale}`,
    `- 建议标题：${analysis.titles.recommended}`,
    `- 标题理由：${analysis.titles.rationale}`,
    `- FCPXML：${fcpxmlPath}`,
    `- 正式时间线：${formats.timeline.width}×${formats.timeline.height}｜${formats.timeline.fps} fps｜${formats.timeline.orientation}`,
    `- 粗剪预览：${previewPath}`,
    `- 预览规格：${formats.preview.width}×${formats.preview.height}｜${formats.preview.fps} fps`,
    `- 原始素材未变化：${sourceVerification.unchanged ? '是' : '否'}`,
    '',
    '## 标题候选',
    '',
    ...analysis.titles.candidates.map((title) => `- ${title}`),
    '',
  ];
  if (analysis.theme.folderNameConflict) {
    lines.push('文件夹名称与素材实际内容存在差异，本次主题以素材内容为准。', '');
  }
  if (hyperframes?.enabled) {
    lines.push(
      '## HyperFrames 可选生成素材',
      '',
      `- CLI 版本：${hyperframes.version}`,
      `- 独立 MP4：${hyperframes.outputPath}`,
      `- 规格：${hyperframes.metadata.displayWidth}×${hyperframes.metadata.displayHeight}`
        + `｜${hyperframes.metadata.frameRate} fps｜${hyperframes.metadata.durationSec}s`,
      `- SHA-256：${hyperframes.sha256}`,
      `- 类型：${hyperframes.kind}`,
      `- 生成原因：${hyperframes.reason}`,
      `- 输入记录：${hyperframes.inputPath}`,
      `- 输出记录：${hyperframes.outputRecordPath}`,
      '- 接入方式：作为独立 v3 素材登记，并作为独立镜头写入 FCPXML。',
      '',
    );
  }
  lines.push('## 素材判断', '');
  for (const asset of analysis.assets) {
    const source = manifestById.get(asset.assetId);
    const ranges = asset.ranges.length
      ? asset.ranges.map((range) => `${range.startSec}-${range.endSec}s（可信度 ${range.confidence}${range.reviewRequired ? '，需复核' : ''}）`).join('；')
      : '无视频区间';
    lines.push(`- ${source?.filename || asset.assetId}｜${asset.status}｜${asset.reason}｜${ranges}`);
  }
  lines.push('', '## 镜头顺序', '');
  timelineAnalysis.timeline.shots.forEach((shot, index) => {
    const source = manifestById.get(shot.assetId);
    const mapping = mappingById.get(shot.assetId);
    lines.push(
      `${index + 1}. ${source?.filename || mapping?.projectFilename || shot.assetId}`
      + `｜${shot.inSec}-${shot.outSec}s`
      + `｜${shot.durationSec}s｜${shot.purpose}｜可信度 ${shot.confidence}`
      + `${shot.reviewRequired ? '｜需复核' : ''}`,
    );
  });
  lines.push('', '## 轻字幕 marker', '');
  if (timelineAnalysis.timeline.markers.length === 0) lines.push('- 无');
  else timelineAnalysis.timeline.markers.forEach(
    (marker) => lines.push(
      `- ${marker.timeSec}s｜${marker.text}`
      + (marker.subtitle
        ? `｜FCP Title：${marker.subtitle.enabled && marker.subtitle.renderAsFcpTitle ? '是' : '否'}`
          + `｜${marker.subtitle.durationSec}s｜${marker.subtitle.position}｜${marker.subtitle.purpose}`
        : '｜未提供字幕扩展'),
    ),
  );
  lines.push('', '## v3 素材登记', '');
  mappings.forEach((mapping) => {
    const asset = analysisById.get(mapping.assetId);
    lines.push(`- ${mapping.projectStableId}｜${mapping.projectRelativePath}｜${asset?.status || 'adopt'}`);
  });
  return `${lines.join('\n')}\n`;
}

async function verifyCodexVideoProject(projectPath) {
  const resolved = path.resolve(projectPath);
  const paths = {
    project: path.join(resolved, PROJECT_FILE),
    assets: path.join(resolved, ASSETS_FILE),
    manifest: path.join(resolved, CODEX_VIDEO_MANIFEST_FILE),
    analysis: path.join(resolved, CODEX_VIDEO_ANALYSIS_FILE),
    status: path.join(resolved, CODEX_VIDEO_STATUS_FILE),
    summary: path.join(resolved, CODEX_VIDEO_SUMMARY_FILE),
  };
  const [project, manifest, analysis, status] = await Promise.all([
    readJson(paths.project, 'project.json'),
    readJson(paths.manifest, 'Codex 视频素材清单'),
    readJson(paths.analysis, 'Codex 视频分析'),
    readJson(paths.status, 'Codex 视频状态'),
  ]);
  validateVideoAnalysis(analysis, manifest);
  const effectiveAnalysis = status.effectiveAnalysis || analysis;
  const errors = [];
  const warnings = [];
  if (project.projectPath !== resolved) errors.push('project.json 的 projectPath 与实际目录不一致。');
  const sourceCurrent = await snapshotSource(manifest.sourceDirectory);
  const sourceVerification = compareSourceSnapshots(manifest.sourceSnapshot, sourceCurrent);
  errors.push(...sourceVerification.errors);

  const assetIndex = await loadAssetIndex(resolved);
  for (const mapping of status.assetMappings || []) {
    const target = path.join(resolved, mapping.projectRelativePath);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) {
      errors.push(`正式项目缺少素材：${mapping.projectRelativePath}`);
      continue;
    }
    if (await hashFile(target) !== mapping.sourceSha256) {
      errors.push(`正式项目素材哈希不一致：${mapping.projectRelativePath}`);
    }
    if (!assetIndex.assets?.some((asset) => asset.stableId === mapping.projectStableId
      && asset.availability === 'available')) {
      errors.push(`assets.json 未登记素材：${mapping.projectRelativePath}`);
    }
  }

  const fcpxmlPath = path.join(resolved, status.artifacts.fcpxml);
  const fcpxml = await fs.readFile(fcpxmlPath, 'utf8').catch(() => '');
  const timelineFormat = status.formats?.timeline || {
    orientation: analysis.timeline.orientation,
    width: analysis.timeline.width,
    height: analysis.timeline.height,
    fps: analysis.timeline.fps,
  };
  const previewFormat = resolvePreviewFormat(status.formats?.preview || {
    width: status.previewMetadata?.displayWidth || analysis.timeline.width,
    height: status.previewMetadata?.displayHeight || analysis.timeline.height,
    fps: status.previewMetadata?.frameRate || analysis.timeline.fps,
  });
  const fcpxmlReport = validateFcpxmlStructure(fcpxml, {
    shotCount: effectiveAnalysis.timeline.shots.length,
    assetCount: status.assetMappings.length,
    markerCount: effectiveAnalysis.timeline.markers.length,
    titleCount: collectFcpTitles(effectiveAnalysis).length,
    width: timelineFormat.width,
    height: timelineFormat.height,
    fps: timelineFormat.fps,
  });
  errors.push(...fcpxmlReport.errors);
  let xmlSyntax = { ok: false, message: '未运行 xmllint。' };
  try {
    await runMediaTool('xmllint', ['--noout', fcpxmlPath], { timeoutMs: 30_000 });
    xmlSyntax = { ok: true, message: 'xmllint 语法校验通过。' };
  } catch (error) {
    errors.push(`xmllint 校验失败：${error.message}`);
    xmlSyntax = { ok: false, message: error.message };
  }

  const previewPath = path.join(resolved, status.artifacts.preview);
  let previewMetadata = null;
  try {
    previewMetadata = await probeMedia(previewPath);
    const expectedDuration = timelineDuration(effectiveAnalysis.timeline.shots);
    if (!previewMetadata.hasVideo) errors.push('粗剪预览没有视频流。');
    if (!Number.isFinite(previewMetadata.durationSec)
      || Math.abs(previewMetadata.durationSec - expectedDuration) > 0.35) {
      errors.push(`粗剪预览时长与时间线不一致：预期 ${expectedDuration}s。`);
    }
    if (previewMetadata.displayWidth !== previewFormat.width
      || previewMetadata.displayHeight !== previewFormat.height) {
      errors.push('粗剪预览分辨率与独立预览设置不一致。');
    }
    if (!Number.isFinite(previewMetadata.frameRate)
      || Math.abs(previewMetadata.frameRate - previewFormat.fps) > 0.05) {
      errors.push('粗剪预览帧率与独立预览设置不一致。');
    }
  } catch (error) {
    errors.push(`粗剪预览无法读取：${error.message}`);
  }
  if (!(await fs.stat(paths.summary).catch(() => null))?.isFile()) errors.push('缺少人类可读项目摘要。');
  if (fcpxml.includes(status.artifacts.preview)) errors.push('FCPXML 错误地引用了粗剪预览作为时间线素材。');
  let hyperframes = { enabled: false };
  if (status.hyperframes?.enabled) {
    const generated = status.assetMappings.find(
      (mapping) => mapping.origin === 'hyperframes',
    );
    hyperframes = {
      enabled: true,
      version: status.hyperframes.version,
      assetId: generated?.assetId || null,
      metadata: generated?.metadata || null,
      sha256: generated?.sourceSha256 || null,
      checkOk: status.hyperframes.check?.ok === true,
    };
    if (!generated) errors.push('HyperFrames 状态缺少独立素材映射。');
    if (!status.artifacts.hyperframesMp4) errors.push('HyperFrames 状态缺少独立 MP4 路径。');
    if (!status.artifacts.hyperframesComposition) errors.push('HyperFrames 状态缺少 composition 路径。');
    if (!status.artifacts.hyperframesInput) errors.push('HyperFrames 状态缺少输入记录路径。');
    if (!status.artifacts.hyperframesOutputRecord) errors.push('HyperFrames 状态缺少输出记录路径。');
    if (!hyperframes.checkOk) errors.push('HyperFrames check 状态不是通过。');
    if (status.artifacts.hyperframesComposition) {
      const compositionPath = path.join(
        resolved,
        status.artifacts.hyperframesComposition,
        'index.html',
      );
      if (!(await fs.stat(compositionPath).catch(() => null))?.isFile()) {
        errors.push('缺少 HyperFrames composition 源文件。');
      }
    }
    for (const artifact of ['hyperframesInput', 'hyperframesOutputRecord']) {
      if (status.artifacts[artifact]
        && !(await fs.stat(path.join(resolved, status.artifacts[artifact])).catch(() => null))?.isFile()) {
        errors.push(`缺少 HyperFrames 记录文件：${artifact}`);
      }
    }
  }

  const report = {
    ok: errors.length === 0,
    verifiedAt: new Date().toISOString(),
    projectPath: resolved,
    errors,
    warnings,
    sourceVerification,
    fcpxml: fcpxmlReport,
    xmlSyntax,
    previewMetadata,
    hyperframes,
    formats: { timeline: timelineFormat, preview: previewFormat },
  };
  if (!report.ok) {
    throw Object.assign(new Error(`项目完整性验证失败：${errors[0]}`), {
      code: 'PROJECT_VERIFICATION_FAILED',
      report,
    });
  }
  return report;
}

async function buildCodexVideoProject(options) {
  const { manifest, analysis, formats } = await validateAnalysisFile(
    options.manifestPath,
    options.analysisPath,
    { timeline: options.timelineFormat, preview: options.previewFormat },
  );
  const target = await assertProjectTargetAvailable(options.projectRoot, options.projectName);
  const hyperframesOptions = options.hyperframes || {};
  let hyperframesFlow = hyperframesOptions.flowSpecPath
    ? normalizeFlowSpec(await readJson(hyperframesOptions.flowSpecPath, 'HyperFrames 流程输入'))
    : null;
  if (hyperframesOptions.enabled && hyperframesOptions.reuseProjectPath) {
    throw Object.assign(new Error('不能同时重新渲染并复用 HyperFrames。'), {
      code: 'INVALID_HYPERFRAMES_REUSE',
    });
  }
  let hyperframesEnvironment = null;
  if (hyperframesOptions.enabled) {
    hyperframesEnvironment = await inspectHyperframesEnvironment({
      executablePath: hyperframesOptions.executablePath,
      browserPath: hyperframesOptions.browserPath,
    });
    if (!hyperframesEnvironment.available) {
      throw Object.assign(
        new Error(`HyperFrames 本地渲染环境不可用：${hyperframesEnvironment.errors.join('；')}`),
        { code: 'HYPERFRAMES_UNAVAILABLE', environment: hyperframesEnvironment },
      );
    }
  }
  const currentBeforeBuild = await snapshotSource(manifest.sourceDirectory);
  const preflight = compareSourceSnapshots(manifest.sourceSnapshot, currentBeforeBuild);
  if (!preflight.unchanged) {
    throw Object.assign(new Error(`原始素材已在准备后变化：${preflight.errors[0]}`), {
      code: 'SOURCE_CHANGED_AFTER_PREPARE',
      details: preflight.errors,
    });
  }

  const created = await createProject(target.root, target.name);
  const projectPath = created.project.projectPath;
  let status = {
    schemaVersion: 1,
    status: 'building',
    createdAt: new Date().toISOString(),
    projectPath,
    sourceDirectory: manifest.sourceDirectory,
    assetMappings: [],
    artifacts: {},
    error: null,
  };
  await writeJson(path.join(projectPath, CODEX_VIDEO_STATUS_FILE), status);
  try {
    const mappings = await syncTimelineAssets(projectPath, manifest, analysis);
    await Promise.all([
      writeJson(path.join(projectPath, CODEX_VIDEO_MANIFEST_FILE), manifest),
      writeJson(path.join(projectPath, CODEX_VIDEO_ANALYSIS_FILE), analysis),
    ]);
    let effectiveAnalysis = analysis;
    let hyperframes = null;
    if (hyperframesOptions.reuseProjectPath) {
      const reused = await copyReusableHyperframes(projectPath, hyperframesOptions.reuseProjectPath);
      hyperframesFlow = reused.flow;
      const rendered = reused.rendered;
      const mapping = await registerHyperframesAsset(projectPath, rendered, analysis, hyperframesFlow);
      mappings.push(mapping);
      effectiveAnalysis = addHyperframesAsset(
        analysis,
        mapping,
        rendered.format.durationSec,
        { flow: hyperframesFlow },
      );
      mapping.analysis = effectiveAnalysis.assets.find((asset) => asset.assetId === mapping.assetId);
      hyperframes = {
        enabled: true,
        kind: hyperframesFlow?.kind || 'title-card',
        reason: hyperframesFlow?.reason || '只读复用已验收 HyperFrames 独立素材。',
        flow: hyperframesFlow,
        version: rendered.environment.version,
        outputPath: rendered.outputPath,
        compositionDirectory: rendered.compositionDirectory,
        inputPath: rendered.inputPath,
        outputRecordPath: rendered.outputRecordPath,
        sha256: rendered.sha256,
        metadata: rendered.metadata,
        format: rendered.format,
        requiredChecks: rendered.environment.requiredChecks,
        optionalWarnings: rendered.environment.optionalWarnings,
        check: rendered.check,
        commands: rendered.commands,
        reusedFromProject: reused.sourceProjectPath,
      };
    } else if (hyperframesOptions.enabled) {
      const durationSec = Number(hyperframesOptions.durationSec || (hyperframesFlow ? 5 : 2));
      const visualSources = resolveHyperframesVisualSources(hyperframesFlow, mappings);
      const outputFilename = hyperframesOutputFilename(
        analysis,
        hyperframesFlow,
        visualSources,
        target.name,
      );
      const outputPath = path.join(projectPath, ASSETS_DIR, outputFilename);
      const compositionDirectory = path.join(
        projectPath,
        CODEX_VIDEO_HYPERFRAMES_DIR,
        hyperframesFlow ? 'process-flow' : 'title-card',
      );
      const rendered = await renderHyperframesAsset({
        environment: hyperframesEnvironment,
        executablePath: hyperframesOptions.executablePath,
        browserPath: hyperframesOptions.browserPath,
        compositionDirectory,
        outputPath,
        title: analysis.titles.recommended,
        subtitle: analysis.theme.summary,
        flow: hyperframesFlow,
        visualSources,
        width: formats.timeline.width,
        height: formats.timeline.height,
        fps: formats.timeline.fps,
        durationSec,
        quality: hyperframesOptions.quality || 'standard',
        mediaIdentity: target.name,
      });
      const mapping = await registerHyperframesAsset(projectPath, rendered, analysis, hyperframesFlow);
      mappings.push(mapping);
      effectiveAnalysis = addHyperframesAsset(
        analysis,
        mapping,
        rendered.format.durationSec,
        { flow: hyperframesFlow },
      );
      mapping.analysis = effectiveAnalysis.assets.find((asset) => asset.assetId === mapping.assetId);
      hyperframes = {
        enabled: true,
        kind: hyperframesFlow?.kind || 'title-card',
        reason: hyperframesFlow?.reason || '根据既有分析生成可选独立标题素材。',
        flow: hyperframesFlow,
        version: rendered.environment.version,
        outputPath: rendered.outputPath,
        compositionDirectory: rendered.compositionDirectory,
        inputPath: rendered.inputPath,
        outputRecordPath: rendered.outputRecordPath,
        sha256: rendered.sha256,
        metadata: rendered.metadata,
        format: rendered.format,
        requiredChecks: rendered.environment.requiredChecks,
        optionalWarnings: rendered.environment.optionalWarnings,
        check: rendered.check,
        commands: rendered.commands,
      };
    }
    const outputBase = safeFilename(analysis.titles.recommended, target.name);
    const fcpxmlPath = path.join(projectPath, CODEX_VIDEO_FCPXML_DIR, `${outputBase}.fcpxml`);
    const previewPath = path.join(projectPath, CODEX_VIDEO_PREVIEW_DIR, `${outputBase}-roughcut-preview.mp4`);
    const fcpxmlResult = await writeFcpxml(fcpxmlPath, {
      projectName: target.name,
      analysis: effectiveAnalysis,
      assetMappings: mappings,
    });
    const previewResult = await generateRoughcutPreview(
      previewPath,
      effectiveAnalysis,
      mappings,
      formats.preview,
    );
    const sourceCurrent = await snapshotSource(manifest.sourceDirectory);
    const sourceVerification = compareSourceSnapshots(manifest.sourceSnapshot, sourceCurrent);
    if (!sourceVerification.unchanged) {
      throw Object.assign(new Error(`构建后原始素材发生变化：${sourceVerification.errors[0]}`), {
        code: 'SOURCE_CHANGED_DURING_BUILD',
      });
    }
    const summaryPath = path.join(projectPath, CODEX_VIDEO_SUMMARY_FILE);
    await fs.writeFile(summaryPath, buildHumanSummary({
      projectPath,
      analysis,
      timelineAnalysis: effectiveAnalysis,
      manifest,
      mappings,
      fcpxmlPath,
      previewPath,
      formats,
      sourceVerification,
      hyperframes,
    }), 'utf8');
    status = {
      ...status,
      status: 'generated',
      generatedAt: new Date().toISOString(),
      assetMappings: mappings,
      effectiveAnalysis,
      hyperframes,
      artifacts: {
        manifest: CODEX_VIDEO_MANIFEST_FILE,
        analysis: CODEX_VIDEO_ANALYSIS_FILE,
        summary: CODEX_VIDEO_SUMMARY_FILE,
        fcpxml: path.relative(projectPath, fcpxmlPath),
        preview: path.relative(projectPath, previewPath),
        ...(hyperframes ? {
          hyperframesMp4: path.relative(projectPath, hyperframes.outputPath),
          hyperframesComposition: path.relative(projectPath, hyperframes.compositionDirectory),
          hyperframesInput: path.relative(projectPath, hyperframes.inputPath),
          hyperframesOutputRecord: path.relative(projectPath, hyperframes.outputRecordPath),
        } : {}),
      },
      fcpxmlReport: fcpxmlResult.report,
      previewMetadata: previewResult.metadata,
      formats,
      sourceVerification,
    };
    await writeJson(path.join(projectPath, CODEX_VIDEO_STATUS_FILE), status);
    const verification = await verifyCodexVideoProject(projectPath);
    status = { ...status, status: 'verified', verifiedAt: verification.verifiedAt, verification };
    await writeJson(path.join(projectPath, CODEX_VIDEO_STATUS_FILE), status);
    if (options.openFcpxml) await openFcpxml(fcpxmlPath);
    return {
      ok: true,
      projectPath,
      project: created.project,
      theme: analysis.theme,
      titles: analysis.titles,
      formats,
      assetMappings: mappings,
      artifacts: {
        fcpxmlPath,
        previewPath,
        summaryPath,
        statusPath: path.join(projectPath, CODEX_VIDEO_STATUS_FILE),
        hyperframesMp4Path: hyperframes?.outputPath || null,
        hyperframesCompositionPath: hyperframes?.compositionDirectory || null,
      },
      hyperframes,
      verification,
    };
  } catch (error) {
    status = {
      ...status,
      status: 'failed',
      failedAt: new Date().toISOString(),
      error: { code: error.code || 'BUILD_FAILED', message: error.message },
    };
    await writeJson(path.join(projectPath, CODEX_VIDEO_STATUS_FILE), status).catch(() => {});
    throw error;
  }
}

async function openFcpxml(fcpxmlPath) {
  const resolved = path.resolve(fcpxmlPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) throw new Error('要打开的 FCPXML 文件不存在。');
  await execFileAsync('/usr/bin/open', [resolved], { timeout: 30_000 });
  return { opened: true, fcpxmlPath: resolved };
}

module.exports = {
  buildCodexVideoProject,
  buildHumanSummary,
  copyReusableHyperframes,
  generateRoughcutPreview,
  hyperframesFlowFingerprint,
  hyperframesOutputFilename,
  openFcpxml,
  safeFilename,
  syncTimelineAssets,
  registerHyperframesAsset,
  validateAnalysisFile,
  verifyCodexVideoProject,
};
