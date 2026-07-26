'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  CODEX_VIDEO_ANALYSIS_FILE,
  CODEX_VIDEO_MANIFEST_FILE,
  CODEX_VIDEO_STATUS_FILE,
  CODEX_VIDEO_FCPXML_DIR,
  CODEX_VIDEO_PREVIEW_DIR,
  DEFAULT_PROJECT_ROOT,
  EDITORIAL_REVIEW_FILE,
} = require('../constants');
const {
  classifyHotIngestFile,
} = require('./hotingest-context-service');
const {
  matchExistingProject,
  readExistingProjectSources,
  scanEpisode,
  walkEpisodeFiles,
} = require('./pending-media-catalog-service');
const {
  PRODUCTION_FORMATS,
  STANDARD_FRAME_RATES,
} = require('./video-format-service');
const {
  buildEditorialReviewModel,
  getConfirmedCaptions,
} = require('./editorial-review-service');
const { readCodexProjectResult } = require('./codex-project-result-service');
const {
  buildCodexVideoProject,
  verifyCodexVideoProject,
} = require('./codex-video-service');
const { openInFinalCut } = require('./project-action-service');
const { summarizeMaterialCoverage } = require('./editing-contract-service');

const EDIT_JOB_SCHEMA_VERSION = 1;
const EDIT_JOB_DIRNAME = 'edit-jobs';
const EDIT_JOB_STATUSES = Object.freeze([
  'ready',
  'preflight',
  'preparing',
  'building_project',
  'rendering_preview',
  'generating_fcpxml',
  'verifying',
  'reusing_existing',
  'completed',
  'completed_with_warnings',
  'failed',
  'blocked',
  'cancelled',
]);
const STATUS_SET = new Set(EDIT_JOB_STATUSES);
const TERMINAL_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'failed',
  'blocked',
  'cancelled',
]);
const STAGE_LABELS = Object.freeze({
  ready: '已准备',
  preflight: '生成前检查',
  preparing: '正在准备素材',
  building_project: '正在创建正式项目',
  rendering_preview: '正在生成粗剪',
  generating_fcpxml: '正在生成 FCPXML',
  verifying: '正在完整验证',
  reusing_existing: '正在读取已有正式结果',
  completed: '已完成',
  completed_with_warnings: '已完成但有警告',
  failed: '已失败',
  blocked: '已阻塞',
  cancelled: '已取消',
});
const ACTIONS = new Set([
  'cursor_agent_handoff',
  'codex_handoff',
  'local_build',
  'reuse_existing',
]);

function isInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function jobRoot(userDataPath) {
  const raw = String(userDataPath || '').trim();
  if (!raw) {
    throw Object.assign(new Error('剪辑任务需要有效的 userData 路径。'), {
      code: 'INVALID_EDIT_JOB_ROOT',
    });
  }
  return path.join(path.resolve(raw), EDIT_JOB_DIRNAME);
}

function jobFilePath(userDataPath, jobId) {
  return path.join(jobRoot(userDataPath), `${jobId}.json`);
}

