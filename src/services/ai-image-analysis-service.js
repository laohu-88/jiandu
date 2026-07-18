const path = require('node:path');
const { spawn } = require('node:child_process');

const { resolvePreviewAsset } = require('./media-service');
const { getAiAnalysis, updateAiAnalysis } = require('./ai-analysis-store');
const { DEFAULT_MLX_PYTHON_PATH } = require('./ai-environment-service');
const { parseModelOutput } = require('./ai-analysis-output-parser');
const { resolveModelForTask } = require('./ai-model-router');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);
const DEFAULT_TIMEOUT_MS = 240_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const PROMPT_VERSION = 'image-asset-analysis-v1';
const PREPROCESS_VERSION = 'image-direct-v1';

function createServiceError(code, message, options = {}) {
  return Object.assign(new Error(message), {
    code,
    retryable: options.retryable === true,
  });
}

async function prepareImageInput(projectPath, stableId, options = {}) {
  const resolveAssetImpl = options.resolveAssetImpl || resolvePreviewAsset;
  let resolved;
  try {
    resolved = await resolveAssetImpl(projectPath, stableId);
  } catch (error) {
    if (/missing/i.test(error?.message || '')) {
      throw createServiceError('ASSET_MISSING', 'missing 素材不能分析。');
    }
    if (/文件不存在|ENOENT/i.test(error?.message || '') || error?.code === 'ENOENT') {
      throw createServiceError('IMAGE_NOT_FOUND', '图片文件不存在。');
    }
    throw error;
  }

  const { asset, absolutePath } = resolved;
  const ext = path.extname(asset.filename || absolutePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    throw createServiceError('UNSUPPORTED_ASSET_TYPE', '当前阶段只支持图片素材。');
  }
  return {
    asset,
    imagePath: absolutePath,
    sourceType: 'image',
  };
}

function buildImageAnalysisPrompt() {
  return `你是视频项目的图片素材分析助手。请只根据当前图片中真实可见的内容进行分析，并只输出一个 JSON 对象。

规则：
1. 所有说明和字段内容使用中文。
2. 只输出 JSON，不要 Markdown，不要代码围栏，不要思考过程。
3. 不要编造图片中看不到的信息，不推断未经画面支持的身份、地点、时间或事件。
4. 必须根据图片可见内容填写每个字段，禁止输出字段说明、模板文字或示例标签。
5. 如果画面看不清，aiSummary 写“画面内容不清晰，无法可靠判断”，其他无法判断的数组返回空数组。
6. 风险提示只是辅助判断，不是最终审核结论；如果画面可能包含隐私、文件路径、账号、二维码、车牌、地址、聊天记录或其他敏感信息，写入 aiRisk。

字段与类型约束：
- aiSummary：字符串，用 1 至 3 句中文概括画面。
- aiTags：字符串数组，最多 12 项，只写从画面得到的具体标签。
- aiRisk：对象；level 只能是 low、medium、high、unknown，flags 是字符串数组，reason 是中文字符串。
- aiCaptionIdeas：字符串数组，最多 3 项，每项必须是基于画面的轻字幕文案。
- aiSuggestedUse：对象数组；role 只能是 opening、process、result、transition、reference、unused，reason 必须说明基于画面的判断理由；没有可靠建议时返回空数组，不要用空 reason 占位。`;
}

function validateImageAnalysisResult(analysis) {
  const summaryHasPlaceholder = String(analysis?.aiSummary || '')
    .includes('一句到三句中文摘要');
  const tagsHavePlaceholder = (analysis?.aiTags || []).some(
    (tag) => /标签[12]/.test(String(tag)),
  );
  const captionsHavePlaceholder = (analysis?.aiCaptionIdeas || []).some(
    (caption) => /轻字幕建议[123]/.test(String(caption)),
  );
  const suggestedUseHasPlaceholder = (analysis?.aiSuggestedUse || []).some((item) => {
    const reason = String(item?.reason || '').trim();
    return !reason || /^(?:原因|理由|用途说明|使用理由|使用原因|请填写|待填写)$/.test(reason);
  });
  if (summaryHasPlaceholder
    || tagsHavePlaceholder
    || captionsHavePlaceholder
    || suggestedUseHasPlaceholder) {
    throw createServiceError(
      'PLACEHOLDER_OUTPUT',
      '模型返回了模板占位符，未生成有效图片分析。',
      { retryable: true },
    );
  }
  return analysis;
}

