const {
  createProject,
  openProject,
  ensureProjectDirs,
} = require('../services/project-service');
const { saveRecentProject } = require('../services/stage7-service');

function registerProjectIpc(ctx) {
  const { app, ipcMain, dialog, getMainWindow, authorizeProject } = ctx;

  ipcMain.handle('project:create', (_event, args) =>
    createProject(args.rootPath, args.projectName).then(async (result) => {
      authorizeProject(result.project.projectPath);
      await saveRecentProject(app.getPath('userData'), result.project);
      return result;
    }));

  ipcMain.handle('project:choose-open', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择已有项目文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    const opened = await openProject(result.filePaths[0]);
    authorizeProject(opened.project.projectPath);
    await saveRecentProject(app.getPath('userData'), opened.project);
    return opened;
  });

  ipcMain.handle('project:open-path', async (_event, projectPath) => {
    const opened = await openProject(projectPath);
    authorizeProject(opened.project.projectPath);
    await saveRecentProject(app.getPath('userData'), opened.project);
    return opened;
  });

  ipcMain.handle('project:ensure-dirs', (_event, projectPath) =>
    ensureProjectDirs(projectPath));
}

module.exports = { registerProjectIpc };
