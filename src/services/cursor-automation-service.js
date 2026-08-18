'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { spawn } = require('node:child_process');
const path = require('node:path');

const execFileAsync = promisify(execFile);

const ACCESSIBILITY_GUIDANCE = [
  '需要开启 macOS 辅助功能权限，App 才能把提示词放入 Cursor 输入框。',
  '打开：系统设置 → 隐私与安全性 → 辅助功能，允许「视频剪辑编排器 v3」。',
  '授权后回到 App，再次点击「开始 AI 剪辑」。',
].join('\n');

const TECHNICAL_WINDOW_MARKERS = Object.freeze([
  'prompt.md',
  'TASK.md',
  'TASK.json',
  'RECOVERY.md',
  'status.json',
  'paths.json',
  'expected-artifacts.json',
  '.cursor-package',
]);

const PROJECT_WORKSPACE_BASENAME = 'video-cut-planner-v3';
const CURSOR_AGENT_MANAGER_WINDOW = 'Cursor Agents';
const TASK_WINDOW_TITLE = '视频剪辑编排器 · 任务';

// A handoff is a single-flight operation.  Keeping this in the main-process
// module prevents two renderer clicks (or a retry racing the first launch)
// from both opening Cursor before the task snapshot has recorded its session.
const cursorHandoffControllers = new Map();

function cursorHandoffKey(taskId, attemptId) {
  const task = String(taskId || '').trim();
  const attempt = String(attemptId || '').trim();
  return task && attempt ? `${task}:${attempt}` : '';
}

function getCursorHandoffController(taskId, attemptId) {
  const key = cursorHandoffKey(taskId, attemptId);
  return key ? cursorHandoffControllers.get(key) || null : null;
}

function destroyCursorHandoffController(taskId, attemptId, reason = 'inactive') {
  const key = cursorHandoffKey(taskId, attemptId);
  if (!key) return false;
  const controller = cursorHandoffControllers.get(key);
  if (!controller) return false;
  controller.uiAutomationActive = false;
  controller.phase = 'stopped';
  controller.closedReason = reason;
  controller.closedAt = new Date().toISOString();
  cursorHandoffControllers.delete(key);
  return true;
}

async function runCursorHandoffController({ taskId, attemptId } = {}, work) {
  const key = cursorHandoffKey(taskId, attemptId);
  if (!key || typeof work !== 'function') return work();
  const existing = cursorHandoffControllers.get(key);
  if (existing) return existing.promise;

  const controller = {
    key,
    taskId,
    attemptId,
    phase: 'launching',
    uiAutomationActive: true,
    createdAt: new Date().toISOString(),
    promise: null,
  };
  controller.promise = (async () => {
    try {
      const result = await work(controller);
      if (result?.submitted === true) {
        // Once Agent is running, no Accessibility/AppleScript retry remains.
        controller.phase = 'running';
        controller.uiAutomationActive = false;
      } else {
        controller.phase = 'stopped';
        controller.uiAutomationActive = false;
        cursorHandoffControllers.delete(key);
      }
      return result;
    } catch (error) {
      controller.phase = 'stopped';
      controller.uiAutomationActive = false;
      cursorHandoffControllers.delete(key);
      throw error;
    }
  })();
  cursorHandoffControllers.set(key, controller);
  return controller.promise;
}

function runOsascript(source, timeoutMs = 12_000) {
  return execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
}

function parseOsascriptJson(stdout) {
  return JSON.parse(String(stdout || '{}').trim() || '{}');
}

function windowLooksTechnical(name) {
  const text = String(name || '');
  return TECHNICAL_WINDOW_MARKERS.some((marker) => text.includes(marker));
}

function windowLooksLikeEditor(window) {
  const size = Array.isArray(window?.size) ? window.size : null;
  if (!size || size.length < 2) return true;
  return Number(size[0]) >= 600 && Number(size[1]) >= 400;
}

function windowLooksLikeWorkspace(name, workspaceNeedle) {
  const text = String(name || '');
  const needle = String(workspaceNeedle || PROJECT_WORKSPACE_BASENAME);
  if (!text || !needle || /\.cursor-package/i.test(text)) return false;
  if (windowLooksTechnical(text)) return false;
  return text === needle
    || text === `${needle} (工作区)`
    || text === `${needle} (Workspace)`;
}

function windowFingerprint(window) {
  if (!window || typeof window !== 'object') return '';
  if (window.id != null && Number.isFinite(Number(window.id))) return `id:${window.id}`;
  const pos = Array.isArray(window.position) ? window.position.join(',') : '';
  const size = Array.isArray(window.size) ? window.size.join(',') : '';
  return `name:${window.name || ''}|pos:${pos}|size:${size}`;
}

