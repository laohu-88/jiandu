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

    const overlays = {
      editPreflight: rootEl.querySelector('#editPreflightView'),
      editJob: rootEl.querySelector('#editJobView'),
      handoffConfirm: rootEl.querySelector('#handoffConfirmView'),
      handoffTask: rootEl.querySelector('#handoffTaskView'),
      handoffCompletion: rootEl.querySelector('#handoffCompletionView'),
    };

    function hideOverlays() {
      Object.values(overlays).forEach((el) => el?.classList.add('hidden'));
    }

    function renderPending(snap) {
      if (snap.route.nav !== 'pending') return;
      view.replaceChildren();
      const toolbar = document.createElement('div');
      toolbar.className = 'page-toolbar';
      const title = document.createElement('div');
      title.append(
        text('h2', '待处理素材'),
        text('p', snap.pendingCatalog?.exists
          ? `根目录 ${snap.pendingCatalog.rootPath || ''} · ${snap.pendingCatalog.episodes?.length || 0} 期`
          : (snap.loading.pending ? '正在扫描…' : '尚未配置待处理目录'), 'muted'),
      );
      const actions = document.createElement('div');
      actions.className = 'toolbar-actions';
      const refresh = text('button', '刷新素材', 'button secondary');
      refresh.type = 'button';
      refresh.addEventListener('click', () => data.refreshPending());
      const newJob = text('button', '新建剪辑任务', 'button primary');
      newJob.type = 'button';
      newJob.addEventListener('click', () => startEditJob());
      actions.append(newJob, refresh);
      toolbar.append(title, actions);
      view.appendChild(toolbar);

      if (snap.pendingCatalog && !snap.pendingCatalog.exists) {
        view.appendChild(text('div', snap.pendingCatalog.message || '待处理目录不存在', 'notice warning'));
      }

      const list = document.createElement('div');
      list.className = 'pending-list';
      const episodes = snap.pendingCatalog?.episodes || [];
      if (!episodes.length) {
        list.appendChild(text('div', '尚未发现一期素材。只读取待处理根目录下的直属子目录。', 'empty-state'));
      }
      episodes.forEach((episode) => {
        const row = document.createElement('article');
        row.className = 'pending-row';
        row.append(
          text('strong', episode.name || episode.sourceDirectory),
          text('p', episode.sourceDirectory, 'muted'),
          text('span', `${episode.mediaCount ?? episode.fileCount ?? '—'} 个媒体`, 'status-pill'),
        );
        const rowActions = document.createElement('div');
        rowActions.className = 'result-actions';
        const cursor = text('button', '交给 Cursor Agent', 'button primary');
        cursor.type = 'button';
        cursor.addEventListener('click', () => openHandoff(episode, 'cursor_agent'));
        const codex = text('button', '交给 Codex', 'button secondary');
        codex.type = 'button';
        codex.addEventListener('click', () => openHandoff(episode, 'codex'));
        const finder = text('button', '在 Finder 中显示', 'button ghost');
        finder.type = 'button';
        finder.addEventListener('click', () => data.api.showPendingMediaInFinder?.(episode.sourceDirectory)
          || data.api.call?.('showPendingMediaInFinder', episode.sourceDirectory));
        const edit = text('button', '新建剪辑任务', 'button ghost');
        edit.type = 'button';
        edit.addEventListener('click', () => startEditJob(episode.sourceDirectory));
        rowActions.append(cursor, codex, edit, finder);
        row.appendChild(rowActions);
        list.appendChild(row);
      });
      view.appendChild(list);
    }

    async function openHandoff(episode, engine) {
      hideOverlays();
      const panel = overlays.handoffConfirm;
      if (!panel) {
        data.toast('交接面板未就绪', true);
        return;
      }
      const isCursor = engine === 'cursor_agent';
      panel.classList.remove('hidden');
      const eyebrow = panel.querySelector('#handoffConfirmEyebrow');
      if (eyebrow) eyebrow.textContent = isCursor ? 'CURSOR AGENT 可视化交接' : 'CODEX 可视化交接';
      const title = panel.querySelector('#handoffConfirmTitle');
      if (title) {
        title.textContent = isCursor ? '确认交给 Cursor Agent 分析' : '确认交给 Codex 处理';
      }
      panel.dataset.engine = engine;
      panel.dataset.sourceDirectory = episode.sourceDirectory;
      panel.querySelector('#launchCursorButton')?.classList.toggle('hidden', !isCursor);
      panel.querySelector('#launchCodexButton')?.classList.toggle('hidden', isCursor);
      const summary = panel.querySelector('#handoffSourceSummary');
      if (summary) {
        summary.replaceChildren(root.PlannerDom.createDefinitionGrid([
          ['期名', episode.name || '—'],
          ['素材目录', episode.sourceDirectoryRealPath || episode.sourceDirectory],
          ['剪辑引擎', isCursor ? 'Cursor Agent（默认）' : 'Codex'],
          ['图片', String(episode.counts?.image ?? '—')],
          ['视频', String(episode.counts?.video ?? '—')],
          ['音频', String(episode.counts?.audio ?? '—')],
          ['警告', (episode.warnings || []).join('；') || '无'],
        ]));
      }
      const narrative = panel.querySelector('#handoffNarrativePreview');
      if (narrative) {
        const chapters = episode.chapters || [];
        const narrativeHeading = text('h3', '叙事结构');
        const narrativeList = document.createElement('ol');
        chapters.forEach((chapter) => {
          narrativeList.appendChild(text(
            'li',
            `${chapter.chapterName}（图片 ${chapter.imageCount}，视频 ${chapter.videoCount}）`,
          ));
        });
        const narrativeFacts = root.PlannerDom.createDefinitionGrid([
          ['检测到的章节数', String(chapters.length)],
          ['使用的本期说明文件', (episode.briefFilesUsed || []).join('、') || '无'],
          ['预计成片时长范围', episode.durationPolicy
            ? (episode.durationPolicy.constrained === false
              || episode.durationPolicy.source === 'unconstrained'
              || episode.durationPolicy.maxSec == null
              ? '不设默认成片时长上限'
              : `${episode.durationPolicy.minSec}–${episode.durationPolicy.maxSec} 秒`)
            : '待分析'],
          ['章节交叉', episode.allowChapterInterleave ? '允许' : '禁止'],
        ]);
        narrative.replaceChildren(narrativeHeading, narrativeList, narrativeFacts);
        narrative.classList.toggle(
          'hidden',
          chapters.length === 0 && (episode.briefFilesUsed || []).length === 0,
        );
      }
    }

    async function startEditJob(sourceDirectory) {
      hideOverlays();
      const panel = overlays.editPreflight;
      if (!panel) {
        data.toast('剪辑任务面板未就绪', true);
        return;
      }
      try {
        let directory = sourceDirectory;
        if (!directory) {
          directory = await window.plannerApi.selectMaterialDirectory();
        }
        if (!directory) return;
        const preflight = await window.plannerApi.buildEditPreflight(directory);
        data.patch({
          runningOverlays: {
            ...data.get().runningOverlays,
            editPreflight: preflight || { material: { sourceDirectory: directory } },
          },
        });
        panel.classList.remove('hidden');
        const title = panel.querySelector('#editPreflightTitle');
        if (title) title.textContent = `新建剪辑任务 · ${preflight?.material?.name || directory}`;
        const summary = panel.querySelector('#editPreflightSummary');
        if (summary && preflight) {
          summary.replaceChildren(root.PlannerDom.createDefinitionGrid([
            ['素材目录', preflight.material?.sourceDirectory || directory],
            ['媒体数', String(preflight.mediaCounts?.total ?? '—')],
            ['警告', (preflight.warnings || []).join('；') || '无'],
          ]));
        }
      } catch (error) {
        data.toast(root.PlannerUtils.getUserErrorMessage(error), true);
      }
    }

    function bindOverlayButtons() {
      rootEl.querySelector('#cancelEditPreflightButton')?.addEventListener('click', hideOverlays);
      rootEl.querySelector('#cancelHandoffConfirmButton')?.addEventListener('click', hideOverlays);
      rootEl.querySelector('#editJobCancelButton')?.addEventListener('click', hideOverlays);
      rootEl.querySelector('#cancelHandoffTaskButton')?.addEventListener('click', hideOverlays);

      rootEl.querySelector('#launchCursorButton')?.addEventListener('click', async (event) => {
        const panel = overlays.handoffConfirm;
        const sourceDirectory = panel?.dataset.sourceDirectory;
        if (!sourceDirectory) return;
        await root.PlannerUtils.withBusy(event.currentTarget, async () => {
          const mode = document.querySelector('input[name="hyperframesMode"]:checked')?.value || 'auto';
          let task = await window.plannerApi.createHandoffTask({
            sourceDirectory,
            hyperframesMode: mode,
            engine: 'cursor_agent',
          });
          task = await window.plannerApi.launchCursorHandoff(task.taskFilePath);
          data.patch({
            runningOverlays: { ...data.get().runningOverlays, handoffTask: task },
          });
          hideOverlays();
          overlays.handoffTask?.classList.remove('hidden');
          const name = overlays.handoffTask?.querySelector('#handoffTaskName');
          if (name) name.textContent = task.sourceSummary?.name || sourceDirectory;
          router.navigate('tasks');
          data.toast('已启动 Cursor Agent 交接');
        }, '启动中…', data.toast);
      });

      rootEl.querySelector('#launchCodexButton')?.addEventListener('click', async (event) => {
        const panel = overlays.handoffConfirm;
        const sourceDirectory = panel?.dataset.sourceDirectory;
        if (!sourceDirectory) return;
        await root.PlannerUtils.withBusy(event.currentTarget, async () => {
          const mode = document.querySelector('input[name="hyperframesMode"]:checked')?.value || 'auto';
          let task = await window.plannerApi.createHandoffTask({
            sourceDirectory,
            hyperframesMode: mode,
            engine: 'codex',
          });
          task = await window.plannerApi.launchCodexHandoff(task.taskFilePath);
          data.patch({
            runningOverlays: { ...data.get().runningOverlays, handoffTask: task },
          });
          hideOverlays();
          overlays.handoffTask?.classList.remove('hidden');
          const name = overlays.handoffTask?.querySelector('#handoffTaskName');
          if (name) name.textContent = task.sourceSummary?.name || sourceDirectory;
          router.navigate('tasks');
          data.toast('已启动 Codex 交接');
        }, '启动中…', data.toast);
      });

      rootEl.querySelector('#editCursorHandoffButton')?.addEventListener('click', async (event) => {
        const preflight = data.get().runningOverlays.editPreflight;
        if (!preflight?.material?.sourceDirectory) return;
        await root.PlannerUtils.withBusy(event.currentTarget, async () => {
          await window.plannerApi.createEditJob({
            sourceDirectory: preflight.material.sourceDirectory,
            action: 'cursor_agent_handoff',
            preflight,
          });
          hideOverlays();
          await openHandoff({
            ...preflight.material,
            sourceDirectory: preflight.material.sourceDirectory,
            name: preflight.material.name,
            counts: preflight.mediaCounts,
            warnings: preflight.warnings || [],
          }, 'cursor_agent');
        }, '正在准备…', data.toast);
      });

      rootEl.querySelector('#editCodexHandoffButton')?.addEventListener('click', async (event) => {
        const preflight = data.get().runningOverlays.editPreflight;
        if (!preflight?.material?.sourceDirectory) return;
        await root.PlannerUtils.withBusy(event.currentTarget, async () => {
          await window.plannerApi.createEditJob({
            sourceDirectory: preflight.material.sourceDirectory,
            action: 'codex_handoff',
            preflight,
          });
          hideOverlays();
          await openHandoff({
            ...preflight.material,
            sourceDirectory: preflight.material.sourceDirectory,
            name: preflight.material.name,
            counts: preflight.mediaCounts,
            warnings: preflight.warnings || [],
          }, 'codex');
        }, '正在准备…', data.toast);
      });
    }

    bindOverlayButtons();
    data.subscribe(renderPending);
    renderPending(data.get());
  }

  return { mount };
}));
