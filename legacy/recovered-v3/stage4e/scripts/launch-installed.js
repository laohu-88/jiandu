#!/usr/bin/env node

const { installedAppPath, run } = require('./package-utils');
const { verifyPackage } = require('./verify-package');

async function launchInstalled() {
  await verifyPackage(installedAppPath);
  await run('/usr/bin/open', [installedAppPath], { timeout: 30_000 });
  process.stdout.write(`已通过 LaunchServices 启动：${installedAppPath}\n`);
}

if (require.main === module) {
  launchInstalled().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { launchInstalled };
