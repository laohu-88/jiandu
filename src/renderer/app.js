(async function bootPlannerApp() {
  const toastEl = document.querySelector('#toast');
  const toast = window.PlannerUtils.createToastHelper(toastEl);
  const ipc = window.PlannerIpcClient.createIpcClient(window.plannerApi);
  const data = window.PlannerAppData.create({ api: ipc, toast });

  window.__plannerData = data;
  window.PlannerShell.mount({ data, root: document.body });

  try {
    const config = await window.plannerApi.getConfig();
    data.patch({ config });
    const version = document.querySelector('#version');
    if (version && config?.version) version.textContent = `v${config.version}`;
    try {
      const settings = await window.plannerApi.loadHandoffSettings();
      data.patch({ autoOpenFcp: settings?.autoOpenFcp === true });
    } catch (_error) {
      // optional on first boot
    }
  } catch (error) {
    toast(window.PlannerUtils.getUserErrorMessage(error), true);
  }

  await data.init();
}());
