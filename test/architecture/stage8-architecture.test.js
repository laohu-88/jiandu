'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

const REQUIRED_RENDERER_MODULES = [
  'src/renderer/modules/state.js',
  'src/renderer/modules/router.js',
  'src/renderer/modules/ipc-client.js',
  'src/renderer/modules/utils.js',
  'src/renderer/modules/app-data.js',
  'src/renderer/modules/shell.js',
  'src/renderer/modules/components/dom.js',
  'src/renderer/modules/douyin/editor-core.js',
  'src/renderer/modules/douyin/douyin-page.js',
  'src/renderer/modules/catalog/library-page.js',
  'src/renderer/modules/workspace/workspace-shell.js',
  'src/renderer/modules/review/review-page.js',
  'src/renderer/modules/pending/pending-page.js',
  'src/renderer/modules/workspace/edit-workspace.js',
];

const REQUIRED_VIEW_MODELS = [
  'src/view-models/issue-center-view-model.js',
  'src/view-models/douyin-workflow-view-model.js',
  'src/view-models/workspace-view-model.js',
  'src/view-models/index.js',
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
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(path.relative(ROOT, full));
      }
    }
  }
  return out.sort();
}

function collectRequires(source) {
  const matches = [];
  const pattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match = pattern.exec(source);
  while (match) {
    matches.push(match[1]);
    match = pattern.exec(source);
  }
  return matches;
}

function resolveRequire(fromFile, request) {
  if (!request.startsWith('.')) return null;
  const base = path.resolve(path.dirname(path.join(ROOT, fromFile)), request);
  const candidates = [
    base,
    `${base}.js`,
    path.join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(ROOT, candidate);
    }
  }
  return null;
}

function detectCycles(files) {
  const graph = new Map();
  for (const file of files) {
    const reqs = collectRequires(read(file))
      .map((request) => resolveRequire(file, request))
      .filter(Boolean)
      .filter((target) => files.includes(target));
    graph.set(file, reqs);
  }

  const visiting = new Set();
  const visited = new Set();
  const cycles = [];

  function walk(node, stack) {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      cycles.push([...stack.slice(start), node]);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) || []) walk(next, stack);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }

  for (const file of files) walk(file, []);
  return cycles;
}

test('stage8 module directories exist', () => {
  for (const rel of [...REQUIRED_VIEW_MODELS, ...REQUIRED_RENDERER_MODULES]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing ${rel}`);
  }
});

test('renderer modules do not require node fs or child_process', () => {
  for (const rel of REQUIRED_RENDERER_MODULES) {
    const source = read(rel);
    assert.equal(/require\(['"]fs['"]\)/.test(source), false, rel);
    assert.equal(/require\(['"]node:fs['"]\)/.test(source), false, rel);
    assert.equal(/require\(['"]child_process['"]\)/.test(source), false, rel);
    assert.equal(/require\(['"]node:child_process['"]\)/.test(source), false, rel);
  }
});

test('renderer code does not call validateDouyinPlan or buildFcpxml', () => {
  const rendererFiles = listJsFiles('src/renderer').filter((rel) => !rel.includes(`${path.sep}legacy${path.sep}`));
  for (const rel of rendererFiles) {
    const source = read(rel);
    assert.equal(source.includes('validateDouyinPlan'), false, rel);
    assert.equal(source.includes('buildFcpxml'), false, rel);
  }
});

test('view-models and ipc have no circular requires', () => {
  const files = [
    ...listJsFiles('src/view-models'),
    ...listJsFiles('src/ipc'),
  ];
  const cycles = detectCycles(files);
  assert.deepEqual(cycles, []);
});

test('view-models stay free of platform-variant/fcpxml business services', () => {
  for (const rel of listJsFiles('src/view-models')) {
    const source = read(rel);
    assert.equal(source.includes('platform-variant-service'), false, rel);
    assert.equal(source.includes('fcpxml-service'), false, rel);
    assert.equal(source.includes('editing-contract'), false, rel);
    assert.equal(source.includes('validateDouyinPlan'), false, rel);
    assert.equal(source.includes('buildFcpxml'), false, rel);
  }
});

{
  const appPath = path.join(ROOT, 'src/renderer/app.js');
  const appSource = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : '';
  const lineCount = appSource ? appSource.split(/\r?\n/).length : 0;
  const deferAppConstraints = process.env.STAGE8_WIP === '1';

  test('app.js stays thin after stage8 refactor', { skip: deferAppConstraints }, () => {
    assert.ok(lineCount <= 200, `app.js has ${lineCount} lines`);
    assert.equal(/require\(['"]fs['"]\)/.test(appSource), false);
    assert.equal(/require\(['"]child_process/.test(appSource), false);
    assert.equal(/function renderDouyinVariantEditor/.test(appSource), false);
    assert.equal(/function renderCodexProjectResult/.test(appSource), false);
  });
}

test('agent-first architecture keeps a single bridge and no local AI product surface', () => {
  for (const rel of [
    'src/services/agent-bridge-service.js',
    'src/services/agent-prompt-builder.js',
    'src/services/agent-lifecycle-service.js',
    'src/services/agent-runtime-service.js',
    'src/services/agent-handoff-service.js',
    'src/services/hotingest-adapter.js',
    'src/renderer/modules/workspace/edit-workspace.js',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing ${rel}`);
  }
  for (const rel of [
    'src/services/ai-environment-service.js',
    'src/ipc/ai-ipc.js',
    'src/preload/ai-api.js',
    'src/renderer/asset-view-model.js',
    'src/renderer/modules/workspace/tasks-page.js',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, rel);
  }
  const register = read('src/ipc/register.js');
  assert.doesNotMatch(register, /registerAiIpc|ai-ipc/);
  assert.equal(fs.existsSync(path.join(ROOT, 'src/services/agent-lifecycle-service.js')), true);
  const promptBuilder = read('src/services/agent-prompt-builder.js');
  assert.match(promptBuilder, /buildCompactAgentPrompt/);
  assert.doesNotMatch(promptBuilder, /sharedEditingRulesText/);
});

test('sandboxed preload entry has no relative requires', () => {
  const preload = read('src/preload.js');
  assert.equal(/require\(\s*['"]\.\//.test(preload), false);
  assert.match(preload, /contextBridge\.exposeInMainWorld\(\s*['"]plannerApi['"]/);
  assert.match(preload, /Regenerate with: node scripts\/build-preload\.js/);
  for (const file of [
    'app-api.js',
    'catalog-api.js',
    'platform-variant-api.js',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/preload', file)), file);
  }
});