async function atomicWriteJson(filePath, value) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const tempPath = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  try {
    await fs.rename(tempPath, resolved);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function userFacingError(error) {
  const message = error?.message || String(error);
  const code = error?.code || null;
  const map = {
    EMPTY_MATERIAL: '所选目录没有可读素材，请换一期素材后再试。',
    UNREADABLE_MATERIAL: '无法读取所选素材目录，请确认路径权限后重试。',
    PROJECT_ALREADY_EXISTS: '正式项目目录已存在。为保护已有成功结果，不会原地覆盖；请改用“使用已有结果”或生成到新项目。',
    SOURCE_CHANGED_AFTER_PREPARE: '原始素材在准备后发生变化，已停止生成以避免结果不一致。',
    PROJECT_VERIFICATION_FAILED: '生成后的项目未通过完整性验证，不会标记为成功。',
    MISSING_ANALYSIS: '还没有可用的分析结果。请先交给 Cursor Agent 或 Codex 完成分析，或选择已有正式项目。',
    BLOCKED_PREFLIGHT: '生成前检查未通过，当前不能继续生成。',
    UNSAFE_EDIT_JOB_PATH: '剪辑任务文件路径不安全。',
    INVALID_EDIT_ACTION: '不支持的剪辑任务动作。',
  };
  return {
    message: map[code] || message.split('\n')[0] || '剪辑任务失败。',
    diagnostic: {
      code,
      detail: message,
      details: error?.details || error?.report?.errors || null,
    },
  };
}

function detectHotIngestKind(files) {
  const classifications = files
    .map((file) => classifyHotIngestFile(file.relativePath))
    .filter(Boolean);
  const counts = {
    folderIndex: 0,
    contextHtml: 0,
    textHtml: 0,
    metadataJson: 0,
  };
  for (const item of classifications) {
    if (item.type === 'folder-index-html') counts.folderIndex += 1;
    if (item.type === 'context-html') counts.contextHtml += 1;
    if (item.type === 'text-html') counts.textHtml += 1;
    if (item.type === 'metadata-json') counts.metadataJson += 1;
  }
  const isHotIngest = counts.folderIndex > 0
    || counts.contextHtml > 0
    || counts.metadataJson > 0
    || files.some((file) => /(?:^|\/)\.hotingest(?:\/|$)/i.test(file.relativePath.split(path.sep).join('/')));
  return {
    kind: isHotIngest ? 'hotingest' : 'normal',
    kindLabel: isHotIngest ? 'HotIngest 项目' : '普通素材项目',
    hotIngest: {
      detected: isHotIngest,
      counts,
      fileCount: classifications.length,
    },
  };
}

function pickStandardFps(candidate) {
  if (!Number.isFinite(candidate) || candidate <= 0) return 30;
  const standard = STANDARD_FRAME_RATES
    .map((value) => ({ value, distance: Math.abs(value - candidate) }))
    .sort((left, right) => left.distance - right.distance)[0];
  return standard?.distance <= 0.15 ? standard.value : 30;
}

function inferTimelineSpecFromEpisode(episode) {
  const mediaFacts = Array.isArray(episode.mediaFacts) ? episode.mediaFacts : [];
  const videoMetas = mediaFacts
    .filter((entry) => entry.type === 'video' && entry.metadata)
    .map((entry) => ({
      ...entry.metadata,
      durationSec: Number(entry.metadata.durationSec) || 0,
    }))
    .sort((left, right) => right.durationSec - left.durationSec);

  if (videoMetas.length === 0 && Number(episode.counts?.video) > 0) {
    return {
      orientation: null,
      width: null,
      height: null,
      fps: null,
      source: 'pending-probe',
      rationale: '已检测到视频，正式规格将在分析后按主视频判定。',
      confident: false,
    };
  }
  if (videoMetas.length === 0) {
    return {
      orientation: 'horizontal',
      width: PRODUCTION_FORMATS.horizontal.width,
      height: PRODUCTION_FORMATS.horizontal.height,
      fps: 30,
      source: 'image-default',
      rationale: '未检测到主视频，暂按横屏生产规格预估；正式规格以分析结果为准。',
      confident: false,
    };
  }

  const primary = videoMetas[0];
  const width = Number(primary.displayWidth || primary.width) || 0;
  const height = Number(primary.displayHeight || primary.height) || 0;
  const orientation = width && height
    ? (width >= height ? 'horizontal' : 'vertical')
    : 'horizontal';
  const dims = PRODUCTION_FORMATS[orientation];
  return {
    orientation,
    width: dims.width,
    height: dims.height,
    fps: pickStandardFps(Number(primary.frameRate || primary.fps)),
    source: 'dominant-video',
    rationale: '按检测到的主视频方向与帧率预估正式时间线规格。',
    confident: Boolean(width && height),
  };
}

async function loadExistingProjectBundle(projectPath) {
  if (!projectPath) return null;
  const resolved = path.resolve(projectPath);
  const control = path.join(resolved, '00-项目总控');
  const [projectStat, status, analysis, manifest, editorialStat] = await Promise.all([
    fs.stat(resolved).catch(() => null),
    fs.readFile(path.join(control, path.basename(CODEX_VIDEO_STATUS_FILE)), 'utf8')
      .then(JSON.parse)
      .catch(() => null),
    fs.readFile(path.join(resolved, CODEX_VIDEO_ANALYSIS_FILE), 'utf8')
      .then(JSON.parse)
      .catch(() => null),
    fs.readFile(path.join(resolved, CODEX_VIDEO_MANIFEST_FILE), 'utf8')
      .then(JSON.parse)
      .catch(() => null),
    fs.stat(path.join(resolved, EDITORIAL_REVIEW_FILE)).catch(() => null),
  ]);
  if (!projectStat?.isDirectory()) return null;
  let editorialModel = null;
  try {
    editorialModel = await buildEditorialReviewModel(resolved, { analysis, manifest, status });
  } catch {
    editorialModel = null;
  }
  const confirmed = editorialModel ? getConfirmedCaptions(editorialModel) : [];
  const result = await readCodexProjectResult(resolved).catch(() => null);
  const success = status?.status === 'verified'
    || status?.verification?.ok === true
    || result?.project?.status === 'verified';
  const failed = status?.status === 'failed' || result?.project?.status === 'failed';
  const storedCaptionStatuses = { approved: 0, edited_approved: 0, other: 0 };
  try {
    const stored = JSON.parse(await fs.readFile(path.join(resolved, EDITORIAL_REVIEW_FILE), 'utf8'));
    for (const review of Object.values(stored.reviews || {})) {
      for (const caption of Object.values(review.captions || {})) {
        if (caption.reviewStatus === 'approved') storedCaptionStatuses.approved += 1;
        else if (caption.reviewStatus === 'edited_approved') storedCaptionStatuses.edited_approved += 1;
        else storedCaptionStatuses.other += 1;
      }
    }
  } catch {
    // optional
  }
  return {
    projectPath: resolved,
    status: status?.status || result?.project?.status || 'unknown',
    success,
    failed,
    hasAnalysis: Boolean(analysis),
    hasManifest: Boolean(manifest),
    hasEditorialReview: Boolean(editorialStat?.isFile()),
    editorialReviewPath: path.join(resolved, EDITORIAL_REVIEW_FILE),
    analysisPath: path.join(resolved, CODEX_VIDEO_ANALYSIS_FILE),
    manifestPath: path.join(resolved, CODEX_VIDEO_MANIFEST_FILE),
    statusPath: path.join(resolved, CODEX_VIDEO_STATUS_FILE),
    captionSummary: editorialModel?.summary || null,
    confirmedCaptionCount: confirmed.length,
    humanCaptionCount: storedCaptionStatuses.approved + storedCaptionStatuses.edited_approved,
    storedCaptionStatuses,
    timeline: analysis?.timeline ? {
      orientation: analysis.timeline.orientation || null,
      width: analysis.timeline.width || null,
      height: analysis.timeline.height || null,
      fps: analysis.timeline.fps || null,
      shotCount: Array.isArray(analysis.timeline.shots) ? analysis.timeline.shots.length : 0,
      markerCount: Array.isArray(analysis.timeline.markers) ? analysis.timeline.markers.length : 0,
      totalDurationSec: Array.isArray(analysis.timeline.shots)
        ? Number(analysis.timeline.shots.reduce((sum, shot) => sum + (Number(shot.durationSec) || 0), 0).toFixed(3))
        : null,
    } : null,
    artifacts: result?.artifacts || null,
    formats: result?.formats || status?.formats || null,
    result,
    analysis,
    manifest,
    statusRecord: status,
  };
}

function listAffectedArtifacts(existing) {
  if (!existing?.projectPath) return [];
  const files = [
    { path: existing.manifestPath, label: 'Codex视频素材清单.json', regeneratable: true, protected: false },
    { path: existing.analysisPath, label: 'Codex视频分析.json', regeneratable: true, protected: false },
    { path: existing.statusPath, label: 'Codex视频状态.json', regeneratable: true, protected: false },
    {
      path: existing.editorialReviewPath,
      label: 'editorial-review.json（人工审核）',
      regeneratable: false,
      protected: true,
    },
    {
      path: path.join(existing.projectPath, CODEX_VIDEO_FCPXML_DIR),
      label: 'FCPXML 导出目录',
      regeneratable: true,
      protected: false,
    },
    {
      path: path.join(existing.projectPath, CODEX_VIDEO_PREVIEW_DIR),
      label: '粗剪预览目录',
      regeneratable: true,
      protected: false,
    },
    {
      path: path.join(existing.projectPath, '01-精选素材'),
      label: '精选素材目录',
      regeneratable: true,
      protected: false,
    },
  ];
  return files;
}

async function recognizeMaterialProject(sourceDirectory, options = {}) {
  const resolved = path.resolve(String(sourceDirectory || ''));
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw Object.assign(new Error('请选择一个有效的素材项目目录。'), {
      code: 'INVALID_MATERIAL_DIRECTORY',
    });
  }
  const projectRoot = options.projectRoot || DEFAULT_PROJECT_ROOT;
  const projectSources = options.projectSources
    || await readExistingProjectSources(projectRoot);
  const files = await walkEpisodeFiles(resolved);
  const kindInfo = detectHotIngestKind(files);
  const episode = await scanEpisode(resolved, {
    ...options,
    projectSources,
  });
  return {
    ...episode,
    ...kindInfo,
    totalWalkedFiles: files.length,
    projectRoot,
  };
}

