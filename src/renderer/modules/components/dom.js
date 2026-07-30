(function createPlannerDom(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerDom = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function createTextElement(tag, text, className = '') {
    if (root.PlannerUtils?.createTextElement) {
      return root.PlannerUtils.createTextElement(tag, text, className);
    }
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function formatDateTime(value) {
    if (root.PlannerUtils?.formatDateTime) return root.PlannerUtils.formatDateTime(value);
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN');
  }

  function formatResultDuration(value) {
    return Number.isFinite(value) ? `${Number(value.toFixed(2))} 秒` : '—';
  }

  function formatVideoSpec(format) {
    if (!format) return '—';
    const dimensions = format.width && format.height ? `${format.width}×${format.height}` : '—';
    const fps = Number.isFinite(format.fps) ? `${format.fps}p` : '—';
    return `${dimensions} · ${fps}`;
  }

  function resultStatusClass(status) {
    return `result-status result-status-${status || 'incomplete'}`;
  }

  function createResultSection(title, subtitle = '') {
    const section = document.createElement('section');
    section.className = 'result-section';
    const heading = document.createElement('div');
    heading.className = 'result-section-heading';
    heading.appendChild(createTextElement('h3', title));
    if (subtitle) heading.appendChild(createTextElement('p', subtitle));
    section.appendChild(heading);
    return section;
  }

  function createDefinitionGrid(entries, className = '') {
    const grid = document.createElement('dl');
    grid.className = `result-definition-grid ${className}`.trim();
    entries.forEach(([label, value]) => {
      const item = document.createElement('div');
      item.append(
        createTextElement('dt', label),
        createTextElement('dd', value ?? '—'),
      );
      grid.appendChild(item);
    });
    return grid;
  }

  function createArtifactButton(label, target, enabled = true, options = {}) {
    const button = createTextElement('button', label, 'button secondary');
    button.type = 'button';
    button.disabled = !enabled;
    const withBusy = options.withBusy || root.PlannerUtils?.withBusy;
    const api = options.api || root.plannerApi || (typeof window !== 'undefined' ? window.plannerApi : null);
    const projectPath = () => options.getProjectPath?.() || null;
    button.addEventListener('click', () => {
      const run = async () => {
        await api.runProjectArtifactAction({ projectPath: projectPath(), target });
      };
      if (typeof withBusy === 'function') return withBusy(button, run, '正在打开…', options.showToast);
      return run();
    });
    return button;
  }

  function displayProvided(value, suffix = '') {
    return value == null || value === '' ? '未提供' : `${value}${suffix}`;
  }

  function fillList(list, values) {
    list.replaceChildren();
    values.forEach((value) => list.appendChild(createTextElement('li', value)));
  }

  return {
    createTextElement,
    formatDateTime,
    formatResultDuration,
    formatVideoSpec,
    resultStatusClass,
    createResultSection,
    createDefinitionGrid,
    createArtifactButton,
    displayProvided,
    fillList,
  };
}));
