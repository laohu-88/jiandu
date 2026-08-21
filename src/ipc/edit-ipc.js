const path = require('node:path');
const fs = require('node:fs/promises');

const {
  DEFAULT_PROJECT_ROOT,
  EDITORIAL_REVIEW_FILE,
} = require('../constants');
const { assertCatalogProject } = require('../services/project-catalog-service');
const { resolveProjectArtifactRoot } = require('../services/project-artifact-paths');
const {
  assertUserDataEditJob,
  buildEditPreflight,
  createEditJob,
  listEditJobs,
  openEditJobInFinalCut,
  recognizeMaterialProject,
  runEditJob,
  updateEditJob,
} = require('../services/in-app-edit-workflow-service');

function registerEditIpc(ctx) {
  const { app, ipcMain, shell, authorizeProject } = ctx;

  ipcMain.handle('edit:recognize', (_event, sourceDirectory) =>
    recognizeMaterialProject(sourceDirectory, { projectRoot: DEFAULT_PROJECT_ROOT }));

  ipcMain.handle('edit:preflight', (_event, sourceDirectory) =>
    buildEditPreflight(sourceDirectory, { projectRoot: DEFAULT_PROJECT_ROOT }));

  ipcMain.handle('edit:create-job', (_event, args) =>
    createEditJob(app.getPath('userData'), {
      ...args,
      projectRoot: DEFAULT_PROJECT_ROOT,
    }));

  ipcMain.handle('edit:run-job', async (_event, jobPath) => {
    const started = await assertUserDataEditJob(app.getPath('userData'), jobPath);
    const finished = await runEditJob(app.getPath('userData'), started.jobFilePath);
    if (finished.resultProjectPath) authorizeProject(finished.resultProjectPath);
    return finished;
  });

  ipcMain.handle('edit:read-job', (_event, jobPath) =>
    assertUserDataEditJob(app.getPath('userData'), jobPath));

  ipcMain.handle('edit:list-jobs', () => listEditJobs(app.getPath('userData')));

  ipcMain.handle('edit:update-job', (_event, args) =>
    updateEditJob(args.jobPath, args.patch || {}));

  ipcMain.handle('edit:open-final-cut', async (_event, jobPathOrProjectPath) => {
    let projectPath = jobPathOrProjectPath;
    if (String(jobPathOrProjectPath || '').endsWith('.json')) {
      const job = await assertUserDataEditJob(app.getPath('userData'), jobPathOrProjectPath);
      projectPath = job.resultProjectPath;
      if (!projectPath) throw new Error('还没有可交接的正式项目。');
    }
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, projectPath);
    authorizeProject(validated);
    return openEditJobInFinalCut(validated);
  });

  ipcMain.handle('edit:open-project', async (_event, projectPath) => {
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, projectPath);
    authorizeProject(validated);
    const error = await shell.openPath(validated);
    if (error) throw new Error(error);
    return { opened: true, projectPath: validated };
  });

  ipcMain.handle('edit:show-editorial-review', async (_event, projectPath) => {
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, projectPath);
    authorizeProject(validated);
    const artifactRoot = await resolveProjectArtifactRoot(validated);
    const reviewPath = path.basename(artifactRoot) === '00-项目总控'
      ? path.join(artifactRoot, path.basename(EDITORIAL_REVIEW_FILE))
      : path.join(artifactRoot, 'editorial-review.json');
    const stat = await fs.stat(reviewPath).catch(() => null);
    if (!stat?.isFile()) throw new Error('editorial-review.json 不存在。');
    shell.showItemInFolder(reviewPath);
    return { opened: true, path: reviewPath };
  });
}

module.exports = { registerEditIpc };
