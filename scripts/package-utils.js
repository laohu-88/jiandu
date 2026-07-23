const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, '..');
const packageJson = require(path.join(projectRoot, 'package.json'));
const builderConfig = require(path.join(projectRoot, 'electron-builder.config.js'));
const productName = builderConfig.productName;
const builtAppPath = path.join(projectRoot, 'dist', 'mac-arm64', `${productName}.app`);
const installedAppPath = path.join('/Applications', `${productName}.app`);
const userDataPath = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  productName,
);

function assertExpectedAppPath(appPath, allowedRoots) {
  const resolved = path.resolve(String(appPath || ''));
  if (path.basename(resolved) !== `${productName}.app`) {
    throw new Error(`App Bundle 名称无效：${resolved}`);
  }
  if (!allowedRoots.some((root) => path.dirname(resolved) === path.resolve(root))) {
    throw new Error(`App Bundle 不在允许目录：${resolved}`);
  }
  return resolved;
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      timeout: options.timeout || 10 * 60 * 1000,
      maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
      env: options.env || process.env,
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw Object.assign(new Error(`${path.basename(command)} 失败：${detail}`), {
      cause: error,
      command,
      args,
    });
  }
}

async function pathExists(candidate) {
  return Boolean(await fs.stat(candidate).catch(() => null));
}

module.exports = {
  assertExpectedAppPath,
  builderConfig,
  builtAppPath,
  installedAppPath,
  packageJson,
  pathExists,
  productName,
  projectRoot,
  run,
  userDataPath,
};
