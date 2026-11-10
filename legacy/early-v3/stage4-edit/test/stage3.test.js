const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createProject } = require('../src/services/project-service');
const { importVideoPlan } = require('../src/services/stage2-service');
const {
  getDefaultItem,
  autoFitItems,
  addAssetToSegment,
  saveAssignments,
  syncSegmentPackages,
} = require('../src/services/stage3-service');

async function createStage3Project() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-stage3-'));
  const { project } = await createProject(root, 'Stage3测试');
  await importVideoPlan(project.projectPath, [
    '第1段：开头/钩子',
    '口播文案：这是第一段口播。',
    '素材建议：图片和视频',
  ].join('\n'));

  const image = {
    id: 'A001',
    filename: 'A001-中文图片.png',
    relativePath: path.join('01-精选素材', 'A001-中文图片.png'),
    type: 'image',
    ext: 'png',
    sizeBytes: 5,
    width: 100,
    height: 200,
    aspectRatio: 0.5,
    orientation: 'vertical',
    durationSec: null,
    note: '',
  };
  const video = {
    id: 'A002',
    filename: 'A002-中文视频.mp4',
    relativePath: path.join('01-精选素材', 'A002-中文视频.mp4'),
    type: 'video',
    ext: 'mp4',
    sizeBytes: 5,
    width: 1920,
    height: 1080,
    aspectRatio: 1.7778,
    orientation: 'horizontal',
    durationSec: 8.4,
    note: '',
  };
  await fs.writeFile(path.join(project.projectPath, image.relativePath), 'image');
  await fs.writeFile(path.join(project.projectPath, video.relativePath), 'video');
  await fs.writeFile(
    path.join(project.projectPath, '00-项目总控', 'assets.json'),
    `${JSON.stringify({ assets: [image, video] }, null, 2)}\n`,
  );
  return { project, image, video };
}

test('图片和视频素材使用正确的默认编排值', () => {
  const imageItem = getDefaultItem(
    { id: 'A001', filename: '图.png', relativePath: '图.png', type: 'image' },
    null,
    1,
  );
  assert.equal(imageItem.durationSec, 3);
  assert.equal(imageItem.fitMode, 'push_in');
  assert.equal(imageItem.audioMode, 'none');

  const videoItem = getDefaultItem(
    {
      id: 'A002',
      filename: '视频.mp4',
      relativePath: '视频.mp4',
      type: 'video',
      durationSec: 8.4,
    },
    null,
    1,
  );
  assert.equal(videoItem.durationSec, 5);
  assert.equal(videoItem.fitMode, 'contain');
  assert.equal(videoItem.audioMode, 'none');
});

test('添加素材到分段后保存 segment-assignments.json', async () => {
  const { project } = await createStage3Project();
  const result = await addAssetToSegment(project.projectPath, '01', 'A001');
  assert.equal(result.segments[0].items[0].assetId, 'A001');

  const saved = JSON.parse(
    await fs.readFile(
      path.join(project.projectPath, '00-项目总控', 'segment-assignments.json'),
      'utf8',
    ),
  );
  assert.equal(saved.version, 'v3.0.0-stage4');
  assert.equal(saved.segments[0].items[0].durationSec, 3);
});

test('自动补齐能把素材总时长调整到配音时长', () => {
  const extended = autoFitItems([
    { durationSec: 3, order: 1 },
    { durationSec: 2, order: 2 },
  ], 8.5);
  assert.equal(extended.reduce((sum, item) => sum + item.durationSec, 0), 8.5);

  const shortened = autoFitItems([
    { durationSec: 3, order: 1 },
    { durationSec: 4, order: 2 },
  ], 5.25);
  assert.equal(shortened.reduce((sum, item) => sum + item.durationSec, 0), 5.25);
  assert.ok(shortened.every((item) => item.durationSec >= 0.1));
});

test('audioMode 的四种值都能保存', async () => {
  const { project } = await createStage3Project();
  const modes = ['none', 'keep', 'duck', 'smart_duck'];
  const segments = [{
    segmentId: '01',
    items: modes.map((audioMode, index) => ({
      assetId: 'A002',
      durationSec: 1,
      fitMode: 'contain',
      audioMode,
      order: index + 1,
    })),
  }];
  const result = await saveAssignments(project.projectPath, segments);
  assert.deepEqual(
    result.segments[0].items.map((item) => item.audioMode),
    modes,
  );
});

test('同步分段素材包复制原素材、口播和 segment-plan.json', async () => {
  const { project } = await createStage3Project();
  await addAssetToSegment(project.projectPath, '01', 'A001');
  await addAssetToSegment(project.projectPath, '01', 'A002');

  const result = await syncSegmentPackages(project.projectPath);
  const targetDir = path.join(project.projectPath, '03-分段素材包', '01-开头钩子');
  assert.equal(result.segmentCount, 1);
  assert.equal(result.copiedAssetCount, 2);
  assert.equal(await fs.readFile(path.join(targetDir, 'A001-中文图片.png'), 'utf8'), 'image');
  assert.equal(await fs.readFile(path.join(targetDir, 'A002-中文视频.mp4'), 'utf8'), 'video');
  assert.match(await fs.readFile(path.join(targetDir, '口播.txt'), 'utf8'), /这是第一段口播/);

  const plan = JSON.parse(await fs.readFile(path.join(targetDir, 'segment-plan.json'), 'utf8'));
  assert.equal(plan.segmentId, '01');
  assert.equal(plan.items.length, 2);
});
