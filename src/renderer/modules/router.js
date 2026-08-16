(function createPlannerRouter(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PlannerRouter = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function resolveStore(store) {
    if (store && typeof store.get === 'function' && typeof store.set === 'function') {
      return store;
    }
    if (typeof module === 'object' && module.exports) {
      // eslint-disable-next-line global-require
      return require('./state');
    }
    if (root.PlannerState) return root.PlannerState;
    throw new Error('PlannerRouter 需要 PlannerState 存储。');
  }

  function createRouter(store) {
    const stateStore = resolveStore(store);

    function navigate(nav) {
      return stateStore.set({
        nav,
        sessionOpen: false,
      });
    }

    function openProject(projectPath, extras = {}) {
      return stateStore.set({
        nav: 'library',
        sessionOpen: true,
        projectPath: projectPath == null ? null : String(projectPath),
        sourceDirectory: extras.sourceDirectory || stateStore.get().sourceDirectory || null,
        projectPage: extras.projectPage || 'results',
        workspacePhase: extras.workspacePhase || 'results',
        platformMode: extras.platformMode || 'douyin',
        engine: extras.engine || stateStore.get().engine || 'cursor_agent',
        douyinStage: 'plan',
        error: null,
      });
    }

    function openPendingEpisode(sourceDirectory, extras = {}) {
      return stateStore.set({
        nav: 'pending',
        sessionOpen: true,
        sourceDirectory: String(sourceDirectory),
        projectPath: extras.projectPath || null,
        projectPage: extras.projectPage || 'brief',
        workspacePhase: extras.workspacePhase || 'brief',
        platformMode: extras.platformMode || 'douyin',
        engine: extras.engine || 'cursor_agent',
        extraRequirements: extras.extraRequirements || '',
        error: null,
      });
    }

    function setProjectPage(projectPage) {
      return stateStore.set({
        projectPage,
        workspacePhase: projectPage,
      });
    }

    function setDouyinStage(douyinStage) {
      return stateStore.set({
        projectPage: 'advanced',
        workspacePhase: 'advanced',
        douyinStage,
      });
    }

    return {
      navigate,
      openProject,
      openPendingEpisode,
      setProjectPage,
      setDouyinStage,
      getState: () => stateStore.get(),
    };
  }

  const defaultRouter = createRouter();
  return {
    createRouter,
    navigate: defaultRouter.navigate,
    openProject: defaultRouter.openProject,
    openPendingEpisode: defaultRouter.openPendingEpisode,
    setProjectPage: defaultRouter.setProjectPage,
    setDouyinStage: defaultRouter.setDouyinStage,
    getState: defaultRouter.getState,
  };
}));
