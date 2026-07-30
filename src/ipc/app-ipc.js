const { DEFAULT_PROJECT_ROOT } = require('../constants');
const { DEFAULT_PENDING_ROOT } = require('../services/pending-media-catalog-service');

function registerAppIpc(ctx) {
  const { app, ipcMain } = ctx;

  ipcMain.handle('app:get-config', () => ({
    version: app.getVersion(),
    defaultProjectRoot: DEFAULT_PROJECT_ROOT,
    defaultPendingRoot: DEFAULT_PENDING_ROOT,
  }));
}

module.exports = { registerAppIpc };
