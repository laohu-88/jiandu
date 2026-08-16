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

function runOsascript(source, timeoutMs = 12_000) {
  return execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
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

async function waitForCursorWindow(timeoutMs = 12_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const { stdout } = await runOsascript(`
        const se = Application("System Events");
        const procs = se.processes.whose({ name: "Cursor" });
        procs.length > 0 && procs[0].windows.length > 0;
      `, 4000);
      if (String(stdout).trim() === 'true') return { ok: true };
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
    message: '已启动 Cursor，但未找到可操作窗口。请手动点进 Cursor 后再试一次。',
    lastError: lastError?.message || null,
  };
}

async function injectPromptViaAccessibility(prompt, verifyNeedle) {
  const permission = await checkAccessibilityPermission();
  if (!permission.granted) return permission;
  const windowReady = await waitForCursorWindow();
  if (!windowReady.ok) return windowReady;
  const needle = JSON.stringify(String(verifyNeedle || '').slice(0, 80));
  try {
    const { stdout } = await runOsascript(`
      function run() {
        const se = Application("System Events");
        const procs = se.processes.whose({ name: "Cursor" });
        if (procs.length === 0) return JSON.stringify({ ok: false, code: "CURSOR_WINDOW_NOT_FOUND" });
        const cursor = procs[0];
        cursor.frontmost = true;
        delay(0.6);
        se.keystroke("l", { using: ["command down"] });
        delay(0.45);
        se.keystroke("a", { using: ["command down"] });
        delay(0.08);
        se.keystroke("v", { using: ["command down"] });
        delay(0.5);
        let value = "";
        try {
          const focused = se.uiElements(cursor).whose({ focused: true });
          if (focused.length) value = String(focused[0].value() || "");
        } catch (error) {}
        if (!value) {
          try {
            const areas = cursor.textAreas();
            if (areas.length) value = String(areas[areas.length - 1].value() || "");
          } catch (error) {}
        }
        const needle = ${needle};
        const ok = !needle || value.indexOf(needle) !== -1;
        return JSON.stringify({
          ok: ok,
          injected: true,
          verified: ok,
          preview: value.slice(0, 200),
          code: ok ? null : "PROMPT_INJECT_UNVERIFIED",
        });
      }
    `, 16_000);
    const parsed = JSON.parse(String(stdout || '{}').trim() || '{}');
    if (parsed.ok) {
      return {
        ok: true,
        injected: true,
        verified: parsed.verified === true,
        preview: parsed.preview || '',
      };
    }
    return {
      ok: false,
      injected: parsed.injected === true,
      verified: false,
      code: parsed.code || 'PROMPT_INJECT_FAILED',
      message: parsed.verified === false
        ? '已尝试粘贴提示词，但未能在 Cursor 输入框中验证到任务内容。请检查 Cursor 是否停在可输入 Agent 的界面。'
        : '无法把提示词放入 Cursor 输入框。',
      preview: parsed.preview || '',
      guidance: '请点进 Cursor 的 Agent 输入框后，回到 App 使用「重新打开 Agent」。',
    };
  } catch (error) {
    const permissionAgain = await checkAccessibilityPermission();
    if (!permissionAgain.granted) return permissionAgain;
    return {
      ok: false,
      code: 'PROMPT_INJECT_FAILED',
      message: error.message,
      guidance: '请手动点进 Cursor Agent 输入框，或检查辅助功能权限后重试。',
    };
  }
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
} = {}) {
  const launch = await launchCursorProcess(openArgs);
  if (!inject) {
    return {
      ok: true,
      launched: true,
      injected: false,
      verified: false,
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
      launch,
      ...permission,
    };
  }
  const result = await withClipboard(clipboard, prompt, () => (
    injectPromptViaAccessibility(prompt, verifyNeedle)
  ));
  return {
    ...result,
    launched: true,
    launch,
  };
}

module.exports = {
  ACCESSIBILITY_GUIDANCE,
  checkAccessibilityPermission,
  injectPromptViaAccessibility,
  launchAndInjectCursor,
  launchCursorProcess,
  waitForCursorWindow,
  withClipboard,
};
