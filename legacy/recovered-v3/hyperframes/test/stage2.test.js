const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createProject } = require('../src/services/project-service');
const {
  parseVideoPlan,
  getVoiceSegmentIndex,
  importVideoPlan,
  scanVoiceFiles,
} = require('../src/services/stage2-service');

function createSilentWav(durationSec = 0.1) {
  const sampleRate = 8000;
  const channels = 1;
  const bitsPerSample = 16;
  const sampleCount = Math.round(sampleRate * durationSec);
  const dataSize = sampleCount * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

test('解析“第1段：xxx”并提取口播和素材字段', () => {
  const result = parseVideoPlan([
    '第1段：开头钩子',
    '口播文案：你是不是也遇到过这个问题？',
    '素材建议：A001 截图',
  ].join('\n'));

  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].id, '01');
  assert.equal(result.segments[0].title, '开头钩子');
  assert.equal(result.segments[0].voiceoverText, '你是不是也遇到过这个问题？');
  assert.equal(result.segments[0].suggestedAssetsText, 'A001 截图');
});

test('解析“01｜xxx”格式', () => {
  const result = parseVideoPlan([
    '01｜问题出现',
    '旁白：事情要从这里说起。',
  ].join('\n'));

  assert.equal(result.segments[0].index, 1);
  assert.equal(result.segments[0].title, '问题出现');
  assert.equal(result.segments[0].voiceoverText, '事情要从这里说起。');
});

test('方案可以成功解析 6 段', () => {
  const plan = Array.from({ length: 6 }, (_, index) => [
    `## 第 ${index + 1} 段 标题${index + 1}`,
    `文案：这是第 ${index + 1} 段口播。`,
    `画面素材：A${String(index + 1).padStart(3, '0')}`,
  ].join('\n')).join('\n\n');

  const result = parseVideoPlan(plan);
  assert.equal(result.segments.length, 6);
  assert.deepEqual(result.segments.map((segment) => segment.id), ['01', '02', '03', '04', '05', '06']);
});

test('无法解析分段时返回明确错误', () => {
  assert.throws(
    () => parseVideoPlan('这是一份没有任何分段标题的视频方案。'),
    /未识别到分段标题/,
  );
});

test('配音数字前缀识别', () => {
  assert.equal(getVoiceSegmentIndex('01.wav'), 1);
  assert.equal(getVoiceSegmentIndex('01-开头.wav'), 1);
  assert.equal(getVoiceSegmentIndex('1.mp3'), 1);
  assert.equal(getVoiceSegmentIndex('02-问题出现.m4a'), 2);
  assert.equal(getVoiceSegmentIndex('无编号.aac'), null);
});

test('扫描配音时 01.wav 匹配第 1 段并写入 segments.json', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-stage2-'));
  const { project } = await createProject(root, '配音匹配测试');
  await importVideoPlan(project.projectPath, [
    '第1段：开头',
    '口播：测试口播。',
  ].join('\n'));
  await fs.mkdir(path.join(project.projectPath, '02-配音'), { recursive: true });
  await fs.writeFile(
    path.join(project.projectPath, '02-配音', '01.wav'),
    createSilentWav(),
  );

  const result = await scanVoiceFiles(project.projectPath);
  const segment = result.segments[0];
  assert.equal(segment.voiceFile, path.join('02-配音', '01.wav'));
  assert.equal(segment.voiceStatus, 'matched');
  assert.equal(segment.durationSec, 0.1);

  const saved = JSON.parse(
    await fs.readFile(path.join(project.projectPath, '00-项目总控', 'segments.json'), 'utf8'),
  );
  assert.equal(saved.segments[0].voiceFile, path.join('02-配音', '01.wav'));
});
