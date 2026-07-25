'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MANAGED_CAPTION_NOTE_PREFIX,
  buildFcpxml,
  fcpTime,
  fcpTimeAligned,
  frameDuration,
  isRationalMultiple,
  parseFcpTimeRational,
  planFrameAlignedTimeline,
  quantizeShotToFrameGrid,
  resolveMediaContentDurationSec,
  validateFcpxmlStructure,
} = require('../src/services/fcpxml-service');
const {
  buildCaptionExportPlan,
  toManagedCaptionTitles,
} = require('../src/services/caption-fcpxml-export-service');

function baseAnalysis(assets, shots, extras = {}) {
  return {
    schemaVersion: 1,
    theme: {
      summary: 'Fix3',
      rationale: 'frame align',
      confidence: 0.9,
      folderNameConflict: false,
    },
    titles: {
      candidates: ['Fix3'],
      recommended: 'Fix3 timeline frame align',
      rationale: 'test',
    },
    assets,
    lightCaptionPlan: extras.lightCaptionPlan || [],
    timeline: {
      orientation: 'vertical',
      width: 1080,
      height: 1920,
      fps: extras.fps || 30,
      shots,
      markers: extras.markers || [],
    },
  };
}

function videoAsset(assetId, durationSec, overrides = {}) {
  return {
    assetId,
    type: 'video',
    status: 'adopt',
    reason: '过程',
    ranges: [{ startSec: 0, endSec: durationSec, confidence: 0.9, reviewRequired: false }],
    confidence: 0.9,
    storyUnitId: 'su-1',
    chapterId: 'ch-1',
    narrativeRole: 'representative',
    audioAnalysis: {
      audioAvailable: true,
      preserveOriginalAudio: true,
      muteReason: null,
      warnings: [],
    },
    videoPreservationPlan: {
      preserveFullClip: overrides.preserveFullClip !== false,
      sourceDuration: durationSec,
      proposedIn: 0,
      proposedOut: durationSec,
      selectedDuration: durationSec,
      keepRatio: 1,
      trimReason: null,
      criticalMoments: [],
      protectedTimeRanges: [],
      warnings: [],
    },
  };
}

function imageAsset(assetId) {
  return {
    assetId,
    type: 'image',
    status: 'adopt',
    reason: '结果',
    ranges: [],
    confidence: 0.9,
    storyUnitId: 'su-1',
    chapterId: 'ch-1',
    narrativeRole: 'supporting',
  };
}

function mappingFor(asset, metadata = {}) {
  return {
    assetId: asset.assetId,
    type: asset.type,
    projectFilename: `${asset.assetId}.${asset.type === 'video' ? 'mp4' : 'png'}`,
    projectAbsolutePath: `/tmp/fix3/${asset.assetId}.${asset.type === 'video' ? 'mp4' : 'png'}`,
    projectStableId: `stable-${asset.assetId}`,
    sourceSha256: 'ab'.repeat(32),
    metadata: asset.type === 'video'
      ? {
        durationSec: asset.ranges[0].endSec,
        width: 1080,
        height: 1920,
        frameRate: 30,
        hasAudio: true,
        audioChannels: 2,
        sampleRate: 48000,
        ...metadata,
      }
      : { width: 1080, height: 1920, hasAudio: false, ...metadata },
  };
}

function spineClips(xml) {
  return [...xml.matchAll(/<(asset-clip|video)\s+([^>]+)>/g)].map((match) => {
    const attrs = match[2];
    return {
      tag: match[1],
      name: attrs.match(/\bname="([^"]*)"/)?.[1] || '',
      offset: attrs.match(/\boffset="([^"]+)"/)?.[1] || null,
      start: attrs.match(/\bstart="([^"]+)"/)?.[1] || null,
      duration: attrs.match(/\bduration="([^"]+)"/)?.[1] || null,
    };
  });
}

function assertOnFrameGrid(time, fps) {
  const fd = parseFcpTimeRational(frameDuration(fps));
  assert.equal(
    isRationalMultiple(parseFcpTimeRational(time), fd),
    true,
    `${time} not on ${frameDuration(fps)} grid`,
  );
}

