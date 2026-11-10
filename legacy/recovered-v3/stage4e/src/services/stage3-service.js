const fs = require('node:fs/promises');
const path = require('node:path');

const {
  APP_VERSION,
  ASSETS_FILE,
  SEGMENTS_FILE,
  ASSIGNMENTS_FILE,
  SEGMENT_PACKAGES_DIR,
} = require('../constants');
const { writeProjectState } = require('./project-service');
const { backupCoreProjectJson } = require('./backup-service');
const { compileTimeline, getSegmentDuration } = require('./timeline-engine');

const FIT_MODES = new Set(['contain', 'cover', 'blur', 'push_in']);
const AUDIO_MODES = new Set(['none', 'keep', 'duck', 'smart_duck']);

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function roundDuration(value) {
  return Number(Number(value).toFixed(2));
}

function createEmptyPayload(projectPath, segments = [], existing = {}) {
  const now = new Date().toISOString();
  const existingById = new Map(
    (existing.segments || []).map((segment) => [segment.segmentId, segment]),
  );
  return {
    version: APP_VERSION,
    projectPath,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    segments: segments.map((segment) => {
      const items = existingById.get(segment.id)?.items || [];
      const timeline = compileTimeline({ ...segment, items });
      return {
        segmentId: segment.id,
        items,
        timeline,
      };
    }),
  };
}

function normalizeItem(item, asset, order) {
  if (!asset) throw new Error(`找不到素材：${item.assetId || item.filename || '未知素材'}。`);
  const duration = Number(item.durationSec);
  return {
    assetId: asset.id,
    filename: asset.filename,
    relativePath: asset.relativePath,
    type: asset.type,
    originalDurationSec: Number.isFinite(asset.durationSec) ? asset.durationSec : null,
    startOffsetSec: Math.max(0, Number(item.startOffsetSec) || 0),
    durationSec: roundDuration(Math.max(0.1, Number.isFinite(duration) ? duration : 3)),
    fitMode: FIT_MODES.has(item.fitMode)
      ? item.fitMode
      : (asset.type === 'image' ? 'push_in' : 'contain'),
    audioMode: asset.type === 'image'
      ? 'none'
      : (AUDIO_MODES.has(item.audioMode) ? item.audioMode : 'none'),
    order,
    note: String(item.note || ''),
  };
}

async function getProjectData(projectPath) {
  const [assetsPayload, segmentsPayload, assignmentsPayload] = await Promise.all([
    readJson(path.join(projectPath, ASSETS_FILE)),
    readJson(path.join(projectPath, SEGMENTS_FILE)),
    readJson(path.join(projectPath, ASSIGNMENTS_FILE)),
  ]);
  return {
    assetsPayload,
    segmentsPayload,
    assignmentsPayload,
  };
}

async function normalizePayload(projectPath, requestedSegments) {
  const { assetsPayload, segmentsPayload, assignmentsPayload } = await getProjectData(projectPath);
  const segmentDefinitions = segmentsPayload?.segments || [];
  const segmentIds = segmentDefinitions.map((segment) => segment.id);
  const validSegmentIds = new Set(segmentIds);
  const assets = assetsPayload?.assets || [];
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const requestedById = new Map(
    (requestedSegments || assignmentsPayload?.segments || [])
      .filter((segment) => validSegmentIds.has(segment.segmentId))
      .map((segment) => [segment.segmentId, segment]),
  );
  const base = createEmptyPayload(projectPath, segmentDefinitions, assignmentsPayload || {});

  base.segments = base.segments.map((segment) => {
    const requested = requestedById.get(segment.segmentId);
    const items = (requested?.items || []).map((item, index) =>
      normalizeItem(item, assetsById.get(item.assetId), index + 1));
    const segmentDefinition = segmentDefinitions.find((entry) => entry.id === segment.segmentId);
    return {
      segmentId: segment.segmentId,
      items,
      timeline: compileTimeline({ ...segmentDefinition, items }),
    };
  });
  return { payload: base, assets, segmentsPayload };
}