async function buildEditPreflight(sourceDirectory, options = {}) {
  const material = await recognizeMaterialProject(sourceDirectory, options);
  const existingMatch = material.existingProject
    || matchExistingProject(material, options.projectSources || []);
  const existing = existingMatch
    ? await loadExistingProjectBundle(existingMatch.projectPath || existingMatch)
    : null;

  const blockers = [];
  const warnings = [...(material.warnings || [])];
  if (material.empty) {
    blockers.push({ code: 'EMPTY_MATERIAL', message: '所选目录没有可读素材。' });
  }
  if (material.unreadable) {
    blockers.push({ code: 'UNREADABLE_MATERIAL', message: '素材目录存在无法读取的内容。' });
  }
  if (material.hasUnsupported) {
    warnings.push(`存在 ${material.counts.unsupported} 个不支持的文件，生成时会忽略它们。`);
  }

  const timelineSpec = existing?.timeline
    ? {
      ...existing.timeline,
      source: 'existing-analysis',
      rationale: '已有正式项目分析中的时间线规格。',
      confident: true,
    }
    : inferTimelineSpecFromEpisode(material);

  const generationMode = existing?.success
    ? 'regenerate'
    : existing?.hasAnalysis
      ? 'regenerate'
      : 'first';

  let recommendedAction = 'cursor_agent_handoff';
  if (existing?.success) recommendedAction = 'reuse_existing';
  else if (existing?.hasAnalysis && existing?.hasManifest) recommendedAction = 'local_build';
  else if (material.empty || material.unreadable) recommendedAction = 'blocked';

  if (recommendedAction === 'local_build' && !(existing?.hasAnalysis && existing?.hasManifest)) {
    blockers.push({ code: 'MISSING_ANALYSIS', message: '缺少可复用的分析结果，无法在 App 内直接生成。' });
    recommendedAction = 'blocked';
  }

  const affectedFiles = listAffectedArtifacts(existing).map((item) => ({
    ...item,
    note: item.protected
      ? '再次生成时不会覆盖此文件。'
      : generationMode === 'first'
        ? '首次生成将创建此产物。'
        : '再次生成可能更新此产物；已有成功项目不会被原地覆盖。',
  }));

  const canContinue = blockers.length === 0 && recommendedAction !== 'blocked';
  const materialCoverage = existing?.analysis && existing?.manifest
    ? summarizeMaterialCoverage(existing.analysis, existing.manifest)
    : null;
  return {
    material,
    existingProject: existing,
    generationMode,
    generationModeLabel: generationMode === 'first' ? '首次生成' : '再次生成',
    timelineSpec,
    materialCoverage,
    editorialReview: existing ? {
      exists: existing.hasEditorialReview,
      path: existing.editorialReviewPath,
      summary: existing.captionSummary,
      confirmedCaptionCount: existing.confirmedCaptionCount,
      humanCaptionCount: existing.humanCaptionCount,
    } : {
      exists: false,
      path: null,
      summary: null,
      confirmedCaptionCount: 0,
      humanCaptionCount: 0,
    },
    context: {
      kind: material.kind,
      kindLabel: material.kindLabel,
      hotIngest: material.hotIngest,
      chapters: material.chapters || [],
      briefFilesUsed: material.briefFilesUsed || [],
      durationPolicy: material.durationPolicy || null,
      existingProjectPath: existing?.projectPath || null,
    },
    mediaCounts: material.counts,
    unsupportedCount: material.counts?.unsupported || 0,
    warnings,
    blockers,
    affectedFiles,
    protections: {
      preserveEditorialReview: true,
      preserveHumanCaptions: true,
      preserveHotIngestSource: true,
      refuseOverwriteSuccessfulProject: true,
      sourceDirectoryReadOnly: true,
    },
    canContinue,
    recommendedAction,
    recommendedEngine: recommendedAction === 'cursor_agent_handoff' || recommendedAction === 'codex_handoff'
      ? (recommendedAction === 'codex_handoff' ? 'codex' : 'cursor_agent')
      : null,
    actions: {
      reuse_existing: Boolean(existing?.success || existing?.hasAnalysis),
      local_build: Boolean(existing?.hasAnalysis && existing?.hasManifest),
      cursor_agent_handoff: !material.empty && !material.unreadable,
      codex_handoff: !material.empty && !material.unreadable,
    },
  };
}

