'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runMediaTool } = require('./media-tool-service');
const {
  frameDuration,
  secondsToFrameIndex,
  fcpTimeFromFrameIndex,
} = require('./fcpxml-service');

const SUBJECT_TYPES = new Set([
  'person',
  'animal',
  'vehicle',
  'moving_object',
  'user_region',
]);
const TRACKING_STATUSES = new Set([
  'tracked',
  'low_confidence',
  'fallback',
  'failed',
]);
const TRACKING_CONFIRMATIONS = new Set([
  'pending',
  'approved_continue',
  'corrected',
  'fallback',
]);
const TRACKING_FALLBACK_MODES = new Set([
  'landscape_card',
  'landscape_card_blur',
  'native_vertical',
  'center_crop',
  'screen_focus',
  'screen_split',
  'segmented_focus',
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function validRect(rect) {
  if (!rect || typeof rect !== 'object') return false;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  return [x, y, width, height].every(Number.isFinite)
    && x >= 0 && y >= 0 && width > 0 && height > 0
    && x + width <= 1.000001 && y + height <= 1.000001;
}

function normalizeRect(rect) {
  if (!validRect(rect)) return null;
  return {
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height),
  };
}

function unionRects(rects) {
  const usable = rects.filter(validRect);
  if (!usable.length) return null;
  const left = Math.min(...usable.map((rect) => rect.x));
  const top = Math.min(...usable.map((rect) => rect.y));
  const right = Math.max(...usable.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...usable.map((rect) => rect.y + rect.height));
  return normalizeRect({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
}

function alignSourceTime(seconds, frameDur) {
  const frames = Math.max(0, secondsToFrameIndex(seconds, frameDur, 'nearest'));
  return {
    frame: frames,
    seconds: round(frames * (
      frameDur === '1001/30000s'
        ? 1001 / 30000
        : frameDur === '1001/60000s'
          ? 1001 / 60000
          : 1 / Number(String(frameDur).match(/1\/(\d+)s/)?.[1] || 30)
    )),
    fcpTime: fcpTimeFromFrameIndex(frames, frameDur),
  };
}

function pointCenter(point) {
  return {
    x: point.bounds.x + point.bounds.width / 2,
    y: point.bounds.y + point.bounds.height / 2,
  };
}

function smoothPoints(points) {
  if (points.length < 3) return points;
  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1 || point.origin === 'manual' || point.locked) {
      return point;
    }
    const previousCenter = pointCenter(points[index - 1]);
    const currentCenter = pointCenter(point);
    const nextCenter = pointCenter(points[index + 1]);
    const horizontalReversal = (currentCenter.x - previousCenter.x)
      * (nextCenter.x - currentCenter.x) < 0;
    const verticalReversal = (currentCenter.y - previousCenter.y)
      * (nextCenter.y - currentCenter.y) < 0;
    if (horizontalReversal || verticalReversal) return point;
    const window = points.slice(Math.max(0, index - 1), Math.min(points.length, index + 2));
    const center = window.map(pointCenter);
    const x = center.reduce((sum, item) => sum + item.x, 0) / center.length;
    const y = center.reduce((sum, item) => sum + item.y, 0) / center.length;
    const width = window.reduce((sum, item) => sum + item.bounds.width, 0) / window.length;
    const height = window.reduce((sum, item) => sum + item.bounds.height, 0) / window.length;
    return {
      ...point,
      bounds: normalizeRect({
        x: clamp(x - width / 2, 0, 1 - width),
        y: clamp(y - height / 2, 0, 1 - height),
        width,
        height,
      }),
    };
  });
}

