const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  loadAiSettings,
  saveAiSettings,
  settingsPath,
} = require('../src/services/ai-settings-service');

test('没有保存路径时返回空设置且不创建配置文件', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-settings-empty-'));
  const settings = await loadAiSettings(userDataPath);

  assert.equal(settings.mlxPythonPath, '');
  await assert.rejects(() => fs.stat(settingsPath(userDataPath)), { code: 'ENOENT' });
});

test('MLX Python 路径保存到 userData 下并可再次读取', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-settings-save-'));
  const saved = await saveAiSettings(userDataPath, { mlxPythonPath: process.execPath });
  const loaded = await loadAiSettings(userDataPath);

  assert.equal(saved.mlxPythonPath, process.execPath);
  assert.equal(loaded.mlxPythonPath, process.execPath);
  assert.equal(path.dirname(settingsPath(userDataPath)), userDataPath);
});

test('保存不存在的 MLX Python 路径时返回明确错误', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-settings-missing-'));
  const missingPath = path.join(userDataPath, 'missing-python');

  await assert.rejects(
    () => saveAiSettings(userDataPath, { mlxPythonPath: missingPath }),
    (error) => error.code === 'MLX_PYTHON_NOT_FOUND' && /路径不存在/.test(error.message),
  );
});

test('保存不可执行的 MLX Python 路径时返回明确错误', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-settings-no-exec-'));
  const pythonPath = path.join(userDataPath, 'python');
  await fs.writeFile(pythonPath, '#!/bin/sh\n', { mode: 0o600 });
  await fs.chmod(pythonPath, 0o600);

  await assert.rejects(
    () => saveAiSettings(userDataPath, { mlxPythonPath: pythonPath }),
    (error) => error.code === 'MLX_PYTHON_NOT_EXECUTABLE' && /不可执行/.test(error.message),
  );
});
