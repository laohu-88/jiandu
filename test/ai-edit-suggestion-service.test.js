const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  AI_ANALYSIS_FILE,
  AI_EDIT_SUGGESTION_FILE,
  AI_MATERIAL_REPORT_FILE,
  ASSETS_FILE,
} = require('../src/constants');
const {
  MAX_REPORT_CHARS,
  buildEditSuggestionPrompt,
  generateEditSuggestion,
  normalizeSuggestionMarkdown,
  readMaterialReportForSuggestion,
  runEditSuggestionModel,
} = require('../src/services/ai-edit-suggestion-service');

const MODEL = {
  taskName: 'edit_suggestion',
  runtime: 'mlx_lm',
  moduleName: 'mlx_lm',
  snapshotPath: '/mock/qwen-snapshot',
  modelId: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit',
  displayName: 'Qwen3-30B-A3B-Instruct-2507-4bit',
};

function validSuggestion() {
  return `# 剪辑建议

## 1. 总体判断
- 适合做过程记录型视频，重点展示制作过程和最终成果。
- 画面信息足够，不需要额外口播，也不需要露脸。

## 2. 推荐视频结构
### 开头
- 段落目的：快速交代主题。
- 可用素材：成品图.png。
- 建议画面：先展示结果，再进入过程。
- 建议轻字幕：先看看完成效果。
- 注意事项：保持节奏自然。

## 3. 优先使用素材
- 成品图.png：结果明确，适合建立观看预期。

## 4. 不建议使用或谨慎使用素材
- 未分析.mov：需要人工预览视频后再决定。

## 5. 轻字幕建议
- 从这里开始
- 慢慢成形
- 最后一点调整
- 看看完成效果
- 过程比想象中顺利
- 细节补一下
- 接近完成
- 收尾

## 6. 推荐剪辑顺序
1. 成品画面开头。
2. 过程素材自然推进。
3. 结果画面收尾。

## 7. 需要人工再确认
- 未分析.mov：需要人工预览视频。
`;
}

async function makeProject({ report = '# AI素材报告\n\n## 1. 项目概览\n\n- 素材总数：2\n' } = {}) {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-suggestion-'));
  const controlPath = path.join(projectPath, '00-项目总控');
  await fs.mkdir(controlPath, { recursive: true });
  if (report !== null) {
    await fs.writeFile(path.join(projectPath, AI_MATERIAL_REPORT_FILE), report, 'utf8');
  }
  return projectPath;
}

test('ai素材报告.md 不存在时报 MATERIAL_REPORT_NOT_FOUND，且不自动生成', async () => {
  const projectPath = await makeProject({ report: null });
  await assert.rejects(
    () => readMaterialReportForSuggestion(projectPath),
    (error) => error.code === 'MATERIAL_REPORT_NOT_FOUND'
      && error.message === '请先生成素材报告。',
  );
  await assert.rejects(fs.access(path.join(projectPath, AI_MATERIAL_REPORT_FILE)), { code: 'ENOENT' });
});

test('读取素材报告并构建包含全部风格与素材状态约束的 prompt', async () => {
  const projectPath = await makeProject({
    report: '# AI素材报告\n\n## 2. 推荐优先使用素材\n\n| 成品图.png | keep |\n',
  });
  const result = await readMaterialReportForSuggestion(projectPath);
  const prompt = buildEditSuggestionPrompt(result.reportText);

  assert.match(prompt, /成品图\.png/);
  assert.match(prompt, /不口播|尽量少口播/);
  assert.match(prompt, /不露脸/);
  assert.match(prompt, /过程和结果/);
  assert.match(prompt, /少量轻字幕/);
  assert.match(prompt, /不采用固定六段|不要固定六段/);
  assert.match(prompt, /Electron 内的本地模型主线/);
  assert.match(prompt, /Codex 视频 Skill.*正式 v3 项目.*独立素材 FCPXML.*粗剪预览/);
  assert.match(prompt, /历史版本.*旧流程.*过往尝试.*旧版本截图/);
  assert.match(prompt, /不能推荐为当前视频主线/);
  assert.match(prompt, /不用教程腔/);
  assert.match(prompt, /不要强行升华/);
  assert.match(prompt, /创作哲学/);
  assert.match(prompt, /不做强情绪鸡血表达/);
  assert.match(prompt, /不得建议使用人工状态为 reject、淘汰或已淘汰/);
  assert.match(prompt, /未筛选素材不能作为确定推荐，只能标记为“可再人工确认”/);
  assert.match(prompt, /旧版.*分段口播.*配音匹配.*总粗剪.*字幕收口/);
  assert.match(prompt, /一键全自动成片/);
  assert.match(prompt, /不生成视频标题、发布标题、封面标题或发布建议/);
  assert.match(prompt, /2-8 个汉字/);
  assert.match(prompt, /人工预览视频/);
  assert.match(prompt, /遮挡或避开/);
  assert.match(prompt, /只输出 Markdown/);
});

