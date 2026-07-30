(function createPlannerState(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PlannerState = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function loadBuildAppRouteState() {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      return require('../../view-models/workspace-view-model').buildAppRouteState;
    } catch (_error) {
      const workspace = root.WorkspaceViewModel;
      if (workspace && typeof workspace.buildAppRouteState === 'function') {
        return workspace.buildAppRouteState;
      }
      return (partial = {}) => ({
        nav: partial.nav || 'pending',
        projectPath: partial.projectPath ?? null,
        projectPage: partial.projectPage || 'overview',
        douyinStage: partial.douyinStage || 'plan',
        douyinVariantId: partial.douyinVariantId ?? null,
        assetFilter: partial.assetFilter || 'all',
        issueFilters: partial.issueFilters || {
          levels: null,
          videoId: null,
          shotId: null,
          assetId: null,
          unresolvedOnly: false,
        },
        runningTask: partial.runningTask ?? null,
        error: partial.error ?? null,
      });
    }
  }

  const buildAppRouteState = loadBuildAppRouteState();
  let state = buildAppRouteState();
  const listeners = new Set();

  function get() {
    return state;
  }

  function set(partial = {}) {
    state = buildAppRouteState({ ...state, ...partial });
    for (const listener of listeners) listener(state);
    return state;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('subscribe(listener) 需要函数。');
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function reset(partial = {}) {
    state = buildAppRouteState(partial);
    for (const listener of listeners) listener(state);
    return state;
  }

  return {
    get,
    set,
    subscribe,
    reset,
    buildAppRouteState,
  };
}));
