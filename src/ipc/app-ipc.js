const { DEFAULT_PROJECT_ROOT } = require('../constants');
const { DEFAULT_PENDING_ROOT } = require('../services/pending-media-catalog-service');
const { getProviderStatus } = require('../services/provider-status-service');

function registerAppIpc(ctx) {
  const { app, ipcMain } = ctx;

  ipcMain.handle('app:get-config', async () => ({
    version: app.getVersion(),
    defaultProjectRoot: DEFAULT_PROJECT_ROOT,
    defaultPendingRoot: DEFAULT_PENDING_ROOT,
    providers: await getProviderStatus(),
  }));
}

module.exports = { registerAppIpc };
