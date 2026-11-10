const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const UNUSED_PERMISSION_KEYS = Object.freeze([
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
]);

async function removePlistKey(infoPath, key, runImpl) {
  if (typeof runImpl !== 'function') throw new Error('afterPack 缺少命令执行器。');
  try {
    await runImpl('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, infoPath], {
      timeout: 10_000,
    });
    return true;
  } catch (error) {
    if (/Does Not Exist|Entry, .* Does Not Exist/.test(error.message)) return false;
    throw error;
  }
}

async function removeUnusedMacPermissionDescriptions(context, options = {}) {
  if (context.electronPlatformName !== 'darwin') return { removed: [] };
  const runImpl = options.runImpl || (async (command, args, runOptions = {}) => {
    try {
      return await execFileAsync(command, args, {
        timeout: runOptions.timeout || 10_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      throw Object.assign(new Error(String(error.stderr || error.message).trim()), { cause: error });
    }
  });
  const infoPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Info.plist',
  );
  const removed = [];
  for (const key of UNUSED_PERMISSION_KEYS) {
    if (await removePlistKey(infoPath, key, runImpl)) removed.push(key);
  }
  return { infoPath, removed };
}

module.exports = {
  UNUSED_PERMISSION_KEYS,
  removePlistKey,
  removeUnusedMacPermissionDescriptions,
};
