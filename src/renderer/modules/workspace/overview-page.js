(function createPlannerOverviewPage(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerOverviewPage = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function text(tag, value, className = '') {
    return (root.PlannerDom || root.PlannerUtils).createTextElement(tag, value, className);
  }

  function mount({ data, router, pageEl }) {
    if (!pageEl) return;

    function render(snap) {
      if (snap.route.projectPage !== 'overview') return;
      pageEl.replaceChildren();
      const result = snap.projectResult;
      if (!result) {
        pageEl.appendChild(text('div', snap.loading.project ? '加载中…' : '请从项目库打开项目', 'empty-state'));
        return;
      }
      if (result.error) {
        pageEl.appendChild(text('div', result.error, 'notice warning'));
      }

      const grid = root.PlannerDom.createDefinitionGrid([
        ['项目', result.project?.name || '—'],
        ['路径', result.project?.path || snap.route.projectPath || '—'],
        ['状态', result.project?.statusLabel || result.project?.status || '—'],
        ['主题', result.summary?.theme || '—'],
        ['建议标题', result.summary?.recommendedTitle || '—'],
        ['生成时间', root.PlannerUtils.formatDateTime(result.project?.generatedAt)],
        ['验证时间', root.PlannerUtils.formatDateTime(result.project?.verifiedAt)],
        ['抖音变体', String(result.platformVariants?.variants?.filter((v) => v.platform === 'douyin').length || 0)],
      ]);

      const next = snap.workspaceHeader?.nextStep;
      const nextCard = document.createElement('div');
      nextCard.className = 'overview-next';
      nextCard.append(
        text('h3', '下一步'),
        text('p', next?.reason || '暂无建议'),
      );
      if (next?.label) {
        const button = text('button', next.label, 'button primary');
        button.type = 'button';
        button.addEventListener('click', () => {
          if (next.page) router.setProjectPage(next.page);
          if (next.page === 'douyin' && snap.douyinWorkflow?.currentStage) {
            router.setDouyinStage(snap.douyinWorkflow.currentStage);
          }
        });
        nextCard.appendChild(button);
      }

      const issues = snap.issueSummary || {};
      const issueRow = document.createElement('div');
      issueRow.className = 'issue-chips';
      [
        ['blocking', '阻断', issues.blocking],
        ['confirm', '确认', issues.confirm],
        ['suggestion', '建议', issues.suggestion],
        ['info', '信息', issues.info],
      ].forEach(([level, label, count]) => {
        const chip = text('button', `${label} ${count || 0}`, `issue-chip issue-${level}`);
        chip.type = 'button';
        chip.addEventListener('click', () => router.setProjectPage('review'));
        issueRow.appendChild(chip);
      });

      const notices = document.createElement('ul');
      notices.className = 'notice-list';
      (snap.douyinWorkflow?.notices || [
        '「生成」只产出可编辑的预览与 FCP 时间线，不会导出最终可发布 MP4。',
        '最终发布用 MP4 需要在 Final Cut Pro 中完成精剪与导出。',
      ]).forEach((line) => notices.appendChild(text('li', line)));

      pageEl.append(
        root.PlannerDom.createResultSection('项目概览'),
      );
      pageEl.querySelector('.result-section')?.append(grid, issueRow, nextCard, notices);
    }

    data.subscribe(render);
    render(data.get());
  }

  return { mount };
}));
