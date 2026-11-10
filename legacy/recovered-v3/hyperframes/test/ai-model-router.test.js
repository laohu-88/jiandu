const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  SUPPORTED_TASKS,
  resolveModelForTask,
} = require('../src/services/ai-model-router');

const CACHE_DIRECTORIES = {
  text_asset_analysis: 'models--mlx-community--Qwen3-30B-A3B-Instruct-2507-4bit',
  edit_suggestion: 'models--mlx-community--Qwen3-30B-A3B-Instruct-2507-4bit',
  image_asset_analysis: 'models--mlx-community--Qwen3-VL-8B-Instruct-4bit',
};

async function makeModelHome(taskName, { withConfig = true } = {}) {
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-model-router-'));
  const snapshotPath = path.join(
    homePath,
    '.cache',
    'huggingface',
    'hub',
    CACHE_DIRECTORIES[taskName],
    'snapshots',
    'test-snapshot',
  );
  await fs.mkdir(snapshotPath, { recursive: true });
  if (withConfig) await fs.writeFile(path.join(snapshotPath, 'config.json'), '{}', 'utf8');
  return { homePath, snapshotPath };
}

test('router 支持文本素材、剪辑建议和图片素材任务', () => {
  assert.deepEqual(SUPPORTED_TASKS, [
    'text_asset_analysis',
    'edit_suggestion',
    'image_asset_analysis',
  ]);
});

test('text_asset_analysis 返回 Qwen3 主力文本模型与 mlx_lm', async () => {
  const { homePath, snapshotPath } = await makeModelHome('text_asset_analysis');
  const model = await resolveModelForTask('text_asset_analysis', {
    homedirImpl: () => homePath,
  });
  assert.equal(model.taskName, 'text_asset_analysis');
  assert.equal(model.modelType, 'text');
  assert.equal(model.runtime, 'mlx_lm');
  assert.equal(model.moduleName, 'mlx_lm');
  assert.equal(model.snapshotPath, snapshotPath);
  assert.equal(model.modelId, 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit');
  assert.equal(model.displayName, 'Qwen3-30B-A3B-Instruct-2507-4bit');
});

test('edit_suggestion 复用 Qwen3 主力文本模型且不回退其他模型', async () => {
  const { homePath, snapshotPath } = await makeModelHome('edit_suggestion');
  const model = await resolveModelForTask('edit_suggestion', {
    homedirImpl: () => homePath,
  });
  assert.equal(model.taskName, 'edit_suggestion');
  assert.equal(model.modelType, 'text');
  assert.equal(model.runtime, 'mlx_lm');
  assert.equal(model.moduleName, 'mlx_lm');
  assert.equal(model.snapshotPath, snapshotPath);
  assert.equal(model.modelId, 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit');
  assert.equal(model.displayName, 'Qwen3-30B-A3B-Instruct-2507-4bit');
});

test('image_asset_analysis 返回 Qwen3-VL 看图模型与 mlx_vlm', async () => {
  const { homePath, snapshotPath } = await makeModelHome('image_asset_analysis');
  const model = await resolveModelForTask('image_asset_analysis', {
    homedirImpl: () => homePath,
  });
  assert.equal(model.taskName, 'image_asset_analysis');
  assert.equal(model.modelType, 'vision');
  assert.equal(model.runtime, 'mlx_vlm');
  assert.equal(model.moduleName, 'mlx_vlm.generate');
  assert.equal(model.snapshotPath, snapshotPath);
  assert.equal(model.modelId, 'mlx-community/Qwen3-VL-8B-Instruct-4bit');
  assert.equal(model.displayName, 'Qwen3-VL-8B-Instruct-4bit');
});

test('不支持的 taskName 返回明确错误且没有 Coder 或 Gemma 路由', async () => {
  for (const taskName of ['code_analysis', 'gemma_review', '', null]) {
    await assert.rejects(
      () => resolveModelForTask(taskName),
      (error) => error.code === 'UNSUPPORTED_AI_TASK' && /不支持的 AI 任务/.test(error.message),
    );
  }
});

test('cacheRoot 不存在时返回 MODEL_NOT_FOUND', async () => {
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-model-router-missing-'));
  await assert.rejects(
    () => resolveModelForTask('text_asset_analysis', { homedirImpl: () => homePath }),
    (error) => error.code === 'MODEL_NOT_FOUND'
      && error.model?.modelId === 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit'
      && error.model?.snapshotPath === null,
  );
});

test('snapshots 中没有 config.json 时返回 MODEL_NOT_FOUND', async () => {
  const { homePath } = await makeModelHome('image_asset_analysis', { withConfig: false });
  await assert.rejects(
    () => resolveModelForTask('image_asset_analysis', { homedirImpl: () => homePath }),
    (error) => error.code === 'MODEL_NOT_FOUND',
  );
});

test('snapshotPath、modelId 与 runtime 由同一个冻结路由结果返回', async () => {
  const { homePath, snapshotPath } = await makeModelHome('image_asset_analysis');
  const model = await resolveModelForTask('image_asset_analysis', {
    homedirImpl: () => homePath,
  });
  assert.equal(Object.isFrozen(model), true);
  assert.deepEqual(
    [model.snapshotPath, model.modelId, model.runtime],
    [snapshotPath, 'mlx-community/Qwen3-VL-8B-Instruct-4bit', 'mlx_vlm'],
  );
});
