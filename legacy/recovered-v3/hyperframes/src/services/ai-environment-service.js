const { execFile } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MLX_PYTHON_PATH = '/Users/example/AI/mlx-env/venv/bin/python';
const DEFAULT_PYTHON_CANDIDATES = [
  DEFAULT_MLX_PYTHON_PATH,
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  '/usr/bin/python3',
  'python3',
  'python',
];

const PYTHON_DETECTION_SCRIPT = String.raw`
import contextlib
import importlib
import importlib.metadata
import io
import json
import os
import platform
import sys

package_specs = {
    "mlx": ["mlx"],
    "mlx_lm": ["mlx-lm", "mlx_lm"],
    "mlx_vlm": ["mlx-vlm", "mlx_vlm"],
}
captured_stdout = io.StringIO()
captured_stderr = io.StringIO()
packages = {}

with contextlib.redirect_stdout(captured_stdout), contextlib.redirect_stderr(captured_stderr):
    for module_name, distribution_names in package_specs.items():
        version = None
        for distribution_name in distribution_names:
            try:
                version = importlib.metadata.version(distribution_name)
                break
            except importlib.metadata.PackageNotFoundError:
                pass
        try:
            module = importlib.import_module(module_name)
            if version is None:
                version = getattr(module, "__version__", None)
            packages[module_name] = {"ok": True, "version": version, "error": None}
        except Exception as error:
            packages[module_name] = {
                "ok": False,
                "version": version,
                "error": "%s: %s" % (type(error).__name__, error),
            }

print(json.dumps({
    "python": {
        "ok": True,
        "path": os.path.abspath(sys.executable),
        "version": platform.python_version(),
        "arch": platform.machine(),
    },
    "packages": packages,
    "diagnostics": {
        "stdout": captured_stdout.getvalue(),
        "stderr": captured_stderr.getvalue(),
    },
}))
`;

function uniqueCandidates(candidates) {
  return [...new Set(candidates.filter(
    (candidate) => typeof candidate === 'string' && candidate.trim(),
  ).map((candidate) => candidate.trim()))];
}

function getPythonCandidates({ pythonPath, env = process.env, candidates } = {}) {
  return uniqueCandidates([
    pythonPath,
    env.MLX_PYTHON_PATH,
    env.AI_PYTHON_PATH,
    ...(candidates || DEFAULT_PYTHON_CANDIDATES),
  ]);
}

function runExecFile(execFileImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    try {
      execFileImpl(command, args, options, (error, stdout = '', stderr = '') => {
        if (error) {
          error.stdout = error.stdout || stdout;
          error.stderr = error.stderr || stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    } catch (error) {
      reject(error);
    }
  });
}

function emptyResult() {
  return {
    available: false,
    python: {
      ok: false,
      path: null,
      version: null,
      arch: null,
    },
    packages: {
      mlx: { ok: false, version: null, error: null },
      mlx_lm: { ok: false, version: null, error: null },
      mlx_vlm: { ok: false, version: null, error: null },
    },
    missingPackages: [],
    errors: [],
    diagnostics: { stdout: '', stderr: '' },
  };
}

function isNotFoundError(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function isNotExecutableError(error) {
  return error?.code === 'EACCES' || error?.code === 'EPERM';
}

function isTimeoutError(error) {
  return error?.code === 'ETIMEDOUT'
    || error?.killed === true
    || (error?.signal === 'SIGTERM' && /timed?\s*out|timeout/i.test(error.message || ''));
}

function failedExecutionResult(candidate, error) {
  const result = emptyResult();
  result.python.path = candidate;
  result.diagnostics.stderr = String(error?.stderr || '').trim();
  if (isTimeoutError(error)) {
    result.errors.push({
      code: 'DETECTION_TIMEOUT',
      message: `Python 环境检测超时：${candidate}`,
    });
  } else {
    result.errors.push({
      code: 'DETECTION_FAILED',
      message: `Python 环境检测失败：${error?.message || candidate}`,
    });
  }
  return result;
}

function invalidConfiguredPathResult(candidate, error) {
  const result = emptyResult();
  result.python.path = candidate;
  const notFound = isNotFoundError(error);
  result.errors.push({
    code: notFound ? 'CONFIGURED_PYTHON_NOT_FOUND' : 'CONFIGURED_PYTHON_NOT_EXECUTABLE',
    message: notFound
      ? `已保存的 MLX Python 路径不存在：${candidate}`
      : `已保存的 MLX Python 路径不可执行：${candidate}`,
  });
  result.diagnostics.stderr = String(error?.stderr || '').trim();
  return result;
}

function buildResult(payload, stderr = '') {
  const result = emptyResult();
  result.python = {
    ...result.python,
    ...(payload.python || {}),
    ok: payload.python?.ok === true,
  };
  for (const packageName of Object.keys(result.packages)) {
    const packageResult = payload.packages?.[packageName] || {};
    result.packages[packageName] = {
      ok: packageResult.ok === true,
      version: packageResult.version || null,
      error: packageResult.error || null,
    };
    if (!result.packages[packageName].ok) {
      result.missingPackages.push(packageName);
      result.errors.push({
        code: 'PACKAGE_MISSING',
        package: packageName,
        message: `${packageName} 不可用${packageResult.error ? `：${packageResult.error}` : ''}`,
      });
    }
  }
  if (result.python.ok && result.python.arch !== 'arm64') {
    result.errors.push({
      code: 'UNSUPPORTED_ARCH',
      message: `当前 Python 架构为 ${result.python.arch || '未知'}，需要 arm64。`,
    });
  }
  result.diagnostics = {
    stdout: String(payload.diagnostics?.stdout || ''),
    stderr: [payload.diagnostics?.stderr, stderr].filter(Boolean).join('\n').trim(),
  };
  result.available = result.python.ok
    && result.python.arch === 'arm64'
    && result.missingPackages.length === 0;
  return result;
}

async function checkAiEnvironment(options = {}) {
  const {
    execFileImpl = execFile,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;
  const candidates = getPythonCandidates(options);
  const configuredPythonPath = typeof options.pythonPath === 'string'
    ? options.pythonPath.trim()
    : '';

  for (const candidate of candidates) {
    let execution;
    try {
      execution = await runExecFile(
        execFileImpl,
        candidate,
        ['-c', PYTHON_DETECTION_SCRIPT],
        {
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          shell: false,
        },
      );
    } catch (error) {
      if (
        candidate === configuredPythonPath
        && (isNotFoundError(error) || isNotExecutableError(error))
      ) {
        return invalidConfiguredPathResult(candidate, error);
      }
      if (isNotFoundError(error)) continue;
      return failedExecutionResult(candidate, error);
    }

    try {
      return buildResult(JSON.parse(execution.stdout), execution.stderr);
    } catch (error) {
      return failedExecutionResult(candidate, Object.assign(
        new Error(`无法解析 Python 检测结果：${error.message}`),
        { stderr: execution.stderr },
      ));
    }
  }

  const result = emptyResult();
  result.errors.push({
    code: 'PYTHON_NOT_FOUND',
    message: '未找到可用的 python3 或 python。',
  });
  return result;
}

module.exports = {
  DEFAULT_MLX_PYTHON_PATH,
  DEFAULT_PYTHON_CANDIDATES,
  DEFAULT_TIMEOUT_MS,
  PYTHON_DETECTION_SCRIPT,
  checkAiEnvironment,
  getPythonCandidates,
};
