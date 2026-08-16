'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { spawn } = require('node:child_process');

const execFileAsync = promisify(execFile);

const ACCESSIBILITY_GUIDANCE = [
  '需要开启 macOS 辅助功能权限，App 才能把提示词放入 Cursor 输入框。',
  '打开：系统设置 → 隐私与安全性 → 辅助功能，允许「视频剪辑编排器 v3」。',
  '授权后回到 App，再次点击「开始 AI 剪辑」。',
].join('\n');

const FORBIDDEN_WINDOW_MARKERS = Object.freeze([
  'video-cut-planner-v3',
]);

function runOsascript(source, timeoutMs = 12_000) {
  return execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
}

function parseOsascriptJson(stdout) {
  return JSON.parse(String(stdout || '{}').trim() || '{}');
}

function windowLooksForbidden(name, titleNeedle) {
  const text = String(name || '');
  const needle = String(titleNeedle || '');
  if (needle && text.includes(needle)) return false;
  if (/\.cursor-package/i.test(text)) return false;
  return FORBIDDEN_WINDOW_MARKERS.some((marker) => text.includes(marker));
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
    const child = spawn('cursor', openArgs, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.unref();
    setTimeout(() => resolve({ launched: true, args: openArgs }), 400);
  });
}

async function listCursorWindows() {
  const { stdout } = await runOsascript(`
    const se = Application("System Events");
    const procs = se.processes.whose({ name: "Cursor" });
    if (!procs.length) {
      JSON.stringify({ ok: false, count: 0, names: [] });
    } else {
      const windows = procs[0].windows();
      const names = [];
      for (let i = 0; i < windows.length; i++) names.push(String(windows[i].name() || ""));
      JSON.stringify({ ok: names.length > 0, count: names.length, names });
    }
  `, 4000);
  return parseOsascriptJson(stdout);
}

function pickTargetWindowName(names, titleNeedle) {
  const list = Array.isArray(names) ? names : [];
  const needle = String(titleNeedle || '');
  if (needle) {
    return list.find((name) => {
      const text = String(name);
      return text.includes(needle) && !windowLooksForbidden(text, needle);
    }) || null;
  }
  const byPackage = [...list].reverse().find((name) => /\.cursor-package/i.test(String(name))
    && !windowLooksForbidden(name, needle));
  return byPackage || null;
}

