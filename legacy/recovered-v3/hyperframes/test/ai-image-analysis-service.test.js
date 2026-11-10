const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { AI_ANALYSIS_FILE, ASSETS_DIR, ASSETS_FILE } = require('../src/constants');
const {
  analyzeCurrentImageAsset,
  buildImageAnalysisPrompt,
  prepareImageInput,
  runMlxVlm,
} = require('../src/services/ai-image-analysis-service');

const IMAGE_MODEL_ROUTE = Object.freeze({
  taskName: 'image_asset_analysis',
  modelType: 'vision',
  runtime: 'mlx_vlm',
  moduleName: 'mlx_vlm.generate',
  cacheRoot: '/cache/image',
  snapshotPath: '/cache/image/snapshots/test',
  modelId: 'mlx-community/Qwen3-VL-8B-Instruct-4bit',
  displayName: 'Qwen3-VL-8B-Instruct-4bit',
});

const VALID_OUTPUT = JSON.stringify({
  aiSummary: '画面展示一条夜间街道。',
  aiTags: ['街道', '夜景'],
  aiRisk: { level: 'medium', flags: ['车牌'], reason: '车辆车牌可能清晰可见' },
  aiCaptionIdeas: ['夜色中的城市', '街灯亮起'],
  aiSuggestedUse: [{ role: 'opening', reason: '适合交代环境' }],
});

async function makeProject(asset) {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-image-analysis-'));
  await fs.mkdir(path.join(projectPath, '00-项目总控'), { recursive: true });
  await fs.mkdir(path.join(projectPath, ASSETS_DIR), { recursive: true });
  if (asset?.content != null) {
    await fs.writeFile(path.join(projectPath, ASSETS_DIR, asset.filename), asset.content);
  }
  const payload = {
    schemaVersion: 2,
    assets: asset ? [{
      stableId: asset.stableId || 'asset_1',
      filename: asset.filename,
      relativePath: path.join(ASSETS_DIR, asset.filename),
      availability: asset.availability || 'available',
      fingerprint: asset.fingerprint || 'image-fingerprint-1',
      type: asset.type || 'unknown',
      ext: path.extname(asset.filename).slice(1),
    }] : [],
  };
  await fs.writeFile(
    path.join(projectPath, ASSETS_FILE),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
  return projectPath;
}

function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}

async function expectPlaceholderFailure(payload) {
  const projectPath = await makeProject({ filename: 'placeholder.jpg', content: 'image' });
  const assetsPath = path.join(projectPath, ASSETS_FILE);
  const assetsBefore = await fs.readFile(assetsPath, 'utf8');
  await assert.rejects(
    () => analyzeCurrentImageAsset({ projectPath, stableId: 'asset_1' }, {
      resolveModelForTaskImpl: async () => IMAGE_MODEL_ROUTE,
      runMlxVlmImpl: async () => JSON.stringify(payload),
      now: () => '2026-06-30T13:00:00.000Z',
    }),
    (error) => error.code === 'PLACEHOLDER_OUTPUT'
      && error.message === '模型返回了模板占位符，未生成有效图片分析。'
      && error.retryable === true,
  );
  const written = JSON.parse(await fs.readFile(path.join(projectPath, AI_ANALYSIS_FILE), 'utf8'));
  const record = written.analyses.asset_1;
  assert.equal(record.aiStatus, 'failed');
  assert.equal(record.aiError.code, 'PLACEHOLDER_OUTPUT');
  assert.equal(record.aiError.message, '模型返回了模板占位符，未生成有效图片分析。');
  assert.equal(record.aiError.retryable, true);
  assert.equal(Object.hasOwn(record.aiError, 'stdout'), false);
  assert.equal(Object.hasOwn(record.aiError, 'stderr'), false);
  assert.equal(Object.hasOwn(record.aiError, 'stack'), false);
  assert.equal(record.aiModel, IMAGE_MODEL_ROUTE.modelId);
  assert.equal(await fs.readFile(assetsPath, 'utf8'), assetsBefore);
}

test('非图片素材拒绝分析', async () => {
  const projectPath = await makeProject({ filename: 'clip.mov', content: 'binary-ish' });
  await assert.rejects(
    () => prepareImageInput(projectPath, 'asset_1'),
    (error) => error.code === 'UNSUPPORTED_ASSET_TYPE',
  );
});

