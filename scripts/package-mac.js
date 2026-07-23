#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  projectRoot,
  run,
} = require('./package-utils');
const { generate, outputPath } = require('./generate-mac-icon');

async function packageMac() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(`只允许在 Apple Silicon macOS 构建，当前为 ${process.platform}/${process.arch}。`);
  }
  if (!await fs.stat(outputPath).catch(() => null)) await generate();
  const distPath = path.join(projectRoot, 'dist');
  if (path.dirname(distPath) !== projectRoot || path.basename(distPath) !== 'dist') {
    throw new Error('拒绝清理非预期 dist 路径。');
  }
  await fs.rm(distPath, { recursive: true, force: true });
  await run(path.join(projectRoot, 'node_modules', '.bin', 'electron-builder'), [
    '--config', 'electron-builder.config.js',
    '--mac', 'dir',
    '--arm64',
  ], {
    timeout: 20 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  });
  process.stdout.write('macOS arm64 App Bundle 构建完成。\n');
}

if (require.main === module) {
  packageMac().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { packageMac };
