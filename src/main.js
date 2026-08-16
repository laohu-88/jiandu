const path = require('node:path');
const fs = require('node:fs/promises');
const { watch } = require('node:fs');
const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron');

if (app && process.env.PLANNER_CDP_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', String(process.env.PLANNER_CDP_PORT));
}

const {
  APP_ID,
  APP_NAME,
} = require('./constants');
const {
  getRuntimePaths,
  stableUserDataPath,
} = require('./runtime-paths');
const {
  PROTOCOL_SCHEME,
  ProtocolQueue,
  protocolUrlFromArgv,
} = require('./protocol-service');
const { openInFinalCut } = require('./services/project-action-service');
const {
  TERMINAL_STATUSES,
  assertUserDataTask,
  listHandoffTasks,
  taskRoot,
  updateHandoffTask,
} = require('./services/handoff-task-service');
const { finalizeAgentTask, userFacingStatus } = require('./services/agent-bridge-service');
const { createIpcHelpers } = require('./ipc/helpers');
const { registerIpc } = require('./ipc/register');

let mainWindow;
const terminalTaskVersions = new Map();
let handoffWatcher = null;
let handoffRefreshTimer = null;
const protocolQueue = new ProtocolQueue();
let appReady = false;

const helpers = createIpcHelpers({ app });
const {
  authorizeProject,
  assertAuthorizedProject,
  resolveAuthorizedItem,
  scanHandoffsAndPending,
  validateTerminalProject,
} = helpers;

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const runtimePaths = getRuntimePaths(app);
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: APP_NAME,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: runtimePaths.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(runtimePaths.rendererPath);
  mainWindow.webContents.once('did-finish-load', () => {
    refreshTerminalHandoffs({ includeExisting: true }).catch(() => {});
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

async function focusPlannerOnTask(task) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.webContents.isLoadingMainFrame()) {
    await new Promise((resolve) => mainWindow.webContents.once('did-finish-load', resolve));
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  app.focus({ steal: true });
  mainWindow.webContents.send('handoff:progress', {
    task,
    userStatus: userFacingStatus(task),
  });
  if (TERMINAL_STATUSES.has(task.status) || task.status === 'analysis_complete' || task.status === 'failed') {
    mainWindow.webContents.send('handoff:terminal', task);
  }
}

function restoreMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  app.focus({ steal: true });
}

async function handleReturnProtocol(entry) {
  const taskPath = path.join(taskRoot(app.getPath('userData')), `${entry.taskId}.json`);
  const task = await assertUserDataTask(app.getPath('userData'), taskPath);
  if (!TERMINAL_STATUSES.has(task.status) && task.status !== 'analysis_complete') {
    throw Object.assign(new Error('只有终态或分析完成任务可以通过协议回流。'), {
      code: 'HANDOFF_NOT_TERMINAL',
    });
  }
  await focusPlannerOnTask(task);
}

function queueReturnUrl(rawUrl) {
  try {
    protocolQueue.enqueue(rawUrl);
    if (appReady) protocolQueue.drain(handleReturnProtocol).catch(() => {});
  } catch {
    // 单个非法或恶意 URL 被拒绝，不影响应用生命周期。
  }
}

async function refreshTerminalHandoffs(options = {}) {
  const payload = await listHandoffTasks(app.getPath('userData'));
  for (const task of payload.tasks) {
    if (task.status === 'analysis_complete' && !task.resultProjectPath) {
      const finalized = await finalizeAgentTask(task.taskFilePath).catch((error) => ({
        task,
        blocked: true,
        error,
      }));
      if (finalized?.task) await focusPlannerOnTask(finalized.task);
      continue;
    }
    if (!TERMINAL_STATUSES.has(task.status)) {
      if (options.includeExisting && !['draft', 'ready', 'cancelled'].includes(task.status)) {
        await focusPlannerOnTask(task);
      }
      continue;
    }
    const version = `${task.updatedAt}:${task.returnState?.requestedAt || ''}`;
    const requestedAt = Date.parse(task.returnState?.requestedAt || 0) || 0;
    const acknowledgedAt = Date.parse(task.returnState?.acknowledgedAt || 0) || 0;
    if (acknowledgedAt >= requestedAt && acknowledgedAt > 0) {
      terminalTaskVersions.set(task.taskId, version);
      continue;
    }
    if (!options.includeExisting && terminalTaskVersions.get(task.taskId) === version) continue;
    terminalTaskVersions.set(task.taskId, version);
    await focusPlannerOnTask(task);
    const acknowledgmentTime = new Date().toISOString();
    const acknowledged = await updateHandoffTask(task.taskFilePath, {
      status: task.status,
      returnState: { ...(task.returnState || {}), acknowledgedAt: acknowledgmentTime },
    }).catch(() => {});
    if (acknowledged) {
      terminalTaskVersions.set(
        task.taskId,
        `${acknowledged.updatedAt}:${acknowledged.returnState?.requestedAt || ''}`,
      );
    }
    if (task.status === 'completed' && task.autoOpenFcp) {
      const validated = await validateTerminalProject(task).catch(() => null);
      if (validated && validated.result.verification.warnings.length === 0) {
        await openInFinalCut(validated.result.artifacts.fcpxml.path).catch(async (error) => {
          await updateHandoffTask(task.taskFilePath, {
            status: task.status,
            errors: [...(task.errors || []), {
              code: 'FINAL_CUT_OPEN_FAILED',
              message: error.message,
              at: new Date().toISOString(),
            }],
          }).catch(() => {});
        });
      }
    }
  }
}

async function startHandoffWatcher() {
  const root = taskRoot(app.getPath('userData'));
  await fs.mkdir(root, { recursive: true });
  handoffWatcher?.close();
  handoffWatcher = watch(root, { persistent: false }, () => {
    clearTimeout(handoffRefreshTimer);
    handoffRefreshTimer = setTimeout(() => refreshTerminalHandoffs().catch(() => {}), 150);
  });
}

app.setName(APP_NAME);
app.setPath('userData', stableUserDataPath(app.getPath('appData')));

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('open-url', (event, rawUrl) => {
    event.preventDefault();
    queueReturnUrl(rawUrl);
  });

  app.on('second-instance', (_event, argv) => {
    const rawUrl = protocolUrlFromArgv(argv);
    if (rawUrl) queueReturnUrl(rawUrl);
    else if (appReady) restoreMainWindow();
  });
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  appReady = true;
  app.accessibilitySupportEnabled = true;
  app.setAppUserModelId?.(APP_ID);
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  registerIpc({
    app,
    ipcMain,
    dialog,
    shell,
    clipboard,
    BrowserWindow,
    getMainWindow: () => mainWindow,
    authorizeProject,
    assertAuthorizedProject,
    resolveAuthorizedItem,
    scanHandoffsAndPending,
    validateTerminalProject,
  });
  createWindow();
  startHandoffWatcher().catch(() => {});
  await protocolQueue.drain(handleReturnProtocol).catch(() => {});

  app.on('activate', () => {
    restoreMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  handoffWatcher?.close();
  clearTimeout(handoffRefreshTimer);
});