test('missing 图片素材拒绝分析', async () => {
  const projectPath = await makeProject({
    filename: 'missing.jpg', availability: 'missing', content: null,
  });
  await assert.rejects(
    () => prepareImageInput(projectPath, 'asset_1'),
    (error) => error.code === 'ASSET_MISSING',
  );
});

test('图片文件不存在返回 IMAGE_NOT_FOUND', async () => {
  const projectPath = await makeProject({ filename: 'gone.png', content: null });
  await assert.rejects(
    () => prepareImageInput(projectPath, 'asset_1'),
    (error) => error.code === 'IMAGE_NOT_FOUND',
  );
});

test('支持 jpg、jpeg、png、webp、heic 和 heif 图片扩展名', async () => {
  for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']) {
    const projectPath = await makeProject({ filename: `image.${ext}`, content: 'image' });
    const prepared = await prepareImageInput(projectPath, 'asset_1');
    assert.equal(prepared.sourceType, 'image');
  }
});

test('Python 不可用返回 PYTHON_NOT_AVAILABLE', async () => {
  const spawnImpl = () => {
    const child = createMockChild();
    setImmediate(() => child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' })));
    return child;
  };
  await assert.rejects(
    () => runMlxVlm('/image.jpg', 'prompt', {
      spawnImpl, pythonPath: '/missing/python', modelPath: '/model',
    }),
    (error) => error.code === 'PYTHON_NOT_AVAILABLE',
  );
});

test('mlx_vlm 不可用返回 MLX_VLM_NOT_AVAILABLE', async () => {
  const spawnImpl = () => {
    const child = createMockChild();
    setImmediate(() => {
      child.stderr.write("No module named 'mlx_vlm'");
      child.emit('close', 1);
    });
    return child;
  };
  await assert.rejects(
    () => runMlxVlm('/image.jpg', 'prompt', {
      spawnImpl, pythonPath: '/python', modelPath: '/model',
    }),
    (error) => error.code === 'MLX_VLM_NOT_AVAILABLE',
  );
});

test('runMlxVlm 使用参数数组且关闭 shell', async () => {
  let call;
  const spawnImpl = (command, args, options) => {
    call = { command, args, options };
    const child = createMockChild();
    setImmediate(() => {
      child.stdout.write(VALID_OUTPUT);
      child.emit('close', 0);
    });
    return child;
  };
  const output = await runMlxVlm('/safe/image.jpg', '分析图片', {
    spawnImpl, pythonPath: '/python', modelPath: '/model',
  });
  assert.equal(output, VALID_OUTPUT);
  assert.equal(call.command, '/python');
  assert.equal(Array.isArray(call.args), true);
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.args.slice(0, 2), ['-m', 'mlx_vlm.generate']);
  assert.equal(call.args[call.args.indexOf('--image') + 1], '/safe/image.jpg');
});

test('图片 Prompt 要求中文 JSON、避免编造并提示敏感信息风险', () => {
  const prompt = buildImageAnalysisPrompt();
  assert.match(prompt, /只输出 JSON/);
  assert.match(prompt, /不要编造图片中看不到的信息/);
  assert.match(prompt, /二维码/);
  assert.match(prompt, /风险提示只是辅助判断/);
  assert.match(prompt, /必须根据图片可见内容填写/);
  assert.match(prompt, /画面内容不清晰，无法可靠判断/);
  assert.match(prompt, /禁止输出字段说明、模板文字或示例标签/);
  for (const placeholder of [
    '一句到三句中文摘要',
    '标签1',
    '标签2',
    '轻字幕建议1',
    '轻字幕建议2',
    '轻字幕建议3',
  ]) {
    assert.doesNotMatch(prompt, new RegExp(placeholder));
  }
});

test('标准有效 JSON 仍写入 done', async () => {
  const projectPath = await makeProject({ filename: 'valid.jpg', content: 'image' });
  const result = await analyzeCurrentImageAsset({ projectPath, stableId: 'asset_1' }, {
    resolveModelForTaskImpl: async () => IMAGE_MODEL_ROUTE,
    runMlxVlmImpl: async () => VALID_OUTPUT,
    now: () => '2026-06-30T12:15:00.000Z',
  });
  assert.equal(result.analysis.aiStatus, 'done');
  assert.equal(result.analysis.aiSummary, '画面展示一条夜间街道。');
});

