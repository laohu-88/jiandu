const fs = require('node:fs/promises');
const fsSync = require('node:fs');
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
const userDataPath = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  productName,
);

const DEFAULT_INSTALL_ROOT = '/Applications';

// 允许通过 JIANDU_INSTALL_DIR 选择安装位置；当终端进程缺少
// App Management 授权、无法改写 /Applications 时可回退到用户目录。
function installRoot() {
  return process.env.JIANDU_INSTALL_DIR || DEFAULT_INSTALL_ROOT;
}

function resolveInstalledAppPath(root = installRoot()) {
  return path.join(root, `${productName}.app`);
}

const installedAppPath = resolveInstalledAppPath(DEFAULT_INSTALL_ROOT);

// 备份优先写入 Application Support；当终端进程被 macOS TCC 拦截时
// 自动降级到 Caches/tmp，保证本地安装流程不被系统权限中断。
function ensureWritableDir(directory) {
  fsSync.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.write-probe-${process.pid}`);
  fsSync.writeFileSync(probe, 'probe');
  fsSync.rmSync(probe, { force: true });
  return directory;
}

function installBackupRoot() {
  const candidates = [
    process.env.JIANDU_INSTALL_BACKUP_DIR,
    path.join(userDataPath, 'install-backups'),
    path.join(os.homedir(), 'Library', 'Caches', `${productName}-install-backups`),
    path.join(os.tmpdir(), `${productName}-install-backups`),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return ensureWritableDir(candidate);
    } catch {
      // 尝试下一个候选目录。
    }
  }
  throw new Error('无法创建安装备份目录。');
}

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
  installBackupRoot,
  installRoot,
  installedAppPath,
  packageJson,
  pathExists,
  productName,
  projectRoot,
  resolveInstalledAppPath,
  run,
  userDataPath,
};