function validateJobShape(job, expectedPath = null) {
  if (!job || job.schemaVersion !== EDIT_JOB_SCHEMA_VERSION) {
    throw Object.assign(new Error('剪辑任务 schemaVersion 无效。'), { code: 'INVALID_EDIT_JOB_SCHEMA' });
  }
  if (typeof job.jobId !== 'string' || !/^[a-f0-9-]{36}$/i.test(job.jobId)) {
    throw Object.assign(new Error('剪辑任务 jobId 无效。'), { code: 'INVALID_EDIT_JOB_ID' });
  }
  if (!STATUS_SET.has(job.status) || job.stage !== job.status) {
    throw Object.assign(new Error('剪辑任务状态无效。'), { code: 'INVALID_EDIT_JOB_STATUS' });
  }
  if (!ACTIONS.has(job.action) && job.action !== 'preflight_only') {
    throw Object.assign(new Error('剪辑任务动作无效。'), { code: 'INVALID_EDIT_ACTION' });
  }
  if (expectedPath) {
    const resolved = path.resolve(expectedPath);
    if (path.basename(resolved) !== `${job.jobId}.json`
      || path.basename(path.dirname(resolved)) !== EDIT_JOB_DIRNAME) {
      throw Object.assign(new Error('剪辑任务文件位置与 jobId 不匹配。'), {
        code: 'UNSAFE_EDIT_JOB_PATH',
      });
    }
  }
  return job;
}

async function readEditJob(jobPath) {
  const resolved = path.resolve(String(jobPath || ''));
  const job = JSON.parse(await fs.readFile(resolved, 'utf8'));
  return validateJobShape(job, resolved);
}

