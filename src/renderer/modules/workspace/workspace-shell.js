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
    const tabs = workspace.querySelector('#projectTabs');
    const pages = {
      overview: workspace.querySelector('#pageOverview'),
      main: workspace.querySelector('#pageMain'),
      douyin: workspace.querySelector('#pageDouyin'),
      assets: workspace.querySelector('#pageAssets'),
      review: workspace.querySelector('#pageReview'),
      outputs: workspace.querySelector('#pageOutputs'),
    };

    const vm = root.WorkspaceViewModel || root.PlannerViewModels || {};
    const projectPages = vm.PROJECT_PAGES || [
      { id: 'overview', label: '概览' },
      { id: 'main', label: '主成片' },
      { id: 'douyin', label: '抖音版本' },
      { id: 'assets', label: '素材' },
      { id: 'review', label: '问题与审核' },
      { id: 'outputs', label: '输出结果' },
    ];

    if (tabs) {
      tabs.replaceChildren();
      projectPages.forEach((page) => {
        const button = text('button', page.label, 'project-tab');
        button.type = 'button';
        button.dataset.page = page.id;
        button.addEventListener('click', () => router.setProjectPage(page.id));
        tabs.appendChild(button);
      });
    }

    root.PlannerOverviewPage?.mount?.({ data, root: rootEl, router, pageEl: pages.overview });
    root.PlannerMainFilmPage?.mount?.({ data, root: rootEl, router, pageEl: pages.main });
    root.PlannerDouyinPage?.mount?.({ data, root: rootEl, router, pageEl: pages.douyin });
    root.PlannerAssetsPage?.mount?.({ data, root: rootEl, router, pageEl: pages.assets });
    root.PlannerReviewPage?.mount?.({ data, root: rootEl, router, pageEl: pages.review });
    root.PlannerOutputsPage?.mount?.({ data, root: rootEl, router, pageEl: pages.outputs });

    function renderHeader(snap) {
      if (!header) return;
      const info = snap.workspaceHeader;
      header.replaceChildren();
      if (!info) {
        header.appendChild(text('p', snap.loading.project ? '正在加载项目…' : '未打开项目', 'muted'));
        return;
      }
      const left = document.createElement('div');
      left.className = 'workspace-header-main';
      left.append(
        text('h2', info.name),
        text('p', info.theme || '无主题', 'muted'),
      );
      const meta = document.createElement('div');
      meta.className = 'workspace-header-meta';
      meta.append(
        text('span', `状态 ${info.status}`, 'status-pill'),
        text('span', `主成片 ${info.mainFilmStatus}`, 'status-pill'),
        text('span', `抖音 ${info.platformStatus}`, 'status-pill'),
        text('span', `最近操作 ${root.PlannerUtils?.formatDateTime?.(info.lastOperation) || info.lastOperation || '—'}`, 'muted'),
      );
      const right = document.createElement('div');
      right.className = 'workspace-header-actions';
      const next = text('button', info.nextStep?.label || '下一步', 'button primary');
      next.type = 'button';
      next.title = info.nextStep?.reason || '';
      next.addEventListener('click', () => {
        if (info.nextStep?.page) router.setProjectPage(info.nextStep.page);
      });
      const back = text('button', '返回项目库', 'button ghost');
      back.type = 'button';
      back.addEventListener('click', () => data.closeProject());
      right.append(next, back);
      header.append(left, meta, right);
    }

    function syncPages(snap) {
      const page = snap.route.projectPage || 'overview';
      if (tabs) {
        tabs.querySelectorAll('.project-tab').forEach((button) => {
          button.classList.toggle('active', button.dataset.page === page);
        });
      }
      Object.entries(pages).forEach(([id, el]) => {
        if (!el) return;
        el.classList.toggle('hidden', id !== page);
      });
      renderHeader(snap);
    }

    data.subscribe(syncPages);
    syncPages(data.get());
  }

  return { mount };
}));
