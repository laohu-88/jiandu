const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_MLX_PYTHON_PATH,
  checkAiEnvironment,
  getPythonCandidates,
} = require('../src/services/ai-environment-service');

function pythonPayload({ arch = 'arm64', packages = {} } = {}) {
  return JSON.stringify({
    python: {
      ok: true,
      path: '/fake/python3',
      version: '3.12.4',
      arch,
    },
    packages: {
      mlx: { ok: true, version: '0.26.0', error: null },
      mlx_lm: { ok: true, version: '0.25.2', error: null },
      mlx_vlm: { ok: true, version: '0.2.3', error: null },
      ...packages,
    },
    diagnostics: { stdout: '', stderr: '' },
  });
}

test('Python 不存在时返回 available false', async () => {
  const execFileImpl = (_command, _args, _options, callback) => {
    const error = Object.assign(new Error('not found'), { code: 'ENOENT' });
    callback(error, '', '');
  };
  const result = await checkAiEnvironment({
    candidates: ['missing-python3', 'missing-python'],
    env: {},
    execFileImpl,
  });

  assert.equal(result.available, false);
  assert.equal(result.python.ok, false);
  assert.equal(result.errors[0].code, 'PYTHON_NOT_FOUND');
});

test('Python 存在但 mlx 缺失时返回 available false 并列出缺失包', async () => {
  const execFileImpl = (_command, _args, _options, callback) => callback(
    null,
    pythonPayload({
      packages: {
        mlx: { ok: false, version: null, error: "ModuleNotFoundError: No module named 'mlx'" },
      },
    }),
    '',
  );
  const result = await checkAiEnvironment({
    candidates: ['python3'],
    env: {},
    execFileImpl,
  });

  assert.equal(result.available, false);
  assert.deepEqual(result.missingPackages, ['mlx']);
  assert.equal(result.packages.mlx.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'PACKAGE_MISSING'));
});

test('mlx、mlx_lm、mlx_vlm 均存在且架构为 arm64 时返回 available true', async () => {
  const execFileImpl = (_command, _args, _options, callback) => {
    callback(null, pythonPayload(), '');
  };
  const result = await checkAiEnvironment({
    candidates: ['python3'],
    env: {},
    execFileImpl,
  });

  assert.equal(result.available, true);
  assert.equal(result.python.path, '/fake/python3');
  assert.equal(result.python.version, '3.12.4');
  assert.equal(result.python.arch, 'arm64');
  assert.deepEqual(result.missingPackages, []);
});

test('检测超时时返回明确错误', async () => {
  const execFileImpl = (_command, _args, _options, callback) => {
    const error = Object.assign(new Error('Command timed out'), {
      killed: true,
      signal: 'SIGTERM',
    });
    callback(error, '', 'partial stderr');
  };
  const result = await checkAiEnvironment({
    candidates: ['python3'],
    env: {},
    execFileImpl,
    timeoutMs: 25,
  });

  assert.equal(result.available, false);
  assert.equal(result.errors[0].code, 'DETECTION_TIMEOUT');
  assert.match(result.errors[0].message, /超时/);
  assert.equal(result.diagnostics.stderr, 'partial stderr');
});

test('检测使用 execFile 参数数组且禁用 shell，并优先采用配置和环境变量路径', async () => {
  const calls = [];
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(null, pythonPayload(), '');
  };
  const candidates = getPythonCandidates({
    pythonPath: '/configured/python',
    env: { MLX_PYTHON_PATH: '/env/python' },
  });
  assert.deepEqual(candidates.slice(0, 4), [
    '/configured/python',
    '/env/python',
    DEFAULT_MLX_PYTHON_PATH,
    '/opt/homebrew/bin/python3',
  ]);

  await checkAiEnvironment({
    pythonPath: '/configured/python',
    env: { MLX_PYTHON_PATH: '/env/python' },
    candidates: ['python3'],
    execFileImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/configured/python');
  assert.equal(calls[0].args[0], '-c');
  assert.equal(Array.isArray(calls[0].args), true);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 10_000);
});

test('没有保存路径时在环境变量之后包含默认 MLX 虚拟环境路径', () => {
  const candidates = getPythonCandidates({
    env: {
      MLX_PYTHON_PATH: '/env/mlx-python',
      AI_PYTHON_PATH: '/env/ai-python',
    },
  });

  assert.deepEqual(candidates.slice(0, 4), [
    '/env/mlx-python',
    '/env/ai-python',
    DEFAULT_MLX_PYTHON_PATH,
    '/opt/homebrew/bin/python3',
  ]);
});

test('已保存路径不存在时返回明确错误且不回退其他 Python', async () => {
  const calls = [];
  const execFileImpl = (command, _args, _options, callback) => {
    calls.push(command);
    callback(Object.assign(new Error('not found'), { code: 'ENOENT' }), '', '');
  };
  const result = await checkAiEnvironment({
    pythonPath: '/saved/missing-python',
    env: {},
    candidates: ['python3'],
    execFileImpl,
  });

  assert.equal(result.available, false);
  assert.deepEqual(calls, ['/saved/missing-python']);
  assert.equal(result.errors[0].code, 'CONFIGURED_PYTHON_NOT_FOUND');
  assert.match(result.errors[0].message, /路径不存在/);
});

test('已保存路径不可执行时返回明确错误且不回退其他 Python', async () => {
  const calls = [];
  const execFileImpl = (command, _args, _options, callback) => {
    calls.push(command);
    callback(Object.assign(new Error('permission denied'), { code: 'EACCES' }), '', '');
  };
  const result = await checkAiEnvironment({
    pythonPath: '/saved/non-executable-python',
    env: {},
    candidates: ['python3'],
    execFileImpl,
  });

  assert.equal(result.available, false);
  assert.deepEqual(calls, ['/saved/non-executable-python']);
  assert.equal(result.errors[0].code, 'CONFIGURED_PYTHON_NOT_EXECUTABLE');
  assert.match(result.errors[0].message, /不可执行/);
});
