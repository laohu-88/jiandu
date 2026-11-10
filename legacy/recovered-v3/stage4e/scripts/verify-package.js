#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const asar = require('@electron/asar');
const { UNUSED_PERMISSION_KEYS } = require('./after-pack');

const {
  builderConfig,
  builtAppPath,
  packageJson,
  pathExists,
  run,
} = require('./package-utils');

function parseAppArgument(argv) {
  const index = argv.indexOf('--app');
  if (index < 0) return builtAppPath;
  if (!argv[index + 1]) throw new Error('--app 缺少路径。');
  return path.resolve(argv[index + 1]);
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function readPlist(infoPath) {
  const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPath]);
  return JSON.parse(stdout);
}

async function readEntitlements(executablePath) {
  const { stdout, stderr } = await run('/usr/bin/codesign', [
    '-d',
    '--entitlements', ':-',
    executablePath,
  ]);
  const text = String(stdout || stderr || '');
  const xmlStart = text.indexOf('<?xml');
  if (xmlStart < 0) throw new Error('无法读取主程序 entitlements。');
  const tempPath = path.join(
    require('node:os').tmpdir(),
    `video-cut-planner-entitlements-${process.pid}.plist`,
  );
  await fs.writeFile(tempPath, text.slice(xmlStart), 'utf8');
  try {
    return await readPlist(tempPath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} 不匹配：${actual} !== ${expected}`);
}

async function verifyPackage(appPath, options = {}) {
  const resolved = path.resolve(appPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`App Bundle 不存在：${resolved}`);

  const infoPath = path.join(resolved, 'Contents', 'Info.plist');
  const info = await readPlist(infoPath);
  assertEqual(info.CFBundleIdentifier, builderConfig.appId, 'Bundle ID');
  assertEqual(info.CFBundleDisplayName, builderConfig.productName, '显示名称');
  assertEqual(info.CFBundleShortVersionString, packageJson.version, '版本');
  assertEqual(info.LSApplicationCategoryType, builderConfig.mac.category, '分类');
  const schemes = (info.CFBundleURLTypes || [])
    .flatMap((entry) => entry.CFBundleURLSchemes || []);
  if (!schemes.includes('video-cut-planner')) throw new Error('未注册 video-cut-planner 协议。');
  if (schemes.includes('codex')) throw new Error('App 不得注册 codex 协议。');
  for (const key of UNUSED_PERMISSION_KEYS) {
    if (Object.hasOwn(info, key)) throw new Error(`Info.plist 含有未使用权限说明：${key}`);
  }

  const executablePath = path.join(resolved, 'Contents', 'MacOS', info.CFBundleExecutable);
  const { stdout: architecture } = await run('/usr/bin/file', [executablePath]);
  if (!/\barm64\b/.test(architecture) || /\bx86_64\b/.test(architecture)) {
    throw new Error(`主程序不是纯 arm64：${architecture.trim()}`);
  }

  const iconName = info.CFBundleIconFile || 'app-icon.icns';
  const iconPath = path.join(resolved, 'Contents', 'Resources', iconName);
  if (!await pathExists(iconPath)) throw new Error(`App 图标不存在：${iconPath}`);
  const appAsarPath = path.join(resolved, 'Contents', 'Resources', 'app.asar');
  if (!await pathExists(appAsarPath)) throw new Error('缺少 app.asar。');
  const packagedFiles = new Set(asar.listPackage(appAsarPath));
  const requiredFiles = [
    '/package.json',
    '/src/main.js',
    '/src/preload.js',
    '/src/protocol-service.js',
    '/src/runtime-paths.js',
    '/src/renderer/index.html',
    '/src/renderer/styles.css',
    '/src/renderer/app.js',
    '/schemas/codex-video-analysis.schema.json',
  ];
  for (const file of requiredFiles) {
    if (!packagedFiles.has(file)) throw new Error(`app.asar 缺少运行时文件：${file}`);
  }
  const forbidden = ['/test/', '/coverage/', '/dist/', '/.git/', '/handoffs/'];
  for (const file of packagedFiles) {
    if (forbidden.some((fragment) => file.includes(fragment))) {
      throw new Error(`app.asar 含有禁止内容：${file}`);
    }
  }

  let signature = '';
  if (!options.skipCodesign) {
    await run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', resolved]);
    const result = await run('/usr/bin/codesign', ['-dv', '--verbose=4', resolved]);
    signature = String(result.stderr || result.stdout || '');
    if (!/Signature=adhoc/.test(signature)) throw new Error('App 不是 ad-hoc 签名。');
    if (!signature.includes(`Identifier=${builderConfig.appId}`)) {
      throw new Error('签名 Bundle ID 不匹配。');
    }
    if (!options.skipRuntimeEntitlements) {
      const entitlements = await readEntitlements(executablePath);
      if (entitlements['com.apple.security.cs.disable-library-validation'] !== true) {
        throw new Error('ad-hoc Electron App 缺少 disable-library-validation，可能因 Team ID 拒绝加载。');
      }
    }
  }

  return {
    ok: true,
    appPath: resolved,
    appId: info.CFBundleIdentifier,
    productName: info.CFBundleDisplayName,
    version: info.CFBundleShortVersionString,
    category: info.LSApplicationCategoryType,
    protocol: 'video-cut-planner',
    architecture: architecture.trim(),
    iconPath,
    appAsarPath,
    appAsarSha256: await sha256(appAsarPath),
    packagedFileCount: packagedFiles.size,
    signature: signature.match(/Signature=[^\n]+/)?.[0] || null,
  };
}

if (require.main === module) {
  verifyPackage(parseAppArgument(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseAppArgument,
  readEntitlements,
  readPlist,
  sha256,
  verifyPackage,
};
