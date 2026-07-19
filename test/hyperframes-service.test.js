const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GENERATED_ASSET_ID,
  addHyperframesAsset,
  addHyperframesTitleCard,
  buildProcessFlowHtml,
  buildTitleCardHtml,
  hyperframesFpsArgument,
  requiredDoctorReport,
} = require('../src/services/hyperframes-service');
const { hyperframesOutputFilename } = require('../src/services/codex-video-service');

test('HyperFrames 标题卡 HTML 使用分析文本、生产规格并转义不可信字符', () => {
  const html = buildTitleCardHtml({
    title: '标题 <script>alert("x")</script>',
    subtitle: '主题 & 结果',
    width: 1920,
    height: 1080,
    fps: 30,
    durationSec: 2,
    quality: 'standard',
  });
  assert.match(html, /data-composition-id="main"/);
  assert.match(html, /data-no-timeline/);
  assert.match(html, /data-width="1920"/);
  assert.match(html, /data-height="1080"/);
  assert.match(html, /data-duration="2"/);
  assert.match(html, /标题 &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /主题 &amp; 结果/);
  assert.doesNotMatch(html, /<script>alert/);
});

test('HyperFrames 流程动画保存明确节点并注册可寻址 GSAP 时间线', () => {
  const html = buildProcessFlowHtml({
    flow: {
      nodes: [
        'Draw Things',
        '加载 Z Image Turbo',
        '本地生成',
        '切换到 Comfy Desktop',
        '使用同一模型生成结果',
      ],
      heading: '本地实测流程',
      closing: '同一模型 · 两个本地工具',
      reason: '在两段真实素材之间补充流程关系。',
      insertAfterShotId: 'shot-006',
    },
    width: 1920,
    height: 1080,
    fps: 30,
    durationSec: 5,
    quality: 'standard',
  });
  assert.match(html, /gsap@3\.14\.2/);
  assert.match(html, /window\.__timelines\["main"\] = tl/);
  assert.match(html, /加载 Z Image Turbo/);
  assert.match(html, /切换到 Comfy Desktop/);
  assert.match(html, /使用同一模型生成结果/);
  assert.doesNotMatch(html, /data-no-timeline/);
});