test('占位符摘要会写入 PLACEHOLDER_OUTPUT failed', async () => {
  const payload = JSON.parse(VALID_OUTPUT);
  payload.aiSummary = '一句到三句中文摘要';
  await expectPlaceholderFailure(payload);
});

test('占位符标签会写入 PLACEHOLDER_OUTPUT failed', async () => {
  const payload = JSON.parse(VALID_OUTPUT);
  payload.aiTags = ['夜景', '标签1', '标签2'];
  await expectPlaceholderFailure(payload);
});

test('占位符轻字幕建议会写入 PLACEHOLDER_OUTPUT failed', async () => {
  const payload = JSON.parse(VALID_OUTPUT);
  payload.aiCaptionIdeas = ['轻字幕建议1', '轻字幕建议2', '轻字幕建议3'];
  await expectPlaceholderFailure(payload);
});

test('空用途理由会写入 PLACEHOLDER_OUTPUT failed', async () => {
  const payload = JSON.parse(VALID_OUTPUT);
  payload.aiSuggestedUse = [{ role: 'reference', reason: '' }];
  await expectPlaceholderFailure(payload);
});

test('模型输出非 JSON 会写入 failed 且不保存堆栈或本机路径', async () => {
  const projectPath = await makeProject({ filename: 'photo.jpg', content: 'image' });
  await assert.rejects(
    () => analyzeCurrentImageAsset({ projectPath, stableId: 'asset_1' }, {
      resolveModelForTaskImpl: async () => IMAGE_MODEL_ROUTE,
      runMlxVlmImpl: async () => '不是 JSON',
      now: () => '2026-06-30T12:00:00.000Z',
    }),
    (error) => error.code === 'INVALID_MODEL_OUTPUT',
  );
  const written = JSON.parse(await fs.readFile(path.join(projectPath, AI_ANALYSIS_FILE), 'utf8'));
  const record = written.analyses.asset_1;
  assert.equal(record.aiStatus, 'failed');
  assert.equal(record.sourceType, 'image');
  assert.equal(record.aiError.code, 'INVALID_MODEL_OUTPUT');
  assert.equal(Object.hasOwn(record.aiError, 'stack'), false);
  assert.doesNotMatch(record.aiError.message, /\/Users\//);
});

test('fenced 有效 JSON 写入 done 且不修改 assets.json', async () => {
  const projectPath = await makeProject({ filename: 'photo.webp', content: 'image' });
  const assetsPath = path.join(projectPath, ASSETS_FILE);
  const assetsBefore = await fs.readFile(assetsPath, 'utf8');
  let requestedTask;
  let runnerOptions;
  const result = await analyzeCurrentImageAsset({ projectPath, stableId: 'asset_1' }, {
    resolveModelForTaskImpl: async (taskName) => {
      requestedTask = taskName;
      return IMAGE_MODEL_ROUTE;
    },
    runMlxVlmImpl: async (_imagePath, _prompt, options) => {
      runnerOptions = options;
      return `模型输出\n\`\`\`json\n${VALID_OUTPUT}\n\`\`\``;
    },
    now: () => '2026-06-30T12:30:00.000Z',
  });
  assert.equal(requestedTask, 'image_asset_analysis');
  assert.equal(runnerOptions.modelPath, IMAGE_MODEL_ROUTE.snapshotPath);
  assert.equal(runnerOptions.moduleName, IMAGE_MODEL_ROUTE.moduleName);
  assert.equal(result.analysis.aiModel, IMAGE_MODEL_ROUTE.modelId);
  assert.equal(result.analysis.aiStatus, 'done');
  assert.equal(result.analysis.sourceFingerprint, 'image-fingerprint-1');
  assert.equal(result.analysis.sourceType, 'image');
  assert.equal(result.analysis.attempt, 1);
  assert.equal(result.analysis.aiSuggestedUse[0].role, 'opening');
  assert.match(result.analysis.aiModel, /Qwen3-VL-8B-Instruct-4bit/);
  assert.equal(await fs.readFile(assetsPath, 'utf8'), assetsBefore);
});

test('图片服务不再持有模型路径或模型 ID 常量', async () => {
  const source = await fs.readFile(
    path.join(__dirname, '../src/services/ai-image-analysis-service.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /DEFAULT_MODEL_(?:CACHE_ROOT|ID)/);
  assert.doesNotMatch(source, /Qwen3-VL-8B-Instruct-4bit/);
  assert.doesNotMatch(source, /resolveLocalModelPath/);
});
