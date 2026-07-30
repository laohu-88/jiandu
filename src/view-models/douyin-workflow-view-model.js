(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DouyinWorkflowViewModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const DOUYIN_STAGES = Object.freeze([
  { id: 'plan', label: '方案规划', shortLabel: '方案' },
  { id: 'issues', label: '问题确认', shortLabel: '问题' },
  { id: 'preview', label: '预览检查', shortLabel: '预览' },
  { id: 'deliver', label: '交付输出', shortLabel: '交付' },
]);

const STATUS_LABELS = Object.freeze({
  draft: '草稿',
  approved: '已批准',
  generated: '已生成',
  generated_with_warnings: '已生成（有警告）',
});

const ACTION_LABELS = Object.freeze({
  saveDraft: '保存方案修改',
  confirmIssues: '确认待处理问题',
  approve: '批准当前抖音方案',
  generate: '生成预览与 FCP 时间线',
  playPreview: '播放预览',
  viewVerification: '查看验证报告',
  openOutputDir: '打开输出目录',
  openInFcp: '在 Final Cut Pro 中打开',
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function emptySummary() {
  return {
    total: 0,
    blocking: 0,
    confirm: 0,
    suggestion: 0,
    info: 0,
    unresolvedBlocking: 0,
    unresolvedConfirm: 0,
    unresolved: 0,
  };
}

function hasPlanContent(variant) {
  const plan = variant?.plan;
  if (!plan) return false;
  return asArray(plan.videos).length > 0 && asArray(plan.selection).length > 0;
}

function hasSelectedAssets(variant) {
  return asArray(variant?.plan?.selection).some((item) => item.decision === 'selected');
}

function isApprovedStatus(status) {
  return ['approved', 'generated', 'generated_with_warnings'].includes(String(status || ''));
}

function outputsOk(variant) {
  const outputs = asArray(variant?.outputs);
  if (!outputs.length) return false;
  return outputs.every((output) => {
    const status = output.validationStatus || (output.validation?.ok === false ? 'failed' : null);
    if (status === 'failed') return false;
    if (output.validation && output.validation.ok === false) return false;
    return true;
  });
}

function buildNotices({ draftDirty, approved }) {
  return [
    '「生成」只产出可编辑的预览与 FCP 时间线，不会导出最终可发布 MP4。',
    '最终发布用 MP4 需要在 Final Cut Pro 中完成精剪与导出。',
    '保存方案、批准方案、生成输出、验证报告是四个不同步骤，请按顺序操作。',
    approved || draftDirty
      ? '批准后若再保存方案修改，旧批准与已生成输出将失效，需重新确认并批准。'
      : '保存草稿不会自动批准；批准后才能生成预览与 FCP 时间线。',
  ];
}

function makeAction(id, extras = {}) {
  return {
    id,
    label: ACTION_LABELS[id] || id,
    reason: extras.reason || '',
    blocked: Boolean(extras.blocked),
    blockReason: extras.blockReason || null,
    resolveHint: extras.resolveHint || null,
  };
}

function resolveNextAction({
  variant,
  draftDirty,
  issueSummary,
  planReady,
  approved,
  hasOutputs,
  verificationOk,
}) {
  const status = String(variant?.status || 'draft');
  const unresolvedConfirm = Number(issueSummary?.unresolvedConfirm || 0);
  const unresolvedBlocking = Number(issueSummary?.unresolvedBlocking || 0);
  // Synthetic generation-gate "no approval" should not steal the approve CTA.
  const structuralBlocking = unresolvedBlocking > 0
    && unresolvedConfirm === 0
    && !approved
    && unresolvedBlocking === 1
    && status === 'draft';

  if (draftDirty && (approved || asArray(variant?.previousOutputs).length > 0 || variant?.approval)) {
    return makeAction('saveDraft', {
      reason: '方案已修改，保存后旧批准与输出将失效。',
      blocked: false,
      resolveHint: '先保存方案，再重新确认警告并批准。',
    });
  }

  if (draftDirty && !approved) {
    return makeAction('saveDraft', {
      reason: '方案有未保存修改。',
      blocked: false,
      resolveHint: '保存后再确认问题并批准。',
    });
  }

  if (unresolvedConfirm > 0) {
    return makeAction('confirmIssues', {
      reason: `还有 ${unresolvedConfirm} 条待确认警告。`,
      blocked: false,
      resolveHint: '在问题中心勾选确认后才能批准。',
    });
  }

  if (!planReady || (unresolvedBlocking > 0 && !approved && !structuralBlocking && unresolvedConfirm === 0)) {
    // Structural blockers (empty videos / missing reasons / invalidated approval).
    if (unresolvedBlocking > 0 && !approved) {
      const onlyNoApproval = unresolvedBlocking === 1;
      if (!onlyNoApproval) {
        return makeAction('confirmIssues', {
          reason: '仍有阻断问题需要处理。',
          blocked: false,
          resolveHint: '先处理阻断问题，再批准方案。',
        });
      }
    }
  }

  if (!approved) {
    const blocked = !planReady || unresolvedConfirm > 0;
    return makeAction('approve', {
      reason: blocked ? '方案未就绪，暂不可批准。' : '确认警告后批准当前抖音方案。',
      blocked,
      blockReason: blocked
        ? (!planReady ? '方案缺少成片或选材。' : '仍有待确认警告。')
        : null,
      resolveHint: blocked ? '完善方案并确认全部警告。' : '批准后即可生成预览与 FCP 时间线。',
    });
  }

  if (!hasOutputs) {
    return makeAction('generate', {
      reason: '方案已批准，可生成预览与 FCP 时间线。',
      blocked: false,
      resolveHint: '生成不会导出最终发布 MP4。',
    });
  }

  if (!verificationOk) {
    return makeAction('viewVerification', {
      reason: '输出已生成但验证未通过。',
      blocked: false,
      resolveHint: '查看验证报告并修复后重新生成。',
    });
  }

  return makeAction('playPreview', {
    reason: '预览与时间线已就绪，可播放预览或打开 FCP。',
    blocked: false,
    resolveHint: '也可打开输出目录或在 Final Cut Pro 中打开。',
  });
}

function stageStatus(id, {
  planComplete,
  issuesComplete,
  previewComplete,
  deliverComplete,
  currentStage,
}) {
  const order = DOUYIN_STAGES.map((stage) => stage.id);
  const currentIndex = order.indexOf(currentStage);
  const index = order.indexOf(id);
  const completeMap = {
    plan: planComplete,
    issues: issuesComplete,
    preview: previewComplete,
    deliver: deliverComplete,
  };

  if (completeMap[id]) return 'complete';
  if (id === currentStage) return 'current';
  if (index < currentIndex && !completeMap[id]) return 'blocked';
  if (index > currentIndex) {
    // Earlier required stage incomplete → later stages blocked.
    if (id === 'issues' && !planComplete) return 'blocked';
    if (id === 'preview' && !planComplete) return 'blocked';
    if (id === 'deliver' && !planComplete) return 'blocked';
    return 'upcoming';
  }
  return 'upcoming';
}

function suggestCurrentStage({
  planComplete,
  issuesComplete,
  previewComplete,
  deliverComplete,
  hasOutputs,
  approved,
}) {
  if (!planComplete) return 'plan';
  if (!issuesComplete) return 'issues';
  if (approved && hasOutputs && !deliverComplete) return 'deliver';
  if (approved && !hasOutputs) return 'preview';
  if (previewComplete && !deliverComplete) return deliverComplete ? 'deliver' : (hasOutputs ? 'deliver' : 'preview');
  if (deliverComplete) return 'deliver';
  return 'preview';
}

function buildDouyinWorkflowViewModel({
  variant = null,
  approvedWarningIds = [],
  issueSummary = null,
  draftDirty = false,
} = {}) {
  void approvedWarningIds;
  const summary = issueSummary || emptySummary();
  const planReady = hasPlanContent(variant) && hasSelectedAssets(variant);
  const planComplete = planReady;
  const approved = isApprovedStatus(variant?.status) && Boolean(variant?.approval);
  const hasOutputs = asArray(variant?.outputs).length > 0;
  const verificationOk = hasOutputs && outputsOk(variant);
  // Issues are complete when confirms are cleared and the only remaining
  // unresolved blocking (if any) is the synthetic no-approval gate — or none.
  const issuesComplete = summary.unresolvedConfirm === 0
    && (
      summary.unresolvedBlocking === 0
      || (!approved && summary.unresolvedBlocking <= 1 && planComplete)
    );
  const previewComplete = planComplete;
  const deliverComplete = hasOutputs && verificationOk;

  const currentStage = suggestCurrentStage({
    planComplete,
    issuesComplete: issuesComplete && (approved || summary.unresolvedBlocking === 0),
    previewComplete,
    deliverComplete,
    hasOutputs,
    approved,
  });

  // Prefer staying on issues until confirms/structural blockers cleared;
  // after that, prefer approve before leaving issues.
  let resolvedCurrent = currentStage;
  if (!planComplete) resolvedCurrent = 'plan';
  else if (summary.unresolvedConfirm > 0) resolvedCurrent = 'issues';
  else if (!approved && summary.unresolvedBlocking > 1) resolvedCurrent = 'issues';
  else if (!approved) resolvedCurrent = 'issues';
  else if (!hasOutputs) resolvedCurrent = 'preview';
  else resolvedCurrent = 'deliver';

  const stages = DOUYIN_STAGES.map((stage) => {
    const status = stageStatus(stage.id, {
      planComplete,
      issuesComplete: approved ? (summary.unresolvedConfirm === 0 && summary.unresolvedBlocking === 0) : issuesComplete,
      previewComplete,
      deliverComplete,
      currentStage: resolvedCurrent,
    });
    const summaries = {
      plan: planComplete ? '已有成片与选材' : '待完善方案与选材',
      issues: summary.unresolvedConfirm || (!approved && summary.unresolvedBlocking > 1)
        ? `待处理 ${summary.unresolvedConfirm + Math.max(0, summary.unresolvedBlocking - (approved ? 0 : 1))} 项`
        : (approved ? '问题已确认' : '待批准'),
      preview: hasOutputs ? '预览可用' : (planComplete ? '可预览方案布局' : '等待方案'),
      deliver: deliverComplete ? '输出与验证完成' : (hasOutputs ? '输出待验证' : '尚未生成输出'),
    };
    return {
      id: stage.id,
      label: stage.label,
      status: stage.id === resolvedCurrent && status === 'complete' ? 'current' : status,
      summary: summaries[stage.id],
    };
  });

  // Ensure exactly one current.
  let sawCurrent = false;
  for (const stage of stages) {
    if (stage.id === resolvedCurrent) {
      stage.status = 'current';
      sawCurrent = true;
    } else if (stage.status === 'current') {
      stage.status = 'upcoming';
    }
  }
  if (!sawCurrent && stages[0]) stages[0].status = 'current';

  const nextAction = resolveNextAction({
    variant,
    draftDirty,
    issueSummary: summary,
    planReady,
    approved,
    hasOutputs,
    verificationOk,
  });

  return {
    stages,
    currentStage: resolvedCurrent,
    nextAction,
    notices: buildNotices({ draftDirty, approved }),
    statusLabel: STATUS_LABELS[variant?.status] || String(variant?.status || '未知'),
    deliverActions: hasOutputs
      ? [
        makeAction('playPreview', { reason: '播放粗剪预览' }),
        makeAction('viewVerification', { reason: '查看验证报告' }),
        makeAction('openOutputDir', { reason: '打开输出目录' }),
        makeAction('openInFcp', { reason: '在 Final Cut Pro 中打开时间线' }),
      ]
      : [],
  };
}

  return {
    DOUYIN_STAGES,
    ACTION_LABELS,
    STATUS_LABELS,
    buildDouyinWorkflowViewModel,
  };
}));
