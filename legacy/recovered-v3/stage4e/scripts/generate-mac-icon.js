#!/usr/bin/env node

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(projectRoot, 'assets', 'app-icon.svg');
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

async function renderBasePng(tempRoot) {
  const output = path.join(tempRoot, 'app-icon.png');
  await run('/usr/bin/qlmanage', ['-t', '-s', '1024', '-o', tempRoot, sourcePath]);
  const qlOutput = `${sourcePath}.png`;
  const generated = path.join(tempRoot, path.basename(qlOutput));
  await fs.rename(generated, output);
  return output;
}

async function generate() {
  if (process.platform !== 'darwin') {
    throw new Error('macOS 图标只能在 macOS 上生成。');
  }
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cut-planner-icon-'));
  try {
    const basePng = await renderBasePng(tempRoot);
    await fs.rm(iconsetPath, { recursive: true, force: true });
    await fs.mkdir(iconsetPath, { recursive: true });
    const entries = [
      [16, 'icon_16x16.png'],
      [32, 'icon_16x16@2x.png'],
      [32, 'icon_32x32.png'],
      [64, 'icon_32x32@2x.png'],
      [128, 'icon_128x128.png'],
      [256, 'icon_128x128@2x.png'],
      [256, 'icon_256x256.png'],
      [512, 'icon_256x256@2x.png'],
      [512, 'icon_512x512.png'],
      [1024, 'icon_512x512@2x.png'],
    ];
    for (const [size, filename] of entries) {
      await run('/usr/bin/sips', [
        '-z', String(size), String(size),
        basePng,
        '--out', path.join(iconsetPath, filename),
      ]);
    }
    await fs.rm(outputPath, { force: true });
    await run('/usr/bin/iconutil', ['-c', 'icns', iconsetPath, '-o', outputPath]);
    process.stdout.write(`已生成 macOS 图标：${outputPath}\n`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  generate().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { generate, iconsetPath, outputPath, sourcePath };
