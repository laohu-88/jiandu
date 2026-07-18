const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveTimelineFormat } = require('./video-format-service');

const FCPXML_TIMESCALE = 60000;

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function gcd(left, right) {
  let a = Math.abs(Math.round(left));
  let b = Math.abs(Math.round(right));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function fcpTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) throw new Error(`无效 FCP 时间：${seconds}`);
  if (value === 0) return '0s';
  const numerator = Math.round(value * FCPXML_TIMESCALE);
  const divisor = gcd(numerator, FCPXML_TIMESCALE);
  return `${numerator / divisor}/${FCPXML_TIMESCALE / divisor}s`;
}

function frameDuration(fps) {
  const value = Number(fps);
  if (Math.abs(value - 29.97) < 0.01) return '1001/30000s';
  if (Math.abs(value - 59.94) < 0.01) return '1001/60000s';
  const rounded = Math.round(value);
  return `1/${rounded || 30}s`;
}

function createFormatKey(width, height, fps, isStill = false) {
  if (isStill) return `${width || 1920}x${height || 1080}@still`;
  return `${width || 1920}x${height || 1080}@${Number(fps || 30).toFixed(3)}`;
}

function getShotAtTime(shots, timeSec) {
  let cursor = 0;
  for (const shot of shots) {
    const end = cursor + shot.durationSec;
    if (timeSec >= cursor && timeSec < end) return { shot, timelineStart: cursor };
    cursor = end;
  }
  return null;
}

