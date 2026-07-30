const { DEFAULT_PROJECT_ROOT } = require('../constants');
const { resolveProjectPath } = require('../services/codex-project-result-service');
const { assertCatalogProject } = require('../services/project-catalog-service');
const { openInFinalCut } = require('../services/project-action-service');
const {
  approveDouyinVariant,
  analyzeDouyinShotTracking,
  buildDouyinVariant,
  createDouyinVariant,
  readDouyinVariant,
  saveDouyinVariantDraft,
  verifyDouyinVariant,
} = require('../services/platform-variant-service');

function registerPlatformVariantIpc(ctx) {
  const { ipcMain, shell, authorizeProject } = ctx;

  ipcMain.handle('platform-variant:douyin-create', async (_event, args) => {
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, args?.projectPath);
    authorizeProject(validated);
    return createDouyinVariant(validated, {
      variantId: args?.variantId || 'douyin',
      plan: args?.plan || null,
    });
  });

  ipcMain.handle('platform-variant:douyin-read', async (_event, args) => {
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, args?.projectPath);
    authorizeProject(validated);
    return readDouyinVariant(validated, args?.variantId || 'douyin');
  });

  ipcMain.handle('platform-variant:douyin-save', async (_event, args) => {
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, args?.projectPath);
    authorizeProject(validated);
    return saveDouyinVariantDraft(
      validated,
      args?.variantId || 'douyin',
      args?.plan,
      { expectedRevision: args?.expectedRevision },
    );
  });

  ipcMain.handle('platform-variant:douyin-analyze-tracking', async (_event, args) => {
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, args?.projectPath);
    authorizeProject(validated);
    return analyzeDouyinShotTracking(
      validated,
      args?.variantId || 'douyin',
      args?.videoId,
      args?.shotId,
      {
        subjectType: args?.subjectType,
        safeMargin: args?.safeMargin,
        fallbackMode: args?.fallbackMode,
      },
    );
  });

  ipcMain.handle('platform-variant:douyin-approve', async (_event, args) => {
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, args?.projectPath);
    authorizeProject(validated);
    return approveDouyinVariant(validated, args?.variantId || 'douyin', {
      approvedWarningIds: args?.approvedWarningIds || [],
      approvedBy: 'app-user',
    });
  });

  ipcMain.handle('platform-variant:douyin-build', async (_event, args) => {
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, args?.projectPath);
    authorizeProject(validated);
    return buildDouyinVariant(validated, args?.variantId || 'douyin');
  });

  ipcMain.handle('platform-variant:douyin-verify', async (_event, args) => {
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, args?.projectPath);
    authorizeProject(validated);
    return verifyDouyinVariant(validated, args?.variantId || 'douyin');
  });

  ipcMain.handle('platform-variant:douyin-artifact', async (_event, args) => {
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, args?.projectPath);
    const variant = await readDouyinVariant(validated, args?.variantId || 'douyin');
    const output = variant.outputs?.find((item) => item.videoId === args?.videoId);
    if (!output) throw new Error('找不到抖音成片输出。');
    const candidates = {
      outputDirectory: {
        relativePath: output.relativeOutputDirectory,
        kind: 'directory',
      },
      preview: { relativePath: output.artifacts?.preview, kind: 'file' },
      fcpxml: { relativePath: output.artifacts?.fcpxml, kind: 'file' },
      editPlan: { relativePath: output.artifacts?.editPlan, kind: 'file' },
      analysis: { relativePath: output.artifacts?.analysis, kind: 'file' },
      validation: { relativePath: output.artifacts?.validation, kind: 'file' },
    };
    const candidate = candidates[args?.target];
    if (!candidate?.relativePath) throw new Error('不支持的抖音产物操作。');
    const artifact = await resolveProjectPath(validated, candidate.relativePath, {
      kind: candidate.kind,
    });
    if (!artifact.exists) throw new Error('抖音产物不存在。');
    if (candidate.kind === 'directory') {
      const error = await shell.openPath(artifact.path);
      if (error) throw new Error(error);
    } else {
      shell.showItemInFolder(artifact.path);
    }
    return { opened: true, target: args.target, path: artifact.path };
  });

  ipcMain.handle('platform-variant:douyin-open-final-cut', async (_event, args) => {
    const validated = await assertCatalogProject(DEFAULT_PROJECT_ROOT, args?.projectPath);
    const variant = await readDouyinVariant(validated, args?.variantId || 'douyin');
    const output = variant.outputs?.find((item) => item.videoId === args?.videoId);
    if (!output?.artifacts?.fcpxml) throw new Error('抖音 FCPXML 不存在。');
    const artifact = await resolveProjectPath(validated, output.artifacts.fcpxml, { kind: 'file' });
    if (!artifact.exists) throw new Error('抖音 FCPXML 不存在。');
    return openInFinalCut(artifact.path);
  });
}

module.exports = { registerPlatformVariantIpc };