async function assertUserDataEditJob(userDataPath, jobPath) {
  const root = jobRoot(userDataPath);
  const resolved = path.resolve(String(jobPath || ''));
  if (!isInside(root, resolved) || path.extname(resolved) !== '.json') {
    throw Object.assign(new Error('拒绝访问剪辑任务目录外的文件。'), {
      code: 'UNSAFE_EDIT_JOB_PATH',
    });
  }
  return readEditJob(resolved);
}

async function updateEditJob(jobPath, patch = {}) {
  const current = await readEditJob(jobPath);
  if (TERMINAL_STATUSES.has(current.status) && patch.status && patch.status !== current.status) {
    if (!(current.status === 'blocked' && patch.status === 'cancelled')) {
      throw Object.assign(new Error('终态剪辑任务不能再改写状态。'), {
        code: 'EDIT_JOB_ALREADY_TERMINAL',
      });
    }
  }
  const now = new Date().toISOString();
  const nextStatus = patch.status || current.status;
  if (!STATUS_SET.has(nextStatus)) {
    throw Object.assign(new Error('剪辑任务状态无效。'), { code: 'INVALID_EDIT_JOB_STATUS' });
  }
  const next = {
    ...current,
    ...patch,
    status: nextStatus,
    stage: nextStatus,
    stageMessage: patch.stageMessage || current.stageMessage,
    stageStartedAt: patch.status && patch.status !== current.status
      ? now
      : current.stageStartedAt,
    updatedAt: now,
    lastHeartbeatAt: now,
  };
  if (patch.error) next.error = patch.error;
  if (patch.result) next.result = patch.result;
  if (patch.warnings) next.warnings = patch.warnings;
  validateJobShape(next, jobPath);
  await atomicWriteJson(jobPath, next);
  return next;
}

function uniqueProjectName(baseName, existingNames = []) {
  const safe = String(baseName || '未命名项目').trim() || '未命名项目';
  const taken = new Set(existingNames);
  if (!taken.has(safe)) return safe;
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  let candidate = `${safe}-${stamp}`;
  let index = 2;
  while (taken.has(candidate)) {
    candidate = `${safe}-${stamp}-${index}`;
    index += 1;
  }
  return candidate;
}

async function createEditJob(userDataPath, input = {}) {
  const preflight = input.preflight || await buildEditPreflight(input.sourceDirectory, input);
  const action = String(input.action || preflight.recommendedAction || 'cursor_agent_handoff');
  if (!ACTIONS.has(action) && action !== 'preflight_only') {
    throw Object.assign(new Error('不支持的剪辑任务动作。'), { code: 'INVALID_EDIT_ACTION' });
  }
  if (action !== 'preflight_only' && !preflight.canContinue && action !== 'reuse_existing') {
    if (preflight.blockers.length) {
      throw Object.assign(new Error(preflight.blockers[0].message), {
        code: preflight.blockers[0].code || 'BLOCKED_PREFLIGHT',
        preflight,
      });
    }
  }
  if (action === 'reuse_existing' && !preflight.existingProject) {
    throw Object.assign(new Error('没有可复用的正式项目结果。'), { code: 'MISSING_EXISTING_PROJECT' });
  }
  if (action === 'local_build') {
    if (!preflight.existingProject?.hasAnalysis || !preflight.existingProject?.hasManifest) {
      throw Object.assign(new Error('缺少可复用的分析结果，无法在 App 内直接生成。'), {
        code: 'MISSING_ANALYSIS',
        preflight,
      });
    }
    if (preflight.existingProject.success) {
      // local rebuild of a successful project must target a new directory name
    }
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    schemaVersion: EDIT_JOB_SCHEMA_VERSION,
    jobId,
    jobFilePath: jobFilePath(userDataPath, jobId),
    createdAt: now,
    updatedAt: now,
    stageStartedAt: now,
    lastHeartbeatAt: now,
    status: 'ready',
    stage: 'ready',
    stageMessage: '剪辑任务已创建，等待执行。',
    action,
    sourceDirectory: preflight.material.sourceDirectory,
    sourceDirectoryRealPath: preflight.material.sourceDirectoryRealPath,
    sourceSnapshot: preflight.material.sourceSnapshot || null,
    materialKind: preflight.material.kind,
    generationMode: preflight.generationMode,
    projectRoot: preflight.material.projectRoot || DEFAULT_PROJECT_ROOT,
    existingProjectPath: preflight.existingProject?.projectPath || null,
    targetProjectName: input.projectName
      || (action === 'local_build' && preflight.existingProject?.success
        ? uniqueProjectName(`${preflight.material.name}-regen`)
        : preflight.material.name),
    hyperframesMode: input.hyperframesMode || 'disabled',
    preflight,
    protections: preflight.protections,
    warnings: [...preflight.warnings],
    errors: [],
    error: null,
    result: null,
    resultProjectPath: action === 'reuse_existing'
      ? preflight.existingProject?.projectPath || null
      : null,
  };
  validateJobShape(job, job.jobFilePath);
  await atomicWriteJson(job.jobFilePath, job);
  return job;
}

