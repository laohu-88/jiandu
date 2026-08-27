#!/usr/bin/env node
// 剪渡 macOS 图标生成：
// - ≥128px 使用 assets/app-icon.svg（全细节：素材卡、渡桥、FC 时间线）
// - ≤64px  使用 assets/app-icon-small.svg（简化主体，保证 Dock 小尺寸清晰）
// 每个尺寸由系统 CoreSVG 矢量渲染到精确像素，而不是放大一张小 PNG。
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, '..');
const fullSvg = path.join(projectRoot, 'assets', 'app-icon.svg');
const smallSvg = path.join(projectRoot, 'assets', 'app-icon-small.svg');
const renderer = path.join(__dirname, 'render-icon.jxa');
const buildRoot = path.join(projectRoot, 'build');
const iconsetPath = path.join(buildRoot, 'app-icon.iconset');
const outputPath = path.join(buildRoot, 'app-icon.icns');

async function run(command, args) {
  try {
    return await execFileAsync(command, args, {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error.stderr || error.message).trim();
    throw new Error(`${path.basename(command)} 失败：${detail}`);
  }
}

async function renderSize(sourceSvg, size, filename) {
  const target = path.join(iconsetPath, filename);
  await run('/usr/bin/osascript', [
    '-l', 'JavaScript', renderer, sourceSvg, target, String(size),
  ]);
}

async function generate() {
  if (process.platform !== 'darwin') {
    throw new Error('macOS 图标只能在 macOS 上生成。');
  }
  await fs.rm(iconsetPath, { recursive: true, force: true });
  await fs.mkdir(iconsetPath, { recursive: true });

  const entries = [
    [16, 'icon_16x16.png', smallSvg],
    [32, 'icon_16x16@2x.png', smallSvg],
    [32, 'icon_32x32.png', smallSvg],
    [64, 'icon_32x32@2x.png', smallSvg],
    [128, 'icon_128x128.png', fullSvg],
    [256, 'icon_128x128@2x.png', fullSvg],
    [256, 'icon_256x256.png', fullSvg],
    [512, 'icon_256x256@2x.png', fullSvg],
    [512, 'icon_512x512.png', fullSvg],
    [1024, 'icon_512x512@2x.png', fullSvg],
  ];
  for (const [size, filename, source] of entries) {
    await renderSize(source, size, filename);
  }

  await fs.rm(outputPath, { force: true });
  await run('/usr/bin/iconutil', ['-c', 'icns', iconsetPath, '-o', outputPath]);
  process.stdout.write(`图标已生成：${outputPath}\n`);
  return outputPath;
}

if (require.main === module) {
  generate().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { generate, outputPath };
