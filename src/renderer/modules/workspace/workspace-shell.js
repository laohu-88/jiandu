(function createPlannerWorkspaceShell(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerWorkspaceShell = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function text(tag, value, className = '') {
    return (root.PlannerDom || root.PlannerUtils).createTextElement(tag, value, className);
  }

  function mount({ data, root: rootEl, router }) {
    const workspace = rootEl.querySelector('#workspaceView');
    if (!workspace) return;
    const header = workspace.querySelector('#workspaceHeader');
    const pages = {
      brief: workspace.querySelector('#pageBrief'),
      processing: workspace.querySelector('#pageProcessing'),
      results: workspace.querySelector('#pageResults'),
      advanced: workspace.querySelector('#pageAdvanced'),
    };

    root.PlannerOverviewPage?.mount?.({ data, root: rootEl, router, pageEl: workspace.querySelector('#pageOverview') });
    root.PlannerMainFilmPage?.mount?.({ data, root: rootEl, router, pageEl: workspace.querySelector('#pageMain') });
    root.PlannerDouyinPage?.mount?.({ data, root: rootEl, router, pageEl: workspace.querySelector('#pageDouyin') });
    root.PlannerAssetsPage?.mount?.({ data, root: rootEl, router, pageEl: workspace.querySelector('#pageAssets') });
    root.PlannerReviewPage?.mount?.({ data, root: rootEl, router, pageEl: workspace.querySelector('#pageReview') });
    root.PlannerOutputsPage?.mount?.({ data, root: rootEl, router, pageEl: workspace.querySelector('#pageOutputs') });

    function renderHeader(snap) {
      if (!header) return;
      const info = snap.workspaceHeader;
      header.replaceChildren();
      const left = document.createElement('div');
      left.className = 'workspace-header-main';
      left.append(text('h2', info?.name || snap.currentEpisode?.name || '剪辑工作区'));
      const meta = document.createElement('div');
      meta.className = 'workspace-header-meta';
      const mode = text('button', info?.platformModeLabel || (snap.route.platformMode === 'main' ? '完整成片' : '抖音'), 'status-pill');
      mode.type = 'button';
      mode.addEventListener('click', () => {
        const next = snap.route.platformMode === 'main' ? 'douyin' : 'main';
        data.routeStore.set({ platformMode: next });
      });
      const engine = text('button', info?.engineLabel || (snap.route.engine === 'codex' ? 'Codex' : 'Cursor'), 'status-pill');
      engine.type = 'button';
      const task = snap.runningOverlays?.handoffTask;
      const locked = ['handed_off', 'running'].includes(task?.lifecycle);
      engine.disabled = Boolean(locked);
      if (locked) engine.title = '处理中不可切换 Agent，请先取消任务';
      engine.addEventListener('click', () => {
        if (engine.disabled) return;
        const next = snap.route.engine === 'codex' ? 'cursor_agent' : 'codex';
        data.routeStore.set({ engine: next });
      });
      meta.append(
        mode,
        engine,
        text('span', info?.status || '准备开始', 'status-pill'),
      );
      const back = text('button', '返回项目列表', 'button ghost');
      back.type = 'button';
      back.addEventListener('click', () => data.closeProject());
      header.append(left, meta, back);
    }

    function syncPages(snap) {
      if (!snap.route.sessionOpen) return;
      let phase = snap.route.workspacePhase || snap.route.projectPage || 'brief';
      if (snap.runningOverlays?.handoffTask && !['results', 'advanced', 'revise'].includes(phase)) {
        const status = snap.runningOverlays.handoffTask.status;
        if (['completed', 'completed_with_warnings', 'failed'].includes(status)) phase = 'results';
        else if (status === 'cancelled') phase = 'brief';
        else if (!['draft', 'ready'].includes(status)) phase = 'processing';
      }
      Object.entries(pages).forEach(([id, el]) => {
        if (!el) return;
        el.classList.toggle('hidden', id !== phase && !(phase === 'revise' && id === 'brief'));
      });
      renderHeader(snap);
    }

    data.subscribe(syncPages);
    syncPages(data.get());
  }

  return { mount };
}));
