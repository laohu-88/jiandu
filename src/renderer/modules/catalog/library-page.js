(function createPlannerLibraryPage(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerLibraryPage = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function text(tag, value, className = '') {
    return (root.PlannerDom || root.PlannerUtils).createTextElement(tag, value, className);
  }

  function mount({ data, root: rootEl, router }) {
    const view = rootEl.querySelector('#libraryView');
    if (!view) return;

    function render(snap) {
      if (snap.route.nav !== 'library' || snap.route.sessionOpen) return;
      view.replaceChildren();
      const toolbar = document.createElement('div');
      toolbar.className = 'page-toolbar';
      toolbar.append(
        (() => {
          const box = document.createElement('div');
          box.append(
            text('h2', '项目'),
            text('p', snap.loading.catalog ? '正在读取项目…' : `共 ${data.getCatalogRows().length} 个项目`, 'muted'),
          );
          return box;
        })(),
      );
      const refresh = text('button', '刷新', 'button secondary');
      refresh.type = 'button';
      refresh.addEventListener('click', () => data.refreshCatalog());
      toolbar.appendChild(refresh);
      view.appendChild(toolbar);

      const filters = document.createElement('div');
      filters.className = 'library-filters';
      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = '搜索项目';
      search.value = snap.catalogQuery || '';
      search.addEventListener('input', () => data.patch({ catalogQuery: search.value }));
      const status = document.createElement('select');
      [
        ['all', '全部状态'],
        ['waiting_ai', '等待 AI'],
        ['processing', 'AI 正在处理'],
        ['results_ready', '结果已就绪'],
        ['in_fcp', '已进入 FCP'],
        ['blocked', '真正阻塞'],
      ].forEach(([value, label]) => {
        const option = text('option', label);
        option.value = value;
        option.selected = snap.catalogStatus === value;
        status.appendChild(option);
      });
      status.addEventListener('change', () => data.patch({ catalogStatus: status.value }));
      filters.append(search, status);
      view.appendChild(filters);

      const list = document.createElement('div');
      list.className = 'library-list';
      const rows = data.getCatalogRows();
      if (!rows.length) {
        list.appendChild(text('div', '还没有历史项目。', 'empty-state'));
      }
      rows.forEach((row) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'library-row card-row';
        button.append(
          text('strong', row.name),
          text('p', row.theme || row.projectPath || '', 'muted'),
          text('span', row.userStatusLabel || row.mainStatus, `status-pill status-${row.userStatus || 'waiting_ai'}`),
        );
        button.addEventListener('click', () => {
          const phase = row.userStatus === 'processing' ? 'processing'
            : row.userStatus === 'waiting_ai' ? 'brief'
              : 'results';
          data.openProject(row.projectPath);
          data.routeStore.set({
            sessionOpen: true,
            projectPage: phase,
            workspacePhase: phase,
            platformMode: 'douyin',
          });
        });
        list.appendChild(button);
      });
      view.appendChild(list);
    }

    data.subscribe(render);
    render(data.get());
  }

  return { mount };
}));