test('HyperFrames 产品流程演示使用真实视觉素材且不显示额外主题标题', () => {
  const html = buildProcessFlowHtml({
    flow: {
      nodes: ['Draw Things', 'Z Image Turbo', '本地生成', 'Comfy Desktop', '同模型结果'],
      heading: '不应显示的概括标题',
      reason: '用真实界面与结果解释双工具流程。',
      insertAfterShotId: 'shot-006',
      visuals: {
        drawInterface: 'draw-interface-id',
        drawResult: 'draw-result-id',
        comfyInterface: 'comfy-interface-id',
        comfyResult: 'comfy-result-id',
      },
    },
    visualPaths: {
      drawInterface: 'assets/draw-interface.png',
      drawResult: 'assets/draw-result.png',
      comfyInterface: 'assets/comfy-interface.png',
      comfyResult: 'assets/comfy-result.png',
    },
    width: 1920,
    height: 1080,
    fps: 30,
    durationSec: 5,
    quality: 'standard',
  });
  assert.match(html, /src="assets\/draw-interface\.png"/);
  assert.match(html, /src="assets\/comfy-result\.png"/);
  assert.match(html, /Draw Things/);
  assert.match(html, /Comfy Desktop/);
  assert.match(html, /Z Image Turbo/);
  assert.doesNotMatch(html, /不应显示的概括标题/);
  assert.doesNotMatch(html, /class="node/);
});

test('HyperFrames 产品流程文件名包含输入指纹，避免 FCP 复用同名旧动画', () => {
  const analysis = { titles: { recommended: '同一个标题' } };
  const flow = {
    nodes: ['Draw Things', 'Z Image Turbo', 'Comfy Desktop'],
    reason: '解释共同模型关系。',
    insertAfterShotId: 'shot-006',
  };
  const first = hyperframesOutputFilename(analysis, flow, {
    drawInterface: { sha256: 'a'.repeat(64) },
  }, '项目 A');
  const second = hyperframesOutputFilename(analysis, flow, {
    drawInterface: { sha256: 'b'.repeat(64) },
  }, '项目 A');
  const otherProject = hyperframesOutputFilename(analysis, flow, {
    drawInterface: { sha256: 'a'.repeat(64) },
  }, '项目 B');
  assert.match(first, /^HyperFrames-流程解释-同一个标题-[0-9a-f]{10}\.mp4$/);
  assert.notEqual(first, second);
  assert.notEqual(first, otherProject);
});

test('HyperFrames 渲染参数把 NTSC 小数帧率转换为 CLI 支持的有理数', () => {
  assert.equal(hyperframesFpsArgument(23.976), '24000/1001');
  assert.equal(hyperframesFpsArgument(29.97), '30000/1001');
  assert.equal(hyperframesFpsArgument(59.94), '60000/1001');
  assert.equal(hyperframesFpsArgument(30), '30');
  assert.equal(hyperframesFpsArgument(29.5), '59/2');
});

test('HyperFrames doctor 只用本地渲染必需项判定，不因 Docker/TTS 缺失误报', () => {
  const report = requiredDoctorReport({
    checks: [
      { name: 'Node.js', ok: true, detail: 'v22' },
      { name: 'FFmpeg', ok: true, detail: '8.1' },
      { name: 'FFprobe', ok: true, detail: '8.1' },
      { name: 'Chrome', ok: true, detail: 'system' },
      { name: 'Docker', ok: false, detail: 'Not found' },
      { name: 'TTS (Kokoro)', ok: false, detail: 'Not installed' },
    ],
  });
  assert.equal(report.available, true);
  assert.deepEqual(report.missing, []);
  assert.equal(report.optionalWarnings.length, 2);
});

test('HyperFrames 独立片头加入有效时间线并整体平移原 marker', () => {
  const analysis = {
    titles: { recommended: '建议标题' },
    assets: [{ assetId: 'source', type: 'video' }],
    timeline: {
      shots: [{
        id: 'source-shot', assetId: 'source', inSec: 0, outSec: 1,
        durationSec: 1, fitMode: 'contain', audioMode: 'mute',
      }],
      markers: [{ timeSec: 0.25, text: '原 marker' }],
    },
  };
  const effective = addHyperframesTitleCard(analysis, {
    assetId: GENERATED_ASSET_ID,
    metadata: { durationSec: 1.5 },
  }, 1.5);
  assert.equal(effective.timeline.shots.length, 2);
  assert.equal(effective.timeline.shots[0].assetId, GENERATED_ASSET_ID);
  assert.equal(effective.timeline.shots[0].durationSec, 1.5);
  assert.equal(effective.timeline.markers[0].timeSec, 1.75);
  assert.equal(effective.assets.at(-1).assetId, GENERATED_ASSET_ID);
  assert.equal(analysis.timeline.shots.length, 1);
  assert.equal(analysis.timeline.markers[0].timeSec, 0.25);
});

test('HyperFrames 流程镜头插入指定叙事位置，只移动该位置之后的 marker', () => {
  const analysis = {
    titles: { recommended: '建议标题' },
    assets: [
      { assetId: 'draw', type: 'image' },
      { assetId: 'comfy', type: 'image' },
    ],
    timeline: {
      shots: [
        { id: 'draw-shot', assetId: 'draw', inSec: 0, outSec: 2, durationSec: 2 },
        { id: 'comfy-shot', assetId: 'comfy', inSec: 0, outSec: 2, durationSec: 2 },
      ],
      markers: [
        { timeSec: 1, text: '前段' },
        { timeSec: 2.1, text: '后段' },
      ],
    },
  };
  const flow = {
    nodes: ['Draw Things', '加载模型', '本地生成', 'Comfy Desktop', '同模型结果'],
    reason: '在工具切换处解释关系。',
    insertAfterShotId: 'draw-shot',
  };
  const effective = addHyperframesAsset(analysis, {
    assetId: GENERATED_ASSET_ID,
    metadata: { durationSec: 5 },
  }, 5, { flow });
  assert.deepEqual(
    effective.timeline.shots.map((shot) => shot.assetId),
    ['draw', GENERATED_ASSET_ID, 'comfy'],
  );
  assert.deepEqual(effective.timeline.markers.map((marker) => marker.timeSec), [1, 7.1]);
  assert.equal(effective.assets.at(-1).contentSummary.includes('Draw Things → 加载模型'), true);
});
