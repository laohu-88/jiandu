const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveTimelineFormat } = require('./video-format-service');
const { fcpxmlShouldMuteShot } = require('./visual-explanation-service');
const {
  buildManagedCaptionTitlesFromAnalysis,
  defaultCaptionTransform,
} = require('./light-caption-export-service');

const FCPXML_TIMESCALE = 60000;
const FCPXML_DEFAULT_VERSION = '1.10';
const FCPXML_TITLE_VERSION = '1.14';
const BASIC_TITLE_EFFECT = Object.freeze({
  name: '基本字幕',
  uid: '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti',
});
const BASIC_TITLE_STYLE = Object.freeze({
  threeDText: true,
  surface: true,
  outline: true,
  glow: true,
  dropShadow: true,
});
const GAUSSIAN_BLUR_EFFECT = Object.freeze({
  name: 'Gaussian',
  uid: '.../Effects.localized/Blur.localized/Gaussian.localized/Gaussian.moef',
});
const MANAGED_CAPTION_NOTE_PREFIX = 'vcp-managed-caption:';

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Final Cut Pro names are a separate concern from XML escaping. Keep CJK and
// emoji, but normalize path/control characters before they ever reach XML.
function sanitizeFcpFilename(value, fallback = '未命名项目') {
  const clean = String(value || fallback)
    .replace(/[\\/:*?"'<>|]/g, '·')
    .replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 180)
    .trim();
  return clean && clean !== '.' && clean !== '..' ? clean : fallback;
}

function sanitizeFcpName(value, fallback = '未命名项目') {
  return sanitizeFcpFilename(value, fallback).replace(/&/g, '·');
}

function normalizeFcpNames({ filename, eventName, projectName } = {}) {
  return {
    filename: sanitizeFcpFilename(filename, '未命名素材'),
    eventName: sanitizeFcpName(eventName, '未命名事件'),
    projectName: sanitizeFcpName(projectName, '未命名项目'),
  };
}

function isLegalFcpName(value) {
  const name = String(value || '');
  return Boolean(name.trim())
    && name !== '.'
    && name !== '..'
    && !/[\\/:*?"'<>|\u0000-\u001f\u007f\r\n]/.test(name)
    && !/^\.+|\.+$/.test(name);
}

function gcd(left, right) {
  let a = Math.abs(Math.round(left));
  let b = Math.abs(Math.round(right));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function reduceRational(numerator, denominator) {
  const num = Number(numerator);
  const den = Number(denominator);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    throw new Error(`无效有理数：${numerator}/${denominator}`);
  }
  const sign = (num < 0) !== (den < 0) ? -1 : 1;
  const absNum = Math.abs(Math.round(num));
  const absDen = Math.abs(Math.round(den));
  const divisor = gcd(absNum, absDen);
  return {
    numerator: sign * (absNum / divisor),
    denominator: absDen / divisor,
  };
}

function parseFcpTimeRational(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('空 FCP 时间');
  const match = raw.match(/^(-?\d+)(?:\/(-?\d+))?s$/);
  if (!match) throw new Error(`无效 FCP 时间：${value}`);
  return reduceRational(Number(match[1]), match[2] ? Number(match[2]) : 1);
}

function formatFcpRational(numerator, denominator = 1) {
  const reduced = reduceRational(numerator, denominator);
  if (reduced.numerator === 0) return '0s';
  if (reduced.denominator === 1) return `${reduced.numerator}s`;
  return `${reduced.numerator}/${reduced.denominator}s`;
}

function rationalToSeconds(rational) {
  return Number(rational.numerator) / Number(rational.denominator);
}

function isRationalMultiple(value, base) {
  // value / base must be an integer: (value.num * base.den) % (value.den * base.num) === 0
  const valueNum = BigInt(value.numerator);
  const valueDen = BigInt(value.denominator);
  const baseNum = BigInt(base.numerator);
  const baseDen = BigInt(base.denominator);
  if (baseNum === 0n) return valueNum === 0n;
  const product = valueNum * baseDen;
  const divisor = valueDen * baseNum;
  if (divisor < 0n) {
    return product % -divisor === 0n;
  }
  return product % divisor === 0n;
}

function frameDuration(fps) {
  const value = Number(fps);
  if (Math.abs(value - 29.97) < 0.01) return '1001/30000s';
  if (Math.abs(value - 59.94) < 0.01) return '1001/60000s';
  const rounded = Math.round(value);
  return `1/${rounded || 30}s`;
}

function frameDurationRational(fpsOrDuration) {
  if (fpsOrDuration && typeof fpsOrDuration === 'object'
    && Number.isFinite(fpsOrDuration.numerator)
    && Number.isFinite(fpsOrDuration.denominator)) {
    return reduceRational(fpsOrDuration.numerator, fpsOrDuration.denominator);
  }
  if (typeof fpsOrDuration === 'string' && /s$/.test(fpsOrDuration)) {
    return parseFcpTimeRational(fpsOrDuration);
  }
  return parseFcpTimeRational(frameDuration(fpsOrDuration));
}

function divideRationalToInt(numerator, denominator, mode = 'nearest') {
  let num = BigInt(numerator);
  let den = BigInt(denominator);
  if (den === 0n) throw new Error('除零');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  if (mode === 'floor') {
    if (num >= 0n) return Number(num / den);
    return Number(-(((-num) + den - 1n) / den));
  }
  if (mode === 'ceil') {
    if (num >= 0n) return Number((num + den - 1n) / den);
    return Number(-((-num) / den));
  }
  // nearest, ties away from zero via +den/2 for positive
  if (num >= 0n) return Number((num + den / 2n) / den);
  return Number(-(((-num) + den / 2n) / den));
}

function secondsToFrameIndex(seconds, frameDur, mode = 'nearest') {
  const value = Number(seconds);
  if (!Number.isFinite(value)) throw new Error(`无效秒数：${seconds}`);
  const fd = frameDurationRational(frameDur);
  // frames = seconds / (num/den) = seconds * den / num
  // Keep a tiny epsilon so exact frameDuration multiples (e.g. 1/30) survive float noise.
  const scaled = (value * fd.denominator) / fd.numerator;
  if (mode === 'floor') return Math.floor(scaled + 1e-9);
  if (mode === 'ceil') return Math.ceil(scaled - 1e-9);
  return Math.round(scaled);
}

function rationalToFrameIndex(rational, frameDur, mode = 'nearest') {
  const value = reduceRational(rational.numerator, rational.denominator);
  const fd = frameDurationRational(frameDur);
  // frames = (value.num/value.den) / (fd.num/fd.den) = value.num * fd.den / (value.den * fd.num)
  return divideRationalToInt(
    BigInt(value.numerator) * BigInt(fd.denominator),
    BigInt(value.denominator) * BigInt(fd.numerator),
    mode,
  );
}

function frameIndexToRational(frameIndex, frameDur) {
  const fd = frameDurationRational(frameDur);
  const frames = Math.trunc(frameIndex);
  return reduceRational(frames * fd.numerator, fd.denominator);
}

function fcpTimeFromFrameIndex(frameIndex, frameDur) {
  const rational = frameIndexToRational(frameIndex, frameDur);
  return formatFcpRational(rational.numerator, rational.denominator);
}

function fcpTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) throw new Error(`无效 FCP 时间：${seconds}`);
  if (value === 0) return '0s';
  const numerator = Math.round(value * FCPXML_TIMESCALE);
  const divisor = gcd(numerator, FCPXML_TIMESCALE);
  return `${numerator / divisor}/${FCPXML_TIMESCALE / divisor}s`;
}

function fcpTimeAligned(seconds, fpsOrFrameDuration, mode = 'nearest') {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) throw new Error(`无效 FCP 时间：${seconds}`);
  if (value === 0) return '0s';
  const frames = secondsToFrameIndex(value, fpsOrFrameDuration, mode);
  return fcpTimeFromFrameIndex(Math.max(0, frames), fpsOrFrameDuration);
}

function parseFrameRateRational(value, fallbackFps = 30) {
  if (value && typeof value === 'object'
    && Number.isFinite(value.numerator)
    && Number.isFinite(value.denominator)
    && value.denominator !== 0) {
    return reduceRational(value.numerator, value.denominator);
  }
  if (typeof value === 'string' && value.includes('/')) {
    const [num, den] = value.split('/').map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0 && num > 0) {
      return reduceRational(num, den);
    }
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (Math.abs(numeric - 29.97) < 0.01 || Math.abs(numeric - 29.97003) < 0.01) {
      return reduceRational(30000, 1001);
    }
    if (Math.abs(numeric - 59.94) < 0.01) {
      return reduceRational(60000, 1001);
    }
    if (Math.abs(numeric - Math.round(numeric)) < 1e-6) {
      return reduceRational(Math.round(numeric), 1);
    }
    // Fall back to millisecond approximation of the float fps.
    const millis = Math.round(numeric * 1000);
    return reduceRational(millis, 1000);
  }
  return parseFrameRateRational(fallbackFps, 30);
}

function resolveMediaFrameCount(metadata = {}) {
  const candidates = [
    metadata.frameCount,
    metadata.nbFrames,
    metadata.nb_frames,
    metadata.nbReadFrames,
    metadata.nb_read_frames,
  ];
  for (const value of candidates) {
    const frames = Number(value);
    if (Number.isFinite(frames) && frames > 0) return Math.round(frames);
  }
  const durationTs = Number(metadata.durationTs ?? metadata.duration_ts);
  const timeBase = metadata.timeBase || metadata.time_base;
  if (Number.isFinite(durationTs) && durationTs > 0 && typeof timeBase === 'string' && timeBase.includes('/')) {
    const [tbNum, tbDen] = timeBase.split('/').map(Number);
    const fps = parseFrameRateRational(
      metadata.avgFrameRate || metadata.avg_frame_rate || metadata.frameRate || metadata.r_frame_rate,
    );
    if (Number.isFinite(tbNum) && Number.isFinite(tbDen) && tbDen !== 0 && fps) {
      // frames ≈ duration_ts * time_base * fps = duration_ts * (tbNum/tbDen) * (fpsNum/fpsDen)
      return Math.max(1, divideRationalToInt(
        BigInt(Math.round(durationTs)) * BigInt(tbNum) * BigInt(fps.numerator),
        BigInt(tbDen) * BigInt(fps.denominator),
        'nearest',
      ));
    }
  }
  return null;
}

