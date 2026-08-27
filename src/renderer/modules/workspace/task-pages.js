(function createPlannerTaskPages(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerTaskPages = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function text(tag, value, className = '') {
    return (root.PlannerDom || root.PlannerUtils).createTextElement(tag, value, className);
  }

  function sourceDirectoryOf(snap) {
    return snap.route.sourceDirectory
      || snap.currentEpisode?.sourceDirectory
      || snap.projectResult?.project?.sourceDirectory
      || null;
  }

  function mount({ data, root: rootEl }) {
    const brief = rootEl.querySelector('#pageBrief');
    const processing = rootEl.querySelector('#pageProcessing');
    const results = rootEl.querySelector('#pageResults');
    if (!brief || !processing || !results) return;

    async function startAiEdit(extraRequirements, kind) {
      const snap = data.get();
      const sourceDirectory = sourceDirectoryOf(snap);
      if (!sourceDirectory) {
        data.toast('没有可交接的素材目录。', true);
        return;
      }
      const current = snap.runningOverlays?.handoffTask;
      if (current && ['handed_off', 'running'].includes(current.lifecycle)) {
        data.toast('当前任务仍在处理中。请先取消或等待完成。', true);
        return;
      }
      try {
        if (current?.status === 'agent_disconnected') {
          await takeoverTask(current, 'resume_after_disconnect', extraRequirements);
          return;
        }
        const created = await window.plannerApi.startEditHandoff({
          sourceDirectory,
          platformMode: snap.route.platformMode || 'main',
          extraRequirements: extraRequirements == null ? '' : String(extraRequirements),
          kind: kind === 'revise' ? 'revise' : 'edit',
          parentTaskId: current?.taskId || null,
          previousProjectPath: snap.route.previousProjectPath || null,
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
        await window.plannerApi.launchCodexHandoff(task.taskFilePath);
        data.patch({
          runningOverlays: { ...data.get().runningOverlays, handoffTask: null },
        });
        data.toast('AI 剪辑任务已交接');
      } catch (error) {
        data.toast(root.PlannerUtils.getUserErrorMessage(error), true);
      }
    }

    async function cancelTask(task) {
      if (!task?.taskFilePath) return;
      try {
        const cancelled = await window.plannerApi.cancelHandoffTask(task.taskFilePath);
        data.patch({
          runningOverlays: { ...data.get().runningOverlays, handoffTask: cancelled },
        });
        data.routeStore.set({ workspacePhase: 'brief', projectPage: 'brief' });
        data.toast('任务已取消');
      } catch (error) {
        data.toast(root.PlannerUtils.getUserErrorMessage(error), true);
      }
    }

    async function takeoverTask(task, reason, extraRequirements) {
      if (!task?.taskFilePath) return;
      try {
        const launched = await window.plannerApi.takeoverHandoffTask({
          taskPath: task.taskFilePath,
          reason,
          extraRequirements,
        });
        data.patch({
          runningOverlays: { ...data.get().runningOverlays, handoffTask: launched },
        });
        data.routeStore.set({
          sessionOpen: true,
          workspacePhase: 'processing',
          projectPage: 'processing',
        });
        data.toast('已重新交回 AI');
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

      const summary = root.PlannerDom.createResultSection('本期素材');
      summary.appendChild(root.PlannerDom.createDefinitionGrid([
        ['本期视频名', episode.name || snap.route.sourceDirectory || '—'],
        ['来源', inventory?.detected ? 'HotIngest' : (episode.name ? '普通素材' : '—')],
        ['额外要求', snap.route.extraRequirements ? '已填写' : '无'],
      ]));
      brief.appendChild(summary);

      const extras = document.createElement('label');
      extras.className = 'extra-requirements';
      extras.append(
        text('strong', '本次额外要求'),
        text('p', '可留空。内容会原样交给 AI，不改写、不省略。', 'muted'),
      );
      const textarea = document.createElement('textarea');
      textarea.rows = 6;
      textarea.placeholder = phase === 'revise'
        ? '例如：第二条开头换成狗；字幕往上；这一段不要裁人物'
        : '本次额外要求';
      textarea.value = snap.route.extraRequirements || '';
      textarea.addEventListener('input', () => data.routeStore.set({ extraRequirements: textarea.value }));
      extras.appendChild(textarea);
      brief.appendChild(extras);

      const start = text('button', phase === 'revise' ? '让 AI 再改一次' : '开始剪辑', 'button primary extra-start');
      start.type = 'button';
      start.addEventListener('click', () => startAiEdit(textarea.value, phase === 'revise' ? 'revise' : 'edit'));
      brief.appendChild(start);
    }

    function renderProcessing(snap) {
      if (!snap.route.sessionOpen) return;
      if ((snap.route.workspacePhase || snap.route.projectPage) !== 'processing') return;
      processing.replaceChildren();
      const task = snap.runningOverlays?.handoffTask;
      const disconnected = task?.status === 'agent_disconnected' || task?.lifecycle === 'agent_disconnected';
      const title = disconnected ? 'AI 已停止，任务未完成' : 'AI 正在处理';
      processing.append(
        text('h3', title),
        text('p', task?.stageMessage || '已交接，等待 AI 返回。', 'muted'),
      );
      if (!disconnected && task) {
        const status = document.createElement('ol');
        status.className = 'process-steps';
        [
          ['已交接', true],
          ['正在分析', /analyz|planning|extract|scanning/i.test(task.status || '')],
          ['正在生成', /build|render|generat|verif/i.test(task.status || '')],
          ['已完成', ['completed', 'completed_with_warnings'].includes(task.status)],
        ].forEach(([label, on]) => {
          const item = text('li', label, on ? 'on' : '');
          status.appendChild(item);
        });
        processing.appendChild(status);
      }
      const actions = document.createElement('div');
      actions.className = 'result-actions';
      if (task) {
        const reopen = text('button', disconnected ? '继续任务' : '打开 AI 窗口', 'button secondary');
        reopen.type = 'button';
        reopen.addEventListener('click', () => window.plannerApi.activateCodexHandoff(task.taskFilePath));
        const cancel = text('button', '取消任务', 'button ghost');
        cancel.type = 'button';
        cancel.addEventListener('click', () => cancelTask(task));
        actions.append(reopen, cancel);
      }
      processing.appendChild(actions);
    }

    function artifactRow(grid, result) {
      const fcpxml = result?.artifacts?.fcpxml;
      grid.push(
        ['FCPXML', fcpxml?.path || (fcpxml?.exists ? '存在' : '尚未生成')],
        ['验证', result?.verifiedAt ? root.PlannerUtils.formatDateTime(result.verifiedAt) : '未运行'],
      );
    }

    function renderResults(snap) {
      if (!snap.route.sessionOpen) return;
      if ((snap.route.workspacePhase || snap.route.projectPage) !== 'results') return;
      results.replaceChildren();
      const task = snap.runningOverlays?.handoffTask;
      const result = snap.projectResult;
      const failed = task?.status === 'failed' || snap.route.error;
      if (failed) {
        const banner = document.createElement('div');
        banner.className = 'notice warning';
        banner.append(text('strong',
          task?.errors?.[0]?.message || snap.route.error || task?.stageMessage || 'AI 剪辑失败'));
        results.appendChild(banner);
        const retryActions = document.createElement('div');
        retryActions.className = 'result-actions';
        const retrySame = text('button', '重新交给 AI', 'button primary');
        retrySame.type = 'button';
        retrySame.addEventListener('click', () => takeoverTask(task, 'resume_after_failure', snap.route.extraRequirements));
        retryActions.append(retrySame);
        results.appendChild(retryActions);
        if (!result && !task?.resultProjectPath) return;
      }

      const section = root.PlannerDom.createResultSection(result?.project?.name || '剪辑结果');
      const rows = [
        ['状态', result?.project?.statusLabel || result?.project?.status || (failed ? '失败' : '—')],
      ];
      artifactRow(rows, result);
      const variantCount = Array.isArray(result?.platformVariants?.variants)
        ? result.platformVariants.variants.filter((item) => item.platform === 'douyin').length
        : 0;
      rows.push(['抖音变体', String(variantCount)]);
      section.appendChild(root.PlannerDom.createDefinitionGrid(rows));

      const bar = document.createElement('div');
      bar.className = 'result-actions';
      const fcp = text('button', '在 Final Cut Pro 中打开', 'button primary');
      fcp.type = 'button';
      fcp.addEventListener('click', async () => {
        try {
          await window.plannerApi.openProjectFcpxmlInFinalCut(snap.route.projectPath || result?.project?.path);
          data.toast('正在打开 Final Cut Pro');
        } catch (error) {
          data.toast(root.PlannerUtils.getUserErrorMessage(error), true);
        }
      });
      const folder = text('button', '打开项目目录', 'button ghost');
      folder.type = 'button';
      folder.addEventListener('click', () => window.plannerApi.runProjectArtifactAction?.({
        projectPath: snap.route.projectPath || result?.project?.path,
        target: 'exportDirectory',
      }));
      const revise = text('button', '让 AI 再改一次', 'button secondary');
      revise.type = 'button';
      revise.addEventListener('click', () => data.routeStore.set({
        workspacePhase: 'revise',
        projectPage: 'brief',
        extraRequirements: '',
      }));
      bar.append(fcp, folder, revise);
      section.appendChild(bar);
      results.appendChild(section);
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
