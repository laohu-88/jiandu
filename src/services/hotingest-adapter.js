'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const ADAPTER_SCHEMA_VERSION = 1;
const MAX_FIELD_CHARS = 8_000;
const MAX_TEXT_CHARS = 16_000;

const KNOWN_ITEM_TOP_KEYS = Object.freeze([
  'schema_version', 'source', 'platform_id', 'media_type', 'discovered_at',
  'original_run', 'original_item', 'translation_snapshot', 'layout_version',
  'selected_index', 'visible_files', 'hidden_metadata_path', 'legacy_final_path',
  'migrated_at', 'batch_id', 'moved_at', 'title', 'body', 'description',
  'translated_title', 'translated_body', 'translation', 'author', 'published_at',
  'source_url', 'tags', 'comments', 'top_comments', 'language',
]);

const KNOWN_ORIGINAL_ITEM_KEYS = Object.freeze([
  'title', 'download_status', 'exclusion_reason', 'exclusion_signal', 'failure_reason',
  'failure_stage', 'attempt_count', 'tags', 'published_at', 'media_type', 'media_url',
  'author', 'actual_mime', 'actual_bytes', 'duration_seconds', 'duration',
  'local_context_path', 'context_quality', 'context_missing_fields', 'filter_decision',
  'estimated_selected_probability', 'post_id', 'post_url', 'description', 'upvotes',
  'comments_count', 'top_comments', 'has_audio', 'source_has_audio', 'stream_types',
  'representation', 'section', 'external_source_url', 'local_entity_path',
  'listing_source', 'listing_sources', 'listing_rank', 'listing_ranks', 'fetched_at',
  'video_id', 'channel_id', 'channel_title', 'view_count', 'like_count',
  'thumbnail_url', 'local_video_path', 'local_thumbnail_path', 'source_url',
  'regions', 'region_ranks', 'source', 'platform_id', 'canonical_uri',
  'remote_local_id', 'body', 'account', 'community', 'instance', 'external_url',
  'score', 'comment_count', 'boosts_count', 'favourites_count', 'language',
  'content_warning', 'media_description', 'comments', 'local_media_paths',
  'unsupported_media_types', 'comments_status', 'selftext',
  'category_id', 'category_title', 'quality_exclusion_reason',
  'profile_id', 'profile_version', 'profile_score', 'discovery_path',
  'query_group', 'matched_positive_signals', 'matched_negative_signals',
  'watch_signals', 'accepted_reason',
]);

const KNOWN_TRANSLATION_KEYS = Object.freeze([
  'field', 'label', 'original_text', 'translated_text', 'status',
  'detected_language', 'target_language', 'translated_at', 'partial',
  'failure_reason_code',
]);

const KNOWN_MANIFEST_TOP_KEYS = Object.freeze([
  'schema_version', 'layout_version', 'date', 'updated_at', 'items',
]);

const KNOWN_MANIFEST_ITEM_KEYS = Object.freeze([
  'index', 'source', 'platform_id', 'decision_key', 'original_run', 'moved_at',
  'batch_id', 'visible_files', 'hidden_metadata', 'files', 'legacy_final_path',
  'migrated_at',
]);

const VISUAL_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.tif', '.tiff', '.bmp', '.gif',
  '.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mts', '.m2ts',
]);

function normalizeValue(value) {
  return String(value ?? '').replace(/\0/g, '').replace(/[ \t]+/g, ' ').trim();
}

function normalizeScalar(value, maximum = MAX_FIELD_CHARS) {
  const normalized = normalizeValue(value).replace(/\n{3,}/g, '\n\n');
  return normalized ? normalized.slice(0, maximum) : null;
}

function decodeHtmlEntities(value) {
  const named = new Map([
    ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
    ['nbsp', ' '],
  ]);
  return String(value || '').replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z][a-z0-9]+);?/gi,
    (entity, code) => {
      if (code[0] !== '#') return named.get(code.toLowerCase()) ?? entity;
      const numeric = code[1]?.toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0x10ffff) return entity;
      try {
        return String.fromCodePoint(numeric);
      } catch {
        return entity;
      }
    },
  );
}

function stripHtml(rawHtml) {
  return decodeHtmlEntities(String(rawHtml || '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|pre|div|section|article|li|h[1-6])\s*>/gi, '\n')
    .replace(/<(p|pre|div|section|article|li|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>?/g, ' '))
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TEXT_CHARS);
}

function pickFirst(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const normalized = normalizeScalar(value);
      if (normalized) return normalized;
    }
  }
  return null;
}