function resolveMediaContentDurationSec(metadata = {}, fallbackSec = null) {
  const frameCount = resolveMediaFrameCount(metadata);
  const sourceFps = parseFrameRateRational(
    metadata.avgFrameRate || metadata.avg_frame_rate || metadata.frameRate || metadata.r_frame_rate,
  );
  const durations = [];
  if (frameCount && sourceFps) {
    durations.push(rationalToSeconds(reduceRational(
      frameCount * sourceFps.denominator,
      sourceFps.numerator,
    )));
  }
  const durationTs = Number(metadata.durationTs ?? metadata.duration_ts);
  const timeBase = metadata.timeBase || metadata.time_base;
  if (Number.isFinite(durationTs) && durationTs > 0 && typeof timeBase === 'string' && timeBase.includes('/')) {
    const [tbNum, tbDen] = timeBase.split('/').map(Number);
    if (Number.isFinite(tbNum) && Number.isFinite(tbDen) && tbDen !== 0) {
      durations.push(rationalToSeconds(reduceRational(durationTs * tbNum, tbDen)));
    }
  }
  if (Number.isFinite(metadata.durationSec) && metadata.durationSec > 0) {
    durations.push(Number(metadata.durationSec));
  }
  if (Number.isFinite(fallbackSec) && fallbackSec > 0) {
    durations.push(Number(fallbackSec));
  }
  if (!durations.length) return null;
  return Math.max(...durations);
}

function shotPreservesFullClip(shot, analysisAsset, mapping) {
  if ((mapping?.type || analysisAsset?.type) === 'image') return false;
  if (shot?.preserveFullClip === true || shot?.preserveFullClipLocked === true) return true;
  if (shot?.preserveFullClip === false) return false;
  const plan = analysisAsset?.videoPreservationPlan;
  if (plan?.preserveFullClip === false) return false;
  if (plan?.preserveFullClip === true) return true;
  return false;
}

/**
 * Quantize one timeline shot onto the sequence frame grid.
 * Videos that preserve full content ceil outward so tail frames/audio are kept.
 * Images snap to the nearest legal frame count (minimum one frame).
 */
function quantizeShotToFrameGrid({
  shot,
  mapping = null,
  analysisAsset = null,
  timelineFrameDur,
}) {
  const fd = frameDurationRational(timelineFrameDur);
  const sourceInSec = Number(shot.inSec);
  const declaredDuration = Number(shot.durationSec);
  const declaredOut = Number(shot.outSec);
  const imageLike = mapping?.type === 'image'
    || analysisAsset?.type === 'image'
    || analysisAsset?.type === 'comic'
    || analysisAsset?.type === 'meme';
  const preserveFull = shotPreservesFullClip(shot, analysisAsset, mapping);
  const metadata = mapping?.metadata || {};

  let contentDurationSec = declaredDuration;
  let usedRealFrameCount = false;
  const frameCount = resolveMediaFrameCount(metadata);
  const mediaEnd = resolveMediaContentDurationSec(
    metadata,
    Number.isFinite(declaredOut) ? declaredOut : declaredDuration,
  );
  const planOut = Number(
    analysisAsset?.videoPreservationPlan?.proposedOut
      ?? analysisAsset?.videoPreservationPlan?.sourceDuration
      ?? mediaEnd,
  );
  const start = Number.isFinite(sourceInSec) ? sourceInSec : 0;
  const looksLikeFullSpan = Number.isFinite(declaredOut)
    && Number.isFinite(planOut)
    && start <= 0.02
    && declaredOut >= planOut - 0.05;

  if (preserveFull && !imageLike && looksLikeFullSpan && Number.isFinite(mediaEnd)) {
    contentDurationSec = Math.max(
      Number.isFinite(declaredDuration) ? declaredDuration : 0,
      Math.max(0, mediaEnd - start),
    );
    if (frameCount) usedRealFrameCount = true;
  } else if (Number.isFinite(declaredDuration) && declaredDuration > 0) {
    contentDurationSec = declaredDuration;
  } else if (Number.isFinite(declaredOut) && Number.isFinite(sourceInSec)) {
    contentDurationSec = Math.max(0, declaredOut - sourceInSec);
  }

  if (!(contentDurationSec > 0)) {
    contentDurationSec = rationalToSeconds(fd);
  }

  const mode = imageLike ? 'nearest' : 'ceil';
  let durationFrames = secondsToFrameIndex(contentDurationSec, fd, mode);
  if (durationFrames < 1) durationFrames = 1;

  const durationRational = frameIndexToRational(durationFrames, fd);
  const durationSec = rationalToSeconds(durationRational);
  const sourceOutSec = start + durationSec;
  const adjusted = !Number.isFinite(declaredDuration)
    || Math.abs(durationSec - declaredDuration) > 1e-9;

  return {
    sourceInSec: start,
    sourceOutSec,
    durationFrames,
    durationSec,
    durationRational,
    durationTime: formatFcpRational(durationRational.numerator, durationRational.denominator),
    preserveFullClip: preserveFull,
    usedRealFrameCount,
    frameAlignmentAdjusted: adjusted,
    imageLike: Boolean(imageLike),
  };
}

function quantizeAssetResourceDuration(mapping, timelineFrameDur) {
  const metadata = mapping?.metadata || {};
  if (mapping?.type !== 'video') {
    return { durationSec: 0, durationTime: '0s', durationFrames: 0 };
  }
  const contentSec = resolveMediaContentDurationSec(metadata, metadata.durationSec) || 0;
  const assetFps = parseFrameRateRational(metadata.frameRate || metadata.avg_frame_rate, 30);
  const assetFrameDur = reduceRational(assetFps.denominator, assetFps.numerator);
  // Prefer asset-native frames so the resource covers real media; also cover
  // any timeline-ceil expansion via wall-clock content seconds.
  let assetFrames = secondsToFrameIndex(contentSec, assetFrameDur, 'ceil');
  if (assetFrames < 1) assetFrames = 1;
  const frameCount = resolveMediaFrameCount(metadata);
  if (frameCount) assetFrames = Math.max(assetFrames, frameCount);
  const durationRational = frameIndexToRational(assetFrames, assetFrameDur);
  return {
    durationSec: rationalToSeconds(durationRational),
    durationTime: formatFcpRational(durationRational.numerator, durationRational.denominator),
    durationFrames: assetFrames,
    frameDuration: formatFcpRational(assetFrameDur.numerator, assetFrameDur.denominator),
  };
}

/**
 * Rebuild the spine in integer sequence frames. Offsets are the running sum of
 * quantized durations — never a float-second accumulation.
 */
function planFrameAlignedTimeline({ analysis, assetMappings = [] }) {
  const fps = analysis?.timeline?.fps;
  const sequenceFrameDuration = frameDuration(fps);
  const fd = frameDurationRational(sequenceFrameDuration);
  const mappingById = new Map(assetMappings.map((mapping) => [mapping.assetId, mapping]));
  const analysisById = new Map(
    (Array.isArray(analysis?.assets) ? analysis.assets : []).map((asset) => [asset.assetId, asset]),
  );

  let timelineFrame = 0;
  const shots = [];
  for (const shot of analysis.timeline.shots) {
    const mapping = mappingById.get(shot.assetId) || null;
    const analysisAsset = analysisById.get(shot.assetId) || null;
    const quantized = quantizeShotToFrameGrid({
      shot,
      mapping,
      analysisAsset,
      timelineFrameDur: fd,
    });
    const offsetFrames = timelineFrame;
    const endFrames = offsetFrames + quantized.durationFrames;
    shots.push({
      shot,
      mapping,
      analysisAsset,
      ...quantized,
      offsetFrames,
      endFrames,
      offsetTime: fcpTimeFromFrameIndex(offsetFrames, fd),
      timelineStartSec: rationalToSeconds(frameIndexToRational(offsetFrames, fd)),
      timelineEndSec: rationalToSeconds(frameIndexToRational(endFrames, fd)),
    });
    timelineFrame = endFrames;
  }

  return {
    fps,
    sequenceFrameDuration,
    sequenceFrameRational: fd,
    totalFrames: timelineFrame,
    totalDurationSec: rationalToSeconds(frameIndexToRational(timelineFrame, fd)),
    totalDurationTime: fcpTimeFromFrameIndex(timelineFrame, fd),
    shots,
  };
}

/**
 * Quantize a caption [start, end) range onto the project frame grid.
 * Uses exact frameDuration (never hard-codes 30fps). Snaps start/end to the
 * nearest legal frame, then clamps inward to [minSec, maxSec]. Guarantees at
 * least one frame when the host range can fit it; otherwise returns ok:false.
 */
function quantizeCaptionTiming({
  startSec,
  endSec,
  minSec,
  maxSec,
  fps,
  frameDuration: frameDurationValue = null,
}) {
  const fd = frameDurationRational(frameDurationValue || fps);
  const rawStart = Number(startSec);
  const rawEnd = Number(endSec);
  const rawMin = Number(minSec);
  const rawMax = Number(maxSec);
  if (![rawStart, rawEnd, rawMin, rawMax].every(Number.isFinite) || rawEnd <= rawStart) {
    return {
      ok: false,
      reason: 'invalid_range',
      message: '字幕时间范围无效，无法对齐帧边界。',
    };
  }
  if (rawMax <= rawMin) {
    return {
      ok: false,
      reason: 'invalid_host_range',
      message: '镜头或时间线范围无效，无法对齐帧边界。',
    };
  }

  const minFrame = secondsToFrameIndex(rawMin, fd, 'ceil');
  const maxFrame = secondsToFrameIndex(rawMax, fd, 'floor');
  if (maxFrame - minFrame < 1) {
    return {
      ok: false,
      reason: 'insufficient_frame_room',
      message: '镜头剩余时间不足一帧，已阻止导出该字幕。',
      minFrame,
      maxFrame,
      frameDuration: formatFcpRational(fd.numerator, fd.denominator),
    };
  }

  let startFrame = secondsToFrameIndex(rawStart, fd, 'nearest');
  let endFrame = secondsToFrameIndex(rawEnd, fd, 'nearest');
  startFrame = Math.min(Math.max(startFrame, minFrame), maxFrame - 1);
  endFrame = Math.min(Math.max(endFrame, minFrame + 1), maxFrame);

  if (startFrame >= endFrame) {
    if (startFrame + 1 <= maxFrame) {
      endFrame = startFrame + 1;
    } else if (endFrame - 1 >= minFrame) {
      startFrame = endFrame - 1;
    } else {
      return {
        ok: false,
        reason: 'insufficient_frame_room',
        message: '吸附后不足一帧且镜头无法容纳，已阻止导出该字幕。',
        minFrame,
        maxFrame,
        frameDuration: formatFcpRational(fd.numerator, fd.denominator),
      };
    }
  }

  if (endFrame - startFrame < 1 || startFrame < minFrame || endFrame > maxFrame) {
    return {
      ok: false,
      reason: 'insufficient_frame_room',
      message: '对齐帧边界后字幕无法落在镜头范围内。',
      minFrame,
      maxFrame,
      frameDuration: formatFcpRational(fd.numerator, fd.denominator),
    };
  }

  const alignedStart = rationalToSeconds(frameIndexToRational(startFrame, fd));
  const alignedEnd = rationalToSeconds(frameIndexToRational(endFrame, fd));
  const durationFrames = endFrame - startFrame;
  const adjusted = Math.abs(alignedStart - rawStart) > 1e-9
    || Math.abs(alignedEnd - rawEnd) > 1e-9;
  return {
    ok: true,
    startSec: alignedStart,
    endSec: alignedEnd,
    durationSec: alignedEnd - alignedStart,
    startFrame,
    endFrame,
    durationFrames,
    startTime: fcpTimeFromFrameIndex(startFrame, fd),
    endTime: fcpTimeFromFrameIndex(endFrame, fd),
    durationTime: fcpTimeFromFrameIndex(durationFrames, fd),
    frameDuration: formatFcpRational(fd.numerator, fd.denominator),
    adjusted,
    deltaStartSec: alignedStart - rawStart,
    deltaEndSec: alignedEnd - rawEnd,
  };
}