function normalizeWindow(raw, index = 0) {
  const name = String(raw?.name || '');
  const id = raw?.id == null || raw.id === '' ? null : Number(raw.id);
  return {
    name,
    id: Number.isFinite(id) ? id : null,
    position: Array.isArray(raw?.position) ? raw.position.map(Number) : null,
    size: Array.isArray(raw?.size) ? raw.size.map(Number) : null,
    index,
    fingerprint: windowFingerprint({
      name,
      id,
      position: raw?.position,
      size: raw?.size,
    }),
    technical: windowLooksTechnical(name),
  };
}

function sessionMatchesWindow(session, window) {
  if (!session || !window) return false;
  if (session.windowId != null && window.id != null && Number(session.windowId) === Number(window.id)) {
    return true;
  }
  if (session.fingerprint && window.fingerprint && session.fingerprint === window.fingerprint) {
    return true;
  }
  if (session.windowName && window.name && session.windowName === window.name) {
    const samePosition = Array.isArray(session.position)
      && Array.isArray(window.position)
      && session.position[0] === window.position[0]
      && session.position[1] === window.position[1];
    if (samePosition || session.windowId == null) return !window.technical;
  }
  return false;
}

function isReusableCursorSession(session, { attemptId, taskId } = {}) {
  if (!session || session.active !== true) return false;
  if (attemptId && session.attemptId && session.attemptId !== attemptId) return false;
  if (taskId && session.taskId && session.taskId !== taskId) return false;
  return Boolean(session.windowName || session.windowId || session.fingerprint);
}

function pickTaskWindow(windows, options = {}) {
  const list = (Array.isArray(windows) ? windows : []).map((item, index) => (
    item && typeof item === 'object' && 'fingerprint' in item ? item : normalizeWindow(item, index)
  ));
  const session = options.session || null;
  const workspaceNeedle = options.workspaceNeedle || options.titleNeedle || PROJECT_WORKSPACE_BASENAME;
  const preexisting = new Set(
    (options.preexisting || []).map((item) => (
      typeof item === 'string' ? item : windowFingerprint(item)
    )),
  );

  if (session && isReusableCursorSession(session, options)) {
    const matched = list.find((window) => sessionMatchesWindow(session, window) && !window.technical);
    if (matched) return matched;
  }

  const candidates = list.filter((window) => {
    if (!window.name) return false;
    if (window.technical) return false;
    if (/\.cursor-package/i.test(window.name)) return false;
    if (preexisting.has(window.fingerprint)) return false;
    if (!windowLooksLikeEditor(window)) return false;
    if (!windowLooksLikeWorkspace(window.name, workspaceNeedle)) return false;
    return true;
  });
  if (!candidates.length) {
    if (options.allowAgentManager === true) {
      return list.find((window) => window.name === CURSOR_AGENT_MANAGER_WINDOW
        && windowLooksLikeEditor(window)) || null;
    }
    return null;
  }
  const preferred = candidates.filter((window) => !window.technical);
  const pool = preferred.length ? preferred : candidates;
  const bareWorkspace = pool.find((window) => window.name === workspaceNeedle);
  return bareWorkspace || pool[pool.length - 1];
}

function pickTargetWindowName(names, titleNeedle, options = {}) {
  const list = Array.isArray(names) ? names : [];
  const windows = list.length && typeof list[0] === 'object'
    ? list.map((item, index) => (item && item.fingerprint ? item : normalizeWindow(item, index)))
    : list.map((name, index) => normalizeWindow({ name }, index));
  const picked = pickTaskWindow(windows, {
    ...options,
    workspaceNeedle: titleNeedle || options.workspaceNeedle,
  });
  return picked ? picked.name : null;
}

function windowLooksForbidden(name, titleNeedle, options = {}) {
  const text = String(name || '');
  if (windowLooksTechnical(text)) return true;
  if (text === CURSOR_AGENT_MANAGER_WINDOW) return options.allowAgentManager !== true;
  const window = normalizeWindow(options.window || {
    name: text,
    id: options.windowId,
    position: options.position,
    size: options.size,
  });
  if (options.session && sessionMatchesWindow(options.session, window)) return false;
  const preexisting = options.preexisting || [];
  const samePreexistingWindow = preexisting.some((item) => {
    if (typeof item === 'string') return item === window.fingerprint;
    const previous = item.fingerprint ? item : normalizeWindow(item);
    return Boolean(window.fingerprint && previous.fingerprint && window.fingerprint === previous.fingerprint);
  });
  if (samePreexistingWindow) return true;
  if (options.allowWorkspace === true && windowLooksLikeWorkspace(text, titleNeedle)) return false;
  return false;
}

