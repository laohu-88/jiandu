(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkspaceViewModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const douyin = (typeof require === 'function' ? (() => { try { return require('./douyin-workflow-view-model'); } catch { return null; } })() : null)
    || root.DouyinWorkflowViewModel;
  const { DOUYIN_STAGES } = douyin;

const NAV_ITEMS = Object.freeze([
  { id: 'pending', label: '待处理' },
  { id: 'library', label: '项目' },
  { id: 'settings', label: '设置' },
]);

const PROJECT_PAGES = Object.freeze([
  { id: 'brief', label: '剪辑准备' },
  { id: 'processing', label: '处理中' },
  { id: 'results', label: '结果' },
  { id: 'advanced', label: '高级调整' },
]);

const LEGACY_PAGE_MAP = Object.freeze({
  overview: 'brief',
  main: 'results',
  douyin: 'results',
  assets: 'advanced',
  review: 'advanced',
  outputs: 'results',
  plan: 'brief',
  issues: 'advanced',
  preview: 'advanced',
  deliver: 'results',
});

const ASSET_FILTERS = Object.freeze([
  'selected',
  'separate',
  'excluded',
  'issues',
  'all',
]);

const DEFAULT_ISSUE_FILTERS = Object.freeze({
  levels: null,
  videoId: null,
  shotId: null,
  assetId: null,
  unresolvedOnly: false,
});

const USER_STATUS_LABELS = Object.freeze({
  waiting_ai: '等待 AI',
  processing: 'AI 正在处理',
  results_ready: '结果已就绪',
  in_fcp: '已进入 FCP',
  blocked: '真正阻塞',
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function emptyIssueCounts() {
  return { blocking: 0, confirm: 0, suggestion: 0, info: 0 };
}

function normalizeIssueCounts(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    blocking: Number(source.blocking || 0),
    confirm: Number(source.confirm || 0),
    suggestion: Number(source.suggestion || 0),
    info: Number(source.info || 0),
  };
}

function pickDouyinVariant(result, douyinVariant) {
  if (douyinVariant) return douyinVariant;
  const variants = result?.platformVariants?.variants;
  if (!Array.isArray(variants)) return null;
  return variants.find((item) => item.platform === 'douyin') || variants[0] || null;
}

function mainStatusOf(result, item) {
  return item?.mainStatus
    || result?.project?.statusLabel
    || result?.project?.status
    || item?.statusLabel
    || item?.status
    || 'unknown';
}

function douyinStatusOf(result, item, douyinVariant) {
  if (item?.douyinStatus) return item.douyinStatus;
  const variant = pickDouyinVariant(result, douyinVariant);
  if (variant?.status) return variant.status;
  if (result?.platformVariants == null) return 'unavailable';
  if (Array.isArray(result?.platformVariants?.variants)
    && result.platformVariants.variants.length === 0) {
    return 'none';
  }
  return 'none';
}

function deriveUserStatus({
  task = null,
  result = null,
  issueSummary = null,
} = {}) {
  if (task?.status === 'failed' || result?.project?.status === 'corrupt' || result?.error) {
    return 'blocked';
  }
  if (Number(issueSummary?.unresolvedBlocking || 0) > 0) return 'blocked';
  if (task && ['completed', 'completed_with_warnings'].includes(task.status)) {
    return task.openedInFcpAt ? 'in_fcp' : 'results_ready';
  }
  const processing = [
    'launching_codex', 'launching_cursor', 'awaiting_user_send',
    'scanning_media', 'extracting_metadata', 'extracting_frames',
    'analyzing_media', 'planning_story', 'analysis_complete',
    'deciding_hyperframes', 'designing_hyperframes', 'rendering_hyperframes',
    'reviewing_hyperframes', 'building_project', 'rendering_preview',
    'generating_fcpxml', 'verifying',
  ];
  if (task && processing.includes(task.status)) return 'processing';
  const outputs = asArray(pickDouyinVariant(result)?.outputs);
  if (outputs.length || result?.artifacts?.fcpxml?.exists) return 'results_ready';
  if (task) return 'waiting_ai';
  return 'waiting_ai';
}

function buildCatalogProjectRow(resultSummaryOrCatalogItem = {}, task = null) {
  const item = resultSummaryOrCatalogItem || {};
  const result = item.result || item;
  const project = result.project || {};
  const name = item.name
    || item.projectName
    || project.name
    || item.title
    || '未命名项目';
  const theme = item.theme
    || result.summary?.theme
    || result.summary?.recommendedTitle
    || item.recommendedTitle
    || null;
  const updatedAt = item.updatedAt
    || project.verifiedAt
    || project.generatedAt
    || item.generatedAt
    || item.verifiedAt
    || item.filesystemTime
    || project.createdAt
    || null;
  const userStatus = deriveUserStatus({
    task: task || item.latestTask || null,
    result,
    issueSummary: item.issueCounts || item.issueSummary,
  });

  return {
    name,
    theme,
    updatedAt,
    mainStatus: mainStatusOf(result, item),
    douyinStatus: douyinStatusOf(result, item, item.douyinVariant),
    userStatus,
    userStatusLabel: USER_STATUS_LABELS[userStatus] || userStatus,
    issueCounts: normalizeIssueCounts(item.issueCounts || item.issueSummary || emptyIssueCounts()),
    projectPath: item.projectPath || project.path || null,
    sourceDirectory: item.sourceDirectory || null,
  };
}

function deriveNextStep({
  result = null,
  douyinVariant = null,
  issueSummary = null,
  task = null,
  workspacePhase = 'brief',
} = {}) {
  const unresolvedBlocking = Number(issueSummary?.unresolvedBlocking || 0);
  if (unresolvedBlocking > 0 || task?.status === 'failed' || result?.error) {
    return {
      label: '查看阻塞原因',
      page: 'results',
      reason: task?.errors?.[0]?.message || result?.error || '存在无法安全继续的问题。',
      nav: 'library',
      actionId: 'resolveBlocker',
    };
  }
  if (task && !['completed', 'completed_with_warnings', 'cancelled', 'failed'].includes(task.status)
    && !['draft', 'ready'].includes(task.status)) {
    return {
      label: '查看处理进度',
      page: 'processing',
      reason: task.stageMessage || 'AI 正在处理。',
      nav: 'library',
      actionId: 'watchProgress',
    };
  }
  const variant = pickDouyinVariant(result, douyinVariant);
  const hasOutputs = asArray(variant?.outputs).length > 0 || result?.artifacts?.fcpxml?.exists;
  if (hasOutputs) {
    return {
      label: '在 Final Cut Pro 中打开',
      page: 'results',
      reason: '结果已就绪。',
      nav: 'library',
      actionId: 'openInFcp',
    };
  }
  if (workspacePhase === 'brief' || !result) {
    return {
      label: '开始 AI 剪辑',
      page: 'brief',
      reason: '确认素材后即可开始。',
      nav: 'pending',
      actionId: 'startAiEdit',
    };
  }
  return {
    label: '开始 AI 剪辑',
    page: 'brief',
    reason: '可以开始剪辑。',
    nav: 'pending',
    actionId: 'startAiEdit',
  };
}

function buildWorkspaceHeader({
  result = null,
  douyinVariant = null,
  issueSummary = null,
  activePage = 'brief',
  douyinWorkflow = null,
  task = null,
  platformMode = 'douyin',
  engine = 'cursor_agent',
} = {}) {
  const project = result?.project || {};
  const variant = pickDouyinVariant(result, douyinVariant);
  const userStatus = deriveUserStatus({ task, result, issueSummary });
  const nextStep = deriveNextStep({
    result,
    douyinVariant: variant,
    issueSummary,
    task,
    workspacePhase: activePage,
  });
  const mappedPage = PROJECT_PAGES.some((page) => page.id === activePage)
    ? activePage
    : (LEGACY_PAGE_MAP[activePage] || 'brief');

  return {
    name: project.name || task?.sourceSummary?.name || '未命名项目',
    theme: result?.summary?.theme || result?.summary?.recommendedTitle || null,
    status: USER_STATUS_LABELS[userStatus] || userStatus,
    userStatus,
    mainFilmStatus: project.statusLabel || project.status || 'unknown',
    platformStatus: variant?.status || (result?.platformVariants == null ? 'unavailable' : 'none'),
    platformMode: platformMode === 'main' ? 'main' : 'douyin',
    platformModeLabel: platformMode === 'main' ? '完整成片' : '抖音',
    engine: engine === 'codex' ? 'codex' : 'cursor_agent',
    engineLabel: engine === 'codex' ? 'Codex' : 'Cursor',
    lastOperation: variant?.generatedAt
      || variant?.updatedAt
      || project.verifiedAt
      || project.generatedAt
      || project.createdAt
      || task?.updatedAt
      || null,
    nextStep: {
      label: nextStep.label,
      page: nextStep.page,
      reason: nextStep.reason,
      actionId: nextStep.actionId,
    },
    canReturnToLibrary: true,
    activePage: mappedPage,
    issueSummary: normalizeIssueCounts(issueSummary || emptyIssueCounts()),
    blockingOnly: Number(issueSummary?.unresolvedBlocking || 0) > 0,
  };
}

function buildAppRouteState(partial = {}) {
  const navIds = new Set(NAV_ITEMS.map((item) => item.id));
  const pageIds = new Set(PROJECT_PAGES.map((item) => item.id));
  const stageIds = new Set(DOUYIN_STAGES.map((item) => item.id));
  const assetFilters = new Set(ASSET_FILTERS);

  let nav = navIds.has(partial.nav) ? partial.nav : (partial.nav === 'tasks' ? 'library' : 'pending');
  if (!navIds.has(nav)) nav = 'pending';
  const requestedPage = LEGACY_PAGE_MAP[partial.projectPage] || partial.projectPage;
  const projectPage = pageIds.has(requestedPage) ? requestedPage : 'brief';
  const douyinStage = stageIds.has(partial.douyinStage) ? partial.douyinStage : 'plan';
  const assetFilter = assetFilters.has(partial.assetFilter) ? partial.assetFilter : 'all';
  const platformMode = partial.platformMode === 'main' ? 'main' : 'douyin';
  const engine = partial.engine === 'codex' ? 'codex' : 'cursor_agent';
  const workspacePhase = ['brief', 'processing', 'results', 'revise', 'advanced'].includes(partial.workspacePhase)
    ? partial.workspacePhase
    : projectPage;

  const issueFilters = {
    ...DEFAULT_ISSUE_FILTERS,
    ...(partial.issueFilters && typeof partial.issueFilters === 'object'
      ? partial.issueFilters
      : {}),
  };

  const runningTask = partial.runningTask && typeof partial.runningTask === 'object'
    ? {
      id: String(partial.runningTask.id || ''),
      label: String(partial.runningTask.label || ''),
    }
    : null;

  return {
    nav,
    projectPath: partial.projectPath == null ? null : String(partial.projectPath),
    sourceDirectory: partial.sourceDirectory == null ? null : String(partial.sourceDirectory),
    projectPage,
    workspacePhase,
    platformMode,
    engine,
    extraRequirements: partial.extraRequirements == null ? '' : String(partial.extraRequirements),
    douyinStage,
    douyinVariantId: partial.douyinVariantId == null ? null : String(partial.douyinVariantId),
    assetFilter,
    issueFilters,
    runningTask: runningTask && runningTask.id ? runningTask : null,
    sessionOpen: Boolean(partial.sessionOpen || partial.projectPath || partial.sourceDirectory),
    error: partial.error == null ? null : String(partial.error),
  };
}

function buildPendingEpisodeRow(episode = {}) {
  const counts = episode.counts || {};
  const inventory = episode.inventory || episode.contextIngestion || null;
  return {
    name: episode.name || pathBasename(episode.sourceDirectory),
    sourceDirectory: episode.sourceDirectory,
    origin: inventory?.detected || episode.hotingestDetected ? 'HotIngest' : '普通来源',
    videoCount: counts.video || episode.videoCount || 0,
    imageCount: counts.image || episode.imageCount || 0,
    captionCount: Number(inventory?.items?.filter((item) => item.translations?.length)?.length || 0),
    recognized: Boolean(episode.existingProject || inventory?.detected || episode.totalFileCount > 0),
    existingProject: episode.existingProject || null,
    latestTask: episode.latestTask || null,
  };
}

function pathBasename(value) {
  const text = String(value || '');
  const parts = text.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || text || '未命名素材';
}

  return {
    NAV_ITEMS,
    PROJECT_PAGES,
    ASSET_FILTERS,
    DEFAULT_ISSUE_FILTERS,
    USER_STATUS_LABELS,
    LEGACY_PAGE_MAP,
    buildCatalogProjectRow,
    buildWorkspaceHeader,
    buildAppRouteState,
    buildPendingEpisodeRow,
    deriveNextStep,
    deriveUserStatus,
  };
}));
