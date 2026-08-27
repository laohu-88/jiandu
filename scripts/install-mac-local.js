#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  assertExpectedAppPath,
  builtAppPath,
  installBackupRoot,
  pathExists,
  productName,
  resolveInstalledAppPath,
  run,
} = require('./package-utils');
const { verifyPackage } = require('./verify-package');

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function backupPathFor(date = new Date()) {
  return path.join(installBackupRoot(), `${productName}-${timestamp(date)}.app`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findInstalledPids(options = {}) {
  const runImpl = options.runImpl || run;
  const executable = path.join(resolveInstalledAppPath(), 'Contents', 'MacOS', productName);
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

async function terminateInstalledProcesses(options = {}) {
  const pids = await findInstalledPids(options);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

async function requestNormalQuit(options = {}) {
  if ((await findInstalledPids(options)).length === 0) return;
  const runImpl = options.runImpl || run;
  try {
    await runImpl('/usr/bin/osascript', [
      '-e',
      'tell application id "com.laohu.video-cut-planner-v3" to quit',
    ], { timeout: 10_000 });
  } catch (error) {
    // 终端进程可能缺少 Apple Events 自动化授权；降级为直接 SIGTERM。
    process.stderr.write('osascript 退出失败，改用 SIGTERM：\n');
    process.stderr.write(`${String(error.message || error).trim()}\n`);
    await terminateInstalledProcesses(options);
  }
  if (!await waitForExit(10_000, options)) {
    throw new Error('已安装 App 仍在运行；请正常退出后重新安装。');
  }
}

async function installMacLocal(options = {}) {
  const installedAppPath = resolveInstalledAppPath(options.installRoot);
  const source = assertExpectedAppPath(
    options.sourcePath || builtAppPath,
    [path.dirname(builtAppPath)],
  );
  const target = assertExpectedAppPath(
    options.targetPath || installedAppPath,
    [path.dirname(path.resolve(installedAppPath))],
  );
  const runImpl = options.runImpl || run;
  const verifyImpl = options.verifyImpl || verifyPackage;
  await verifyImpl(source);
  await requestNormalQuit({ runImpl });

  const previousExists = await pathExists(target);
  const backupPath = previousExists ? backupPathFor() : null;
  const stagingPath = path.join(
    path.dirname(path.resolve(target)),
    `.${productName}.installing-${process.pid}.app`,
  );
  const legacyVerificationOptions = {
    skipRuntimeEntitlements: true,
    skipRuntimeFileRequirements: true,
    skipVersionCheck: true,
  };
  let targetRemoved = false;
  try {
    await fs.rm(stagingPath, { recursive: true, force: true });
    if (previousExists) {
      const installedVerification = await verifyImpl(target, legacyVerificationOptions);
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await runImpl('/usr/bin/ditto', [target, backupPath], { timeout: 10 * 60 * 1000 });
      const backupVerification = await verifyImpl(backupPath, legacyVerificationOptions);
      if (backupVerification.appAsarSha256 !== installedVerification.appAsarSha256) {
        throw new Error('旧 App 备份与已安装版本的 app.asar 不一致。');
      }
      await fs.rm(target, { recursive: true });
      targetRemoved = true;
    }
    await runImpl('/usr/bin/ditto', [source, stagingPath], { timeout: 10 * 60 * 1000 });
    await verifyImpl(stagingPath);
    await fs.rename(stagingPath, target);
    const verification = await verifyImpl(target);
    targetRemoved = false;
    return { installed: true, target, previousExists, backupPath, verification };
  } catch (error) {
    await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    if (previousExists && targetRemoved && backupPath && await pathExists(backupPath)) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      await runImpl('/usr/bin/ditto', [backupPath, target], { timeout: 10 * 60 * 1000 });
      await verifyImpl(target, legacyVerificationOptions);
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
