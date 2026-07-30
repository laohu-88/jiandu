(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IssueCenterViewModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ISSUE_LEVELS = Object.freeze(['blocking', 'confirm', 'suggestion', 'info']);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asSet(ids) {
  return new Set(asArray(ids).map(String).filter(Boolean));
}

function makeIssue(partial) {
  const level = ISSUE_LEVELS.includes(partial.level) ? partial.level : 'info';
  const jumpTarget = partial.jumpTarget && typeof partial.jumpTarget === 'object'
    ? {
      kind: partial.jumpTarget.kind || 'page',
      videoId: partial.jumpTarget.videoId ?? partial.videoId ?? null,
      shotId: partial.jumpTarget.shotId ?? partial.shotId ?? null,
      assetId: partial.jumpTarget.assetId ?? partial.assetId ?? null,
      page: partial.jumpTarget.page ?? null,
    }
    : { kind: 'page', page: 'review' };

  return {
    id: String(partial.id),
    level,
    message: String(partial.message || '').trim() || '未命名问题',
    videoId: partial.videoId ?? null,
    shotId: partial.shotId ?? null,
    assetId: partial.assetId ?? null,
    warningId: partial.warningId ?? null,
    type: partial.type ?? null,
    source: partial.source || 'state',
    resolved: Boolean(partial.resolved),
    jumpTarget,
  };
}

function planOf(variant) {
  return variant?.plan && typeof variant.plan === 'object' ? variant.plan : null;
}

function classifyPlanWarnings(plan, approvedIds) {
  const issues = [];
  for (const video of asArray(plan?.videos)) {
    for (const warning of asArray(video.warnings)) {
      const warningId = String(warning.warningId || '');
      const assetId = warning.assetId ? String(warning.assetId) : null;
      issues.push(makeIssue({
        id: `confirm:${warningId || `${video.videoId}:warning`}`,
        level: 'confirm',
        message: String(warning.message || '').trim() || `需要确认警告 ${warningId}`,
        videoId: video.videoId || null,
        assetId,
        warningId: warningId || null,
        type: warning.type || null,
        source: 'plan-warning',
        resolved: warningId ? approvedIds.has(warningId) : false,
        jumpTarget: {
          kind: assetId ? 'asset' : 'video',
          videoId: video.videoId || null,
          assetId,
          page: 'review',
        },
      }));
    }
  }
  return issues;
}

function classifyStructuralBlocking(plan) {
  const issues = [];
  const videos = asArray(plan?.videos);
  const selection = asArray(plan?.selection);

  if (!plan || videos.length === 0) {
    issues.push(makeIssue({
      id: 'blocking:empty-videos',
      level: 'blocking',
      message: '抖音方案没有成片，无法继续批准或生成。',
      source: 'state',
      resolved: false,
      jumpTarget: { kind: 'page', page: 'douyin' },
    }));
  }

  const selected = selection.filter((item) => item.decision === 'selected');
  if (!plan || selected.length === 0) {
    issues.push(makeIssue({
      id: 'blocking:no-selected-assets',
      level: 'blocking',
      message: '没有选中任何素材，请至少选择一条可用素材。',
      source: 'state',
      resolved: false,
      jumpTarget: { kind: 'page', page: 'assets' },
    }));
  }

  for (const item of selection) {
    if (!String(item.reason || '').trim()) {
      issues.push(makeIssue({
        id: `blocking:missing-reason:${item.assetId || 'unknown'}`,
        level: 'blocking',
        message: `素材 ${item.assetId || '未知'} 缺少选用/排除理由。`,
        assetId: item.assetId || null,
        source: 'state',
        resolved: false,
        jumpTarget: {
          kind: 'asset',
          assetId: item.assetId || null,
          page: 'assets',
        },
      }));
    }
  }

  return issues;
}

function classifyApprovalInvalidation(variant) {
  const issues = [];
  if (!variant) return issues;

  const approval = variant.approval;
  const status = String(variant.status || '');
  const previousOutputs = asArray(variant.previousOutputs);
  const revision = Number(variant.revision);
  const approvalRevision = approval ? Number(approval.revision) : null;

  const hashMismatch = Boolean(
    approval
    && (
      (approval.planHash && variant.planHash && approval.planHash !== variant.planHash)
      || (approval.actualPlanHash && approval.planHash && approval.actualPlanHash !== approval.planHash)
      || (Number.isFinite(approvalRevision) && Number.isFinite(revision) && approvalRevision !== revision)
    ),
  );
  const invalidated = Boolean(variant.approvalStale)
    || Boolean(variant.invalidatedApproval)
    || (status === 'draft' && previousOutputs.length > 0)
    || hashMismatch;

  if (invalidated) {
    issues.push(makeIssue({
      id: 'blocking:approval-invalidated',
      level: 'blocking',
      message: '方案在批准后已变更，旧批准与输出已失效，请重新确认警告并再次批准。',
      source: 'state',
      resolved: false,
      jumpTarget: { kind: 'page', page: 'review' },
    }));
  }

  return issues;
}

function classifyGenerationGate(variant, confirmIssues) {
  const issues = [];
  const status = String(variant?.status || 'draft');
  const approved = ['approved', 'generated', 'generated_with_warnings'].includes(status)
    && Boolean(variant?.approval);
  const unresolvedConfirms = confirmIssues.filter((issue) => !issue.resolved);

  // Generation gate: unconfirmed warnings block generate/approve path.
  if (unresolvedConfirms.length > 0) {
    issues.push(makeIssue({
      id: 'blocking:unconfirmed-warnings',
      level: 'blocking',
      message: `仍有 ${unresolvedConfirms.length} 条待确认警告，批准与生成前必须全部确认。`,
      source: 'state',
      resolved: false,
      jumpTarget: { kind: 'page', page: 'review' },
    }));
  }

  // No approval blocks generate (resolved once approved/generated).
  issues.push(makeIssue({
    id: 'blocking:no-approval',
    level: 'blocking',
    message: '尚未批准当前抖音方案，不能生成预览与 FCP 时间线。',
    source: 'state',
    resolved: approved,
    jumpTarget: { kind: 'page', page: 'review' },
  }));

  return issues;
}

function classifyInfo(variant, verificationReport) {
  const issues = [];
  const status = String(variant?.status || 'draft');
  const revision = variant?.revision ?? null;
  const outputs = asArray(variant?.outputs);
  const approval = variant?.approval;

  issues.push(makeIssue({
    id: 'info:approval-status',
    level: 'info',
    message: approval
      ? `批准状态：已批准（revision ${approval.revision ?? revision ?? '—'}）`
      : `批准状态：未批准（当前 ${status}）`,
    source: 'state',
    resolved: true,
    jumpTarget: { kind: 'page', page: 'overview' },
  }));

  issues.push(makeIssue({
    id: 'info:revision',
    level: 'info',
    message: `当前方案 revision：${revision ?? '—'}`,
    source: 'state',
    resolved: true,
    jumpTarget: { kind: 'page', page: 'douyin' },
  }));

  issues.push(makeIssue({
    id: 'info:outputs',
    level: 'info',
    message: outputs.length
      ? `已生成输出 ${outputs.length} 条`
      : '尚未生成预览与 FCP 时间线输出',
    source: 'state',
    resolved: true,
    jumpTarget: { kind: 'page', page: 'outputs' },
  }));

  const reports = verificationReport
    ? asArray(verificationReport.reports || verificationReport.results || [verificationReport])
    : outputs.map((output) => output.validation || null).filter(Boolean);

  if (reports.length || outputs.length) {
    const failed = reports.filter((report) => report && report.ok === false);
    const allOk = reports.length > 0 && failed.length === 0;
    if (outputs.length && failed.length) {
      issues.push(makeIssue({
        id: 'blocking:verification-failed',
        level: 'blocking',
        message: `输出已存在但验证失败（${failed.length}/${reports.length}）。`,
        source: 'verification',
        resolved: false,
        jumpTarget: { kind: 'page', page: 'outputs' },
      }));
    }
    issues.push(makeIssue({
      id: 'info:verification',
      level: 'info',
      message: reports.length === 0
        ? '尚无验证报告'
        : (allOk ? `验证通过（${reports.length}）` : `验证摘要：失败 ${failed.length} / 共 ${reports.length}`),
      source: 'verification',
      resolved: true,
      jumpTarget: { kind: 'page', page: 'outputs' },
    }));
  } else {
    issues.push(makeIssue({
      id: 'info:verification',
      level: 'info',
      message: '尚无验证报告',
      source: 'verification',
      resolved: true,
      jumpTarget: { kind: 'page', page: 'outputs' },
    }));
  }

  return issues;
}

function classifySuggestions(readabilityFindings) {
  return asArray(readabilityFindings).map((finding, index) => makeIssue({
    id: `suggestion:readability:${finding.shotId || finding.assetId || finding.videoId || index}`,
    level: 'suggestion',
    message: String(finding.message || '').trim() || '布局可读性提示',
    videoId: finding.videoId ?? null,
    shotId: finding.shotId ?? null,
    assetId: finding.assetId ?? null,
    source: 'suggestion',
    resolved: false,
    jumpTarget: {
      kind: finding.shotId ? 'shot' : (finding.assetId ? 'asset' : (finding.videoId ? 'video' : 'page')),
      videoId: finding.videoId ?? null,
      shotId: finding.shotId ?? null,
      assetId: finding.assetId ?? null,
      page: 'douyin',
    },
  }));
}

function classifyDouyinIssues({
  variant = null,
  approvedWarningIds = [],
  readabilityFindings = [],
  verificationReport = null,
} = {}) {
  const approvedIds = asSet(
    approvedWarningIds.length
      ? approvedWarningIds
      : variant?.approval?.approvedWarningIds,
  );
  const plan = planOf(variant);
  const confirmIssues = classifyPlanWarnings(plan, approvedIds);
  const issues = [
    ...classifyStructuralBlocking(plan),
    ...classifyApprovalInvalidation(variant),
    ...confirmIssues,
    ...classifyGenerationGate(variant, confirmIssues),
    ...classifySuggestions(readabilityFindings),
    ...classifyInfo(variant, verificationReport),
  ];

  // De-dupe by id, keep first.
  const seen = new Set();
  return issues.filter((issue) => {
    if (seen.has(issue.id)) return false;
    seen.add(issue.id);
    return true;
  });
}

function summarizeIssues(issues) {
  const list = asArray(issues);
  const count = (level) => list.filter((issue) => issue.level === level).length;
  const unresolved = list.filter((issue) => (
    (issue.level === 'blocking' || issue.level === 'confirm') && !issue.resolved
  ));
  return {
    total: list.length,
    blocking: count('blocking'),
    confirm: count('confirm'),
    suggestion: count('suggestion'),
    info: count('info'),
    unresolvedBlocking: list.filter((issue) => issue.level === 'blocking' && !issue.resolved).length,
    unresolvedConfirm: list.filter((issue) => issue.level === 'confirm' && !issue.resolved).length,
    unresolved: unresolved.length,
  };
}

function filterIssues(issues, {
  levels,
  videoId,
  shotId,
  assetId,
  unresolvedOnly = false,
} = {}) {
  const levelSet = levels ? new Set(asArray(levels)) : null;
  return asArray(issues).filter((issue) => {
    if (levelSet && !levelSet.has(issue.level)) return false;
    if (videoId != null && issue.videoId !== videoId) return false;
    if (shotId != null && issue.shotId !== shotId) return false;
    if (assetId != null && issue.assetId !== assetId) return false;
    if (unresolvedOnly && issue.resolved) return false;
    if (unresolvedOnly && issue.level !== 'blocking' && issue.level !== 'confirm') return false;
    return true;
  });
}

function groupIssuesByLevel(issues) {
  const groups = {
    blocking: [],
    confirm: [],
    suggestion: [],
    info: [],
  };
  for (const issue of asArray(issues)) {
    if (groups[issue.level]) groups[issue.level].push(issue);
  }
  return groups;
}

  return {
    ISSUE_LEVELS,
    classifyDouyinIssues,
    summarizeIssues,
    filterIssues,
    groupIssuesByLevel,
  };
}));
