#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  assertExpectedAppPath,
  builtAppPath,
  installedAppPath,
  pathExists,
  productName,
  run,
  userDataPath,
} = require('./package-utils');
const { verifyPackage } = require('./verify-package');

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function backupPathFor(date = new Date()) {
  return path.join(userDataPath, 'install-backups', `${productName}-${timestamp(date)}.app`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findInstalledPids(options = {}) {
  const runImpl = options.runImpl || run;
  const executable = path.join(installedAppPath, 'Contents', 'MacOS', productName);
  try {
    const { stdout } = await runImpl('/usr/bin/pgrep', ['-f', `^${escapeRegExp(executable)}$`], {
      timeout: 5000,
    });
    return String(stdout).trim().split(/\s+/).filter(Boolean).map(Number);
  } catch (error) {
    if (error.cause?.code === 1 || error.code === 1) return [];
    throw error;
  }
}

async function waitForExit(timeoutMs = 10_000, options = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await findInstalledPids(options)).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function requestNormalQuit(options = {}) {
  if ((await findInstalledPids(options)).length === 0) return;
  const runImpl = options.runImpl || run;
  await runImpl('/usr/bin/osascript', [
    '-e',
    'tell application id "com.laohu.video-cut-planner-v3" to quit',
  ], { timeout: 10_000 });
  if (!await waitForExit(10_000, options)) {
    throw new Error('已安装 App 仍在运行；请正常退出后重新安装。');
  }
}

async function installMacLocal(options = {}) {
  const source = assertExpectedAppPath(
    options.sourcePath || builtAppPath,
    [path.dirname(builtAppPath)],
  );
  const target = assertExpectedAppPath(
    options.targetPath || installedAppPath,
    ['/Applications'],
  );
  const runImpl = options.runImpl || run;
  const verifyImpl = options.verifyImpl || verifyPackage;
  await verifyImpl(source);
  await requestNormalQuit({ runImpl });

  const previousExists = await pathExists(target);
  const backupPath = previousExists ? backupPathFor() : null;
  const stagingPath = path.join('/Applications', `.${productName}.installing-${process.pid}.app`);
  let targetRemoved = false;
  try {
    await fs.rm(stagingPath, { recursive: true, force: true });
    if (previousExists) {
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await runImpl('/usr/bin/ditto', [target, backupPath], { timeout: 10 * 60 * 1000 });
      await verifyImpl(backupPath, { skipRuntimeEntitlements: true });
      await fs.rm(target, { recursive: true });
      targetRemoved = true;
    }
    await runImpl('/usr/bin/ditto', [source, stagingPath], { timeout: 10 * 60 * 1000 });
    await verifyImpl(stagingPath);
    await fs.rename(stagingPath, target);
    targetRemoved = false;
    const verification = await verifyImpl(target);
    return { installed: true, target, previousExists, backupPath, verification };
  } catch (error) {
    await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    if (previousExists && targetRemoved && backupPath && await pathExists(backupPath)) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      await runImpl('/usr/bin/ditto', [backupPath, target], { timeout: 10 * 60 * 1000 });
      await verifyImpl(target, { skipRuntimeEntitlements: true });
    }
    throw error;
  }
}

if (require.main === module) {
  installMacLocal().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  backupPathFor,
  escapeRegExp,
  findInstalledPids,
  installMacLocal,
  requestNormalQuit,
  timestamp,
  waitForExit,
};
