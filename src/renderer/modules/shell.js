(function createPlannerShell(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerShell = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function text(tag, value, className = '') {
    return (root.PlannerUtils || root.PlannerDom).createTextElement(tag, value, className);
  }

  function mount(options = {}) {
    const data = options.data;
    const rootEl = options.root || document.body;
    const router = root.PlannerRouter?.createRouter
      ? root.PlannerRouter.createRouter(data.routeStore)
      : root.PlannerRouter;
    const vm = root.WorkspaceViewModel || root.PlannerViewModels || {};
    const navItems = vm.NAV_ITEMS || [
      { id: 'pending', label: '待处理素材' },
      { id: 'library', label: '项目库' },
      { id: 'tasks', label: '当前任务' },
      { id: 'settings', label: '设置' },
    ];

    const navSidebar = rootEl.querySelector('#navSidebar');
    const versionEl = rootEl.querySelector('#version');
    const views = {
      pending: rootEl.querySelector('#pendingView'),
      library: rootEl.querySelector('#libraryView'),
      tasks: rootEl.querySelector('#tasksView'),
      settings: rootEl.querySelector('#settingsView'),
      workspace: rootEl.querySelector('#workspaceView'),
    };

    if (navSidebar) {
      navSidebar.replaceChildren();
      const brand = document.createElement('div');
      brand.className = 'nav-brand';
      brand.append(
        text('strong', '视频剪辑编排器'),
        text('span', 'v3', 'nav-brand-version'),
      );
      navSidebar.appendChild(brand);
      const list = document.createElement('nav');
      list.className = 'nav-list';
      list.setAttribute('aria-label', '主导航');
      navItems.forEach((item) => {
        const button = text('button', item.label, 'nav-item');
        button.type = 'button';
        button.dataset.nav = item.id;
        button.addEventListener('click', () => {
          data.routeStore.set({ nav: item.id });
          if (item.id === 'library') data.refreshCatalog();
          if (item.id === 'pending') data.refreshPending();
        });
        list.appendChild(button);
      });
      navSidebar.appendChild(list);
      const collapse = text('button', '收起侧栏', 'nav-collapse button ghost');
      collapse.type = 'button';
      collapse.addEventListener('click', () => {
        rootEl.classList.toggle('nav-collapsed');
      });
      navSidebar.appendChild(collapse);
    }

    function syncViews(snap) {
      const route = snap.route;
      // Workspace only while 当前任务 has an open project.
      const showWorkspace = Boolean(route.projectPath) && route.nav === 'tasks';
      const activeNav = route.nav;

      if (navSidebar) {
        navSidebar.querySelectorAll('.nav-item').forEach((button) => {
          button.classList.toggle('active', button.dataset.nav === activeNav);
        });
      }

      Object.entries(views).forEach(([key, el]) => {
        if (!el) return;
        if (key === 'workspace') {
          el.classList.toggle('hidden', !showWorkspace);
          return;
        }
        if (key === 'tasks') {
          const showTasksHome = !showWorkspace && route.nav === 'tasks';
          el.classList.toggle('hidden', !showTasksHome);
          return;
        }
        el.classList.toggle('hidden', route.nav !== key);
      });

      if (versionEl && snap.config?.version) {
        versionEl.textContent = `v${snap.config.version}`;
      } else if (versionEl && !versionEl.dataset.ready) {
        versionEl.textContent = '视频剪辑编排器';
        versionEl.dataset.ready = '1';
      }
    }

    // Mount feature pages once.
    root.PlannerLibraryPage?.mount?.({ data, root: rootEl, router });
    root.PlannerWorkspaceShell?.mount?.({ data, root: rootEl, router });
    root.PlannerPendingPage?.mount?.({ data, root: rootEl, router });
    root.PlannerSettingsPage?.mount?.({ data, root: rootEl, router });
    root.PlannerTasksPage?.mount?.({ data, root: rootEl, router });

    data.subscribe(syncViews);
    syncViews(data.get());

    return { syncViews, router };
  }

  return { mount };
}));
