const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const TASK_DEFINITIONS = Object.freeze({
  text_asset_analysis: Object.freeze({
    modelType: 'text',
    runtime: 'mlx_lm',
    moduleName: 'mlx_lm',
    cacheDirectory: 'models--mlx-community--Qwen3-30B-A3B-Instruct-2507-4bit',
    modelId: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit',
    displayName: 'Qwen3-30B-A3B-Instruct-2507-4bit',
  }),
  edit_suggestion: Object.freeze({
    modelType: 'text',
    runtime: 'mlx_lm',
    moduleName: 'mlx_lm',
    cacheDirectory: 'models--mlx-community--Qwen3-30B-A3B-Instruct-2507-4bit',
    modelId: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit',
    displayName: 'Qwen3-30B-A3B-Instruct-2507-4bit',
  }),
  image_asset_analysis: Object.freeze({
    modelType: 'vision',
    runtime: 'mlx_vlm',
    moduleName: 'mlx_vlm.generate',
    cacheDirectory: 'models--mlx-community--Qwen3-VL-8B-Instruct-4bit',
    modelId: 'mlx-community/Qwen3-VL-8B-Instruct-4bit',
    displayName: 'Qwen3-VL-8B-Instruct-4bit',
  }),
});

const SUPPORTED_TASKS = Object.freeze(Object.keys(TASK_DEFINITIONS));

function createRouterError(code, message, model = null) {
  return Object.assign(new Error(message), {
    code,
    retryable: false,
    model,
  });
}

async function findSnapshotPath(cacheRoot, options = {}) {
  const statImpl = options.statImpl || fs.stat;
  const readdirImpl = options.readdirImpl || fs.readdir;
  const rootStat = await statImpl(cacheRoot).catch(() => null);
  if (!rootStat?.isDirectory()) return null;

  const snapshotsRoot = path.join(cacheRoot, 'snapshots');
  const entries = await readdirImpl(snapshotsRoot, { withFileTypes: true }).catch(() => []);
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of directories) {
    const candidate = path.join(snapshotsRoot, entry.name);
    const configStat = await statImpl(path.join(candidate, 'config.json')).catch(() => null);
    if (configStat?.isFile()) return candidate;
  }
  return null;
}

async function resolveModelForTask(taskName, options = {}) {
  const definition = TASK_DEFINITIONS[taskName];
  if (!definition) {
    throw createRouterError(
      'UNSUPPORTED_AI_TASK',
      `不支持的 AI 任务：${String(taskName || '') || '未提供'}。`,
    );
  }

  const homedirImpl = options.homedirImpl || os.homedir;
  const cacheRoot = path.join(
    homedirImpl(),
    '.cache',
    'huggingface',
    'hub',
    definition.cacheDirectory,
  );
  const baseResult = Object.freeze({
    taskName,
    modelType: definition.modelType,
    runtime: definition.runtime,
    moduleName: definition.moduleName,
    cacheRoot,
    snapshotPath: null,
    modelId: definition.modelId,
    displayName: definition.displayName,
  });
  const snapshotPath = await findSnapshotPath(cacheRoot, options);
  if (!snapshotPath) {
    throw createRouterError(
      'MODEL_NOT_FOUND',
      `未找到 ${definition.displayName} 的本地模型 snapshot。`,
      baseResult,
    );
  }
  return Object.freeze({
    ...baseResult,
    snapshotPath,
  });
}

module.exports = {
  SUPPORTED_TASKS,
  findSnapshotPath,
  resolveModelForTask,
};
