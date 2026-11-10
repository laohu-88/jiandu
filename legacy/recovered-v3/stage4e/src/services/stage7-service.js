const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const RECENT_PROJECTS_FILE = 'recent-projects.json';
const TOOL_SEARCH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

async function resolveToolPath(toolName) {
  const command = String(toolName || '').trim();
  if (!command) return null;

  const candidates = path.isAbsolute(command)
    ? [command]
    : [
      ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean),
      ...TOOL_SEARCH_DIRS,
    ].map((directory) => path.resolve(directory, command));

  for (const candidate of new Set(candidates)) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // 继续尝试下一个 PATH 或常见安装位置。
    }
  }
  return null;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function getRecentProjectsPath(userDataPath) {
  return path.join(userDataPath, RECENT_PROJECTS_FILE);
}

async function projectExists(projectPath) {
  const stat = await fs.stat(projectPath).catch(() => null);
  return Boolean(stat?.isDirectory());
}

async function normalizeRecentProjects(projects = []) {
  const seen = new Set();
  const normalized = [];
  for (const project of projects) {
    if (!project?.projectPath || seen.has(project.projectPath)) continue;
    seen.add(project.projectPath);
    normalized.push({
      projectName: project.projectName || path.basename(project.projectPath),
      projectPath: project.projectPath,
      lastOpenedAt: project.lastOpenedAt || new Date().toISOString(),
      exists: await projectExists(project.projectPath),
    });
  }
  return normalized
    .sort((a, b) => String(b.lastOpenedAt).localeCompare(String(a.lastOpenedAt)))
    .slice(0, 10);
}

async function loadRecentProjects(userDataPath) {
  const payload = await readJson(getRecentProjectsPath(userDataPath), { projects: [] });
  return {
    projects: await normalizeRecentProjects(payload.projects || []),
  };
}

async function saveRecentProject(userDataPath, project) {
  const existing = await loadRecentProjects(userDataPath);
  const withoutCurrent = existing.projects.filter(
    (entry) => entry.projectPath !== project.projectPath,
  );
  const projects = await normalizeRecentProjects([
    {
      projectName: project.projectName || path.basename(project.projectPath),
      projectPath: project.projectPath,
      lastOpenedAt: new Date().toISOString(),
    },
    ...withoutCurrent,
  ]);
  const payload = { projects };
  await writeJson(getRecentProjectsPath(userDataPath), payload);
  return payload;
}

async function checkExecutable(command, args = ['-version']) {
  const commandPath = await resolveToolPath(command);
  if (!commandPath) {
    return {
      available: false,
      message: '不可用',
      detail: `未在 PATH 或常见安装位置找到 ${command}。`,
    };
  }
  try {
    const result = await execFileAsync(commandPath, args, {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return {
      available: true,
      message: '可用',
      detail: String(result.stdout || result.stderr || '').split('\n')[0],
      executablePath: commandPath,
    };
  } catch (error) {
    return {
      available: false,
      message: '不可用',
      detail: error.stderr || error.message,
    };
  }
}

async function checkSubtitleCommand(command = 'ww') {
  const cleanCommand = String(command || '').trim() || 'ww';
  if (!/^[\w./-]+$/.test(cleanCommand)) {
    return {
      available: false,
      message: '可能不可用',
      detail: '字幕命令包含空格或特殊字符。请填写真实命令路径或脚本路径。',
    };
  }
  const commandPath = await resolveToolPath(cleanCommand);
  if (!commandPath) {
    return {
      available: false,
      message: '可能不可用',
      detail: '未找到可执行文件。可以手动生成 raw.srt 后用“整理已有 SRT”。',
    };
  }
  return {
    available: true,
    message: '可用',
    detail: commandPath,
    executablePath: commandPath,
  };
}

async function detectEnvironment(subtitleCommand = 'ww') {
  const [ffmpeg, ffprobe, subtitle] = await Promise.all([
    checkExecutable('ffmpeg'),
    checkExecutable('ffprobe'),
    checkSubtitleCommand(subtitleCommand),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    ffmpeg,
    ffprobe,
    subtitleCommand: {
      command: subtitleCommand || 'ww',
      ...subtitle,
    },
    notes: [
      'ffmpeg / ffprobe 不可用时，粗剪生成和视频信息读取会受影响。',
      '字幕命令不可用时，可以先手动生成 raw.srt，再用“整理已有 SRT”。',
    ],
  };
}

module.exports = {
  RECENT_PROJECTS_FILE,
  getRecentProjectsPath,
  normalizeRecentProjects,
  loadRecentProjects,
  saveRecentProject,
  resolveToolPath,
  detectEnvironment,
  checkSubtitleCommand,
};
