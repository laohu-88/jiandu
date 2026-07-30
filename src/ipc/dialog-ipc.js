const { DEFAULT_PROJECT_ROOT } = require('../constants');
const { DEFAULT_PENDING_ROOT } = require('../services/pending-media-catalog-service');

function registerDialogIpc(ctx) {
  const { ipcMain, dialog, getMainWindow } = ctx;

  ipcMain.handle('dialog:select-root', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择项目根目录',
      defaultPath: DEFAULT_PROJECT_ROOT,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:select-material', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择素材项目目录',
      defaultPath: DEFAULT_PENDING_ROOT,
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

module.exports = { registerDialogIpc };
