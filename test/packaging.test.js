const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const config = require('../electron-builder.config');
const packageJson = require('../package.json');
const {
  assertExpectedAppPath,
  builtAppPath,
  installedAppPath,
} = require('../scripts/package-utils');
const {
  backupPathFor,
  escapeRegExp,
  timestamp,
} = require('../scripts/install-mac-local');
const {
  UNUSED_PERMISSION_KEYS,
  removeUnusedMacPermissionDescriptions,
} = require('../scripts/after-pack');

test('electron-builder 使用正式身份、arm64 dir、ASAR、图标和 ad-hoc 签名', () => {
  assert.equal(config.productName, '视频剪辑编排器 v3');
  assert.equal(config.appId, 'com.laohu.video-cut-planner-v3');
  assert.equal(config.asar, true);
  assert.equal(config.mac.category, 'public.app-category.video');
  assert.equal(config.mac.identity, '-');
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.icon, 'build/app-icon.icns');
  assert.deepEqual(config.mac.target, [{ target: 'dir', arch: ['arm64'] }]);
  assert.equal(config.mac.protocols[0].name, '视频剪辑编排器 v3 交接回流');
  assert.deepEqual(config.mac.protocols[0].schemes, ['video-cut-planner']);
});

test('打包白名单包含运行时文件且排除测试、产物和用户数据', () => {
  const files = config.files.join('\n');
  assert.match(files, /src\/\*\*\/\*\.js/);
  assert.match(files, /schemas\/\*\.json/);
  assert.match(files, /!test/);
  assert.match(files, /!coverage/);
  assert.match(files, /!dist/);
  assert.doesNotMatch(files, /handoffs|视频素材库|视频待处理/);
  assert.equal(config.asarUnpack, undefined);
});

test('版本只有 package.json 一个 SemVer 来源', async () => {
  assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const constants = await fs.readFile(path.join(__dirname, '../src/constants.js'), 'utf8');
  assert.match(constants, /require\('\.\.\/package\.json'\)/);
  assert.doesNotMatch(constants, /3\.1\.0-stage1/);
});

test('entitlements 只有 Electron ad-hoc 本机运行所需最小项', async () => {
  const entitlements = await fs.readFile(
    path.join(__dirname, '../build/entitlements.mac.plist'),
    'utf8',
  );
  assert.match(entitlements, /allow-jit/);
  assert.match(entitlements, /allow-unsigned-executable-memory/);
  assert.match(entitlements, /disable-library-validation/);
  assert.doesNotMatch(
    entitlements,
    /camera|microphone|contacts|calendar|location|screen-capture|personal-information/,
  );
});

test('afterPack 在签名前移除 Electron 默认的未使用权限说明', async () => {
  const calls = [];
  const result = await removeUnusedMacPermissionDescriptions({
    electronPlatformName: 'darwin',
    appOutDir: '/tmp/构建 输出',
    packager: { appInfo: { productFilename: '视频剪辑编排器 v3' } },
  }, {
    runImpl: async (command, args) => {
      calls.push({ command, args });
    },
  });
  assert.deepEqual(result.removed, UNUSED_PERMISSION_KEYS);
  assert.equal(calls.length, UNUSED_PERMISSION_KEYS.length);
  assert.ok(calls.every((call) => call.command === '/usr/libexec/PlistBuddy'));
  assert.ok(calls.every((call) => call.args[2].endsWith('/Contents/Info.plist')));
});

test('构建与安装路径严格限定且支持中文和空格', () => {
  assert.equal(
    assertExpectedAppPath(builtAppPath, [path.dirname(builtAppPath)]),
    builtAppPath,
  );
  assert.equal(
    assertExpectedAppPath(installedAppPath, ['/Applications']),
    installedAppPath,
  );
  assert.throws(
    () => assertExpectedAppPath('/Applications/恶意.app', ['/Applications']),
    /名称无效/,
  );
  assert.throws(
    () => assertExpectedAppPath('/tmp/视频剪辑编排器 v3.app', ['/Applications']),
    /不在允许目录/,
  );
});

test('安装备份使用稳定 userData 子目录和无冒号时间戳', () => {
  const fixed = new Date('2026-07-23T12:34:56.789Z');
  assert.equal(timestamp(fixed), '2026-07-23T12-34-56-789Z');
  const backup = backupPathFor(fixed);
  assert.match(backup, /视频剪辑编排器 v3\/install-backups\//);
  assert.equal(path.extname(backup), '.app');
  assert.equal(backup.includes(':'), false);
  assert.equal(escapeRegExp('/Applications/a+b.app'), '/Applications/a\\+b\\.app');
});

test('package 脚本禁止证书自动发现且 launch 不回退 npm start', async () => {
  const packageScript = await fs.readFile(path.join(__dirname, '../scripts/package-mac.js'), 'utf8');
  const launchScript = await fs.readFile(path.join(__dirname, '../scripts/launch-installed.js'), 'utf8');
  const installScript = await fs.readFile(path.join(__dirname, '../scripts/install-mac-local.js'), 'utf8');
  assert.match(packageScript, /CSC_IDENTITY_AUTO_DISCOVERY/);
  assert.match(launchScript, /\/usr\/bin\/open/);
  assert.doesNotMatch(launchScript, /npm start|electron \./);
  assert.match(installScript, /\/usr\/bin\/ditto/);
  assert.match(installScript, /install-backups/);
  assert.match(installScript, /skipRuntimeFileRequirements: true/);
  assert.match(installScript, /skipVersionCheck: true/);
  assert.match(installScript, /backupVerification\.appAsarSha256 !== installedVerification\.appAsarSha256/);
  assert.match(
    installScript,
    /const verification = await verifyImpl\(target\);\s+targetRemoved = false;/,
  );
  assert.doesNotMatch(installScript, /pkill|sudo|shell:\s*true/);
});

test('包校验每次读取前清除 ASAR 路径缓存，避免原位更新后误判旧文件列表', async () => {
  const verifyScript = await fs.readFile(path.join(__dirname, '../scripts/verify-package.js'), 'utf8');
  assert.match(verifyScript, /asar\.uncache\(appAsarPath\);\s+const packagedFiles/);
});