function unknownKeys(object, known) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return [];
  const allowed = new Set(known);
  return Object.keys(object).filter((key) => !allowed.has(key) && !key.startsWith('_'));
}

function parseTags(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[,，、#\n]+/);
  const result = [];
  const seen = new Set();
  for (const entry of source) {
    const tag = normalizeScalar(
      typeof entry === 'object' && entry ? entry.name ?? entry.tag ?? '' : entry,
      100,
    );
    const key = tag?.toLocaleLowerCase('en-US');
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= 50) break;
  }
  return result;
}

function commentsText(value) {
  if (!value) return null;
  if (typeof value === 'string') return normalizeScalar(value);
  const list = Array.isArray(value) ? value : [];
  const lines = list.map((item) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    const author = item.author || item.account || '';
    const body = item.body || item.text || item.content || '';
    return [author, body].filter(Boolean).join(': ');
  }).filter(Boolean);
  return normalizeScalar(lines.join('\n'));
}

function parseTranslationSnapshot(snapshot) {
  if (!Array.isArray(snapshot)) return [];
  return snapshot.map((entry) => {
    const object = entry && typeof entry === 'object' ? entry : {};
    return {
      field: normalizeScalar(object.field, 120),
      label: normalizeScalar(object.label, 120),
      originalText: normalizeScalar(object.original_text),
      translatedText: normalizeScalar(object.translated_text),
      status: normalizeScalar(object.status, 80),
      detectedLanguage: normalizeScalar(object.detected_language, 40),
      targetLanguage: normalizeScalar(object.target_language, 40),
      partial: object.partial === true,
      failureReasonCode: normalizeScalar(object.failure_reason_code, 120) || '',
      unknownKeys: unknownKeys(object, KNOWN_TRANSLATION_KEYS),
    };
  }).filter((entry) => entry.field || entry.translatedText || entry.originalText);
}

function translationForField(entries, field) {
  const hit = entries.find((entry) => entry.field === field && entry.translatedText);
  return hit?.translatedText || null;
}

function collectDrift(parts) {
  return parts.filter((item) => item.keys.length).map((item) => ({
    path: item.path,
    keys: item.keys,
    message: `HotIngest schema drift：${item.path} 出现未识别字段 ${item.keys.join('、')}`,
  }));
}

function parseMetadataDocument(value) {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const original = object.original_item && typeof object.original_item === 'object' && !Array.isArray(object.original_item)
    ? object.original_item
    : {};
  const translations = parseTranslationSnapshot(object.translation_snapshot);
  const merged = { ...original, ...object };
  const title = pickFirst(merged, ['title', 'name']);
  const body = normalizeScalar([
    pickFirst(merged, ['body', 'selftext', 'content', 'text']),
    pickFirst(merged, ['description', 'media_description', 'caption']),
  ].filter(Boolean).join('\n\n'));
  const translation = [
    translationForField(translations, 'title'),
    translationForField(translations, 'body'),
    translationForField(translations, 'description'),
    translationForField(translations, 'selftext'),
    pickFirst(object, ['translated_title', 'title_zh', 'translated_body', 'translated_text', 'translation']),
  ].filter(Boolean);
  const uniqueTranslation = [...new Set(translation)];
  const explanationCandidates = translations
    .filter((entry) => entry.translatedText && entry.status !== 'already_chinese')
    .map((entry) => entry.translatedText);
  const drift = collectDrift([
    { path: 'item', keys: unknownKeys(object, KNOWN_ITEM_TOP_KEYS) },
    { path: 'original_item', keys: unknownKeys(original, KNOWN_ORIGINAL_ITEM_KEYS) },
    ...translations.map((entry, index) => ({
      path: `translation_snapshot[${index}]`,
      keys: entry.unknownKeys,
    })),
  ]);
  const authorValue = merged.author;
  const author = typeof authorValue === 'object' && authorValue
    ? pickFirst(authorValue, ['name', 'username', 'acct', 'display_name'])
    : pickFirst(merged, ['author', 'channel_title', 'account', 'creator']);
  return {
    title,
    body,
    translation: uniqueTranslation.length ? normalizeScalar(uniqueTranslation.join('\n\n')) : null,
    platform: pickFirst(merged, ['source', 'platform', 'site']),
    sourceUrl: pickFirst(merged, [
      'source_url', 'post_url', 'canonical_uri', 'external_source_url', 'original_url', 'url',
    ]),
    author,
    publishedAt: pickFirst(merged, ['published_at', 'created_at', 'published', 'date']),
    tags: parseTags(merged.tags || merged.hashtags || []),
    comments: commentsText(merged.comments || merged.top_comments),
    indexSupplement: null,
    sourceItemKey: pickFirst(merged, [
      'decision_key', 'platform_id', 'source_item_id', 'source_id', 'post_id', 'item_id', 'video_id',
    ]),
    language: pickFirst(merged, ['language', 'lang', 'source_language'])
      || translations[0]?.detectedLanguage
      || null,
    translationEntries: translations,
    explanationCandidates: [...new Set(explanationCandidates)],
    hasAudio: typeof merged.has_audio === 'boolean' ? merged.has_audio : null,
    sourceHasAudio: typeof merged.source_has_audio === 'boolean' ? merged.source_has_audio : null,
    streamTypes: Array.isArray(merged.stream_types) ? merged.stream_types.map(String) : [],
    mediaType: pickFirst(merged, ['media_type']),
    durationSec: Number.isFinite(Number(merged.duration_seconds || merged.duration))
      ? Number(merged.duration_seconds || merged.duration)
      : null,
    selectedIndex: Number.isFinite(Number(object.selected_index)) ? Number(object.selected_index) : null,
    decisionKey: object.platform_id && object.source
      ? `${object.source}:${object.platform_id}`
      : pickFirst(merged, ['decision_key']),
    visibleFiles: Array.isArray(object.visible_files) ? object.visible_files.map(String) : [],
    rawOriginalItem: original,
    schemaDrift: drift,
  };
}

