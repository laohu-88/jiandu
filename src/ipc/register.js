const { registerAppIpc } = require('./app-ipc');
const { registerPendingIpc } = require('./pending-ipc');
const { registerHandoffIpc } = require('./handoff-ipc');
const { registerDialogIpc } = require('./dialog-ipc');
const { registerCatalogIpc } = require('./catalog-ipc');
const { registerShellIpc } = require('./shell-ipc');

function registerIpc(ctx) {
  registerAppIpc(ctx);
  registerPendingIpc(ctx);
  registerHandoffIpc(ctx);
  registerDialogIpc(ctx);
  registerCatalogIpc(ctx);
  registerShellIpc(ctx);
}

module.exports = { registerIpc };
