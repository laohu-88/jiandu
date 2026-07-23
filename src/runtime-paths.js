const path = require('node:path');

const {
  APP_NAME,
  CODEX_WORKSPACE_ROOT,
  USER_DATA_DIRNAME,
} = require('./constants');

function stableUserDataPath(appDataPath) {
  if (!appDataPath || !path.isAbsolute(String(appDataPath))) {
    throw new Error('Electron appData 路径必须为绝对路径。');
  }
  const root = path.resolve(String(appDataPath));
  return path.join(root, USER_DATA_DIRNAME);
}

function getRuntimePaths(electronApp) {
  const appPath = path.resolve(electronApp.getAppPath());
  const resourcesPath = path.resolve(process.resourcesPath || path.dirname(appPath));
  return Object.freeze({
    appName: APP_NAME,
    appPath,
    resourcesPath,
    preloadPath: path.join(appPath, 'src', 'preload.js'),
    rendererPath: path.join(appPath, 'src', 'renderer', 'index.html'),
    analysisSchemaPath: path.join(appPath, 'schemas', 'codex-video-analysis.schema.json'),
    codexWorkspacePath: CODEX_WORKSPACE_ROOT,
  });
}

function isWritableRuntimeTarget(candidatePath, electronApp) {
  const candidate = path.resolve(String(candidatePath || ''));
  const runtime = getRuntimePaths(electronApp);
  const relativeToApp = path.relative(runtime.appPath, candidate);
  const relativeToResources = path.relative(runtime.resourcesPath, candidate);
  const inside = (relative) => relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative));
  return !inside(relativeToApp) && !inside(relativeToResources);
}

module.exports = {
  getRuntimePaths,
  isWritableRuntimeTarget,
  stableUserDataPath,
};
