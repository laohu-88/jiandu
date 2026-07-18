const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GENERATED_ASSET_ID,
  addHyperframesTitleCard,
  buildTitleCardHtml,
  hyperframesFpsArgument,
  requiredDoctorReport,
} = require('../src/services/hyperframes-service');

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
