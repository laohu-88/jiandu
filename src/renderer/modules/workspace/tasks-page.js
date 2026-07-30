(function createPlannerTasksPage(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerTasksPage = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function text(tag, value, className = '') {
    return (root.PlannerDom || root.PlannerUtils).createTextElement(tag, value, className);
  }

  function mount({ data, root: rootEl, router }) {
    const view = rootEl.querySelector('#tasksView');
    if (!view) return;

    function render(snap) {
      if (snap.route.nav !== 'tasks' || snap.route.projectPath) return;
      view.replaceChildren();
      view.append(
        text('h2', '当前任务'),
        text('p', '交接、剪辑任务与打开中的项目会出现在这里。', 'muted'),
      );

      const overlays = snap.runningOverlays || {};
      const cards = document.createElement('div');
      cards.className = 'tasks-list';

      if (overlays.handoffTask) {
        const card = document.createElement('article');
        card.className = 'task-row';
        card.append(
          text('strong', '交接任务'),
          text('p', overlays.handoffTask.sourceSummary?.name || overlays.handoffTask.id || '进行中'),
        );
        cards.appendChild(card);
      }
      if (overlays.editJob) {
        const card = document.createElement('article');
        card.className = 'task-row';
        card.append(
          text('strong', '剪辑任务'),
          text('p', overlays.editJob.name || overlays.editJob.id || '进行中'),
        );
        cards.appendChild(card);
      }
      if (!cards.children.length) {
        cards.appendChild(text('div', '暂无运行中的任务。可从待处理素材发起，或从项目库打开项目。', 'empty-state'));
      }
      const toLibrary = text('button', '前往项目库', 'button secondary');
      toLibrary.type = 'button';
      toLibrary.addEventListener('click', () => router.navigate('library'));
      view.append(cards, toLibrary);
    }

    data.subscribe(render);
    render(data.get());
  }

  return { mount };
}));
