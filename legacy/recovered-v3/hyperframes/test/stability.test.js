const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createProject } = require('../src/services/project-service');
const { backupCoreProjectJson } = require('../src/services/backup-service');
const {
  validateSegmentForRender,
  generateOneSegment,
} = require('../src/services/stage4-service');
const { generateFinalRoughcut } = require('../src/services/stage5-service');

function createSilentWav(durationSec = 0.3) {
  const sampleRate = 48000;
  const sampleCount = Math.round(sampleRate * durationSec);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function makeProject(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-stability-'));
  const { project } = await createProject(root, name);
  for (const legacyDir of ['02-配音', '04-分段粗剪', '05-总粗剪']) {
    await fs.mkdir(path.join(project.projectPath, legacyDir), { recursive: true });
  }
  return project;
}

async function writeJson(projectPath, relativePath, value) {
  await fs.writeFile(
    path.join(projectPath, relativePath),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
}

async function prepareRenderProject({
  name,
  voiceFiles = [],
  voiceDurations = [],
  voiceoverText = '测试口播。',
  voiceContent = null,
  assetContent = 'P3\n2 2\n255\n255 0 0  0 255 0\n0 0 255  255 255 255\n',
  visualDuration = null,
}) {
  const project = await makeProject(name);
  for (const voiceFile of voiceFiles) {
    await fs.writeFile(
      path.join(project.projectPath, voiceFile),
      voiceContent ?? createSilentWav(0.3),
    );
  }
  const assetRelativePath = '01-精选素材/A001.ppm';
  await fs.writeFile(path.join(project.projectPath, assetRelativePath), assetContent);
  const clips = voiceFiles.map((file, index) => ({
    file,
    durationSec: voiceDurations[index],
  }));
  const targetDuration = visualDuration
    ?? voiceDurations.reduce((sum, duration) => sum + duration, 0);
  await writeJson(project.projectPath, '00-项目总控/segments.json', {
    segments: [{
      id: '01',
      index: 1,
      title: '稳定性测试',
      voiceoverText,
      voiceFiles,
      voiceTrack: clips.length ? { type: 'audio', clips } : null,
    }],
  });
  await writeJson(project.projectPath, '00-项目总控/segment-assignments.json', {
    segments: [{
      segmentId: '01',
      items: [{
        assetId: 'A001',
        filename: 'A001.ppm',
        relativePath: assetRelativePath,
        type: 'image',
        startOffsetSec: 0,
        durationSec: targetDuration,
        fitMode: 'contain',
        audioMode: 'none',
        order: 1,
      }],
    }],
  });
  return project;
}

test('validateSegmentForRender 缺配音时返回中文错误', async () => {
  const project = await prepareRenderProject({
    name: '缺配音预检',
    visualDuration: 1,
  });
  const report = await validateSegmentForRender(project.projectPath, '01');
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((message) => /缺少配音文件/.test(message)));
});

test('validateSegmentForRender 支持 01-1.mp3 和 01-2.mp3', async () => {
  const project = await prepareRenderProject({
    name: '多配音预检',
    voiceFiles: ['02-配音/01-1.mp3', '02-配音/01-2.mp3'],
    voiceDurations: [0.3, 0.3],
  });
  const report = await validateSegmentForRender(project.projectPath, '01');
  assert.deepEqual(report, { ok: true, errors: [], warnings: [] });
});

test('validateSegmentForRender 拒绝非法 pause duration', async () => {
  const project = await prepareRenderProject({
    name: '非法停顿预检',
    voiceFiles: ['02-配音/01.wav'],
    voiceDurations: [0.3],
    voiceoverText: '前半句[pause:0]后半句',
  });
  const report = await validateSegmentForRender(project.projectPath, '01');
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((message) => /停顿指令不合法/.test(message)));
});

