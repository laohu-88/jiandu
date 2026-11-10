const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createProject } = require('../src/services/project-service');
const {
  validateSegmentPlan,
  buildRoughcutPlan,
  generateOneSegment,
} = require('../src/services/stage4-service');

function createSilentWav(durationSec = 0.3) {
  const sampleRate = 48000;
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

const baseSegment = {
  id: '01',
  title: '开头钩子',
  voiceFile: '02-配音/01.wav',
  durationSec: 5,
};

const baseItem = {
  assetId: 'A001',
  filename: 'A001-素材.mp4',
  relativePath: '01-精选素材/A001-素材.mp4',
  type: 'video',
  startOffsetSec: 0,
  durationSec: 5,
  fitMode: 'contain',
  audioMode: 'none',
  order: 1,
};

test('缺配音、缺素材、时长未对齐时返回明确错误', () => {
  assert.throws(
    () => validateSegmentPlan({ ...baseSegment, voiceFile: null }, { items: [baseItem] }),
    /缺少配音文件/,
  );
  assert.throws(
    () => validateSegmentPlan(baseSegment, { items: [] }),
    /没有素材编排/,
  );
  assert.throws(
    () => validateSegmentPlan(baseSegment, {
      items: [{ ...baseItem, durationSec: 4.5 }],
    }),
    /未对齐/,
  );
});

test('audioMode 四种模式正确进入生成计划', () => {
  const modes = ['none', 'keep', 'duck', 'smart_duck'];
  const assignment = {
    segmentId: '01',
    items: modes.map((audioMode, index) => ({
      ...baseItem,
      assetId: `A00${index + 1}`,
      durationSec: 1,
      audioMode,
      order: index + 1,
    })),
  };
  const plan = buildRoughcutPlan(
    { ...baseSegment, durationSec: 4 },
    assignment,
    '/tmp/project',
  );
  assert.deepEqual(plan.items.map((item) => item.audioVolume), [0, 0.9, 0.25, 0.25]);
});

test('fitMode 四种模式正确进入生成计划', () => {
  const modes = ['contain', 'cover', 'blur', 'push_in'];
  const assignment = {
    segmentId: '01',
    items: modes.map((fitMode, index) => ({
      ...baseItem,
      assetId: `A00${index + 1}`,
      type: fitMode === 'push_in' ? 'image' : 'video',
      durationSec: 1,
      fitMode,
      order: index + 1,
    })),
  };
  const plan = buildRoughcutPlan(
    { ...baseSegment, durationSec: 4 },
    assignment,
    '/tmp/project',
  );
  assert.deepEqual(plan.items.map((item) => item.fitMode), modes);
  assert.match(plan.items[0].videoFilter, /pad=1920:1080/);
  assert.match(plan.items[1].videoFilter, /crop=1920:1080/);
  assert.match(plan.items[2].videoFilter, /boxblur/);
  assert.match(plan.items[3].videoFilter, /zoompan/);
});

test('成功生成后写入 roughcut-status.json', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-stage4-'));
  const { project } = await createProject(root, '粗剪生成测试');
  const imageRelativePath = path.join('01-精选素材', 'A001-测试画面.ppm');
  const voiceRelativePath = path.join('02-配音', '01.wav');
  await fs.writeFile(
    path.join(project.projectPath, imageRelativePath),
    'P3\n2 2\n255\n255 0 0  0 255 0\n0 0 255  255 255 255\n',
  );
  await fs.writeFile(
    path.join(project.projectPath, voiceRelativePath),
    createSilentWav(0.3),
  );
  await fs.writeFile(
    path.join(project.projectPath, '00-项目总控', 'segments.json'),
    `${JSON.stringify({
      segments: [{
        id: '01',
        title: '测试/粗剪',
        voiceFile: voiceRelativePath,
        durationSec: 0.3,
      }],
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(project.projectPath, '00-项目总控', 'segment-assignments.json'),
    `${JSON.stringify({
      segments: [{
        segmentId: '01',
        items: [{
          assetId: 'A001',
          filename: 'A001-测试画面.ppm',
          relativePath: imageRelativePath,
          type: 'image',
          startOffsetSec: 0,
          durationSec: 0.3,
          fitMode: 'contain',
          audioMode: 'none',
          order: 1,
        }],
      }],
    }, null, 2)}\n`,
  );

  const result = await generateOneSegment(project.projectPath, '01');
  assert.equal(result.entry.status, 'success');
  assert.equal(result.entry.outputFile, path.join('04-分段粗剪', '01-测试粗剪.mp4'));
  assert.ok(await fs.stat(path.join(project.projectPath, result.entry.outputFile)));

  const status = JSON.parse(
    await fs.readFile(
      path.join(project.projectPath, '00-项目总控', 'roughcut-status.json'),
      'utf8',
    ),
  );
  assert.equal(status.version, 'v3.0.0-stage4');
  assert.equal(status.segments[0].status, 'success');
});
