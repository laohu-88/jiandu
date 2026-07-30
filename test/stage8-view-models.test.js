'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ISSUE_LEVELS,
  classifyDouyinIssues,
  summarizeIssues,
  filterIssues,
  groupIssuesByLevel,
} = require('../src/view-models/issue-center-view-model');

const {
  DOUYIN_STAGES,
  buildDouyinWorkflowViewModel,
  ACTION_LABELS,
} = require('../src/view-models/douyin-workflow-view-model');

const {
  NAV_ITEMS,
  PROJECT_PAGES,
  ASSET_FILTERS,
  buildCatalogProjectRow,
  buildWorkspaceHeader,
  buildAppRouteState,
  deriveNextStep,
} = require('../src/view-models/workspace-view-model');

const viewModels = require('../src/view-models');

const PlannerState = require('../src/renderer/modules/state');
const PlannerRouter = require('../src/renderer/modules/router');
const { createIpcClient } = require('../src/renderer/modules/ipc-client');
const {
  formatDateTime,
  formatDuration,
  getUserErrorMessage,
  createToastHelper,
} = require('../src/renderer/modules/utils');

function sampleVariant(overrides = {}) {
  return {
    variantId: 'douyin',
    platform: 'douyin',
    revision: 2,
    status: 'draft',
    approval: null,
    outputs: [],
    previousOutputs: [],
    plan: {
      selection: [
        { assetId: 'a1', decision: 'selected', reason: '开场清晰' },
        { assetId: 'a2', decision: 'excluded', reason: '重复画面' },
      ],
      videos: [
        {
          videoId: 'douyin-1',
          theme: '开场',
          shots: [{ shotId: 'shot-1', assetId: 'a1' }],
          warnings: [
            {
              warningId: 'w1',
              type: 'watermark',
              assetId: 'a1',
              message: '右上角可能有水印',
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

test('view-models index re-exports core symbols', () => {
  assert.ok(viewModels.ISSUE_LEVELS);
  assert.ok(viewModels.DOUYIN_STAGES);
  assert.ok(viewModels.NAV_ITEMS);
  assert.equal(typeof viewModels.classifyDouyinIssues, 'function');
  assert.equal(typeof viewModels.buildDouyinWorkflowViewModel, 'function');
  assert.equal(typeof viewModels.buildAppRouteState, 'function');
});

test('routing state merge keeps unique shape and defaults', () => {
  const state = buildAppRouteState({});
  assert.deepEqual(Object.keys(state).sort(), [
    'assetFilter',
    'douyinStage',
    'douyinVariantId',
    'error',
    'issueFilters',
    'nav',
    'projectPage',
    'projectPath',
    'runningTask',
  ].sort());
  assert.equal(state.nav, 'pending');
  assert.equal(state.projectPath, null);
  assert.equal(state.projectPage, 'overview');
  assert.equal(state.douyinStage, 'plan');
  assert.equal(state.assetFilter, 'all');
  assert.equal(state.error, null);

  const next = buildAppRouteState({
    nav: 'tasks',
    projectPath: '/tmp/demo',
    projectPage: 'douyin',
    douyinStage: 'issues',
    douyinVariantId: 'douyin',
    assetFilter: 'selected',
    issueFilters: { unresolvedOnly: true },
    runningTask: { id: 't1', label: '生成中' },
    error: 'boom',
  });
  assert.equal(next.nav, 'tasks');
  assert.equal(next.projectPage, 'douyin');
  assert.equal(next.douyinStage, 'issues');
  assert.equal(next.assetFilter, 'selected');
  assert.equal(next.issueFilters.unresolvedOnly, true);
  assert.equal(next.runningTask.id, 't1');
  assert.equal(next.error, 'boom');

  const invalid = buildAppRouteState({
    nav: 'nope',
    projectPage: 'zzz',
    douyinStage: 'zzz',
    assetFilter: 'zzz',
  });
  assert.equal(invalid.nav, 'pending');
  assert.equal(invalid.projectPage, 'overview');
  assert.equal(invalid.douyinStage, 'plan');
  assert.equal(invalid.assetFilter, 'all');
});

test('nav and project pages use Chinese labels', () => {
  assert.deepEqual(NAV_ITEMS.map((item) => item.label), [
    '待处理素材', '项目库', '当前任务', '设置',
  ]);
  assert.deepEqual(PROJECT_PAGES.map((item) => item.label), [
    '概览', '主成片', '抖音版本', '素材', '问题与审核', '输出结果',
  ]);
  assert.deepEqual([...ASSET_FILTERS], [
    'selected', 'separate', 'excluded', 'issues', 'all',
  ]);
});

test('project switch fields normalize catalog rows and workspace header', () => {
  const row = buildCatalogProjectRow({
    projectName: '一期演示',
    recommendedTitle: '竖屏开发记录',
    status: 'verified',
    statusLabel: '已验证',
    generatedAt: '2026-07-01T00:00:00.000Z',
    issueCounts: { blocking: 1, confirm: 2, suggestion: 0, info: 3 },
    douyinStatus: 'draft',
    projectPath: '/projects/demo',
  });
  assert.equal(row.name, '一期演示');
  assert.equal(row.theme, '竖屏开发记录');
  assert.equal(row.mainStatus, '已验证');
  assert.equal(row.douyinStatus, 'draft');
  assert.equal(row.issueCounts.confirm, 2);

  const header = buildWorkspaceHeader({
    result: {
      project: { name: '一期演示', status: 'verified', statusLabel: '已验证' },
      summary: { theme: '开发记录' },
      platformVariants: { variants: [{ platform: 'douyin', status: 'approved' }] },
    },
    douyinVariant: sampleVariant({ status: 'approved', approval: { revision: 2, approvedWarningIds: ['w1'] } }),
    issueSummary: { blocking: 0, confirm: 0, suggestion: 1, info: 2, unresolvedConfirm: 0, unresolvedBlocking: 0 },
    activePage: 'douyin',
  });
  assert.equal(header.name, '一期演示');
  assert.equal(header.theme, '开发记录');
  assert.equal(header.mainFilmStatus, '已验证');
  assert.equal(header.platformStatus, 'approved');
  assert.equal(header.canReturnToLibrary, true);
  assert.ok(header.nextStep.label);
  assert.ok(header.nextStep.page);
});

test('main vs douyin status remain distinct for old and new projects', () => {
  const oldRow = buildCatalogProjectRow({
    projectName: '旧项目',
    statusLabel: '已验证',
    result: { platformVariants: null, project: { name: '旧项目', statusLabel: '已验证' } },
  });
  assert.equal(oldRow.mainStatus, '已验证');
  assert.equal(oldRow.douyinStatus, 'unavailable');

  const header = buildWorkspaceHeader({
    result: {
      project: { name: '旧项目', statusLabel: '已验证' },
      summary: { theme: null },
      platformVariants: null,
    },
    activePage: 'main',
  });
  assert.equal(header.platformStatus, 'unavailable');
  assert.equal(header.nextStep.page, 'main');
  assert.match(header.nextStep.reason, /旧项目|主成片/);
});

test('four douyin stages are ordered and labeled', () => {
  assert.deepEqual(DOUYIN_STAGES.map((stage) => stage.id), [
    'plan', 'issues', 'preview', 'deliver',
  ]);
  assert.ok(DOUYIN_STAGES.every((stage) => stage.label && stage.shortLabel));
});

test('issue classify/filter/confirm resolved and generation gates', () => {
  assert.deepEqual([...ISSUE_LEVELS], ['blocking', 'confirm', 'suggestion', 'info']);

  const variant = sampleVariant();
  const unread = classifyDouyinIssues({
    variant,
    approvedWarningIds: [],
    readabilityFindings: [{ message: '字幕偏小', videoId: 'douyin-1', shotId: 'shot-1' }],
  });
  const grouped = groupIssuesByLevel(unread);
  assert.equal(grouped.confirm.length, 1);
  assert.equal(grouped.confirm[0].warningId, 'w1');
  assert.equal(grouped.confirm[0].resolved, false);
  assert.equal(grouped.confirm[0].source, 'plan-warning');
  assert.ok(grouped.suggestion.some((issue) => issue.message.includes('字幕偏小')));
  assert.ok(grouped.info.length >= 3);
  assert.ok(grouped.blocking.some((issue) => issue.id === 'blocking:no-approval'));
  assert.ok(grouped.blocking.some((issue) => issue.id === 'blocking:unconfirmed-warnings'));

  const approvedWarnings = classifyDouyinIssues({
    variant,
    approvedWarningIds: ['w1'],
  });
  const confirm = approvedWarnings.find((issue) => issue.warningId === 'w1');
  assert.equal(confirm.resolved, true);
  assert.equal(
    approvedWarnings.some((issue) => issue.id === 'blocking:unconfirmed-warnings'),
    false,
  );

  const summary = summarizeIssues(unread);
  assert.ok(summary.unresolvedConfirm >= 1);
  assert.ok(summary.unresolvedBlocking >= 1);
  assert.equal(summary.total, unread.length);

  const onlyConfirm = filterIssues(unread, { levels: ['confirm'], unresolvedOnly: true });
  assert.equal(onlyConfirm.length, 1);
  assert.equal(onlyConfirm[0].videoId, 'douyin-1');

  const empty = classifyDouyinIssues({
    variant: sampleVariant({
      plan: { selection: [], videos: [] },
    }),
  });
  assert.ok(empty.some((issue) => issue.id === 'blocking:empty-videos'));
  assert.ok(empty.some((issue) => issue.id === 'blocking:no-selected-assets'));

  const missingReason = classifyDouyinIssues({
    variant: sampleVariant({
      plan: {
        selection: [{ assetId: 'a1', decision: 'selected', reason: '' }],
        videos: [{ videoId: 'douyin-1', warnings: [], shots: [] }],
      },
    }),
  });
  assert.ok(missingReason.some((issue) => issue.id.startsWith('blocking:missing-reason:')));

  const invalidated = classifyDouyinIssues({
    variant: sampleVariant({
      status: 'draft',
      previousOutputs: [{ revision: 1, outputs: [{ videoId: 'douyin-1' }] }],
      approval: null,
    }),
  });
  assert.ok(invalidated.some((issue) => issue.id === 'blocking:approval-invalidated'));

  const verifyFail = classifyDouyinIssues({
    variant: sampleVariant({
      status: 'generated',
      approval: { revision: 2, approvedWarningIds: ['w1'] },
      outputs: [{ videoId: 'douyin-1', validationStatus: 'failed', validation: { ok: false } }],
    }),
    approvedWarningIds: ['w1'],
    verificationReport: { ok: false, reports: [{ ok: false, errors: ['bad'] }] },
  });
  assert.ok(verifyFail.some((issue) => issue.id === 'blocking:verification-failed'));
  assert.ok(verifyFail.some((issue) => issue.id === 'info:verification'));
});

test('workflow next actions cover save/approve/invalidate/generate/verify messaging', () => {
  const draft = sampleVariant();
  const draftIssues = summarizeIssues(classifyDouyinIssues({
    variant: draft,
    approvedWarningIds: [],
  }));
  const draftVm = buildDouyinWorkflowViewModel({
    variant: draft,
    approvedWarningIds: [],
    issueSummary: draftIssues,
    draftDirty: false,
  });
  assert.equal(draftVm.nextAction.label, ACTION_LABELS.confirmIssues);
  assert.ok(draftVm.notices.some((line) => line.includes('不会导出最终可发布 MP4')));
  assert.ok(draftVm.notices.some((line) => /保存方案|批准方案|生成输出|验证报告/.test(line)));

  const confirmedSummary = summarizeIssues(classifyDouyinIssues({
    variant: draft,
    approvedWarningIds: ['w1'],
  }));
  const readyToApprove = buildDouyinWorkflowViewModel({
    variant: draft,
    approvedWarningIds: ['w1'],
    issueSummary: confirmedSummary,
  });
  assert.equal(readyToApprove.nextAction.label, '批准当前抖音方案');

  const dirtyApproved = buildDouyinWorkflowViewModel({
    variant: sampleVariant({
      status: 'approved',
      approval: { revision: 2, approvedWarningIds: ['w1'] },
    }),
    approvedWarningIds: ['w1'],
    issueSummary: { unresolvedConfirm: 0, unresolvedBlocking: 0 },
    draftDirty: true,
  });
  assert.equal(dirtyApproved.nextAction.label, '保存方案修改');
  assert.match(dirtyApproved.nextAction.reason, /失效/);
  assert.ok(dirtyApproved.notices.some((line) => line.includes('旧批准') && line.includes('失效')));

  const approved = sampleVariant({
    status: 'approved',
    approval: { revision: 2, approvedWarningIds: ['w1'] },
    plan: {
      selection: [
        { assetId: 'a1', decision: 'selected', reason: '开场清晰' },
      ],
      videos: [{ videoId: 'douyin-1', warnings: [], shots: [{ shotId: 's1', assetId: 'a1' }] }],
    },
  });
  const approvedVm = buildDouyinWorkflowViewModel({
    variant: approved,
    approvedWarningIds: ['w1'],
    issueSummary: summarizeIssues(classifyDouyinIssues({
      variant: approved,
      approvedWarningIds: ['w1'],
    })),
  });
  assert.equal(approvedVm.nextAction.label, '生成预览与 FCP 时间线');
  assert.equal(approvedVm.statusLabel, '已批准');

  const generated = sampleVariant({
    status: 'generated',
    approval: { revision: 2, approvedWarningIds: ['w1'] },
    outputs: [{
      videoId: 'douyin-1',
      validationStatus: 'verified',
      validation: { ok: true },
      artifacts: { preview: 'a.mp4', fcpxml: 'a.fcpxml' },
    }],
    plan: approved.plan,
  });
  const generatedVm = buildDouyinWorkflowViewModel({
    variant: generated,
    issueSummary: summarizeIssues(classifyDouyinIssues({
      variant: generated,
      approvedWarningIds: ['w1'],
    })),
  });
  assert.equal(generatedVm.nextAction.label, '播放预览');
  assert.ok(generatedVm.deliverActions.some((action) => action.label === '查看验证报告'));
  assert.ok(generatedVm.deliverActions.some((action) => action.label === '打开输出目录'));
  assert.ok(generatedVm.deliverActions.some((action) => action.label === '在 Final Cut Pro 中打开'));

  const failed = sampleVariant({
    status: 'generated_with_warnings',
    approval: { revision: 2, approvedWarningIds: ['w1'] },
    outputs: [{ videoId: 'douyin-1', validationStatus: 'failed', validation: { ok: false } }],
    plan: approved.plan,
  });
  const failedVm = buildDouyinWorkflowViewModel({
    variant: failed,
    issueSummary: summarizeIssues(classifyDouyinIssues({
      variant: failed,
      approvedWarningIds: ['w1'],
      verificationReport: { reports: [{ ok: false }] },
    })),
  });
  assert.equal(failedVm.nextAction.label, '查看验证报告');
});

test('output entry labels stay available after generate', () => {
  const vm = buildDouyinWorkflowViewModel({
    variant: sampleVariant({
      status: 'generated',
      approval: { revision: 2, approvedWarningIds: [] },
      outputs: [{ videoId: 'douyin-1', validation: { ok: true } }],
      plan: {
        selection: [{ assetId: 'a1', decision: 'selected', reason: 'ok' }],
        videos: [{ videoId: 'douyin-1', warnings: [], shots: [] }],
      },
    }),
    issueSummary: { unresolvedConfirm: 0, unresolvedBlocking: 0 },
  });
  assert.deepEqual(
    vm.deliverActions.map((action) => action.label),
    ['播放预览', '查看验证报告', '打开输出目录', '在 Final Cut Pro 中打开'],
  );
});

test('empty and error states stay safe', () => {
  assert.doesNotThrow(() => classifyDouyinIssues({}));
  assert.doesNotThrow(() => buildDouyinWorkflowViewModel({}));
  assert.doesNotThrow(() => buildWorkspaceHeader({}));
  assert.doesNotThrow(() => buildCatalogProjectRow({}));

  const emptyIssues = classifyDouyinIssues({ variant: null });
  assert.ok(Array.isArray(emptyIssues));
  const emptyWorkflow = buildDouyinWorkflowViewModel({ variant: null, issueSummary: summarizeIssues(emptyIssues) });
  assert.ok(emptyWorkflow.currentStage);
  assert.ok(emptyWorkflow.nextAction.label);

  const errored = buildWorkspaceHeader({
    result: {
      project: { name: '坏项目', status: 'corrupt', statusLabel: '损坏' },
      error: 'project.json 损坏',
      platformVariants: { variants: [] },
    },
  });
  assert.equal(errored.nextStep.page, 'overview');
  assert.match(errored.nextStep.reason, /损坏|异常/);
});

test('deriveNextStep prefers workflow action when provided', () => {
  const step = deriveNextStep({
    result: {
      project: { name: 'demo', statusLabel: '已验证' },
      platformVariants: { variants: [{ platform: 'douyin', status: 'draft' }] },
    },
    douyinWorkflow: {
      nextAction: { id: 'approve', label: '批准当前抖音方案', reason: '可以批准' },
    },
  });
  assert.equal(step.label, '批准当前抖音方案');
  assert.equal(step.page, 'review');
});

test('renderer state/router stubs manage route transitions', () => {
  PlannerState.reset();
  assert.equal(PlannerState.get().nav, 'pending');

  const router = PlannerRouter.createRouter(PlannerState);
  router.navigate('library');
  assert.equal(PlannerState.get().nav, 'library');

  router.openProject('/tmp/project-a');
  assert.equal(PlannerState.get().nav, 'tasks');
  assert.equal(PlannerState.get().projectPath, '/tmp/project-a');
  assert.equal(PlannerState.get().projectPage, 'overview');

  router.setProjectPage('assets');
  assert.equal(PlannerState.get().projectPage, 'assets');
  assert.equal(PlannerState.get().assetFilter, 'all');

  router.setDouyinStage('preview');
  assert.equal(PlannerState.get().projectPage, 'douyin');
  assert.equal(PlannerState.get().douyinStage, 'preview');

  let seen = null;
  const unsubscribe = PlannerState.subscribe((next) => { seen = next.nav; });
  PlannerState.set({ nav: 'settings' });
  assert.equal(seen, 'settings');
  unsubscribe();
});

test('ipc client wraps injected api and errors clearly when missing', async () => {
  const calls = [];
  const client = createIpcClient({
    readDouyinVariant: async (args) => {
      calls.push(args);
      return { ok: true };
    },
  });
  const result = await client.readDouyinVariant({ projectPath: '/p', variantId: 'douyin' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], { projectPath: '/p', variantId: 'douyin' });

  const missing = createIpcClient({});
  assert.throws(
    () => missing.approveDouyinVariant({}),
    (error) => error.code === 'PLANNER_API_MISSING' && /approveDouyinVariant/.test(error.message),
  );
});

test('utils helpers format values and toast factory works without DOM', () => {
  assert.equal(formatDuration(65.5), '01:05.50');
  assert.equal(formatDuration(Number.NaN), '—');
  assert.ok(formatDateTime('2026-07-01T12:00:00.000Z'));
  assert.equal(
    getUserErrorMessage(new Error("Error invoking remote method 'x': boom\nmore")),
    'boom',
  );
  const toast = { textContent: '', classList: { toggle() {}, remove() {}, add() {} } };
  const showToast = createToastHelper(toast);
  showToast('hello', true);
  assert.equal(toast.textContent, 'hello');
});