function extractSection(rawHtml, headingPattern) {
  const pattern = new RegExp(
    `<h3\\b[^>]*>\\s*${headingPattern}\\s*<\\/h3>\\s*<pre\\b[^>]*>([\\s\\S]*?)<\\/pre>`,
    'i',
  );
  const match = String(rawHtml || '').match(pattern);
  return match ? normalizeScalar(decodeHtmlEntities(match[1].replace(/<[^>]*>/g, ''))) : null;
}

function extractHotIngestHtmlFields(rawHtml) {
  const html = String(rawHtml || '');
  const text = stripHtml(html);
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const h1 = (html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  const title = normalizeScalar(h1 ? decodeHtmlEntities(h1.replace(/<[^>]*>/g, '')) : '')
    || extractSection(html, '原文\\s*[·.]\\s*标题')
    || null;
  const metaLine = lines.find((line) => /来源：/.test(line) && /作者：/.test(line)) || '';
  const meta = {};
  for (const part of metaLine.split(/[·•|]/)) {
    const match = part.match(/^(来源|作者|发布时间)\s*[：:]\s*(.+)$/);
    if (match) meta[match[1]] = normalizeScalar(match[2]);
  }
  const sourceLink = (html.match(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>\s*原始来源/i) || [])[1];
  const originalTitle = extractSection(html, '原文\\s*[·.]\\s*标题');
  const translatedTitle = extractSection(html, '中文对照\\s*[·.]\\s*标题');
  const originalBody = extractSection(html, '原文\\s*[·.]\\s*(?:正文|描述|说明|内容)');
  const translatedBody = extractSection(html, '中文对照\\s*[·.]\\s*(?:正文|描述|说明|内容)');
  const translation = [translatedTitle, translatedBody].filter(Boolean);
  return {
    title: title || originalTitle,
    body: originalBody || null,
    translation: translation.length ? translation.join('\n\n') : translatedTitle,
    platform: meta['来源'] || null,
    sourceUrl: sourceLink || null,
    author: meta['作者'] || null,
    publishedAt: meta['发布时间'] || null,
    tags: [],
    comments: null,
    indexSupplement: null,
    sourceItemKey: null,
    language: null,
    explanationCandidates: translation,
  };
}

function parseMetadataFields(value) {
  const parsed = parseMetadataDocument(value);
  return {
    title: parsed.title,
    body: parsed.body,
    translation: parsed.translation,
    platform: parsed.platform,
    sourceUrl: parsed.sourceUrl,
    author: parsed.author,
    publishedAt: parsed.publishedAt,
    tags: parsed.tags,
    comments: parsed.comments,
    indexSupplement: parsed.indexSupplement,
    sourceItemKey: parsed.sourceItemKey,
    language: parsed.language,
    translationEntries: parsed.translationEntries,
    explanationCandidates: parsed.explanationCandidates,
    hasAudio: parsed.hasAudio,
    sourceHasAudio: parsed.sourceHasAudio,
    streamTypes: parsed.streamTypes,
    mediaType: parsed.mediaType,
    durationSec: parsed.durationSec,
    selectedIndex: parsed.selectedIndex,
    decisionKey: parsed.decisionKey,
    visibleFiles: parsed.visibleFiles,
    rawOriginalItem: parsed.rawOriginalItem,
    schemaDrift: parsed.schemaDrift,
  };
}

function classifyCanonicalFile(relativePath) {
  const normalized = String(relativePath || '').split(path.sep).join('/');
  const basename = path.posix.basename(normalized);
  const lower = basename.toLocaleLowerCase('en-US');
  if (lower === '_素材索引.html' || lower === '_素材索引.htm') {
    return { role: 'folder-index', type: 'folder-index-html' };
  }
  if (/(?:^|\/)\.hotingest\/manifest\.json$/i.test(normalized)) {
    return { role: 'package-manifest', type: 'package-manifest' };
  }
  if (/\.context\.html?$/i.test(basename)) {
    return { role: 'asset-sidecar', type: 'context-html' };
  }
  if (/\.text\.html?$/i.test(basename)) {
    return { role: 'asset-sidecar', type: 'text-html' };
  }
  if (/(?:^|\/)\.hotingest\/items\/\d+\.json$/i.test(normalized)) {
    return { role: 'asset-sidecar', type: 'metadata-json' };
  }
  if (VISUAL_EXTENSIONS.has(path.extname(basename).toLowerCase())) {
    return { role: 'media', type: 'visual-media' };
  }
  return null;
}

function assetRole(filename, index, siblings) {
  const ext = path.extname(filename).toLowerCase();
  const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext);
  const numbered = String(filename).match(/_(\d{2})\.[^.]+$/);
  if (numbered && Number(numbered[1]) > 1 && isImage) return 'thumbnail';
  if (index === 0) return 'primary';
  return isImage ? 'gallery' : 'other';
}