async function writeAssignments(projectPath, payload) {
  payload.updatedAt = new Date().toISOString();
  const segmentsPath = path.join(projectPath, SEGMENTS_FILE);
  const segmentsPayload = await readJson(segmentsPath);
  const segmentById = new Map(
    (segmentsPayload?.segments || []).map((segment) => [segment.id, segment]),
  );
  payload.segments = payload.segments.map((assignment) => {
    const timeline = compileTimeline({
      ...(segmentById.get(assignment.segmentId) || {}),
      items: assignment.items,
    });
    return {
      ...assignment,
      timeline,
    };
  });
  await fs.writeFile(
    path.join(projectPath, ASSIGNMENTS_FILE),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
  if (segmentsPayload?.segments) {
    const assignmentById = new Map(
      payload.segments.map((assignment) => [assignment.segmentId, assignment]),
    );
    segmentsPayload.segments = segmentsPayload.segments.map((segment) => {
      const assignment = assignmentById.get(segment.id);
      if (!assignment) return segment;
      const timeline = compileTimeline({ ...segment, items: assignment.items });
      return {
        ...segment,
        timeline,
        durationSec: getSegmentDuration({ timeline }),
      };
    });
    segmentsPayload.updatedAt = payload.updatedAt;
    await fs.writeFile(segmentsPath, `${JSON.stringify(segmentsPayload, null, 2)}\n`, 'utf8');
  }
  await writeProjectState(projectPath);
  return payload;
}

async function loadStage3State(projectPath) {
  const { payload, assets } = await normalizePayload(projectPath);
  const savedPayload = await writeAssignments(projectPath, payload);
  return { assignmentsPayload: savedPayload, assets };
}

async function saveAssignments(projectPath, segments) {
  const { payload } = await normalizePayload(projectPath, segments);
  return writeAssignments(projectPath, payload);
}

function getDefaultItem(asset, remainingSec, order) {
  let defaultDuration = asset.type === 'image'
    ? 3
    : Math.min(Number.isFinite(asset.durationSec) ? asset.durationSec : 5, 5);
  if (Number.isFinite(remainingSec) && remainingSec > 0 && remainingSec < defaultDuration) {
    defaultDuration = remainingSec;
  }
  defaultDuration = roundDuration(Math.max(0.1, defaultDuration));

  return {
    assetId: asset.id,
    filename: asset.filename,
    relativePath: asset.relativePath,
    type: asset.type,
    originalDurationSec: Number.isFinite(asset.durationSec) ? asset.durationSec : null,
    startOffsetSec: 0,
    durationSec: defaultDuration,
    fitMode: asset.type === 'image' ? 'push_in' : 'contain',
    audioMode: 'none',
    order,
    note: '',
  };
}

async function addAssetToSegment(projectPath, segmentId, assetId) {
  const { payload, assets, segmentsPayload } = await normalizePayload(projectPath);
  const segment = payload.segments.find((entry) => entry.segmentId === segmentId);
  if (!segment) throw new Error(`找不到分段：${segmentId}。`);
  const asset = assets.find((entry) => entry.id === assetId);
  if (!asset) throw new Error(`找不到素材：${assetId}，请先重新扫描精选素材。`);

  const segmentDefinition = segmentsPayload?.segments?.find((entry) => entry.id === segmentId);
  const compiled = compileTimeline({ ...segmentDefinition, items: segment.items });
  const voiceDuration = compiled.voiceDuration;
  const remaining = Number.isFinite(voiceDuration)
    ? roundDuration(voiceDuration - compiled.visualDuration)
    : null;
  segment.items.push(getDefaultItem(asset, remaining, segment.items.length + 1));
  segment.timeline = compileTimeline({ ...segmentDefinition, items: segment.items });
  return writeAssignments(projectPath, payload);
}

function autoFitItems(items, voiceDuration) {
  if (!Number.isFinite(voiceDuration)) {
    throw new Error('未读取配音时长，无法自动补齐。');
  }
  if (!items.length) throw new Error('本段还没有素材，无法自动补齐。');

  const adjusted = items.map((item) => ({ ...item }));
  let difference = roundDuration(
    voiceDuration - compileTimeline({ items: adjusted }).visualDuration,
  );

  if (difference > 0.05) {
    const last = adjusted[adjusted.length - 1];
    last.durationSec = roundDuration(last.durationSec + difference);
  } else if (difference < -0.05) {
    let excess = Math.abs(difference);
    for (let index = adjusted.length - 1; index >= 0 && excess > 0.005; index -= 1) {
      const reducible = roundDuration(Math.max(0, adjusted[index].durationSec - 0.1));
      const reduction = Math.min(reducible, excess);
      adjusted[index].durationSec = roundDuration(adjusted[index].durationSec - reduction);
      excess = roundDuration(excess - reduction);
    }
  }

  return adjusted.map((item, index) => ({
    ...item,
    durationSec: roundDuration(Math.max(0.1, item.durationSec)),
    order: index + 1,
  }));
}

async function autoFitSegment(projectPath, segmentId) {
  const { payload, segmentsPayload } = await normalizePayload(projectPath);
  const assignment = payload.segments.find((entry) => entry.segmentId === segmentId);
  const segment = segmentsPayload?.segments?.find((entry) => entry.id === segmentId);
  if (!assignment || !segment) throw new Error(`找不到分段：${segmentId}。`);
  const timeline = compileTimeline({ ...segment, items: assignment.items });
  assignment.items = autoFitItems(assignment.items, timeline.voiceDuration);
  assignment.timeline = compileTimeline({ ...segment, items: assignment.items });
  return writeAssignments(projectPath, payload);
}

function safeFilename(value) {
  const safe = String(value || '')
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/g, '')
    .trim();
  return safe || '未命名';
}

