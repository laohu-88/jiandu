const path = require('node:path');

function registerPendingIpc(ctx) {
  const { ipcMain, shell, scanHandoffsAndPending } = ctx;

  ipcMain.handle('pending:scan', () => scanHandoffsAndPending());

  ipcMain.handle('pending:show-in-finder', async (_event, sourceDirectory) => {
    const payload = await scanHandoffsAndPending();
    const episode = payload.episodes.find((item) => item.sourceDirectory === path.resolve(sourceDirectory));
    if (!episode) throw new Error('所选素材目录未通过待处理目录授权。');
    shell.showItemInFolder(episode.sourceDirectoryRealPath);
    return { shown: true };
  });
}

module.exports = { registerPendingIpc };
