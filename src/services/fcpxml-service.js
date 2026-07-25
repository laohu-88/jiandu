const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveTimelineFormat } = require('./video-format-service');
const { fcpxmlShouldMuteShot } = require('./visual-explanation-service');

const FCPXML_TIMESCALE = 60000;
const FCPXML_DEFAULT_VERSION = '1.10';
const FCPXML_TITLE_VERSION = '1.14';
const BASIC_TITLE_EFFECT = Object.freeze({
  name: '基本字幕',
  uid: '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti',
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
    if (timeSec >= cursor && timeSec < end) return { shot, timelineStart: cursor };
    cursor = end;
  }
  return null;
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
      };
    })
    .filter(Boolean);
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
  const markerTitles = collectFcpTitles(analysis);
  const managedTitles = normalizeManagedCaptionTitles(managedCaptionTitles);
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
  const titleEffectId = fcpTitles.length > 0 ? `r${nextResourceId++}` : null;

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
  const titleByShotId = new Map();
  for (const title of fcpTitles) {
    const located = getShotAtTime(analysis.timeline.shots, title.startSec);
    if (!located) continue;
    const titles = titleByShotId.get(located.shot.id) || [];
    titles.push({
      ...title,
      sourceTimeSec: located.shot.inSec + title.startSec - located.timelineStart,
    });
    titleByShotId.set(located.shot.id, titles);
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
        + ` uid="${assetUid(asset)}"`
        + ` start="0s" duration="${fcpTime(duration)}" hasVideo="1" videoSources="1"${audioAttributes}`
        + ` format="${asset.formatId}">\n`
        + `      <media-rep kind="original-media" src="${escapeXml(pathToFileURL(asset.projectAbsolutePath).href)}"/>\n`
        + '    </asset>';
    }),
    ...(titleEffectId ? [
      `    <effect id="${titleEffectId}" name="${escapeXml(BASIC_TITLE_EFFECT.name)}"`
      + ` uid="${escapeXml(BASIC_TITLE_EFFECT.uid)}"/>`,
    ] : []),
  ].join('\n');

  let timelineOffset = 0;
  const clipsXml = analysis.timeline.shots.map((shot) => {
    const mapping = mappingById.get(shot.assetId);
    const resourceId = assetResourceById.get(shot.assetId);
    if (!mapping || !resourceId) throw new Error(`FCPXML 缺少镜头素材映射：${shot.assetId}`);
    const nested = [];
    nested.push(`          <adjust-conform type="${shot.fitMode === 'cover' ? 'fill' : 'fit'}"/>`);
    if (fcpxmlShouldMuteShot(shot, analysisById.get(shot.assetId), mapping)) {
      nested.push('          <adjust-volume amount="-96dB"/>');
    }
    const stillTimeOffset = mapping.type === 'image' ? 3600 : 0;
    for (const title of titleByShotId.get(shot.id) || []) {
      const titleOffset = stillTimeOffset + title.sourceTimeSec;
      // FCPXML DTD: title children are param*, text*, text-style-def*, note?, ...
      // note is a child element — never a title attribute.
      const noteChild = title.note
        ? `            <note>${escapeXml(title.note)}</note>\n`
        : '';
      nested.push(
        `          <title ref="${titleEffectId}" lane="1" offset="${fcpTime(titleOffset)}"`
        + ` name="${escapeXml(`${title.text} - ${BASIC_TITLE_EFFECT.name}`)}"`
        + ` start="3600s" duration="${fcpTime(title.durationSec)}">\n`
        + '            <param name="展平" key="9999/999166631/999166633/2/351" value="1"/>\n'
        + '            <param name="对齐" key="9999/999166631/999166633/2/354/999169573/401" value="1 (居中)"/>\n'
        + '            <text>\n'
        + `              <text-style ref="ts-title-${title.index + 1}">${escapeXml(title.text)}</text-style>\n`
        + '            </text>\n'
        + `            <text-style-def id="ts-title-${title.index + 1}">\n`
        + '              <text-style font="Helvetica" fontSize="63" fontFace="Regular" fontColor="1 1 1 1" alignment="center"/>\n'
        + '            </text-style-def>\n'
        + noteChild
        + '          </title>',
      );
    }
    // FCPXML 1.14 的 DTD 要求锚定项（Title 等）位于 Marker 之前。
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

  const fcpxmlVersion = fcpTitles.length > 0 ? FCPXML_TITLE_VERSION : FCPXML_DEFAULT_VERSION;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="${fcpxmlVersion}">
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
  const version = xml.match(/<fcpxml\s+version="([^"]+)">/)?.[1] || null;
  if (![FCPXML_DEFAULT_VERSION, FCPXML_TITLE_VERSION].includes(version)) {
    errors.push('缺少受支持的 FCPXML 1.10/1.14 根节点。');
  }
  if (!/<resources>[\s\S]*<\/resources>/.test(xml)) errors.push('缺少 resources。');
  if (!/<sequence\b[^>]*>[\s\S]*<spine>[\s\S]*<\/spine>/.test(xml)) errors.push('缺少 sequence/spine。');
  const assets = [...xml.matchAll(/<asset\s+id="([^"]+)"/g)];
  const clips = [...xml.matchAll(/<(?:asset-clip|video)\s+[^>]*ref="([^"]+)"[^>]*>/g)];
  const markers = [...xml.matchAll(/<marker\s+/g)];
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
  for (const clip of clips) {
    if (!assetIds.has(clip[1])) errors.push(`时间线镜头引用了不存在的资源 ${clip[1]}。`);
  }
  for (const media of mediaRepresentations) {
    if (!media[1].startsWith('file://')) errors.push('素材资源不是 file URL。');
  }
  const managedTitleKeys = [];
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
    if (title.noteChild && title.noteChild.startsWith(MANAGED_CAPTION_NOTE_PREFIX)) {
      const titleKey = title.noteChild.slice(MANAGED_CAPTION_NOTE_PREFIX.length);
      if (!titleKey) {
        errors.push('受管 title 的 titleKey 为空。');
      } else {
        managedTitleKeys.push(titleKey);
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
  return {
    ok: errors.length === 0,
    errors,
    assetCount: assets.length,
    clipCount: clips.length,
    markerCount: markers.length,
    titleCount: titles.length,
    effectCount: effects.length,
    version,
    mediaUrls: mediaRepresentations.map((match) => match[1]),
    clipMediaUrls,
    sequenceFormat,
  };
}

async function writeFcpxml(outputPath, payload, options = {}) {
  const managedCaptionTitles = normalizeManagedCaptionTitles(payload.managedCaptionTitles);
  const xml = buildFcpxml(payload);
  const expectedTitleCount = Number.isInteger(options.expectedTitleCount)
    ? options.expectedTitleCount
    : collectFcpTitles(payload.analysis).length + managedCaptionTitles.length;
  const report = validateFcpxmlStructure(xml, {
    shotCount: payload.analysis.timeline.shots.length,
    assetCount: payload.assetMappings.length,
    markerCount: payload.analysis.timeline.markers.length,
    titleCount: expectedTitleCount,
    width: payload.analysis.timeline.width,
    height: payload.analysis.timeline.height,
    fps: payload.analysis.timeline.fps,
    clipMediaUrls: payload.analysis.timeline.shots.map((shot) => {
      const mapping = payload.assetMappings.find((item) => item.assetId === shot.assetId);
      return mapping ? pathToFileURL(mapping.projectAbsolutePath).href.replace(/&/g, '&amp;') : null;
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
    return { outputPath, report, managedTitleCount: managedCaptionTitles.length };
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
      const backupPath = path.join(directory, `.${path.basename(outputPath)}.prev`);
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
    managedTitleCount: managedCaptionTitles.length,
    restoredOnFailure: false,
  };
}

module.exports = {
  BASIC_TITLE_EFFECT,
  FCPXML_DEFAULT_VERSION,
  FCPXML_TITLE_VERSION,
  FCPXML_TIMESCALE,
  MANAGED_CAPTION_NOTE_PREFIX,
  assetUid,
  buildFcpxml,
  collectFcpTitles,
  escapeXml,
  extractManagedCaptionTitles,
  fcpTime,
  frameDuration,
  normalizeManagedCaptionTitles,
  validateFcpxmlStructure,
  writeFcpxml,
};
