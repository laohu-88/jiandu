#!/usr/bin/env node

const { resolveInstalledAppPath, run } = require('./package-utils');
const { verifyPackage } = require('./verify-package');

async function launchInstalled() {
  const target = resolveInstalledAppPath();
  await verifyPackage(target);
  await run('/usr/bin/open', [target], { timeout: 30_000 });
  process.stdout.write(`已通过 LaunchServices 启动：${target}\n`);
}

if (require.main === module) {
  launchInstalled().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { launchInstalled };