function meaningfulPointIndexes(points, options = {}) {
  if (points.length <= 2) return points.map((_, index) => index);
  const movementThreshold = Number(options.movementThreshold) || 0.025;
  const scaleThreshold = Number(options.scaleThreshold) || 0.035;
  const indexes = [0];
  let lastIndex = 0;
  let previousDirection = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = pointCenter(points[index - 1]);
    const current = pointCenter(points[index]);
    const next = pointCenter(points[index + 1]);
    const last = pointCenter(points[lastIndex]);
    const distance = Math.hypot(current.x - last.x, current.y - last.y);
    const sizeDelta = Math.max(
      Math.abs(points[index].bounds.width - points[lastIndex].bounds.width),
      Math.abs(points[index].bounds.height - points[lastIndex].bounds.height),
    );
    const direction = Math.sign(next.x - current.x);
    const reversal = previousDirection !== 0 && direction !== 0 && direction !== previousDirection
      && Math.abs(current.x - previous.x) >= movementThreshold / 2;
    if (points[index].origin === 'manual'
      || points[index].locked
      || distance >= movementThreshold
      || sizeDelta >= scaleThreshold
      || reversal) {
      indexes.push(index);
      lastIndex = index;
    }
    if (direction !== 0) previousDirection = direction;
  }
  indexes.push(points.length - 1);
  return [...new Set(indexes)];
}

function trackingAspectFactors(sourceAspect, outputAspect) {
  const source = Number(sourceAspect);
  const output = Number(outputAspect);
  if (!(source > 0) || !(output > 0)) {
    return { x: 1, y: 1, aspectAware: false };
  }
  return source >= output
    ? { x: source / output, y: 1, aspectAware: true }
    : { x: 1, y: output / source, aspectAware: true };
}

function trackingPosition(bounds, safeZone, margin, scale = 1, factors = { x: 1, y: 1 }) {
  const safe = {
    x: safeZone.x + margin,
    y: safeZone.y + margin,
    width: Math.max(0.05, safeZone.width - margin * 2),
    height: Math.max(0.05, safeZone.height - margin * 2),
  };
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const desired = {
    x: safe.x + safe.width / 2,
    y: clamp(
      safe.y + safe.height / 2,
      safe.y + bounds.height / 2,
      safe.y + safe.height - bounds.height / 2,
    ),
  };
  const scaledCenter = {
    x: 0.5 + (center.x - 0.5) * factors.x * scale,
    y: 0.5 + (center.y - 0.5) * factors.y * scale,
  };
  return {
    x: round(clamp((desired.x - scaledCenter.x) * 2, -1, 1)),
    y: round(clamp((desired.y - scaledCenter.y) * 2, -1, 1)),
  };
}

function normalizeObservation(observation, index, frameDur, inSec) {
  const sourceTime = Number.isFinite(Number(observation.sourceTimeSec))
    ? Number(observation.sourceTimeSec)
    : inSec + Number(observation.timeSec || 0);
  const aligned = alignSourceTime(sourceTime, frameDur);
  const subjects = Array.isArray(observation.subjects)
    ? observation.subjects.map((item) => ({
      bounds: normalizeRect(item.bounds || item),
      confidence: clamp(Number(item.confidence) || 0, 0, 1),
      primary: item.primary === true,
    })).filter((item) => item.bounds)
    : [];
  if (!subjects.length && validRect(observation.bounds)) {
    subjects.push({
      bounds: normalizeRect(observation.bounds),
      confidence: clamp(Number(observation.confidence) || 0, 0, 1),
      primary: true,
    });
  }
  return {
    index,
    sourceTimeSec: aligned.seconds,
    sourceTime: aligned.fcpTime,
    subjects,
  };
}

