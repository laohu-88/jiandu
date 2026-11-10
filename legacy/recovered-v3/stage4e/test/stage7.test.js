const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  checkSubtitleCommand,
  loadRecentProjects,
  saveRecentProject,
  detectEnvironment,
} = require('../src/services/stage7-service');

test('最近项目能保存与读取', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-stage7-recent-'));
  const projectPath = path.join(userData, '项目A');
  await fs.mkdir(projectPath, { recursive: true });

  await saveRecentProject(userData, {
    projectName: '项目A',
    projectPath,
  });
  const loaded = await loadRecentProjects(userData);
  assert.equal(loaded.projects.length, 1);
  assert.equal(loaded.projects[0].projectName, '项目A');
  assert.equal(loaded.projects[0].projectPath, projectPath);
  assert.equal(loaded.projects[0].exists, true);
});

test('最近项目最多保留 10 个，并按最近打开排序', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-stage7-limit-'));
  for (let index = 0; index < 12; index += 1) {
    const projectPath = path.join(userData, `项目${index}`);
    await fs.mkdir(projectPath, { recursive: true });
    await saveRecentProject(userData, {
      projectName: `项目${index}`,
      projectPath,
    });
  }
  const loaded = await loadRecentProjects(userData);
  assert.equal(loaded.projects.length, 10);
  assert.equal(loaded.projects[0].projectName, '项目11');
  assert.equal(loaded.projects.at(-1).projectName, '项目2');
});

test('最近项目路径不存在时不崩溃并标记项目不存在', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-stage7-missing-'));
  const projectPath = path.join(userData, '已删除项目');
  await saveRecentProject(userData, {
    projectName: '已删除项目',
    projectPath,
  });
  const loaded = await loadRecentProjects(userData);
  assert.equal(loaded.projects.length, 1);
  assert.equal(loaded.projects[0].exists, false);
});

test('环境检测函数返回 ffmpeg、ffprobe、字幕命令状态', async () => {
  const result = await detectEnvironment('definitely_missing_subtitle_command_for_test');
  assert.ok(result.checkedAt);
  assert.equal(typeof result.ffmpeg.available, 'boolean');
  assert.equal(typeof result.ffprobe.available, 'boolean');
  assert.equal(result.subtitleCommand.command, 'definitely_missing_subtitle_command_for_test');
  assert.equal(typeof result.subtitleCommand.available, 'boolean');
  assert.ok(result.subtitleCommand.message);
  assert.ok(Array.isArray(result.notes));
});

test('Finder 启动环境从绝对路径与常见目录解析，不启动 login shell', async () => {
  const executable = await checkSubtitleCommand(process.execPath);
  assert.equal(executable.available, true);
  assert.equal(executable.executablePath, process.execPath);
  const source = await fs.readFile(path.join(__dirname, '../src/services/stage7-service.js'), 'utf8');
  assert.doesNotMatch(source, /\/bin\/zsh|-[il]+c|command -v/);
  const stage2 = await fs.readFile(path.join(__dirname, '../src/services/stage2-service.js'), 'utf8');
  assert.doesNotMatch(stage2, /execFileAsync\('ffprobe'/);
  const stage6 = await fs.readFile(path.join(__dirname, '../src/services/stage6-service.js'), 'utf8');
  assert.doesNotMatch(stage6, /\/bin\/zsh|shellQuote|shell:\s*true/);
});
