(function createPlannerLibraryPage(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerLibraryPage = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function text(tag, value, className = '') {
    return (root.PlannerDom || root.PlannerUtils).createTextElement(tag, value, className);
  }

  function issueChips(counts = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'issue-chips';
    [
      ['blocking', '阻断', counts.blocking],
      ['confirm', '确认', counts.confirm],
      ['suggestion', '建议', counts.suggestion],
      ['info', '信息', counts.info],
    ].forEach(([level, label, count]) => {
      const chip = text('span', `${label} ${count || 0}`, `issue-chip issue-${level}`);
      wrap.appendChild(chip);
    });
    return wrap;
  }

  function mount({ data, root: rootEl, router }) {
    const view = rootEl.querySelector('#libraryView');
    if (!view) return;

    function render(snap) {
      const route = snap.route;
      if (route.nav !== 'library' && !(route.projectPath && route.nav === 'tasks')) {
        // Still allow library to keep DOM when hidden
      }
      view.replaceChildren();

      const toolbar = document.createElement('div');
      toolbar.className = 'page-toolbar';
      const titleBox = document.createElement('div');
      titleBox.append(
        text('h2', '项目库'),
        text('p', snap.catalog?.summary
          || (snap.loading.catalog ? '正在扫描项目…' : `共 ${data.getCatalogRows().length} 个项目`), 'muted'),
      );
      const actions = document.createElement('div');
      actions.className = 'toolbar-actions';
      const refresh = text('button', '刷新', 'button secondary');
      refresh.type = 'button';
      refresh.addEventListener('click', () => data.refreshCatalog());
      actions.appendChild(refresh);
      toolbar.append(titleBox, actions);

      const filters = document.createElement('div');
      filters.className = 'library-filters';
      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = '搜索项目名 / 主题 / 路径';
      search.value = snap.catalogQuery || '';
      search.addEventListener('input', () => data.patch({ catalogQuery: search.value }));

      const sort = document.createElement('select');
      [
        ['updatedAt', '最近更新'],
        ['name', '名称'],
        ['issues', '问题优先'],
      ].forEach(([value, label]) => {
        const option = text('option', label);
        option.value = value;
        option.selected = snap.catalogSort === value;
        sort.appendChild(option);
      });
      sort.addEventListener('change', () => data.patch({ catalogSort: sort.value }));

      const status = document.createElement('select');
      [
        ['all', '全部状态'],
        ['ready', '就绪'],
        ['draft', '草稿'],
        ['approved', '已批准'],
        ['generated', '已生成'],
        ['incomplete', '未完成'],
        ['corrupt', '异常'],
      ].forEach(([value, label]) => {
        const option = text('option', label);
        option.value = value;
        option.selected = snap.catalogStatus === value;
        status.appendChild(option);
      });
      status.addEventListener('change', () => data.patch({ catalogStatus: status.value }));
      filters.append(search, sort, status);

      const layout = document.createElement('div');
      layout.className = `library-layout ${snap.libraryCollapsed ? 'collapsed' : ''}`;
      layout.style.setProperty('--library-width', `${snap.libraryWidth || 320}px`);

      const listPane = document.createElement('div');
      listPane.className = 'library-list-pane';
      const list = document.createElement('div');
      list.className = 'library-list';
      const rows = data.getCatalogRows();
      if (!rows.length) {
        list.appendChild(text('div', snap.loading.catalog ? '加载中…' : '尚未发现项目', 'empty-state'));
      }
      rows.forEach((row) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'library-row';
        if (route.projectPath && row.projectPath === route.projectPath) item.classList.add('active');
        const main = document.createElement('div');
        main.className = 'library-row-main';
        main.append(
          text('strong', row.name || '未命名项目'),
          text('span', row.theme || '无主题', 'muted'),
        );
        const meta = document.createElement('div');
        meta.className = 'library-row-meta';
        meta.append(
          text('span', `主成片 ${row.mainStatus || '—'}`, 'status-pill'),
          text('span', `抖音 ${row.douyinStatus || '—'}`, 'status-pill'),
          text('span', root.PlannerUtils?.formatDateTime?.(row.updatedAt) || row.updatedAt || '—', 'muted'),
        );
        item.append(main, meta, issueChips(row.issueCounts));
        item.addEventListener('click', () => data.openProject(row.projectPath));
        list.appendChild(item);
      });
      listPane.appendChild(list);

      const resize = document.createElement('div');
      resize.className = 'library-resizer';
      resize.title = '拖动调整列表宽度';
      resize.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = snap.libraryWidth || 320;
        const move = (moveEvent) => {
          const next = Math.max(220, Math.min(520, startWidth + (moveEvent.clientX - startX)));
          data.patch({ libraryWidth: next });
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });

      const detail = document.createElement('div');
      detail.className = 'library-detail-pane';
      detail.append(
        text('h3', '打开项目进入工作区'),
        text('p', '列表按行展示状态与分级问题计数，避免卡片堆叠。选择一项即可进入概览、主成片与抖音流程。', 'muted'),
      );

      layout.append(listPane, resize, detail);
      view.append(toolbar, filters, layout);

      if (snap.catalog?.error || snap.error && route.nav === 'library') {
        const notice = text('div', snap.catalog?.error || snap.error, 'notice warning');
        view.prepend(notice);
      }
    }

    data.subscribe(render);
    render(data.get());
  }

  return { mount };
}));
