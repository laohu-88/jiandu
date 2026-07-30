'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const REQUIRED_FILES = [
  'src/renderer/app.js',
  'src/renderer/index.html',
  'src/renderer/styles/index.css',
  'src/renderer/styles/tokens.css',
  'src/renderer/modules/app-data.js',
  'src/renderer/modules/shell.js',
  'src/renderer/modules/components/dom.js',
  'src/renderer/modules/douyin/editor-core.js',
  'src/renderer/modules/douyin/douyin-page.js',
  'src/renderer/modules/catalog/library-page.js',
  'src/renderer/modules/workspace/workspace-shell.js',
  'src/renderer/modules/workspace/overview-page.js',
  'src/renderer/modules/workspace/main-film-page.js',
  'src/renderer/modules/workspace/settings-page.js',
  'src/renderer/modules/review/review-page.js',
  'src/renderer/modules/assets/assets-page.js',
  'src/renderer/modules/outputs/outputs-page.js',
  'src/renderer/modules/pending/pending-page.js',
];

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function listJsFiles(relDir) {
  const abs = path.join(ROOT, relDir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const stack = [abs];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'legacy') continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(path.relative(ROOT, full));
      }
    }
  }
  return out.sort();
}

test('stage8 renderer architecture files exist', () => {
  for (const rel of REQUIRED_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing ${rel}`);
  }
});

test('app.js is thin bootstrap only', () => {
  const appSource = read('src/renderer/app.js');
  const lineCount = appSource.split(/\r?\n/).length;
  assert.ok(lineCount <= 200, `app.js has ${lineCount} lines`);
  assert.equal(/function renderDouyinVariantEditor/.test(appSource), false);
  assert.equal(/function renderCodexProjectResult/.test(appSource), false);
  assert.equal(/function validateDouyinPlan/.test(appSource), false);
  assert.equal(/require\(['"]fs['"]\)/.test(appSource), false);
  assert.equal(/require\(['"]child_process/.test(appSource), false);
});

test('active renderer modules avoid node fs/child_process and business validators', () => {
  for (const rel of listJsFiles('src/renderer')) {
    if (rel.includes(`${path.sep}legacy${path.sep}`) || rel.endsWith(`${path.sep}legacy/monolith-source.js`)) {
      continue;
    }
    const source = read(rel);
    assert.equal(/require\(['"]fs['"]\)/.test(source), false, rel);
    assert.equal(/require\(['"]node:fs['"]\)/.test(source), false, rel);
    assert.equal(/require\(['"]child_process['"]\)/.test(source), false, rel);
    assert.equal(/require\(['"]node:child_process['"]\)/.test(source), false, rel);
    assert.equal(source.includes('validateDouyinPlan'), false, rel);
    assert.equal(source.includes('buildFcpxml'), false, rel);
  }
});

test('index.html wires stage8 shell and modules', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /id="navSidebar"/);
  assert.match(html, /id="libraryView"/);
  assert.match(html, /id="workspaceView"/);
  assert.match(html, /id="pageDouyin"/);
  assert.match(html, /douyin-stage-rail/);
  assert.match(html, /sticky-action-bar/);
  assert.match(html, /styles\/index\.css/);
  assert.match(html, /modules\/shell\.js/);
  assert.match(html, /modules\/douyin\/douyin-page\.js/);
  assert.match(html, /view-models\/workspace-view-model\.js/);
});

test('douyin action labels remain exact', () => {
  const source = read('src/view-models/douyin-workflow-view-model.js');
  for (const label of [
    '保存方案修改',
    '确认待处理问题',
    '批准当前抖音方案',
    '生成预览与 FCP 时间线',
    '播放预览',
    '查看验证报告',
    '打开输出目录',
    '在 Final Cut Pro 中打开',
  ]) {
    assert.equal(source.includes(label), true, label);
  }
});
