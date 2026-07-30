const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const { compileTimeline, getSegmentDuration } = require('../src/services/timeline-engine');

function makeSegment(patch = {}) {
  return {
    id: '01',
    voiceoverText: '第一句[pause:0.3]第二句',
    voiceTrack: {
      type: 'audio',
      clips: [
        { file: '02-配音/01-1.mp3', durationSec: 1.2 },
        { file: '02-配音/01-2.mp3', durationSec: 0.8 },
      ],
    },
    ...patch,
  };
}

test('timeline 是唯一输出，已保存 timeline 和 segment.durationSec 不参与编译', () => {
  const segment = makeSegment({
    durationSec: 999,
    timeline: [{ type: 'pause', startSec: 0, endSec: 999, durationSec: 999 }],
  });
  const timeline = compileTimeline(segment);

  assert.equal(timeline.duration, 2.3);
  assert.equal(timeline.items.some((item) => item.durationSec === 999), false);
  assert.equal(getSegmentDuration({ timeline }), 2.3);
});

test('voiceTrack 的旧派生时间字段不参与时间计算', () => {
  const segment = makeSegment({
    voiceTrack: {
      ...makeSegment().voiceTrack,
      durationSec: 888,
      timeline: [{ type: 'audio', startSec: 0, endSec: 888, durationSec: 888 }],
    },
  });
  const timeline = compileTimeline(segment);

  assert.equal(timeline.duration, 2.3);
  assert.equal(timeline.voiceDuration, 2.3);
});

test('pause DSL 编译为占用时间轴的 pause 项', () => {
  const timeline = compileTimeline(makeSegment());
  const pause = timeline.items.find((item) => item.type === 'pause');

  assert.deepEqual(pause, {
    id: 'pause-002',
    type: 'pause',
    track: 'voice',
    startSec: 1.2,
    endSec: 1.5,
    durationSec: 0.3,
    renderMode: 'freeze_frame',
  });
  assert.deepEqual(timeline.items.map((item) => item.type), ['audio', 'pause', 'audio']);
});

test('删除 segment.durationSec 不影响 getSegmentDuration', () => {
  const segment = makeSegment();
  segment.timeline = compileTimeline(segment);
  delete segment.durationSec;

  assert.equal(getSegmentDuration(segment), 2.3);
});

test('UI 不读取 segment.durationSec 或 status.durationSec', () => {
  const root = path.join(__dirname, '..', 'src', 'renderer');
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'legacy') continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(full);
      }
    }
  }
  const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(source, /segment\.durationSec|status\.durationSec/);
});
