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
      return stateStore.set({ nav, projectPath: nav === 'library' || nav === 'pending'
        ? (nav === 'pending' ? null : stateStore.get().projectPath)
        : stateStore.get().projectPath });
    }

    function openProject(projectPath) {
      return stateStore.set({
        nav: 'tasks',
        projectPath: projectPath == null ? null : String(projectPath),
        projectPage: 'overview',
        douyinStage: 'plan',
        error: null,
      });
    }

    function setProjectPage(projectPage) {
      return stateStore.set({ projectPage });
    }

    function setDouyinStage(douyinStage) {
      return stateStore.set({
        projectPage: 'douyin',
        douyinStage,
      });
    }

    return {
      navigate,
      openProject,
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
    setProjectPage: defaultRouter.setProjectPage,
    setDouyinStage: defaultRouter.setDouyinStage,
    getState: defaultRouter.getState,
  };
}));