function buildSubjectTracking(options = {}) {
  const fps = Number(options.fps) || 30;
  const frameDur = options.frameDuration || frameDuration(fps);
  const inSec = Number(options.inSec) || 0;
  const outSec = Number(options.outSec);
  const subjectType = SUBJECT_TYPES.has(options.subjectType)
    ? options.subjectType
    : 'moving_object';
  const safeZone = validRect(options.safeZone)
    ? options.safeZone
    : { x: 0.07, y: 0.08, width: 0.72, height: 0.72 };
  const safeMargin = clamp(Number(options.safeMargin) || 0.03, 0, 0.2);
  const sourceAspect = Number(options.sourceAspect) > 0 ? Number(options.sourceAspect) : null;
  const outputAspect = Number(options.outputAspect) > 0 ? Number(options.outputAspect) : null;
  const aspectFactors = trackingAspectFactors(sourceAspect, outputAspect);
  const observations = (Array.isArray(options.observations) ? options.observations : [])
    .map((item, index) => normalizeObservation(item, index, frameDur, inSec))
    .filter((item) => item.sourceTimeSec >= inSec - 1e-6
      && (!Number.isFinite(outSec) || item.sourceTimeSec <= outSec + 1e-6))
    .sort((left, right) => left.sourceTimeSec - right.sourceTimeSec);
  const fallbackMode = TRACKING_FALLBACK_MODES.has(options.fallbackMode)
    ? options.fallbackMode
    : 'landscape_card_blur';

  if (!observations.length || observations.some((item) => !item.subjects.length)) {
    return {
      enabled: true,
      subjectType,
      status: 'failed',
      confidence: 0,
      sourceAspect,
      outputAspect,
      safeMargin,
      sampleIntervalSec: Number(options.sampleIntervalSec) || null,
      points: [],
      keyframes: [],
      locks: [],
      manualConfirmation: 'pending',
      fallback: {
        mode: fallbackMode,
        reason: '采样点没有形成连续、可信的主体检测结果。',
        applied: false,
      },
      warnings: ['主体跟踪失败；不得静默生成动态裁切，请人工指定主体区域或切换静态布局。'],
    };
  }

  let multiSubjectUnstable = false;
  let multiSubjectReason = '';
  for (const observation of observations) {
    const significant = observation.subjects.filter((item) => item.confidence >= 0.45);
    if (significant.length < 2) continue;
    const union = unionRects(significant.map((item) => item.bounds));
    const separated = union && (
      union.width > safeZone.width - safeMargin * 2
      || union.height > safeZone.height - safeMargin * 2
    );
    const clearPrimary = significant.filter((item) => item.primary).length === 1
      && significant.find((item) => item.primary).confidence >= 0.72;
    if (separated && !clearPrimary) {
      multiSubjectUnstable = true;
      multiSubjectReason = '多个关键主体分散或交叉，单主体裁切会丢失共同内容。';
      break;
    }
  }
  if (multiSubjectUnstable) {
    return {
      enabled: true,
      subjectType,
      status: 'fallback',
      confidence: round(observations.reduce((sum, item) => (
        sum + Math.max(...item.subjects.map((subject) => subject.confidence))
      ), 0) / observations.length),
      sourceAspect,
      outputAspect,
      safeMargin,
      sampleIntervalSec: Number(options.sampleIntervalSec) || null,
      points: [],
      keyframes: [],
      locks: [],
      manualConfirmation: 'fallback',
      fallback: {
        mode: fallbackMode,
        reason: multiSubjectReason,
        applied: true,
      },
      warnings: [`${multiSubjectReason} 已安全降级为现有静态布局 ${fallbackMode}。`],
    };
  }

  const rawPoints = observations.map((observation, index) => {
    const primary = observation.subjects.find((item) => item.primary)
      || [...observation.subjects].sort((a, b) => b.confidence - a.confidence)[0];
    return {
      pointId: `track-${index + 1}`,
      sourceTimeSec: observation.sourceTimeSec,
      sourceTime: observation.sourceTime,
      bounds: primary.bounds,
      confidence: primary.confidence,
      origin: options.origin === 'manual' || subjectType === 'user_region' ? 'manual' : 'agent',
      locked: false,
    };
  });
  const points = smoothPoints(rawPoints);
  const confidence = round(points.reduce((sum, point) => sum + point.confidence, 0) / points.length);
  const insetSafe = {
    width: Math.max(0.05, safeZone.width - safeMargin * 2),
    height: Math.max(0.05, safeZone.height - safeMargin * 2),
  };
  const cannotFitAtFill = aspectFactors.aspectAware && points.some((point) => (
    point.bounds.width * aspectFactors.x > insetSafe.width
    || point.bounds.height * aspectFactors.y > insetSafe.height
  ));
  if (cannotFitAtFill) {
    return {
      enabled: true,
      subjectType,
      status: 'fallback',
      confidence,
      sourceAspect,
      outputAspect,
      safeMargin,
      sampleIntervalSec: Number(options.sampleIntervalSec) || null,
      points,
      keyframes: [],
      locks: [],
      manualConfirmation: 'fallback',
      fallback: {
        mode: fallbackMode,
        reason: '主体框在竖屏填充后大于主体安全区，继续单主体裁切会截断关键区域。',
        applied: true,
      },
      warnings: [`主体无法在竖屏填充裁切中完整进入安全区；已安全降级为 ${fallbackMode}。`],
    };
  }
  const selectedIndexes = meaningfulPointIndexes(points, options);
  const keyframes = selectedIndexes.map((index) => {
    const point = points[index];
    const desiredSubjectWidth = Math.max(0.12, safeZone.width * 0.62);
    const desiredSubjectHeight = Math.max(0.12, safeZone.height * 0.82);
    const baseSubjectWidth = point.bounds.width * aspectFactors.x;
    const baseSubjectHeight = point.bounds.height * aspectFactors.y;
    const scale = round(clamp(
      Math.min(
        desiredSubjectWidth / Math.max(baseSubjectWidth, 0.05),
        desiredSubjectHeight / Math.max(baseSubjectHeight, 0.05),
      ) * (Number(options.scale) || 1),
      aspectFactors.aspectAware ? 1 : 0.5,
      4,
    ));
    const position = trackingPosition(
      point.bounds,
      safeZone,
      safeMargin,
      scale,
      aspectFactors,
    );
    return {
      keyframeId: `keyframe-${index + 1}`,
      pointId: point.pointId,
      sourceTimeSec: point.sourceTimeSec,
      sourceTime: point.sourceTime,
      position,
      scale,
      crop: options.crop || { left: 0, top: 0, right: 0, bottom: 0 },
      interpolation: 'smooth',
    };
  });
  const status = confidence < (Number(options.confidenceThreshold) || 0.58)
    ? 'low_confidence'
    : 'tracked';
  return {
    enabled: true,
    subjectType,
    status,
    confidence,
    sourceAspect,
    outputAspect,
    safeMargin,
    sampleIntervalSec: Number(options.sampleIntervalSec) || null,
    points,
    keyframes,
    locks: [],
    manualConfirmation: status === 'tracked' ? 'pending' : 'pending',
    fallback: {
      mode: fallbackMode,
      reason: status === 'low_confidence'
        ? `平均跟踪置信度 ${confidence.toFixed(2)} 低于阈值，建议人工修正或切换静态布局。`
        : '',
      applied: false,
    },
    warnings: status === 'low_confidence'
      ? ['跟踪置信度不足；继续使用前必须人工确认，或改用建议的静态布局。']
      : [],
  };
}

