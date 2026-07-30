const path = require('node:path');
const fs = require('node:fs/promises');

const {
  FCP_EXPORT_DIR,
  RAW_SRT_FILE,
} = require('../constants');
const {
  loadStage2State,
  importVideoPlan,
  scanVoiceFiles,
} = require('../services/stage2-service');
const {
  loadStage3State,
  saveAssignments,
  addAssetToSegment,
  autoFitSegment,
  syncSegmentPackages,
} = require('../services/stage3-service');
const {
  loadRoughcutStatus,
  generateOneSegment,
  generateAllSegments,
} = require('../services/stage4-service');
const {
  loadFinalRoughcutStatus,
  generateFinalRoughcut,
  generateFcpHandoff,
} = require('../services/stage5-service');
const {
  loadSubtitleState,
  writeSubtitleConfig,
  generateSubtitlesFromVideo,
  organizeExistingSrt,
} = require('../services/stage6-service');
const {
  loadRecentProjects,
  detectEnvironment,
} = require('../services/stage7-service');
const {
  preparePendingMedia,
  inspectVideoRange,
} = require('../services/pending-media-service');
const {
  buildCodexVideoProject,
  validateAnalysisFile,
  verifyCodexVideoProject,
} = require('../services/codex-video-service');

function registerStageIpc(ctx) {
  const { app, ipcMain, dialog, shell, getMainWindow, resolveAuthorizedItem } = ctx;

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

  ipcMain.handle('roughcut:show-output', async (_event, args) => {
    const item = await resolveAuthorizedItem(args, 'file');
    if (!item.exists) throw new Error('粗剪文件不存在。');
    shell.showItemInFolder(item.path);
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
    const result = await dialog.showOpenDialog(getMainWindow(), {
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
      const result = await dialog.showOpenDialog(getMainWindow(), {
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

  ipcMain.handle('codex-video:prepare', (_event, args) =>
    preparePendingMedia(args.sourceDirectory, { cacheRoot: args.cacheRoot }));

  ipcMain.handle('codex-video:inspect-range', (_event, args) =>
    inspectVideoRange(
      args.manifestPath,
      args.assetId,
      args.startSec,
      args.endSec,
      args.intervalSec,
    ));

  ipcMain.handle('codex-video:validate-analysis', (_event, args) =>
    validateAnalysisFile(args.manifestPath, args.analysisPath));

  ipcMain.handle('codex-video:build', (_event, args) =>
    buildCodexVideoProject(args));

  ipcMain.handle('codex-video:verify', (_event, projectPath) =>
    verifyCodexVideoProject(projectPath));
}

module.exports = { registerStageIpc };
