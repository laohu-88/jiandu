const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  analyzeBatchAssets,
  getAiEnvironmentIssue,
  selectBatchCandidates,
} = require('../src/services/ai-batch-analysis-service');

function asset(stableId, filename, options = {}) {
  return {
    stableId,
    filename,
    fingerprint: options.fingerprint || stableId + '-fingerprint',
    availability: options.availability || 'available',
    reviewStatus: options.reviewStatus || 'unreviewed',
    type: options.type || 'unknown',
  };
}

function payload(analyses = {}) {
  return { schemaVersion: 1, analyses };
}

test('unanalyzed 选择没有 AI 记录的支持文本和图片', () => {
  const result = selectBatchCandidates([
    asset('text_1', 'notes.md'),
    asset('image_1', 'photo.HEIC'),
  ], payload(), 'unanalyzed');

  assert.deepEqual(
    result.queued.map((item) => [item.stableId, item.assetType]),
    [['text_1', 'text'], ['image_1', 'image']],
  );
  assert.equal(result.skipped.length, 0);
});

test('unanalyzed 跳过视频、音频、其他文件和 missing', () => {
  const result = selectBatchCandidates([
    asset('video_1', 'clip.mov', { type: 'video' }),
    asset('audio_1', 'voice.wav', { type: 'audio' }),
    asset('binary_1', 'archive.zip'),
    asset('missing_1', 'lost.txt', { availability: 'missing' }),
  ], payload(), 'unanalyzed');

  assert.equal(result.queued.length, 0);
  assert.deepEqual(
    result.skipped.map((item) => item.reason),
    ['unsupported_type', 'unsupported_type', 'unsupported_type', 'missing'],
  );
});

test('unanalyzed 跳过 done 且 fingerprint 一致的素材', () => {
  const current = asset('text_1', 'notes.txt');
  const result = selectBatchCandidates([current], payload({
    text_1: {
      stableId: 'text_1',
      aiStatus: 'done',
      sourceFingerprint: current.fingerprint,
    },
  }), 'unanalyzed');

  assert.equal(result.queued.length, 0);
  assert.equal(result.skipped[0].reason, 'already_done');
});

test('unanalyzed 加入 stale 素材且不计为 skipped', () => {
  const result = selectBatchCandidates([
    asset('text_1', 'notes.vtt', { fingerprint: 'new-fingerprint' }),
  ], payload({
    text_1: {
      stableId: 'text_1',
      aiStatus: 'done',
      sourceFingerprint: 'old-fingerprint',
    },
  }), 'unanalyzed');

  assert.equal(result.queued[0].reason, 'stale_included');
  assert.equal(result.skipped.length, 0);
  assert.equal(result.reasons.stale_included, 1);
});

test('unanalyzed 加入 failed 素材用于重试', () => {
  const current = asset('image_1', 'photo.webp');
  const result = selectBatchCandidates([current], payload({
    image_1: {
      stableId: 'image_1',
      aiStatus: 'failed',
      sourceFingerprint: current.fingerprint,
    },
  }), 'unanalyzed');

  assert.equal(result.queued[0].reason, 'failed_retry_included');
  assert.equal(result.skipped.length, 0);
});

test('kept 只选择 reviewStatus 为 keep 的支持文本和图片', () => {
  const result = selectBatchCandidates([
    asset('keep_text', 'keep.csv', { reviewStatus: 'keep' }),
    asset('keep_image', 'keep.png', { reviewStatus: 'keep' }),
    asset('maybe_text', 'maybe.json', { reviewStatus: 'maybe' }),
    asset('reject_image', 'reject.jpg', { reviewStatus: 'reject' }),
  ], payload(), 'kept');

  assert.deepEqual(result.queued.map((item) => item.stableId), ['keep_text', 'keep_image']);
  assert.deepEqual(result.skipped.map((item) => item.reason), ['not_kept', 'not_kept']);
});

