const { fcpTime } = require('./fcpxml-service');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function timelineDuration(shots) {
  return asArray(shots).reduce((total, shot) => total + (Number(shot.durationSec) || 0), 0);
}

function locateShot(shots, timeSec, totalDurationSec = timelineDuration(shots)) {
  const time = Number(timeSec);
  if (!Number.isFinite(time)) return null;
  let cursor = 0;
  for (const [index, shot] of asArray(shots).entries()) {
    const end = cursor + (Number(shot.durationSec) || 0);
    if ((time >= cursor && time < end)
      || (index === shots.length - 1 && time === totalDurationSec)) {
      return { shot, index, timelineStartSec: cursor, timelineEndSec: end };
    }
    cursor = end;
  }
  return null;
}

function formatFcpTimecode(seconds, fps, totalDurationSec = null) {
  const rate = Number(fps);
  const raw = Number(seconds);
  if (!Number.isFinite(raw) || !Number.isFinite(rate) || rate <= 0) return null;
  const upper = Number.isFinite(totalDurationSec) ? Math.max(0, totalDurationSec) : raw;
  const clamped = Math.min(Math.max(raw, 0), upper);
  const roundedRate = Math.max(1, Math.round(rate));
  let frames = Math.round(clamped * rate);
  const hours = Math.floor(frames / (roundedRate * 3600));
  frames -= hours * roundedRate * 3600;
  const minutes = Math.floor(frames / (roundedRate * 60));
  frames -= minutes * roundedRate * 60;
  const wholeSeconds = Math.floor(frames / roundedRate);
  const frame = frames - wholeSeconds * roundedRate;
  return [hours, minutes, wholeSeconds, frame]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function xmlAttribute(attributes, name) {
  return attributes.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] || null;
}

function inspectFcpxml(xml) {
  const markers = [...String(xml || '').matchAll(/<marker\s+([^>]+)\/>/g)].map((match) => ({
    start: xmlAttribute(match[1], 'start'),
    value: decodeXml(xmlAttribute(match[1], 'value')),
  }));
  const titles = [...String(xml || '').matchAll(/<title\s+([^>]+)>([\s\S]*?)<\/title>/g)].map((match) => ({
    ref: xmlAttribute(match[1], 'ref'),
    lane: Number(xmlAttribute(match[1], 'lane')),
    offset: xmlAttribute(match[1], 'offset'),
    duration: xmlAttribute(match[1], 'duration'),
    name: decodeXml(xmlAttribute(match[1], 'name')),
    text: decodeXml(match[2].match(/<text-style\b[^>]*>([\s\S]*?)<\/text-style>/)?.[1] || ''),
  }));
  return { markers, titles };
}

function markerSubtitle(marker) {
  const subtitle = marker?.subtitle && typeof marker.subtitle === 'object'
    ? marker.subtitle
    : null;
  return {
    enabled: subtitle?.enabled === true,
    text: subtitle?.text || marker?.text || null,
    durationSec: Number.isFinite(subtitle?.durationSec)
      ? subtitle.durationSec
      : (Number.isFinite(marker?.durationSec) ? marker.durationSec : null),
    position: subtitle?.position || marker?.position || null,
    purpose: subtitle?.purpose || marker?.purpose || marker?.note || null,
    renderAsFcpTitle: subtitle?.renderAsFcpTitle === true,
    hasExtension: Boolean(subtitle),
  };
}

function createMarkerViewModel({
  analysis,
  baseAnalysis = analysis,
  manifest,
  status,
  fcpxml = '',
}) {
  const timeline = analysis?.timeline || {};
  const shots = asArray(timeline.shots);
  const markers = asArray(timeline.markers);
  const baseMarkers = asArray(baseAnalysis?.timeline?.markers);
  const totalDurationSec = Number(timelineDuration(shots).toFixed(3));
  const fps = Number(timeline.fps) || Number(status?.formats?.timeline?.fps) || 30;
  const manifestById = new Map(asArray(manifest?.items).map((item) => [item.assetId, item]));
  const mappingById = new Map(asArray(status?.assetMappings).map((item) => [item.assetId, item]));
  const xml = inspectFcpxml(fcpxml);
  const source = status?.hyperframes?.enabled === true && status?.effectiveAnalysis
    ? 'effectiveAnalysis'
    : 'analysis';

  const items = markers.map((marker, index) => {
    const timeSec = Number(marker.timeSec);
    const located = locateShot(shots, timeSec, totalDurationSec);
    const shot = located?.shot || null;
    const mapping = shot ? mappingById.get(shot.assetId) : null;
    const sourceItem = shot ? manifestById.get(shot.assetId) : null;
    const subtitle = markerSubtitle(marker);
    const stillOffset = mapping?.type === 'image' || sourceItem?.type === 'image' ? 3600 : 0;
    const sourceTimeSec = located
      ? stillOffset + (Number(shot.inSec) || 0) + timeSec - located.timelineStartSec
      : null;
    const expectedStart = Number.isFinite(sourceTimeSec) ? fcpTime(sourceTimeSec) : null;
    const baseMarker = marker.id
      ? baseMarkers.find((item) => item.id === marker.id)
      : baseMarkers[index];
    const timeAdjusted = source === 'effectiveAnalysis'
      && Number.isFinite(baseMarker?.timeSec)
      && Math.abs(baseMarker.timeSec - timeSec) > 0.0005;
    const writtenMarker = xml.markers.some((item) => (
      item.value === marker.text && (!expectedStart || item.start === expectedStart)
    ));
    const generatedTitle = subtitle.enabled && subtitle.renderAsFcpTitle
      ? xml.titles.some((item) => (
        item.text === subtitle.text && item.lane > 0 && (!expectedStart || item.offset === expectedStart)
      ))
      : false;
    return {
      key: marker.id || `marker-index-${index}`,
      id: marker.id || null,
      timeSec,
      timecode: formatFcpTimecode(timeSec, fps, totalDurationSec),
      outOfRange: !Number.isFinite(timeSec) || timeSec < 0 || timeSec > totalDurationSec,
      shotId: marker.shotId || shot?.id || null,
      shotOrder: located ? located.index + 1 : null,
      assetId: shot?.assetId || null,
      assetFilename: sourceItem?.filename || mapping?.projectFilename || null,
      text: subtitle.text,
      markerText: marker.text || null,
      type: marker.type || null,
      purpose: subtitle.purpose,
      durationSec: subtitle.durationSec,
      position: subtitle.position,
      enabled: subtitle.enabled,
      shouldGenerateFcpTitle: subtitle.enabled && subtitle.renderAsFcpTitle,
      writtenToFcpxmlMarker: writtenMarker,
      generatedFcpTitle: generatedTitle,
      timeAdjustedByHyperframes: timeAdjusted,
      sourceTimeSec,
      hasSubtitleExtension: subtitle.hasExtension,
    };
  });

  return {
    source,
    fps,
    totalDurationSec,
    hyperframesAdjusted: items.some((item) => item.timeAdjustedByHyperframes),
    markerCount: items.length,
    enabledSubtitleCount: items.filter((item) => item.enabled).length,
    fcpTitleCount: items.filter((item) => item.generatedFcpTitle).length,
    allMarkersWritten: items.length === 0 || items.every((item) => item.writtenToFcpxmlMarker),
    allRequestedTitlesGenerated: items
      .filter((item) => item.shouldGenerateFcpTitle)
      .every((item) => item.generatedFcpTitle),
    items,
  };
}

module.exports = {
  createMarkerViewModel,
  formatFcpTimecode,
  inspectFcpxml,
  locateShot,
  markerSubtitle,
  timelineDuration,
};
