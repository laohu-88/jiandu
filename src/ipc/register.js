const { registerAppIpc } = require('./app-ipc');
const { registerPendingIpc } = require('./pending-ipc');
const { registerHandoffIpc } = require('./handoff-ipc');
const { registerDialogIpc } = require('./dialog-ipc');
const { registerEditIpc } = require('./edit-ipc');
const { registerProjectIpc } = require('./project-ipc');
const { registerAssetsIpc } = require('./assets-ipc');
const { registerAiIpc } = require('./ai-ipc');
const { registerStageIpc } = require('./stage-ipc');
const { registerCatalogIpc } = require('./catalog-ipc');
const { registerPlatformVariantIpc } = require('./platform-variant-ipc');
const { registerShellIpc } = require('./shell-ipc');

function registerIpc(ctx) {
  registerAppIpc(ctx);
  registerPendingIpc(ctx);
  registerHandoffIpc(ctx);
  registerDialogIpc(ctx);
  registerEditIpc(ctx);
  registerProjectIpc(ctx);
  registerAssetsIpc(ctx);
  registerAiIpc(ctx);
  registerStageIpc(ctx);
  registerCatalogIpc(ctx);
  registerPlatformVariantIpc(ctx);
  registerShellIpc(ctx);
}

module.exports = { registerIpc };