test('kept 跳过 done 且 fingerprint 一致的保留素材', () => {
  const current = asset('keep_text', 'keep.srt', { reviewStatus: 'keep' });
  const result = selectBatchCandidates([current], payload({
    keep_text: {
      stableId: 'keep_text',
      aiStatus: 'done',
      sourceFingerprint: current.fingerprint,
    },
  }), 'kept');

  assert.equal(result.queued.length, 0);
  assert.equal(result.skipped[0].reason, 'already_done');
});

test('单个素材失败不影响后续素材，且执行始终为单并发', async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const run = async ({ stableId }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push(stableId);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    if (stableId === 'text_1') {
      throw Object.assign(new Error('本机路径不应进入结果'), { code: 'MOCK_TEXT_FAILED' });
    }
  };

  const result = await analyzeBatchAssets({
    projectPath: '/mock-project',
    assets: [asset('text_1', 'one.txt'), asset('image_1', 'two.jpeg')],
    aiAnalysis: payload(),
    mode: 'unanalyzed',
  }, {
    analyzeTextImpl: run,
    analyzeImageImpl: run,
  });

  assert.deepEqual(calls, ['text_1', 'image_1']);
  assert.equal(maxActive, 1);
  assert.equal(result.success, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results.find((item) => item.stableId === 'text_1').reason, 'MOCK_TEXT_FAILED');
  assert.equal(result.results.find((item) => item.stableId === 'image_1').status, 'done');
});

test('批量汇总 success、failed、skipped 和进度正确', async () => {
  const progress = [];
  const result = await analyzeBatchAssets({
    projectPath: '/mock-project',
    assets: [
      asset('text_1', 'one.md'),
      asset('image_1', 'two.png'),
      asset('video_1', 'three.mp4', { type: 'video' }),
    ],
    aiAnalysis: payload(),
    mode: 'unanalyzed',
  }, {
    analyzeTextImpl: async () => {},
    analyzeImageImpl: async () => {
      throw Object.assign(new Error('mock'), { code: 'MOCK_IMAGE_FAILED' });
    },
    onProgress: (item) => progress.push(item),
  });

  assert.deepEqual(
    { total: result.total, success: result.success, failed: result.failed, skipped: result.skipped },
    { total: 2, success: 1, failed: 1, skipped: 1 },
  );
  assert.equal(progress[0].phase, 'started');
  assert.deepEqual(
    progress.filter((item) => item.phase === 'running').map((item) => item.filename),
    ['one.md', 'two.png'],
  );
  assert.deepEqual(
    progress.at(-1),
    {
      phase: 'completed',
      current: 2,
      filename: 'two.png',
      total: 2,
      success: 1,
      failed: 1,
      skipped: 1,
    },
  );
});

test('批量服务不修改 assets.json，分析函数使用 mock', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-batch-assets-'));
  const assetsPath = path.join(projectPath, 'assets.json');
  const original = '{"assets":[{"stableId":"text_1","reviewStatus":"keep"}]}\n';
  await fs.writeFile(assetsPath, original, 'utf8');

  await analyzeBatchAssets({
    projectPath,
    assets: [asset('text_1', 'one.txt')],
    aiAnalysis: payload(),
    mode: 'unanalyzed',
  }, {
    analyzeTextImpl: async () => {},
    analyzeImageImpl: async () => {},
  });

  assert.equal(await fs.readFile(assetsPath, 'utf8'), original);
});

test('环境检查只要求候选类型实际需要的 MLX 包', () => {
  const environment = {
    python: { ok: true, arch: 'arm64' },
    packages: {
      mlx: { ok: true },
      mlx_lm: { ok: true },
      mlx_vlm: { ok: false },
    },
  };
  assert.equal(getAiEnvironmentIssue(environment, [{ assetType: 'text' }]), null);
  assert.equal(
    getAiEnvironmentIssue(environment, [{ assetType: 'image' }]),
    'mlx_vlm 不可用。',
  );
});

test('批量服务不导入或拼接 shell 命令', async () => {
  const source = await fs.readFile(
    path.join(__dirname, '../src/services/ai-batch-analysis-service.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /child_process|execFile|execSync|spawnSync|shell\s*:/);
});
