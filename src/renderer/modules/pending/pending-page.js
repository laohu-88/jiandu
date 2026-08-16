(function createPlannerPendingPage(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerPendingPage = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function text(tag, value, className = '') {
    return (root.PlannerDom || root.PlannerUtils).createTextElement(tag, value, className);
  }

  function mount({ data, root: rootEl, router }) {
    const view = rootEl.querySelector('#pendingView');
    if (!view) return;

    function renderPending(snap) {
      if (snap.route.nav !== 'pending' || snap.route.sessionOpen) return;
      view.replaceChildren();
      const toolbar = document.createElement('div');
      toolbar.className = 'page-toolbar';
      const title = document.createElement('div');
      title.append(
        text('h2', '待处理'),
        text('p', snap.pendingCatalog?.exists
          ? `${snap.pendingCatalog.episodes?.length || 0} 个素材项目`
          : (snap.loading.pending ? '正在识别…' : '尚未配置素材库'), 'muted'),
      );
      const refresh = text('button', '刷新', 'button secondary');
      refresh.type = 'button';
      refresh.addEventListener('click', () => data.refreshPending());
      toolbar.append(title, refresh);
      view.appendChild(toolbar);

      const list = document.createElement('div');
      list.className = 'pending-list';
      const episodes = snap.pendingCatalog?.episodes || [];
      if (!episodes.length) {
        list.appendChild(text('div', '还没有新进入的素材。把一期素材放到待处理目录后刷新即可。', 'empty-state'));
      }
      const vm = root.WorkspaceViewModel || {};
      episodes.forEach((episode) => {
        const rowModel = vm.buildPendingEpisodeRow
          ? vm.buildPendingEpisodeRow(episode)
          : episode;
        const row = document.createElement('article');
        row.className = 'pending-row card-row';
        const meta = document.createElement('div');
        meta.append(
          text('strong', rowModel.name),
          text('p', `${rowModel.origin} · 视频 ${rowModel.videoCount} · 图片 ${rowModel.imageCount}${rowModel.captionCount ? ` · 字幕 ${rowModel.captionCount}` : ''}`, 'muted'),
        );
        const pills = document.createElement('div');
        pills.className = 'row-pills';
        pills.append(
          text('span', rowModel.origin, 'status-pill'),
          text('span', rowModel.recognized ? '已识别' : '待识别', rowModel.recognized ? 'status-pill ok' : 'status-pill'),
        );
        const start = text('button', '开始剪辑', 'button primary');
        start.type = 'button';
        start.addEventListener('click', () => {
          router.openPendingEpisode(episode.sourceDirectory, {
            projectPath: episode.existingProject?.projectPath || null,
            engine: snap.route.engine || 'cursor_agent',
            platformMode: 'douyin',
          });
          data.patch({ currentEpisode: episode });
          data.recognizeSource?.(episode.sourceDirectory);
        });
        row.append(meta, pills, start);
        list.appendChild(row);
      });
      view.appendChild(list);
    }

    data.subscribe(renderPending);
    renderPending(data.get());
  }

  return { mount };
}));
