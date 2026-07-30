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
  { id: 'pending', label: '待处理素材' },
  { id: 'library', label: '项目库' },
  { id: 'tasks', label: '当前任务' },
  { id: 'settings', label: '设置' },
]);

const PROJECT_PAGES = Object.freeze([
  { id: 'overview', label: '概览' },
  { id: 'main', label: '主成片' },
  { id: 'douyin', label: '抖音版本' },
  { id: 'assets', label: '素材' },
  { id: 'review', label: '问题与审核' },
  { id: 'outputs', label: '输出结果' },
]);

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

function buildCatalogProjectRow(resultSummaryOrCatalogItem = {}) {
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

  return {
    name,
    theme,
    updatedAt,
    mainStatus: mainStatusOf(result, item),
    douyinStatus: douyinStatusOf(result, item, item.douyinVariant),
    issueCounts: normalizeIssueCounts(item.issueCounts || item.issueSummary || emptyIssueCounts()),
    projectPath: item.projectPath || project.path || null,
  };
}

function deriveNextStep({
  result = null,
  douyinVariant = null,
  issueSummary = null,
  douyinWorkflow = null,
} = {}) {
  const variant = pickDouyinVariant(result, douyinVariant);
  const unresolvedConfirm = Number(issueSummary?.unresolvedConfirm || 0);
  const unresolvedBlocking = Number(issueSummary?.unresolvedBlocking || 0);
  const platformVariantsMissing = result != null && result.platformVariants == null;

  if (!result) {
    return {
      label: '打开项目库',
      page: null,
      reason: '尚未打开项目。',
      nav: 'library',
    };
  }

  if (result?.error || result?.project?.status === 'corrupt') {
    return {
      label: '查看概览',
      page: 'overview',
      reason: result.error || '项目状态异常，请先查看概览。',
      nav: 'tasks',
    };
  }

  if (platformVariantsMissing) {
    return {
      label: '查看主成片',
      page: 'main',
      reason: '旧项目尚未包含平台变体，可先查看主成片。',
      nav: 'tasks',
    };
  }

  if (douyinWorkflow?.nextAction) {
    const action = douyinWorkflow.nextAction;
    const pageByAction = {
      saveDraft: 'douyin',
      confirmIssues: 'review',
      approve: 'review',
      generate: 'douyin',
      playPreview: 'outputs',
      viewVerification: 'outputs',
      openOutputDir: 'outputs',
      openInFcp: 'outputs',
    };
    return {
      label: action.label,
      page: pageByAction[action.id] || 'douyin',
      reason: action.reason || '',
      nav: 'tasks',
      actionId: action.id,
    };
  }

  if (!variant) {
    return {
      label: '创建抖音版本',
      page: 'douyin',
      reason: '项目还没有抖音变体。',
      nav: 'tasks',
    };
  }

  if (unresolvedConfirm > 0 || unresolvedBlocking > 1) {
    return {
      label: '确认待处理问题',
      page: 'review',
      reason: '仍有待处理问题。',
      nav: 'tasks',
    };
  }

  if (!['approved', 'generated', 'generated_with_warnings'].includes(String(variant.status))) {
    return {
      label: '批准当前抖音方案',
      page: 'review',
      reason: '抖音方案尚未批准。',
      nav: 'tasks',
    };
  }

  if (!asArray(variant.outputs).length) {
    return {
      label: '生成预览与 FCP 时间线',
      page: 'douyin',
      reason: '方案已批准，可生成输出。',
      nav: 'tasks',
    };
  }

  return {
    label: '查看输出结果',
    page: 'outputs',
    reason: '输出已生成。',
    nav: 'tasks',
  };
}

function buildWorkspaceHeader({
  result = null,
  douyinVariant = null,
  issueSummary = null,
  activePage = 'overview',
  douyinWorkflow = null,
} = {}) {
  const project = result?.project || {};
  const variant = pickDouyinVariant(result, douyinVariant);
  const nextStep = deriveNextStep({
    result,
    douyinVariant: variant,
    issueSummary,
    douyinWorkflow,
  });

  const lastOperation = variant?.generatedAt
    || variant?.updatedAt
    || project.verifiedAt
    || project.generatedAt
    || project.createdAt
    || null;

  return {
    name: project.name || '未命名项目',
    theme: result?.summary?.theme || result?.summary?.recommendedTitle || null,
    status: project.statusLabel || project.status || 'unknown',
    mainFilmStatus: project.statusLabel || project.status || 'unknown',
    platformStatus: variant?.status || (result?.platformVariants == null ? 'unavailable' : 'none'),
    lastOperation,
    nextStep: {
      label: nextStep.label,
      page: nextStep.page,
      reason: nextStep.reason,
    },
    canReturnToLibrary: true,
    activePage: PROJECT_PAGES.some((page) => page.id === activePage) ? activePage : 'overview',
    issueSummary: normalizeIssueCounts(issueSummary || emptyIssueCounts()),
  };
}

function buildAppRouteState(partial = {}) {
  const navIds = new Set(NAV_ITEMS.map((item) => item.id));
  const pageIds = new Set(PROJECT_PAGES.map((item) => item.id));
  const stageIds = new Set(DOUYIN_STAGES.map((item) => item.id));
  const assetFilters = new Set(ASSET_FILTERS);

  const nav = navIds.has(partial.nav) ? partial.nav : 'pending';
  const projectPage = pageIds.has(partial.projectPage) ? partial.projectPage : 'overview';
  const douyinStage = stageIds.has(partial.douyinStage) ? partial.douyinStage : 'plan';
  const assetFilter = assetFilters.has(partial.assetFilter) ? partial.assetFilter : 'all';

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
    projectPage,
    douyinStage,
    douyinVariantId: partial.douyinVariantId == null ? null : String(partial.douyinVariantId),
    assetFilter,
    issueFilters,
    runningTask: runningTask && runningTask.id ? runningTask : null,
    error: partial.error == null ? null : String(partial.error),
  };
}

  return {
    NAV_ITEMS,
    PROJECT_PAGES,
    ASSET_FILTERS,
    DEFAULT_ISSUE_FILTERS,
    buildCatalogProjectRow,
    buildWorkspaceHeader,
    buildAppRouteState,
    deriveNextStep,
  };
}));
