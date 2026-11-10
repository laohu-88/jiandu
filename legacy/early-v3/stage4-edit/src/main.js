const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');

const {
  APP_VERSION,
  DEFAULT_PROJECT_ROOT,
} = require('./constants');
const {
  createProject,
  openProject,
  ensureProjectDirs,
} = require('./services/project-service');
const {
  scanAssets,
  generateBrief,
} = require('./services/media-service');
const {
  loadStage2State,
  importVideoPlan,
  scanVoiceFiles,
} = require('./services/stage2-service');
const {
  loadStage3State,
  saveAssignments,
  addAssetToSegment,
  autoFitSegment,
  syncSegmentPackages,
} = require('./services/stage3-service');
const {
  loadRoughcutStatus,
  generateOneSegment,
  generateAllSegments,
} = require('./services/stage4-service');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: '视频剪辑编排器 v3',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function registerIpc() {
  ipcMain.handle('app:get-config', () => ({
    version: APP_VERSION,
    defaultProjectRoot: DEFAULT_PROJECT_ROOT,
  }));

  ipcMain.handle('dialog:select-root', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择项目根目录',
      defaultPath: DEFAULT_PROJECT_ROOT,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('project:create', (_event, args) =>
    createProject(args.rootPath, args.projectName));

  ipcMain.handle('project:choose-open', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择已有项目文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    return openProject(result.filePaths[0]);
  });

  ipcMain.handle('project:ensure-dirs', (_event, projectPath) =>
    ensureProjectDirs(projectPath));

  ipcMain.handle('assets:scan', (_event, projectPath) =>
    scanAssets(projectPath));

  ipcMain.handle('brief:generate', (_event, projectPath) =>
    generateBrief(projectPath));

  ipcMain.handle('stage2:load', (_event, projectPath) =>
    loadStage2State(projectPath));

  ipcMain.handle('plan:import', (_event, args) =>
    importVideoPlan(args.projectPath, args.planText));

  ipcMain.handle('voice:scan', (_event, projectPath) =>
    scanVoiceFiles(projectPath));

  ipcMain.handle('stage3:load', (_event, projectPath) =>
    loadStage3State(projectPath));

  ipcMain.handle('assignments:save', (_event, args) =>
    saveAssignments(args.projectPath, args.segments));

  ipcMain.handle('assignments:add-asset', (_event, args) =>
    addAssetToSegment(args.projectPath, args.segmentId, args.assetId));

  ipcMain.handle('assignments:auto-fit', (_event, args) =>
    autoFitSegment(args.projectPath, args.segmentId));

  ipcMain.handle('packages:sync', (_event, projectPath) =>
    syncSegmentPackages(projectPath));

  ipcMain.handle('roughcut:load-status', (_event, projectPath) =>
    loadRoughcutStatus(projectPath));

  ipcMain.handle('roughcut:generate-one', (_event, args) =>
    generateOneSegment(args.projectPath, args.segmentId));

  ipcMain.handle('roughcut:generate-all', (_event, projectPath) =>
    generateAllSegments(projectPath));

  ipcMain.handle('roughcut:show-output', (_event, outputPath) => {
    shell.showItemInFolder(outputPath);
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