function createFormatKey(width, height, fps, isStill = false) {
  if (isStill) return `${width || 1920}x${height || 1080}@still`;
  return `${width || 1920}x${height || 1080}@${Number(fps || 30).toFixed(3)}`;
}

function assetUid(mapping) {
  const sourceIdentity = String(
    mapping.sourceSha256 || mapping.projectAbsolutePath || mapping.assetId,
  );
  const generated = mapping.origin === 'hyperframes' || mapping.generator?.name === 'hyperframes';
  const uidIdentity = generated
    ? `${sourceIdentity}:${mapping.projectStableId || mapping.projectAbsolutePath || mapping.assetId}`
    : sourceIdentity;
  const digest = /^[0-9a-f]{64}$/i.test(uidIdentity)
    ? uidIdentity.toLowerCase()
    : crypto.createHash('sha256').update(uidIdentity).digest('hex');
  return `com.openai.video-cut-planner.asset.${digest}`;
}

function getShotAtTime(shots, timeSec) {
  let cursor = 0;
  for (const shot of shots) {
    const end = cursor + shot.durationSec;
    if (timeSec >= cursor && timeSec < end) return { shot, timelineStart: cursor, timelineEnd: end };
    cursor = end;
  }
  return null;
}

function getPlannedShotAtOriginalTime(originalShots, plannedShots, timeSec) {
  const located = getShotAtTime(originalShots, timeSec);
  if (!located) return null;
  const planned = plannedShots.find((entry) => entry.shot.id === located.shot.id);
  if (!planned) return null;
  const localSec = Math.max(0, timeSec - located.timelineStart);
  const sourceTimeSec = located.shot.inSec + localSec;
  const relativeSec = Math.min(
    Math.max(0, sourceTimeSec - planned.sourceInSec),
    planned.durationSec,
  );
  return {
    planned,
    located,
    sourceTimeSec: planned.sourceInSec + relativeSec,
    relativeSec,
    timelineSec: planned.timelineStartSec + relativeSec,
  };
}

function collectFcpTitles(analysis) {
  const totalDuration = analysis.timeline.shots.reduce(
    (sum, shot) => sum + shot.durationSec,
    0,
  );
  const requested = analysis.timeline.markers
    .map((marker, index) => ({ marker, index, subtitle: marker.subtitle }))
    .filter(({ subtitle }) => (
      subtitle?.enabled === true
      && subtitle.renderAsFcpTitle === true
      && typeof subtitle.text === 'string'
      && subtitle.text.trim()
      && Number.isFinite(subtitle.durationSec)
      && subtitle.durationSec > 0
    ))
    .sort((left, right) => left.marker.timeSec - right.marker.timeSec);
  const defaultTransformFor = (position) => defaultCaptionTransform(analysis, position);
  return requested.map((item, index) => {
    const startSec = item.marker.timeSec;
    const nextStart = requested[index + 1]?.marker.timeSec ?? totalDuration;
    const durationSec = Math.max(0, Math.min(
      item.subtitle.durationSec,
      totalDuration - startSec,
      nextStart - startSec,
    ));
    return {
      ...item,
      kind: 'marker_subtitle',
      titleKey: null,
      note: null,
      startSec,
      durationSec,
      text: item.subtitle.text.trim(),
      position: typeof item.subtitle.position === 'string' ? item.subtitle.position : 'bottom-safe',
      fontSize: Number.isFinite(Number(item.subtitle.fontSize))
        ? Number(item.subtitle.fontSize)
        : 46,
      // Marker subtitles have no free-form layout in the analysis contract;
      // use the production safe-zone default while keeping managed/manual
      // caption transforms untouched below.
      transform: defaultTransformFor(item.subtitle.position),
      defaultStyle: BASIC_TITLE_STYLE,
    };
  }).filter((item) => item.durationSec > 0);
}

function normalizeManagedCaptionTitles(managedCaptionTitles = []) {
  return (Array.isArray(managedCaptionTitles) ? managedCaptionTitles : [])
    .map((item, index) => {
      const text = typeof item?.text === 'string' ? item.text.trim() : '';
      const startSec = Number(item?.startSec);
      const durationSec = Number(item?.durationSec);
      const titleKey = typeof item?.titleKey === 'string' ? item.titleKey.trim() : '';
      if (!text || !titleKey || !Number.isFinite(startSec) || !Number.isFinite(durationSec) || durationSec <= 0) {
        return null;
      }
      return {
        kind: 'managed_light_caption',
        index,
        titleKey,
        captionId: item.captionId || null,
        assetId: item.assetId || null,
        matchedShotId: item.matchedShotId || null,
        startSec,
        durationSec,
        text,
        note: item.note || `${MANAGED_CAPTION_NOTE_PREFIX}${titleKey}`,
        offsetFcpTime: typeof item.offsetFcpTime === 'string' ? item.offsetFcpTime : null,
        durationFcpTime: typeof item.durationFcpTime === 'string' ? item.durationFcpTime : null,
        frameAlignment: item.frameAlignment || null,
        position: typeof item.position === 'string' ? item.position : null,
        captionKind: typeof item.captionKind === 'string' ? item.captionKind : 'content',
        fontSize: Number.isFinite(Number(item.fontSize)) ? Number(item.fontSize) : 63,
        transform: item.transform && Number.isFinite(Number(item.transform.x))
          && Number.isFinite(Number(item.transform.y))
          ? { x: Number(item.transform.x), y: Number(item.transform.y) }
          : null,
      };
    })
    .filter(Boolean);
}

function normalizeShotLayout(shot = {}) {
  const layout = shot.layout;
  if (!layout || typeof layout !== 'object') {
    return {
      mode: shot.fitMode === 'cover' ? 'center_crop' : 'native_vertical',
      conform: shot.fitMode === 'cover' ? 'fill' : 'fit',
      scale: 1,
      position: { x: 0, y: 0 },
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
      secondaryCrop: { left: 0, top: 0, right: 0, bottom: 0 },
      splitRatio: 0.5,
      blurredBackground: false,
      layeredScreen: false,
      explicit: false,
      tracking: null,
    };
  }
  const mode = String(layout.mode || 'native_vertical');
  const position = layout.position || {};
  const crop = layout.crop || {};
  const secondaryCrop = layout.secondaryCrop || {};
  return {
    mode,
    conform: ['center_crop', 'screen_focus', 'segmented_focus', 'subject_track'].includes(mode)
      ? 'fill'
      : 'fit',
    scale: Number.isFinite(Number(layout.scale)) ? Number(layout.scale) : 1,
    position: {
      x: Number.isFinite(Number(position.x)) ? Number(position.x) : 0,
      y: Number.isFinite(Number(position.y)) ? Number(position.y) : 0,
    },
    crop: {
      left: Number.isFinite(Number(crop.left)) ? Number(crop.left) : 0,
      top: Number.isFinite(Number(crop.top)) ? Number(crop.top) : 0,
      right: Number.isFinite(Number(crop.right)) ? Number(crop.right) : 0,
      bottom: Number.isFinite(Number(crop.bottom)) ? Number(crop.bottom) : 0,
    },
    secondaryCrop: {
      left: Number.isFinite(Number(secondaryCrop.left)) ? Number(secondaryCrop.left) : 0,
      top: Number.isFinite(Number(secondaryCrop.top)) ? Number(secondaryCrop.top) : 0,
      right: Number.isFinite(Number(secondaryCrop.right)) ? Number(secondaryCrop.right) : 0,
      bottom: Number.isFinite(Number(secondaryCrop.bottom)) ? Number(secondaryCrop.bottom) : 0,
    },
    splitRatio: Number.isFinite(Number(layout.splitRatio)) ? Number(layout.splitRatio) : 0.5,
    blurredBackground: mode === 'landscape_card_blur',
    layeredScreen: mode === 'screen_split',
    explicit: true,
    tracking: layout.tracking?.enabled === true ? layout.tracking : null,
  };
}

function splitScreenLayouts(layout) {
  const topRatio = Math.max(0.25, Math.min(0.75, layout.splitRatio));
  const bottomRatio = 1 - topRatio;
  return {
    top: {
      ...layout,
      mode: 'screen_focus',
      conform: 'fill',
      crop: layout.crop,
      scale: Math.max(0.1, layout.scale * topRatio),
      position: {
        x: layout.position.x,
        y: -(1 - topRatio),
      },
      blurredBackground: false,
      layeredScreen: false,
    },
    bottom: {
      ...layout,
      mode: 'screen_focus',
      conform: 'fill',
      crop: layout.secondaryCrop,
      scale: Math.max(0.1, layout.scale * bottomRatio),
      position: {
        x: layout.position.x,
        y: topRatio,
      },
      blurredBackground: false,
      layeredScreen: false,
    },
  };
}

function shotLayoutAdjustments(layout, indent = '          ') {
  const lines = [];
  const crop = layout.crop;
  // FCPXML 1.14 DTD intrinsic order is adjust-crop → adjust-conform →
  // adjust-transform. Keep this order even though all three are optional.
  if ([crop.left, crop.top, crop.right, crop.bottom].some((value) => value > 0)) {
    const percent = (value) => Number((value * 100).toFixed(4));
    lines.push(
      `${indent}<adjust-crop mode="trim">`,
      `${indent}  <trim-rect left="${percent(crop.left)}" top="${percent(crop.top)}"`
        + ` right="${percent(crop.right)}" bottom="${percent(crop.bottom)}"/>`,
      `${indent}</adjust-crop>`,
    );
  }
  lines.push(`${indent}<adjust-conform type="${layout.conform}"/>`);
  const trackingKeyframes = Array.isArray(layout.tracking?.keyframes)
    ? layout.tracking.keyframes
      .filter((item) => item
        && Number.isFinite(Number(item.position?.x))
        && Number.isFinite(Number(item.position?.y))
        && Number.isFinite(Number(item.scale))
        && typeof item.sourceTime === 'string'
        && item.sourceTime.endsWith('s'))
      .sort((left, right) => Number(left.sourceTimeSec) - Number(right.sourceTimeSec))
    : [];
  if (trackingKeyframes.length) {
    const first = trackingKeyframes[0];
    const firstX = Number((first.position.x * 100).toFixed(4));
    const firstY = Number((-first.position.y * 100).toFixed(4));
    const firstScale = Number(first.scale.toFixed(6));
    lines.push(
      `${indent}<adjust-transform position="${firstX} ${firstY}" scale="${firstScale} ${firstScale}">`,
      `${indent}  <param name="position" value="${firstX} ${firstY}">`,
      `${indent}    <keyframeAnimation>`,
      ...trackingKeyframes.map((keyframe) => {
        const x = Number((keyframe.position.x * 100).toFixed(4));
        const y = Number((-keyframe.position.y * 100).toFixed(4));
        return `${indent}      <keyframe time="${escapeXml(keyframe.sourceTime)}"`
          + ` value="${x} ${y}" curve="${keyframe.interpolation === 'linear' ? 'linear' : 'smooth'}"/>`;
      }),
      `${indent}    </keyframeAnimation>`,
      `${indent}  </param>`,
      `${indent}  <param name="scale" value="${firstScale} ${firstScale}">`,
      `${indent}    <keyframeAnimation>`,
      ...trackingKeyframes.map((keyframe) => {
        const scale = Number(keyframe.scale.toFixed(6));
        return `${indent}      <keyframe time="${escapeXml(keyframe.sourceTime)}"`
          + ` value="${scale} ${scale}" curve="${keyframe.interpolation === 'linear' ? 'linear' : 'smooth'}"/>`;
      }),
      `${indent}    </keyframeAnimation>`,
      `${indent}  </param>`,
      `${indent}</adjust-transform>`,
    );
  } else if (Math.abs(layout.scale - 1) > 1e-9
    || Math.abs(layout.position.x) > 1e-9
    || Math.abs(layout.position.y) > 1e-9) {
    const x = Number((layout.position.x * 100).toFixed(4));
    const y = Number((-layout.position.y * 100).toFixed(4));
    const scale = Number(layout.scale.toFixed(6));
    lines.push(`${indent}<adjust-transform position="${x} ${y}" scale="${scale} ${scale}"/>`);
  }
  return lines;
}

