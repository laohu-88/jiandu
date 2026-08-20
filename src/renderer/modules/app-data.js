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

  function resolveViewModels() {
    return root.PlannerViewModels
      || root.IssueCenterViewModel && root.DouyinWorkflowViewModel && root.WorkspaceViewModel && {
        ...root.IssueCenterViewModel,
        ...root.DouyinWorkflowViewModel,
        ...root.WorkspaceViewModel,
      }
      || {};
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
      catalogStatus: 'all',
      pendingCatalog: null,
      projectResult: null,
      douyinVariant: null,
      draftPlan: null,
      draftDirty: false,
      approvedWarningIds: [],
      douyinPreview: null,
      selectedAssetId: null,
      assetSearch: '',
      libraryCollapsed: false,
      libraryWidth: 320,
      inspectorCollapsed: false,
      runningOverlays: {
        editPreflight: null,
        editJob: null,
        handoffTask: null,
        completion: null,
      },
      aiEnvironment: null,
      accessibility: null,
      defaultEngine: 'codex',
      currentEpisode: null,
      sourceRecognition: null,
      selectedVideoId: null,
      selectedOutput: null,
      autoOpenFcp: false,
      error: null,
      loading: {
        catalog: false,
        project: false,
        variant: false,
        pending: false,
      },
    };

    function snapshot() {
      return {
        route: routeStore.get(),
        ...data,
        issues: deriveIssues(),
        issueSummary: deriveIssueSummary(),
        douyinWorkflow: deriveDouyinWorkflow(),
        workspaceHeader: deriveWorkspaceHeader(),
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

    function deriveIssues() {
      const vm = resolveViewModels();
      if (!vm.classifyDouyinIssues) return [];
      const readability = [];
      const plan = data.draftPlan || data.douyinVariant?.plan;
      if (plan?.videos && root.DouyinEditorCore?.douyinReadabilityFindings) {
        for (const video of plan.videos) {
          for (const shot of video.shots || []) {
            for (const message of root.DouyinEditorCore.douyinReadabilityFindings(shot)) {
              readability.push({
                message,
                videoId: video.videoId,
                shotId: shot.shotId,
                assetId: shot.assetId,
              });
            }
          }
        }
      }
      return vm.classifyDouyinIssues({
        variant: data.douyinVariant
          ? { ...data.douyinVariant, plan: plan || data.douyinVariant.plan }
          : null,
        approvedWarningIds: data.approvedWarningIds,
        readabilityFindings: readability,
      });
    }

    function deriveIssueSummary() {
      const vm = resolveViewModels();
      if (!vm.summarizeIssues) {
        return {
          total: 0, blocking: 0, confirm: 0, suggestion: 0, info: 0,
          unresolvedBlocking: 0, unresolvedConfirm: 0, unresolved: 0,
        };
      }
      return vm.summarizeIssues(deriveIssues());
    }

    function deriveDouyinWorkflow() {
      const vm = resolveViewModels();
      if (!vm.buildDouyinWorkflowViewModel) return null;
      return vm.buildDouyinWorkflowViewModel({
        variant: data.douyinVariant
          ? { ...data.douyinVariant, plan: data.draftPlan || data.douyinVariant.plan }
          : null,
        approvedWarningIds: data.approvedWarningIds,
        issueSummary: deriveIssueSummary(),
        draftDirty: data.draftDirty,
      });
    }

    function deriveWorkspaceHeader() {
      const vm = resolveViewModels();
      if (!vm.buildWorkspaceHeader) return null;
      const route = routeStore.get();
      return vm.buildWorkspaceHeader({
        result: data.projectResult,
        douyinVariant: data.douyinVariant,
        issueSummary: deriveIssueSummary(),
        activePage: route.workspacePhase || route.projectPage,
        douyinWorkflow: deriveDouyinWorkflow(),
        task: data.runningOverlays.handoffTask,
        platformMode: route.platformMode,
        engine: route.engine,
      });
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
      ]);
      return notify();
    }

    async function refreshPending() {
      data.loading.pending = true;
      notify();
      try {
        const call = api.scanPendingMedia || api.call?.bind(api, 'scanPendingMedia');
        data.pendingCatalog = await call();
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
        const call = api.scanProjectCatalog || api.call?.bind(api, 'scanProjectCatalog');
        data.catalog = await call();
        data.error = null;
      } catch (error) {
        data.error = getError(error);
        toast(data.error, true);
      } finally {
        data.loading.catalog = false;
      }
      return notify();
    }

    async function openProject(projectPath) {
      if (!projectPath) return notify();
      routeStore.set({
        nav: 'library',
        sessionOpen: true,
        projectPath: String(projectPath),
        projectPage: 'results',
        workspacePhase: 'results',
        douyinStage: 'plan',
        error: null,
      });
      return refreshProject(projectPath);
    }

    async function refreshProject(projectPath = routeStore.get().projectPath) {
      if (!projectPath) {
        data.projectResult = null;
        data.douyinVariant = null;
        data.draftPlan = null;
        data.draftDirty = false;
        data.approvedWarningIds = [];
        return notify();
      }
      data.loading.project = true;
      notify();
      try {
        const call = api.getCodexProjectResult || api.call?.bind(api, 'getCodexProjectResult');
        data.projectResult = await call(projectPath);
        data.error = null;
        await refreshDouyinVariant();
      } catch (error) {
        data.error = getError(error);
        data.projectResult = { error: data.error, project: { path: projectPath, name: projectPath } };
        toast(data.error, true);
      } finally {
        data.loading.project = false;
      }
      return notify();
    }

    async function refreshDouyinVariant(variantId) {
      const result = data.projectResult;
      const variants = result?.platformVariants?.variants || [];
      const douyinVariants = variants.filter((item) => item.platform === 'douyin');
      if (!douyinVariants.length) {
        data.douyinVariant = null;
        data.draftPlan = null;
        data.draftDirty = false;
        data.approvedWarningIds = [];
        return notify();
      }
      const route = routeStore.get();
      const preferred = variantId
        || route.douyinVariantId
        || douyinVariants[0].variantId;
      routeStore.set({ douyinVariantId: preferred });
      data.loading.variant = true;
      notify();
      try {
        const call = api.readDouyinVariant || api.call?.bind(api, 'readDouyinVariant');
        data.douyinVariant = await call({
          projectPath: result.project.path,
          variantId: preferred,
        });
        data.draftPlan = root.DouyinEditorCore?.cloneDouyinPlan
          ? root.DouyinEditorCore.cloneDouyinPlan(data.douyinVariant.plan)
          : JSON.parse(JSON.stringify(data.douyinVariant.plan));
        data.draftDirty = false;
        data.approvedWarningIds = [...(data.douyinVariant.approval?.approvedWarningIds || [])];
      } catch (error) {
        data.error = getError(error);
        toast(data.error, true);
      } finally {
        data.loading.variant = false;
      }
      return notify();
    }

    function setDraftPlan(plan, { dirty = true } = {}) {
      data.draftPlan = plan;
      data.draftDirty = dirty;
      return notify();
    }

    function setApprovedWarningIds(ids) {
      data.approvedWarningIds = [...ids];
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
        douyinStage: 'plan',
        douyinVariantId: null,
      });
      data.projectResult = null;
      data.douyinVariant = null;
      data.draftPlan = null;
      data.draftDirty = false;
      data.approvedWarningIds = [];
      return notify();
    }

    function getCatalogRows() {
      const vm = resolveViewModels();
      const items = data.catalog?.projects || data.catalog?.items || [];
      const rows = items.map((item) => {
        const enriched = {
          ...item,
          name: item.name || item.projectName,
          theme: item.theme || item.recommendedTitle,
          updatedAt: item.updatedAt || item.generatedAt || item.verifiedAt || item.filesystemTime || item.createdAt,
          mainStatus: item.mainStatus || item.statusLabel || item.status,
          douyinStatus: item.douyinStatus || item.platformStatus || '—',
          issueCounts: item.issueCounts || {
            blocking: item.errorCount || 0,
            confirm: item.warningCount || 0,
            suggestion: 0,
            info: 0,
          },
          projectPath: item.projectPath,
        };
        const base = vm.buildCatalogProjectRow
          ? vm.buildCatalogProjectRow(enriched)
          : enriched;
        return { ...base, raw: item };
      });
      const query = String(data.catalogQuery || '').trim().toLowerCase();
      let filtered = rows;
      if (query) {
        filtered = filtered.filter((row) => {
          const hay = `${row.name || ''} ${row.theme || ''} ${row.projectPath || ''}`.toLowerCase();
          return hay.includes(query);
        });
      }
      if (data.catalogStatus && data.catalogStatus !== 'all') {
        filtered = filtered.filter((row) => String(row.userStatus) === data.catalogStatus
          || String(row.mainStatus) === data.catalogStatus
          || String(row.douyinStatus) === data.catalogStatus);
      }
      const sort = data.catalogSort || 'updatedAt';
      filtered = [...filtered].sort((left, right) => {
        if (sort === 'name') return String(left.name).localeCompare(String(right.name), 'zh-CN');
        if (sort === 'issues') {
          const score = (row) => (row.issueCounts?.blocking || 0) * 1000
            + (row.issueCounts?.confirm || 0) * 100
            + (row.issueCounts?.suggestion || 0) * 10
            + (row.issueCounts?.info || 0);
          return score(right) - score(left);
        }
        const leftTime = Date.parse(left.updatedAt || 0) || 0;
        const rightTime = Date.parse(right.updatedAt || 0) || 0;
        return rightTime - leftTime;
      });
      return filtered;
    }

    async function recognizeSource(sourceDirectory) {
      if (!sourceDirectory || !window.plannerApi?.recognizeHandoffSource) return notify();
      try {
        const recognition = await window.plannerApi.recognizeHandoffSource(sourceDirectory);
        data.sourceRecognition = recognition;
        data.currentEpisode = recognition.episode || data.currentEpisode;
      } catch (error) {
        data.error = getError(error);
      }
      return notify();
    }

    async function handleAgentReturn(task) {
      if (!task) return notify();
      data.runningOverlays.handoffTask = task;
      const failed = task.status === 'failed';
      const ready = task.status === 'completed' || task.status === 'completed_with_warnings';
      const cancelled = task.status === 'cancelled';
      const disconnected = task.status === 'agent_disconnected' || task.lifecycle === 'agent_disconnected';
      const route = routeStore.get();
      if (cancelled) {
        routeStore.set({
          sessionOpen: true,
          sourceDirectory: task.sourceDirectory || route.sourceDirectory,
          workspacePhase: 'brief',
          projectPage: 'brief',
          engine: task.engine || route.engine,
          error: null,
        });
        return notify();
      }
      if (disconnected) {
        routeStore.set({
          sessionOpen: true,
          nav: 'library',
          sourceDirectory: task.sourceDirectory,
          projectPath: task.resultProjectPath || route.projectPath || null,
          workspacePhase: 'processing',
          projectPage: 'processing',
          engine: task.engine || route.engine,
          platformMode: task.platformMode || 'douyin',
          error: null,
        });
        return notify();
      }
      if (!route.sessionOpen && !failed && !ready && task.status !== 'analysis_complete') {
        return notify();
      }
      if (task.resultProjectPath) {
        routeStore.set({
          nav: 'library',
          sessionOpen: true,
          projectPath: task.resultProjectPath,
          sourceDirectory: task.sourceDirectory,
          workspacePhase: 'results',
          projectPage: 'results',
          engine: task.engine || routeStore.get().engine,
          platformMode: task.platformMode || 'douyin',
          error: failed ? (task.errors?.[0]?.message || 'Agent 失败') : null,
        });
        await refreshProject(task.resultProjectPath);
      } else {
        routeStore.set({
          sessionOpen: true,
          sourceDirectory: task.sourceDirectory,
          workspacePhase: failed ? 'results' : 'processing',
          projectPage: failed ? 'results' : 'processing',
          error: failed ? (task.errors?.[0]?.message || 'Agent 失败') : null,
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
      if (routeStore.get().sessionOpen || task.status === 'agent_disconnected') {
        const terminal = ['completed', 'completed_with_warnings', 'failed'].includes(task.status);
        const cancelled = task.status === 'cancelled';
        routeStore.set({
          workspacePhase: cancelled ? 'brief' : (terminal ? 'results' : 'processing'),
          projectPage: cancelled ? 'brief' : (terminal ? 'results' : 'processing'),
          engine: task.engine || routeStore.get().engine,
        });
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
          .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))[0]
          || tasks
            .filter((task) => ['completed', 'completed_with_warnings', 'failed'].includes(task.status)
              && !(task.returnState?.acknowledgedAt))
            .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))[0];
        if (!active) return notify();
        data.runningOverlays.handoffTask = active;
        if (['completed', 'completed_with_warnings', 'failed', 'agent_disconnected', 'cancelled'].includes(active.status)) {
          return handleAgentReturn(active);
        }
        routeStore.set({
          sessionOpen: true,
          nav: 'library',
          sourceDirectory: active.sourceDirectory,
          projectPath: active.resultProjectPath || null,
          workspacePhase: 'processing',
          projectPage: 'processing',
          engine: 'codex',
          platformMode: active.platformMode || 'douyin',
        });
      } catch (_error) {
        // Recovery is best-effort on boot.
      }
      return notify();
    }

    routeStore.subscribe(() => notify());

    return {
      create,
      get: snapshot,
      subscribe,
      patch,
      init,
      refreshPending,
      refreshCatalog,
      openProject,
      refreshProject,
      refreshDouyinVariant,
      setDraftPlan,
      setApprovedWarningIds,
      closeProject,
      getCatalogRows,
      recognizeSource,
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