function parsePgm(buffer) {
  const header = buffer.subarray(0, Math.min(buffer.length, 256)).toString('ascii');
  const match = header.match(/^P5\s+(?:#[^\n]*\s+)*(\d+)\s+(\d+)\s+255\s/);
  if (!match) throw new Error('无法解析主体跟踪采样帧。');
  const headerLength = match[0].length;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return {
    width,
    height,
    pixels: buffer.subarray(headerLength, headerLength + width * height),
  };
}

function motionSubjects(previous, current) {
  const { width, height } = current;
  const changed = new Uint8Array(width * height);
  for (let index = 0; index < changed.length; index += 1) {
    changed[index] = Math.abs(current.pixels[index] - previous.pixels[index]) >= 24 ? 1 : 0;
  }
  const visited = new Uint8Array(changed.length);
  const components = [];
  for (let start = 0; start < changed.length; start += 1) {
    if (!changed[start] || visited[start]) continue;
    const stack = [start];
    visited[start] = 1;
    let count = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (stack.length) {
      const index = stack.pop();
      const x = index % width;
      const y = Math.floor(index / width);
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (changed[next] && !visited[next]) {
          visited[next] = 1;
          stack.push(next);
        }
      }
    }
    if (count >= Math.max(8, width * height * 0.001)) {
      components.push({
        count,
        bounds: normalizeRect({
          x: minX / width,
          y: minY / height,
          width: Math.max(2, maxX - minX + 1) / width,
          height: Math.max(2, maxY - minY + 1) / height,
        }),
      });
    }
  }
  return components
    .filter((item) => item.bounds && item.bounds.width * item.bounds.height < 0.8)
    .sort((left, right) => right.count - left.count)
    .slice(0, 3)
    .map((item, index) => ({
      bounds: item.bounds,
      confidence: round(clamp(0.45 + item.count / (width * height * 0.18), 0.45, 0.88)),
      primary: index === 0,
    }));
}

function templateDifference(previous, current, rect, offsetX, offsetY) {
  const left = Math.round(rect.x * previous.width);
  const top = Math.round(rect.y * previous.height);
  const width = Math.max(4, Math.round(rect.width * previous.width));
  const height = Math.max(4, Math.round(rect.height * previous.height));
  let difference = 0;
  let count = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const previousX = clamp(left + x, 0, previous.width - 1);
      const previousY = clamp(top + y, 0, previous.height - 1);
      const currentX = left + x + offsetX;
      const currentY = top + y + offsetY;
      if (currentX < 0 || currentX >= current.width
        || currentY < 0 || currentY >= current.height) continue;
      difference += Math.abs(
        previous.pixels[previousY * previous.width + previousX]
          - current.pixels[currentY * current.width + currentX],
      );
      count += 1;
    }
  }
  return count ? difference / count : 255;
}