async function listEditJobs(userDataPath) {
  const root = jobRoot(userDataPath);
  const entries = await fs.readdir(root).catch(() => []);
  const jobs = [];
  for (const name of entries.sort().reverse()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    try {
      jobs.push(await readEditJob(path.join(root, name)));
    } catch {
      // skip corrupt
    }
  }
  return jobs;
}

async function snapshotPaths(paths) {
  const rows = [];
  for (const target of paths) {
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) {
      rows.push({ path: target, exists: false, size: null, mtimeMs: null, sha256: null });
      continue;
    }
    if (stat.isDirectory()) {
      rows.push({
        path: target,
        exists: true,
        size: null,
        mtimeMs: stat.mtimeMs,
        sha256: null,
        kind: 'directory',
      });
      continue;
    }
    const buffer = await fs.readFile(target);
    rows.push({
      path: target,
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      kind: 'file',
    });
  }
  return rows;
}

async function assertImmutableSnapshots(before, after, label) {
  const changed = [];
  const beforeMap = new Map(before.map((item) => [item.path, item]));
  for (const item of after) {
    const previous = beforeMap.get(item.path);
    if (!previous) continue;
    if (previous.exists !== item.exists
      || previous.size !== item.size
      || previous.sha256 !== item.sha256) {
      changed.push(item.path);
    }
  }
  if (changed.length) {
    throw Object.assign(new Error(`${label} 在任务执行期间被修改：${changed[0]}`), {
      code: 'IMMUTABLE_PATH_CHANGED',
      details: changed,
    });
  }
}

async function runReuseExistingJob(job, helpers, options = {}) {
  await helpers.update({
    status: 'reusing_existing',
    stageMessage: '正在读取已有正式项目结果，不会覆盖人工审核或来源素材。',
  });
  const projectPath = job.existingProjectPath || job.preflight?.existingProject?.projectPath;
  if (!projectPath) {
    throw Object.assign(new Error('没有可复用的正式项目结果。'), {
      code: 'MISSING_EXISTING_PROJECT',
    });
  }
  const verifyImpl = options.verifyImpl || verifyCodexVideoProject;
  const readResultImpl = options.readResultImpl || readCodexProjectResult;
  const protectedPaths = [
    job.sourceDirectoryRealPath || job.sourceDirectory,
    path.join(projectPath, EDITORIAL_REVIEW_FILE),
  ];
  const before = await snapshotPaths(protectedPaths);
  await helpers.update({
    status: 'verifying',
    stageMessage: '正在只读验证已有正式项目。',
  });
  const result = await readResultImpl(projectPath);
  let verification = null;
  try {
    verification = await verifyImpl(projectPath);
  } catch (error) {
    verification = error.report || {
      ok: false,
      errors: [error.message],
      warnings: [],
    };
  }
  // Stage 5E managed caption Titles are intentionally absent from analysis markers.
  // Treat that specific mismatch as a warning when caption export already recorded confirmed titles.
  let captionExportConfirmed = 0;
  try {
    const statusJson = JSON.parse(
      await fs.readFile(path.join(projectPath, CODEX_VIDEO_STATUS_FILE), 'utf8'),
    );
    captionExportConfirmed = Number(statusJson?.captionExport?.confirmed || 0);
  } catch {
    captionExportConfirmed = 0;
  }
  const originalErrors = [...(verification?.errors || [])];
  const filteredErrors = originalErrors.filter((message) => {
    if (captionExportConfirmed > 0 && /title 数量 \d+ 与分析结果 \d+ 不一致/.test(String(message))) {
      return false;
    }
    return true;
  });
  const titleMismatchWarnings = originalErrors
    .filter((message) => /title 数量 \d+ 与分析结果 \d+ 不一致/.test(String(message)))
    .filter(() => captionExportConfirmed > 0)
    .map((message) => `已忽略受管轻字幕 Title 与分析差异：${message}`);
  verification = {
    ...verification,
    errors: filteredErrors,
    warnings: [...(verification?.warnings || []), ...titleMismatchWarnings],
  };
  verification.ok = filteredErrors.length === 0;

  const after = await snapshotPaths(protectedPaths);
  await assertImmutableSnapshots(before, after, '受保护文件');
  const existingBundle = options.existingBundle
    || await loadExistingProjectBundle(projectPath);
  const summary = summarizeResultForJob(result, verification, {
    humanCaptionCount: existingBundle?.humanCaptionCount,
    confirmedCaptionCount: existingBundle?.confirmedCaptionCount,
  });

  const projectFailed = result?.project?.status === 'failed' || result?.project?.status === 'corrupt';
  const ok = !projectFailed && verification.ok === true;
  const warnings = [
    ...(job.warnings || []),
    ...(verification?.warnings || []),
    ...(result?.verification?.warnings || []),
  ];
  if (!ok) {
    const failed = await helpers.update({
      status: 'failed',
      stageMessage: '已有项目未通过验证，不会标记为成功。',
      error: userFacingError(Object.assign(
        new Error((verification?.errors || ['验证失败'])[0]),
        { code: 'PROJECT_VERIFICATION_FAILED', report: verification },
      )),
      result: {
        projectPath,
        verification,
        summary,
      },
      resultProjectPath: projectPath,
      warnings,
    });
    return failed;
  }
  const hasWarnings = warnings.length > 0 || result?.project?.status === 'warning';
  return helpers.update({
    status: hasWarnings ? 'completed_with_warnings' : 'completed',
    stageMessage: hasWarnings
      ? '已复用正式结果，但存在警告。'
      : '已复用正式结果，可交接 Final Cut Pro。',
    result: {
      projectPath,
      verification,
      summary,
      reused: true,
    },
    resultProjectPath: projectPath,
    warnings,
    error: null,
  });
}

