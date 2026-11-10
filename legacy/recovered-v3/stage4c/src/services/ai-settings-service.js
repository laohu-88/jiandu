const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');

const AI_SETTINGS_FILE = 'ai-settings.json';

function defaultSettings() {
  return {
    schemaVersion: 1,
    mlxPythonPath: '',
  };
}

function settingsPath(userDataPath) {
  return path.join(userDataPath, AI_SETTINGS_FILE);
}

function createPathError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function validateMlxPythonPath(pythonPath) {
  const normalizedPath = typeof pythonPath === 'string' ? pythonPath.trim() : '';
  if (!normalizedPath) return '';

  let stat;
  try {
    stat = await fs.stat(normalizedPath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw createPathError(
        'MLX_PYTHON_NOT_FOUND',
        `MLX Python 路径不存在：${normalizedPath}`,
      );
    }
    throw error;
  }
  if (!stat.isFile()) {
    throw createPathError(
      'MLX_PYTHON_NOT_FOUND',
      `MLX Python 路径不是文件：${normalizedPath}`,
    );
  }

  try {
    await fs.access(normalizedPath, fsConstants.X_OK);
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw createPathError(
        'MLX_PYTHON_NOT_EXECUTABLE',
        `MLX Python 路径不可执行：${normalizedPath}`,
      );
    }
    throw error;
  }
  return normalizedPath;
}

async function loadAiSettings(userDataPath) {
  const filePath = settingsPath(userDataPath);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return defaultSettings();
    if (error instanceof SyntaxError) {
      throw createPathError('AI_SETTINGS_INVALID', `AI 设置文件格式错误：${filePath}`);
    }
    throw error;
  }
  return {
    ...defaultSettings(),
    mlxPythonPath: typeof parsed?.mlxPythonPath === 'string'
      ? parsed.mlxPythonPath.trim()
      : '',
  };
}

async function saveAiSettings(userDataPath, settings = {}) {
  const mlxPythonPath = await validateMlxPythonPath(settings.mlxPythonPath);
  const payload = {
    ...defaultSettings(),
    mlxPythonPath,
  };
  const filePath = settingsPath(userDataPath);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
  return payload;
}

module.exports = {
  AI_SETTINGS_FILE,
  defaultSettings,
  loadAiSettings,
  saveAiSettings,
  settingsPath,
  validateMlxPythonPath,
};