test('分段粗剪生成失败时保留旧文件和 outputFile', { timeout: 30000 }, async () => {
  const project = await prepareRenderProject({
    name: '分段旧文件保护',
    voiceFiles: ['02-配音/01.wav'],
    voiceDurations: [0.3],
    voiceContent: '这不是有效音频',
  });
  const oldRelativePath = '04-分段粗剪/01-稳定性测试.mp4';
  const oldPath = path.join(project.projectPath, oldRelativePath);
  await fs.writeFile(oldPath, 'OLD ROUGHCUT');
  await writeJson(project.projectPath, '00-项目总控/roughcut-status.json', {
    segments: [{
      segmentId: '01',
      status: 'success',
      outputFile: oldRelativePath,
      durationSec: 0.3,
      generatedAt: '2026-06-27T00:00:00.000Z',
    }],
  });

  await assert.rejects(
    () => generateOneSegment(project.projectPath, '01'),
    /已保留旧粗剪文件/,
  );
  assert.equal(await fs.readFile(oldPath, 'utf8'), 'OLD ROUGHCUT');
  const status = JSON.parse(
    await fs.readFile(path.join(project.projectPath, '00-项目总控/roughcut-status.json'), 'utf8'),
  );
  assert.equal(status.segments[0].status, 'failed');
  assert.equal(status.segments[0].outputFile, oldRelativePath);
  assert.equal(status.segments[0].oldFilePreserved, true);
  const log = await fs.readFile(
    path.join(project.projectPath, '00-项目总控/roughcut-errors.log'),
    'utf8',
  );
  assert.match(log, /timeline\.duration：0\.3/);
  assert.match(log, /voiceFiles：\["02-配音\/01\.wav"\]/);
  assert.match(log, /pause 节点：\[\]/);
  assert.match(log, /素材列表：/);
  assert.match(log, /ffmpeg stderr 摘要：/);
  assert.match(log, /临时目录：.*\.tmp-roughcut/);
});

test('总粗剪生成失败时保留旧 full-roughcut.mp4', { timeout: 30000 }, async () => {
  const project = await makeProject('总粗剪旧文件保护');
  await writeJson(project.projectPath, '00-项目总控/segments.json', {
    segments: [{ id: '01', index: 1, title: '第一段', voiceoverText: '' }],
  });
  await writeJson(project.projectPath, '00-项目总控/segment-assignments.json', {
    segments: [{ segmentId: '01', items: [] }],
  });
  const roughcutRelativePath = '04-分段粗剪/01-第一段.mp4';
  await fs.writeFile(path.join(project.projectPath, roughcutRelativePath), 'INVALID VIDEO');
  await writeJson(project.projectPath, '00-项目总控/roughcut-status.json', {
    segments: [{
      segmentId: '01',
      status: 'success',
      outputFile: roughcutRelativePath,
    }],
  });
  const finalPath = path.join(project.projectPath, '05-总粗剪/full-roughcut.mp4');
  await fs.writeFile(finalPath, 'OLD FINAL ROUGHCUT');
  await writeJson(project.projectPath, '00-项目总控/final-roughcut-status.json', {
    status: 'success',
    outputFile: '05-总粗剪/full-roughcut.mp4',
    durationSec: 3,
  });

  await assert.rejects(
    () => generateFinalRoughcut(project.projectPath),
    /已保留旧总粗剪文件/,
  );
  assert.equal(await fs.readFile(finalPath, 'utf8'), 'OLD FINAL ROUGHCUT');
  const status = JSON.parse(
    await fs.readFile(
      path.join(project.projectPath, '00-项目总控/final-roughcut-status.json'),
      'utf8',
    ),
  );
  assert.equal(status.status, 'failed');
  assert.equal(status.outputFile, '05-总粗剪/full-roughcut.mp4');
  assert.equal(status.oldFilePreserved, true);
});

test('备份函数复制核心 json 到 backups', async () => {
  const project = await makeProject('核心数据备份');
  await writeJson(project.projectPath, '00-项目总控/assets.json', { assets: [] });
  await writeJson(project.projectPath, '00-项目总控/segments.json', { segments: [] });
  await writeJson(project.projectPath, '00-项目总控/roughcut-status.json', { segments: [] });

  const result = await backupCoreProjectJson(
    project.projectPath,
    new Date(2026, 5, 27, 21, 30, 0),
  );
  const names = (await fs.readdir(path.join(project.projectPath, result.backupDir))).sort();
  assert.ok(names.includes('2026-06-27-213000-project.json'));
  assert.ok(names.includes('2026-06-27-213000-assets.json'));
  assert.ok(names.includes('2026-06-27-213000-segments.json'));
  assert.ok(names.includes('2026-06-27-213000-roughcut-status.json'));
});
