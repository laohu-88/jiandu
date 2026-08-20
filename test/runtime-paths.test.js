const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');

const {
  getRuntimePaths,
  isWritableRuntimeTarget,
  migrateLegacyUserData,
  stableUserDataPath,
} = require('../src/runtime-paths');

function fakeApp(appPath) {
  return { getAppPath: () => appPath };
}

test('development 和 packaged 都从 app.getAppPath 解析内部资源', () => {
  const development = getRuntimePaths(fakeApp('/Users/example/Projects/video-cut-planner-v3'));
  assert.equal(
    development.rendererPath,
    '/Users/example/Projects/video-cut-planner-v3/src/renderer/index.html',
  );
  const packaged = getRuntimePaths(fakeApp(
    '/Applications/剪渡.app/Contents/Resources/app.asar',
  ));
  assert.equal(
    packaged.preloadPath,
    '/Applications/剪渡.app/Contents/Resources/app.asar/src/preload.js',
  );
  assert.match(packaged.analysisSchemaPath, /app\.asar\/schemas\/codex-video-analysis\.schema\.json$/);
  assert.equal(packaged.codexWorkspacePath, '/Users/example/Projects/video-cut-planner-v3');
  assert.doesNotMatch(packaged.codexWorkspacePath, /app\.asar|Applications/);
});

test('稳定 userData 与 cwd、package name、Bundle ID 无关', () => {
  const appData = '/Users/example/Library/Application Support';
  assert.equal(
    stableUserDataPath(appData),
    '/Users/example/Library/Application Support/剪渡',
  );
  assert.throws(() => stableUserDataPath('relative path'), /绝对路径/);
  assert.throws(() => stableUserDataPath(''), /绝对路径/);
});

test('旧 userData 迁移只搬运业务状态，不复制安装备份和 Chromium 缓存', async () => {
  const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'jiandu-runtime-'));
  const legacy = path.join(appData, '视频剪辑编排器 v3');
  await fs.mkdir(path.join(legacy, 'handoffs'), { recursive: true });
  await fs.mkdir(path.join(legacy, 'install-backups', 'old.app', 'Contents'), { recursive: true });
  await fs.writeFile(path.join(legacy, 'handoffs', 'task.json'), '{}');
  await fs.writeFile(path.join(legacy, 'install-backups', 'old.app', 'Contents', 'app.asar'), 'not a package');
  await fs.mkdir(path.join(legacy, 'Cache'), { recursive: true });

  const result = await migrateLegacyUserData(appData);
  const target = stableUserDataPath(appData);
  assert.equal(result.migrated, true);
  assert.equal(await fs.readFile(path.join(target, 'handoffs', 'task.json'), 'utf8'), '{}');
  await assert.rejects(fs.stat(path.join(target, 'install-backups')));
  await assert.rejects(fs.stat(path.join(target, 'Cache')));
});

test('App Bundle 和 resources 内部永远不是可写状态目标', () => {
  const appPath = '/Applications/剪渡.app/Contents/Resources/app.asar';
  const app = fakeApp(appPath);
  const originalResources = process.resourcesPath;
  Object.defineProperty(process, 'resourcesPath', {
    value: '/Applications/剪渡.app/Contents/Resources',
    configurable: true,
  });
  try {
    assert.equal(isWritableRuntimeTarget(path.join(appPath, 'task.json'), app), false);
    assert.equal(
      isWritableRuntimeTarget('/Applications/剪渡.app/Contents/Resources/log.txt', app),
      false,
    );
    assert.equal(
      isWritableRuntimeTarget('/Users/example/Library/Application Support/剪渡/task.json', app),
      true,
    );
  } finally {
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResources,
      configurable: true,
    });
  }
});