async function assertFile(filePath, label) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`${label}不存在：${filePath}`);
}

async function syncSegmentPackages(projectPath) {
  const { payload, segmentsPayload } = await normalizePayload(projectPath);
  if (!segmentsPayload?.segments?.length) {
    throw new Error('尚未导入视频方案，无法同步分段素材包。');
  }
  await backupCoreProjectJson(projectPath);

  const segmentsById = new Map(
    segmentsPayload.segments.map((segment) => [segment.id, segment]),
  );

  for (const assignment of payload.segments) {
    for (const item of assignment.items) {
      await assertFile(path.join(projectPath, item.relativePath), `素材 ${item.assetId}`);
    }
    const segment = segmentsById.get(assignment.segmentId);
    const voiceFiles = segment?.voiceFiles?.length
      ? segment.voiceFiles
      : (segment?.voiceFile ? [segment.voiceFile] : []);
    for (const voiceFile of voiceFiles) {
      await assertFile(path.join(projectPath, voiceFile), `第 ${segment.id} 段配音`);
    }
  }

  const packageRoot = path.join(projectPath, SEGMENT_PACKAGES_DIR);
  const stagingRoot = path.join(
    projectPath,
    `.${SEGMENT_PACKAGES_DIR}-sync-${Date.now()}`,
  );
  await fs.mkdir(stagingRoot, { recursive: true });

  let copiedAssetCount = 0;
  try {
    for (const assignment of payload.segments) {
      const segment = segmentsById.get(assignment.segmentId);
      if (!segment) continue;
      const folderName = `${segment.id}-${safeFilename(segment.title)}`;
      const targetDir = path.join(stagingRoot, folderName);
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(
        path.join(targetDir, '口播.txt'),
        `${segment.voiceoverText || ''}\n`,
        'utf8',
      );

      const voiceFiles = segment.voiceFiles?.length
        ? segment.voiceFiles
        : (segment.voiceFile ? [segment.voiceFile] : []);
      for (const voiceFile of voiceFiles) {
        await fs.copyFile(
          path.join(projectPath, voiceFile),
          path.join(targetDir, path.basename(voiceFile)),
        );
      }

      const copiedAssets = new Set();
      for (const item of assignment.items) {
        if (copiedAssets.has(item.relativePath)) continue;
        await fs.copyFile(
          path.join(projectPath, item.relativePath),
          path.join(targetDir, item.filename),
        );
        copiedAssets.add(item.relativePath);
        copiedAssetCount += 1;
      }

      const timeline = compileTimeline({ ...segment, items: assignment.items });
      const segmentPlan = {
        segmentId: segment.id,
        title: segment.title,
        voiceoverText: segment.voiceoverText,
        voiceFile: segment.voiceFile,
        voiceFiles,
        voiceTrack: segment.voiceTrack,
        timeline,
        items: assignment.items.map((item) => ({
          assetId: item.assetId,
          filename: item.filename,
          durationSec: item.durationSec,
          fitMode: item.fitMode,
          audioMode: item.audioMode,
          order: item.order,
        })),
      };
      await fs.writeFile(
        path.join(targetDir, 'segment-plan.json'),
        `${JSON.stringify(segmentPlan, null, 2)}\n`,
        'utf8',
      );
    }

    await fs.rm(packageRoot, { recursive: true, force: true });
    await fs.rename(stagingRoot, packageRoot);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  await writeProjectState(projectPath);
  return {
    segmentCount: payload.segments.length,
    copiedAssetCount,
    packageRoot,
  };
}

module.exports = {
  FIT_MODES,
  AUDIO_MODES,
  getDefaultItem,
  autoFitItems,
  safeFilename,
  loadStage3State,
  saveAssignments,
  addAssetToSegment,
  autoFitSegment,
  syncSegmentPackages,
};