function trackInitialRegion(frames, initialRegion, inSec, outSec, sampleIntervalSec) {
  const observations = [{
    sourceTimeSec: inSec,
    bounds: initialRegion,
    confidence: 1,
  }];
  let region = initialRegion;
  for (let index = 1; index < frames.length; index += 1) {
    let best = { difference: Infinity, offsetX: 0, offsetY: 0 };
    const searchX = Math.max(5, Math.round(frames[index].width * 0.16));
    const searchY = Math.max(4, Math.round(frames[index].height * 0.12));
    for (let offsetY = -searchY; offsetY <= searchY; offsetY += 2) {
      for (let offsetX = -searchX; offsetX <= searchX; offsetX += 2) {
        const difference = templateDifference(
          frames[index - 1],
          frames[index],
          region,
          offsetX,
          offsetY,
        );
        if (difference < best.difference) {
          best = { difference, offsetX, offsetY };
        }
      }
    }
    region = normalizeRect({
      x: clamp(region.x + best.offsetX / frames[index].width, 0, 1 - region.width),
      y: clamp(region.y + best.offsetY / frames[index].height, 0, 1 - region.height),
      width: region.width,
      height: region.height,
    });
    observations.push({
      sourceTimeSec: Math.min(outSec, inSec + index * sampleIntervalSec),
      bounds: region,
      confidence: round(clamp(1 - best.difference / 160, 0.4, 0.96)),
    });
  }
  if (observations.at(-1).sourceTimeSec < outSec - 1e-6) {
    observations.push({
      sourceTimeSec: outSec,
      bounds: region,
      confidence: observations.at(-1).confidence,
    });
  }
  return observations;
}