async function waitForCursorWindow(timeoutMs = 12_000, titleNeedle = '') {
  const started = Date.now();
  let lastError = null;
  let lastCount = 0;
  let lastNames = [];
  while (Date.now() - started < timeoutMs) {
    try {
      const listed = await listCursorWindows();
      lastCount = Number(listed.count || 0);
      lastNames = listed.names || [];
      const targetName = pickTargetWindowName(lastNames, titleNeedle);
      if (listed.ok && (titleNeedle ? Boolean(targetName) : lastCount > 0)) {
        return {
          ok: true,
          windowCount: lastCount,
          windowName: targetName || lastNames[lastNames.length - 1] || '',
          names: lastNames,
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
      ? `已启动 Cursor，但未找到独立任务窗口（${titleNeedle}）。`
      : '已启动 Cursor，但未找到可操作窗口。请手动点进 Cursor 后再试一次。',
    lastError: lastError?.message || null,
    windowCount: lastCount,
    names: lastNames,
  };
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

function raiseTargetScript(titleNeedle) {
  const needle = JSON.stringify(String(titleNeedle || ''));
  return `
      const needle = ${needle};
      let target = null;
      for (let i = windows.length - 1; i >= 0; i--) {
        const name = String(windows[i].name() || "");
        if (needle && name.indexOf(needle) !== -1) { target = windows[i]; break; }
        if (!needle && name.indexOf("cursor-package") !== -1) {
          target = windows[i];
          break;
        }
      }
      if (!target) {
        const names = [];
        for (let i = 0; i < windows.length; i++) names.push(String(windows[i].name() || ""));
        return JSON.stringify({ ok: false, code: "CURSOR_WINDOW_NOT_FOUND", names });
      }
      const targetName = String(target.name() || "");
      if (!needle && /video-cut-planner-v3/.test(targetName) && targetName.indexOf("cursor-package") === -1) {
        return JSON.stringify({ ok: false, code: "CURSOR_WINDOW_FORBIDDEN", targetName });
      }
      cursor.frontmost = true;
      try { target.actions["AXRaise"](); } catch (error) {}
      delay(0.45);
  `;
}

async function focusAgentComposer(titleNeedle) {
  const raise = raiseTargetScript(titleNeedle);
  const opened = await runCursorKeys(`
      ${raise}
      se.keyCode(53);
      delay(0.08);
      se.keyCode(53);
      delay(0.08);
      se.keyCode(53);
      delay(0.2);
      se.keystroke("p", { using: ["command down", "shift down"] });
      delay(0.45);
      se.keystroke("composer.newAgentChat");
      delay(0.35);
      se.keyCode(36);
      delay(0.8);
      return JSON.stringify({ ok: true, focused: true, targetName: targetName, windowCount: windows.length });
  `, 18_000);
  if (opened.ok) return opened;

  const fallback = await runCursorKeys(`
      ${raise}
      se.keyCode(53);
      delay(0.12);
      se.keystroke("i", { using: ["command down"] });
      delay(0.55);
      return JSON.stringify({ ok: true, focused: true, fallback: "cmd-i", targetName: targetName, windowCount: windows.length });
  `, 12_000);
  return fallback;
}

async function copyFocusedText(titleNeedle) {
  await runCursorKeys(`
      ${raiseTargetScript(titleNeedle)}
      se.keystroke("a", { using: ["command down"] });
      delay(0.1);
      se.keystroke("c", { using: ["command down"] });
      delay(0.2);
      return JSON.stringify({ ok: true, targetName: targetName });
  `, 8000);
}

async function pasteIntoFocusedField(titleNeedle) {
  await runCursorKeys(`
      ${raiseTargetScript(titleNeedle)}
      se.keystroke("a", { using: ["command down"] });
      delay(0.08);
      se.keystroke("v", { using: ["command down"] });
      delay(0.55);
      return JSON.stringify({ ok: true, targetName: targetName });
  `, 8000);
}

async function submitFocusedField(titleNeedle) {
  await runCursorKeys(`
      ${raiseTargetScript(titleNeedle)}
      se.keyCode(36, { using: ["command down"] });
      delay(0.35);
      return JSON.stringify({ ok: true, submitted: true, targetName: targetName });
  `, 4000);
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

async function injectPromptViaAccessibility(prompt, verifyNeedle, options = {}) {
  const permission = await checkAccessibilityPermission();
  if (!permission.granted) return permission;
  const titleNeedle = options.windowTitleNeedle || options.titleNeedle || '';
  const windowReady = await waitForCursorWindow(titleNeedle ? 20_000 : 14_000, titleNeedle);
  if (!windowReady.ok) return windowReady;
  if (windowLooksForbidden(windowReady.windowName, titleNeedle)) {
    return {
      ok: false,
      injected: false,
      verified: false,
      submitted: false,
      code: 'CURSOR_WINDOW_FORBIDDEN',
      message: '拒绝写入当前开发用 Cursor 窗口。请等待独立的 .cursor-package 任务窗口。',
      preview: '',
      windowName: windowReady.windowName,
    };
  }
  const submit = options.submit === true;
  const attempts = Math.max(1, Number(options.retries || 3));
  let last = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const focused = await focusAgentComposer(titleNeedle || windowReady.windowName);
      if (!focused.ok) {
        last = { ...focused, injected: false, verified: false };
        continue;
      }
      if (options.clipboard && typeof options.clipboard.writeText === 'function') {
        options.clipboard.writeText('');
      }
      const targetNeedle = titleNeedle || windowReady.windowName;
      await copyFocusedText(targetNeedle);
      const before = options.clipboard && typeof options.clipboard.readText === 'function'
        ? String(options.clipboard.readText() || '')
        : '';
      if (copiedLooksLikePrompt(before, verifyNeedle, prompt)) {
        last = {
          ok: false,
          injected: false,
          verified: false,
          code: 'CURSOR_WINDOW_FORBIDDEN',
          message: '复制到的是已有提示词文件，不是空的 Agent 输入框。已中止，避免写入当前开发会话。',
          preview: before.slice(0, 240),
          windowName: focused.targetName || windowReady.windowName,
        };
        continue;
      }
      if (options.clipboard && typeof options.clipboard.writeText === 'function') {
        options.clipboard.writeText(String(prompt || ''));
      }
      await pasteIntoFocusedField(targetNeedle);
      await copyFocusedText(targetNeedle);
      const copied = options.clipboard && typeof options.clipboard.readText === 'function'
        ? String(options.clipboard.readText() || '')
        : '';
      const verified = copiedLooksLikePrompt(copied, verifyNeedle, prompt);
      last = {
        ok: verified,
        injected: true,
        verified,
          preview: copied.slice(0, 800),
        windowName: focused.targetName || windowReady.windowName,
        windowCount: focused.windowCount || windowReady.windowCount,
        code: verified ? null : 'PROMPT_INJECT_UNVERIFIED',
      };
      if (verified) {
        const expectedNeedle = String(titleNeedle || '');
        if (expectedNeedle && !String(last.windowName || '').includes(expectedNeedle)) {
          last = {
            ...last,
            ok: false,
            verified: false,
            submitted: false,
            code: 'CURSOR_WINDOW_MISMATCH',
            message: `提示词窗口不匹配：期望 ${expectedNeedle}，实际 ${last.windowName || '未知'}。`,
          };
          continue;
        }
        if (submit) await submitFocusedField(targetNeedle);
        return {
          ok: true,
          injected: true,
          verified: true,
          submitted: submit,
          preview: last.preview,
          windowName: last.windowName,
          windowCount: last.windowCount,
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
    guidance: '请点进独立任务窗口的 Agent 输入框后，回到 App 使用「重新打开 Agent」。',
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

async function launchAndInjectCursor({
  openArgs,
  prompt,
  verifyNeedle,
  clipboard,
  inject = true,
  submit = false,
  windowTitleNeedle = '',
} = {}) {
  const launch = await launchCursorProcess(openArgs);
  if (!inject) {
    return {
      ok: true,
      launched: true,
      injected: false,
      verified: false,
      submitted: false,
      launch,
    };
  }
  const permission = await checkAccessibilityPermission();
  if (!permission.granted) {
    return {
      ok: false,
      launched: true,
      injected: false,
      verified: false,
      submitted: false,
      launch,
      ...permission,
    };
  }
  const titleNeedle = windowTitleNeedle
    || (Array.isArray(openArgs) ? openArgs.find((arg) => String(arg).includes('.cursor-package')) : '')
    || '';
  const basenameNeedle = String(titleNeedle).split('/').filter(Boolean).pop() || titleNeedle;
  const result = await withClipboard(clipboard, prompt, () => (
    injectPromptViaAccessibility(prompt, verifyNeedle, {
      submit,
      retries: 3,
      clipboard,
      windowTitleNeedle: basenameNeedle,
    })
  ));
  return {
    ...result,
    launched: true,
    launch,
    verified: result.verified === true,
    submitted: result.submitted === true,
  };
}

module.exports = {
  ACCESSIBILITY_GUIDANCE,
  checkAccessibilityPermission,
  copiedLooksLikePrompt,
  injectPromptViaAccessibility,
  launchAndInjectCursor,
  launchCursorProcess,
  pickTargetWindowName,
  waitForCursorWindow,
  withClipboard,
};