test('Stage 5E-Fix3: 93437/1000s 与 37333/1000s 在 30fps 转为覆盖完整内容的合法帧时长', () => {
  const fd = parseFcpTimeRational(frameDuration(30));
  assert.equal(isRationalMultiple(parseFcpTimeRational('93437/1000s'), fd), false);
  assert.equal(isRationalMultiple(parseFcpTimeRational('37333/1000s'), fd), false);

  const q1 = quantizeShotToFrameGrid({
    shot: { id: 's1', inSec: 0, outSec: 93.437, durationSec: 93.437 },
    mapping: mappingFor(videoAsset('v1', 93.437), { frameCount: 2802, frameRate: 30 }),
    analysisAsset: videoAsset('v1', 93.437),
    timelineFrameDur: fd,
  });
  assert.ok(q1.durationFrames >= Math.ceil(93.437 * 30 - 1e-9));
  assert.equal(isRationalMultiple(q1.durationRational, fd), true);
  assert.ok(q1.durationSec + 1e-9 >= 93.437);
  assert.equal(q1.usedRealFrameCount, true);

  const q2 = quantizeShotToFrameGrid({
    shot: { id: 's2', inSec: 0, outSec: 37.333, durationSec: 37.333 },
    mapping: mappingFor(videoAsset('v2', 37.333), {
      frameCount: 1117,
      frameRate: 29.97003,
      avgFrameRate: '30000/1001',
    }),
    analysisAsset: videoAsset('v2', 37.333),
    timelineFrameDur: fd,
  });
  assert.equal(isRationalMultiple(q2.durationRational, fd), true);
  assert.ok(q2.durationSec + 1e-9 >= 37.333);
  assert.notEqual(q2.durationTime, '37333/1000s');
});

test('Stage 5E-Fix3: preserveFullClip 不向下裁掉尾部；无真实帧数时向外取整', () => {
  const fd = parseFcpTimeRational(frameDuration(30));
  const withFrames = quantizeShotToFrameGrid({
    shot: { id: 's', inSec: 0, outSec: 93.437, durationSec: 93.437 },
    mapping: mappingFor(videoAsset('v', 93.437), { frameCount: 2802, frameRate: 30 }),
    analysisAsset: videoAsset('v', 93.437),
    timelineFrameDur: fd,
  });
  const withoutFrames = quantizeShotToFrameGrid({
    shot: { id: 's', inSec: 0, outSec: 93.437, durationSec: 93.437 },
    mapping: mappingFor(videoAsset('v', 93.437), { frameRate: 30 }),
    analysisAsset: videoAsset('v', 93.437),
    timelineFrameDur: fd,
  });
  assert.ok(withFrames.durationSec + 1e-9 >= 93.437);
  assert.ok(withoutFrames.durationSec + 1e-9 >= 93.437);
  assert.equal(withoutFrames.durationFrames, Math.ceil(93.437 * 30 - 1e-9));
  assert.equal(withoutFrames.usedRealFrameCount, false);
  assert.ok(withFrames.usedRealFrameCount);
});

test('Stage 5E-Fix3: 后续镜头 offset 按量化后前镜头重新累计；sequence 为总和', () => {
  const assets = [
    videoAsset('v1', 93.437),
    videoAsset('v2', 37.333),
    imageAsset('img-1'),
  ];
  const shots = [
    {
      id: 'shot-1', assetId: 'v1', inSec: 0, outSec: 93.437, durationSec: 93.437,
      fitMode: 'contain', audioMode: 'keep', chapterId: 'ch-1',
    },
    {
      id: 'shot-2', assetId: 'v2', inSec: 0, outSec: 37.333, durationSec: 37.333,
      fitMode: 'contain', audioMode: 'keep', chapterId: 'ch-1',
    },
    {
      id: 'shot-3', assetId: 'img-1', inSec: 0, outSec: 5.5, durationSec: 5.5,
      fitMode: 'contain', audioMode: 'mute', chapterId: 'ch-1',
    },
  ];
  const analysis = baseAnalysis(assets, shots, {
    markers: [{ timeSec: 0.8, text: '巧合' }],
  });
  const assetMappings = assets.map((asset) => mappingFor(asset));
  const plan = planFrameAlignedTimeline({ analysis, assetMappings });
  assert.equal(plan.shots[0].offsetFrames, 0);
  assert.equal(plan.shots[1].offsetFrames, plan.shots[0].durationFrames);
  assert.equal(plan.shots[2].offsetFrames, plan.shots[0].durationFrames + plan.shots[1].durationFrames);
  assert.equal(
    plan.totalFrames,
    plan.shots.reduce((sum, shot) => sum + shot.durationFrames, 0),
  );

  const xml = buildFcpxml({
    projectName: 'fix3-acc',
    analysis,
    assetMappings,
  });
  const clips = spineClips(xml);
  assert.equal(clips.length, 3);
  assertOnFrameGrid(clips[0].duration, 30);
  assertOnFrameGrid(clips[1].offset, 30);
  assertOnFrameGrid(clips[1].duration, 30);
  assertOnFrameGrid(clips[2].offset, 30);
  assertOnFrameGrid(clips[2].duration, 30);
  assert.equal(clips[1].offset, plan.shots[1].offsetTime);
  assert.equal(clips[2].offset, plan.shots[2].offsetTime);
  assert.match(xml, new RegExp(`sequence duration="${plan.totalDurationTime.replace('/', '\\/')}"`));
  assert.doesNotMatch(xml, /93437\/1000s|37333\/1000s/);
  const report = validateFcpxmlStructure(xml, {
    shotCount: 3, assetCount: 3, markerCount: 1, fps: 30, width: 1080, height: 1920,
  });
  assert.equal(report.ok, true, report.errors.join('；'));
});

