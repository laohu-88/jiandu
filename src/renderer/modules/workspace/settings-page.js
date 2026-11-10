(function createPlannerSettingsPage(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerSettingsPage = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function text(tag, value, className = '') {
    return (root.PlannerDom || root.PlannerUtils).createTextElement(tag, value, className);
  }

  function mount({ data, root: rootEl }) {
    const view = rootEl.querySelector('#settingsView');
    if (!view) return;

    function render(snap) {
      if (snap.route.nav !== 'settings') return;
      view.replaceChildren();
      view.append(
        text('h2', '设置'),
        text('p', '只保留日常需要的交接与诊断。', 'muted'),
      );

      const engine = root.PlannerDom.createResultSection('剪辑 Agent');
      engine.append(text('p', 'Codex（唯一可执行 provider）', 'muted'));
      view.appendChild(engine);

      const library = root.PlannerDom.createResultSection('素材库位置');
      library.appendChild(root.PlannerDom.createDefinitionGrid([
        ['待处理', snap.config?.pendingRoot || '~/Desktop/视频待处理'],
        ['项目库', snap.config?.projectRoot || '~/Desktop/视频素材库'],
      ]));
      view.appendChild(library);

      const fcp = root.PlannerDom.createResultSection('Final Cut Pro');
      const auto = document.createElement('label');
      auto.className = 'setting-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(snap.autoOpenFcp);
      checkbox.addEventListener('change', async () => {
        const settings = await window.plannerApi.saveHandoffSettings({ autoOpenFcp: checkbox.checked });
        data.patch({ autoOpenFcp: settings.autoOpenFcp === true });
      });
      auto.append(checkbox, text('span', '结果就绪且无阻塞问题时自动打开 Final Cut Pro'));
      fcp.appendChild(auto);
      view.appendChild(fcp);

      const diag = document.createElement('details');
      diag.className = 'result-section advanced-diagnostics';
      const summary = document.createElement('summary');
      summary.textContent = '高级诊断';
      diag.appendChild(summary);
      const task = snap.runningOverlays?.handoffTask;
      const retention = task?.status === 'cancelled' || task?.status === 'completed' || task?.status === 'completed_with_warnings'
        ? '完成后可清理'
        : (task?.status === 'failed'
          ? '失败诊断保留'
          : (task?.status === 'agent_disconnected' ? '失联恢复保留' : (task ? '进行中保留' : '—')));
      diag.appendChild(root.PlannerDom.createDefinitionGrid([
        ['版本', snap.config?.version || '—'],
        ['工作区', snap.config?.workspace || '—'],
        ['当前任务', task?.taskId || '无'],
        ['任务记录', retention],
      ].filter((item) => item[1])));

      const envButton = text('button', '探测本机媒体工具', 'button ghost');
      envButton.type = 'button';
      envButton.addEventListener('click', async () => {
        try {
          const environment = await window.plannerApi.detectEnvironment();
          const rows = [['FFmpeg', environment?.ffmpeg?.available ? `可用（${environment.ffmpeg.version || '已安装'}）` : environment?.ffmpeg?.detail || '不可用']];
          if (environment?.subtitleCommand) {
            rows.push(['字幕工具', environment.subtitleCommand.available
              ? `可用（${environment.subtitleCommand.command}）`
              : environment.subtitleCommand.detail || '不可用']);
          }
          const old = diag.querySelector('.environment-grid');
          if (old) old.remove();
          diag.insertBefore(root.PlannerDom.createDefinitionGrid(rows), envButton);
          const grid = diag.querySelector('.definition-grid:last-of-type');
          grid.classList.add('environment-grid');
        } catch (error) {
          data.toast(root.PlannerUtils.getUserErrorMessage(error), true);
        }
      });
      diag.appendChild(envButton);
      view.appendChild(diag);
    }

    data.subscribe(render);
    render(data.get());
  }

  return { mount };
}));
