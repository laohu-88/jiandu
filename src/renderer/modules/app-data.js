(function createPlannerAppData(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerAppData = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function resolveRouteStore() {
    if (root.PlannerState) return root.PlannerState;
    if (typeof module === 'object' && module.exports) {
      // eslint-disable-next-line global-require
      return require('./state');
    }
    throw new Error('PlannerAppData 需要 PlannerState。');
  }

  function resolveIpc(injected) {
    if (injected) return injected;
    if (root.PlannerIpcClient?.createIpcClient) {
      return root.PlannerIpcClient.createIpcClient(root.plannerApi || (typeof window !== 'undefined' ? window.plannerApi : null));
    }
    return root.plannerApi || (typeof window !== 'undefined' ? window.plannerApi : null);
  }

  function create(options = {}) {
    const routeStore = options.store || resolveRouteStore();
    const api = resolveIpc(options.api);
    const toast = options.toast || (() => {});
    const utils = root.PlannerUtils || {};
    const getError = utils.getUserErrorMessage || ((error) => error?.message || String(error));
    const listeners = new Set();

    const data = {
      config: null,
      catalog: null,
      catalogQuery: '',
      catalogSort: 'updatedAt',
      pendingCatalog: null,
      projectResult: null,
      runningOverlays: { handoffTask: null },
      currentEpisode: null,
      sourceRecognition: null,
      autoOpenFcp: false,
      error: null,
      loading: { catalog: false, pending: false, project: false },
    };

    function snapshot() {
      const task = data.runningOverlays.handoffTask;
      const route = routeStore.get();
      return {
        route,
        ...data,
        workspaceHeader: {
          name: data.projectResult?.project?.name
            || data.currentEpisode?.name
            || route.sourceDirectory
            || null,
          status: task?.stageMessage
            || data.projectResult?.project?.statusLabel
            || null,
        },
      };
    }

    function notify() {
      const snap = snapshot();
      for (const listener of listeners) listener(snap);
      return snap;
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('subscribe 需要函数');
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function patch(partial = {}) {
      Object.assign(data, partial);
      return notify();
    }

    async function init() {
      try {
        if (api?.getConfig) {
          data.config = await api.getConfig();
          data.autoOpenFcp = Boolean(data.config?.autoOpenFcp);
        }
      } catch (error) {
        data.error = getError(error);
      }
      await Promise.all([
        refreshPending().catch(() => null),
        refreshCatalog().catch(() => null),
        recoverAgentSession().catch(() => null),
      ]);
      return notify();
    }

    async function refreshPending() {
      data.loading.pending = true;
      notify();
      try {
        data.pendingCatalog = await api.scanPendingMedia();
        data.error = null;
      } catch (error) {
        data.error = getError(error);
        toast(data.error, true);
      } finally {
        data.loading.pending = false;
      }
      return notify();
    }

    async function refreshCatalog() {
      data.loading.catalog = true;
      notify();
      try {
        data.catalog = await api.scanProjectCatalog();
        data.error = null;
      } catch (error) {
        data.error = getError(error);
        toast(data.error, true);
      } finally {
        data.loading.catalog = false;
      }
      return notify();
    }

    function getCatalogRows() {
      const items = data.catalog?.projects || data.catalog?.items || [];
      return [...items]
        .map((item) => ({
          ...item,
          name: item.name || item.projectName,
          updatedAt: item.updatedAt || item.generatedAt || item.verifiedAt || item.filesystemTime || null,
        }))
        .filter((row) => {
          const query = String(data.catalogQuery || '').trim().toLowerCase();
          if (!query) return true;
          return `${row.name || ''} ${row.theme || ''}`.toLowerCase().includes(query);
        })
        .sort((left, right) => {
          if (data.catalogSort === 'name') {
            return String(left.name).localeCompare(String(right.name), 'zh-CN');
          }
          return (Date.parse(right.updatedAt || 0) || 0) - (Date.parse(left.updatedAt || 0) || 0);
        });
    }

    async function openProject(projectPath) {
      if (!projectPath) return notify();
      routeStore.set({
        nav: 'library',
        sessionOpen: true,
        projectPath: String(projectPath),
        previousProjectPath: String(projectPath),
        projectPage: 'results',
        workspacePhase: 'results',
        error: null,
      });
      return refreshProject(projectPath);
    }

    async function openPendingEpisode(sourceDirectory, extras = {}) {
      routeStore.set({
        nav: 'pending',
        sessionOpen: true,
        sourceDirectory: String(sourceDirectory),
        projectPath: extras.projectPath || null,
        previousProjectPath: extras.previousProjectPath || null,
        projectPage: 'brief',
        workspacePhase: 'brief',
        platformMode: extras.platformMode || 'main',
        extraRequirements: extras.extraRequirements || '',
        error: null,
      });
      try {
        if (window.plannerApi?.recognizeHandoffSource) {
          data.sourceRecognition = await window.plannerApi.recognizeHandoffSource(String(sourceDirectory));
          data.currentEpisode = data.sourceRecognition?.episode || data.currentEpisode;
        }
      } catch (error) {
        data.error = getError(error);
      }
      return notify();
    }

    async function refreshProject(projectPath = routeStore.get().projectPath) {
      if (!projectPath) {
        data.projectResult = null;
        return notify();
      }
      data.loading.project = true;
      notify();
      try {
        data.projectResult = await api.getCodexProjectResult(projectPath);
        data.error = null;
      } catch (error) {
        data.error = getError(error);
        data.projectResult = { error: data.error, project: { path: projectPath, name: projectPath } };
        toast(data.error, true);
      } finally {
        data.loading.project = false;
      }
      return notify();
    }

    function closeProject() {
      routeStore.set({
        nav: routeStore.get().nav === 'pending' ? 'pending' : 'library',
        sessionOpen: false,
        projectPath: null,
        sourceDirectory: null,
        projectPage: 'brief',
        workspacePhase: 'brief',
      });
      data.projectResult = null;
      data.runningOverlays.handoffTask = null;
      return notify();
    }

    function handleAgentReturn(task) {
      if (!task) return notify();
      data.runningOverlays.handoffTask = task;
      const failed = task.status === 'failed';
      const ready = task.status === 'completed' || task.status === 'completed_with_warnings';
      const cancelled = task.status === 'cancelled';
      const disconnected = task.status === 'agent_disconnected' || task.lifecycle === 'agent_disconnected';
      if (cancelled) {
        routeStore.set({
          sessionOpen: true,
          sourceDirectory: task.sourceDirectory || routeStore.get().sourceDirectory,
          workspacePhase: 'brief',
          projectPage: 'brief',
          error: null,
        });
        return notify();
      }
      if (task.resultProjectPath && !disconnected) {
        routeStore.set({
          nav: 'library',
          sessionOpen: true,
          projectPath: task.resultProjectPath,
          previousProjectPath: task.resultProjectPath,
          sourceDirectory: task.sourceDirectory,
          workspacePhase: 'results',
          projectPage: 'results',
          error: failed ? (task.errors?.[0]?.message || 'AI 剪辑失败') : null,
        });
        void refreshProject(task.resultProjectPath);
      } else if (!routeStore.get().sessionOpen) {
        routeStore.set({
          sessionOpen: true,
          nav: 'pending',
          sourceDirectory: task.sourceDirectory,
          workspacePhase: disconnected ? 'processing' : (ready || failed ? 'results' : 'processing'),
          projectPage: disconnected ? 'processing' : (ready || failed ? 'results' : 'processing'),
        });
      }
      if (ready) toast('AI 剪辑结果已就绪');
      if (failed) toast(task.errors?.[0]?.message || 'AI 剪辑失败', true);
      return notify();
    }

    function handleAgentProgress(payload) {
      const task = payload?.task || payload;
      if (!task) return notify();
      const previous = data.runningOverlays.handoffTask;
      if (previous?.currentAttempt?.attemptId
        && task.currentAttempt?.attemptId
        && previous.currentAttempt.attemptId !== task.currentAttempt.attemptId
        && Date.parse(task.updatedAt || 0) < Date.parse(previous.updatedAt || 0)) {
        return notify();
      }
      data.runningOverlays.handoffTask = task;
      if (routeStore.get().sessionOpen) {
        const terminal = ['completed', 'completed_with_warnings', 'failed'].includes(task.status);
        const cancelled = task.status === 'cancelled';
        const phase = cancelled ? 'brief' : (terminal ? 'results' : 'processing');
        routeStore.set({ workspacePhase: phase, projectPage: phase });
      }
      return notify();
    }

    async function recoverAgentSession() {
      try {
        if (window.plannerApi?.reconcileHandoffTasks) {
          await window.plannerApi.reconcileHandoffTasks();
        }
        const listed = await window.plannerApi.listHandoffTasks();
        const tasks = listed?.tasks || [];
        const active = tasks
          .filter((task) => !['cancelled', 'draft', 'ready', 'completed', 'completed_with_warnings', 'failed'].includes(task.status))
          .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))[0];
        if (!active) return notify();
        data.runningOverlays.handoffTask = active;
        routeStore.set({
          sessionOpen: true,
          nav: active.resultProjectPath ? 'library' : 'pending',
          sourceDirectory: active.sourceDirectory,
          projectPath: active.resultProjectPath || null,
          workspacePhase: 'processing',
          projectPage: 'processing',
        });
      } catch (_error) {
        // 启动恢复尽力而为。
      }
      return notify();
    }

    routeStore.subscribe(() => notify());

    return {
      get: snapshot,
      subscribe,
      patch,
      init,
      refreshPending,
      refreshCatalog,
      openProject,
      openPendingEpisode,
      refreshProject,
      closeProject,
      getCatalogRows,
      handleAgentReturn,
      handleAgentProgress,
      recoverAgentSession,
      routeStore,
      api,
      toast,
    };
  }

  return { create };
}));
