'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  computeDurationPolicy,
} = require('../src/services/narrative-structure-service');
const {
  sharedEditingRulesText,
  summarizeMaterialCoverage,
  validateMaterialCoverage,
  validateRequiredLightCaptions,
} = require('../src/services/editing-contract-service');
const { validateVideoAnalysis } = require('../src/services/video-analysis-schema');
const { buildAgentPrompt, AGENT_ENGINES } = require('../src/services/handoff-task-service');

function baseAsset(assetId, type = 'image', extras = {}) {
  return {
    assetId,
    type,
    semanticLabels: ['结果'],
    contentSummary: '可见内容',
    suggestedUse: ['时间线'],
    status: 'adopt',
    reason: '推动叙事',
    ranges: type === 'video' ? [{ startSec: 0, endSec: extras.durationSec || 5, confidence: 0.9 }] : [],
    confidence: 0.9,
    ...extras.asset,
  };
}

function shot(id, assetId, extras = {}) {
  return {
    id,
    assetId,
    inSec: extras.inSec ?? 0,
    outSec: extras.outSec ?? extras.durationSec ?? 2,
    durationSec: extras.durationSec ?? ((extras.outSec ?? 2) - (extras.inSec ?? 0)),
    fitMode: 'contain',
    audioMode: extras.audioMode || 'keep',
    purpose: '结果',
    confidence: 0.9,
    reviewRequired: false,
  };
}

function multiAssetManifest(items) {
  return {
    schemaVersion: 2,
    narrative: {
      allowChapterInterleave: false,
      enforceChapterValidation: false,
      durationPolicy: computeDurationPolicy([{ chapterName: '合集' }], {
        imageCount: items.filter((item) => item.type === 'image').length,
        videoCount: items.filter((item) => item.type === 'video').length,
      }),
    },
    chapters: [],
    items,
  };
}

test('不存在默认成片时长限制', () => {
  const policy = computeDurationPolicy(
    [{ chapterName: 'HotIngest合集' }],
    { imageCount: 20, videoCount: 10, totalVideoDurationSec: 400 },
  );
  assert.equal(policy.source, 'unconstrained');
  assert.equal(policy.maxSec, null);
  assert.equal(policy.constrained, false);
  assert.match(policy.rationale, /不设目标时长|不要太长/);
});

test('多素材项目全部进入时间线', () => {
  const items = [
    { assetId: 'a', type: 'image', filename: 'a.png', metadata: {} },
    { assetId: 'b', type: 'image', filename: 'b.png', metadata: {} },
    { assetId: 'c', type: 'video', filename: 'c.mp4', metadata: { durationSec: 8, hasAudio: true } },
  ];
  const analysis = {
    schemaVersion: 1,
    theme: { summary: '主题', rationale: '可见', confidence: 0.9, folderNameConflict: false },
    titles: { candidates: ['A', 'B'], recommended: 'A', rationale: '可见' },
    assets: items.map((item) => baseAsset(item.assetId, item.type, {
      durationSec: item.metadata.durationSec,
    })),
    timeline: {
      orientation: 'vertical', width: 1080, height: 1920, fps: 30,
      durationPolicy: multiAssetManifest(items).narrative.durationPolicy,
      shots: [
        shot('s1', 'a', { durationSec: 2 }),
        shot('s2', 'b', { durationSec: 2 }),
        shot('s3', 'c', { durationSec: 8, outSec: 8 }),
      ],
      markers: [{ timeSec: 0.5, text: '开始' }],
    },
  };
  assert.doesNotThrow(() => validateVideoAnalysis(analysis, multiAssetManifest(items)));
  const coverage = summarizeMaterialCoverage(analysis, multiAssetManifest(items));
  assert.equal(coverage.eligibleVisualCount, 3);
  assert.equal(coverage.timelineAssetCount, 3);
  assert.equal(coverage.hasUnusedRequiredAssets, false);
});

