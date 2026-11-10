'use strict';

function roundTime(value) {
  return Number(Number(value).toFixed(3));
}

function parsePauseDirectives(text) {
  const source = String(text || '');
  const pattern = /\[pause\s*:\s*(\d+(?:\.\d+)?)\s*\]/gi;
  const tokens = [];
  let cursor = 0;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    const speech = source.slice(cursor, match.index).trim();
    if (speech) tokens.push({ type: 'speech', text: speech });
    const durationSec = Number(match[1]);
    if (Number.isFinite(durationSec) && durationSec > 0) {
      tokens.push({ type: 'pause', durationSec: roundTime(durationSec) });
    }
    cursor = pattern.lastIndex;
  }

  const trailingSpeech = source.slice(cursor).trim();
  if (trailingSpeech) tokens.push({ type: 'speech', text: trailingSpeech });
  return tokens;
}

function normalizeAudioClips(segment) {
  const clips = Array.isArray(segment?.voiceTrack?.clips)
    ? segment.voiceTrack.clips
    : [];
  return clips
    .map((clip) => ({
      file: clip.file,
      durationSec: roundTime(Number(clip.durationSec) || 0),
    }))
    .filter((clip) => clip.file && clip.durationSec >= 0);
}

function compileVoiceItems(segment) {
  const clips = normalizeAudioClips(segment);
  const tokens = parsePauseDirectives(segment?.voiceoverText);
  const speechCount = tokens.filter((token) => token.type === 'speech').length;
  const pausesByBoundary = new Map();
  let speechBefore = 0;

  for (const token of tokens) {
    if (token.type === 'speech') {
      speechBefore += 1;
      continue;
    }
    const boundary = speechCount > 0
      ? Math.round((speechBefore / speechCount) * clips.length)
      : clips.length;
    const safeBoundary = Math.max(0, Math.min(clips.length, boundary));
    const pauses = pausesByBoundary.get(safeBoundary) || [];
    pauses.push(token.durationSec);
    pausesByBoundary.set(safeBoundary, pauses);
  }

  const items = [];
  let cursor = 0;
  const appendPauses = (boundary) => {
    for (const durationSec of pausesByBoundary.get(boundary) || []) {
      const startSec = cursor;
      cursor = roundTime(cursor + durationSec);
      items.push({
        id: `pause-${String(items.length + 1).padStart(3, '0')}`,
        type: 'pause',
        track: 'voice',
        startSec,
        endSec: cursor,
        durationSec,
        renderMode: 'freeze_frame',
      });
    }
  };

  appendPauses(0);
  clips.forEach((clip, index) => {
    const startSec = cursor;
    cursor = roundTime(cursor + clip.durationSec);
    items.push({
      id: `audio-${String(index + 1).padStart(3, '0')}`,
      type: 'audio',
      track: 'voice',
      file: clip.file,
      startSec,
      endSec: cursor,
      durationSec: clip.durationSec,
    });
    appendPauses(index + 1);
  });
  return { items, durationSec: cursor };
}

function compileVisualItems(segment) {
  const sourceItems = segment?.items || segment?.assignment?.items || [];
  let cursor = 0;
  const items = [...sourceItems]
    .sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0))
    .map((item, index) => {
      const durationSec = roundTime(Math.max(0, Number(item.durationSec) || 0));
      const startSec = cursor;
      cursor = roundTime(cursor + durationSec);
      return {
        ...item,
        id: item.id || `video-${String(index + 1).padStart(3, '0')}`,
        type: 'video',
        sourceType: item.sourceType || item.type,
        track: item.track || 'visual',
        startSec,
        endSec: cursor,
        durationSec,
      };
    });
  return { items, durationSec: cursor };
}

function createTimeline(items, voiceDuration = 0, visualDuration = 0) {
  const sortedItems = [...items].sort((left, right) => {
    const difference = (Number(left.startSec) || 0) - (Number(right.startSec) || 0);
    if (difference) return difference;
    const priority = { video: 0, audio: 1, pause: 2 };
    return (priority[left.type] ?? 9) - (priority[right.type] ?? 9);
  });
  return {
    duration: roundTime(Math.max(voiceDuration, visualDuration)),
    voiceDuration: roundTime(voiceDuration),
    visualDuration: roundTime(visualDuration),
    items: sortedItems,
  };
}

function compileNestedTimeline(segment) {
  const items = [];
  let cursor = 0;

  for (const child of segment.segments) {
    const childTimeline = compileTimeline({
      ...(child.segment || child),
      items: child.items || child.segment?.items || [],
    });
    const duration = childTimeline.duration;
    if (child.programFile) {
      items.push({
        id: `segment-${child.segment?.id || child.id}`,
        type: 'video',
        track: 'program',
        segmentId: child.segment?.id || child.id,
        file: child.programFile,
        startSec: cursor,
        endSec: roundTime(cursor + duration),
        durationSec: duration,
      });
    }
    for (const item of childTimeline.items) {
      items.push({
        ...item,
        id: `${child.segment?.id || child.id}-${item.id}`,
        segmentId: child.segment?.id || child.id,
        startSec: roundTime(cursor + item.startSec),
        endSec: roundTime(cursor + item.endSec),
      });
    }
    cursor = roundTime(cursor + duration);
  }
  return createTimeline(items, cursor, cursor);
}

function compileTimeline(segment = {}) {
  if (Array.isArray(segment.segments)) return compileNestedTimeline(segment);
  const voice = compileVoiceItems(segment);
  const visual = compileVisualItems(segment);
  return createTimeline(
    [...visual.items, ...voice.items],
    voice.durationSec,
    visual.durationSec,
  );
}

function getSegmentDuration(segment) {
  const duration = Number(segment?.timeline?.duration);
  return Number.isFinite(duration) ? duration : null;
}

module.exports = {
  compileTimeline,
  getSegmentDuration,
  parsePauseDirectives,
};