function unescapeXmlText(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractTitleManagedNote(titleXml, attrs) {
  const body = String(titleXml || '');
  // Prefer the legal <note> child. Legacy illegal note="..." is only read so
  // re-export can upgrade existing managed titles without losing identity.
  const childMatch = body.match(/<note>([\s\S]*?)<\/note>/);
  if (childMatch) {
    const note = unescapeXmlText(childMatch[1]).trim();
    if (note.startsWith(MANAGED_CAPTION_NOTE_PREFIX)) return note;
  }
  const attrNote = String(attrs || '').match(/\bnote="([^"]*)"/)?.[1] || '';
  const legacy = unescapeXmlText(attrNote).trim();
  if (legacy.startsWith(MANAGED_CAPTION_NOTE_PREFIX)) return legacy;
  return '';
}

function extractManagedCaptionTitles(xml) {
  const source = String(xml || '');
  const titles = [];
  const pattern = /<title\s+([^>]+)>[\s\S]*?<\/title>/g;
  let match = pattern.exec(source);
  while (match) {
    const attrs = match[1];
    const note = extractTitleManagedNote(match[0], attrs);
    if (!note.startsWith(MANAGED_CAPTION_NOTE_PREFIX)) {
      match = pattern.exec(source);
      continue;
    }
    const titleKey = note.slice(MANAGED_CAPTION_NOTE_PREFIX.length);
    const textMatch = match[0].match(/<text-style[^>]*>([\s\S]*?)<\/text-style>/);
    const rawText = textMatch ? textMatch[1] : '';
    const text = unescapeXmlText(rawText);
    titles.push({
      titleKey,
      note,
      text,
      offset: attrs.match(/\boffset="([^"]+)"/)?.[1] || null,
      duration: attrs.match(/\bduration="([^"]+)"/)?.[1] || null,
      name: attrs.match(/\bname="([^"]*)"/)?.[1] || null,
    });
    match = pattern.exec(source);
  }
  return titles;
}

function resolveFcpxmlTitles(analysis, managedCaptionTitles = []) {
  const provided = normalizeManagedCaptionTitles(managedCaptionTitles);
  const auto = provided.length > 0
    ? []
    : normalizeManagedCaptionTitles(buildManagedCaptionTitlesFromAnalysis({ analysis }));
  const managedTitles = provided.length > 0 ? provided : auto;
  // lightCaptionPlan is the official Title source. Marker.subtitle remains a
  // legacy opt-in only when the plan did not already produce managed Titles.
  const markerTitles = managedTitles.length > 0 ? [] : collectFcpTitles(analysis);
  return { markerTitles, managedTitles };
}

