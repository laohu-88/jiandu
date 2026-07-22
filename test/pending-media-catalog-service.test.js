const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  scanPendingMediaCatalog,
} = require('../src/services/pending-media-catalog-service');
const {
  CODEX_VIDEO_MANIFEST_FILE,
  CODEX_VIDEO_STATUS_FILE,
} = require('../src/constants');

async function tempRoot() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pending-catalog-')));
}

test('根目录不存在、空根目录和一期空目录返回明确状态', async () => {
  const temp = await tempRoot();
  const missing = await scanPendingMediaCatalog({
    rootPath: path.join(temp, 'missing'),
    projectRoot: path.join(temp, 'projects'),
  });
  assert.equal(missing.exists, false);
  const root = path.join(temp, '视频待处理');
  await fs.mkdir(root);
  assert.equal((await scanPendingMediaCatalog({ rootPath: root })).episodes.length, 0);
  await fs.mkdir(path.join(root, '空一期'));
  const payload = await scanPendingMediaCatalog({ rootPath: root });
  assert.equal(payload.episodes[0].empty, true);
  assert.equal(payload.episodes[0].status, 'empty');
});

test('只把直属目录识别为一期并统计图片、视频、音频、支持、不支持文件、时长和大小', async () => {
  const temp = await tempRoot();
  const root = path.join(temp, '视频待处理');
  const issue = path.join(root, '真实一期');
  const nested = path.join(issue, '内部目录');
  await fs.mkdir(nested, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(issue, '图.png'), 'image'),
    fs.writeFile(path.join(issue, '录屏.mp4'), 'video'),
    fs.writeFile(path.join(issue, '声音.wav'), 'audio'),
    fs.writeFile(path.join(issue, '重点.txt'), 'text'),
    fs.writeFile(path.join(issue, '未知.xyz'), 'unsupported'),
    fs.writeFile(path.join(nested, '内部图.jpg'), 'nested'),
  ]);
  const payload = await scanPendingMediaCatalog({
    rootPath: root,
    projectRoot: path.join(temp, 'projects'),
    probeMediaSafeImpl: async () => ({ ok: true, metadata: { durationSec: 12.5 } }),
  });
  assert.equal(payload.episodes.length, 1);
  const episode = payload.episodes[0];
  assert.deepEqual(episode.counts, { image: 2, video: 1, audio: 1, support: 1, unsupported: 1 });
  assert.equal(episode.totalFileCount, 6);
  assert.equal(episode.totalVideoDurationSec, 12.5);
  assert.equal(episode.hasUnsupported, true);
  assert.equal(episode.status, 'warning');
  assert.ok(episode.totalSizeBytes > 0);
});

test('已有正式结果按 sourceDirectory/digest 匹配，同名不同来源不误判', async () => {
  const temp = await tempRoot();
  const root = path.join(temp, '视频待处理');
  const projectRoot = path.join(temp, '视频素材库');
  const issue = path.join(root, '同名一期');
  const other = path.join(temp, '其他来源', '同名一期');
  const project = path.join(projectRoot, '正式项目');
  await Promise.all([
    fs.mkdir(issue, { recursive: true }),
    fs.mkdir(other, { recursive: true }),
    fs.mkdir(path.dirname(path.join(project, CODEX_VIDEO_MANIFEST_FILE)), { recursive: true }),
  ]);
  await fs.writeFile(path.join(issue, 'a.txt'), 'a');
  await fs.writeFile(path.join(other, 'a.txt'), 'different');
  await fs.writeFile(path.join(project, CODEX_VIDEO_MANIFEST_FILE), JSON.stringify({
    sourceDirectory: other,
    sourceSnapshot: { digest: 'different-digest' },
  }));
  await fs.writeFile(path.join(project, CODEX_VIDEO_STATUS_FILE), JSON.stringify({ status: 'verified' }));
  let payload = await scanPendingMediaCatalog({ rootPath: root, projectRoot });
  assert.equal(payload.episodes[0].existingProject, null);
  const manifest = JSON.parse(await fs.readFile(path.join(project, CODEX_VIDEO_MANIFEST_FILE)));
  manifest.sourceDirectory = issue;
  await fs.writeFile(path.join(project, CODEX_VIDEO_MANIFEST_FILE), JSON.stringify(manifest));
  payload = await scanPendingMediaCatalog({ rootPath: root, projectRoot });
  assert.equal(payload.episodes[0].existingProject.projectPath, project);
});

test('任务状态只在真实任务进入运行阶段后显示正在处理', async () => {
  const temp = await tempRoot();
  const root = path.join(temp, '视频待处理');
  const issue = path.join(root, '一期');
  await fs.mkdir(issue, { recursive: true });
  await fs.writeFile(path.join(issue, 'a.txt'), 'a');
  const real = await fs.realpath(issue);
  let payload = await scanPendingMediaCatalog({
    rootPath: root,
    tasks: [{ sourceDirectoryRealPath: real, status: 'awaiting_user_send' }],
  });
  assert.equal(payload.episodes[0].status, 'awaiting_user_send');
  payload = await scanPendingMediaCatalog({
    rootPath: root,
    tasks: [{ sourceDirectoryRealPath: real, status: 'analyzing_media' }],
  });
  assert.equal(payload.episodes[0].status, 'processing');
});

test('越界符号链接不作为合法一期，单项错误不阻断其他目录', async () => {
  const temp = await tempRoot();
  const root = path.join(temp, '视频待处理');
  const valid = path.join(root, '正常一期');
  const outside = path.join(temp, '外部');
  await fs.mkdir(valid, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(valid, 'a.txt'), 'a');
  await fs.symlink(outside, path.join(root, '越界链接'));
  const payload = await scanPendingMediaCatalog({ rootPath: root });
  assert.equal(payload.episodes.length, 1);
  assert.equal(payload.episodes[0].name, '正常一期');
});
