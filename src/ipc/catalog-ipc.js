const { DEFAULT_PROJECT_ROOT } = require('../constants');
const {
  readCodexProjectResult,
  verifyCodexProjectReadOnly,
} = require('../services/codex-project-result-service');
const {
  assertCatalogProject,
  scanProjectCatalog,
} = require('../services/project-catalog-service');
const { openInFinalCut } = require('../services/project-action-service');

function registerCatalogIpc(ctx) {
  const { ipcMain, shell, authorizeProject } = ctx;

  ipcMain.handle('catalog:scan', () =>
    scanProjectCatalog(DEFAULT_PROJECT_ROOT));

  ipcMain.handle('catalog:get-result', async (_event, projectPath) => {
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, projectPath);
    authorizeProject(validated);
    return readCodexProjectResult(validated);
  });

  ipcMain.handle('catalog:verify', async (_event, projectPath) => {
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, projectPath);
    authorizeProject(validated);
    return verifyCodexProjectReadOnly(validated);
  });

  ipcMain.handle('catalog:artifact-action', async (_event, args) => {
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, args?.projectPath);
    const result = await readCodexProjectResult(validated);
    const artifact = result.artifacts[args?.target];
    if (!artifact?.exists) throw new Error('所选项目产物不存在。');
    const folderTargets = new Set([
      'projectRoot',
      'exportDirectory',
    ]);
    if (folderTargets.has(args.target)) {
      const error = await shell.openPath(artifact.path);
      if (error) throw new Error(error);
      return { opened: true, target: args.target };
    }
    const fileTargets = new Set([
      'fcpxml',
      'analysis',
      'status',
      'manifest',
    ]);
    if (!fileTargets.has(args.target)) throw new Error('不支持的项目产物操作。');
    shell.showItemInFolder(artifact.path);
    return { opened: true, target: args.target };
  });

  ipcMain.handle('catalog:open-final-cut', async (_event, projectPath) => {
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, projectPath);
    const result = await readCodexProjectResult(validated);
    if (!result.artifacts.fcpxml?.exists) throw new Error('FCPXML 不存在。');
    return openInFinalCut(result.artifacts.fcpxml.path);
  });
}

module.exports = { registerCatalogIpc };
