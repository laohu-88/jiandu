#!/usr/bin/env node
'use strict';

/**
 * Inline src/preload/*-api.js into src/preload.js for Electron sandbox compatibility.
 * Sandboxed preload scripts cannot require relative project modules.
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'src', 'preload');
const order = [
  'app-api.js',
  'pending-api.js',
  'handoff-api.js',
  'dialog-api.js',
  'catalog-api.js',
  'shell-api.js',
];

function extractObjectLiteral(src, file) {
  const idx = src.indexOf('=>');
  if (idx < 0) throw new Error(`${file}: missing =>`);
  const start = src.indexOf('{', idx);
  if (start < 0) throw new Error(`${file}: missing object start`);
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${file}: unbalanced braces`);
}

function build() {
  const chunks = order.map((file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const objectLiteral = extractObjectLiteral(src, file);
    return `  // --- ${file} ---\n  ...(${objectLiteral}),`;
  });
  const out = `const { contextBridge, ipcRenderer } = require('electron');

// Domain-organized preload API, inlined for Electron sandbox compatibility.
// Source modules: src/preload/*-api.js (kept for review / non-sandbox tooling).
// Regenerate with: node scripts/build-preload.js
const api = {
${chunks.join('\n')}
};

contextBridge.exposeInMainWorld('plannerApi', api);
`;
  const target = path.join(root, 'src', 'preload.js');
  fs.writeFileSync(target, out);
  return { target, lines: out.split('\n').length, domains: order.length };
}

if (require.main === module) {
  const result = build();
  process.stdout.write(`preload.js rebuilt: ${result.domains} domains, ${result.lines} lines → ${result.target}\n`);
}

module.exports = { build };