async function checkAccessibilityPermission() {
  try {
    await runOsascript('Application("System Events").processes.length;', 4000);
    return { ok: true, granted: true, guidance: null };
  } catch (error) {
    const message = String(error.stderr || error.message || '');
    const denied = /not allowed assistive|1002|辅助功能|errAEEventNotPermitted/i.test(message);
    return {
      ok: false,
      granted: false,
      code: denied ? 'ACCESSIBILITY_DENIED' : 'ACCESSIBILITY_CHECK_FAILED',
      message: denied ? ACCESSIBILITY_GUIDANCE : message,
      guidance: ACCESSIBILITY_GUIDANCE,
    };
  }
}

function launchCursorProcess(openArgs) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn('cursor', openArgs, {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.on('error', reject);
    child.unref();
    setTimeout(() => resolve({ launched: true, args: openArgs }), 400);
  });
}

async function describeCursorWindows() {
  const { stdout } = await runOsascript(`
    const se = Application("System Events");
    const procs = se.processes.whose({ name: "Cursor" });
    if (!procs.length) {
      JSON.stringify({ ok: false, count: 0, windows: [] });
    } else {
      const windows = procs[0].windows();
      const items = [];
      for (let i = 0; i < windows.length; i++) {
        const win = windows[i];
        let id = null;
        let position = null;
        let size = null;
        try { id = win.id(); } catch (error) {}
        try { position = win.position(); } catch (error) {}
        try { size = win.size(); } catch (error) {}
        items.push({
          name: String(win.name() || ""),
          id: id,
          position: position,
          size: size,
        });
      }
      JSON.stringify({ ok: items.length > 0, count: items.length, windows: items });
    }
  `, 5000);
  const parsed = parseOsascriptJson(stdout);
  const windows = (parsed.windows || []).map((item, index) => normalizeWindow(item, index));
  return {
    ok: windows.length > 0,
    count: windows.length,
    windows,
    names: windows.map((item) => item.name),
  };
}

async function listCursorWindows() {
  try {
    const described = await describeCursorWindows();
    return {
      ok: described.ok,
      count: described.count,
      names: described.names,
      windows: described.windows,
    };
  } catch {
    return { ok: false, count: 0, names: [], windows: [] };
  }
}

function findSessionWindow(windows, session) {
  return (windows || []).find((window) => sessionMatchesWindow(session, window) && !window.technical) || null;
}

