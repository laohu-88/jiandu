const {
  scanAssets,
  loadAssetIndex,
  getAssetPreview,
  readTextPreview,
  updateAssetReview,
} = require('../services/media-service');

function registerAssetsIpc(ctx) {
  const { ipcMain } = ctx;

  ipcMain.handle('assets:scan', (_event, projectPath) =>
    scanAssets(projectPath));

  ipcMain.handle('assets:load-index', (_event, projectPath) =>
    loadAssetIndex(projectPath));

  ipcMain.handle('assets:update-review', (_event, args) =>
    updateAssetReview(args.projectPath, args.stableId, args.patch));

  ipcMain.handle('assets:get-preview', (_event, args) =>
    getAssetPreview(args.projectPath, args.stableId));

  ipcMain.handle('assets:read-text-preview', (_event, args) =>
    readTextPreview(args.projectPath, args.stableId, args.maxBytes));
}

module.exports = { registerAssetsIpc };