function summarizeResultForJob(result, verification = null, options = {}) {
  const shots = result?.timeline?.shots || [];
  const videoShotCount = shots.filter((shot) => /\.(mp4|mov|m4v|mkv|webm)$/i.test(shot.filename || '')).length;
  const approved = Number(result?.explanationReview?.summary?.approved || 0);
  const edited = Number(result?.explanationReview?.summary?.editedApproved || 0);
  const subtitleCount = Number.isFinite(options.humanCaptionCount)
    ? options.humanCaptionCount
    : (approved + edited > 0 ? approved + edited : (options.confirmedCaptionCount ?? null));
  return {
    projectName: result?.project?.name || null,
    projectPath: result?.project?.path || null,
    status: result?.project?.status || null,
    recommendedTitle: result?.summary?.recommendedTitle || null,
    shotCount: result?.timeline?.shotCount ?? verification?.narrative?.shotCount ?? null,
    videoCount: videoShotCount || null,
    markerCount: result?.timeline?.markers?.length
      ?? verification?.markerCount
      ?? null,
    titleCount: result?.formats?.fcpxmlTitleCount
      ?? result?.subtitles?.titles?.length
      ?? verification?.titleCount
      ?? null,
    subtitleCount,
    totalDurationSec: result?.timeline?.totalDurationSec ?? verification?.narrative?.durationSec ?? null,
    timeline: result?.formats?.timeline || verification?.formats?.timeline || null,
    preview: result?.formats?.preview || verification?.formats?.preview || null,
    artifacts: {
      projectPath: result?.project?.path || null,
      fcpxmlPath: result?.artifacts?.fcpxml?.path || null,
      previewPath: result?.artifacts?.preview?.path || null,
      editorialReviewPath: result?.project?.path
        ? path.join(result.project.path, EDITORIAL_REVIEW_FILE)
        : null,
      analysisPath: result?.artifacts?.analysis?.path || null,
      statusPath: result?.artifacts?.status?.path || null,
    },
  };
}

async function runLocalBuildJob(job, helpers) {
  const existing = job.preflight?.existingProject;
  if (!existing?.hasAnalysis || !existing?.hasManifest) {
    throw Object.assign(new Error('缺少可复用的分析结果，无法在 App 内直接生成。'), {
      code: 'MISSING_ANALYSIS',
    });
  }

  const projectRoot = job.projectRoot || DEFAULT_PROJECT_ROOT;
  const entries = await fs.readdir(projectRoot).catch(() => []);
  let targetName = job.targetProjectName || existing.projectPath && path.basename(existing.projectPath);
  if (existing.success) {
    targetName = uniqueProjectName(
      job.targetProjectName || `${path.basename(existing.projectPath)}-regen`,
      entries,
    );
  } else {
    // Failed/incomplete project: still avoid destroying non-empty dirs by using a new name
    // if the same name already exists and is non-empty.
    const targetPath = path.join(projectRoot, targetName);
    const stat = await fs.stat(targetPath).catch(() => null);
    if (stat) {
      const childEntries = await fs.readdir(targetPath);
      if (childEntries.length > 0) {
        targetName = uniqueProjectName(`${targetName}-regen`, entries);
      }
    }
  }

  const protectedPaths = [
    job.sourceDirectoryRealPath || job.sourceDirectory,
  ];
  if (existing.hasEditorialReview) protectedPaths.push(existing.editorialReviewPath);
  if (existing.success) protectedPaths.push(existing.projectPath);

  const before = await snapshotPaths(protectedPaths);
  await helpers.update({
    status: 'building_project',
    stageMessage: existing.success
      ? `已有成功项目将保持不动；正在生成到新项目「${targetName}」。`
      : '正在基于已有分析在 App 内生成正式项目。',
    targetProjectName: targetName,
  });

  const built = await buildCodexVideoProject({
    manifestPath: existing.manifestPath,
    analysisPath: existing.analysisPath,
    projectRoot,
    projectName: targetName,
    timelineFormat: existing.formats?.timeline || existing.timeline || undefined,
    previewFormat: existing.formats?.preview || undefined,
    hyperframes: { enabled: false },
    onStage: async (status, message) => {
      const mapped = STATUS_SET.has(status) ? status : 'building_project';
      await helpers.update({
        status: mapped,
        stageMessage: message || STAGE_LABELS[mapped] || status,
      });
    },
  });

  // Preserve human editorial review into the new project without touching the source copy.
  if (existing.hasEditorialReview) {
    const targetReview = path.join(built.projectPath, EDITORIAL_REVIEW_FILE);
    const sourceReview = await fs.readFile(existing.editorialReviewPath, 'utf8');
    await fs.writeFile(targetReview, sourceReview, 'utf8');
  }

  await helpers.update({
    status: 'verifying',
    stageMessage: '正在验证新生成的正式项目。',
  });
  const verification = await verifyCodexVideoProject(built.projectPath);
  const result = await readCodexProjectResult(built.projectPath);
  const after = await snapshotPaths(protectedPaths);
  await assertImmutableSnapshots(before, after, '受保护文件与已有成功项目');

  return helpers.update({
    status: 'completed',
    stageMessage: 'App 内生成完成，可交接 Final Cut Pro。',
    result: {
      projectPath: built.projectPath,
      verification,
      summary: summarizeResultForJob(result, verification),
      reused: false,
      preservedEditorialReview: Boolean(existing.hasEditorialReview),
    },
    resultProjectPath: built.projectPath,
    error: null,
  });
}

