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

      const engine = root.PlannerDom.createResultSection('Cursor / Codex 交接');
      const engineSelect = document.createElement('select');
      [['cursor_agent', 'Cursor'], ['codex', 'Codex']].forEach(([value, label]) => {
        const option = text('option', label);
        option.value = value;
        option.selected = (snap.defaultEngine || snap.route.engine) === value;
        engineSelect.appendChild(option);
      });
      engineSelect.addEventListener('change', async () => {
        data.routeStore.set({ engine: engineSelect.value });
        const settings = await window.plannerApi.saveHandoffSettings({ defaultEngine: engineSelect.value });
        data.patch({ defaultEngine: settings.defaultEngine });
      });
      engine.append(text('p', '开始 AI 剪辑时默认使用的 Agent。', 'muted'), engineSelect);
      view.appendChild(engine);

      const access = root.PlannerDom.createResultSection('Cursor 自动化权限');
      const check = text('button', '检查辅助功能权限', 'button secondary');
      check.type = 'button';
      const accessStatus = text('p', snap.accessibility?.granted
        ? '已授权，可以把提示词放入 Cursor。'
        : '尚未检查。首次自动放入提示词时如果缺权限，会在这里给出一次性指引。', 'muted');
      check.addEventListener('click', async () => {
        try {
          const result = await window.plannerApi.checkCursorAccessibility();
          data.patch({ accessibility: result });
          data.toast(result.granted ? '辅助功能已授权' : '尚未授权辅助功能', !result.granted);
        } catch (error) {
          data.toast(root.PlannerUtils.getUserErrorMessage(error), true);
        }
      });
      if (snap.accessibility && snap.accessibility.granted === false) {
        access.append(text('pre', snap.accessibility.guidance || snap.accessibility.message || '', 'notice warning'));
      }
      access.append(accessStatus, check);
      view.appendChild(access);

      const library = root.PlannerDom.createResultSection('素材库位置');
      library.appendChild(root.PlannerDom.createDefinitionGrid([
        ['待处理', snap.config?.pendingRoot || '/Users/example/Desktop/视频待处理'],
        ['项目库', snap.config?.projectRoot || '/Users/example/Desktop/视频素材库'],
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

      const diag = root.PlannerDom.createResultSection('诊断信息');
      diag.appendChild(root.PlannerDom.createDefinitionGrid([
        ['版本', snap.config?.version || '—'],
        ['工作区', snap.config?.workspace || '—'],
        ['FFmpeg', snap.config?.ffmpeg || '本地媒体处理可用'],
      ].filter((item) => item[1])));
      view.appendChild(diag);
    }

    data.subscribe(render);
    render(data.get());
  }

  return { mount };
}));
