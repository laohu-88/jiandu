const fs = require('node:fs/promises');
const path = require('node:path');

async function readJsonFile(filePath, options = {}) {
  const resolvedPath = path.resolve(filePath);
  let text;
  try {
    text = await fs.readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && options.optional) {
      return { value: null, path: resolvedPath, missing: true, error: null };
    }
    throw Object.assign(new Error(`无法读取 ${options.label || path.basename(filePath)}：${error.message}`), {
      code: error.code === 'ENOENT' ? 'PROJECT_FILE_MISSING' : 'PROJECT_FILE_READ_FAILED',
      filePath: resolvedPath,
      cause: error,
    });
  }

  try {
    return { value: JSON.parse(text), path: resolvedPath, missing: false, error: null };
  } catch (error) {
    throw Object.assign(new Error(`${options.label || path.basename(filePath)} JSON 已损坏：${error.message}`), {
      code: 'PROJECT_JSON_CORRUPT',
      filePath: resolvedPath,
      cause: error,
    });
  }
}

module.exports = { readJsonFile };