function buildFcpxml({ projectName, analysis, assetMappings, managedCaptionTitles = [] }) {
  const manifest = {
    items: assetMappings.map((mapping) => ({
      assetId: mapping.assetId,
      type: mapping.type,
      metadata: mapping.metadata,
    })),
  };
  const timelineFormat = resolveTimelineFormat(analysis, manifest);
  analysis = {
    ...analysis,
    timeline: { ...analysis.timeline, ...timelineFormat },
  };
  const mappingById = new Map(assetMappings.map((mapping) => [mapping.assetId, mapping]));
  const analysisById = new Map(
    (Array.isArray(analysis.assets) ? analysis.assets : []).map((asset) => [asset.assetId, asset]),
  );
  const { markerTitles, managedTitles } = resolveFcpxmlTitles(analysis, managedCaptionTitles);
  const fcpTitles = [
    ...markerTitles,
    ...managedTitles.map((title, index) => ({
      ...title,
      index: markerTitles.length + index,
    })),
  ];
  const formatResources = [];
  const formatByKey = new Map();
  let nextResourceId = 1;

  const addFormat = (width, height, fps, isStill = false) => {
    const key = createFormatKey(width, height, fps, isStill);
    if (formatByKey.has(key)) return formatByKey.get(key);
    const id = `r${nextResourceId++}`;
    const format = {
      id,
      width: width || analysis.timeline.width,
      height: height || analysis.timeline.height,
      fps: fps || analysis.timeline.fps,
      isStill,
    };
    formatByKey.set(key, id);
    formatResources.push(format);
    return id;
  };

  const sequenceFormatId = addFormat(
    analysis.timeline.width,
    analysis.timeline.height,
    analysis.timeline.fps,
  );
  const assets = [];
  const assetResourceById = new Map();
  for (const mapping of assetMappings) {
    const names = normalizeFcpNames({ filename: mapping.projectFilename });
    const metadata = mapping.metadata || {};
    const formatId = mapping.type === 'video'
      ? addFormat(
        metadata.displayWidth || metadata.width,
        metadata.displayHeight || metadata.height,
        metadata.frameRate || analysis.timeline.fps,
      )
      : addFormat(
        metadata.displayWidth || metadata.width,
        metadata.displayHeight || metadata.height,
        null,
        true,
      );
    const resourceId = `r${nextResourceId++}`;
    assetResourceById.set(mapping.assetId, resourceId);
    assets.push({ ...mapping, projectFilename: names.filename, formatId, resourceId });
  }
  const titleEffectId = fcpTitles.length > 0 ? `r${nextResourceId++}` : null;
  const blurEffectId = analysis.timeline.shots.some(
    (shot) => normalizeShotLayout(shot).blurredBackground,
  ) ? `r${nextResourceId++}` : null;

  const timelinePlan = planFrameAlignedTimeline({ analysis, assetMappings });
  const sequenceFrameDuration = timelinePlan.sequenceFrameDuration;

  const markerByShotId = new Map();
  for (const marker of analysis.timeline.markers) {
    const mapped = getPlannedShotAtOriginalTime(
      analysis.timeline.shots,
      timelinePlan.shots,
      marker.timeSec,
    );
    if (!mapped) continue;
    const markers = markerByShotId.get(mapped.planned.shot.id) || [];
    markers.push({
      ...marker,
      sourceTimeSec: mapped.sourceTimeSec,
      relativeSec: mapped.relativeSec,
    });
    markerByShotId.set(mapped.planned.shot.id, markers);
  }
  const titleByShotId = new Map();
  for (const title of fcpTitles) {
    let planned = null;
    let sourceTimeSec = null;
    let relativeSec = null;
    if (title.matchedShotId) {
      planned = timelinePlan.shots.find((entry) => entry.shot.id === title.matchedShotId) || null;
      if (planned && Number.isFinite(title.startSec)) {
        relativeSec = Math.min(
          Math.max(0, title.startSec - planned.timelineStartSec),
          planned.durationSec,
        );
        sourceTimeSec = planned.sourceInSec + relativeSec;
      }
    }
    if (!planned) {
      const mapped = getPlannedShotAtOriginalTime(
        analysis.timeline.shots,
        timelinePlan.shots,
        title.startSec,
      );
      if (!mapped) continue;
      planned = mapped.planned;
      sourceTimeSec = mapped.sourceTimeSec;
      relativeSec = mapped.relativeSec;
    }
    const titles = titleByShotId.get(planned.shot.id) || [];
    const maxDurationSec = Math.max(
      rationalToSeconds(timelinePlan.sequenceFrameRational),
      planned.durationSec - relativeSec,
    );
    const durationSec = Math.min(title.durationSec, maxDurationSec);
    titles.push({
      ...title,
      sourceTimeSec,
      relativeSec,
      durationSec,
    });
    titleByShotId.set(planned.shot.id, titles);
  }

  const resourcesXml = [
    ...formatResources.map((format) => (
      `    <format id="${format.id}"${format.isStill ? '' : ` frameDuration="${frameDuration(format.fps)}"`}`
      + ` width="${format.width}" height="${format.height}" colorSpace="1-1-1 (Rec. 709)"/>`
    )),
    ...assets.map((asset) => {
      const metadata = asset.metadata || {};
      const assetDuration = quantizeAssetResourceDuration(asset, sequenceFrameDuration);
      const audioChannels = Number.isInteger(metadata.audioChannels) && metadata.audioChannels > 0
        ? metadata.audioChannels
        : 1;
      const audioRate = Number.isInteger(metadata.sampleRate) && metadata.sampleRate > 0
        ? metadata.sampleRate
        : 48000;
      const audioAttributes = metadata.hasAudio
        ? ` hasAudio="1" audioSources="1" audioChannels="${audioChannels}" audioRate="${audioRate}"`
        : '';
      return `    <asset id="${asset.resourceId}" name="${escapeXml(asset.projectFilename)}"`
        + ` uid="${assetUid(asset)}"`
        + ` start="0s" duration="${asset.type === 'video' ? assetDuration.durationTime : '0s'}"`
        + ` hasVideo="1" videoSources="1"${audioAttributes}`
        + ` format="${asset.formatId}">\n`
        + `      <media-rep kind="original-media" src="${escapeXml(pathToFileURL(asset.projectAbsolutePath).href)}"/>\n`
        + '    </asset>';
    }),
    ...(titleEffectId ? [
      `    <effect id="${titleEffectId}" name="${escapeXml(BASIC_TITLE_EFFECT.name)}"`
      + ` uid="${escapeXml(BASIC_TITLE_EFFECT.uid)}"/>`,
    ] : []),
    ...(blurEffectId ? [
      `    <effect id="${blurEffectId}" name="${escapeXml(GAUSSIAN_BLUR_EFFECT.name)}"`
      + ` uid="${escapeXml(GAUSSIAN_BLUR_EFFECT.uid)}"/>`,
    ] : []),
  ].join('\n');

  const clipsXml = timelinePlan.shots.map((planned) => {
    const shot = planned.shot;
    const mapping = planned.mapping || mappingById.get(shot.assetId);
    const resourceId = assetResourceById.get(shot.assetId);
    if (!mapping || !resourceId) throw new Error(`FCPXML 缺少镜头素材映射：${shot.assetId}`);
    const safeMappingName = sanitizeFcpFilename(mapping.projectFilename, '未命名素材');
    const layout = normalizeShotLayout(shot);
    const intrinsicItems = [];
    const anchorItems = [];
    const markerItems = [];
    const videoFilterItems = [];
    const screenLayers = layout.layeredScreen ? splitScreenLayouts(layout) : null;
    if (layout.blurredBackground) {
      intrinsicItems.push('          <adjust-conform type="fill"/>');
      videoFilterItems.push(`          <filter-video ref="${blurEffectId}"/>`);
    } else if (screenLayers) {
      intrinsicItems.push(...shotLayoutAdjustments(screenLayers.top));
    } else {
      intrinsicItems.push(...shotLayoutAdjustments(layout));
    }
    if (fcpxmlShouldMuteShot(shot, analysisById.get(shot.assetId), mapping)) {
      intrinsicItems.push('          <adjust-volume amount="-96dB"/>');
    }
    const stillTimeOffset = mapping.type === 'image' ? 3600 : 0;
    const clipStartSec = stillTimeOffset + planned.sourceInSec;
    const clipEndSec = clipStartSec + planned.durationSec;

    for (const title of titleByShotId.get(shot.id) || []) {
      const titleFontSize = Number.isFinite(Number(title.fontSize))
        ? Number(title.fontSize)
        : 46;
      const titleOffsetSec = stillTimeOffset + title.sourceTimeSec;
      const useExactManagedTimes = title.kind === 'managed_light_caption'
        && title.offsetFcpTime
        && title.durationFcpTime;
      let offsetTime;
      let durationTime;
      if (useExactManagedTimes) {
        // Re-clamp pre-aligned managed captions into the quantized parent clip.
        const offsetRational = parseFcpTimeRational(title.offsetFcpTime);
        const durationRational = parseFcpTimeRational(title.durationFcpTime);
        let startFrame = rationalToFrameIndex(offsetRational, sequenceFrameDuration, 'nearest');
        let endFrame = startFrame + Math.max(
          1,
          rationalToFrameIndex(durationRational, sequenceFrameDuration, 'nearest'),
        );
        const minFrame = secondsToFrameIndex(clipStartSec, sequenceFrameDuration, 'ceil');
        const maxFrame = secondsToFrameIndex(clipEndSec, sequenceFrameDuration, 'floor');
        if (maxFrame - minFrame >= 1) {
          startFrame = Math.min(Math.max(startFrame, minFrame), maxFrame - 1);
          endFrame = Math.min(Math.max(endFrame, startFrame + 1), maxFrame);
        }
        offsetTime = fcpTimeFromFrameIndex(startFrame, sequenceFrameDuration);
        durationTime = fcpTimeFromFrameIndex(endFrame - startFrame, sequenceFrameDuration);
      } else {
        const quantizedTitle = quantizeCaptionTiming({
          startSec: titleOffsetSec,
          endSec: titleOffsetSec + title.durationSec,
          minSec: clipStartSec,
          maxSec: clipEndSec,
          frameDuration: sequenceFrameDuration,
        });
        if (quantizedTitle.ok) {
          offsetTime = quantizedTitle.startTime;
          durationTime = quantizedTitle.durationTime;
        } else {
          // Fallback: one frame at the clamped start.
          const startFrame = Math.min(
            secondsToFrameIndex(clipEndSec, sequenceFrameDuration, 'floor') - 1,
            Math.max(
              secondsToFrameIndex(clipStartSec, sequenceFrameDuration, 'ceil'),
              secondsToFrameIndex(titleOffsetSec, sequenceFrameDuration, 'nearest'),
            ),
          );
          offsetTime = fcpTimeFromFrameIndex(Math.max(0, startFrame), sequenceFrameDuration);
          durationTime = fcpTimeFromFrameIndex(1, sequenceFrameDuration);
        }
      }
      const noteChild = title.note
        ? `            <note>${escapeXml(title.note)}</note>\n`
        : '';
      anchorItems.push(
        `          <title ref="${titleEffectId}" lane="1" offset="${offsetTime}"`
        + ` name="${escapeXml(`${title.text} - ${BASIC_TITLE_EFFECT.name}`)}"`
        + ` start="3600s" duration="${durationTime}">\n`
        // Basic Title's Flatten=0 is the native 3D-text mode.  The remaining
        // switches are published by the installed Basic Title template and
        // keep the Title editable in FCP's Text inspector.
        + '            <param name="展平" key="9999/999166631/999166633/2/351" value="0"/>\n'
        + '            <param name="对齐" key="9999/999166631/999166633/2/354/999169573/401" value="1 (居中)"/>\n'
        + (title.transform
          ? `            <param name="位置" key="9999/999166631/999166633/1/100/101"`
            + ` value="${title.transform.x} ${title.transform.y}"/>\n`
          : '')
        + '            <text>\n'
        + `              <text-style ref="ts-title-${title.index + 1}">${escapeXml(title.text)}</text-style>\n`
        + '            </text>\n'
        + `            <text-style-def id="ts-title-${title.index + 1}">\n`
        + `              <text-style font="Helvetica" fontSize="${titleFontSize}" fontFace="Regular"`
        + ' fontColor="1 1 1 1" alignment="center" strokeColor="0 0 0 0.9" strokeWidth="-4"'
        + ' shadowColor="0 0 0 0.85" shadowOffset="0 -6" shadowBlurRadius="12"/>\n'
        + '            </text-style-def>\n'
        + noteChild
        + '          </title>',
      );
    }
    // FCPXML 1.14 的 DTD 要求锚定项（Title 等）位于 Marker 之前。
    for (const marker of markerByShotId.get(shot.id) || []) {
      const rawMarkerSec = stillTimeOffset + marker.sourceTimeSec;
      let markerFrame = secondsToFrameIndex(rawMarkerSec, sequenceFrameDuration, 'nearest');
      const minMarkerFrame = secondsToFrameIndex(clipStartSec, sequenceFrameDuration, 'nearest');
      const maxMarkerFrame = Math.max(
        minMarkerFrame,
        secondsToFrameIndex(clipEndSec, sequenceFrameDuration, 'floor') - 1,
      );
      markerFrame = Math.min(Math.max(markerFrame, minMarkerFrame), maxMarkerFrame);
      const markerStart = fcpTimeFromFrameIndex(markerFrame, sequenceFrameDuration);
      markerItems.push(
        `          <marker start="${markerStart}"`
        + ` duration="${sequenceFrameDuration}" value="${escapeXml(marker.text)}"/>`,
      );
    }
    const audioRole = mapping.metadata?.hasAudio ? ' audioRole="dialogue"' : '';
    const clipElement = mapping.type === 'image' ? 'video' : 'asset-clip';
    // Keep the historical 3600/1s still origin so existing FCP projects stay stable.
    const startTime = mapping.type === 'image' && planned.sourceInSec === 0
      ? '3600/1s'
      : fcpTimeAligned(clipStartSec, sequenceFrameDuration, 'nearest');
    if (layout.blurredBackground) {
      const foregroundTag = mapping.type === 'image' ? 'video' : 'asset-clip';
      anchorItems.push(
        `          <${foregroundTag} name="${escapeXml(`${safeMappingName} · 完整横屏卡片`)}"`
        + ` ref="${resourceId}" lane="1" offset="${startTime}" start="${startTime}"`
        + ` duration="${planned.durationTime}">\n`
        + `${shotLayoutAdjustments({ ...layout, conform: 'fit', blurredBackground: false }, '            ').join('\n')}\n`
        + (mapping.metadata?.hasAudio ? '            <adjust-volume amount="-96dB"/>\n' : '')
        + `          </${foregroundTag}>`,
      );
    }
    if (screenLayers) {
      const secondaryTag = mapping.type === 'image' ? 'video' : 'asset-clip';
      anchorItems.push(
        `          <${secondaryTag} name="${escapeXml(`${safeMappingName} · 上下双层录屏 · 关键区域`)}"`
        + ` ref="${resourceId}" lane="1" offset="${startTime}" start="${startTime}"`
        + ` duration="${planned.durationTime}">\n`
        + `${shotLayoutAdjustments(screenLayers.bottom, '            ').join('\n')}\n`
        + (mapping.metadata?.hasAudio ? '            <adjust-volume amount="-96dB"/>\n' : '')
        + `          </${secondaryTag}>`,
      );
    }
    // FCPXML 1.14 DTD container order is intrinsic params, anchored items,
    // markers, then video filters. In particular, a blur filter cannot precede
    // titles or the foreground card that it visually sits behind.
    const nested = [
      ...intrinsicItems,
      ...anchorItems,
      ...markerItems,
      ...videoFilterItems,
    ];
    const clip = `        <${clipElement} name="${escapeXml(safeMappingName)}" ref="${resourceId}"`
      + ` offset="${planned.offsetTime}" start="${startTime}"`
      + ` duration="${planned.durationTime}"${audioRole}>\n`
      + `${nested.join('\n')}\n`
      + `        </${clipElement}>`;
    return clip;
  }).join('\n');

  const hasTransformKeyframes = analysis.timeline.shots.some((shot) => (
    Array.isArray(shot.layout?.tracking?.keyframes)
    && shot.layout.tracking.keyframes.length > 0
  ));
  const fcpxmlVersion = fcpTitles.length > 0 || hasTransformKeyframes
    ? FCPXML_TITLE_VERSION
    : FCPXML_DEFAULT_VERSION;
  const names = normalizeFcpNames({
    eventName: projectName,
    projectName: analysis.titles.recommended,
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="${fcpxmlVersion}">
  <resources>
${resourcesXml}
  </resources>
  <library>
    <event name="${escapeXml(names.eventName)}">
      <project name="${escapeXml(names.projectName)}">
        <sequence duration="${timelinePlan.totalDurationTime}" format="${sequenceFormatId}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${clipsXml}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

function extractTopLevelSpineClips(xml) {
  const body = String(xml || '').match(/<spine>([\s\S]*?)<\/spine>/)?.[1] || '';
  const tags = [];
  const stack = [];
  const tokenPattern = /<\/?([a-zA-Z0-9-]+)\b([^>]*)\/?>/g;
  let match = tokenPattern.exec(body);
  while (match) {
    const raw = match[0];
    const name = match[1];
    const closing = raw.startsWith('</');
    const selfClosing = /\/>$/.test(raw);
    if (closing) {
      stack.pop();
    } else {
      if (stack.length === 0 && ['asset-clip', 'video', 'gap', 'clip'].includes(name)) {
        tags.push({
          tag: name,
          attrs: match[2] || '',
          ref: (match[2] || '').match(/\bref="([^"]+)"/)?.[1] || null,
        });
      }
      if (!selfClosing) stack.push(name);
    }
    match = tokenPattern.exec(body);
  }
  return tags;
}

const FCPXML_ANCHOR_ITEM_NAMES = new Set([
  'audio',
  'video',
  'clip',
  'title',
  'caption',
  'mc-clip',
  'ref-clip',
  'sync-clip',
  'asset-clip',
  'audition',
  'spine',
  'live-drawing',
]);
const FCPXML_MARKER_ITEM_NAMES = new Set([
  'marker',
  'chapter-marker',
  'rating',
  'keyword',
  'analysis-marker',
  'hidden-clip-marker',
]);
const FCPXML_VIDEO_INTRINSIC_ORDER = [
  'object-tracker',
  'adjust-crop',
  'adjust-corners',
  'adjust-conform',
  'adjust-transform',
  'adjust-blend',
  'adjust-stabilization',
  'adjust-rollingShutter',
  'adjust-360-transform',
  'adjust-reorient',
  'adjust-orientation',
  'adjust-cinematic',
  'adjust-colorConform',
  'adjust-stereo-3D',
];

function extractFcpxmlContainerChildren(xml) {
  const targets = new Set(['video', 'asset-clip']);
  const records = [];
  const stack = [];
  const tokenPattern = /<\/?([a-zA-Z0-9-]+)\b[^>]*\/?>/g;
  let match = tokenPattern.exec(String(xml || ''));
  while (match) {
    const raw = match[0];
    const name = match[1];
    const closing = raw.startsWith('</');
    const selfClosing = /\/>$/.test(raw);
    if (closing) {
      while (stack.length) {
        const current = stack.pop();
        if (current.name === name) break;
      }
    } else {
      const parent = stack[stack.length - 1];
      if (parent?.record) parent.record.children.push(name);
      const record = targets.has(name) ? { name, children: [] } : null;
      if (record) records.push(record);
      if (!selfClosing) stack.push({ name, record });
    }
    match = tokenPattern.exec(String(xml || ''));
  }
  return records;
}

function validateFcpxmlContainerOrder(xml) {
  const errors = [];
  for (const record of extractFcpxmlContainerChildren(xml)) {
    let previousPhase = -1;
    let previousIntrinsic = -1;
    for (const child of record.children) {
      let phase = null;
      let intrinsicIndex = FCPXML_VIDEO_INTRINSIC_ORDER.indexOf(child);
      if (record.name === 'video') {
        if (child === 'param') phase = 0;
        else if (child === 'note') phase = 1;
        else if (child === 'conform-rate' || child === 'timeMap') phase = 2;
        else if (intrinsicIndex >= 0) phase = 3;
        else if (FCPXML_ANCHOR_ITEM_NAMES.has(child)) phase = 4;
        else if (FCPXML_MARKER_ITEM_NAMES.has(child)) phase = 5;
        else if (child === 'filter-video' || child === 'filter-video-mask') phase = 6;
        else if (child === 'reserved') phase = 7;
        else if (child === 'adjust-volume' || child === 'adjust-panner') {
          errors.push(`video 元素不能直接包含 ${child}。`);
        }
      } else {
        if (child === 'note') phase = 0;
        else if (child === 'conform-rate' || child === 'timeMap') phase = 1;
        else if (intrinsicIndex >= 0) phase = 2;
        else if (child === 'adjust-volume' || child === 'adjust-panner') {
          phase = 2;
          intrinsicIndex = FCPXML_VIDEO_INTRINSIC_ORDER.length
            + (child === 'adjust-volume' ? 0 : 1);
        } else if (FCPXML_ANCHOR_ITEM_NAMES.has(child)) phase = 3;
        else if (FCPXML_MARKER_ITEM_NAMES.has(child)) phase = 4;
        else if (child === 'audio-channel-source') phase = 5;
        else if (child === 'filter-video' || child === 'filter-video-mask') phase = 6;
        else if (child === 'filter-audio') phase = 7;
        else if (child === 'metadata' || child === 'reserved') phase = 8;
      }
      if (phase == null) continue;
      if (phase < previousPhase) {
        errors.push(`${record.name} 子元素顺序不符合 FCPXML 1.14 DTD：${child} 出现在不合法位置。`);
        break;
      }
      if ((record.name === 'video' && phase === 3)
        || (record.name === 'asset-clip' && phase === 2)) {
        if (intrinsicIndex >= 0 && intrinsicIndex < previousIntrinsic) {
          errors.push(`${record.name} 内在参数顺序不符合 FCPXML 1.14 DTD：${child}。`);
          break;
        }
        previousIntrinsic = Math.max(previousIntrinsic, intrinsicIndex);
      }
      previousPhase = phase;
    }
  }
  return errors;
}

function validateFcpxmlStructure(xml, expected = {}) {
  const errors = [];
  if (!/^<\?xml[^>]*encoding="UTF-8"[^>]*\?>/i.test(xml)) {
    errors.push('FCPXML 缺少 UTF-8 XML 声明。');
  }
  // Keep this explicit even when xmllint is unavailable; Final Cut refuses
  // several otherwise well-formed documents without the FCPXML doctype.
  if (!/<!DOCTYPE\s+fcpxml\s*>/i.test(xml)) errors.push('FCPXML 缺少 <!DOCTYPE fcpxml>。');
  const version = xml.match(/<fcpxml\s+version="([^"]+)">/)?.[1] || null;
  if (![FCPXML_DEFAULT_VERSION, FCPXML_TITLE_VERSION].includes(version)) {
    errors.push('缺少受支持的 FCPXML 1.10/1.14 根节点。');
  }
  if (!/<resources>[\s\S]*<\/resources>/.test(xml)) errors.push('缺少 resources。');
  if (!/<sequence\b[^>]*>[\s\S]*<spine>[\s\S]*<\/spine>/.test(xml)) errors.push('缺少 sequence/spine。');
  errors.push(...validateFcpxmlContainerOrder(xml));
  const assets = [...xml.matchAll(/<asset\s+id="([^"]+)"/g)];
  const allClips = [...xml.matchAll(/<(?:asset-clip|video)\s+[^>]*ref="([^"]+)"[^>]*>/g)];
  const clips = extractTopLevelSpineClips(xml)
    .filter((clip) => clip.ref)
    .map((clip) => [null, clip.ref]);
  const markers = [...xml.matchAll(/<marker\s+/g)];
  const transformKeyframeAnimations = [...xml.matchAll(
    /<keyframeAnimation>([\s\S]*?)<\/keyframeAnimation>/g,
  )].map((animation) => (
    [...animation[1].matchAll(/<keyframe\s+time="([^"]+)"\s+value="([^"]+)"/g)]
      .map((match) => ({ time: match[1], value: match[2] }))
  ));
  const transformKeyframes = transformKeyframeAnimations.flat();
  const effects = [...xml.matchAll(/<effect\s+([^>]+)\/>/g)].map((match) => ({
    id: match[1].match(/\bid="([^"]+)"/)?.[1] || null,
    uid: match[1].match(/\buid="([^"]+)"/)?.[1] || null,
  }));
  const titleBlocks = [...xml.matchAll(/<title\s+([^>]+)>[\s\S]*?<\/title>/g)];
  const titles = titleBlocks.map((match) => ({
    attrs: match[1],
    xml: match[0],
    ref: match[1].match(/\bref="([^"]+)"/)?.[1] || null,
    lane: Number(match[1].match(/\blane="([^"]+)"/)?.[1]),
    offset: match[1].match(/\boffset="([^"]+)"/)?.[1] || null,
    duration: match[1].match(/\bduration="([^"]+)"/)?.[1] || null,
    hasIllegalNoteAttribute: /\bnote\s*=/.test(match[1]),
    noteChild: (() => {
      const noteMatch = match[0].match(/<note>([\s\S]*?)<\/note>/);
      return noteMatch ? unescapeXmlText(noteMatch[1]).trim() : null;
    })(),
    noteOrderOk: (() => {
      const body = match[0];
      if (!/<note>/.test(body)) return true;
      // DTD order: param*, text*, text-style-def*, note?
      const noteIndex = body.search(/<note>/);
      const afterStyleDefs = body.search(/<\/text-style-def>/);
      const lastTextClose = (() => {
        let index = -1;
        const re = /<\/text>/g;
        let found = re.exec(body);
        while (found) {
          index = found.index + found[0].length;
          found = re.exec(body);
        }
        return index;
      })();
      const minIndex = Math.max(afterStyleDefs >= 0 ? afterStyleDefs : -1, lastTextClose);
      if (minIndex < 0) return noteIndex > body.indexOf('>');
      return noteIndex > minIndex;
    })(),
  }));
  const mediaRepresentations = [...xml.matchAll(/<media-rep\s+[^>]*src="([^"]+)"/g)];
  const namedElements = [
    ...[...xml.matchAll(/<(event|project|asset|asset-clip|video)\s+([^>]+)>/g)].map((match) => ({
      kind: match[1],
      value: match[2].match(/\bname="([^"]*)"/)?.[1] || '',
    })),
  ];
  for (const named of namedElements) {
    const name = unescapeXmlText(named.value);
    if (!isLegalFcpName(name)) {
      errors.push(`${named.kind} name 非法，不能包含路径分隔符、&、单双引号、尖括号或换行：${name || '空名称'}`);
    }
  }
  const resourceMediaById = new Map(
    [...xml.matchAll(/<asset\s+id="([^"]+)"[\s\S]*?<media-rep\s+[^>]*src="([^"]+)"/g)]
      .map((match) => [match[1], match[2]]),
  );
  const clipMediaUrls = clips.map((clip) => resourceMediaById.get(clip[1]) || null);
  const sequenceFormatId = xml.match(/<sequence\b[^>]*\bformat="([^"]+)"/)?.[1] || null;
  const formatTags = [...xml.matchAll(/<format\s+([^>]+)\/>/g)].map((match) => {
    const attributes = match[1];
    return {
      id: attributes.match(/\bid="([^"]+)"/)?.[1] || null,
      width: Number(attributes.match(/\bwidth="([^"]+)"/)?.[1]) || null,
      height: Number(attributes.match(/\bheight="([^"]+)"/)?.[1]) || null,
      frameDuration: attributes.match(/\bframeDuration="([^"]+)"/)?.[1] || null,
    };
  });
  const sequenceFormat = formatTags.find((format) => format.id === sequenceFormatId) || null;
  const assetIds = new Set(assets.map((match) => match[1]));
  const effectIds = new Set(effects.map((effect) => effect.id));
  for (const clip of allClips) {
    if (!assetIds.has(clip[1])) errors.push(`时间线镜头引用了不存在的资源 ${clip[1]}。`);
  }
  for (const media of mediaRepresentations) {
    if (!media[1].startsWith('file://') || /[\u0000-\u001f\u007f\r\n]/.test(media[1])) {
      errors.push('素材资源不是合法 file URL。');
    }
  }
  const managedTitleKeys = [];
  const sequenceDurationMatch = xml.match(/<sequence\b[^>]*\bduration="([^"]+)"/);
  let sequenceDurationRational = null;
  try {
    sequenceDurationRational = sequenceDurationMatch
      ? parseFcpTimeRational(sequenceDurationMatch[1])
      : null;
  } catch {
    sequenceDurationRational = null;
  }
  let sequenceFrameRational = null;
  try {
    sequenceFrameRational = sequenceFormat?.frameDuration
      ? parseFcpTimeRational(sequenceFormat.frameDuration)
      : (Number.isFinite(expected.fps) ? frameDurationRational(expected.fps) : null);
  } catch {
    sequenceFrameRational = null;
  }
  for (const animation of transformKeyframeAnimations) {
    let previousTransformTime = null;
    for (const keyframe of animation) {
      try {
        const time = parseFcpTimeRational(keyframe.time);
        if (sequenceFrameRational && !isRationalMultiple(time, sequenceFrameRational)) {
          errors.push(`transform 关键帧未对齐帧边界：${keyframe.time}。`);
        }
        const timeSec = rationalToSeconds(time);
        if (previousTransformTime != null && timeSec < previousTransformTime - 1e-9) {
          errors.push('transform 关键帧时间顺序不合法。');
        }
        previousTransformTime = timeSec;
        const values = keyframe.value.trim().split(/\s+/).map(Number);
        if (!values.length || values.some((value) => !Number.isFinite(value))) {
          errors.push(`transform 关键帧数值无效：${keyframe.value}。`);
        }
      } catch (error) {
        errors.push(`transform 关键帧时间无法解析：${error.message}`);
      }
    }
  }

  // Parent clip bounds for managed-title containment checks.
  const clipBlocks = [...xml.matchAll(
    /<(asset-clip|video)\s+([^>]+)>([\s\S]*?)<\/\1>/g,
  )].map((match) => {
    const attrs = match[2];
    return {
      offset: attrs.match(/\boffset="([^"]+)"/)?.[1] || null,
      start: attrs.match(/\bstart="([^"]+)"/)?.[1] || null,
      duration: attrs.match(/\bduration="([^"]+)"/)?.[1] || null,
      body: match[3],
    };
  });

  for (const title of titles) {
    if (!effectIds.has(title.ref)) errors.push(`标题引用了不存在的 effect ${title.ref}。`);
    if (!(title.lane > 0)) errors.push('标题必须位于主时间线上方的正 lane。');
    if (!title.offset || !title.duration) errors.push('标题缺少 offset 或 duration。');
    if (title.hasIllegalNoteAttribute) {
      errors.push('title 元素含有非法 note 属性（FCPXML DTD 仅允许 <note> 子元素）。');
    }
    if (title.noteChild != null && !title.noteOrderOk) {
      errors.push('title 的 <note> 子元素顺序不合法（应位于 text / text-style-def 之后）。');
    }
    const isManaged = Boolean(
      title.noteChild && title.noteChild.startsWith(MANAGED_CAPTION_NOTE_PREFIX),
    );
    if (isManaged) {
      const titleKey = title.noteChild.slice(MANAGED_CAPTION_NOTE_PREFIX.length);
      if (!titleKey) {
        errors.push('受管 title 的 titleKey 为空。');
      } else {
        managedTitleKeys.push(titleKey);
      }

      let offsetRational = null;
      let durationRational = null;
      try {
        offsetRational = parseFcpTimeRational(title.offset);
        durationRational = parseFcpTimeRational(title.duration);
      } catch (error) {
        errors.push(`受管 title 时间无法解析（${titleKey || 'unknown'}）：${error.message}`);
      }

      if (offsetRational && durationRational) {
        const durationSeconds = rationalToSeconds(durationRational);
        if (!(durationSeconds > 0)) {
          errors.push(`受管 title 时长必须大于 0：${titleKey || title.offset}`);
        }
        if (sequenceFrameRational) {
          if (!isRationalMultiple(offsetRational, sequenceFrameRational)) {
            errors.push(
              `受管 title offset 未对齐帧边界：${title.offset}（frameDuration=${sequenceFormat?.frameDuration || formatFcpRational(sequenceFrameRational.numerator, sequenceFrameRational.denominator)}）`,
            );
          }
          if (!isRationalMultiple(durationRational, sequenceFrameRational)) {
            errors.push(
              `受管 title duration 未对齐帧边界：${title.duration}（frameDuration=${sequenceFormat?.frameDuration || formatFcpRational(sequenceFrameRational.numerator, sequenceFrameRational.denominator)}）`,
            );
          }
          const endRational = reduceRational(
            offsetRational.numerator * durationRational.denominator
              + durationRational.numerator * offsetRational.denominator,
            offsetRational.denominator * durationRational.denominator,
          );
          if (!isRationalMultiple(endRational, sequenceFrameRational)) {
            errors.push(
              `受管 title 结束时间未对齐帧边界：${formatFcpRational(endRational.numerator, endRational.denominator)}`,
            );
          }
        }

        const parent = clipBlocks.find((clip) => title.xml && clip.body.includes(title.xml));
        if (parent?.start && parent?.duration && parent?.offset) {
          try {
            const clipStart = parseFcpTimeRational(parent.start);
            const clipDuration = parseFcpTimeRational(parent.duration);
            const clipOffset = parseFcpTimeRational(parent.offset);
            const clipEnd = reduceRational(
              clipStart.numerator * clipDuration.denominator
                + clipDuration.numerator * clipStart.denominator,
              clipStart.denominator * clipDuration.denominator,
            );
            const titleEnd = reduceRational(
              offsetRational.numerator * durationRational.denominator
                + durationRational.numerator * offsetRational.denominator,
              offsetRational.denominator * durationRational.denominator,
            );
            const startSec = rationalToSeconds(offsetRational);
            const endSec = rationalToSeconds(titleEnd);
            const clipStartSec = rationalToSeconds(clipStart);
            const clipEndSec = rationalToSeconds(clipEnd);
            if (startSec < clipStartSec - 1e-9 || endSec > clipEndSec + 1e-9) {
              errors.push(`受管 title 越过所属镜头范围：${titleKey || title.offset}`);
            }

            // Absolute timeline position = clip.offset + (title.offset - clip.start)
            const relativeStart = reduceRational(
              offsetRational.numerator * clipStart.denominator
                - clipStart.numerator * offsetRational.denominator,
              offsetRational.denominator * clipStart.denominator,
            );
            const absoluteStart = reduceRational(
              clipOffset.numerator * relativeStart.denominator
                + relativeStart.numerator * clipOffset.denominator,
              clipOffset.denominator * relativeStart.denominator,
            );
            const absoluteEnd = reduceRational(
              absoluteStart.numerator * durationRational.denominator
                + durationRational.numerator * absoluteStart.denominator,
              absoluteStart.denominator * durationRational.denominator,
            );
            if (sequenceDurationRational
              && rationalToSeconds(absoluteEnd) > rationalToSeconds(sequenceDurationRational) + 1e-9) {
              errors.push(`受管 title 越过项目总时长：${titleKey || title.offset}`);
            }
          } catch (error) {
            errors.push(`受管 title 镜头边界校验失败：${error.message}`);
          }
        }
      }
    }
  }
  const duplicateTitleKeys = managedTitleKeys.filter((key, index) => managedTitleKeys.indexOf(key) !== index);
  if (duplicateTitleKeys.length > 0) {
    errors.push(`受管 titleKey 不唯一：${[...new Set(duplicateTitleKeys)].join('、')}`);
  }
  if (Number.isInteger(expected.shotCount) && clips.length !== expected.shotCount) {
    errors.push(`时间线镜头数量 ${clips.length} 与镜头数 ${expected.shotCount} 不一致。`);
  }
  if (Number.isInteger(expected.assetCount) && assets.length !== expected.assetCount) {
    errors.push(`asset 数量 ${assets.length} 与独立素材数 ${expected.assetCount} 不一致。`);
  }
  if (Number.isInteger(expected.markerCount) && markers.length !== expected.markerCount) {
    errors.push(`marker 数量 ${markers.length} 与分析结果 ${expected.markerCount} 不一致。`);
  }
  if (Number.isInteger(expected.titleCount) && titles.length !== expected.titleCount) {
    errors.push(`title 数量 ${titles.length} 与分析结果 ${expected.titleCount} 不一致。`);
  }
  if (Array.isArray(expected.clipMediaUrls)
    && JSON.stringify(clipMediaUrls) !== JSON.stringify(expected.clipMediaUrls)) {
    errors.push('FCPXML 镜头素材顺序与 analysis 章节化镜头顺序不一致。');
  }
  if (titles.length > 0 && !effects.some((effect) => effect.uid === BASIC_TITLE_EFFECT.uid)) {
    errors.push('原生标题缺少 FCP 12.3 基础标题 effect 资源。');
  }
  if (titles.length > 0 && version !== FCPXML_TITLE_VERSION) {
    errors.push(`原生标题项目必须使用 FCPXML ${FCPXML_TITLE_VERSION}。`);
  }
  if (Number.isInteger(expected.width) && sequenceFormat?.width !== expected.width) {
    errors.push(`正式时间线宽度 ${sequenceFormat?.width || '未知'} 与预期 ${expected.width} 不一致。`);
  }
  if (Number.isInteger(expected.height) && sequenceFormat?.height !== expected.height) {
    errors.push(`正式时间线高度 ${sequenceFormat?.height || '未知'} 与预期 ${expected.height} 不一致。`);
  }
  if (Number.isFinite(expected.fps) && sequenceFormat?.frameDuration !== frameDuration(expected.fps)) {
    errors.push(`正式时间线帧率与预期 ${expected.fps} fps 不一致。`);
  }

  // Full timeline edit-boundary validation against sequence frameDuration.
  if (sequenceFrameRational) {
    const frameDurLabel = sequenceFormat?.frameDuration
      || formatFcpRational(sequenceFrameRational.numerator, sequenceFrameRational.denominator);

    if (sequenceDurationRational
      && !isRationalMultiple(sequenceDurationRational, sequenceFrameRational)) {
      errors.push(`sequence duration 未对齐帧边界：${sequenceDurationMatch?.[1]}（frameDuration=${frameDurLabel}）`);
    }
    if (sequenceDurationRational && rationalToSeconds(sequenceDurationRational) <= 0) {
      errors.push('sequence duration 必须大于 0。');
    }

    const spineMatch = xml.match(/<spine>([\s\S]*?)<\/spine>/);
    const spineBody = spineMatch ? spineMatch[1] : '';
    const spineChildren = [...spineBody.matchAll(
      /<(asset-clip|video|gap|clip)\s+([^>]+)(?:\/>|>([\s\S]*?)<\/\1>)/g,
    )].map((match) => {
      const attrs = match[2];
      return {
        tag: match[1],
        offset: attrs.match(/\boffset="([^"]+)"/)?.[1] || null,
        start: attrs.match(/\bstart="([^"]+)"/)?.[1] || null,
        duration: attrs.match(/\bduration="([^"]+)"/)?.[1] || null,
        name: attrs.match(/\bname="([^"]*)"/)?.[1] || null,
        body: match[3] || '',
        mute: /adjust-volume[^>]*amount="-96dB"/.test(match[3] || ''),
      };
    });

    let previousEnd = reduceRational(0, 1);
    for (const clip of spineChildren) {
      let offsetRational = null;
      let durationRational = null;
      let startRational = null;
      try {
        offsetRational = clip.offset ? parseFcpTimeRational(clip.offset) : null;
        durationRational = clip.duration ? parseFcpTimeRational(clip.duration) : null;
        startRational = clip.start ? parseFcpTimeRational(clip.start) : null;
      } catch (error) {
        errors.push(`时间线 ${clip.tag} 时间无法解析（${clip.name || clip.offset}）：${error.message}`);
        continue;
      }
      if (!offsetRational || !durationRational) {
        errors.push(`时间线 ${clip.tag} 缺少 offset 或 duration。`);
        continue;
      }
      if (!isRationalMultiple(offsetRational, sequenceFrameRational)) {
        errors.push(
          `时间线 ${clip.tag} offset 未对齐帧边界：${clip.offset}（frameDuration=${frameDurLabel}）`,
        );
      }
      if (!isRationalMultiple(durationRational, sequenceFrameRational)) {
        errors.push(
          `时间线 ${clip.tag} duration 未对齐帧边界：${clip.duration}（frameDuration=${frameDurLabel}）`,
        );
      }
      if (!(rationalToSeconds(durationRational) > 0)) {
        errors.push(`时间线 ${clip.tag} 时长必须大于 0：${clip.name || clip.duration}`);
      }
      const endRational = reduceRational(
        offsetRational.numerator * durationRational.denominator
          + durationRational.numerator * offsetRational.denominator,
        offsetRational.denominator * durationRational.denominator,
      );
      if (!isRationalMultiple(endRational, sequenceFrameRational)) {
        errors.push(
          `时间线 ${clip.tag} 结束时间未对齐帧边界：${formatFcpRational(endRational.numerator, endRational.denominator)}`,
        );
      }
      if (startRational && !isRationalMultiple(startRational, sequenceFrameRational)) {
        // Image still origin 3600/1s and video 0s are sequence-grid legal at common fps.
        errors.push(
          `时间线 ${clip.tag} start 未对齐帧边界：${clip.start}（frameDuration=${frameDurLabel}）`,
        );
      }
      if (Math.abs(rationalToSeconds(offsetRational) - rationalToSeconds(previousEnd)) > 1e-9) {
        errors.push(
          `时间线镜头不连续：${clip.name || clip.tag} offset=${clip.offset} 前序结束=${formatFcpRational(previousEnd.numerator, previousEnd.denominator)}`,
        );
      }
      previousEnd = endRational;

      // Nested markers must sit on the frame grid and inside the host clip.
      for (const markerMatch of clip.body.matchAll(/<marker\s+([^>]+)\/>/g)) {
        const markerAttrs = markerMatch[1];
        const markerStart = markerAttrs.match(/\bstart="([^"]+)"/)?.[1];
        const markerDuration = markerAttrs.match(/\bduration="([^"]+)"/)?.[1];
        try {
          const markerStartRational = parseFcpTimeRational(markerStart);
          const markerDurationRational = parseFcpTimeRational(markerDuration);
          if (!isRationalMultiple(markerStartRational, sequenceFrameRational)) {
            errors.push(`marker start 未对齐帧边界：${markerStart}`);
          }
          if (!isRationalMultiple(markerDurationRational, sequenceFrameRational)) {
            errors.push(`marker duration 未对齐帧边界：${markerDuration}`);
          }
          if (startRational) {
            const markerEnd = reduceRational(
              markerStartRational.numerator * markerDurationRational.denominator
                + markerDurationRational.numerator * markerStartRational.denominator,
              markerStartRational.denominator * markerDurationRational.denominator,
            );
            const clipEnd = reduceRational(
              startRational.numerator * durationRational.denominator
                + durationRational.numerator * startRational.denominator,
              startRational.denominator * durationRational.denominator,
            );
            if (rationalToSeconds(markerStartRational) < rationalToSeconds(startRational) - 1e-9
              || rationalToSeconds(markerEnd) > rationalToSeconds(clipEnd) + 1e-9) {
              errors.push(`marker 越过所属镜头范围：${markerStart}`);
            }
          }
        } catch (error) {
          errors.push(`marker 时间无法解析：${error.message}`);
        }
      }
    }

    if (sequenceDurationRational
      && Math.abs(rationalToSeconds(previousEnd) - rationalToSeconds(sequenceDurationRational)) > 1e-9
      && spineChildren.length > 0) {
      errors.push(
        `sequence duration 与镜头总和不一致：sequence=${sequenceDurationMatch?.[1]} spineEnd=${formatFcpRational(previousEnd.numerator, previousEnd.denominator)}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    assetCount: assets.length,
    clipCount: clips.length,
    markerCount: markers.length,
    titleCount: titles.length,
    transformKeyframeCount: transformKeyframes.length,
    managedTitleCount: managedTitleKeys.length,
    effectCount: effects.length,
    version,
    mediaUrls: mediaRepresentations.map((match) => match[1]),
    clipMediaUrls,
    sequenceFormat,
    sequenceFrameDuration: sequenceFormat?.frameDuration || null,
  };
}

async function enrichAssetMappingsFrameMetadata(assetMappings = []) {
  const { probeMediaSafe } = require('./media-tool-service');
  const enriched = [];
  for (const mapping of assetMappings) {
    if (!mapping || mapping.type !== 'video') {
      enriched.push(mapping);
      continue;
    }
    const metadata = { ...(mapping.metadata || {}) };
    const hasFrameSignal = resolveMediaFrameCount(metadata) != null
      || metadata.durationTs != null
      || metadata.timeBase != null;
    if (hasFrameSignal || !mapping.projectAbsolutePath) {
      enriched.push(mapping);
      continue;
    }
    const probed = await probeMediaSafe(mapping.projectAbsolutePath);
    if (!probed.ok || !probed.metadata) {
      enriched.push(mapping);
      continue;
    }
    enriched.push({
      ...mapping,
      metadata: {
        ...metadata,
        durationSec: metadata.durationSec ?? probed.metadata.durationSec,
        frameRate: metadata.frameRate ?? probed.metadata.frameRate,
        avgFrameRate: probed.metadata.avgFrameRate || metadata.avgFrameRate || null,
        rFrameRate: probed.metadata.rFrameRate || metadata.rFrameRate || null,
        frameCount: probed.metadata.frameCount ?? metadata.frameCount ?? null,
        durationTs: probed.metadata.durationTs ?? metadata.durationTs ?? null,
        timeBase: probed.metadata.timeBase || metadata.timeBase || null,
        hasAudio: metadata.hasAudio ?? probed.metadata.hasAudio,
      },
    });
  }
  return enriched;
}

async function writeFcpxml(outputPath, payload, options = {}) {
  const assetMappings = await enrichAssetMappingsFrameMetadata(payload.assetMappings || []);
  const writePayload = { ...payload, assetMappings };
  const resolvedTitles = resolveFcpxmlTitles(writePayload.analysis, payload.managedCaptionTitles);
  const xml = buildFcpxml(writePayload);
  const expectedTitleCount = Number.isInteger(options.expectedTitleCount)
    ? options.expectedTitleCount
    : resolvedTitles.markerTitles.length + resolvedTitles.managedTitles.length;
  const report = validateFcpxmlStructure(xml, {
    shotCount: writePayload.analysis.timeline.shots.length,
    assetCount: assetMappings.length,
    markerCount: writePayload.analysis.timeline.markers.length,
    titleCount: expectedTitleCount,
    width: writePayload.analysis.timeline.width,
    height: writePayload.analysis.timeline.height,
    fps: writePayload.analysis.timeline.fps,
    clipMediaUrls: writePayload.analysis.timeline.shots.map((shot) => {
      const mapping = assetMappings.find((item) => item.assetId === shot.assetId);
      // Must match buildFcpxml's escapeXml(pathToFileURL(...).href), including &apos; for apostrophes.
      return mapping ? escapeXml(pathToFileURL(mapping.projectAbsolutePath).href) : null;
    }),
  });
  if (!report.ok) {
    throw Object.assign(new Error(`FCPXML 结构校验失败：${report.errors[0]}`), {
      code: 'INVALID_FCPXML',
      details: report.errors,
    });
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const useAtomic = options.atomic === true;
  if (!useAtomic) {
    await fs.writeFile(outputPath, xml, 'utf8');
    return {
      outputPath,
      report,
      managedTitleCount: resolvedTitles.managedTitles.length,
      timelinePlan: planFrameAlignedTimeline({
        analysis: writePayload.analysis,
        assetMappings,
      }),
    };
  }

  const directory = path.dirname(outputPath);
  const tempPath = path.join(
    directory,
    `.${path.basename(outputPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const existing = await fs.readFile(outputPath, 'utf8').catch(() => null);
  try {
    await fs.writeFile(tempPath, xml, { encoding: 'utf8', flag: 'wx' });
    if (options.backupExisting === true && existing != null) {
      const backupDirectory = options.backupDirectory
        ? path.resolve(options.backupDirectory)
        : directory;
      await fs.mkdir(backupDirectory, { recursive: true });
      const backupPath = path.join(
        backupDirectory,
        `${path.basename(outputPath)}.${Date.now()}.prev`,
      );
      await fs.writeFile(backupPath, existing, 'utf8');
    }
    await fs.rename(tempPath, outputPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    if (existing != null) {
      await fs.writeFile(outputPath, existing, 'utf8').catch(() => {});
    }
    throw error;
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
  return {
    outputPath,
    report,
    managedTitleCount: resolvedTitles.managedTitles.length,
    restoredOnFailure: false,
    timelinePlan: planFrameAlignedTimeline({
      analysis: writePayload.analysis,
      assetMappings,
    }),
  };
}

module.exports = {
  BASIC_TITLE_STYLE,
  BASIC_TITLE_EFFECT,
  GAUSSIAN_BLUR_EFFECT,
  FCPXML_DEFAULT_VERSION,
  FCPXML_TITLE_VERSION,
  FCPXML_TIMESCALE,
  MANAGED_CAPTION_NOTE_PREFIX,
  assetUid,
  buildFcpxml,
  collectFcpTitles,
  resolveFcpxmlTitles,
  escapeXml,
  isLegalFcpName,
  extractManagedCaptionTitles,
  extractTopLevelSpineClips,
  fcpTime,
  fcpTimeAligned,
  fcpTimeFromFrameIndex,
  frameDuration,
  frameDurationRational,
  formatFcpRational,
  isRationalMultiple,
  normalizeManagedCaptionTitles,
  normalizeFcpNames,
  sanitizeFcpFilename,
  sanitizeFcpName,
  parseFcpTimeRational,
  parseFrameRateRational,
  planFrameAlignedTimeline,
  quantizeAssetResourceDuration,
  quantizeCaptionTiming,
  quantizeShotToFrameGrid,
  rationalToSeconds,
  resolveMediaContentDurationSec,
  resolveMediaFrameCount,
  enrichAssetMappingsFrameMetadata,
  secondsToFrameIndex,
  frameIndexToRational,
  validateFcpxmlStructure,
  writeFcpxml,
};
