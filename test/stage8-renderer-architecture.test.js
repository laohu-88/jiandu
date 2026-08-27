'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// 薄壳 renderer 只保留以下运行时文件；其余页面/编辑器已并入 Skill / CLI。
const REQUIRED_FILES = [
  'src/renderer/app.js',
  'src/renderer/index.html',
  'src/renderer/styles/index.css',
  'src/renderer/styles/tokens.css',
  'src/renderer/modules/app-data.js',
  'src/renderer/modules/shell.js',
  'src/renderer/modules/state.js',
  'src/renderer/modules/router.js',
  'src/renderer/modules/ipc-client.js',
  'src/renderer/modules/utils.js',
  'src/renderer/modules/components/dom.js',
  'src/renderer/modules/catalog/library-page.js',
  'src/renderer/modules/pending/pending-page.js',
  'src/renderer/modules/workspace/settings-page.js',
  'src/renderer/modules/workspace/task-pages.js',
  'src/renderer/modules/workspace/workspace-shell.js',
];

// 一旦有人把旧的大模块加回来，此断言立刻失败。
const FORBIDDEN_FILES = [
  'src/renderer/explanation-review-ui.js',
  'src/renderer/modules/douyin/editor-core.js',
  'src/renderer/modules/douyin/douyin-page.js',
  'src/renderer/modules/workspace/edit-workspace.js',
  'src/renderer/modules/workspace/result-playback.js',
  'src/renderer/modules/workspace/overview-page.js',
  'src/renderer/modules/workspace/main-film-page.js',
  'src/renderer/modules/review/review-page.js',
  'src/renderer/modules/assets/assets-page.js',
  'src/renderer/modules/outputs/outputs-page.js',
  'src/view-models/douyin-workflow-view-model.js',
  'src/view-models/issue-center-view-model.js',
];

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('薄壳 renderer 文件齐备且旧模块保持删除', () => {
  for (const rel of REQUIRED_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing ${rel}`);
  }
  for (const rel of FORBIDDEN_FILES) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, `forbidden file returned: ${rel}`);
  }
});

test('app.js is thin bootstrap only', () => {
  const app = read('src/renderer/app.js');
  assert.doesNotMatch(app, /\bfetch\(|XMLHttpRequest|eval\(/);
  assert.match(app, /PlannerShell\.mount/);
});

test('active renderer modules avoid node fs and child_process', () => {
  const offenders = [];
  const scan = (dir) => {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const full = path.join(abs, entry.name);
      if (entry.isDirectory()) scan(path.join(dir, entry.name));
      else if (entry.name.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf8');
        if (/require\(['"](?:node:)?(?:fs|child_process)['"]\)/.test(text)) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    }
  };
  ['src/renderer'].forEach(scan);
  assert.deepEqual(offenders, []);
});

test('index.html wires the thin shell only', () => {
  const html = read('src/renderer/index.html');
  assert.equal((html.match(/<script src=/g) || []).length, 15);
  assert.match(html, /workspace\/task-pages\.js/);
  assert.doesNotMatch(html, /pageDouyin|pageAdvanced|pageAssets|pageReview|explanation-review-ui|editor-core|result-playback|edit-workspace/);
  assert.match(html, /AI → Final Cut Pro/);
});

test('app-data 不再依赖旧编辑器与抖音草稿状态机', () => {
  const data = read('src/renderer/modules/app-data.js');
  assert.doesNotMatch(data, /DouyinEditorCore|ExplanationReviewUi|douyinVariant|draftPlan|issueCenter/i);
});
