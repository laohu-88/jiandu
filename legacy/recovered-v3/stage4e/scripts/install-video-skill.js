const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const SKILL_NAME = 'video-cut-planner';
const source = path.resolve(__dirname, '..', 'skills', SKILL_NAME);

async function listFiles(directory, root = directory, files = []) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await listFiles(absolutePath, root, files);
    else if (entry.isFile()) files.push(path.relative(root, absolutePath));
  }
  return files.sort();
}

async function treeDigest(directory) {
  const hash = createHash('sha256');
  for (const relativePath of await listFiles(directory)) {
    hash.update(relativePath);
    hash.update(await fs.readFile(path.join(directory, relativePath)));
  }
  return hash.digest('hex');
}

function parseTarget(argv) {
  const targetIndex = argv.indexOf('--target');
  const base = targetIndex >= 0
    ? argv[targetIndex + 1]
    : path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills');
  if (!base) throw new Error('--target 缺少目录。');
  return path.join(path.resolve(base), SKILL_NAME);
}

async function assertCompatibleTarget(target) {
  const skillPath = path.join(target, 'SKILL.md');
  const text = await fs.readFile(skillPath, 'utf8').catch(() => null);
  if (text && !/^name:\s*video-cut-planner\s*$/m.test(text)) {
    throw new Error(`拒绝覆盖非 ${SKILL_NAME} Skill：${target}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const target = parseTarget(argv);
  if (argv.includes('--check')) {
    const [sourceDigest, targetDigest] = await Promise.all([
      treeDigest(source),
      treeDigest(target),
    ]);
    if (sourceDigest !== targetDigest) throw new Error('已安装 Skill 与仓库源文件不一致。');
    process.stdout.write(`Skill 已发现且与源文件一致：${target}\n`);
    return;
  }

  await assertCompatibleTarget(target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = path.join(path.dirname(target), `.${SKILL_NAME}.${process.pid}.installing`);
  const backup = path.join(path.dirname(target), `.${SKILL_NAME}.${process.pid}.backup`);
  await fs.rm(staging, { recursive: true, force: true });
  await fs.cp(source, staging, { recursive: true });
  const targetExists = Boolean(await fs.stat(target).catch(() => null));
  try {
    if (targetExists) await fs.rename(target, backup);
    await fs.rename(staging, target);
    await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (!(await fs.stat(target).catch(() => null)) && await fs.stat(backup).catch(() => null)) {
      await fs.rename(backup, target);
    }
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  process.stdout.write(`Skill 已安装：${target}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseTarget, treeDigest };
