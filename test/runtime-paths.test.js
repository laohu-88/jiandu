const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  getRuntimePaths,
  isWritableRuntimeTarget,
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
    '/Applications/视频剪辑编排器 v3.app/Contents/Resources/app.asar',
  ));
  assert.equal(
    packaged.preloadPath,
    '/Applications/视频剪辑编排器 v3.app/Contents/Resources/app.asar/src/preload.js',
  );
  assert.match(packaged.analysisSchemaPath, /app\.asar\/schemas\/codex-video-analysis\.schema\.json$/);
  assert.equal(packaged.codexWorkspacePath, '/Users/example/Projects/video-cut-planner-v3');
  assert.doesNotMatch(packaged.codexWorkspacePath, /app\.asar|Applications/);
});

test('稳定 userData 与 cwd、package name、Bundle ID 无关', () => {
  const appData = '/Users/example/Library/Application Support';
  assert.equal(
    stableUserDataPath(appData),
    '/Users/example/Library/Application Support/视频剪辑编排器 v3',
  );
  assert.throws(() => stableUserDataPath('relative path'), /绝对路径/);
  assert.throws(() => stableUserDataPath(''), /绝对路径/);
});

test('App Bundle 和 resources 内部永远不是可写状态目标', () => {
  const appPath = '/Applications/视频剪辑编排器 v3.app/Contents/Resources/app.asar';
  const app = fakeApp(appPath);
  const originalResources = process.resourcesPath;
  Object.defineProperty(process, 'resourcesPath', {
    value: '/Applications/视频剪辑编排器 v3.app/Contents/Resources',
    configurable: true,
  });
  try {
    assert.equal(isWritableRuntimeTarget(path.join(appPath, 'task.json'), app), false);
    assert.equal(
      isWritableRuntimeTarget('/Applications/视频剪辑编排器 v3.app/Contents/Resources/log.txt', app),
      false,
    );
    assert.equal(
      isWritableRuntimeTarget('/Users/example/Library/Application Support/视频剪辑编排器 v3/task.json', app),
      true,
    );
  } finally {
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResources,
      configurable: true,
    });
  }
});
