const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.resolve(__dirname, '..', 'bin', 'video-skill.js');

test('CLI help 列出准备、校验、构建和验证入口', () => {
  for (const argument of ['help', '--help', '-h']) {
    const result = spawnSync(process.execPath, [cliPath, argument], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /prepare/);
    assert.match(result.stdout, /validate-analysis/);
    assert.match(result.stdout, /build/);
    assert.match(result.stdout, /verify/);
  }
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
