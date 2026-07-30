(function createPlannerAssetsPage(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerAssetsPage = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function text(tag, value, className = '') {
    return (root.PlannerDom || root.PlannerUtils).createTextElement(tag, value, className);
  }

  function mount({ data, pageEl }) {
    if (!pageEl) return;

    function decisionsFrom(snap) {
      const selection = snap.draftPlan?.selection || snap.douyinVariant?.plan?.selection || [];
      const map = new Map(selection.map((item) => [item.assetId, item]));
      const assets = snap.douyinVariant?.assets
        || snap.projectResult?.assets
        || [];
      return assets.map((asset) => ({
        asset,
        decision: map.get(asset.assetId)?.decision || map.get(asset.stableId)?.decision || 'all',
        reason: map.get(asset.assetId)?.reason || map.get(asset.stableId)?.reason || '',
        assetId: asset.assetId || asset.stableId,
      }));
    }

    function render(snap) {
      if (snap.route.projectPage !== 'assets') return;
      pageEl.replaceChildren();
      const filter = snap.route.assetFilter || 'all';
      const toolbar = document.createElement('div');
      toolbar.className = 'page-toolbar';
      toolbar.append(text('h2', '素材'), text('p', '紧凑列表 + 检查器；支持筛选与搜索。', 'muted'));

      const filters = document.createElement('div');
      filters.className = 'asset-filters';
      ['selected', 'separate', 'excluded', 'issues', 'all'].forEach((id) => {
        const button = text('button', id, filter === id ? 'button primary' : 'button ghost');
        button.type = 'button';
        button.addEventListener('click', () => data.routeStore.set({ assetFilter: id }));
        filters.appendChild(button);
      });
      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = '搜索文件名 / ID';
      search.value = snap.assetSearch || '';
      search.addEventListener('input', () => data.patch({ assetSearch: search.value }));
      filters.appendChild(search);

      const layout = document.createElement('div');
      layout.className = `assets-layout ${snap.inspectorCollapsed ? 'inspector-collapsed' : ''}`;
      const list = document.createElement('div');
      list.className = 'assets-list';
      let rows = decisionsFrom(snap);
      const issueAssetIds = new Set((snap.issues || []).map((issue) => issue.assetId).filter(Boolean));
      if (filter !== 'all') {
        rows = rows.filter((row) => {
          if (filter === 'issues') return issueAssetIds.has(row.assetId);
          return row.decision === filter;
        });
      }
      const q = String(snap.assetSearch || '').trim().toLowerCase();
      if (q) {
        rows = rows.filter((row) => `${row.asset.filename || ''} ${row.assetId}`.toLowerCase().includes(q));
      }
      if (!rows.length) list.appendChild(text('div', '无匹配素材', 'empty-state'));
      rows.forEach((row) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'asset-row';
        if (snap.selectedAssetId === row.assetId) button.classList.add('active');
        button.append(
          text('strong', row.asset.filename || row.assetId),
          text('span', `${row.asset.type || '—'} · ${row.decision}`, 'muted'),
        );
        if (issueAssetIds.has(row.assetId)) button.appendChild(text('span', '有问题', 'issue-chip issue-confirm'));
        button.addEventListener('click', () => data.patch({ selectedAssetId: row.assetId }));
        list.appendChild(button);
      });

      const inspector = document.createElement('aside');
      inspector.className = 'assets-inspector';
      const selected = rows.find((row) => row.assetId === snap.selectedAssetId) || rows[0];
      if (!selected) {
        inspector.appendChild(text('p', '选择素材查看详情', 'muted'));
      } else {
        const asset = selected.asset;
        inspector.append(
          text('h3', asset.filename || selected.assetId),
          root.PlannerDom.createDefinitionGrid([
            ['ID', selected.assetId],
            ['类型', asset.type || '—'],
            ['结论', selected.decision],
            ['原因', selected.reason || '—'],
            ['时长', root.PlannerUtils.formatDuration?.(asset.metadata?.durationSec) || '—'],
            ['尺寸', asset.metadata?.width && asset.metadata?.height
              ? `${asset.metadata.width}×${asset.metadata.height}` : '—'],
          ]),
        );
        if (asset.fileUrl) {
          const media = document.createElement(asset.type === 'video' ? 'video' : 'img');
          media.src = asset.fileUrl;
          media.controls = asset.type === 'video';
          media.className = 'asset-preview-media';
          inspector.appendChild(media);
        }
      }
      const toggle = text('button', snap.inspectorCollapsed ? '展开检查器' : '收起检查器', 'button ghost');
      toggle.type = 'button';
      toggle.addEventListener('click', () => data.patch({ inspectorCollapsed: !snap.inspectorCollapsed }));

      layout.append(list, inspector);
      pageEl.append(toolbar, filters, toggle, layout);
    }

    data.subscribe(render);
    render(data.get());
  }

  return { mount };
}));
