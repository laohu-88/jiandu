'use strict';

// 薄壳架构守卫：主进程只保留六个 IPC 域，旧状态机与编辑器链路不得回流。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function listJsFiles(relDir) {
  const abs = path.join(ROOT, relDir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.relative(ROOT, full));
    }
  }
  return out.sort();
}

test('ipc 注册面收敛为六个域', () => {
  const register = read('src/ipc/register.js');
  assert.match(register, /registerAppIpc/);
  assert.match(register, /registerPendingIpc/);
  assert.match(register, /registerHandoffIpc/);
  assert.match(register, /registerDialogIpc/);
  assert.match(register, /registerCatalogIpc/);
  assert.match(register, /registerShellIpc/);
  assert.doesNotMatch(register, /registerStageIpc|registerEditIpc|registerProjectIpc|registerAssetsIpc|registerPlatformVariantIpc|registerAiIpc/);
});

test('旧状态机 / 编辑器 / 变体 IPC 保持删除', () => {
  for (const rel of [
    'src/services/stage2-service.js',
    'src/services/stage3-service.js',
    'src/services/stage4-service.js',
    'src/services/stage5-service.js',
    'src/services/stage6-service.js',
    'src/services/stage7-service.js',
    'src/services/in-app-edit-workflow-service.js',
    'src/services/backup-service.js',
    'src/services/timeline-engine.js',
    'src/services/caption-fcpxml-export-service.js',
    'src/ipc/stage-ipc.js',
    'src/ipc/edit-ipc.js',
    'src/ipc/project-ipc.js',
    'src/ipc/assets-ipc.js',
    'src/ipc/platform-variant-ipc.js',
    'src/preload/stage-api.js',
    'src/preload/edit-api.js',
    'src/preload/project-api.js',
    'src/preload/assets-api.js',
    'src/preload/platform-variant-api.js',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, `forbidden file returned: ${rel}`);
  }
});

test('renderer modules do not require node fs or child_process', () => {
  for (const rel of listJsFiles('src/renderer')) {
    const source = read(rel);
    for (const banned of ['fs', 'node:fs', 'child_process', 'node:child_process']) {
      assert.equal(source.includes(`require('${banned}')`), false, `${rel} -> ${banned}`);
    }
  }
});

test('view-models and ipc have no circular requires', () => {
  const graph = new Map();
  for (const rel of [...listJsFiles('src/view-models'), ...listJsFiles('src/ipc')]) {
    const abs = path.join(ROOT, rel);
    const deps = [];
    for (const m of String(read(rel)).matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      const resolved = path.relative(ROOT, path.resolve(path.dirname(abs), m[1]));
      const withExt = fs.existsSync(resolved) ? resolved : `${resolved}.js`;
      if (withExt.endsWith('.js')) deps.push(withExt);
    }
    graph.set(rel, deps);
  }
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];
  const walk = (node, stack) => {
    if (visiting.has(node)) {
      cycles.push([...stack.slice(stack.indexOf(node)), node]);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) || []) walk(next, stack);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) walk(node, []);
  assert.deepEqual(cycles, []);
});

test('agent-first architecture keeps a single bridge and no local AI product surface', () => {
  for (const rel of [
    'src/services/agent-bridge-service.js',
    'src/services/agent-prompt-builder.js',
    'src/services/agent-lifecycle-service.js',
    'src/services/agent-runtime-service.js',
    'src/services/agent-handoff-service.js',
    'src/services/hotingest-adapter.js',
    'src/renderer/modules/workspace/task-pages.js',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing ${rel}`);
  }
  for (const rel of [
    'src/services/ai-environment-service.js',
    'src/ipc/ai-ipc.js',
    'src/preload/ai-api.js',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, rel);
  }
  const promptBuilder = read('src/services/agent-prompt-builder.js');
  assert.match(promptBuilder, /buildCompactAgentPrompt/);
});

test('sandboxed preload entry has exactly six domains and no relative requires', () => {
  const preload = read('src/preload.js');
  assert.equal(/require\(\s*['"]\.\//.test(preload), false);
  assert.match(preload, /contextBridge\.exposeInMainWorld\(\s*['"]plannerApi['"]/);
  assert.match(preload, /Regenerate with: node scripts\/build-preload\.js/);
  assert.equal((preload.match(/--- .*? ---/g) || []).length, 6);
  const order = read('scripts/build-preload.js');
  for (const file of listJsFiles('src/preload').map((rel) => path.basename(rel))) {
    assert.ok(order.includes(`'${file}'`), `build-preload order missing ${file}`);
  }
});