test('Stage 5E-Fix3: 图片时长对齐帧边界；Marker/非受管 Title 对齐且内容不变；受管字幕继续对齐', () => {
  const assets = [videoAsset('v1', 10), imageAsset('img-1')];
  const shots = [
    {
      id: 'shot-v', assetId: 'v1', inSec: 0, outSec: 10, durationSec: 10,
      fitMode: 'contain', audioMode: 'keep', chapterId: 'ch-1', storyUnitId: 'su-1',
    },
    {
      id: 'shot-i', assetId: 'img-1', inSec: 0, outSec: 5.5, durationSec: 5.5,
      fitMode: 'contain', audioMode: 'mute', chapterId: 'ch-1', storyUnitId: 'su-1',
    },
  ];
  const analysis = baseAnalysis(assets, shots, {
    markers: [
      {
        timeSec: 1.01,
        text: '章节',
        id: 'marker-ch',
        subtitle: {
          enabled: true,
          text: '非受管章节 Title',
          durationSec: 1.92,
          position: 'bottom-safe',
          purpose: 'chapter',
          renderAsFcpTitle: true,
        },
      },
      { timeSec: 11.2, text: '图片标记' },
    ],
    lightCaptionPlan: [{
      captionId: 'c1', assetId: 'v1', text: '受管字幕', startTime: 2.01, endTime: 3.93,
    }],
  });
  const assetMappings = assets.map((asset) => mappingFor(asset));
  const plan = buildCaptionExportPlan({
    confirmedCaptions: [{
      captionId: 'c1',
      assetId: 'v1',
      reviewStatus: 'approved',
      text: '受管字幕',
      startTime: 2.01,
      endTime: 3.93,
      storyUnitId: 'su-1',
    }],
    analysis,
    assetMappings,
  });
  const xml = buildFcpxml({
    projectName: 'fix3-titles',
    analysis,
    assetMappings,
    managedCaptionTitles: toManagedCaptionTitles(plan.exportableEntries),
  });
  assert.equal(fcpTime(1.92), '48/25s');
  assert.doesNotMatch(xml, /48\/25s/);
  const clips = spineClips(xml);
  assert.equal(clips[1].duration, '11/2s');
  assertOnFrameGrid(clips[1].duration, 30);
  assert.match(xml, /非受管章节 Title/);
  assert.match(xml, /受管字幕/);
  assert.match(xml, /<marker [^>]*value="章节"\/>/);
  assert.match(xml, /<marker [^>]*value="图片标记"\/>/);
  const managed = [...xml.matchAll(/<note>vcp-managed-caption:([^<]+)<\/note>/g)];
  assert.equal(managed.length, 1);
  assert.doesNotMatch(xml, /<title\b[^>]*\bnote="/);
  const report = validateFcpxmlStructure(xml, {
    shotCount: 2, assetCount: 2, markerCount: 2, titleCount: 2, fps: 30,
  });
  assert.equal(report.ok, true, report.errors.join('；'));
});

test('Stage 5E-Fix3: 29.97/59.94 使用真实分数 frameDuration；不同源帧率不按源毫秒简单截断', () => {
  assert.equal(frameDuration(29.97), '1001/30000s');
  assert.equal(frameDuration(59.94), '1001/60000s');
  const fd2997 = parseFcpTimeRational(frameDuration(29.97));
  const assets = [videoAsset('v2997', 37.333)];
  const shots = [{
    id: 'shot-1', assetId: 'v2997', inSec: 0, outSec: 37.333, durationSec: 37.333,
    fitMode: 'contain', audioMode: 'keep',
  }];
  const analysis = baseAnalysis(assets, shots, { fps: 29.97, markers: [] });
  analysis.timeline.width = 1920;
  analysis.timeline.height = 1080;
  analysis.timeline.orientation = 'horizontal';
  const assetMappings = [mappingFor(assets[0], {
    frameRate: 29.97003,
    avgFrameRate: '30000/1001',
    frameCount: 1117,
  })];
  const xml = buildFcpxml({ projectName: 'fix3-2997', analysis, assetMappings });
  assert.match(xml, /frameDuration="1001\/30000s"/);
  const clips = spineClips(xml);
  assert.equal(isRationalMultiple(parseFcpTimeRational(clips[0].duration), fd2997), true);
  assert.ok(parseFcpTimeRational(clips[0].duration).numerator
    / parseFcpTimeRational(clips[0].duration).denominator + 1e-9 >= 37.333);

  const mixed = quantizeShotToFrameGrid({
    shot: { id: 's', inSec: 0, outSec: 22.019, durationSec: 22.019 },
    mapping: mappingFor(videoAsset('v26', 22.019), {
      frameRate: 26,
      frameCount: 571,
    }),
    analysisAsset: videoAsset('v26', 22.019),
    timelineFrameDur: frameDuration(30),
  });
  assert.ok(mixed.durationSec + 1e-9 >= 22.019);
  assert.notEqual(mixed.durationTime, '22019/1000s');
});

test('Stage 5E-Fix3: 视频原声/镜头数量顺序/Story Unit 不变；无空洞重叠；非法边界可被发现', () => {
  const assets = [
    videoAsset('v1', 5),
    videoAsset('v2', 4),
    imageAsset('img-1'),
  ];
  const shots = [
    {
      id: 'shot-1', assetId: 'v1', inSec: 0, outSec: 5, durationSec: 5,
      fitMode: 'contain', audioMode: 'keep', chapterId: 'ch-1', storyUnitId: 'su-a',
    },
    {
      id: 'shot-2', assetId: 'v2', inSec: 0, outSec: 4, durationSec: 4,
      fitMode: 'contain', audioMode: 'keep', chapterId: 'ch-2', storyUnitId: 'su-b',
    },
    {
      id: 'shot-3', assetId: 'img-1', inSec: 0, outSec: 3, durationSec: 3,
      fitMode: 'contain', audioMode: 'mute', chapterId: 'ch-2', storyUnitId: 'su-b',
    },
  ];
  const analysis = baseAnalysis(assets, shots, { markers: [{ timeSec: 1, text: 'm1' }] });
  const assetMappings = assets.map((asset) => mappingFor(asset));
  const xml = buildFcpxml({ projectName: 'fix3-order', analysis, assetMappings });
  const clips = spineClips(xml);
  assert.deepEqual(clips.map((clip) => clip.name), [
    'v1.mp4',
    'v2.mp4',
    'img-1.png',
  ]);
  assert.equal(clips.length, 3);
  assert.match(xml, /audioRole="dialogue"/);
  assert.doesNotMatch(xml, /adjust-volume amount="-96dB"/);
  assert.equal(analysis.timeline.shots[0].storyUnitId, 'su-a');
  assert.equal(analysis.timeline.shots[1].chapterId, 'ch-2');
  assert.equal(analysis.timeline.shots[1].storyUnitId, 'su-b');

  let cursor = 0;
  for (const clip of clips) {
    const offset = parseFcpTimeRational(clip.offset);
    const duration = parseFcpTimeRational(clip.duration);
    assert.equal(offset.numerator / offset.denominator, cursor);
    cursor += duration.numerator / duration.denominator;
  }

  const legal = validateFcpxmlStructure(xml, {
    shotCount: 3, assetCount: 3, markerCount: 1, fps: 30,
  });
  assert.equal(legal.ok, true, legal.errors.join('；'));

  const illegal = xml.replace(
    /(<asset-clip\b[^>]*\bduration=")[^"]+(")/,
    '$193437/1000s$2',
  );
  const bad = validateFcpxmlStructure(illegal, {
    shotCount: 3, assetCount: 3, markerCount: 1, fps: 30,
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((error) => /duration 未对齐帧边界/.test(error)));

  const illegalNote = xml.replace(
    /(<title\b[^>]*name="[^"]*")(\s+start=)/,
    `$1 note="${MANAGED_CAPTION_NOTE_PREFIX}x"$2`,
  );
  // If no title exists, inject a tiny illegal title for note-attribute rejection.
  const withIllegalTitle = illegalNote.includes('note="')
    ? illegalNote
    : xml.replace(
      '</spine>',
      `          <title ref="r9" lane="1" offset="0s" name="x" note="${MANAGED_CAPTION_NOTE_PREFIX}x" start="3600s" duration="1s"></title>\n          </spine>`,
    );
  const noteReport = validateFcpxmlStructure(withIllegalTitle, { fps: 30 });
  assert.equal(noteReport.ok, false);
  assert.ok(noteReport.errors.some((error) => /非法 note 属性/.test(error)));
});

test('Stage 5E-Fix3: resolveMediaContentDurationSec 优先真实帧数；legacy fcpTime 仍可能离开帧网格', () => {
  const content = resolveMediaContentDurationSec({
    frameCount: 2802,
    frameRate: 30,
    durationSec: 93.437,
  });
  assert.ok(content >= 93.4);
  assert.equal(fcpTime(93.437), '93437/1000s');
  assert.notEqual(fcpTimeAligned(93.437, 30, 'ceil'), '93437/1000s');
});
