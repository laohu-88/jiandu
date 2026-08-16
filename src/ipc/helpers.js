const path = require('node:path');

const { DEFAULT_PROJECT_ROOT } = require('../constants');
const {
  readCodexProjectResult,
  resolveProjectPath,
} = require('../services/codex-project-result-service');
const { assertCatalogProject } = require('../services/project-catalog-service');
const {
  DEFAULT_PENDING_ROOT,
  scanPendingMediaCatalog,
} = require('../services/pending-media-catalog-service');
const { listHandoffTasks } = require('../services/handoff-task-service');

function createIpcHelpers({ app }) {
  const authorizedProjectPaths = new Set();

  function authorizeProject(projectPath) {
    const resolved = path.resolve(projectPath);
    authorizedProjectPaths.add(resolved);
    return resolved;
  }

  function assertAuthorizedProject(projectPath) {
    const resolved = path.resolve(String(projectPath || ''));
    if (!authorizedProjectPaths.has(resolved)) {
      throw Object.assign(new Error('项目尚未通过主进程授权。'), {
        code: 'PROJECT_NOT_AUTHORIZED',
      });
    }
    return resolved;
  }

  async function resolveAuthorizedItem(args, kind) {
    const projectPath = assertAuthorizedProject(args?.projectPath);
    return resolveProjectPath(projectPath, args?.relativePath, { kind });
  }

  async function scanHandoffsAndPending() {
    const handoffs = await listHandoffTasks(app.getPath('userData'));
    const catalog = await scanPendingMediaCatalog({
      rootPath: DEFAULT_PENDING_ROOT,
      projectRoot: DEFAULT_PROJECT_ROOT,
      tasks: handoffs.tasks,
    });
    return { ...catalog, handoffs };
  }

  async function validateTerminalProject(task) {
    if (!task.resultProjectPath) return null;
    const projectPath = await assertCatalogProject(DEFAULT_PROJECT_ROOT, task.resultProjectPath);
    const result = await readCodexProjectResult(projectPath);
    if (result.verification.status === 'failed' || !result.artifacts.fcpxml?.exists) return null;
    return { projectPath, result };
  }

  return {
    authorizeProject,
    assertAuthorizedProject,
    resolveAuthorizedItem,
    scanHandoffsAndPending,
    validateTerminalProject,
  };
}

module.exports = { createIpcHelpers };
