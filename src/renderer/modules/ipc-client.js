(function createPlannerIpcClient(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PlannerIpcClient = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function resolveApi(injected) {
    if (injected && typeof injected === 'object') return injected;
    if (typeof globalThis !== 'undefined' && globalThis.plannerApi) {
      return globalThis.plannerApi;
    }
    if (typeof window !== 'undefined' && window.plannerApi) {
      return window.plannerApi;
    }
    return null;
  }

  function missingApiError(method) {
    return Object.assign(
      new Error(`plannerApi 不可用，无法调用 ${method}。请确认预加载脚本已注入。`),
      { code: 'PLANNER_API_MISSING', method },
    );
  }

  function call(api, method, args) {
    if (!api || typeof api[method] !== 'function') {
      throw missingApiError(method);
    }
    return api[method](...args);
  }

  function createIpcClient(injectedApi) {
    const api = resolveApi(injectedApi);

    return {
      getApi: () => api,
      getConfig: (...args) => call(api, 'getConfig', args),
      scanPendingMedia: (...args) => call(api, 'scanPendingMedia', args),
      showPendingMediaInFinder: (...args) => call(api, 'showPendingMediaInFinder', args),
      scanProjectCatalog: (...args) => call(api, 'scanProjectCatalog', args),
      getCodexProjectResult: (...args) => call(api, 'getCodexProjectResult', args),
      createDouyinVariant: (...args) => call(api, 'createDouyinVariant', args),
      readDouyinVariant: (...args) => call(api, 'readDouyinVariant', args),
      saveDouyinVariant: (...args) => call(api, 'saveDouyinVariant', args),
      approveDouyinVariant: (...args) => call(api, 'approveDouyinVariant', args),
      buildDouyinVariant: (...args) => call(api, 'buildDouyinVariant', args),
      verifyDouyinVariant: (...args) => call(api, 'verifyDouyinVariant', args),
      runDouyinArtifactAction: (...args) => call(api, 'runDouyinArtifactAction', args),
      openDouyinFcpxmlInFinalCut: (...args) => call(api, 'openDouyinFcpxmlInFinalCut', args),
      openProjectFcpxmlInFinalCut: (...args) => call(api, 'openProjectFcpxmlInFinalCut', args),
      runProjectArtifactAction: (...args) => call(api, 'runProjectArtifactAction', args),
      createHandoffTask: (...args) => call(api, 'createHandoffTask', args),
      startEditHandoff: (...args) => call(api, 'startEditHandoff', args),
      recognizeHandoffSource: (...args) => call(api, 'recognizeHandoffSource', args),
      checkCursorAccessibility: (...args) => call(api, 'checkCursorAccessibility', args),
      launchCodexHandoff: (...args) => call(api, 'launchCodexHandoff', args),
      launchCursorHandoff: (...args) => call(api, 'launchCursorHandoff', args),
      loadHandoffSettings: (...args) => call(api, 'loadHandoffSettings', args),
      saveHandoffSettings: (...args) => call(api, 'saveHandoffSettings', args),
      buildEditPreflight: (...args) => call(api, 'buildEditPreflight', args),
      createEditJob: (...args) => call(api, 'createEditJob', args),
      selectMaterialDirectory: (...args) => call(api, 'selectMaterialDirectory', args),
      analyzeDouyinShotTracking: (...args) => call(api, 'analyzeDouyinShotTracking', args),
      call: (method, ...args) => call(api, method, args),
    };
  }

  const defaultClient = createIpcClient();
  return {
    createIpcClient,
    ...defaultClient,
  };
}));