async function analyzeMediaSubjectTracking(options = {}) {
  const mediaPath = path.resolve(String(options.mediaPath || ''));
  const inSec = Number(options.inSec) || 0;
  const outSec = Number(options.outSec);
  if (!Number.isFinite(outSec) || outSec <= inSec) {
    throw Object.assign(new Error('主体跟踪需要有效的源视频时间范围。'), {
      code: 'INVALID_TRACKING_RANGE',
    });
  }
  const duration = outSec - inSec;
  const sampleIntervalSec = clamp(
    Number(options.sampleIntervalSec) || duration / 8,
    0.2,
    1,
  );
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-subject-track-'));
  try {
    const pattern = path.join(tempDirectory, 'frame-%04d.pgm');
    await runMediaTool('ffmpeg', [
      '-v', 'error',
      '-ss', String(inSec),
      '-t', String(duration),
      '-i', mediaPath,
      '-vf', `fps=1/${sampleIntervalSec},scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,format=gray`,
      '-vsync', '0',
      pattern,
    ], { timeoutMs: 120_000 });
    const filenames = (await fs.readdir(tempDirectory))
      .filter((name) => /^frame-\d+\.pgm$/.test(name))
      .sort();
    const frames = await Promise.all(filenames.map(async (name) => (
      parsePgm(await fs.readFile(path.join(tempDirectory, name)))
    )));
    const initialRegion = normalizeRect(options.initialRegion);
    const observations = initialRegion
      ? trackInitialRegion(frames, initialRegion, inSec, outSec, sampleIntervalSec)
      : [];
    if (!initialRegion) {
      for (let index = 1; index < frames.length; index += 1) {
        const subjects = motionSubjects(frames[index - 1], frames[index]);
        observations.push({
          sourceTimeSec: Math.min(outSec, inSec + index * sampleIntervalSec),
          subjects,
        });
      }
      if (observations.length && observations[0].subjects.length) {
        observations.unshift({
          sourceTimeSec: inSec,
          subjects: observations[0].subjects,
        });
      }
      if (observations.length && observations.at(-1).sourceTimeSec < outSec - 1e-6) {
        observations.push({
          sourceTimeSec: outSec,
          subjects: observations.at(-1).subjects,
        });
      }
    }
    return buildSubjectTracking({
      ...options,
      origin: initialRegion ? 'manual' : options.origin,
      inSec,
      outSec,
      sampleIntervalSec,
      observations,
    });
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

function normalizeTracking(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null;
  const subjectType = SUBJECT_TYPES.has(raw.subjectType) ? raw.subjectType : 'moving_object';
  const status = TRACKING_STATUSES.has(raw.status) ? raw.status : 'failed';
  const points = (Array.isArray(raw.points) ? raw.points : []).map((point, index) => ({
    pointId: String(point?.pointId || `track-${index + 1}`),
    sourceTimeSec: Number(point?.sourceTimeSec),
    sourceTime: String(point?.sourceTime || ''),
    bounds: normalizeRect(point?.bounds),
    confidence: clamp(Number(point?.confidence) || 0, 0, 1),
    origin: point?.origin === 'manual' ? 'manual' : 'agent',
    locked: point?.locked === true,
  })).filter((point) => point.bounds && Number.isFinite(point.sourceTimeSec));
  const keyframes = (Array.isArray(raw.keyframes) ? raw.keyframes : []).map((keyframe, index) => ({
    keyframeId: String(keyframe?.keyframeId || `keyframe-${index + 1}`),
    pointId: String(keyframe?.pointId || ''),
    sourceTimeSec: Number(keyframe?.sourceTimeSec),
    sourceTime: String(keyframe?.sourceTime || ''),
    position: {
      x: clamp(Number(keyframe?.position?.x) || 0, -1, 1),
      y: clamp(Number(keyframe?.position?.y) || 0, -1, 1),
    },
    scale: clamp(Number(keyframe?.scale) || 1, 0.1, 8),
    crop: {
      left: clamp(Number(keyframe?.crop?.left) || 0, 0, 0.99),
      top: clamp(Number(keyframe?.crop?.top) || 0, 0, 0.99),
      right: clamp(Number(keyframe?.crop?.right) || 0, 0, 0.99),
      bottom: clamp(Number(keyframe?.crop?.bottom) || 0, 0, 0.99),
    },
    interpolation: keyframe?.interpolation === 'linear' ? 'linear' : 'smooth',
  })).filter((keyframe) => Number.isFinite(keyframe.sourceTimeSec))
    .sort((left, right) => left.sourceTimeSec - right.sourceTimeSec);
  return {
    enabled: true,
    subjectType,
    status,
    confidence: clamp(Number(raw.confidence) || 0, 0, 1),
    sourceAspect: Number(raw.sourceAspect) > 0 ? round(Number(raw.sourceAspect)) : null,
    outputAspect: Number(raw.outputAspect) > 0 ? round(Number(raw.outputAspect)) : null,
    safeMargin: clamp(Number(raw.safeMargin) || 0.03, 0, 0.2),
    sampleIntervalSec: Number.isFinite(Number(raw.sampleIntervalSec))
      ? Number(raw.sampleIntervalSec)
      : null,
    points,
    keyframes,
    locks: (Array.isArray(raw.locks) ? raw.locks : []).map((lock, index) => ({
      lockId: String(lock?.lockId || `lock-${index + 1}`),
      startSec: Number(lock?.startSec),
      endSec: Number(lock?.endSec),
      pointId: String(lock?.pointId || ''),
    })).filter((lock) => Number.isFinite(lock.startSec)
      && Number.isFinite(lock.endSec) && lock.endSec > lock.startSec),
    manualConfirmation: TRACKING_CONFIRMATIONS.has(raw.manualConfirmation)
      ? raw.manualConfirmation
      : 'pending',
    fallback: {
      mode: TRACKING_FALLBACK_MODES.has(raw.fallback?.mode)
        ? raw.fallback.mode
        : 'landscape_card_blur',
      reason: String(raw.fallback?.reason || '').trim(),
      applied: raw.fallback?.applied === true,
    },
    warnings: (Array.isArray(raw.warnings) ? raw.warnings : [])
      .map(String).map((item) => item.trim()).filter(Boolean),
  };
}

function validateTracking(tracking, options = {}) {
  const errors = [];
  const warnings = [];
  if (!tracking) return { errors, warnings };
  const frameDur = options.frameDuration || frameDuration(options.fps || 30);
  const inSec = Number(options.inSec) || 0;
  const outSec = Number(options.outSec);
  for (const point of tracking.points) {
    if (point.sourceTimeSec < inSec - 1e-6
      || (Number.isFinite(outSec) && point.sourceTimeSec > outSec + 1e-6)) {
      errors.push(`跟踪点 ${point.pointId} 越过镜头源时间范围。`);
    }
    if (!validRect(point.bounds)) errors.push(`跟踪点 ${point.pointId} 越过源画面边界。`);
    if (Math.abs(
      secondsToFrameIndex(point.sourceTimeSec, frameDur, 'nearest')
        - secondsToFrameIndex(point.sourceTimeSec, frameDur, 'floor')
    ) > 0) {
      errors.push(`跟踪点 ${point.pointId} 未按 frameDuration 对齐。`);
    }
  }
  let previousTime = -Infinity;
  let previousPosition = null;
  let previousDelta = null;
  for (const keyframe of tracking.keyframes) {
    if (keyframe.sourceTimeSec <= previousTime) {
      errors.push('动态主体关键帧时间必须严格递增。');
    }
    const nearest = secondsToFrameIndex(keyframe.sourceTimeSec, frameDur, 'nearest');
    const aligned = alignSourceTime(keyframe.sourceTimeSec, frameDur);
    if (nearest < 0 || Math.abs(aligned.seconds - keyframe.sourceTimeSec) > 1e-5) {
      errors.push(`关键帧 ${keyframe.keyframeId} 未按 frameDuration 对齐。`);
    }
    if (previousPosition) {
      const delta = keyframe.position.x - previousPosition.x;
      const jump = Math.hypot(
        delta,
        keyframe.position.y - previousPosition.y,
      );
      if (jump > 0.45) warnings.push(`关键帧 ${keyframe.keyframeId} 存在异常位置跳跃。`);
      if (previousDelta != null && Math.sign(delta) !== 0
        && Math.sign(previousDelta) !== 0
        && Math.sign(delta) !== Math.sign(previousDelta)
        && Math.abs(delta) < 0.02) {
        warnings.push(`关键帧 ${keyframe.keyframeId} 可能出现反向抖动。`);
      }
      previousDelta = delta;
    }
    previousTime = keyframe.sourceTimeSec;
    previousPosition = keyframe.position;
  }
  if (tracking.keyframes.length > 2
    && Number.isFinite(outSec)
    && tracking.keyframes.length / Math.max(0.001, outSec - inSec) > 4) {
    warnings.push('动态主体关键帧过密，建议进一步平滑。');
  }
  if (tracking.status === 'low_confidence'
    && !['approved_continue', 'corrected', 'fallback'].includes(tracking.manualConfirmation)) {
    errors.push('低置信度主体跟踪尚未人工确认或安全降级。');
  }
  if (tracking.status === 'failed' && !tracking.fallback.applied) {
    errors.push('主体跟踪失败且尚未应用安全降级。');
  }
  if (tracking.status === 'fallback' && (!tracking.fallback.applied || !tracking.fallback.reason)) {
    errors.push('多主体或不稳定跟踪降级必须记录原因并实际应用。');
  }
  return { errors, warnings };
}

module.exports = {
  SUBJECT_TYPES,
  TRACKING_CONFIRMATIONS,
  TRACKING_FALLBACK_MODES,
  TRACKING_STATUSES,
  alignSourceTime,
  analyzeMediaSubjectTracking,
  buildSubjectTracking,
  meaningfulPointIndexes,
  normalizeTracking,
  smoothPoints,
  validateTracking,
};
