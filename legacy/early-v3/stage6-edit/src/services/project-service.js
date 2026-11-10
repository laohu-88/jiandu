const fs = require('node:fs/promises');
const path = require('node:path');

const {
  APP_VERSION,
  PROJECT_DIRS,
  PROJECT_FILE,
} = require('../constants');

function validateProjectName(projectName) {
  const name = String(projectName || '').trim();
  if (!name) {
    throw new Error('请输入项目名称。');
  }
  if (name === '.' || name === '..' || /[\/\\:\0]/.test(name)) {
    throw new Error('项目名称不能包含 /、\\、: 等路径字符。');
  }
  return name;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function getMissingDirs(projectPath) {
  const missing = [];
  for (const dir of PROJECT_DIRS) {
    if (!(await pathExists(path.join(projectPath, dir)))) {
      missing.push(dir);
    }
  }
  return missing;
}

async function writeProjectState(projectPath, options = {}) {
  const filePath = path.join(projectPath, PROJECT_FILE);
  const existing = await readJson(filePath);
  const now = new Date().toISOString();
  const state = {
    projectName: options.projectName || existing?.projectName || path.basename(projectPath),
    projectPath,
    version: APP_VERSION,
    createdAt: existing?.createdAt || options.createdAt || now,
    updatedAt: now,
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeJson(filePath, state);
  return state;
}

async function createProject(rootPath, projectName) {
  const cleanRoot = String(rootPath || '').trim();
  if (!cleanRoot) {
    throw new Error('请选择项目根目录。');
  }

  const cleanName = validateProjectName(projectName);
  await fs.mkdir(cleanRoot, { recursive: true });

  const projectPath = path.join(cleanRoot, cleanName);
  await fs.mkdir(projectPath, { recursive: true });
  for (const dir of PROJECT_DIRS) {
    await fs.mkdir(path.join(projectPath, dir), { recursive: true });
  }

  const project = await writeProjectState(projectPath, { projectName: cleanName });
  return {
    project,
    missingDirs: [],
  };
}

async function openProject(projectPath) {
  const cleanPath = path.resolve(String(projectPath || '').trim());
  const stat = await fs.stat(cleanPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error('所选路径不是有效的项目文件夹。');
  }

  const missingDirs = await getMissingDirs(cleanPath);
  let project = await readJson(path.join(cleanPath, PROJECT_FILE));

  if (!project && missingDirs.includes('00-项目总控')) {
    project = {
      projectName: path.basename(cleanPath),
      projectPath: cleanPath,
      version: APP_VERSION,
      createdAt: null,
      updatedAt: null,
    };
  } else {
    project = await writeProjectState(cleanPath, {
      projectName: project?.projectName || path.basename(cleanPath),
    });
  }

  return {
    project,
    missingDirs,
  };
}

async function ensureProjectDirs(projectPath) {
  for (const dir of PROJECT_DIRS) {
    await fs.mkdir(path.join(projectPath, dir), { recursive: true });
  }
  const project = await writeProjectState(projectPath);
  return {
    project,
    missingDirs: [],
  };
}

module.exports = {
  createProject,
  openProject,
  ensureProjectDirs,
  getMissingDirs,
  writeProjectState,
};