function parseManifestDocument(value) {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const items = Array.isArray(object.items) ? object.items : [];
  const drift = collectDrift([
    { path: 'manifest', keys: unknownKeys(object, KNOWN_MANIFEST_TOP_KEYS) },
    ...items.map((item, index) => ({
      path: `manifest.items[${index}]`,
      keys: unknownKeys(item, KNOWN_MANIFEST_ITEM_KEYS),
    })),
  ]);
  return {
    schemaVersion: object.schema_version ?? null,
    layoutVersion: object.layout_version ?? null,
    date: object.date || null,
    items,
    schemaDrift: drift,
  };
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function buildCanonicalInventory(sourceDirectory, files = []) {
  const root = path.resolve(String(sourceDirectory || ''));
  const list = Array.isArray(files) ? files : [];
  const classified = list.map((file) => ({
    ...file,
    classification: classifyCanonicalFile(file.relativePath || file.filename),
  }));
  const manifestFile = classified.find((file) => file.classification?.type === 'package-manifest');
  const metadataFiles = classified.filter((file) => file.classification?.type === 'metadata-json');
  const mediaFiles = classified.filter((file) => file.classification?.type === 'visual-media');
  const warnings = [];
  const schemaDrift = [];
  let manifest = null;
  if (manifestFile?.absolutePath) {
    const raw = await readJsonIfPresent(manifestFile.absolutePath);
    if (raw) {
      manifest = parseManifestDocument(raw);
      schemaDrift.push(...manifest.schemaDrift);
    } else {
      warnings.push(`${manifestFile.relativePath} 无法解析。`);
    }
  }

  const items = [];
  const usedMedia = new Set();
  for (const metaFile of metadataFiles) {
    const raw = metaFile.absolutePath ? await readJsonIfPresent(metaFile.absolutePath) : null;
    if (!raw) {
      warnings.push(`${metaFile.relativePath} 无法解析。`);
      continue;
    }
    const parsed = parseMetadataDocument(raw);
    schemaDrift.push(...parsed.schemaDrift);
    const visible = parsed.visibleFiles.length
      ? parsed.visibleFiles
      : [];
    const assets = [];
    const visualNames = visible.filter((name) => VISUAL_EXTENSIONS.has(path.extname(name).toLowerCase()));
    visualNames.forEach((name, index) => {
      const match = mediaFiles.find((file) => path.basename(file.relativePath || file.filename) === name)
        || list.find((file) => path.basename(file.relativePath || file.filename || '') === name);
      if (match) usedMedia.add(match.relativePath || match.filename);
      assets.push({
        role: assetRole(name, index, visualNames),
        relativePath: match?.relativePath || name,
        filename: name,
        kind: ['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm'].includes(path.extname(name).toLowerCase())
          ? 'video'
          : 'image',
      });
    });
    items.push({
      decisionKey: parsed.decisionKey,
      source: parsed.platform,
      platformId: parsed.sourceItemKey,
      selectedIndex: parsed.selectedIndex,
      mediaType: parsed.mediaType,
      assets,
      original: {
        title: parsed.title,
        body: parsed.body,
        language: parsed.language,
        tags: parsed.tags,
        comments: parsed.comments,
        author: parsed.author,
        publishedAt: parsed.publishedAt,
        sourceUrl: parsed.sourceUrl,
        audio: {
          hasAudio: parsed.hasAudio,
          sourceHasAudio: parsed.sourceHasAudio,
          streamTypes: parsed.streamTypes,
        },
        durationSec: parsed.durationSec,
        rawOriginalItem: parsed.rawOriginalItem,
        acceptedReason: parsed.rawOriginalItem?.accepted_reason || null,
        categoryTitle: parsed.rawOriginalItem?.category_title || null,
        matchedPositiveSignals: Array.isArray(parsed.rawOriginalItem?.matched_positive_signals)
          ? parsed.rawOriginalItem.matched_positive_signals
          : [],
      },
      translations: parsed.translationEntries,
      derived: {
        titleZh: translationForField(parsed.translationEntries, 'title'),
        bodyZh: translationForField(parsed.translationEntries, 'body')
          || translationForField(parsed.translationEntries, 'description'),
        explanationCandidates: parsed.explanationCandidates,
        groupingKey: parsed.decisionKey,
      },
      sidecars: {
        itemMetadataJson: metaFile.relativePath,
      },
    });
  }

  for (const media of mediaFiles) {
    const key = media.relativePath || media.filename;
    if (usedMedia.has(key)) continue;
    items.push({
      decisionKey: null,
      source: null,
      platformId: null,
      selectedIndex: null,
      mediaType: null,
      assets: [{
        role: 'primary',
        relativePath: media.relativePath,
        filename: path.basename(media.relativePath || media.filename || ''),
        kind: ['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm'].includes(
          path.extname(media.relativePath || '').toLowerCase(),
        ) ? 'video' : 'image',
      }],
      original: { rawOriginalItem: {} },
      translations: [],
      derived: { explanationCandidates: [], groupingKey: null },
      sidecars: {},
      warnings: ['hotingest-sidecars-missing'],
    });
  }

  if (!manifest && !metadataFiles.length && mediaFiles.length) {
    warnings.push('未发现 .hotingest 元数据；仅识别到媒体文件。');
  }

  return {
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    sourceSystem: 'hotingest',
    hotingest: {
      selectedDateDir: root,
      layoutVersion: manifest?.layoutVersion || null,
      manifestSchemaVersion: manifest?.schemaVersion || null,
    },
    items,
    schemaDrift,
    warnings: [
      ...warnings,
      ...schemaDrift.map((item) => item.message),
    ],
    detected: metadataFiles.length > 0 || Boolean(manifest),
  };
}

async function scanCanonicalInventory(sourceDirectory) {
  const root = path.resolve(String(sourceDirectory || ''));
  const files = [];
  async function walk(current, prefix) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      return [{ warning: error.message }];
    }
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({ relativePath, absolutePath, filename: entry.name });
    }
    return [];
  }
  await walk(root, '');
  return buildCanonicalInventory(root, files);
}

module.exports = {
  ADAPTER_SCHEMA_VERSION,
  KNOWN_ITEM_TOP_KEYS,
  KNOWN_ORIGINAL_ITEM_KEYS,
  classifyCanonicalFile,
  extractHotIngestHtmlFields,
  parseMetadataDocument,
  parseMetadataFields,
  parseManifestDocument,
  buildCanonicalInventory,
  scanCanonicalInventory,
  unknownKeys,
};
