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
        text('p', '应用偏好与可选的旧入口。', 'muted'),
      );

      const auto = document.createElement('label');
      auto.className = 'setting-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(snap.autoOpenFcp);
      checkbox.addEventListener('change', async () => {
        data.patch({ autoOpenFcp: checkbox.checked });
        try {
          const settings = await window.plannerApi.saveHandoffSettings({
            autoOpenFcp: checkbox.checked,
          });
          data.patch({ autoOpenFcp: settings?.autoOpenFcp === true });
          data.toast(settings?.autoOpenFcp
            ? '已开启：仅在完整验证通过且无警告时自动打开 Final Cut Pro。'
            : '已关闭自动打开 Final Cut Pro。');
        } catch (error) {
          data.toast(root.PlannerUtils.getUserErrorMessage(error), true);
        }
      });
      auto.append(checkbox, text('span', '验证全部通过后，自动打开 Final Cut Pro'));
      view.appendChild(auto);

      const ai = root.PlannerDom.createResultSection('AI 环境');
      const refreshAi = text('button', '检查 AI 环境', 'button secondary');
      refreshAi.type = 'button';
      refreshAi.addEventListener('click', () => root.PlannerUtils.withBusy(refreshAi, async () => {
        const result = data.api.checkAiEnvironment
          ? await data.api.checkAiEnvironment()
          : await data.api.call?.('checkAiEnvironment');
        data.patch({ aiEnvironment: result });
        data.toast(result?.ok ? 'AI 环境可用' : 'AI 环境存在问题', !result?.ok);
      }, '检查中…', data.toast));
      ai.appendChild(refreshAi);
      if (snap.aiEnvironment) {
        ai.appendChild(root.PlannerDom.createDefinitionGrid(
          Object.entries(snap.aiEnvironment)
            .filter(([, value]) => typeof value !== 'object')
            .map(([key, value]) => [key, String(value)]),
        ));
      }
      view.appendChild(ai);

      const legacy = root.PlannerDom.createResultSection('旧版入口');
      legacy.appendChild(text('p', '素材筛选台保留为可选入口，日常请使用项目库与工作区。', 'muted'));
      const openLegacy = text('button', '打开素材筛选台（旧）', 'button ghost');
      openLegacy.type = 'button';
      openLegacy.addEventListener('click', () => {
        data.toast('请从项目库打开项目后，在主成片页使用现有审阅能力；独立筛选台入口已收敛到设置。');
      });
      legacy.appendChild(openLegacy);
      view.appendChild(legacy);
    }

    data.subscribe(render);
    render(data.get());
  }

  return { mount };
}));