function runMlxVlm(imagePath, prompt, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const pythonPath = options.pythonPath || DEFAULT_MLX_PYTHON_PATH;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const args = [
    '-m', options.moduleName || 'mlx_vlm.generate',
    '--model', options.modelPath,
    '--image', imagePath,
    '--prompt', prompt,
    '--max-tokens', String(options.maxTokens || 768),
  ];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(pythonPath, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(createServiceError(
        error?.code === 'ENOENT' ? 'PYTHON_NOT_AVAILABLE' : 'MLX_VLM_GENERATION_FAILED',
        error?.code === 'ENOENT' ? '配置的 MLX Python 不可用。' : '无法启动 MLX-VLM 图片分析。',
        { retryable: true },
      ));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let outputTooLarge = false;
    let timer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() => reject(createServiceError(
        'ANALYSIS_TIMEOUT',
        'MLX-VLM 图片分析超时。',
        { retryable: true },
      )));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 16_384) stderr += chunk.toString();
    });
    child.on('error', (error) => finish(() => reject(createServiceError(
      error?.code === 'ENOENT' ? 'PYTHON_NOT_AVAILABLE' : 'MLX_VLM_GENERATION_FAILED',
      error?.code === 'ENOENT' ? '配置的 MLX Python 不可用。' : 'MLX-VLM 图片分析进程启动失败。',
      { retryable: true },
    ))));
    child.on('close', (code) => finish(() => {
      if (outputTooLarge) {
        reject(createServiceError('MODEL_OUTPUT_TOO_LARGE', '模型输出过大。', { retryable: true }));
      } else if (code === 0) {
        resolve(stdout);
      } else if (/No module named ['"]?mlx_vlm|ModuleNotFoundError.*mlx_vlm/i.test(stderr)) {
        reject(createServiceError('MLX_VLM_NOT_AVAILABLE', '当前 Python 环境中 mlx_vlm 不可用。'));
      } else {
        reject(createServiceError('MLX_VLM_GENERATION_FAILED', 'MLX-VLM 图片分析失败。', {
          retryable: true,
        }));
      }
    }));
  });
}

function toAiError(error, now) {
  return {
    code: error?.code || 'IMAGE_ANALYSIS_FAILED',
    message: error?.message || '图片分析失败。',
    retryable: error?.retryable === true,
    occurredAt: now,
  };
}

async function analyzeCurrentImageAsset(args, options = {}) {
  const { projectPath, stableId } = args || {};
  const prepareImageInputImpl = options.prepareImageInputImpl || prepareImageInput;
  const resolveModelForTaskImpl = options.resolveModelForTaskImpl || resolveModelForTask;
  const runMlxVlmImpl = options.runMlxVlmImpl || runMlxVlm;
  const getAiAnalysisImpl = options.getAiAnalysisImpl || getAiAnalysis;
  const updateAiAnalysisImpl = options.updateAiAnalysisImpl || updateAiAnalysis;
  const prepared = await prepareImageInputImpl(projectPath, stableId, options);
  const previous = await getAiAnalysisImpl(projectPath, stableId);
  const attempt = (previous?.attempt || 0) + 1;
  const analyzedAt = (options.now || (() => new Date().toISOString()))();
  let modelRoute = null;
  const baseRecord = () => ({
    sourceFingerprint: prepared.asset.fingerprint || '',
    sourceType: 'image',
    aiModel: modelRoute?.modelId || null,
    aiAnalyzedAt: analyzedAt,
    promptVersion: PROMPT_VERSION,
    preprocessVersion: PREPROCESS_VERSION,
    attempt,
  });

  try {
    modelRoute = await resolveModelForTaskImpl(
      'image_asset_analysis',
      options.modelRouterOptions,
    );
    const output = await runMlxVlmImpl(
      prepared.imagePath,
      buildImageAnalysisPrompt(),
      {
        ...options,
        modelPath: modelRoute.snapshotPath,
        moduleName: modelRoute.moduleName,
        pythonPath: options.pythonPath || DEFAULT_MLX_PYTHON_PATH,
      },
    );
    const parsed = validateImageAnalysisResult(parseModelOutput(output));
    const analysis = await updateAiAnalysisImpl(projectPath, stableId, {
      ...baseRecord(),
      ...parsed,
      aiStatus: 'done',
      aiError: null,
    });
    return { analysis };
  } catch (error) {
    if (!modelRoute && error?.model?.taskName === 'image_asset_analysis') {
      modelRoute = error.model;
    }
    await updateAiAnalysisImpl(projectPath, stableId, {
      ...baseRecord(),
      aiStatus: 'failed',
      aiSummary: '',
      aiTags: [],
      aiRisk: { level: 'unknown', flags: [], reason: '' },
      aiCaptionIdeas: [],
      aiSuggestedUse: [],
      aiError: toAiError(error, analyzedAt),
    });
    throw error;
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  IMAGE_EXTENSIONS,
  PREPROCESS_VERSION,
  PROMPT_VERSION,
  analyzeCurrentImageAsset,
  buildImageAnalysisPrompt,
  prepareImageInput,
  runMlxVlm,
  validateImageAnalysisResult,
};
