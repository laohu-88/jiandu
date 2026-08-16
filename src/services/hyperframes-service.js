const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { hashFile } = require('./pending-media-service');
const { probeMedia, runMediaTool } = require('./media-tool-service');

const execFileAsync = promisify(execFile);
const GENERATED_ASSET_ID = 'generated_hyperframes_asset';
const GENERATED_SHOT_ID = 'generated-hyperframes-shot';
const REQUIRED_DOCTOR_CHECKS = ['Node.js', 'FFmpeg', 'FFprobe', 'Chrome'];
const SUPPORTED_QUALITIES = new Set(['draft', 'standard', 'high']);
const SYSTEM_BROWSER_PATHS = process.platform === 'darwin'
  ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  : [];

function createHyperframesError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function positiveNumber(value, fallback, label) {
  const number = value == null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw createHyperframesError('INVALID_HYPERFRAMES_OPTIONS', `${label} 必须是正数。`);
  }
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw createHyperframesError('INVALID_HYPERFRAMES_OPTIONS', `${label} 必须是正整数。`);
  }
  return number;
}

function normalizeRenderOptions(options = {}) {
  const width = positiveInteger(options.width, 'HyperFrames width');
  const height = positiveInteger(options.height, 'HyperFrames height');
  const fps = positiveNumber(options.fps, 30, 'HyperFrames fps');
  const durationSec = positiveNumber(options.durationSec, 2, 'HyperFrames duration');
  const quality = String(options.quality || 'standard').trim();
  if (!SUPPORTED_QUALITIES.has(quality)) {
    throw createHyperframesError(
      'INVALID_HYPERFRAMES_OPTIONS',
      'HyperFrames quality 必须是 draft、standard 或 high。',
    );
  }
  return {
    width,
    height,
    fps,
    durationSec: Number(durationSec.toFixed(3)),
    quality,
  };
}

function titleFontSize(title, width, height) {
  const length = [...String(title || '')].length;
  const base = Math.min(width, height);
  const ratio = length > 48 ? 0.07 : length > 28 ? 0.085 : 0.105;
  return Math.max(28, Math.min(104, Math.round(base * ratio)));
}

function subtitleFontSize(width, height) {
  return Math.max(18, Math.min(42, Math.round(Math.min(width, height) * 0.038)));
}

function hyperframesFpsArgument(fps) {
  const value = Number(fps);
  if (Math.abs(value - 23.976) < 0.01) return '24000/1001';
  if (Math.abs(value - 29.97) < 0.01) return '30000/1001';
  if (Math.abs(value - 59.94) < 0.01) return '60000/1001';
  if (Number.isInteger(value)) return String(value);
  const denominator = 1000;
  const numerator = Math.round(value * denominator);
  const gcd = (left, right) => (right ? gcd(right, left % right) : Math.abs(left) || 1);
  const divisor = gcd(numerator, denominator);
  return `${numerator / divisor}/${denominator / divisor}`;
}

function buildTitleCardHtml(options) {
  const format = normalizeRenderOptions(options);
  const title = String(options.title || '').trim();
  const subtitle = String(options.subtitle || '').trim();
  if (!title) {
    throw createHyperframesError('INVALID_HYPERFRAMES_OPTIONS', 'HyperFrames 标题不能为空。');
  }
  const titleSize = titleFontSize(title, format.width, format.height);
  const subtitleSize = subtitleFontSize(format.width, format.height);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${format.width}, height=${format.height}" />
    <style>
      * { box-sizing: border-box; }
      html, body {
        width: ${format.width}px;
        height: ${format.height}px;
        margin: 0;
        overflow: hidden;
      }
      body {
        background: #07111f;
        color: #f8fafc;
        font-family: sans-serif;
      }
      #root {
        position: relative;
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        isolation: isolate;
      }
      #grid {
        position: absolute;
        inset: 0;
        background-image:
          linear-gradient(rgba(148, 163, 184, 0.08) 1px, transparent 1px),
          linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px);
        background-size: 8vw 8vw;
        mask-image: linear-gradient(to bottom, rgba(0,0,0,.85), transparent);
      }
      #glow {
        position: absolute;
        width: 72vmin;
        height: 72vmin;
        border-radius: 50%;
        background: #2563eb;
        filter: blur(20vmin);
        opacity: .48;
      }
      #card {
        position: relative;
        width: min(86%, 1400px);
        padding: clamp(28px, 5vmin, 76px);
        border: 1px solid rgba(255,255,255,.24);
        border-radius: clamp(22px, 3vmin, 48px);
        background: rgba(15, 23, 42, .82);
        box-shadow: 0 5vmin 14vmin rgba(2, 6, 23, .5);
      }
      #eyebrow {
        color: #93c5fd;
        font-size: ${Math.max(14, Math.round(subtitleSize * 0.72))}px;
        font-weight: 700;
        letter-spacing: .18em;
      }
      h1 {
        margin: .3em 0 .22em;
        max-width: 100%;
        color: #f8fafc;
        font-size: ${titleSize}px;
        line-height: 1.08;
        letter-spacing: -.035em;
        text-wrap: balance;
        overflow-wrap: anywhere;
      }
      p {
        display: -webkit-box;
        margin: 0;
        color: #cbd5e1;
        font-size: ${subtitleSize}px;
        line-height: 1.45;
        overflow: hidden;
        overflow-wrap: anywhere;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
      }
      #accent {
        width: clamp(54px, 9vw, 160px);
        height: clamp(5px, .7vmin, 10px);
        margin-top: clamp(22px, 4vmin, 56px);
        border-radius: 999px;
        background: linear-gradient(90deg, #60a5fa, #22d3ee);
      }
    </style>
  </head>
  <body>
    <main id="root" data-composition-id="main" data-no-timeline data-start="0"
      data-duration="${format.durationSec}" data-width="${format.width}"
      data-height="${format.height}" data-fps="${format.fps}">
      <div id="grid" class="clip" data-start="0" data-duration="${format.durationSec}" data-track-index="0"></div>
      <div id="glow" class="clip" data-start="0" data-duration="${format.durationSec}" data-track-index="1"></div>
      <section id="card" class="clip" data-start="0" data-duration="${format.durationSec}" data-track-index="2">
        <div id="eyebrow">VIDEO CUT PLANNER · HYPERFRAMES</div>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(subtitle)}</p>
        <div id="accent"></div>
      </section>
    </main>
  </body>
