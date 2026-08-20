const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function commandExists(command) {
  try {
    await execFileAsync('/usr/bin/which', [command], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function grokBuildStatus(env = process.env) {
  const candidates = [
    '/Applications/Grok Build.app',
    '/Applications/Grok.app',
  ];
  const installedByApp = (await Promise.all(candidates.map(async (candidate) => (
    Boolean(await fs.stat(candidate).catch(() => null))
  )))).some(Boolean);
  const executable = await commandExists('grok-build');
  const configured = Boolean(env.GROK_BUILD_API_KEY || env.XAI_API_KEY);
  return {
    provider: 'grok-build',
    label: 'Grok Build',
    installed: installedByApp || executable,
    configured,
    available: false,
    mode: null,
    reason: '当前未验证官方本地 headless / ACP / stdio 调用，剪渡不会伪造可用状态。',
  };
}

async function getProviderStatus(env = process.env) {
  return {
    default: 'codex',
    providers: {
      codex: { provider: 'codex', label: 'Codex', installed: true, configured: true, available: true },
      grokBuild: await grokBuildStatus(env),
    },
  };
}

module.exports = { getProviderStatus, grokBuildStatus };