test('普通视频不得因控制时长被跳过', () => {
  const items = [
    { assetId: 'v1', type: 'video', filename: 'keep.mp4', metadata: { durationSec: 12, hasAudio: true } },
    { assetId: 'v2', type: 'video', filename: 'skip.mp4', metadata: { durationSec: 15, hasAudio: true } },
  ];
  const analysis = {
    schemaVersion: 1,
    theme: { summary: '主题', rationale: '可见', confidence: 0.9, folderNameConflict: false },
    titles: { candidates: ['A', 'B'], recommended: 'A', rationale: '可见' },
    assets: [
      baseAsset('v1', 'video', { durationSec: 12 }),
      {
        ...baseAsset('v2', 'video', { durationSec: 15 }),
        status: 'reject',
        reason: '成片不要太长，跳过普通视频',
      },
    ],
    timeline: {
      orientation: 'vertical', width: 1080, height: 1920, fps: 30,
      durationPolicy: multiAssetManifest(items).narrative.durationPolicy,
      shots: [shot('s1', 'v1', { durationSec: 12, outSec: 12 })],
      markers: [{ timeSec: 0.5, text: '开始' }],
    },
  };
  const errors = [];
  validateMaterialCoverage(analysis, multiAssetManifest(items), errors);
  assert.match(errors.join('；'), /skip\.mp4|未进入时间线/);
});

test('异常长视频允许截取但不能完全跳过', () => {
  const items = [
    { assetId: 'long', type: 'video', filename: 'long.mp4', metadata: { durationSec: 600, hasAudio: true } },
  ];
  const analysis = {
    schemaVersion: 1,
    theme: { summary: '主题', rationale: '可见', confidence: 0.9, folderNameConflict: false },
    titles: { candidates: ['A', 'B'], recommended: 'A', rationale: '可见' },
    assets: [{
      ...baseAsset('long', 'video', { durationSec: 600 }),
      videoPreservationPlan: {
        preserveFullClip: false,
        proposedIn: 10,
        proposedOut: 40,
        trimReason: '素材相对整期异常长，仅保留精彩动作段 10-40s',
        protectedRanges: [],
        warnings: [],
      },
      audioAnalysis: {
        audioAvailable: true,
        audioEnabled: true,
        audioRole: 'primary',
        speechPresent: false,
        musicPresent: false,
        soundEffectPresent: false,
        audioSummary: '有原声',
        audioNeededForUnderstanding: false,
        preserveOriginalAudio: true,
        muteReason: null,
        warnings: [],
      },
    }],
    timeline: {
      orientation: 'vertical', width: 1080, height: 1920, fps: 30,
      durationPolicy: multiAssetManifest(items).narrative.durationPolicy,
      shots: [shot('s1', 'long', { inSec: 10, outSec: 40, durationSec: 30 })],
      markers: [{ timeSec: 0.5, text: '精彩' }],
    },
  };
  const coverage = summarizeMaterialCoverage(analysis, multiAssetManifest(items));
  assert.equal(coverage.timelineAssetCount, 1);
  assert.equal(coverage.trimmedUseCount, 1);
  assert.equal(coverage.hasUnusedRequiredAssets, false);

  const skipped = {
    ...analysis,
    assets: [{ ...analysis.assets[0], status: 'reject', reason: '太长跳过' }],
    timeline: { ...analysis.timeline, shots: [] },
  };
  const errors = [];
  validateMaterialCoverage(skipped, multiAssetManifest(items), errors);
  // empty shots also fails elsewhere; coverage should still flag unused
  assert.equal(errors.some((item) => /未进入时间线/.test(item)), true);
});

