(function createPlannerReviewPage(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerReviewPage = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function text(tag, value, className = '') {
    return (root.PlannerDom || root.PlannerUtils).createTextElement(tag, value, className);
  }

  function mount({ data, router, pageEl }) {
    if (!pageEl) return;

    function render(snap) {
      if (snap.route.projectPage !== 'review') return;
      pageEl.replaceChildren();
      const issues = snap.issues || [];
      const summary = snap.issueSummary || {};
      const filters = snap.route.issueFilters || {};

      const toolbar = document.createElement('div');
      toolbar.className = 'page-toolbar';
      toolbar.append(
        text('h2', '问题与审核'),
        text('p', `共 ${summary.total || 0} · 阻断 ${summary.blocking || 0} · 确认 ${summary.confirm || 0} · 建议 ${summary.suggestion || 0} · 信息 ${summary.info || 0}`, 'muted'),
      );

      const filterBar = document.createElement('div');
      filterBar.className = 'review-filters';
      const levels = ['blocking', 'confirm', 'suggestion', 'info'];
      levels.forEach((level) => {
        const label = text('label', '', 'filter-check');
        const input = document.createElement('input');
        input.type = 'checkbox';
        const active = !filters.levels || filters.levels.includes(level);
        input.checked = active;
        input.addEventListener('change', () => {
          const current = new Set(filters.levels || levels);
          if (input.checked) current.add(level);
          else current.delete(level);
          data.routeStore.set({
            issueFilters: { ...filters, levels: [...current] },
          });
        });
        label.append(input, text('span', level));
        filterBar.appendChild(label);
      });
      const unresolved = text('label', '', 'filter-check');
      const unresolvedInput = document.createElement('input');
      unresolvedInput.type = 'checkbox';
      unresolvedInput.checked = Boolean(filters.unresolvedOnly);
      unresolvedInput.addEventListener('change', () => {
        data.routeStore.set({
          issueFilters: { ...filters, unresolvedOnly: unresolvedInput.checked },
        });
      });
      unresolved.append(unresolvedInput, text('span', '仅未解决'));
      filterBar.appendChild(unresolved);

      const recheck = text('button', '重新检查', 'button secondary');
      recheck.type = 'button';
      recheck.addEventListener('click', () => data.refreshProject());
      filterBar.appendChild(recheck);

      const vm = root.IssueCenterViewModel || root.PlannerViewModels || {};
      const filtered = vm.filterIssues
        ? vm.filterIssues(issues, filters)
        : issues;
      const groups = vm.groupIssuesByLevel
        ? vm.groupIssuesByLevel(filtered)
        : { blocking: [], confirm: [], suggestion: [], info: [] };

      const list = document.createElement('div');
      list.className = 'review-list';
      levels.forEach((level) => {
        const group = document.createElement('section');
        group.className = `review-group level-${level}`;
        group.appendChild(text('h3', `${level} · ${(groups[level] || []).length}`));
        (groups[level] || []).forEach((issue) => {
          const row = document.createElement('article');
          row.className = `review-row ${issue.resolved ? 'resolved' : ''}`;
          row.append(
            text('strong', issue.message),
            text('small', [
              issue.videoId && `视频 ${issue.videoId}`,
              issue.shotId && `镜头 ${issue.shotId}`,
              issue.assetId && `素材 ${issue.assetId}`,
              issue.type,
              issue.resolved ? '已解决' : '未解决',
            ].filter(Boolean).join(' · '), 'muted'),
          );
          const actions = document.createElement('div');
          actions.className = 'result-actions';
          if (issue.level === 'confirm' && issue.warningId && !issue.resolved) {
            const confirmOne = text('button', '确认此问题', 'button secondary');
            confirmOne.type = 'button';
            confirmOne.addEventListener('click', () => {
              const ids = new Set(snap.approvedWarningIds || []);
              ids.add(issue.warningId);
              data.setApprovedWarningIds([...ids]);
            });
            actions.appendChild(confirmOne);
          }
          if (issue.level === 'confirm' && issue.type) {
            const batch = text('button', '批量确认同类型', 'button ghost');
            batch.type = 'button';
            batch.addEventListener('click', () => {
              const ids = new Set(snap.approvedWarningIds || []);
              issues.filter((item) => item.level === 'confirm' && item.type === issue.type && item.warningId)
                .forEach((item) => ids.add(item.warningId));
              data.setApprovedWarningIds([...ids]);
            });
            actions.appendChild(batch);
          }
          const jump = text('button', '跳转', 'button ghost');
          jump.type = 'button';
          jump.addEventListener('click', () => {
            const target = issue.jumpTarget || {};
            if (target.page === 'douyin' || target.kind === 'shot' || target.kind === 'video') {
              router.setDouyinStage('preview');
              if (target.shotId || target.videoId) {
                data.patch({
                  douyinPreview: {
                    variantId: snap.douyinVariant?.variantId,
                    videoId: target.videoId,
                    shotId: target.shotId,
                    beforeCrop: false,
                  },
                });
              }
            } else if (target.page === 'assets' || target.kind === 'asset') {
              router.setProjectPage('assets');
              if (target.assetId) data.patch({ selectedAssetId: target.assetId });
            } else if (target.page) {
              router.setProjectPage(target.page);
            }
          });
          actions.appendChild(jump);
          row.appendChild(actions);
          group.appendChild(row);
        });
        list.appendChild(group);
      });

      pageEl.append(toolbar, filterBar, list);
    }

    data.subscribe(render);
    render(data.get());
  }

  return { mount };
}));