async function runEditJob(userDataPath, jobPath, options = {}) {
  const resolved = await assertUserDataEditJob(userDataPath, jobPath);
  if (TERMINAL_STATUSES.has(resolved.status)) return resolved;

  const helpers = {
    update: (patch) => updateEditJob(resolved.jobFilePath, patch),
  };

  try {
    if (resolved.action === 'cursor_agent_handoff' || resolved.action === 'codex_handoff') {
      // Agent handoff is orchestrated by the App using the shared handoff service.
      // The edit job remains a planning record that points at the handoff path.
      return helpers.update({
        status: 'ready',
        stageMessage: resolved.action === 'cursor_agent_handoff'
          ? '请继续使用 Cursor Agent 交接管线完成分析；完成后可在 App 内继续构建与验证。'
          : '请继续使用现有 Codex 交接管线完成分析与生成。',
        result: {
          handoffRequired: true,
          engine: resolved.action === 'cursor_agent_handoff' ? 'cursor_agent' : 'codex',
          sourceDirectory: resolved.sourceDirectory,
        },
      });
    }
    if (resolved.action === 'reuse_existing') {
      return await runReuseExistingJob(resolved, helpers, options);
    }
    if (resolved.action === 'local_build') {
      return await runLocalBuildJob(resolved, helpers);
    }
    throw Object.assign(new Error('不支持的剪辑任务动作。'), { code: 'INVALID_EDIT_ACTION' });
  } catch (error) {
    const faced = userFacingError(error);
    return helpers.update({
      status: error.code === 'BLOCKED_PREFLIGHT' ? 'blocked' : 'failed',
      stageMessage: faced.message,
      error: faced,
      resultProjectPath: null,
    });
  }
}

async function openEditJobInFinalCut(jobOrProjectPath) {
  const projectPath = typeof jobOrProjectPath === 'string'
    ? jobOrProjectPath
    : jobOrProjectPath?.resultProjectPath || jobOrProjectPath?.result?.projectPath;
  if (!projectPath) {
    throw Object.assign(new Error('还没有可交接的正式项目。'), { code: 'MISSING_RESULT_PROJECT' });
  }
  const result = await readCodexProjectResult(projectPath);
  if (result.project.status === 'failed' || result.project.status === 'corrupt') {
    throw Object.assign(new Error('失败项目不能交接 Final Cut Pro。'), {
      code: 'FAILED_PROJECT_NOT_HANDOFFABLE',
    });
  }
  if (!result.artifacts?.fcpxml?.exists) {
    throw Object.assign(new Error('FCPXML 不存在，无法打开 Final Cut Pro。'), {
      code: 'MISSING_FCPXML',
    });
  }
  return openInFinalCut(result.artifacts.fcpxml.path);
}

module.exports = {
  ACTIONS,
  EDIT_JOB_DIRNAME,
  EDIT_JOB_SCHEMA_VERSION,
  EDIT_JOB_STATUSES,
  STAGE_LABELS,
  TERMINAL_STATUSES,
  assertUserDataEditJob,
  buildEditPreflight,
  createEditJob,
  detectHotIngestKind,
  inferTimelineSpecFromEpisode,
  jobFilePath,
  jobRoot,
  listAffectedArtifacts,
  listEditJobs,
  loadExistingProjectBundle,
  openEditJobInFinalCut,
  readEditJob,
  recognizeMaterialProject,
  runEditJob,
  summarizeResultForJob,
  uniqueProjectName,
  updateEditJob,
  userFacingError,
};
