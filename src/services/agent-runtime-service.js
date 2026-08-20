'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const { HEARTBEAT_STALE_MS } = require('./agent-lifecycle-service');

const execFileAsync = promisify(execFile);

const ENGINE_BUNDLES = Object.freeze({
  codex: Object.freeze(['com.openai.codex', 'com.todesktop.230313mzl4w4u92']),
});

const ENGINE_APP_PREFIXES = Object.freeze({
  codex: Object.freeze(['/Applications/Codex.app/Contents/MacOS/']),
});

function normalizeProcessName(value) {
  return String(value || '')
    .replace(/\.app$/i, '')
    .split('/')
    .pop()
    .trim()
    .toLowerCase();
}

function matchesEngine(commandLine, engine) {
  const text = String(commandLine || '');
  const prefixes = ENGINE_APP_PREFIXES[engine] || [];
  if (prefixes.some((prefix) => text.includes(prefix))) return true;
  const name = normalizeProcessName(text);
  if (engine === 'codex') return name === 'codex';
  return false;
}

async function listProcessCommands({ execFileImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileImpl('/bin/ps', ['-axo', 'pid=,command='], {
      timeout: 4000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return String(stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        const pid = Number(parts.shift());
        return { pid, command: parts.join(' ') };
      });
  } catch {
    return [];
  }
}

async function bundleIsRunning(bundleId, { execFileImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileImpl('/usr/bin/lsappinfo', ['find', `bundleid=${bundleId}`], {
      timeout: 3000,
    });
    return /ASN:/i.test(String(stdout || ''));
  } catch {
    return false;
  }
}

async function runOsascript(source, timeoutMs = 8_000, { execFileImpl = execFileAsync } = {}) {
  const { stdout } = await execFileImpl('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

async function countAppWindows(appName, options = {}) {
  const runner = options.runOsascript || runOsascript;
  try {
    const result = await runner(`
      const se = Application("System Events");
      const procs = se.processes.whose({ name: ${JSON.stringify(appName)} });
      procs.length ? procs[0].windows.length : 0;
    `, 4000);
    const stdout = result?.stdout == null ? result : result.stdout;
    const count = Number(String(stdout || '').trim());
    return Number.isFinite(count) ? count : 0;
  } catch {
    return null;
  }
}

async function listAppWindowNames(appName, options = {}) {
  const runner = options.runOsascript || runOsascript;
  try {
    const result = await runner(`
      const se = Application("System Events");
      const procs = se.processes.whose({ name: ${JSON.stringify(appName)} });
      if (!procs.length) {
        JSON.stringify({ ok: false, names: [] });
      } else {
        const windows = procs[0].windows();
        const names = [];
        for (let i = 0; i < windows.length; i++) names.push(String(windows[i].name() || ""));
        JSON.stringify({ ok: true, names });
      }
    `, 5000);
    const stdout = result?.stdout == null ? result : result.stdout;
    const parsed = JSON.parse(String(stdout || '{}').trim() || '{}');
    return Array.isArray(parsed.names) ? parsed.names : [];
  } catch {
    return null;
  }
}

function taskWindowNeedle(task) {
  const session = task?.agentSession;
  if (session?.active === true && (session.windowName || session.fingerprint || session.windowId != null)) {
    return session.windowName || session.fingerprint || String(session.windowId);
  }
  return '';
}

function agentSessionIsActive(task) {
  const session = task?.agentSession;
  const attemptId = task?.currentAttempt?.attemptId || null;
  if (!session || session.active !== true) return false;
  if (attemptId && session.attemptId && session.attemptId !== attemptId) return false;
  return true;
}

async function probeTaskWindow(task, options = {}) {
  if ((task?.engine || 'codex') !== 'codex') {
    return { taskWindowExists: null, windowProbeOk: false, windowNames: [] };
  }
  if (!agentSessionIsActive(task)) {
    return {
      taskWindowExists: false,
      windowProbeOk: true,
      windowNames: [],
      sessionActive: false,
    };
  }
  return { taskWindowExists: false, windowProbeOk: true, windowNames: [], sessionActive: true };
}

async function probeAgentRuntime(engine, options = {}) {
  const resolved = engine === 'codex' ? 'codex' : 'codex';
  const bundleIds = ENGINE_BUNDLES[resolved] || [];
  let bundleRunning = false;
  for (const bundleId of bundleIds) {
    if (await bundleIsRunning(bundleId, options)) {
      bundleRunning = true;
      break;
    }
  }
  const processes = await listProcessCommands(options);
  const matched = processes.filter((item) => matchesEngine(item.command, resolved));
  const processExists = bundleRunning || matched.length > 0;
  const appName = resolved === 'codex' ? 'Codex' : 'Codex';
  const windowCount = options.runOsascript
    ? await countAppWindows(appName, options)
    : null;
  return {
    engine: resolved,
    processExists,
    sessionActive: windowCount == null ? processExists : windowCount > 0,
    windowCount,
    bundleRunning,
    processes,
    pids: matched.map((item) => item.pid).filter((pid) => Number.isFinite(pid)),
    checkedAt: new Date().toISOString(),
  };
}

async function attachResultEvidence(task, runtime = {}, now = Date.now()) {
  const artifacts = task?.artifacts || {};
  const candidates = [
    artifacts.analysisPath,
    artifacts.analysisOutputPath,
    artifacts.manifestPath,
    artifacts.previewPath,
    artifacts.fcpxmlPath,
  ].filter(Boolean);
  let resultUpdatedRecently = false;
  let latestMtimeMs = 0;
  for (const filePath of candidates) {
    try {
      const stat = await fs.stat(filePath);
      latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
      if (now - stat.mtimeMs <= HEARTBEAT_STALE_MS) resultUpdatedRecently = true;
    } catch {
      // Missing artifacts are not evidence of a live agent.
    }
  }
  return {
    ...runtime,
    resultUpdatedRecently,
    resultUpdatedAt: latestMtimeMs ? new Date(latestMtimeMs).toISOString() : null,
  };
}

async function probeTaskRuntime(task, options = {}) {
  const runtime = await probeAgentRuntime(task?.engine, options);
  const withResults = await attachResultEvidence(task, runtime, options.now);
  const windowProbe = await probeTaskWindow(task, { ...options, processes: runtime.processes });
  const sessionExists = withResults.processExists === true;
  return {
    ...withResults,
    ...windowProbe,
    sessionExists,
  };
}

module.exports = {
  ENGINE_BUNDLES,
  attachResultEvidence,
  bundleIsRunning,
  agentSessionIsActive,
  listAppWindowNames,
  matchesEngine,
  normalizeProcessName,
  probeAgentRuntime,
  probeTaskRuntime,
  probeTaskWindow,
  taskWindowNeedle,
};