</html>
`;
}

function normalizeFlowSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createHyperframesError('INVALID_HYPERFRAMES_FLOW', 'HyperFrames 流程输入必须是 JSON 对象。');
  }
  const nodes = Array.isArray(value.nodes)
    ? value.nodes.map((node) => String(node?.label ?? node ?? '').trim())
    : [];
  if (nodes.length < 3 || nodes.length > 6 || nodes.some((label) => !label || [...label].length > 32)) {
    throw createHyperframesError(
      'INVALID_HYPERFRAMES_FLOW',
      'HyperFrames 流程必须包含 3 到 6 个非空节点，每个节点最多 32 个字符。',
    );
  }
  const reason = String(value.reason || '').trim();
  if (!reason || [...reason].length > 240) {
    throw createHyperframesError('INVALID_HYPERFRAMES_FLOW', 'HyperFrames 生成原因必须为 1 到 240 个字符。');
  }
  const insertAfterShotId = String(value.insertAfterShotId || '').trim();
  if (!insertAfterShotId || [...insertAfterShotId].length > 80) {
    throw createHyperframesError('INVALID_HYPERFRAMES_FLOW', 'HyperFrames 流程必须指定有效的 insertAfterShotId。');
  }
  const heading = String(value.heading || '本地实测流程').trim();
  const closing = String(value.closing || '').trim();
  if (!heading || [...heading].length > 40 || [...closing].length > 48) {
    throw createHyperframesError('INVALID_HYPERFRAMES_FLOW', 'HyperFrames 流程标题或收束文案过长。');
  }
  const visualKeys = ['drawInterface', 'drawResult', 'comfyInterface', 'comfyResult'];
  const visualStyle = String(value.visualStyle || 'product-flow').trim();
  if (!['product-flow', 'evidence-montage'].includes(visualStyle)) {
    throw createHyperframesError('INVALID_HYPERFRAMES_FLOW', 'HyperFrames visualStyle 无效。');
  }
  let visuals = null;
  if (value.visuals != null) {
    if (typeof value.visuals !== 'object' || Array.isArray(value.visuals)) {
      throw createHyperframesError('INVALID_HYPERFRAMES_FLOW', 'HyperFrames visuals 必须是对象。');
    }
    visuals = Object.fromEntries(visualKeys.map((key) => [key, String(value.visuals[key] || '').trim()]));
    if (Object.values(visuals).some((assetId) => !assetId || [...assetId].length > 100)) {
      throw createHyperframesError(
        'INVALID_HYPERFRAMES_FLOW',
        '产品流程演示必须提供 Draw Things 与 Comfy Desktop 的界面和结果素材 ID。',
      );
    }
  }
  return {
    schemaVersion: 1,
    kind: 'process-flow',
    heading,
    nodes,
    closing,
    reason,
    insertAfterShotId,
    visualStyle,
    visuals,
  };
}

function buildProcessFlowHtml(options) {
  const format = normalizeRenderOptions(options);
  const flow = normalizeFlowSpec(options.flow);
  if (options.visualPaths) {
    if (flow.visualStyle === 'evidence-montage') {
      return buildEvidenceMontageHtml({ format, flow, visualPaths: options.visualPaths });
    }
    return buildProductFlowHtml({ format, flow, visualPaths: options.visualPaths });
  }
  const nodes = flow.nodes.map((label, index) => `
        <article id="node-${index}" class="node ${index < 3 ? 'draw' : 'comfy'}">
          <span class="step">${String(index + 1).padStart(2, '0')}</span>
          <strong>${escapeHtml(label)}</strong>
        </article>`).join('');
  const arrows = flow.nodes.slice(1).map((_, index) => `
        <div id="arrow-${index}" class="arrow" aria-hidden="true">→</div>`).join('');
  const sequence = [];
  for (let index = 0; index < flow.nodes.length; index += 1) {
    sequence.push(nodes.match(new RegExp(`<article id="node-${index}"[\\s\\S]*?<\\/article>`))?.[0] || '');
    if (index < flow.nodes.length - 1) sequence.push(arrows.match(new RegExp(`<div id="arrow-${index}"[\\s\\S]*?<\\/div>`))?.[0] || '');
  }
  const step = Math.max(0.55, (format.durationSec - 1.15) / flow.nodes.length);
  const timeline = flow.nodes.map((_, index) => {
    const at = Number((0.28 + index * step).toFixed(3));
    const arrowAt = Number((at + Math.min(0.42, step * 0.58)).toFixed(3));
    return `
      tl.fromTo("#node-${index}", { opacity: 0, y: 28, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.34 }, ${at});${index < flow.nodes.length - 1 ? `
      tl.fromTo("#arrow-${index}", { opacity: 0, x: -12 }, { opacity: 1, x: 0, duration: 0.24 }, ${arrowAt});` : ''}`;
  }).join('');
  const closingAt = Math.max(0.4, Number((format.durationSec - 0.72).toFixed(3)));
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${format.width}, height=${format.height}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      @font-face { font-family: "Project CJK"; src: local("PingFang SC"); }
      * { box-sizing: border-box; }
      html, body { width: ${format.width}px; height: ${format.height}px; margin: 0; overflow: hidden; }
      body { background: #0b0d12; color: #f7f7f5; font-family: "Project CJK", sans-serif; }
      #root { position: relative; width: 100%; height: 100%; }
      #stage { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; padding: 110px 118px 96px; }
      #header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 72px; }
      #header h1 { margin: 0; font-size: 50px; line-height: 1; letter-spacing: -.025em; font-weight: 650; }
      #header span { color: #9ca3af; font: 500 22px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; }
      #flow { display: grid; grid-template-columns: repeat(${flow.nodes.length * 2 - 1}, auto); align-items: center; justify-content: space-between; }
      .node { width: 268px; min-height: 184px; padding: 28px 28px 30px; border: 1px solid #343a46; border-radius: 20px; background: #151922; opacity: 0; }
      .node.draw { border-top: 5px solid #5b8cff; }
      .node.comfy { border-top: 5px solid #d4a72c; }
      .step { display: block; margin-bottom: 30px; color: #8b93a1; font: 600 18px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
      .node strong { display: block; font-size: 31px; line-height: 1.23; letter-spacing: -.018em; font-weight: 620; overflow-wrap: anywhere; }
      .arrow { width: 48px; color: #697180; font-size: 38px; line-height: 1; text-align: center; opacity: 0; }
      #closing { margin-top: 64px; color: #b9c0ca; font-size: 25px; line-height: 1.3; letter-spacing: .015em; opacity: 0; }
    </style>
  </head>
  <body>
    <main id="root" data-composition-id="main" data-start="0"
      data-duration="${format.durationSec}" data-width="${format.width}"
      data-height="${format.height}" data-fps="${format.fps}">
      <section id="stage" class="clip" data-start="0" data-duration="${format.durationSec}" data-track-index="0">
        <header id="header"><h1>${escapeHtml(flow.heading)}</h1><span>DRAW THINGS / COMFY DESKTOP</span></header>
        <div id="flow">${sequence.join('')}</div>
        <p id="closing">${escapeHtml(flow.closing)}</p>
      </section>
    </main>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#header", { opacity: 0, y: -14 }, { opacity: 1, y: 0, duration: 0.32 }, 0.06);${timeline}
      tl.fromTo("#closing", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.3 }, ${closingAt});
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}

function buildEvidenceMontageHtml({ format, flow, visualPaths }) {
  const required = ['drawInterface', 'drawResult', 'comfyInterface', 'comfyResult'];
  if (required.some((key) => !visualPaths?.[key])) {
    throw createHyperframesError('INVALID_HYPERFRAMES_FLOW', '证据蒙太奇缺少已复制的视觉素材。');
  }
  const src = (key) => escapeHtml(visualPaths[key]);
  const labels = [flow.nodes[1] || 'Codex', flow.nodes[2] || 'DeepSeek', flow.nodes[3] || 'Cursor'];
  const evidenceKeys = ['drawResult', 'comfyInterface', 'comfyResult'];
  const lanes = evidenceKeys.map((key, index) => `
        <article id="lane-${index}" class="lane">
          <img src="${src(key)}" alt="" />
          <div class="label"><span>${String(index + 1).padStart(2, '0')}</span>${escapeHtml(labels[index])}</div>
        </article>`).join('');
  const stageEnd = Math.max(5.4, format.durationSec - 0.4);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${format.width}, height=${format.height}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      @font-face { font-family: "Project CJK"; src: local("PingFang SC"); }
      * { box-sizing: border-box; }
      html, body { width: ${format.width}px; height: ${format.height}px; margin: 0; overflow: hidden; }
      body { background: #05070a; color: #f4f7fb; font-family: "Project CJK", sans-serif; }
      #root, #stage { position: relative; width: 100%; height: 100%; overflow: hidden; }
      #stage { background: #05070a; }
      #overview, #grid { position: absolute; inset: 0; overflow: hidden; }
      #overview { z-index: 2; background: #05070a; }
      #overview img { width: 100%; height: 100%; object-fit: contain; transform-origin: 50% 38%; }
      #overview::after { content: ""; position: absolute; inset: 0; background: radial-gradient(circle at 50% 42%, transparent 38%, rgba(5,7,10,.54) 100%); }
      #grid { z-index: 3; display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; padding: 0 5px; opacity: 0; }
      .lane { position: relative; min-width: 0; overflow: hidden; background: #0d1117; clip-path: inset(0 50% 0 50%); }
      .lane img { width: 100%; height: 100%; display: block; object-fit: cover; object-position: 50% 50%; filter: saturate(.88) contrast(1.04); transform: scale(1.04); }
      .lane::after { content: ""; position: absolute; inset: 0; box-shadow: inset 0 0 0 1px rgba(255,255,255,.1); pointer-events: none; }
      .label { position: absolute; left: 30px; bottom: 28px; display: flex; align-items: center; gap: 14px; color: #f7f9fc; font-size: 26px; font-weight: 650; letter-spacing: -.01em; text-shadow: 0 3px 18px rgba(0,0,0,.9); opacity: 0; }
      .label span { color: #8b96a7; font: 600 16px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; }
      #scan { position: absolute; z-index: 5; top: 0; bottom: 0; left: -18%; width: 14%; opacity: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,.16), transparent); mix-blend-mode: screen; transform: skewX(-12deg); }
      #closing { position: absolute; z-index: 6; left: 50%; top: 42px; transform: translateX(-50%); margin: 0; white-space: nowrap; color: #fff; font-size: 30px; font-weight: 620; letter-spacing: .015em; text-shadow: 0 5px 24px rgba(0,0,0,.95); opacity: 0; }
    </style>
  </head>
  <body>
    <main id="root" data-composition-id="main" data-start="0"
      data-duration="${format.durationSec}" data-width="${format.width}"
      data-height="${format.height}" data-fps="${format.fps}">
      <section id="stage" class="clip" data-start="0" data-duration="${format.durationSec}" data-track-index="0">
        <div id="overview"><img src="${src('drawInterface')}" alt="" /></div>
        <div id="grid">${lanes}</div>
        <div id="scan"></div>
        <p id="closing">${escapeHtml(flow.closing || '同题开发 · 实机核验 · 结果可追溯')}</p>
      </section>
    </main>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#overview img", { scale: 1.12, y: 32 }, { scale: 1, y: 0, duration: 1.25, ease: "power2.out" }, 0.02);
      tl.to("#overview", { opacity: 0, scale: 1.04, duration: 0.46, ease: "power2.inOut" }, 1.16);
      tl.set("#grid", { opacity: 1 }, 1.3);
      tl.to("#lane-0", { clipPath: "inset(0 0% 0 0%)", duration: 0.58, ease: "power3.out" }, 1.3);
      tl.to("#lane-0 img", { scale: 1, duration: 1.1, ease: "power2.out" }, 1.3);
      tl.to("#lane-1", { clipPath: "inset(0 0% 0 0%)", duration: 0.58, ease: "power3.out" }, 2.14);
      tl.to("#lane-1 img", { scale: 1, duration: 1.1, ease: "power2.out" }, 2.14);
      tl.to("#lane-2", { clipPath: "inset(0 0% 0 0%)", duration: 0.58, ease: "power3.out" }, 2.98);
      tl.to("#lane-2 img", { scale: 1, duration: 1.1, ease: "power2.out" }, 2.98);
      tl.to(".label", { opacity: 1, y: -8, duration: 0.36, stagger: 0.12, ease: "power2.out" }, 3.58);
      tl.fromTo("#scan", { opacity: 0, x: 0 }, { opacity: 1, x: ${format.width * 1.35}, duration: 1.15, ease: "power1.inOut" }, 4.05);
      tl.to("#scan", { opacity: 0, duration: 0.2 }, 5.22);
      tl.fromTo("#closing", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.42, ease: "power2.out" }, 5.12);
      tl.to("#grid", { scale: 1.012, duration: ${Math.max(0.4, stageEnd - 5.1).toFixed(2)}, ease: "none" }, 5.1);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}

function buildProductFlowHtml({ format, flow, visualPaths }) {
  const required = ['drawInterface', 'drawResult', 'comfyInterface', 'comfyResult'];
  if (required.some((key) => !visualPaths?.[key])) {
    throw createHyperframesError('INVALID_HYPERFRAMES_FLOW', '产品流程演示缺少已复制的视觉素材。');
  }
  const src = (key) => escapeHtml(visualPaths[key]);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${format.width}, height=${format.height}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      @font-face { font-family: "Project CJK"; src: local("PingFang SC"); }
      * { box-sizing: border-box; }
      html, body { width: ${format.width}px; height: ${format.height}px; margin: 0; overflow: hidden; }
      body { background: #0a0c10; color: #f6f7f8; font-family: "Project CJK", sans-serif; }
      #root, #stage { position: relative; width: 100%; height: 100%; overflow: hidden; }
      #stage { background: #0a0c10; }
      .app-card {
        position: absolute; left: 535px; top: 166px; width: 850px; height: 600px;
        overflow: hidden; border: 1px solid #343942; border-radius: 24px;
        background: #11151b; box-shadow: 0 34px 80px rgba(0,0,0,.38); opacity: 0;
        transform-origin: 50% 50%; z-index: 3;
      }
      .app-bar { height: 66px; display: flex; align-items: center; gap: 13px; padding: 0 24px; border-bottom: 1px solid #303640; background: #171b22; }
      .app-bar strong { font-size: 25px; line-height: 1; font-weight: 620; letter-spacing: -.01em; }
      .app-dot { width: 13px; height: 13px; border-radius: 50%; flex: 0 0 auto; }
      #draw-card .app-dot { background: #ff6b58; }
      #comfy-card .app-dot { background: #d6e838; }
      .screen { position: relative; width: 100%; height: 534px; overflow: hidden; background: #080a0d; }
      .interface { width: 100%; height: 100%; display: block; object-fit: contain; transform-origin: 50% 50%; }
      .result-card {
        position: absolute; right: 28px; bottom: 28px; width: 306px; height: 236px;
        overflow: hidden; border: 1px solid rgba(255,255,255,.44); border-radius: 16px;
        background: #101319; box-shadow: 0 18px 46px rgba(0,0,0,.5); opacity: 0;
      }
      .result-card img { width: 100%; height: 100%; display: block; object-fit: cover; }
      .result-card span {
        position: absolute; left: 13px; bottom: 12px; padding: 7px 11px;
        border-radius: 999px; background: rgba(8,10,14,.78); color: #f5f6f7;
        font-size: 17px; line-height: 1; letter-spacing: .01em;
      }
      #model-hub {
        position: absolute; left: 850px; top: 443px; width: 220px; height: 72px;
        display: grid; place-items: center; border: 1px solid #555d69; border-radius: 18px;
        background: #151a21; box-shadow: 0 16px 42px rgba(0,0,0,.42); opacity: 0; z-index: 5;
      }
      #model-hub strong { font-size: 24px; line-height: 1; font-weight: 650; letter-spacing: -.015em; }
      #model-hub::before, #model-hub::after { content: ""; position: absolute; top: 29px; width: 12px; height: 12px; border-radius: 50%; }
      #model-hub::before { left: -6px; background: #5b8cff; }
      #model-hub::after { right: -6px; background: #d4a72c; }
      .model-line { position: absolute; top: 478px; height: 2px; width: 0; background: #59616d; opacity: 0; z-index: 2; }
      #line-left { right: 1070px; }
      #line-right { left: 1070px; }
      .model-pulse { position: absolute; top: 474px; width: 10px; height: 10px; border-radius: 50%; background: #c9d0d9; opacity: 0; z-index: 4; }
      #pulse-left { left: 842px; }
      #pulse-right { left: 1068px; }
    </style>
  </head>
  <body>
    <main id="root" data-composition-id="main" data-start="0"
      data-duration="${format.durationSec}" data-width="${format.width}"
      data-height="${format.height}" data-fps="${format.fps}">
      <section id="stage" class="clip" data-start="0" data-duration="${format.durationSec}" data-track-index="0">
        <div id="line-left" class="model-line"></div>
        <div id="line-right" class="model-line"></div>
        <div id="pulse-left" class="model-pulse"></div>
        <div id="pulse-right" class="model-pulse"></div>
        <div id="model-hub"><strong>Z Image Turbo</strong></div>
        <article id="draw-card" class="app-card">
          <header class="app-bar"><span class="app-dot"></span><strong>Draw Things</strong></header>
          <div class="screen">
            <img id="draw-interface" class="interface" src="${src('drawInterface')}" alt="" />
            <div id="draw-result" class="result-card"><img src="${src('drawResult')}" alt="" /><span>本地结果</span></div>
          </div>
        </article>
        <article id="comfy-card" class="app-card">
          <header class="app-bar"><span class="app-dot"></span><strong>Comfy Desktop</strong></header>
          <div class="screen">
            <img id="comfy-interface" class="interface" src="${src('comfyInterface')}" alt="" />
            <div id="comfy-result" class="result-card"><img src="${src('comfyResult')}" alt="" /><span>本地结果</span></div>
          </div>
        </article>
      </section>
    </main>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#draw-card", { opacity: 0, y: 28, scale: 0.92 }, { opacity: 1, y: 0, scale: 0.96, duration: 0.42 }, 0.06);
      tl.fromTo("#draw-interface", { scale: 1.035 }, { scale: 1, duration: 1.35 }, 0.06);
      tl.fromTo("#draw-result", { opacity: 0, y: 20, scale: 0.8 }, { opacity: 1, y: 0, scale: 1, duration: 0.42 }, 0.78);
      tl.to("#draw-card", { x: -420, scale: 0.78, duration: 0.62 }, 1.38);
      tl.fromTo("#model-hub", { opacity: 0, x: -170, scale: 0.72 }, { opacity: 1, x: 0, scale: 1, duration: 0.5 }, 1.5);
      tl.fromTo("#line-left", { opacity: 0, width: 0 }, { opacity: 1, width: 120, duration: 0.38 }, 1.82);
      tl.fromTo("#pulse-left", { opacity: 0, x: 0 }, { opacity: 1, x: -110, duration: 0.42 }, 1.84);
      tl.fromTo("#comfy-card", { opacity: 0, x: 510, y: 24, scale: 0.74 }, { opacity: 1, x: 420, y: 0, scale: 0.78, duration: 0.6 }, 2.12);
      tl.fromTo("#comfy-interface", { scale: 1.035 }, { scale: 1, duration: 1.3 }, 2.12);
      tl.fromTo("#line-right", { opacity: 0, width: 0 }, { opacity: 1, width: 120, duration: 0.38 }, 2.48);
      tl.fromTo("#pulse-right", { opacity: 0, x: 0 }, { opacity: 1, x: 110, duration: 0.42 }, 2.5);
      tl.fromTo("#comfy-result", { opacity: 0, y: 20, scale: 0.8 }, { opacity: 1, y: 0, scale: 1, duration: 0.44 }, 3.08);
      tl.to("#draw-card", { scale: 0.8, duration: 0.5 }, 3.86);
      tl.to("#comfy-card", { scale: 0.8, duration: 0.5 }, 3.86);
      tl.to("#model-hub", { scale: 1.035, duration: 0.26 }, 4.02);
      tl.to("#model-hub", { scale: 1, duration: 0.24 }, 4.28);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}

async function executableFile(candidate) {
  if (!candidate) return null;
  try {
    await fs.access(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

async function resolveHyperframesExecutable(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(path.resolve(String(explicitPath)));
  if (process.env.HYPERFRAMES_BIN) candidates.push(path.resolve(process.env.HYPERFRAMES_BIN));
  candidates.push(path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'hyperframes'));
  for (const directory of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.resolve(directory, process.platform === 'win32' ? 'hyperframes.cmd' : 'hyperframes'));
  }
  for (const candidate of new Set(candidates)) {
    if (await executableFile(candidate)) return candidate;
  }
  return null;
}

async function resolveBrowserPath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.HYPERFRAMES_BROWSER_PATH,
    ...SYSTEM_BROWSER_PATHS,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await executableFile(candidate)) return candidate;
  }
  return null;
}

function formatCommand(executable, args) {
  return [executable, ...args.map((value) => JSON.stringify(String(value)))].join(' ');
}

async function runHyperframesCommand(executable, args, options = {}) {
  const env = {
    ...process.env,
    HYPERFRAMES_NO_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    HYPERFRAMES_FONT_CACHE_DIR: options.fontCacheDir
      || path.join(os.tmpdir(), 'video-cut-planner-v3-hyperframes-font-cache'),
  };
  const browserPath = await resolveBrowserPath(options.browserPath);
  if (browserPath) env.HYPERFRAMES_BROWSER_PATH = browserPath;
  try {
    const result = await execFileAsync(executable, args, {
      cwd: options.cwd,
      env,
      timeout: options.timeoutMs || 30 * 60 * 1000,
      maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    });
    return {
      command: formatCommand(executable, args),
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      browserPath,
    };
  } catch (error) {
    const stderr = String(error.stderr || '').trim();
    throw createHyperframesError(
      'HYPERFRAMES_COMMAND_FAILED',
      stderr.split('\n').filter(Boolean).at(-1) || error.message,
      {
        command: formatCommand(executable, args),
        stderr: error.stderr || error.message,
        stdout: error.stdout || '',
      },
    );
  }
}

function requiredDoctorReport(doctor = {}) {
  const checks = Array.isArray(doctor.checks) ? doctor.checks : [];
  const byName = new Map(checks.map((check) => [check.name, check]));
  const missing = REQUIRED_DOCTOR_CHECKS
    .map((name) => byName.get(name) || { name, ok: false, detail: '未返回检测结果。' })
    .filter((check) => !check.ok);
  const optionalWarnings = checks
    .filter((check) => !check.ok && !REQUIRED_DOCTOR_CHECKS.includes(check.name))
    .map((check) => `${check.name}：${check.detail}`);
  return {
    available: missing.length === 0,
    missing,
    optionalWarnings,
    requiredChecks: REQUIRED_DOCTOR_CHECKS.map((name) => byName.get(name) || {
      name,
      ok: false,
      detail: '未返回检测结果。',
    }),
  };
}

async function inspectHyperframesEnvironment(options = {}) {
  const executable = await resolveHyperframesExecutable(options.executablePath);
  if (!executable) {
    return {
      available: false,
      executable: null,
      version: null,
      requiredChecks: [],
      optionalWarnings: [],
      errors: ['未找到 HyperFrames CLI；请运行 npm install。'],
    };
  }
  const command = await runHyperframesCommand(executable, ['doctor', '--json'], {
    browserPath: options.browserPath,
    timeoutMs: 60_000,
  });
  let doctor;
  try {
    doctor = JSON.parse(command.stdout.trim());
  } catch (error) {
    throw createHyperframesError(
      'INVALID_HYPERFRAMES_DOCTOR_OUTPUT',
      `无法解析 HyperFrames doctor 输出：${error.message}`,
    );
  }
  const required = requiredDoctorReport(doctor);
  return {
    available: required.available,
    executable,
    version: doctor._meta?.version || null,
    requiredChecks: required.requiredChecks,
    optionalWarnings: required.optionalWarnings,
    errors: required.missing.map((check) => `${check.name}：${check.detail}`),
    browserPath: command.browserPath,
    doctorOk: doctor.ok === true,
  };
}

function parseCheckOutput(stdout) {
  try {
    return JSON.parse(String(stdout || '').trim());
  } catch (error) {
    throw createHyperframesError(
      'INVALID_HYPERFRAMES_CHECK_OUTPUT',
      `无法解析 HyperFrames check 输出：${error.message}`,
    );
  }
}

async function materializeFlowVisuals(compositionDirectory, flow, visualSources) {
  if (!flow?.visuals) return { paths: null, records: null };
  const keys = ['drawInterface', 'drawResult', 'comfyInterface', 'comfyResult'];
  const assetsDirectory = path.join(compositionDirectory, 'assets');
  await fs.mkdir(assetsDirectory, { recursive: true });
  const paths = {};
  const records = {};
  for (const key of keys) {
    const source = visualSources?.[key];
    if (!source || source.assetId !== flow.visuals[key] || !source.sourcePath) {
      throw createHyperframesError(
        'INVALID_HYPERFRAMES_FLOW',
        `找不到产品流程演示视觉素材：${key}（${flow.visuals[key]}）。`,
      );
    }
    const extension = path.extname(source.sourcePath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
      throw createHyperframesError('INVALID_HYPERFRAMES_FLOW', `视觉素材格式不受支持：${extension}`);
    }
    const filename = `${key}${extension}`;
    const targetPath = path.join(assetsDirectory, filename);
    await fs.copyFile(source.sourcePath, targetPath);
    const copiedSha256 = await hashFile(targetPath);
    if (source.sha256 && copiedSha256 !== source.sha256) {
      throw createHyperframesError('INVALID_HYPERFRAMES_FLOW', `视觉素材复制校验失败：${key}`);
    }
    paths[key] = `assets/${filename}`;
    records[key] = {
      assetId: source.assetId,
      relativePath: paths[key],
      sha256: copiedSha256,
    };
  }
  return { paths, records };
}

async function renderHyperframesAsset(options) {
  const format = normalizeRenderOptions(options);
  const flow = options.flow ? normalizeFlowSpec(options.flow) : null;
  const compositionDirectory = path.resolve(options.compositionDirectory);
  const outputPath = path.resolve(options.outputPath);
  const existing = await fs.stat(outputPath).catch(() => null);
  if (existing) {
    throw createHyperframesError('HYPERFRAMES_OUTPUT_EXISTS', `HyperFrames 输出已存在：${outputPath}`);
  }
  const environment = options.environment || await inspectHyperframesEnvironment(options);
  if (!environment.available) {
    throw createHyperframesError(
      'HYPERFRAMES_UNAVAILABLE',
      `HyperFrames 本地渲染环境不可用：${environment.errors.join('；')}`,
      { environment },
    );
  }
  await fs.mkdir(compositionDirectory, { recursive: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const visualFiles = await materializeFlowVisuals(
    compositionDirectory,
    flow,
    options.visualSources,
  );
  const htmlPath = path.join(compositionDirectory, 'index.html');
  const inputPath = path.join(compositionDirectory, 'render-input.json');
  const outputRecordPath = path.join(compositionDirectory, 'render-output.json');
  const input = {
    schemaVersion: 1,
    renderer: 'hyperframes',
    rendererVersion: environment.version,
    kind: flow?.kind || 'title-card',
    ...(flow ? { flow } : {
      title: String(options.title || '').trim(),
      subtitle: String(options.subtitle || '').trim(),
    }),
    ...(visualFiles.records ? { visualFiles: visualFiles.records } : {}),
    format,
  };
  await fs.writeFile(
    htmlPath,
    flow
      ? buildProcessFlowHtml({ ...options, flow, visualPaths: visualFiles.paths, ...format })
      : buildTitleCardHtml({ ...options, ...format }),
    'utf8',
  );
  await fs.writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, 'utf8');

  const checkCommand = await runHyperframesCommand(
    environment.executable,
    ['check', compositionDirectory, '--json'],
    {
      browserPath: environment.browserPath || options.browserPath,
      cwd: compositionDirectory,
      timeoutMs: 5 * 60 * 1000,
    },
  );
  const check = parseCheckOutput(checkCommand.stdout);
  if (!check.ok) {
    const findings = [
      ...(check.lint?.findings || []),
      ...(check.runtime?.findings || []),
      ...(check.layout?.findings || []),
      ...(check.contrast?.findings || []),
    ].filter((finding) => finding.severity === 'error');
    throw createHyperframesError(
      'HYPERFRAMES_CHECK_FAILED',
      `HyperFrames check 未通过：${findings[0]?.message || '未知错误'}`,
      { check },
    );
  }

  const tempPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.tmp.mp4`,
  );
  const identityPath = `${tempPath}.identity.mp4`;
  try {
    const renderCommand = await runHyperframesCommand(
      environment.executable,
      [
        'render',
        compositionDirectory,
        '--output', tempPath,
        '--fps', hyperframesFpsArgument(format.fps),
        '--quality', format.quality,
        '--workers', '1',
        '--quiet',
      ],
      {
        browserPath: environment.browserPath || options.browserPath,
        cwd: compositionDirectory,
        timeoutMs: 30 * 60 * 1000,
      },
    );
    let identityCommand = null;
    if (options.mediaIdentity) {
      const mediaIdentity = crypto.createHash('sha256')
        .update(String(options.mediaIdentity))
        .digest('hex');
      identityCommand = await runMediaTool('ffmpeg', [
        '-y',
        '-i', tempPath,
        '-map', '0',
        '-c', 'copy',
        '-metadata', `comment=video-cut-planner:${mediaIdentity}`,
        '-movflags', '+faststart',
        identityPath,
      ]);
      await fs.rename(identityPath, tempPath);
    }
    const metadata = await probeMedia(tempPath);
    const errors = [];
    if (!metadata.hasVideo) errors.push('生成文件没有视频流。');
    if (metadata.displayWidth !== format.width || metadata.displayHeight !== format.height) {
      errors.push(`分辨率不是 ${format.width}×${format.height}。`);
    }
    if (!Number.isFinite(metadata.frameRate) || Math.abs(metadata.frameRate - format.fps) > 0.05) {
      errors.push(`帧率不是 ${format.fps} fps。`);
    }
    if (!Number.isFinite(metadata.durationSec)
      || Math.abs(metadata.durationSec - format.durationSec) > 0.2) {
      errors.push(`时长不是 ${format.durationSec}s。`);
    }
    if (errors.length) {
      throw createHyperframesError(
        'INVALID_HYPERFRAMES_OUTPUT',
        `HyperFrames 独立 MP4 验证失败：${errors[0]}`,
        { errors, metadata },
      );
    }
    const sha256 = await hashFile(tempPath);
    await fs.rename(tempPath, outputPath);
    await fs.writeFile(outputRecordPath, `${JSON.stringify({
      schemaVersion: 1,
      renderer: 'hyperframes',
      rendererVersion: environment.version,
      kind: flow?.kind || 'title-card',
      reason: flow?.reason || '根据既有分析生成可选独立标题素材。',
      outputPath,
      sha256,
      metadata,
      check: { ok: check.ok === true },
      commands: {
        check: checkCommand.command,
        render: renderCommand.command,
        ...(identityCommand ? { identity: identityCommand.command } : {}),
      },
      generatedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    return {
      outputPath,
      compositionDirectory,
      htmlPath,
      inputPath,
      outputRecordPath,
      sha256,
      metadata,
      format,
      environment,
      check,
      commands: {
        check: checkCommand.command,
        render: renderCommand.command,
        ...(identityCommand ? { identity: identityCommand.command } : {}),
      },
    };
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    await fs.rm(identityPath, { force: true }).catch(() => {});
  }
}

function addHyperframesAsset(analysis, mapping, durationSec, options = {}) {
  const duration = positiveNumber(durationSec, mapping.metadata?.durationSec || 2, 'HyperFrames duration');
  const flow = options.flow ? normalizeFlowSpec(options.flow) : null;
  let insertionIndex = 0;
  if (flow) {
    const afterIndex = analysis.timeline.shots.findIndex((shot) => shot.id === flow.insertAfterShotId);
    if (afterIndex < 0) {
      throw createHyperframesError(
        'INVALID_HYPERFRAMES_FLOW',
        `找不到 HyperFrames 插入镜头：${flow.insertAfterShotId}`,
      );
    }
    insertionIndex = afterIndex + 1;
  }
  const insertionTime = analysis.timeline.shots
    .slice(0, insertionIndex)
    .reduce((total, shot) => total + shot.durationSec, 0);
  const generatedAsset = {
    assetId: mapping.assetId,
    type: 'video',
    semanticLabels: flow
      ? ['HyperFrames', '流程解释', '独立生成素材']
      : ['HyperFrames', '独立片头', '建议标题'],
    contentSummary: flow
      ? `HyperFrames 解释流程：${flow.nodes.join(' → ')}`
      : `HyperFrames 根据现有分析生成标题卡：${analysis.titles.recommended}`,
    suggestedUse: [flow ? '两套本地工具之间的流程桥接' : '独立片头素材'],
    status: 'adopt',
    reason: flow?.reason || '作为可单独调整或删除的生成镜头进入 FCPXML。',
    ranges: [{
      startSec: 0,
      endSec: duration,
      confidence: 1,
      reviewRequired: false,
    }],
    confidence: 1,
  };
  const generatedShot = {
    id: GENERATED_SHOT_ID,
    assetId: mapping.assetId,
    inSec: 0,
    outSec: duration,
    durationSec: duration,
    fitMode: 'contain',
    audioMode: 'mute',
    purpose: flow
      ? '用短动画串联 Draw Things 与 Comfy Desktop 的同模型本地生成关系'
      : '用分析建议标题建立主题，并保留为独立可编辑 MP4',
    confidence: 1,
    reviewRequired: false,
  };
  return {
    ...analysis,
    assets: [...analysis.assets, generatedAsset],
    timeline: {
      ...analysis.timeline,
      shots: [
        ...analysis.timeline.shots.slice(0, insertionIndex),
        generatedShot,
        ...analysis.timeline.shots.slice(insertionIndex),
      ],
      markers: analysis.timeline.markers.map((marker) => ({
        ...marker,
        timeSec: Number((marker.timeSec >= insertionTime
          ? marker.timeSec + duration
          : marker.timeSec).toFixed(3)),
      })),
    },
  };
}

function addHyperframesTitleCard(analysis, mapping, durationSec) {
  return addHyperframesAsset(analysis, mapping, durationSec);
}

async function renderHyperframesTitleCard(options) {
  return renderHyperframesAsset(options);
}

module.exports = {
  GENERATED_ASSET_ID,
  GENERATED_SHOT_ID,
  REQUIRED_DOCTOR_CHECKS,
  addHyperframesAsset,
  addHyperframesTitleCard,
  buildProcessFlowHtml,
  buildTitleCardHtml,
  escapeHtml,
  hyperframesFpsArgument,
  inspectHyperframesEnvironment,
  normalizeRenderOptions,
  normalizeFlowSpec,
  materializeFlowVisuals,
  renderHyperframesAsset,
  renderHyperframesTitleCard,
  requiredDoctorReport,
  resolveBrowserPath,
  resolveHyperframesExecutable,
  runHyperframesCommand,
};