test('视频原声默认保留', () => {
  const items = [
    { assetId: 'v1', type: 'video', filename: 'voice.mp4', metadata: { durationSec: 5, hasAudio: true } },
  ];
  const analysis = {
    schemaVersion: 1,
    theme: { summary: '主题', rationale: '可见', confidence: 0.9, folderNameConflict: false },
    titles: { candidates: ['A', 'B'], recommended: 'A', rationale: '可见' },
    assets: [baseAsset('v1', 'video', { durationSec: 5 })],
    timeline: {
      orientation: 'vertical', width: 1080, height: 1920, fps: 30,
      durationPolicy: multiAssetManifest(items).narrative.durationPolicy,
      shots: [shot('s1', 'v1', { durationSec: 5, outSec: 5, audioMode: 'mute' })],
      markers: [{ timeSec: 0.5, text: '开始' }],
    },
  };
  assert.throws(
    () => validateVideoAnalysis(analysis, multiAssetManifest(items)),
    /原声|muteReason|keep/,
  );
});

test('人工字幕和 HotIngest 解释触发轻字幕；缺少应有轻字幕时验证失败', () => {
  const items = [
    {
      assetId: 'foreign',
      type: 'image',
      filename: 'meme.png',
      metadata: {},
      context: {
        language: 'en',
        title: 'Funny meme',
        body: 'punchline',
        translation: '这是笑点解释',
      },
    },
  ];
  const analysis = {
    schemaVersion: 1,
    theme: { summary: '主题', rationale: '可见', confidence: 0.9, folderNameConflict: false },
    titles: { candidates: ['A', 'B'], recommended: 'A', rationale: '可见' },
    assets: [{
      ...baseAsset('foreign', 'image'),
      explanationPlan: {
        audienceNeedsExplanation: 'humor_or_twist',
        rationale: '外梗需要解释',
        confidence: 0.9,
        evidence: { visualEvidenceUsed: ['画面'], contextEvidenceUsed: ['翻译'], inference: ['需要字幕'] },
      },
    }],
    lightCaptionPlan: [],
    timeline: {
      orientation: 'vertical', width: 1080, height: 1920, fps: 30,
      durationPolicy: multiAssetManifest(items).narrative.durationPolicy,
      shots: [shot('s1', 'foreign', { durationSec: 3 })],
      markers: [{ timeSec: 0.5, text: '开始' }],
    },
  };
  const errors = [];
  validateRequiredLightCaptions(analysis, multiAssetManifest(items), errors);
  assert.match(errors.join('；'), /应生成轻字幕|lightCaptionPlan/);

  analysis.lightCaptionPlan = [{
    captionId: 'cap-1',
    assetId: 'foreign',
    text: '这是笑点',
    purpose: 'humor',
    basedOn: 'HotIngest 翻译',
    confidence: 0.9,
    reviewRequired: false,
    warnings: [],
  }];
  const okErrors = [];
  validateRequiredLightCaptions(analysis, multiAssetManifest(items), okErrors);
  assert.equal(okErrors.length, 0);
});

test('Codex 使用固定剪辑规则', () => {
  const input = {
    sourceDirectory: '/tmp/src',
    taskId: '00000000-0000-4000-8000-000000000001',
    taskFilePath: '/tmp/task.json',
    taskManifestPath: '/tmp/task.task.json',
    hyperframesMode: 'disabled',
    packageDir: '/tmp/pkg',
    appWorkspace: path.join(__dirname, '..'),
  };
  const codex = buildAgentPrompt(AGENT_ENGINES.codex.id, input);
  const shared = sharedEditingRulesText();
  assert.match(codex, /执行视频剪辑任务 00000000-0000-4000-8000-000000000001/);
  assert.match(codex, /固定剪辑 Skill：/);
  assert.doesNotMatch(codex, /不得设置或推断默认成片目标时长/);
  assert.doesNotMatch(codex, /默认都需要进入时间线/);
  const skill = fs.readFileSync(path.join(__dirname, '../skills/video-cut-planner/SKILL.md'), 'utf8');
  assert.match(skill, /不设默认成片目标时长|不得设置或推断默认成片目标时长/);
  assert.match(skill, /默认都需要进入时间线/);
  assert.match(skill, /默认保留原声/);
  assert.match(skill, /轻字幕/);
  assert.match(skill, /剪辑硬规则/);
});