test('超长报告优先保留关键章节，并把读取内容限制在约 80,000 字符', async () => {
  const important = [
    '## 1. 项目概览',
    '## 2. 推荐优先使用素材',
    '## 3. 适合开头的素材',
    '## 4. 适合过程展示的素材',
    '## 5. 适合结果展示的素材',
    '## 6. 风险提示汇总',
    '## 7. 轻字幕建议汇总',
    '## 8. 仍需人工判断',
  ].map((heading) => `${heading}\n\n关键内容\n`).join('\n');
  const report = `# AI素材报告\n\n${important}\n## 9. 完整素材清单\n${'清单内容\n'.repeat(30_000)}`;
  const projectPath = await makeProject({ report });
  const result = await readMaterialReportForSuggestion(projectPath);

  assert.equal(result.truncated, true);
  assert.ok(result.reportText.length <= MAX_REPORT_CHARS);
  for (const title of ['项目概览', '推荐优先使用素材', '适合开头的素材', '风险提示汇总', '轻字幕建议汇总', '仍需人工判断']) {
    assert.match(result.reportText, new RegExp(title));
  }
});

test('模型路径不存在时报 MODEL_NOT_FOUND，且不会调用 runner', async () => {
  const projectPath = await makeProject();
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-suggestion-model-missing-'));
  let runnerCalled = false;
  await assert.rejects(
    () => generateEditSuggestion(projectPath, {
      pythonPath: '/mock/python',
      modelRouterOptions: { homedirImpl: () => emptyHome },
      runEditSuggestionModelImpl: async () => {
        runnerCalled = true;
        return validSuggestion();
      },
    }),
    (error) => error.code === 'MODEL_NOT_FOUND',
  );
  assert.equal(runnerCalled, false);
});

test('Python 不可用时报 PYTHON_NOT_AVAILABLE', async () => {
  const missing = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  await assert.rejects(
    () => runEditSuggestionModel({
      pythonPath: '/missing/python',
      model: MODEL,
      prompt: 'prompt',
      spawnImpl: () => { throw missing; },
    }),
    (error) => error.code === 'PYTHON_NOT_AVAILABLE',
  );
});

test('mlx_lm 不可用时报 MLX_LM_NOT_AVAILABLE', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {};
  const promise = runEditSuggestionModel({
    pythonPath: '/mock/python',
    model: MODEL,
    prompt: 'prompt',
    spawnImpl: () => {
      process.nextTick(() => {
        child.stderr.write("ModuleNotFoundError: No module named 'mlx_lm'");
        child.emit('close', 1);
      });
      return child;
    },
  });
  await assert.rejects(promise, (error) => error.code === 'MLX_LM_NOT_AVAILABLE');
});

test('模型调用使用参数数组和 stdin，不拼 shell 字符串', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {};
  let invocation;
  let stdin = '';
  child.stdin.on('data', (chunk) => { stdin += chunk.toString(); });
  const promise = runEditSuggestionModel({
    pythonPath: '/mock/python',
    model: MODEL,
    prompt: 'PROMPT VIA STDIN',
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      process.nextTick(() => {
        child.stdout.write(validSuggestion());
        child.emit('close', 0);
      });
      return child;
    },
  });
  await promise;
  assert.equal(invocation.command, '/mock/python');
  assert.equal(Array.isArray(invocation.args), true);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.args.includes('PROMPT VIA STDIN'), false);
  assert.equal(stdin, 'PROMPT VIA STDIN');
});

