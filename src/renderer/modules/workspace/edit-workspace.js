(function createPlannerEditWorkspace(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerEditWorkspace = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function text(tag, value, className = '') {
    return (root.PlannerDom || root.PlannerUtils).createTextElement(tag, value, className);
  }

  function mount({ data, root: rootEl, router }) {
    const brief = rootEl.querySelector('#pageBrief');
    const processing = rootEl.querySelector('#pageProcessing');
    const results = rootEl.querySelector('#pageResults');
    if (!brief || !processing || !results) return;

    async function startAiEdit(extraRequirements, kind = 'edit') {
      const snap = data.get();
      const sourceDirectory = snap.route.sourceDirectory
        || snap.currentEpisode?.sourceDirectory
        || snap.projectResult?.project?.sourceDirectory;
      if (!sourceDirectory) {
        data.toast('没有可交接的素材目录。', true);
        return;
      }
      try {
        const created = await window.plannerApi.startEditHandoff({
          sourceDirectory,
          engine: snap.route.engine || 'cursor_agent',
          platformMode: snap.route.platformMode || 'douyin',
          extraRequirements: extraRequirements == null ? '' : String(extraRequirements),
          kind,
          parentTaskId: snap.runningOverlays?.handoffTask?.taskId || null,
          previousProjectPath: snap.route.projectPath || null,
        });
        const task = created.task || created;
        data.patch({
          runningOverlays: { ...snap.runningOverlays, handoffTask: task },
        });
        data.routeStore.set({
          sessionOpen: true,
          workspacePhase: 'processing',
          projectPage: 'processing',
          runningTask: { id: task.taskId, label: task.stageMessage },
        });
        const launched = task.engine === 'codex'
          ? await window.plannerApi.launchCodexHandoff(task.taskFilePath)
          : await window.plannerApi.launchCursorHandoff(task.taskFilePath);
        data.patch({
          runningOverlays: { ...data.get().runningOverlays, handoffTask: launched },
        });
        if (launched.cursorInject?.granted === false) {
          data.toast(launched.cursorInject.guidance || '需要辅助功能权限才能放入提示词', true);
        } else {
          data.toast(task.engine === 'codex' ? '已打开 Codex' : '已打开 Cursor');
        }
      } catch (error) {
        data.toast(root.PlannerUtils.getUserErrorMessage(error), true);
      }
    }

    function renderBrief(snap) {
      if (!snap.route.sessionOpen) return;
      const phase = snap.route.workspacePhase || snap.route.projectPage;
      if (phase !== 'brief' && phase !== 'revise') return;
      brief.replaceChildren();
      const episode = snap.currentEpisode || {};
      const inventory = snap.sourceRecognition?.inventory;
      const counts = episode.counts || {};
      const summary = root.PlannerDom.createResultSection('素材识别摘要');
      summary.appendChild(root.PlannerDom.createDefinitionGrid([
        ['来源', inventory?.detected ? 'HotIngest' : (episode.name ? '普通来源' : '—')],
        ['视频', String(counts.video ?? '—')],
        ['图片', String(counts.image ?? '—')],
        ['字幕 / 翻译', String(inventory?.items?.filter((item) => item.translations?.length)?.length || 0)],
        ['识别', snap.sourceRecognition ? '已完成' : (snap.loading.pending ? '识别中' : '待识别')],
      ]));
      const inspect = text('button', '查看素材', 'button ghost');
      inspect.type = 'button';
      inspect.addEventListener('click', () => data.routeStore.set({
        workspacePhase: 'advanced',
        projectPage: 'advanced',
      }));
      summary.appendChild(inspect);
      brief.appendChild(summary);

      const extras = document.createElement('label');
      extras.className = 'extra-requirements';
      extras.append(
        text('strong', '本次额外要求'),
        text('p', '可留空。填写内容会原样交给 Agent。', 'muted'),
      );
      const textarea = document.createElement('textarea');
      textarea.rows = 8;
      textarea.placeholder = phase === 'revise'
        ? '例如：第二条开头换成狗；字幕往上；这一段不要裁人物'
        : '本次额外要求';
      textarea.value = snap.route.extraRequirements || '';
      textarea.addEventListener('input', () => data.routeStore.set({ extraRequirements: textarea.value }));
      extras.appendChild(textarea);
      brief.appendChild(extras);

      const start = text('button', phase === 'revise' ? '让 AI 再调整' : '开始 AI 剪辑', 'button primary extra-start');
      start.type = 'button';
      start.addEventListener('click', () => startAiEdit(textarea.value, phase === 'revise' ? 'revise' : 'edit'));
      brief.appendChild(start);
    }

    function renderProcessing(snap) {
      if (!snap.route.sessionOpen) return;
      if ((snap.route.workspacePhase || snap.route.projectPage) !== 'processing') return;
      processing.replaceChildren();
      const task = snap.runningOverlays?.handoffTask;
      processing.append(
        text('h3', task?.engine === 'codex' ? 'Codex 正在处理' : 'Cursor 正在处理'),
        text('p', task?.stageMessage || '已交接，等待 Agent 返回。', 'muted'),
      );
      const status = document.createElement('ol');
      status.className = 'process-steps';
      [
        ['已交接', true],
        ['正在分析', /analyz|planning|extract|scanning/i.test(task?.status || '')],
        ['正在生成', /build|render|generat|verif/i.test(task?.status || '')],
        ['已完成', ['completed', 'completed_with_warnings'].includes(task?.status)],
      ].forEach(([label, on]) => {
        const item = text('li', label, on ? 'on' : '');
        status.appendChild(item);
      });
      processing.appendChild(status);
      const actions = document.createElement('div');
      actions.className = 'result-actions';
      const reopen = text('button', task?.engine === 'codex' ? '重新打开 Codex' : '重新打开 Agent', 'button secondary');
      reopen.type = 'button';
      reopen.addEventListener('click', async () => {
        if (!task) return;
        if (task.engine === 'codex') await window.plannerApi.activateCodexHandoff(task.taskFilePath);
        else await window.plannerApi.activateCursorHandoff(task.taskFilePath);
      });
      const cancel = text('button', '取消', 'button ghost');
      cancel.type = 'button';
      cancel.addEventListener('click', async () => {
        if (!task) return;
        await window.plannerApi.cancelHandoffTask(task.taskFilePath);
        data.routeStore.set({ workspacePhase: 'brief', projectPage: 'brief' });
      });
      actions.append(reopen, cancel);
      processing.appendChild(actions);
    }

    function renderResults(snap) {
      if (!snap.route.sessionOpen) return;
      if ((snap.route.workspacePhase || snap.route.projectPage) !== 'results') return;
      results.replaceChildren();
      const variant = snap.douyinVariant;
      const blocking = (snap.issues || []).filter((item) => item.level === 'blocking' && !item.resolved);
      if (blocking.length) {
        const banner = document.createElement('div');
        banner.className = 'notice warning';
        banner.append(
          text('strong', blocking[0].message || '存在无法安全继续的问题'),
          text('button', '详细诊断', 'button ghost'),
        );
        banner.querySelector('button').addEventListener('click', () => {
          data.routeStore.set({ workspacePhase: 'advanced', projectPage: 'advanced' });
        });
        results.appendChild(banner);
      }

      const layout = document.createElement('div');
      layout.className = 'results-workspace';
      const left = document.createElement('aside');
      left.className = 'results-list';
      const videos = variant?.plan?.videos || [];
      const outputs = variant?.outputs || [];
      if (!videos.length && snap.projectResult?.timeline?.shots) {
        left.appendChild(text('p', `主成片 ${snap.projectResult.timeline.shots.length} 个镜头`, 'muted'));
      }
      videos.forEach((video, index) => {
        const output = outputs[index] || outputs.find((item) => item.videoId === video.videoId);
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'shot-card';
        card.append(
          text('strong', video.theme || `成片 ${index + 1}`),
          text('p', `${video.shots?.length || 0} 镜头 · ${Math.round(Number(video.durationSec || 0))}s`, 'muted'),
          text('p', `字幕 ${video.lightCaptions?.length || video.captions?.length ? '有' : '无'} · 原声 ${video.preserveOriginalAudio === false ? '关' : '开'}`, 'muted'),
        );
        card.addEventListener('click', () => data.patch({ selectedVideoId: video.videoId, selectedOutput: output }));
        left.appendChild(card);
      });

      const center = document.createElement('section');
      center.className = snap.route.platformMode === 'douyin' ? 'results-preview phone-canvas' : 'results-preview';
      const previewPath = snap.selectedOutput?.previewPath
        || outputs[0]?.previewPath
        || snap.projectResult?.artifacts?.preview?.path;
      if (previewPath) {
        const video = document.createElement('video');
        video.controls = true;
        video.src = previewPath.startsWith('file:') ? previewPath : `file://${previewPath}`;
        center.appendChild(video);
      } else {
        center.appendChild(text('p', '预览生成后会显示在这里。', 'muted'));
      }

      const right = document.createElement('aside');
      right.className = 'results-inspector';
      const selected = (videos.find((item) => item.videoId === snap.selectedVideoId) || videos[0] || {});
      right.append(
        text('h3', '当前镜头'),
        text('p', selected.theme || '选择一条成片查看详情', 'muted'),
      );
      (selected.shots || []).slice(0, 8).forEach((shot, index) => {
        right.appendChild(text('p', `${index + 1}. ${shot.assetId || shot.shotId}`, 'muted'));
      });

      layout.append(left, center, right);
      results.appendChild(layout);

      const bar = document.createElement('footer');
      bar.className = 'workspace-footer';
      const fcp = text('button', '在 Final Cut Pro 中打开', 'button primary');
      fcp.type = 'button';
      fcp.addEventListener('click', async () => {
        const output = snap.selectedOutput || outputs[0];
        try {
          if (output && window.plannerApi.openDouyinFcpxmlInFinalCut) {
            await window.plannerApi.openDouyinFcpxmlInFinalCut({
              projectPath: snap.route.projectPath,
              variantId: variant?.variantId || 'douyin',
              outputId: output.outputId || output.videoId,
            });
          } else {
            await window.plannerApi.openProjectFcpxmlInFinalCut(snap.route.projectPath);
          }
          data.toast('正在打开 Final Cut Pro');
        } catch (error) {
          data.toast(root.PlannerUtils.getUserErrorMessage(error), true);
        }
      });
      const revise = text('button', '让 AI 再调整', 'button secondary');
      revise.type = 'button';
      revise.addEventListener('click', () => data.routeStore.set({
        workspacePhase: 'revise',
        projectPage: 'brief',
        extraRequirements: '',
      }));
      const folder = text('button', '打开输出目录', 'button ghost');
      folder.type = 'button';
      folder.addEventListener('click', () => window.plannerApi.runProjectArtifactAction?.({
        projectPath: snap.route.projectPath,
        action: 'show-output-dir',
      }));
      const advanced = text('button', '高级调整', 'button ghost');
      advanced.type = 'button';
      advanced.addEventListener('click', () => data.routeStore.set({
        workspacePhase: 'advanced',
        projectPage: 'advanced',
      }));
      bar.append(fcp, revise, folder, advanced);
      results.appendChild(bar);
    }

    function render(snap) {
      renderBrief(snap);
      renderProcessing(snap);
      renderResults(snap);
    }

    data.subscribe(render);
    render(data.get());
  }

  return { mount };
}));
