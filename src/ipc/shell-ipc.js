function registerShellIpc(ctx) {
  const { ipcMain, shell, resolveAuthorizedItem } = ctx;

  ipcMain.handle('shell:show-item', async (_event, args) => {
    const item = await resolveAuthorizedItem(args, 'file');
    if (!item.exists) throw new Error('文件不存在。');
    shell.showItemInFolder(item.path);
  });

  ipcMain.handle('shell:open-folder', async (_event, args) => {
    const item = await resolveAuthorizedItem(args, 'directory');
    if (!item.exists) throw new Error('目录不存在。');
    const error = await shell.openPath(item.path);
    if (error) throw new Error(error);
    return { opened: true };
  });
}

module.exports = { registerShellIpc };