test('mock 模型输出有效 Markdown 时只写剪辑建议，不修改三个来源文件', async () => {
  const report = '# AI素材报告\n\n## 1. 项目概览\n\n- 素材总数：2\n';
  const projectPath = await makeProject({ report });
  const sentinels = {
    [ASSETS_FILE]: '{"assets":[{"stableId":"keep"}]}\n',
    [AI_ANALYSIS_FILE]: '{"analyses":{"keep":{"aiStatus":"done"}}}\n',
  };
  for (const [file, content] of Object.entries(sentinels)) {
    await fs.writeFile(path.join(projectPath, file), content, 'utf8');
  }
  let capturedPrompt = '';
  const result = await generateEditSuggestion(projectPath, {
    pythonPath: '/mock/python',
    now: () => '2026-07-01T12:00:00.000Z',
    resolveModelForTaskImpl: async (taskName) => {
      assert.equal(taskName, 'edit_suggestion');
      return MODEL;
    },
    runEditSuggestionModelImpl: async ({ prompt }) => {
      capturedPrompt = prompt;
      return validSuggestion();
    },
  });

  const output = await fs.readFile(path.join(projectPath, AI_EDIT_SUGGESTION_FILE), 'utf8');
  assert.equal(result.ok, true);
  assert.equal(result.suggestionPath, path.join(projectPath, AI_EDIT_SUGGESTION_FILE));
  assert.equal(result.model, 'Qwen3-30B-A3B-Instruct-2507-4bit');
  assert.equal(result.generatedAt, '2026-07-01T12:00:00.000Z');
  assert.match(output, /^# 剪辑建议/);
  assert.match(output, /生成时间：2026-07-01T12:00:00.000Z/);
  assert.match(output, /使用模型：Qwen3-30B-A3B-Instruct-2507-4bit/);
  assert.match(output, /来源报告：ai素材报告\.md/);
  assert.match(capturedPrompt, /素材总数：2/);
  assert.equal(await fs.readFile(path.join(projectPath, ASSETS_FILE), 'utf8'), sentinels[ASSETS_FILE]);
  assert.equal(await fs.readFile(path.join(projectPath, AI_ANALYSIS_FILE), 'utf8'), sentinels[AI_ANALYSIS_FILE]);
  assert.equal(await fs.readFile(path.join(projectPath, AI_MATERIAL_REPORT_FILE), 'utf8'), report);
});

test('stdout 中的 MLX WARNING、文档链接和性能日志不会写入剪辑建议', async () => {
  const projectPath = await makeProject();
  const mlxOutput = `[WARNING] Generating with a model that requires 16384 MB which is close to the maximum recommended size.
See https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/README.md for documentation.
==========
Files: 4
Prompt: 1024 tokens, 100.0 tokens-per-sec
Prefill: 1024 tokens, 50.0 tokens-per-sec
${validSuggestion()}
Generation: 512 tokens, 20.0 tokens-per-sec
Peak memory: 17.5 GB
========== generation complete ==========`;
  await generateEditSuggestion(projectPath, {
    pythonPath: '/mock/python',
    resolveModelForTaskImpl: async () => MODEL,
    runEditSuggestionModelImpl: async () => mlxOutput,
  });

  const written = await fs.readFile(path.join(projectPath, AI_EDIT_SUGGESTION_FILE), 'utf8');
  assert.match(written, /适合做过程记录型视频/);
  assert.doesNotMatch(written, /\[WARNING\]/);
  assert.doesNotMatch(written, /github\.com\/ml-explore\/mlx-lm/);
  assert.doesNotMatch(written, /^(?:Prefill|Prompt|Generation|Peak memory|Files):/mi);
  assert.doesNotMatch(written, /^={5,}/m);
});

test('多个“# 剪辑建议”时优先保留最后一个结构有效的真正正文', async () => {
  const projectPath = await makeProject();
  const echoedTemplate = validSuggestion().replace(
    '适合做过程记录型视频',
    '这是被回显的错误候选，不应保留',
  );
  const realSuggestion = validSuggestion().replace(
    '适合做过程记录型视频',
    '这是真正正文，应当保留',
  );
  await generateEditSuggestion(projectPath, {
    pythonPath: '/mock/python',
    resolveModelForTaskImpl: async () => MODEL,
    runEditSuggestionModelImpl: async () => `${echoedTemplate}\n${realSuggestion}`,
  });

  const written = await fs.readFile(path.join(projectPath, AI_EDIT_SUGGESTION_FILE), 'utf8');
  assert.match(written, /这是真正正文，应当保留/);
  assert.doesNotMatch(written, /这是被回显的错误候选/);
  assert.equal((written.match(/^# 剪辑建议$/gm) || []).length, 1);
});

test('不含运行日志的正常 Markdown 标题和列表不受清洗影响', () => {
  const normal = validSuggestion().trim();
  assert.equal(normalizeSuggestionMarkdown(normal), normal);
});

test('模型输出为空或明显无效时返回失败且不写空报告', async () => {
  for (const output of ['', '这不是有效的 Markdown 剪辑建议']) {
    const projectPath = await makeProject();
    let writeCalled = false;
    await assert.rejects(
      () => generateEditSuggestion(projectPath, {
        pythonPath: '/mock/python',
        resolveModelForTaskImpl: async () => MODEL,
        runEditSuggestionModelImpl: async () => output,
        writeEditSuggestionImpl: async () => {
          writeCalled = true;
        },
      }),
      (error) => error.code === 'INVALID_MODEL_OUTPUT',
    );
    assert.equal(writeCalled, false);
    await assert.rejects(fs.access(path.join(projectPath, AI_EDIT_SUGGESTION_FILE)), { code: 'ENOENT' });
  }
});