function buildFcpxml({ projectName, analysis, assetMappings }) {
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
    assets.push({ ...mapping, formatId, resourceId });
  }

  const markerByShotId = new Map();
  for (const marker of analysis.timeline.markers) {
    const located = getShotAtTime(analysis.timeline.shots, marker.timeSec);
    if (!located) continue;
    const markers = markerByShotId.get(located.shot.id) || [];
    markers.push({
      ...marker,
      sourceTimeSec: located.shot.inSec + marker.timeSec - located.timelineStart,
    });
    markerByShotId.set(located.shot.id, markers);
  }

  const totalDuration = analysis.timeline.shots.reduce((sum, shot) => sum + shot.durationSec, 0);
  const resourcesXml = [
    ...formatResources.map((format) => (
      `    <format id="${format.id}"${format.isStill ? '' : ` frameDuration="${frameDuration(format.fps)}"`}`
      + ` width="${format.width}" height="${format.height}" colorSpace="1-1-1 (Rec. 709)"/>`
    )),
    ...assets.map((asset) => {
      const metadata = asset.metadata || {};
      const duration = asset.type === 'video' && Number.isFinite(metadata.durationSec)
        ? metadata.durationSec
        : 0;
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
        + ` start="0s" duration="${fcpTime(duration)}" hasVideo="1" videoSources="1"${audioAttributes}`
        + ` format="${asset.formatId}">\n`
        + `      <media-rep kind="original-media" src="${escapeXml(pathToFileURL(asset.projectAbsolutePath).href)}"/>\n`
        + '    </asset>';
    }),
  ].join('\n');

  let timelineOffset = 0;
  const clipsXml = analysis.timeline.shots.map((shot) => {
    const mapping = mappingById.get(shot.assetId);
    const resourceId = assetResourceById.get(shot.assetId);
    if (!mapping || !resourceId) throw new Error(`FCPXML 缺少镜头素材映射：${shot.assetId}`);
    const nested = [];
    nested.push(`          <adjust-conform type="${shot.fitMode === 'cover' ? 'fill' : 'fit'}"/>`);
    if (shot.audioMode === 'mute' && mapping.metadata?.hasAudio) {
      nested.push('          <adjust-volume amount="-96dB"/>');
    }
    const stillTimeOffset = mapping.type === 'image' ? 3600 : 0;
    for (const marker of markerByShotId.get(shot.id) || []) {
      nested.push(
        `          <marker start="${fcpTime(stillTimeOffset + marker.sourceTimeSec)}"`
        + ` duration="${frameDuration(analysis.timeline.fps)}" value="${escapeXml(marker.text)}"/>`,
      );
    }
    const audioRole = mapping.metadata?.hasAudio ? ' audioRole="dialogue"' : '';
    const clipElement = mapping.type === 'image' ? 'video' : 'asset-clip';
    const clip = `        <${clipElement} name="${escapeXml(mapping.projectFilename)}" ref="${resourceId}"`
      + ` offset="${fcpTime(timelineOffset)}" start="${fcpTime(stillTimeOffset + shot.inSec)}"`
      + ` duration="${fcpTime(shot.durationSec)}"${audioRole}>\n`
      + `${nested.join('\n')}\n`
      + `        </${clipElement}>`;
    timelineOffset += shot.durationSec;
    return clip;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
${resourcesXml}
  </resources>
  <library>
    <event name="${escapeXml(projectName)}">
      <project name="${escapeXml(analysis.titles.recommended)}">
        <sequence duration="${fcpTime(totalDuration)}" format="${sequenceFormatId}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
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

function validateFcpxmlStructure(xml, expected = {}) {
  const errors = [];
  if (!/^<\?xml[\s\S]*<fcpxml\s+version="1\.10">/.test(xml)) errors.push('缺少 FCPXML 1.10 根节点。');
  if (!/<resources>[\s\S]*<\/resources>/.test(xml)) errors.push('缺少 resources。');
  if (!/<sequence\b[^>]*>[\s\S]*<spine>[\s\S]*<\/spine>/.test(xml)) errors.push('缺少 sequence/spine。');
  const assets = [...xml.matchAll(/<asset\s+id="([^"]+)"/g)];
  const clips = [...xml.matchAll(/<(?:asset-clip|video)\s+[^>]*ref="([^"]+)"[^>]*>/g)];
  const markers = [...xml.matchAll(/<marker\s+/g)];
  const mediaRepresentations = [...xml.matchAll(/<media-rep\s+[^>]*src="([^"]+)"/g)];
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
  for (const clip of clips) {
    if (!assetIds.has(clip[1])) errors.push(`时间线镜头引用了不存在的资源 ${clip[1]}。`);
  }
  for (const media of mediaRepresentations) {
    if (!media[1].startsWith('file://')) errors.push('素材资源不是 file URL。');
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
  if (Number.isInteger(expected.width) && sequenceFormat?.width !== expected.width) {
    errors.push(`正式时间线宽度 ${sequenceFormat?.width || '未知'} 与预期 ${expected.width} 不一致。`);
  }
  if (Number.isInteger(expected.height) && sequenceFormat?.height !== expected.height) {
    errors.push(`正式时间线高度 ${sequenceFormat?.height || '未知'} 与预期 ${expected.height} 不一致。`);
  }
  if (Number.isFinite(expected.fps) && sequenceFormat?.frameDuration !== frameDuration(expected.fps)) {
    errors.push(`正式时间线帧率与预期 ${expected.fps} fps 不一致。`);
  }
  return {
    ok: errors.length === 0,
    errors,
    assetCount: assets.length,
    clipCount: clips.length,
    markerCount: markers.length,
    mediaUrls: mediaRepresentations.map((match) => match[1]),
    sequenceFormat,
  };
}

async function writeFcpxml(outputPath, payload) {
  const xml = buildFcpxml(payload);
  const report = validateFcpxmlStructure(xml, {
    shotCount: payload.analysis.timeline.shots.length,
    assetCount: payload.assetMappings.length,
    markerCount: payload.analysis.timeline.markers.length,
    width: payload.analysis.timeline.width,
    height: payload.analysis.timeline.height,
    fps: payload.analysis.timeline.fps,
  });
  if (!report.ok) {
    throw Object.assign(new Error(`FCPXML 结构校验失败：${report.errors[0]}`), {
      code: 'INVALID_FCPXML',
      details: report.errors,
    });
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, xml, 'utf8');
  return { outputPath, report };
}

module.exports = {
  FCPXML_TIMESCALE,
  buildFcpxml,
  escapeXml,
  fcpTime,
  frameDuration,
  validateFcpxmlStructure,
  writeFcpxml,
};