async function waitForCursorWindow(timeoutMs = 12_000, titleNeedle = '', options = {}) {
  const started = Date.now();
  let lastError = null;
  let lastCount = 0;
  let lastNames = [];
  let lastWindows = [];
  while (Date.now() - started < timeoutMs) {
    try {
      const listed = await listCursorWindows();
      lastCount = Number(listed.count || 0);
      lastNames = listed.names || [];
      lastWindows = listed.windows || [];
      const targetName = pickTargetWindowName(lastWindows, titleNeedle, {
        workspaceNeedle: titleNeedle || options.workspaceNeedle,
        session: options.session,
        preexisting: options.preexisting,
        attemptId: options.attemptId,
        taskId: options.taskId,
      });
      const target = lastWindows.find((window) => window.name === targetName) || null;
      if (listed.ok && targetName && target && !target.technical) {
        return {
          ok: true,
          windowCount: lastCount,
          windowName: targetName,
          window: target,
          names: lastNames,
          windows: lastWindows,
        };
      }
    } catch (error) {
      lastError = error;
      const permission = await checkAccessibilityPermission();
      if (!permission.granted) return permission;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return {
    ok: false,
    code: 'CURSOR_WINDOW_NOT_FOUND',
    message: titleNeedle
      ? `已启动 Cursor，但未找到项目任务窗口（${titleNeedle}）。`
      : '已启动 Cursor，但未找到可操作窗口。请手动点进 Cursor 后再试一次。',
    lastError: lastError?.message || null,
    windowCount: lastCount,
    names: lastNames,
    windows: lastWindows,
  };
}

async function waitForNewCursorWindow({
  before = [],
  workspaceNeedle = PROJECT_WORKSPACE_BASENAME,
  timeoutMs = 20_000,
  session = null,
  attemptId = '',
  taskId = '',
  allowAgentManager = false,
} = {}) {
  const preexistingWindows = (before || []).map((item, index) => (
    typeof item === 'string' ? normalizeWindow({ name: item }, index) : item
  ));
  const preexisting = preexistingWindows.map((item) => windowFingerprint(item));
  const beforeCount = preexistingWindows.length;
  if (session && isReusableCursorSession(session, { attemptId, taskId })) {
    const current = await listCursorWindows();
    const existing = findSessionWindow(current.windows, session);
    if (existing) {
      return {
        ok: true,
        reused: true,
        window: existing,
        windowName: existing.name,
        windowCount: current.count,
        names: current.names,
        windows: current.windows,
      };
    }
  }
  const started = Date.now();
  let last = {
    ok: false,
    code: 'CURSOR_WINDOW_NOT_FOUND',
    message: `已启动 Cursor，但未找到新的项目任务窗口（${workspaceNeedle}）。`,
    windowCount: beforeCount,
    names: preexistingWindows.map((item) => item.name),
  };
  while (Date.now() - started < timeoutMs) {
    const listed = await listCursorWindows().catch(() => ({ ok: false, windows: [], count: 0, names: [] }));
    const grown = Number(listed.count || 0) > beforeCount;
    const target = pickTaskWindow(listed.windows || [], {
      workspaceNeedle,
      session,
      preexisting,
      attemptId,
      taskId,
      allowAgentManager,
    });
    const modernAgentManager = target?.name === CURSOR_AGENT_MANAGER_WINDOW && allowAgentManager;
    if (target && (modernAgentManager || ((grown || !beforeCount)
      && !preexisting.includes(target.fingerprint)))) {
      return {
        ok: true,
        reused: modernAgentManager,
        window: target,
        windowName: target.name,
        windowCount: listed.count,
        names: listed.names,
        windows: listed.windows,
      };
    }
    last = {
      ...last,
      windowCount: listed.count,
      names: listed.names,
    };
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return last;
}

async function runCursorKeys(scriptBody, timeoutMs = 12_000) {
  const { stdout } = await runOsascript(`
    function run() {
      const se = Application("System Events");
      const procs = se.processes.whose({ name: "Cursor" });
      if (procs.length === 0) return JSON.stringify({ ok: false, code: "CURSOR_WINDOW_NOT_FOUND" });
      const cursor = procs[0];
      const windows = cursor.windows();
      if (windows.length === 0) return JSON.stringify({ ok: false, code: "CURSOR_WINDOW_NOT_FOUND" });
      ${scriptBody}
    }
  `, timeoutMs);
  return parseOsascriptJson(stdout);
}

function raiseTargetScript(target) {
  const needle = JSON.stringify(String(target?.name || target || ''));
  const fingerprint = JSON.stringify(String(target?.fingerprint || ''));
  const windowId = target?.id == null ? 'null' : JSON.stringify(Number(target.id));
  const expectedPos = JSON.stringify(Array.isArray(target?.position) ? target.position : null);
  const expectedSize = JSON.stringify(Array.isArray(target?.size) ? target.size : null);
  return `
      const needle = ${needle};
      const expectedId = ${windowId};
      const expectedFingerprint = ${fingerprint};
      const expectedPos = ${expectedPos};
      const expectedSize = ${expectedSize};
      function fp(name, id, position, size) {
        if (id != null && isFinite(Number(id))) return "id:" + Number(id);
        return "name:" + name + "|pos:" + (position ? position.join(",") : "") + "|size:" + (size ? size.join(",") : "");
      }
      let target = null;
      let exactName = null;
      for (let i = 0; i < windows.length; i++) {
        const win = windows[i];
        const name = String(win.name() || "");
        let id = null;
        let position = null;
        let size = null;
        try { id = win.id(); } catch (error) {}
        try { position = win.position(); } catch (error) {}
        try { size = win.size(); } catch (error) {}
        if (name.indexOf("cursor-package") !== -1) continue;
        if (name.indexOf("prompt.md") !== -1 || name.indexOf("TASK.json") !== -1) continue;
        if (expectedId != null && id === expectedId) { target = win; break; }
        if (expectedFingerprint && fp(name, id, position, size) === expectedFingerprint) { target = win; break; }
        const samePos = expectedPos && position && position[0] === expectedPos[0] && position[1] === expectedPos[1];
        const sameSize = expectedSize && size && size[0] === expectedSize[0] && size[1] === expectedSize[1];
        if (needle && name === needle && (samePos || sameSize || !expectedPos)) {
          target = win;
          break;
        }
        if (!exactName && needle && name === needle) exactName = win;
      }
      if (!target) target = exactName;
      if (!target) {
        const names = [];
        for (let i = 0; i < windows.length; i++) names.push(String(windows[i].name() || ""));
        return JSON.stringify({ ok: false, code: "CURSOR_WINDOW_NOT_FOUND", names, expectedFingerprint });
      }
      const targetName = String(target.name() || "");
      cursor.frontmost = true;
      try { target.actions["AXRaise"](); } catch (error) {}
      delay(0.45);
  `;
}

async function focusAgentComposer(target) {
  const raise = raiseTargetScript(target);
  const opened = await runCursorKeys(`
      ${raise}
      se.keyCode(53);
      delay(0.08);
      se.keyCode(53);
      delay(0.08);
      se.keyCode(53);
      delay(0.2);
      se.keystroke("l", { using: ["command down", "shift down"] });
      delay(1.2);
      se.keystroke("i", { using: ["command down"] });
      delay(0.8);
      let front = "";
      try { front = String(windows[0].name() || ""); } catch (error) {}
      return JSON.stringify({ ok: true, focused: true, targetName: targetName, frontName: front, windowCount: windows.length });
  `, 18_000);
  if (opened.ok) return opened;

  const inWindow = await runCursorKeys(`
      ${raise}
      se.keyCode(53);
      delay(0.08);
      se.keyCode(53);
      delay(0.12);
      se.keystroke("i", { using: ["command down"] });
      delay(0.7);
      let front = "";
      try { front = String(windows[0].name() || ""); } catch (error) {}
      return JSON.stringify({ ok: true, focused: true, fallback: "cmd-i", targetName: targetName, frontName: front, windowCount: windows.length });
  `, 12_000);
  return inWindow;
}

async function readFocusedComposer(target) {
  return runCursorKeys(`
      ${raiseTargetScript(target)}
      let role = "";
      let value = "";
      let description = "";
      let title = "";
      let help = "";
      try {
        const el = se.processes.whose({ name: "Cursor" })[0].focusedUIElement();
        try { role = String(el.role() || ""); } catch (error) {}
        try { value = String(el.value() || ""); } catch (error) {}
        try { description = String(el.description() || ""); } catch (error) {}
        try { title = String(el.title() || ""); } catch (error) {}
        try { help = String(el.help() || ""); } catch (error) {}
        if (!value) {
          try { value = String(el.valueDescription() || ""); } catch (error) {}
        }
      } catch (error) {}
      return JSON.stringify({ ok: true, role, value, description, title, help, targetName: targetName });
  `, 8000);
}

async function copyFocusedText(target) {
  const result = await runCursorKeys(`
      ${raiseTargetScript(target)}
      se.keystroke("a", { using: ["command down"] });
      delay(0.1);
      se.keystroke("c", { using: ["command down"] });
      delay(0.2);
      let role = "";
      let description = "";
      let title = "";
      let help = "";
      try {
        const el = se.processes.whose({ name: "Cursor" })[0].focusedUIElement();
        try { role = String(el.role() || ""); } catch (error) {}
        try { description = String(el.description() || ""); } catch (error) {}
        try { title = String(el.title() || ""); } catch (error) {}
        try { help = String(el.help() || ""); } catch (error) {}
      } catch (error) {}
      return JSON.stringify({ ok: true, role, description, title, help, targetName: targetName });
  `, 8000);
  return result;
}

async function pasteIntoFocusedField(target) {
  await runCursorKeys(`
      ${raiseTargetScript(target)}
      se.keystroke("a", { using: ["command down"] });
      delay(0.08);
      se.keystroke("v", { using: ["command down"] });
      delay(0.55);
      return JSON.stringify({ ok: true, targetName: targetName });
  `, 8000);
}

async function submitFocusedField(target) {
  await runCursorKeys(`
      ${raiseTargetScript(target)}
      se.keyCode(36, { using: ["command down"] });
      delay(0.45);
      se.keyCode(36);
      delay(0.45);
      return JSON.stringify({ ok: true, submitted: true, targetName: targetName });
  `, 6000);
}

function composerHoldsUnsentPrompt(state, verifyNeedle, prompt) {
  if (!focusedComposerLooksLikeAgent(state)) return false;
  const value = String(state?.value || '');
  return copiedLooksLikePrompt(value, verifyNeedle, prompt);
}

function focusedComposerLooksLikeAgent(state) {
  const role = String(state?.role || '');
  const metadata = [state?.description, state?.title, state?.help].filter(Boolean).join(' ');
  if (/StaticText/i.test(role)) return false;
  if (role && !/AXTextArea|AXTextField|AXComboBox/i.test(role)) return false;
  return !/(search files|quick open|command palette|filter|搜索文件|快速打开|命令面板|筛选)/i.test(metadata);
}

function copiedLooksLikePrompt(copied, verifyNeedle, prompt) {
  const text = String(copied || '');
  const needle = String(verifyNeedle || '');
  if (!needle || !text.includes(needle)) return false;
  if (text.includes('筛选器(例如') || text.includes('Filter (e.g. text')) return false;
  const expected = String(prompt || '');
  if (expected && text.length < Math.min(80, Math.floor(expected.length * 0.35))) return false;
  const extraMatch = expected.match(/本次额外要求：\n([\s\S]*?)\n\n完成后/);
  const extra = extraMatch ? extraMatch[1].trim() : '';
  if (extra && !text.includes(extra)) return false;
  return true;
}

function sessionFromWindow(window, extras = {}) {
  if (!window) return null;
  return {
    active: true,
    windowName: window.name || '',
    windowId: window.id,
    fingerprint: window.fingerprint,
    position: window.position,
    size: window.size,
    workspace: extras.workspace || '',
    taskId: extras.taskId || null,
    attemptId: extras.attemptId || null,
    launchedAt: extras.launchedAt || new Date().toISOString(),
    reused: extras.reused === true,
  };
}

async function injectPromptViaAccessibility(prompt, verifyNeedle, options = {}) {
  const permission = await checkAccessibilityPermission();
  if (!permission.granted) return permission;
  const titleNeedle = options.windowTitleNeedle || options.titleNeedle || TASK_WINDOW_TITLE;
  const windowReady = options.targetWindow
    ? {
      ok: true,
      windowName: options.targetWindow.name,
      window: options.targetWindow,
      windowCount: options.windowCount,
    }
    : await waitForCursorWindow(titleNeedle ? 20_000 : 14_000, titleNeedle, options);
  if (!windowReady.ok) return windowReady;
  let target = windowReady.window || normalizeWindow({ name: windowReady.windowName });
  if (target.technical || windowLooksForbidden(windowReady.windowName, titleNeedle, {
    session: options.session,
    preexisting: options.preexisting,
    allowWorkspace: true,
    allowAgentManager: options.allowAgentManager === true,
    window: target,
  })) {
    return {
      ok: false,
      injected: false,
      verified: false,
      submitted: false,
      code: 'CURSOR_WINDOW_FORBIDDEN',
      message: '拒绝写入当前开发用 Cursor 窗口或其他无关会话。将打开独立的项目任务窗口。',
      preview: '',
      windowName: windowReady.windowName,
    };
  }
  const submit = options.submit === true;
  const attempts = Math.max(1, Number(options.retries || 3));
  let last = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const focused = await focusAgentComposer(target);
      if (!focused.ok) {
        last = { ...focused, injected: false, verified: false };
        continue;
      }
      if (target.name === CURSOR_AGENT_MANAGER_WINDOW && options.allowAgentManager === true) {
        const taskWindow = await waitForCursorWindow(5_000, titleNeedle, {
          ...options,
          allowAgentManager: false,
          preexisting: options.preexisting,
        });
        if (taskWindow.ok && taskWindow.window) target = taskWindow.window;
      }
      if (options.clipboard && typeof options.clipboard.writeText === 'function') {
        options.clipboard.writeText('');
      }
      const copiedField = await copyFocusedText(target);
      if (!focusedComposerLooksLikeAgent(copiedField)) {
        last = {
          ok: false,
          injected: false,
          verified: false,
          code: 'CURSOR_COMPOSER_NOT_FOUND',
          message: '当前焦点不是 Cursor Agent 输入区，已拒绝写入搜索框或文件面板。',
          windowName: target.name || focused.targetName || windowReady.windowName,
        };
        continue;
      }
      const before = options.clipboard && typeof options.clipboard.readText === 'function'
        ? String(options.clipboard.readText() || '')
        : '';
      const alreadyOurs = copiedLooksLikePrompt(before, verifyNeedle, prompt);
      if (before && !alreadyOurs && before.length > 80 && !copiedLooksLikePrompt(before, verifyNeedle, prompt)) {
        const looksLikeOtherSession = /执行视频剪辑任务|You are an AI|user_query|Project Sentinel|交接体验与端到端最终收口/.test(before)
          && !String(before).includes(String(verifyNeedle || ''));
        if (looksLikeOtherSession) {
          last = {
            ok: false,
            injected: false,
            verified: false,
            code: 'CURSOR_WINDOW_FORBIDDEN',
            message: '复制到的是其它会话内容，不是当前任务的 Agent 输入框。已中止，避免写入当前开发会话。',
            preview: before.slice(0, 240),
            windowName: target.name || focused.targetName || windowReady.windowName,
          };
          continue;
        }
      }
      if (!alreadyOurs) {
        if (options.clipboard && typeof options.clipboard.writeText === 'function') {
          options.clipboard.writeText(String(prompt || ''));
        }
        await pasteIntoFocusedField(target);
        const pastedField = await copyFocusedText(target);
        if (!focusedComposerLooksLikeAgent(pastedField)) {
          last = {
            ok: false,
            injected: false,
            verified: false,
            code: 'CURSOR_COMPOSER_NOT_FOUND',
            message: '提示词未进入 Cursor Agent 输入区，已拒绝把内部交接内容写入其他面板。',
            windowName: target.name || focused.targetName || windowReady.windowName,
          };
          continue;
        }
      }
      const copied = alreadyOurs
        ? before
        : (options.clipboard && typeof options.clipboard.readText === 'function'
          ? String(options.clipboard.readText() || '')
          : '');
      const verified = copiedLooksLikePrompt(copied, verifyNeedle, prompt);
      last = {
        ok: verified,
        injected: true,
        verified,
        preview: copied.slice(0, 800),
        windowName: target.name || focused.targetName || windowReady.windowName,
        windowCount: focused.windowCount || windowReady.windowCount,
        code: verified ? null : 'PROMPT_INJECT_UNVERIFIED',
        window: target,
      };
      if (verified) {
        const expectedNeedle = String(titleNeedle || '');
        if (expectedNeedle && windowLooksTechnical(last.windowName)) {
          last = {
            ...last,
            ok: false,
            verified: false,
            submitted: false,
            code: 'CURSOR_WINDOW_MISMATCH',
            message: `提示词窗口不匹配：期望项目窗口 ${expectedNeedle}，实际 ${last.windowName || '未知'}。`,
          };
          continue;
        }
        if (last.windowName === 'Cursor Agents' && !copied.includes(String(verifyNeedle || ''))) {
          last = {
            ...last,
            ok: false,
            verified: false,
            submitted: false,
            code: 'CURSOR_WINDOW_FORBIDDEN',
            message: '拒绝写入全局 Cursor Agents 会话。将使用独立的项目任务窗口。',
          };
          continue;
        }
        if (submit) {
          await submitFocusedField(target);
          await new Promise((resolve) => setTimeout(resolve, 900));
          let composer = await readFocusedComposer(target).catch(() => ({ value: '', role: '' }));
          let composerValue = String(composer.value || '');
          const hijackedThisChat = /交接体验与端到端最终收口/.test(composerValue)
            && !composerValue.includes(String(verifyNeedle || ''));
          if (hijackedThisChat) {
            last = {
              ...last,
              ok: false,
              verified: true,
              submitted: false,
              code: 'CURSOR_WINDOW_FORBIDDEN',
              message: '提交后焦点落到了当前开发会话。已中止。',
              preview: composerValue.slice(0, 800),
            };
            continue;
          }
          if (composerHoldsUnsentPrompt(composer, verifyNeedle, prompt)) {
            await submitFocusedField(target);
            await new Promise((resolve) => setTimeout(resolve, 900));
            composer = await readFocusedComposer(target).catch(() => ({ value: '', role: '' }));
            composerValue = String(composer.value || '');
          }
          if (composerHoldsUnsentPrompt(composer, verifyNeedle, prompt)) {
            last = {
              ...last,
              ok: false,
              verified: true,
              submitted: false,
              code: 'PROMPT_SUBMIT_UNCONFIRMED',
              message: '提示词已在输入框中验证，但未能确认 Agent 已进入运行。',
              preview: composerValue.slice(0, 800),
            };
            continue;
          }
        }
        return {
          ok: true,
          injected: true,
          verified: true,
          submitted: submit,
          preview: last.preview,
          windowName: last.windowName,
          windowCount: last.windowCount,
          window: target,
          session: sessionFromWindow(target, options),
        };
      }
    } catch (error) {
      const permissionAgain = await checkAccessibilityPermission();
      if (!permissionAgain.granted) return permissionAgain;
      last = {
        ok: false,
        injected: false,
        verified: false,
        code: 'PROMPT_INJECT_FAILED',
        message: error.message,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    ok: false,
    injected: last?.injected === true,
    verified: false,
    submitted: false,
    code: last?.code || 'PROMPT_INJECT_UNVERIFIED',
    message: last?.message || '已尝试粘贴提示词，但未能在 Cursor Agent 输入框中验证到任务内容。',
    preview: last?.preview || '',
    windowName: last?.windowName || windowReady.windowName,
    window: target,
    session: sessionFromWindow(target, options),
    guidance: '请点进项目窗口的 Agent 输入框后，回到 App 使用「重新打开 Agent」。',
  };
}

async function withClipboard(clipboard, text, action) {
  const previous = clipboard.readText();
  try {
    clipboard.writeText(String(text || ''));
    return await action();
  } finally {
    try {
      clipboard.writeText(previous || '');
    } catch {
      // Restoring the original clipboard is best-effort.
    }
  }
}

function workspaceFromOpenArgs(openArgs, fallback = '') {
  const args = Array.isArray(openArgs) ? openArgs : [];
  const folder = [...args].reverse().find((arg) => (
    String(arg).startsWith('/')
    && !String(arg).includes('.cursor-package')
    && !/\.(md|json|code-workspace)$/i.test(String(arg))
  ));
  return folder || fallback;
}

async function performLaunchAndInjectCursor({
  openArgs,
  prompt,
  verifyNeedle,
  clipboard,
  inject = true,
  submit = false,
  windowTitleNeedle = '',
  workspace = '',
  session = null,
  attemptId = '',
  taskId = '',
  allowAgentManager = false,
} = {}) {
  const resolvedWorkspace = workspaceFromOpenArgs(openArgs, workspace);
  const workspaceNeedle = windowTitleNeedle || TASK_WINDOW_TITLE;
  const before = await listCursorWindows().catch(() => ({ windows: [], names: [], count: 0 }));
  const reusable = isReusableCursorSession(session, { attemptId, taskId })
    ? findSessionWindow(before.windows, session)
    : null;

  let launch = { launched: false, args: openArgs, reused: false };
  let target = reusable;
  if (target) {
    launch = { launched: false, reused: true, args: openArgs };
  } else {
    launch = await launchCursorProcess(openArgs);
    const appeared = await waitForNewCursorWindow({
      before: before.windows,
      workspaceNeedle,
      timeoutMs: 35_000,
      session,
      attemptId,
      taskId,
      allowAgentManager,
    });
    if (!appeared.ok) {
      return {
        ok: false,
        launched: true,
        reused: false,
        injected: false,
        verified: false,
        submitted: false,
        launch,
        ...appeared,
      };
    }
    target = appeared.window || normalizeWindow({ name: appeared.windowName });
  }

  if (!inject) {
    try {
      await runCursorKeys(`${raiseTargetScript(target)} return JSON.stringify({ ok: true, targetName: targetName });`);
    } catch {
      // Raising the existing task window is best-effort when inject is skipped.
    }
    return {
      ok: true,
      launched: launch.launched !== false && !reusable,
      reused: Boolean(reusable),
      injected: false,
      verified: false,
      submitted: false,
      launch,
      windowName: target.name,
      window: target,
      session: sessionFromWindow(target, {
        workspace: resolvedWorkspace,
        taskId,
        attemptId,
        reused: Boolean(reusable),
      }),
    };
  }

  const permission = await checkAccessibilityPermission();
  if (!permission.granted) {
    return {
      ok: false,
      launched: !reusable,
      reused: Boolean(reusable),
      injected: false,
      verified: false,
      submitted: false,
      launch,
      windowName: target.name,
      session: sessionFromWindow(target, {
        workspace: resolvedWorkspace,
        taskId,
        attemptId,
        reused: Boolean(reusable),
      }),
      ...permission,
    };
  }

  const result = await withClipboard(clipboard, prompt, () => (
    injectPromptViaAccessibility(prompt, verifyNeedle, {
      submit,
      retries: 3,
      clipboard,
      windowTitleNeedle: workspaceNeedle,
      targetWindow: target,
      session,
      preexisting: before.windows,
      attemptId,
      taskId,
      workspace: resolvedWorkspace,
      allowAgentManager,
    })
  ));
  return {
    ...result,
    launched: !reusable,
    reused: Boolean(reusable),
    launch,
    verified: result.verified === true,
    submitted: result.submitted === true,
    session: result.session || sessionFromWindow(target, {
      workspace: resolvedWorkspace,
      taskId,
      attemptId,
      reused: Boolean(reusable),
    }),
  };
}

async function launchAndInjectCursor(options = {}) {
  if (options.inject !== false && options.controllerOwned !== true
    && options.taskId && options.attemptId) {
    return runCursorHandoffController(options, () => performLaunchAndInjectCursor(options));
  }
  return performLaunchAndInjectCursor(options);
}

module.exports = {
  ACCESSIBILITY_GUIDANCE,
  PROJECT_WORKSPACE_BASENAME,
  TASK_WINDOW_TITLE,
  TECHNICAL_WINDOW_MARKERS,
  checkAccessibilityPermission,
  copiedLooksLikePrompt,
  composerHoldsUnsentPrompt,
  focusedComposerLooksLikeAgent,
  destroyCursorHandoffController,
  describeCursorWindows,
  findSessionWindow,
  getCursorHandoffController,
  injectPromptViaAccessibility,
  isReusableCursorSession,
  launchAndInjectCursor,
  launchCursorProcess,
  listCursorWindows,
  pickTargetWindowName,
  pickTaskWindow,
  sessionFromWindow,
  sessionMatchesWindow,
  runCursorHandoffController,
  windowLooksLikeEditor,
  waitForCursorWindow,
  waitForNewCursorWindow,
  windowLooksForbidden,
  windowLooksTechnical,
  withClipboard,
};
