const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');

const {
  APP_NAME,
  APP_VERSION,
  DEFAULT_PROJECT_ROOT,
  FCP_EXPORT_DIR,
  RAW_SRT_FILE,
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
const {
  loadFinalRoughcutStatus,
  generateFinalRoughcut,
  generateFcpHandoff,
} = require('./services/stage5-service');
const {
  loadSubtitleState,
  writeSubtitleConfig,
  generateSubtitlesFromVideo,
  organizeExistingSrt,
} = require('./services/stage6-service');
const {
  loadRecentProjects,
  saveRecentProject,
  detectEnvironment,
} = require('./services/stage7-service');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: APP_NAME,
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
    createProject(args.rootPath, args.projectName).then(async (result) => {
      await saveRecentProject(app.getPath('userData'), result.project);
      return result;
    }));

  ipcMain.handle('project:choose-open', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择已有项目文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    const opened = await openProject(result.filePaths[0]);
    await saveRecentProject(app.getPath('userData'), opened.project);
    return opened;
  });

  ipcMain.handle('project:open-path', async (_event, projectPath) => {
    const opened = await openProject(projectPath);
    await saveRecentProject(app.getPath('userData'), opened.project);
    return opened;
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

  ipcMain.handle('final-roughcut:load-status', (_event, projectPath) =>
    loadFinalRoughcutStatus(projectPath));

  ipcMain.handle('final-roughcut:generate', (_event, projectPath) =>
    generateFinalRoughcut(projectPath));

  ipcMain.handle('fcp-handoff:generate', (_event, projectPath) =>
    generateFcpHandoff(projectPath));

  ipcMain.handle('subtitle:load', (_event, projectPath) =>
    loadSubtitleState(projectPath));

  ipcMain.handle('subtitle:save-config', (_event, args) =>
    writeSubtitleConfig(args.projectPath, args.config));

  ipcMain.handle('subtitle:choose-video', async (_event, projectPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 FCP 导出的最终整片视频',
      defaultPath: path.join(projectPath, FCP_EXPORT_DIR),
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v'] }],
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('subtitle:generate-from-video', (_event, args) =>
    generateSubtitlesFromVideo(args.projectPath, args.inputVideo, args.command));

  ipcMain.handle('subtitle:organize-existing', async (_event, projectPath) => {
    let selectedSrtPath = null;
    const rawPath = path.join(projectPath, RAW_SRT_FILE);
    const rawExists = Boolean((await fs.stat(rawPath).catch(() => null))?.isFile());
    if (!rawExists) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择已有 SRT 文件',
        defaultPath: path.join(projectPath, '07-字幕'),
        properties: ['openFile'],
        filters: [{ name: 'SRT', extensions: ['srt'] }],
      });
      if (result.canceled) {
        throw new Error('找不到 raw.srt，请先放入 07-字幕/raw.srt，或选择一个已有 SRT 文件。');
      }
      selectedSrtPath = result.filePaths[0];
    }
    return organizeExistingSrt(projectPath, selectedSrtPath);
  });

  ipcMain.handle('recent-projects:load', () =>
    loadRecentProjects(app.getPath('userData')));

  ipcMain.handle('environment:detect', (_event, subtitleCommand) =>
    detectEnvironment(subtitleCommand));

  ipcMain.handle('shell:show-item', (_event, itemPath) => {
    shell.showItemInFolder(itemPath);
  });

  ipcMain.handle('shell:open-folder', (_event, folderPath) =>
    shell.openPath(folderPath));
}

app.setName(APP_NAME);

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
