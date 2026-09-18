'use strict';

// 唯一文件输出契约（硬性产品契约）：
// 唯一素材输入 ~/Desktop/视频待处理；唯一用户可见输出
// ~/Desktop/视频素材库/<本期视频名>/ 且根层只有 *.fcpxml；
// 其余一切内部状态位于 Application Support/剪渡。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const cliPath = path.join(ROOT, 'bin', 'jiandu.js');

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function validAnalysis(assetId) {
  return {
    schemaVersion: 1,
    theme: { summary: '主题', rationale: '可见素材', confidence: 0.9, folderNameConflict: false },
    titles: { candidates: ['渡口三期', '第三期剪影'], recommended: '渡口三期', rationale: '与素材一致' },
    assets: [{
      assetId,
      type: 'image',
      semanticLabels: ['壁画'],
      contentSummary: '壁画与街景',
      suggestedUse: ['时间线'],
      status: 'adopt',
      reason: '完整展示',
      cleanup: {
        decision: 'none', overlayTypes: [], rationale: '检查后未发现无关覆盖物。',
        method: 'none', provider: 'none', zones: [],
        inspectedFrames: ['preview.jpg'], reviewRequired: false, warnings: [],
      },
      ranges: [],
      confidence: 0.9,
    }],
    timeline: {
      orientation: 'vertical', width: 1080, height: 1920, fps: 30,
      shots: [{
        id: 'shot-001', assetId, inSec: 0, outSec: 2, durationSec: 2,
        fitMode: 'contain', audioMode: 'keep', purpose: '完整展示',
        confidence: 0.9, reviewRequired: false,
      }],
      markers: [{ timeSec: 1, text: '渡口三期' }],
    },
  };
}

function runCli(homeRoot, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeRoot },
  });
  return result;
}

test('执行 Skill 后：素材库根层只有 FCPXML，无子目录/JSON/MP4/复制媒体，状态全部在 Application Support', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jiandu-contract-'));
  const pendingDir = path.join(tmp, 'Desktop', '视频待处理', '2026-07-20 渡口示例');
  await fs.mkdir(pendingDir, { recursive: true });
  const sourcePng = path.join(pendingDir, 'frame.png');
  await fs.writeFile(sourcePng, Buffer.from(PNG_BASE64, 'base64'));

  // 1. 准备媒体索引（缓存写入 Application Support）
  let r = runCli(tmp, [
    'prepare', '--source', pendingDir, '--json',
  ]);
  assert.equal(r.status, 0, `prepare 失败失败: ${r.stderr || r.stdout}`);
  const prepared = JSON.parse(r.stdout);
  const manifestPath = prepared.manifestPath;
  const assetId = prepared.items[0].assetId;

  // 2. 校验分析协议
  const analysisPath = path.join(tmp, 'analysis.json');
  await fs.writeFile(analysisPath, `${JSON.stringify(validAnalysis(assetId), null, 2)}\n`);
  r = runCli(tmp, [
    'validate-analysis', '--manifest', manifestPath, '--analysis', analysisPath, '--json',
  ]);
  assert.equal(r.status, 0, `validate-analysis 失败: ${r.stderr || r.stdout}`);

  // 3. 正式构建
  const projectName = '本期视频名';
  r = runCli(tmp, [
    'build',
    '--manifest', manifestPath,
    '--analysis', analysisPath,
    '--project-root', path.join(tmp, 'Desktop', '视频素材库'),
    '--project-name', projectName,
    '--json',
  ]);
  assert.equal(r.status, 0, `build 失败: ${r.stderr || r.stdout}`);

  // ---------- 契约断言 ----------
  // (1) 项目目录存在
  const projectDir = path.join(tmp, 'Desktop', '视频素材库', projectName);
  const projStat = await fs.stat(projectDir);
  assert.equal(projStat.isDirectory(), true);

  // 遍历工具
  async function walk(dir) {
    const entries = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) entries.push(...await walk(full));
      else entries.push({ file: full, name: entry.name });
    }
    return entries;
  }
  const files = await walk(projectDir);
  const names = files.map((item) => item.name);

  // (2) 自动生成交付物只有 .fcpxml
  assert.equal(names.length > 0, true, '项目目录为空');
  for (const name of names) {
    assert.match(name, /\.fcpxml$/, `非 FCPXML 文件出现在项目根层: ${name}`);
  }

  // (3) 根层没有剪渡自动创建的子目录
  const dirents = await fs.readdir(projectDir, { withFileTypes: true });
  const subdirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  assert.deepEqual(subdirs, []);

  // (4)(6) 无内部 JSON/MD/cache/preview，也无 MP4
  for (const name of names) {
    assert.doesNotMatch(name, /\.(json|md|txt|log|cache|mp4|mov|webm)$/i, `违禁交付物: ${name}`);
  }

  // (5) 源媒体未被复制/修改/移动
  const sourceStatNow = await fs.stat(sourcePng);
  const pendingFilesNow = await fs.readdir(pendingDir);
  assert.deepEqual(pendingFilesNow.sort(), ['frame.png']);
  assert.equal(sourceStatNow.size, Buffer.from(PNG_BASE64, 'base64').length);

  // (7) 内部状态全部位于 Application Support/剪渡
  const asProject = path.join(tmp, 'Library', 'Application Support', '剪渡', 'projects', projectName);
  const asEntries = await fs.readdir(asProject).catch(() => null);
  assert.ok(Array.isArray(asEntries), 'Application Support/剪渡/projects 缺少项目状态');
  assert.ok(asEntries.includes('视频状态.json'), '缺少内部视频状态.json');

  // verify 只读重跑保持契约
  const fcpxmlFile = names.find((n) => n.endsWith('.fcpxml'));
  r = runCli(tmp, [
    'verify', '--project', path.join(projectDir), '--json',
  ]);
  assert.equal(r.status, 0, `verify 失败: ${r.stderr || r.stdout}`);
  assert.notEqual(fcpxmlFile, undefined);

  await fs.rm(tmp, { recursive: true, force: true });
});
