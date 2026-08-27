const path = require('node:path');
const fs = require('node:fs/promises');

const {
  APP_NAME,
  WORKSPACE_ROOT,
  LEGACY_USER_DATA_DIRNAME,
  USER_DATA_DIRNAME,
} = require('./constants');

const LEGACY_CACHE_ENTRIES = new Set([
  '.DS_Store',
  'Cache',
  'Code Cache',
  'DIPS',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'DevToolsActivePort',
  'GPUCache',
  'Local Storage',
  'Network Persistent State',
  'Preferences',
  'Session Storage',
  'Shared Dictionary',
  'SharedStorage',
  'Trust Tokens',
  'Trust Tokens-journal',
  'VideoDecodeStats',
  'blob_storage',
  'install-backups',
  'shared_proto_db',
]);

function stableUserDataPath(appDataPath) {
  if (!appDataPath || !path.isAbsolute(String(appDataPath))) {
    throw new Error('Electron appData 路径必须为绝对路径。');
  }
  const root = path.resolve(String(appDataPath));
  return path.join(root, USER_DATA_DIRNAME);
}

function legacyUserDataPath(appDataPath) {
  if (!appDataPath || !path.isAbsolute(String(appDataPath))) {
    throw new Error('Electron appData 路径必须为绝对路径。');
  }
  return path.join(path.resolve(String(appDataPath)), LEGACY_USER_DATA_DIRNAME);
}

/**
 * Merge the old data directory into 剪渡 directory without replacing
 * anything already created there. Keeping the old directory is deliberate:
 * it makes this migration recoverable and lets older installs keep reading it.
 */
async function migrateLegacyUserData(appDataPath) {
  const target = stableUserDataPath(appDataPath);
  const legacy = legacyUserDataPath(appDataPath);
  if (path.resolve(target) === path.resolve(legacy)) return { target, legacy, migrated: false };
  const legacyStat = await fs.stat(legacy).catch(() => null);
  if (!legacyStat?.isDirectory()) return { target, legacy, migrated: false };
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(legacy, { withFileTypes: true });
  let migrated = false;
  for (const entry of entries) {
    if (LEGACY_CACHE_ENTRIES.has(entry.name)) continue;
    const source = path.join(legacy, entry.name);
    const destination = path.join(target, entry.name);
    const existing = await fs.lstat(destination).catch(() => null);
    if (existing) continue;
    await fs.cp(source, destination, { recursive: entry.isDirectory(), errorOnExist: false, force: false });
    migrated = true;
  }
  return { target, legacy, migrated };
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
    workspacePath: WORKSPACE_ROOT,
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
  legacyUserDataPath,
  migrateLegacyUserData,
};
