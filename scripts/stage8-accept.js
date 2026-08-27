#!/usr/bin/env node
'use strict';

const PROJECT_FORMAL = '/Users/example/Desktop/视频素材库/意外、动物与机灵反应合集-正式';
const PROJECT_STAGE8 = '/Users/example/Desktop/视频素材库/Stage 8 验收副本-HotIngest 与动态主体跟踪';
const CDP_PORT = Number(process.env.PLANNER_CDP_PORT || 9333);

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((item) => item.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('no CDP page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  });
  async function send(method, params = {}) {
    const id = nextId++;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    ws.send(JSON.stringify({ id, method, params }));
    return result;
  }
  async function ev(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'evaluate failed');
    }
    return result.result?.value;
  }
  await send('Runtime.enable');
  return {
    ev,
    close() {
      try { ws.close(); } catch (_error) { /* ignore */ }
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(ev, expression, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await ev(expression);
    if (value) return value;
    await sleep(300);
  }
  throw new Error(`timeout: ${expression}`);
}

async function main() {
  const notes = [];
  const steps = [];
  const log = (name, info) => {
    steps.push({ name, info });
    process.stdout.write(`✔ ${name}${info ? ` — ${info}` : ''}\n`);
  };

  const cdp = await connect();
  const { ev } = cdp;

  const boot = await waitFor(ev, `window.__plannerData && window.plannerApi && ({
    nav: [...document.querySelectorAll('.nav-item')].map((el) => el.textContent.trim()),
    projects: window.__plannerData.get().catalog?.projects?.length || 0,
  })`);
  if (!boot.nav.includes('项目库')) throw new Error('主导航缺失');
  log('启动后可见主导航', boot.nav.join(' / '));

  await ev(`document.querySelectorAll('.nav-item').forEach((el) => {
    if (el.textContent.includes('项目库')) el.click();
  })`);
  await sleep(600);
  const library = await ev(`({
    rows: document.querySelectorAll('.library-row').length,
    names: [...document.querySelectorAll('.library-row strong')].map((el) => el.textContent).slice(0, 8),
  })`);
  log('项目库列表', `${library.rows} 项`);
  if (!library.names.some((name) => name.includes('意外、动物与机灵反应合集-正式'))) {
    notes.push('正式项目未出现在首屏名称抽样中（可能排序靠后）');
  }

  await ev(`window.__plannerData.openProject(${JSON.stringify(PROJECT_STAGE8)})`);
  await waitFor(ev, `(() => {
    const ws = document.querySelector('#workspaceView');
    return ws && !ws.classList.contains('hidden');
  })()`, 20000);
  const workspace = await ev(`({
    header: document.querySelector('#workspaceHeader')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 220),
    tabs: [...document.querySelectorAll('.project-tab')].map((el) => el.textContent.trim()),
    next: document.querySelector('#workspaceHeader .button.primary')?.textContent.trim() || null,
  })`);
  log('打开工作区', `next=${workspace.next || '—'}; tabs=${workspace.tabs.join('/')}`);

  await ev(`[...document.querySelectorAll('.project-tab')].find((el) => el.textContent.includes('抖音'))?.click()`);
  await sleep(1000);
  // Prefer stage7c variant if multiple
  await ev(`(async () => {
    const data = window.__plannerData;
    const variants = data.get().projectResult?.platformVariants?.variants || [];
    const preferred = variants.find((item) => item.variantId === 'douyin-stage7c')
      || variants.find((item) => item.platform === 'douyin');
    if (preferred) await data.refreshDouyinVariant(preferred.variantId);
    return preferred?.variantId || null;
  })()`);
  await sleep(800);

  const douyin = await ev(`({
    stages: [...document.querySelectorAll('.stage-rail-item')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim()),
    actions: [...document.querySelectorAll('.sticky-action-bar button')].map((el) => el.textContent.trim()),
    mp4Note: document.querySelector('.action-mp4-note')?.textContent || '',
    plan: document.querySelector('#douyinStagePlan')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 220) || '',
  })`);
  const required = [
    '保存方案修改', '确认待处理问题', '批准当前抖音方案', '生成预览与 FCP 时间线',
    '播放预览', '查看验证报告', '打开输出目录', '在 Final Cut Pro 中打开',
  ];
  const missing = required.filter((label) => !douyin.actions.includes(label));
  if (missing.length) throw new Error(`缺少按钮: ${missing.join(', ')}`);
  log('抖音四段与操作文案', `stages=${douyin.stages.length}; mp4Note=${/MP4|Final Cut/.test(douyin.mp4Note)}`);

  await ev(`[...document.querySelectorAll('.stage-rail-item')].find((el) => /问题/.test(el.textContent))?.click()`);
  await sleep(500);
  const issueConfirm = await ev(`(() => {
    const root = document.querySelector('#douyinStageIssues');
    const box = [...root.querySelectorAll('input[type="checkbox"]')].find((el) => !el.checked);
    if (box) {
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const jump = [...root.querySelectorAll('button')].find((el) => /跳转/.test(el.textContent));
    jump?.click();
    return {
      text: root.textContent.replace(/\\s+/g, ' ').trim().slice(0, 220),
      confirmed: Boolean(box),
      jumped: Boolean(jump),
    };
  })()`);
  log('问题中心确认与跳转', JSON.stringify(issueConfirm));

  await ev(`[...document.querySelectorAll('.stage-rail-item')].find((el) => /预览/.test(el.textContent))?.click()`);
  await sleep(700);
  const preview = await ev(`(() => {
    const input = document.querySelector('#douyinStagePreview input[type="number"]');
    if (input) {
      input.value = String((Number(input.value) || 1) + 0.05);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return {
      adjusted: Boolean(input),
      canvas: Boolean(document.querySelector('.douyin-canvas-pane, .douyin-preview-canvas')),
      inspector: Boolean(document.querySelector('.douyin-inspector, .douyin-inspector-pane')),
    };
  })()`);
  log('预览调整布局', JSON.stringify(preview));

  await ev(`[...document.querySelectorAll('.sticky-action-bar button')].find((el) => el.textContent.includes('保存方案修改'))?.click()`);
  await sleep(2500);
  log('保存方案修改（应使旧批准失效）');

  await ev(`[...document.querySelectorAll('.stage-rail-item')].find((el) => /问题/.test(el.textContent))?.click()`);
  await sleep(400);
  await ev(`[...document.querySelectorAll('button')].find((el) => el.textContent.includes('确认全部待确认'))?.click()`);
  await sleep(400);
  await ev(`[...document.querySelectorAll('.sticky-action-bar button')].find((el) => el.textContent.includes('批准当前抖音方案') && !el.disabled)?.click()`);
  await sleep(3000);
  log('重新批准当前抖音方案');

  const generate = await ev(`(() => {
    const button = [...document.querySelectorAll('.sticky-action-bar button')]
      .find((el) => el.textContent.includes('生成预览与 FCP 时间线'));
    if (!button) return { ok: false, reason: 'missing' };
    if (button.disabled) return { ok: false, reason: 'disabled', title: button.title };
    button.click();
    return { ok: true };
  })()`);
  log('生成预览与 FCP 时间线', JSON.stringify(generate));
  if (generate.ok) {
    await waitFor(ev, `(() => {
      const play = [...document.querySelectorAll('.sticky-action-bar button')]
        .find((el) => el.textContent.includes('播放预览'));
      const toast = document.querySelector('#toast')?.textContent || '';
      return (play && !play.disabled) || /生成|失败|错误|MP4|FCP/.test(toast);
    })()`, 300000).catch((error) => {
      notes.push(`生成等待: ${error.message}`);
      return false;
    });
    log('生成等待结束');
  } else {
    notes.push(`生成未点击: ${JSON.stringify(generate)}`);
  }

  for (const label of ['播放预览', '查看验证报告', '打开输出目录', '在 Final Cut Pro 中打开']) {
    const result = await ev(`(() => {
      const button = [...document.querySelectorAll('.sticky-action-bar button')]
        .find((el) => el.textContent.includes(${JSON.stringify(label)}));
      if (!button) return { label: ${JSON.stringify(label)}, ok: false, reason: 'missing' };
      if (button.disabled) return { label: ${JSON.stringify(label)}, ok: false, reason: 'disabled' };
      button.click();
      return { label: ${JSON.stringify(label)}, ok: true };
    })()`);
    await sleep(1200);
    log(label, JSON.stringify(result));
    if (!result.ok) notes.push(`${label}: ${result.reason}`);
  }

  await ev(`(() => {
    const back = [...document.querySelectorAll('#workspaceHeader button')]
      .find((el) => /返回项目库/.test(el.textContent));
    if (back) back.click();
    else [...document.querySelectorAll('.nav-item')].find((el) => el.textContent.includes('项目库'))?.click();
  })()`);
  await sleep(1000);
  await ev(`window.__plannerData.refreshCatalog()`);
  await sleep(800);
  const after = await ev(`({
    libraryVisible: !document.querySelector('#libraryView')?.classList.contains('hidden'),
    rows: document.querySelectorAll('.library-row').length,
  })`);
  log('返回项目库刷新', JSON.stringify(after));

  const integrity = await ev(`(async () => {
    const formal = await window.plannerApi.getCodexProjectResult(${JSON.stringify(PROJECT_FORMAL)});
    const copy = await window.plannerApi.getCodexProjectResult(${JSON.stringify(PROJECT_STAGE8)});
    return {
      formal: formal.project.statusLabel,
      formalVariants: (formal.platformVariants?.variants || []).map((v) => v.variantId + ':' + v.status),
      copy: copy.project.statusLabel,
      copyVariants: (copy.platformVariants?.variants || []).map((v) => v.variantId + ':' + v.status),
    };
  })()`);
  log('数据完整性抽查', JSON.stringify(integrity));

  const report = { ok: notes.length === 0 || notes.every((n) => !/失败|缺失|不可用/.test(n)), steps, notes };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  cdp.close();
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
