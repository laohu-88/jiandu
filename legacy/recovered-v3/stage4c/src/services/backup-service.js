const fs = require('node:fs/promises');
const path = require('node:path');

const {
  BACKUPS_DIR,
  PROJECT_FILE,
  ASSETS_FILE,
  SEGMENTS_FILE,
  ASSIGNMENTS_FILE,
  ROUGHCUT_STATUS_FILE,
  FINAL_ROUGHCUT_STATUS_FILE,
  SUBTITLE_STATUS_FILE,
} = require('../constants');

const CORE_JSON_FILES = [
  PROJECT_FILE,
  ASSETS_FILE,
  SEGMENTS_FILE,
  ASSIGNMENTS_FILE,
  ROUGHCUT_STATUS_FILE,
  FINAL_ROUGHCUT_STATUS_FILE,
  SUBTITLE_STATUS_FILE,
];

function formatBackupTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function pathIsFile(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile());
}

async function backupCoreProjectJson(projectPath, date = new Date()) {
  const backupDir = path.join(projectPath, BACKUPS_DIR);
  const timestamp = formatBackupTimestamp(date);
  await fs.mkdir(backupDir, { recursive: true });

  const files = [];
  for (const relativePath of CORE_JSON_FILES) {
    const sourcePath = path.join(projectPath, relativePath);
    if (!(await pathIsFile(sourcePath))) continue;
    const backupName = `${timestamp}-${path.basename(relativePath)}`;
    const backupPath = path.join(backupDir, backupName);
    await fs.copyFile(sourcePath, backupPath);
    files.push({
      source: relativePath,
      backup: path.join(BACKUPS_DIR, backupName),
    });
  }

  return {
    backupDir: BACKUPS_DIR,
    timestamp,
    files,
  };
}

module.exports = {
  CORE_JSON_FILES,
  formatBackupTimestamp,
  backupCoreProjectJson,
};
