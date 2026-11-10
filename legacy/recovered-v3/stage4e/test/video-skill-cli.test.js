const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.resolve(__dirname, '..', 'bin', 'video-skill.js');
const {
  formatOptions,
  hyperframesOptions,
  parseArguments,
} = require('../bin/video-skill');

test('CLI help 列出准备、校验、构建和验证入口', () => {
  for (const argument of ['help', '--help', '-h']) {
    const result = spawnSync(process.execPath, [cliPath, argument], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /prepare/);
    assert.match(result.stdout, /validate-analysis/);
    assert.match(result.stdout, /build/);
    assert.match(result.stdout, /verify/);
    assert.match(result.stdout, /--orientation/);
    assert.match(result.stdout, /--preview-width/);
    assert.match(result.stdout, /hyperframes-doctor/);
    assert.match(result.stdout, /--hyperframes/);
  }
});

test('CLI 将 HyperFrames 保持为显式启用的可选适配', () => {
  const parsed = parseArguments([
    'build', '--hyperframes', '--hyperframes-duration', '1.5',
    '--hyperframes-quality', 'draft', '--hyperframes-executable', '/tmp/hyperframes',
    '--hyperframes-flow', '/tmp/flow.json',
  ]);
  assert.deepEqual(hyperframesOptions(parsed.options), {
    enabled: true,
    executablePath: '/tmp/hyperframes',
    browserPath: undefined,
    durationSec: '1.5',
    quality: 'draft',
    flowSpecPath: '/tmp/flow.json',
  });
  assert.equal(hyperframesOptions({}).enabled, false);
  assert.equal(
    hyperframesOptions({ 'reuse-hyperframes-project': '/tmp/reviewed-project' }).reuseProjectPath,
    '/tmp/reviewed-project',
  );
});

test('CLI 接受可选的正式时间线和独立预览格式', () => {
  const parsed = parseArguments([
    'build', '--orientation', 'vertical', '--width', '1080', '--height', '1920',
    '--fps', '30', '--preview-width', '640', '--preview-height', '360',
  ]);
  assert.deepEqual(formatOptions(parsed.options), {
    timeline: { orientation: 'vertical', width: '1080', height: '1920', fps: '30' },
    preview: { width: '640', height: '360', fps: undefined },
  });
});

test('CLI 非法命令返回结构化错误和退出码 2', () => {
  const result = spawnSync(process.execPath, [cliPath, 'not-a-command', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'INVALID_COMMAND');
});

test('CLI 缺少必填参数返回结构化错误和退出码 2', () => {
  const result = spawnSync(process.execPath, [cliPath, 'prepare', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.error.code, 'MISSING_ARGUMENT');
});
