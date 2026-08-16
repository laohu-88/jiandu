const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hotingestAdapter = require('./hotingest-adapter');

const MAX_CONTEXT_FILE_BYTES = 256 * 1024;
const MAX_CONTEXT_TEXT_CHARS = 16_000;
const MAX_FIELD_CHARS = 8_000;
const MAX_TAGS = 50;
const MAX_ANALYSIS_CONTEXT_CHARS_PER_ASSET = 4_000;
const MAX_ANALYSIS_CONTEXT_TOTAL_CHARS = 64_000;
const VISUAL_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.tif', '.tiff', '.bmp', '.gif',
  '.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mts', '.m2ts',
]);
const FIELD_PRIORITIES = {
  'metadata-json': 400,
  'context-html': 300,
  'text-html': 250,
  'folder-index': 100,
};
const FIELD_KEYS = [
  'title',
  'body',
  'translation',
  'platform',
  'sourceUrl',
  'author',
  'publishedAt',
  'tags',
  'comments',
  'indexSupplement',
  'sourceItemKey',
  'language',
];

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

function normalizeValue(value) {
  return String(value ?? '').replace(/\0/g, '').replace(/[ \t]+/g, ' ').trim();
}

function normalizeScalar(value, maximum = MAX_FIELD_CHARS) {
  const normalized = normalizeValue(value).replace(/\n{3,}/g, '\n\n');
  return normalized ? normalized.slice(0, maximum) : null;
}

function normalizeFilename(value) {
  return path.basename(String(value || '')).normalize('NFKC').toLocaleLowerCase('en-US');
}

function normalizeKey(value) {
  return normalizeValue(value).normalize('NFKC').toLocaleLowerCase('en-US');
}

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function truncateText(value, maximum) {
  const normalized = normalizeScalar(value, maximum);
  return normalized || null;
}

function decodeHtmlEntities(value) {
  const named = new Map([
    ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
    ['nbsp', ' '], ['ensp', ' '], ['emsp', ' '], ['ndash', '–'], ['mdash', '—'],
    ['hellip', '…'], ['laquo', '«'], ['raquo', '»'], ['middot', '·'],
  ]);
  return String(value || '').replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);?/gi,
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

function stripUnsafeHtml(rawHtml) {
  let html = String(rawHtml || '').replace(/\0/g, '');
  html = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|noscript|template|svg|nav|header|footer|form)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|pre|div|section|article|li|tr|h[1-6]|dt|dd|blockquote)\s*>/gi, '\n')
    .replace(/<(p|pre|div|section|article|li|tr|h[1-6]|dt|dd|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>?/g, ' ');
  return decodeHtmlEntities(html)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CONTEXT_TEXT_CHARS);
}

function elementTexts(rawHtml, tagPattern) {
  const values = [];
  const pattern = new RegExp(`<(${tagPattern})\\b[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, 'gi');
  for (const match of String(rawHtml || '').matchAll(pattern)) {
    const value = normalizeScalar(stripUnsafeHtml(match[2]), MAX_FIELD_CHARS);
    if (value) values.push(value);
  }
  return values;
}

function metaValue(rawHtml, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const tag of String(rawHtml || '').match(/<meta\b[^>]*>/gi) || []) {
    const attributes = Object.fromEntries([...tag.matchAll(
      /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
    )].map((match) => [match[1].toLowerCase(), decodeHtmlEntities(match[2] ?? match[3] ?? match[4])]));
    const key = String(attributes.name || attributes.property || '').toLowerCase();
    if (wanted.has(key)) return normalizeScalar(attributes.content);
  }
  return null;
}

function labeledValue(lines, labels) {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`^(?:${escaped})\\s*[：:]\\s*(.+)$`, 'i');
  for (const line of lines) {
    const match = line.match(pattern);
    if (match?.[1]) return normalizeScalar(match[1]);
  }
  return null;
}

function extractLinks(rawHtml) {
  const links = [];
  for (const match of String(rawHtml || '').matchAll(
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
  )) {
    const href = decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '').trim();
    const label = normalizeScalar(stripUnsafeHtml(match[4]), 500);
    if (href) links.push({ href, label });
  }
  return links;
}

function safeUrl(value) {
  const normalized = normalizeScalar(value, 2_000);
  if (!normalized || !/^https?:\/\//i.test(normalized)) return null;
  return normalized;
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
    if (result.length === MAX_TAGS) break;
  }
  return result;
}

function parseHtmlFields(rawHtml, role) {
  const text = stripUnsafeHtml(rawHtml);
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const headings = elementTexts(rawHtml, 'h1|h2|h3');
  const titleElement = elementTexts(rawHtml, 'title')[0] || null;
  const links = extractLinks(rawHtml);
  const sourceLink = links.find((link) => /原(?:始|帖|文).*(?:地址|链接)|来源|source|original/i.test(
    link.label || '',
  )) || links.find((link) => /^https?:\/\//i.test(link.href));
  const production = hotingestAdapter.extractHotIngestHtmlFields(rawHtml);
  const title = labeledValue(lines, ['标题', '原文标题', 'Title'])
    || production.title
    || metaValue(rawHtml, ['og:title', 'twitter:title'])
    || headings[0]
    || titleElement;
  const body = labeledValue(lines, ['正文', '原文', '说明', '内容', '描述', 'Body', 'Description'])
    || production.body;
  const translation = labeledValue(lines, [
    '中文翻译', '中文译文', '翻译', '译文', 'Translated Title', 'Translated Body', '中文对照',
  ]) || production.translation;
  const tags = parseTags(labeledValue(lines, ['标签', 'Tags']));
  const fields = {
    title,
    body,
    translation,
    platform: labeledValue(lines, ['来源平台', '平台', 'Platform', 'Source']) || production.platform,
    sourceUrl: safeUrl(
      labeledValue(lines, ['原始链接', '原文链接', '原帖地址', '来源 URL', 'Source URL'])
      || sourceLink?.href
      || production.sourceUrl,
    ),
    author: labeledValue(lines, ['作者', '账号', '频道', 'Author', 'Channel']) || production.author,
    publishedAt: labeledValue(lines, ['发布时间', '发布日期', 'Published At', 'Published'])
      || production.publishedAt,
    explanationCandidates: production.explanationCandidates || [],
    tags: tags.length ? tags : null,
    comments: labeledValue(lines, ['评论', '热门评论', 'Comments']),
    indexSupplement: role === 'folder-index' ? text : null,
  };
  if (!fields.body && role !== 'folder-index') {
    const candidates = elementTexts(rawHtml, 'pre|blockquote|p')
      .filter((value) => value !== fields.title && !/^https?:\/\//i.test(value));
    fields.body = normalizeScalar(candidates.join('\n\n'));
  }
  return { fields, text, links };
}

function htmlIntegrityWarning(rawHtml) {
  const html = String(rawHtml || '');
  for (const tag of ['script', 'style']) {
    const openings = (html.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length;
    const closings = (html.match(new RegExp(`</${tag}\\s*>`, 'gi')) || []).length;
    if (openings !== closings) return `${tag} 标签不完整，已按损坏 HTML 容错并忽略其余内容。`;
  }
  return null;
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

function commentsText(value) {
  if (!Array.isArray(value)) return normalizeScalar(value);
  return normalizeScalar(value.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return '';
    const author = pickFirst(entry, ['author', 'account', 'user']);
    const body = pickFirst(entry, ['body', 'text', 'content']);
    return author && body ? `${author}：${body}` : body || author || '';
  }).filter(Boolean).join('\n'));
}

function translationText(object) {
  const direct = [
    pickFirst(object, ['translated_title', 'title_zh', 'title_zh_cn']),
    pickFirst(object, ['translated_body', 'translated_description', 'body_zh', 'description_zh']),
    pickFirst(object, ['translation', 'translated_text']),
  ].filter(Boolean);
  if (direct.length) return normalizeScalar([...new Set(direct)].join('\n\n'));
  const translations = object?.translations;
  if (!translations || typeof translations !== 'object' || Array.isArray(translations)) return null;
  return normalizeScalar(Object.values(translations).flatMap((value) => {
    if (typeof value === 'string') return [value];
    if (value && typeof value === 'object') {
      return [value.translated_text, value.text, value.translation].filter((entry) => typeof entry === 'string');
    }
    return [];
  }).join('\n\n'));
}

function parseMetadataFields(value) {
  const parsed = hotingestAdapter.parseMetadataFields(value);
  return {
    ...parsed,
    sourceUrl: safeUrl(parsed.sourceUrl),
    translation: parsed.translation || translationText(value && typeof value === 'object' ? value : {}),
  };
}

function classifyHotIngestFile(relativePath) {
  const normalized = String(relativePath || '').split(path.sep).join('/');
  const basename = path.posix.basename(normalized);
  const lower = basename.toLocaleLowerCase('en-US');
  if (lower === '_素材索引.html' || lower === '_素材索引.htm') {
    return { role: 'folder-index', type: 'folder-index-html' };
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
  if (/(?:^|\/)\.hotingest\/manifest\.json$/i.test(normalized)) {
    return { role: 'package-manifest', type: 'package-manifest' };
  }
  return null;
}

function selectedNumber(filename) {
  return normalizeFilename(filename).match(/^(\d+)(?=[_.\-\s]|$)/)?.[1] || null;
}

function visualStem(filename) {
  return path.basename(filename, path.extname(filename));
}

function sidecarStem(filename) {
  return path.basename(filename).replace(/\.(?:context|text)\.html?$/i, '');
}

function isVisualReference(value) {
  return VISUAL_EXTENSIONS.has(path.extname(String(value || '')).toLowerCase());
}

function htmlReferences(rawHtml) {
  const references = [];
  const pattern = /\b(?:href|src|data-file|data-filename)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of String(rawHtml || '').matchAll(pattern)) {
    const value = decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '').split(/[?#]/)[0];
    if (!value || /^(?:https?:|data:|javascript:)/i.test(value)) continue;
    try {
      references.push(decodeURIComponent(value));
    } catch {
      references.push(value);
    }
  }
  return [...new Set(references)];
}

function parseIndexEntries(rawHtml) {
  const entries = [];
  const blockPattern = /<(article|tr|li|section)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of String(rawHtml || '').matchAll(blockPattern)) {
    const references = htmlReferences(match[0]);
    const visualFiles = references.filter(isVisualReference).map((value) => path.basename(value));
    const sidecarFiles = references
      .filter((value) => /\.(?:context|text)\.html?$/i.test(value))
      .map((value) => path.basename(value));
    if (!visualFiles.length) continue;
    entries.push({
      visualFiles,
      sidecarFiles,
      fields: parseHtmlFields(match[0], 'folder-index').fields,
    });
  }
  if (entries.length) return entries;
  const references = htmlReferences(rawHtml);
  const visualFiles = references.filter(isVisualReference).map((value) => path.basename(value));
  const sidecarFiles = references
    .filter((value) => /\.(?:context|text)\.html?$/i.test(value))
    .map((value) => path.basename(value));
  return visualFiles.map((filename) => ({
    visualFiles: [filename],
    sidecarFiles: sidecarFiles.filter((sidecar) => {
      const target = normalizeFilename(sidecarStem(sidecar));
      const stem = normalizeFilename(visualStem(filename));
      return target === stem || selectedNumber(target) === selectedNumber(stem);
    }),
    fields: {},
  }));
}

async function readContextFile(file) {
  const stat = await fs.stat(file.absolutePath);
  if (stat.size > MAX_CONTEXT_FILE_BYTES) {
    return {
      raw: '',
      warning: `${file.relativePath} 超过 ${MAX_CONTEXT_FILE_BYTES} 字节，未解析。`,
    };
  }
  try {
    return { raw: await fs.readFile(file.absolutePath, 'utf8'), warning: null };
  } catch (error) {
    return { raw: '', warning: `${file.relativePath} 无法读取：${error.message}` };
  }
}

function relativeDirectory(relativePath) {
  const directory = path.dirname(relativePath);
  return directory === '.' ? '.' : directory;
}

function metadataRoot(relativePath) {
  const normalized = String(relativePath).split(path.sep).join('/');
  return normalized.replace(/\/?\.hotingest\/items\/[^/]+$/i, '') || '.';
}

function sameDirectory(left, right) {
  return relativeDirectory(left) === relativeDirectory(right);
}

function exactVisualMatches(file, items) {
  const target = normalizeFilename(
    classifyHotIngestFile(file.relativePath)?.type === 'metadata-json'
      ? path.basename(file.relativePath, path.extname(file.relativePath))
      : sidecarStem(file.relativePath),
  );
  return items.filter((item) => sameDirectory(file.relativePath, item.relativePath)
    && normalizeFilename(visualStem(item.filename)) === target);
}

function numberedVisualMatches(file, items) {
  const number = selectedNumber(path.basename(file.relativePath));
  if (!number) return [];
  const directory = classifyHotIngestFile(file.relativePath)?.type === 'metadata-json'
    ? metadataRoot(file.relativePath)
    : relativeDirectory(file.relativePath);
  const matches = items.filter((item) => relativeDirectory(item.relativePath) === directory
    && selectedNumber(item.filename) === number);
  if (matches.length <= 1) return matches;
  const target = normalizeFilename(
    classifyHotIngestFile(file.relativePath)?.type === 'metadata-json'
      ? path.basename(file.relativePath, path.extname(file.relativePath))
      : sidecarStem(file.relativePath),
  );
  return matches.filter((item) => {
    const stem = normalizeFilename(visualStem(item.filename));
    return stem === target || stem.startsWith(`${target}_`) || stem.startsWith(`${target}-`);
  });
}

function distinctFiles(files) {
  const byPath = new Map();
  for (const file of files) byPath.set(file.relativePath, file);
  return [...byPath.values()].sort((left, right) => naturalCompare(left.relativePath, right.relativePath));
}

function mergeRecord(target, record, warnings) {
  const priority = FIELD_PRIORITIES[record.type] || 0;
  target.files = distinctFiles([...target.files, {
    relativePath: record.relativePath,
    type: record.type,
    role: record.role,
  }]);
  if (record.groupKey) {
    target.explicitGroupKeys = [...new Set([...target.explicitGroupKeys, record.groupKey])];
  }
  for (const field of FIELD_KEYS) {
    const incoming = record.fields[field];
    if (incoming == null || incoming === '' || (Array.isArray(incoming) && !incoming.length)) continue;
    if (field === 'tags') {
      target.tags = parseTags([...(target.tags || []), ...incoming]);
      target.fieldSources.tags = [...new Set([
        ...(Array.isArray(target.fieldSources.tags) ? target.fieldSources.tags : []),
        record.relativePath,
      ])];
      continue;
    }
    const normalized = normalizeScalar(incoming);
    if (!normalized) continue;
    const currentSource = target.fieldSources[field];
    const currentPriority = currentSource ? target.fieldPriorities[field] : -1;
    if (!target[field] || priority > currentPriority) {
      if (target[field] && normalizeValue(target[field]) !== normalizeValue(normalized)) {
        warnings.push(
          `${field} 冲突：保留 ${record.relativePath}，未采用 ${currentSource} 的不同值。`,
        );
      }
      target[field] = normalized;
      target.fieldSources[field] = record.relativePath;
      target.fieldPriorities[field] = priority;
    } else if (normalizeValue(target[field]) !== normalizeValue(normalized)) {
      warnings.push(
        `${field} 冲突：保留 ${currentSource}，未采用 ${record.relativePath} 的不同值。`,
      );
    }
  }
  if (Array.isArray(record.fields.translationEntries) && record.fields.translationEntries.length) {
    target.translationEntries = record.fields.translationEntries;
  }
  if (Array.isArray(record.fields.explanationCandidates) && record.fields.explanationCandidates.length) {
    target.explanationCandidates = [...new Set([
      ...(target.explanationCandidates || []),
      ...record.fields.explanationCandidates,
    ])];
  }
  if (typeof record.fields.hasAudio === 'boolean') target.hasAudio = record.fields.hasAudio;
  if (typeof record.fields.sourceHasAudio === 'boolean') target.sourceHasAudio = record.fields.sourceHasAudio;
  if (Array.isArray(record.fields.schemaDrift) && record.fields.schemaDrift.length) {
    target.schemaDrift = [...(target.schemaDrift || []), ...record.fields.schemaDrift];
    warnings.push(...record.fields.schemaDrift.map((item) => item.message || String(item)));
  }
  if (record.fields.rawOriginalItem && typeof record.fields.rawOriginalItem === 'object') {
    target.rawOriginalItem = record.fields.rawOriginalItem;
  }
}

function createAssetContext() {
  return {
    files: [],
    title: null,
    body: null,
    translation: null,
    platform: null,
    sourceUrl: null,
    author: null,
    publishedAt: null,
    tags: [],
    comments: null,
    indexSupplement: null,
    sourceItemKey: null,
    language: null,
    translationEntries: [],
    explanationCandidates: [],
    hasAudio: null,
    sourceHasAudio: null,
    schemaDrift: [],
    rawOriginalItem: null,
    fieldSources: {},
    fieldPriorities: {},
    explicitGroupKeys: [],
    warnings: [],
    analysisReady: false,
  };
}

function publicAssetContext(context) {
  const result = { ...context };
  delete result.fieldPriorities;
  result.analysisReady = result.files.length > 0 && FIELD_KEYS.some((field) => (
    Array.isArray(result[field]) ? result[field].length > 0 : Boolean(result[field])
  ));
  return result;
}

function reliableGrouping(item) {
  const context = item.context || {};
  const platform = normalizeKey(context.platform);
  const sourceItem = normalizeKey(context.sourceItemKey);
  if (sourceItem) {
    return {
      key: `source-item:${platform || 'unknown'}:${sourceItem}`,
      basis: 'stable-source-item',
      confidence: platform ? 0.98 : 0.9,
    };
  }
  if (context.sourceUrl) {
    return {
      key: `source-url:${normalizeValue(context.sourceUrl).normalize('NFKC')}`,
      basis: 'exact-source-url',
      confidence: 0.96,
    };
  }
  const number = selectedNumber(item.filename);
  if (number && platform) {
    return {
      key: `hotingest-number:${normalizeKey(relativeDirectory(item.relativePath))}:${platform}:${number}`,
      basis: 'exact-item-number-and-platform',
      confidence: 0.9,
    };
  }
  if (context.explicitGroupKeys?.length) {
    return {
      key: `index-entry:${normalizeKey(context.explicitGroupKeys[0])}`,
      basis: 'explicit-folder-index',
      confidence: 0.86,
    };
  }
  const title = normalizeKey(context.title);
  const publishedAt = normalizeKey(context.publishedAt);
  if (title && publishedAt) {
    return {
      key: `title-time:${normalizeKey(relativeDirectory(item.relativePath))}:`
        + `${platform || 'unknown'}:${title}:${publishedAt}`,
      basis: 'exact-normalized-title-and-time',
      confidence: 0.72,
    };
  }
  return {
    key: `asset:${item.assetId}`,
    basis: 'independent-asset-fallback',
    confidence: context.files?.length ? 0.55 : 1,
  };
}

function contextEvidence(context) {
  const evidence = [];
  for (const field of [
    'title', 'body', 'translation', 'platform', 'sourceUrl', 'author', 'publishedAt',
    'tags', 'comments', 'sourceItemKey', 'language',
  ]) {
    const value = context?.[field];
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue;
    const sources = Array.isArray(context.fieldSources?.[field])
      ? context.fieldSources[field]
      : [context.fieldSources?.[field]].filter(Boolean);
    evidence.push({ field, sourceFiles: sources });
  }
  return evidence;
}

function semanticProfileForItem(item, grouping) {
  const context = item.context || {};
  const contextSourceFiles = (context.files || []).map((file) => file.relativePath);
  return {
    schemaVersion: 1,
    assetId: item.assetId,
    contextSummary: truncateText(
      [context.translation, context.title, context.body].filter(Boolean).join('\n'),
      1_000,
    ),
    normalizedTitle: truncateText(normalizeKey(context.title), 300),
    sourcePlatform: truncateText(context.platform, 100),
    sourceUrl: truncateText(context.sourceUrl, 2_000),
    author: truncateText(context.author, 300),
    publishedAt: truncateText(context.publishedAt, 100),
    translatedSummary: truncateText(context.translation, 800),
    tags: (context.tags || []).slice(0, 20),
    language: truncateText(context.language, 50),
    eventKey: grouping.basis === 'independent-asset-fallback' ? null : grouping.key,
    sourceItemKey: truncateText(context.sourceItemKey, 300),
    contextSourceFiles,
    contextEvidence: contextEvidence(context),
    conflicts: (context.warnings || []).filter((warning) => /冲突/.test(warning)).slice(0, 10),
    warnings: (context.warnings || []).slice(0, 10),
    confidence: grouping.confidence,
  };
}

function representativeOrder(left, right) {
  const leftUnsupported = String(left.extension || '').toLowerCase() === 'webm' ? 1 : 0;
  const rightUnsupported = String(right.extension || '').toLowerCase() === 'webm' ? 1 : 0;
  if (leftUnsupported !== rightUnsupported) return leftUnsupported - rightUnsupported;
  if (left.type !== right.type) return left.type === 'video' ? -1 : 1;
  return naturalCompare(left.relativePath, right.relativePath);
}

function buildStoryUnits(items) {
  const groups = new Map();
  const enrichedItems = items.map((item) => {
    const grouping = reliableGrouping(item);
    const storyUnitId = `story_${shortHash(grouping.key)}`;
    const semanticProfile = semanticProfileForItem(item, grouping);
    const group = groups.get(grouping.key) || {
      grouping,
      storyUnitId,
      items: [],
    };
    group.items.push({ ...item, storyUnitId, semanticProfile });
    groups.set(grouping.key, group);
    return { ...item, storyUnitId, semanticProfile };
  });
  const storyUnits = [...groups.values()].map(({ grouping, storyUnitId, items: groupedItems }) => {
    const ordered = [...groupedItems].sort(representativeOrder);
    const representative = ordered[0];
    const profiles = ordered.map((item) => item.semanticProfile);
    const sourcePlatforms = [...new Set(profiles.map((profile) => profile.sourcePlatform).filter(Boolean))];
    const sourceUrls = [...new Set(profiles.map((profile) => profile.sourceUrl).filter(Boolean))];
    const publishedValues = [...new Set(profiles.map((profile) => profile.publishedAt).filter(Boolean))];
    const chapterIds = [...new Set(ordered.map((item) => item.chapterId).filter(Boolean))];
    const warnings = [...new Set(profiles.flatMap((profile) => profile.warnings || []))];
    if (chapterIds.length > 1) {
      warnings.push('同一 Story Unit 的视觉素材位于不同顶层章节，章节归属必须服从项目结构。');
    }
    if (sourcePlatforms.length > 1) {
      warnings.push('同一 Story Unit 存在多个来源平台，需人工复核归组。');
    }
    return {
      storyUnitId,
      topic: profiles.find((profile) => profile.translatedSummary)?.translatedSummary
        || profiles.find((profile) => profile.normalizedTitle)?.normalizedTitle
        || null,
      eventKey: grouping.basis === 'independent-asset-fallback' ? null : grouping.key,
      sourceItemKey: profiles.find((profile) => profile.sourceItemKey)?.sourceItemKey || null,
      assetIds: ordered.map((item) => item.assetId),
      representativeAssetIds: representative ? [representative.assetId] : [],
      supportingAssetIds: ordered.slice(1).map((item) => item.assetId),
      sourcePlatform: sourcePlatforms.length === 1 ? sourcePlatforms[0] : null,
      sourceUrl: sourceUrls.length === 1 ? sourceUrls[0] : null,
      reliablePublishedAt: publishedValues.length === 1
        && Number.isFinite(Date.parse(publishedValues[0]))
        ? publishedValues[0]
        : null,
      chapterIds,
      narrativeRoleCandidates: ['context', 'evidence', 'supporting'],
      evidence: {
        groupingBasis: grouping.basis,
        contextSourceFiles: [...new Set(profiles.flatMap(
          (profile) => profile.contextSourceFiles || [],
        ))],
      },
      warnings,
      duplicateOrVariantGroups: ordered.length > 1 ? [{
        assetIds: ordered.map((item) => item.assetId),
        classification: 'candidate-variants',
      }] : [],
      confidence: grouping.confidence,
    };
  });
  return { items: enrichedItems, storyUnits };
}

function analysisContextView(context) {
  if (!context?.files?.length) return null;
  return {
    files: context.files,
    title: truncateText(context.title, 300),
    translation: truncateText(context.translation, 700),
    body: truncateText(context.body, 1_500),
    platform: truncateText(context.platform, 100),
    sourceUrl: truncateText(context.sourceUrl, 1_000),
    author: truncateText(context.author, 200),
    publishedAt: truncateText(context.publishedAt, 100),
    tags: (context.tags || []).slice(0, 12),
    comments: truncateText(context.comments, 400),
    sourceItemKey: truncateText(context.sourceItemKey, 200),
    language: truncateText(context.language, 50),
    explanationCandidates: (context.explanationCandidates || []).slice(0, 8),
    hasAudio: context.hasAudio,
    sourceHasAudio: context.sourceHasAudio,
    fieldSources: context.fieldSources,
    warnings: (context.warnings || []).slice(0, 5).map((warning) => truncateText(warning, 300)),
  };
}

function analysisSemanticProfileView(profile) {
  if (!profile) return null;
  return {
    ...profile,
    contextSummary: truncateText(profile.contextSummary, 600),
    translatedSummary: truncateText(profile.translatedSummary, 500),
    tags: (profile.tags || []).slice(0, 12),
    contextEvidence: (profile.contextEvidence || []).slice(0, 10),
    conflicts: (profile.conflicts || []).slice(0, 5),
    warnings: (profile.warnings || []).slice(0, 5),
  };
}

function buildAnalysisContextPayload(items) {
  let usedChars = 0;
  let truncatedAssetCount = 0;
  let omittedAssetCount = 0;
  const contexts = new Map();
  const semanticProfiles = new Map();
  for (const item of items) {
    let view = analysisContextView(item.context);
    let profile = analysisSemanticProfileView(item.semanticProfile);
    if (!view && !profile) {
      contexts.set(item.assetId, null);
      semanticProfiles.set(item.assetId, null);
      continue;
    }
    let serialized = JSON.stringify({ context: view, semanticProfile: profile });
    if (serialized.length > MAX_ANALYSIS_CONTEXT_CHARS_PER_ASSET) {
      view = view ? { ...view, body: truncateText(view.body, 500), comments: null } : null;
      profile = profile ? {
        ...profile,
        contextSummary: truncateText(profile.contextSummary, 300),
        translatedSummary: truncateText(profile.translatedSummary, 300),
        contextEvidence: (profile.contextEvidence || []).slice(0, 5),
      } : null;
      serialized = JSON.stringify({ context: view, semanticProfile: profile });
      truncatedAssetCount += 1;
    }
    if (serialized.length > MAX_ANALYSIS_CONTEXT_CHARS_PER_ASSET) {
      view = view ? {
        files: view.files,
        title: view.title,
        platform: view.platform,
        sourceUrl: view.sourceUrl,
        sourceItemKey: view.sourceItemKey,
        omittedLowPriorityTextDueToBudget: true,
      } : null;
      profile = profile ? {
        assetId: profile.assetId,
        eventKey: profile.eventKey,
        sourceItemKey: profile.sourceItemKey,
        contextSourceFiles: profile.contextSourceFiles,
        omittedLowPriorityTextDueToBudget: true,
      } : null;
      serialized = JSON.stringify({ context: view, semanticProfile: profile });
    }
    if (serialized.length > MAX_ANALYSIS_CONTEXT_CHARS_PER_ASSET) {
      view = null;
      profile = profile ? {
        assetId: profile.assetId,
        eventKey: profile.eventKey,
        omittedLowPriorityTextDueToBudget: true,
      } : null;
      serialized = JSON.stringify({ context: view, semanticProfile: profile });
    }
    if (usedChars + serialized.length > MAX_ANALYSIS_CONTEXT_TOTAL_CHARS) {
      view = view ? {
        files: view.files,
        title: view.title,
        platform: view.platform,
        sourceUrl: view.sourceUrl,
        sourceItemKey: view.sourceItemKey,
        omittedLowPriorityTextDueToBudget: true,
      } : null;
      profile = profile ? {
        schemaVersion: profile.schemaVersion,
        assetId: profile.assetId,
        eventKey: profile.eventKey,
        sourceItemKey: profile.sourceItemKey,
        sourcePlatform: profile.sourcePlatform,
        sourceUrl: profile.sourceUrl,
        contextSourceFiles: profile.contextSourceFiles,
        omittedLowPriorityTextDueToBudget: true,
      } : null;
      serialized = JSON.stringify({ context: view, semanticProfile: profile });
      truncatedAssetCount += 1;
    }
    if (usedChars + serialized.length > MAX_ANALYSIS_CONTEXT_TOTAL_CHARS) {
      view = null;
      profile = profile ? {
        assetId: profile.assetId,
        eventKey: profile.eventKey,
        omittedLowPriorityTextDueToBudget: true,
      } : null;
      serialized = JSON.stringify({ context: view, semanticProfile: profile });
    }
    if (usedChars + serialized.length > MAX_ANALYSIS_CONTEXT_TOTAL_CHARS) {
      view = null;
      profile = null;
      serialized = '';
      omittedAssetCount += 1;
    }
    usedChars += serialized.length;
    contexts.set(item.assetId, view);
    semanticProfiles.set(item.assetId, profile);
  }
  return {
    contexts,
    semanticProfiles,
    budget: {
      maxCharsPerAsset: MAX_ANALYSIS_CONTEXT_CHARS_PER_ASSET,
      maxTotalChars: MAX_ANALYSIS_CONTEXT_TOTAL_CHARS,
      usedChars,
      maximumAssetChars: Math.max(0, ...items.map((item) => JSON.stringify({
        context: contexts.get(item.assetId),
        semanticProfile: semanticProfiles.get(item.assetId),
      }).length)),
      truncatedAssetCount,
      omittedAssetCount,
    },
  };
}

async function ingestHotIngestContexts(sourceDirectory, files, items) {
  const recognized = files
    .map((file) => ({ ...file, classification: classifyHotIngestFile(file.relativePath) }))
    .filter((file) => file.classification);
  const sidecars = recognized.filter((file) => file.classification.role === 'asset-sidecar');
  const indexes = recognized.filter((file) => file.classification.role === 'folder-index');
  const contexts = new Map(items.map((item) => [item.assetId, createAssetContext()]));
  const warnings = [];
  const parseWarnings = [];
  const parsedByPath = new Map();
  const indexBindings = new Map();
  const referencedSidecars = new Map();

  for (const indexFile of indexes) {
    const read = await readContextFile(indexFile);
    if (read.warning) {
      warnings.push(read.warning);
      parseWarnings.push(read.warning);
      continue;
    }
    const integrityWarning = htmlIntegrityWarning(read.raw);
    if (integrityWarning) {
      const warning = `${indexFile.relativePath}：${integrityWarning}`;
      warnings.push(warning);
      parseWarnings.push(warning);
    }
    const entries = parseIndexEntries(read.raw);
    const directory = relativeDirectory(indexFile.relativePath);
    for (const [entryIndex, entry] of entries.entries()) {
      const matchedItems = [];
      for (const filename of entry.visualFiles) {
        const matches = items.filter((item) => relativeDirectory(item.relativePath) === directory
          && normalizeFilename(item.filename) === normalizeFilename(filename));
        if (!matches.length) {
          warnings.push(`${indexFile.relativePath} 指向不存在的视觉文件：${filename}`);
        }
        matchedItems.push(...matches);
      }
      for (const item of matchedItems) {
        const bindings = indexBindings.get(item.assetId) || [];
        bindings.push({
          relativePath: indexFile.relativePath,
          role: 'folder-index',
          type: 'folder-index',
          fields: {
            ...entry.fields,
            indexSupplement: entry.fields.indexSupplement || null,
          },
          groupKey: `${indexFile.relativePath}#${entryIndex + 1}`,
        });
        indexBindings.set(item.assetId, bindings);
      }
      for (const sidecar of entry.sidecarFiles) {
        const key = `${directory}\0${normalizeFilename(sidecar)}`;
        const ids = referencedSidecars.get(key) || new Set();
        matchedItems.forEach((item) => ids.add(item.assetId));
        referencedSidecars.set(key, ids);
      }
    }
  }

  const orphanContexts = [];
  for (const file of sidecars) {
    const read = await readContextFile(file);
    if (read.warning) {
      warnings.push(read.warning);
      parseWarnings.push(read.warning);
    }
    let fields = {};
    if (read.raw) {
      if (file.classification.type === 'metadata-json') {
        try {
          fields = parseMetadataFields(JSON.parse(read.raw));
        } catch (error) {
          const warning = `${file.relativePath} JSON 损坏，已跳过结构化字段：${error.message}`;
          warnings.push(warning);
          parseWarnings.push(warning);
        }
      } else {
        const integrityWarning = htmlIntegrityWarning(read.raw);
        if (integrityWarning) {
          const warning = `${file.relativePath}：${integrityWarning}`;
          warnings.push(warning);
          parseWarnings.push(warning);
        }
        fields = parseHtmlFields(read.raw, file.classification.type).fields;
      }
    } else {
      const warning = `${file.relativePath} 为空，未提取到上下文。`;
      warnings.push(warning);
      parseWarnings.push(warning);
    }
    parsedByPath.set(file.relativePath, fields);

    const explicitKey = `${relativeDirectory(file.relativePath)}\0${normalizeFilename(path.basename(file.relativePath))}`;
    const indexedIds = referencedSidecars.get(explicitKey);
    let matchedItems = indexedIds
      ? items.filter((item) => indexedIds.has(item.assetId))
      : exactVisualMatches(file, items);
    if (!matchedItems.length) matchedItems = numberedVisualMatches(file, items);
    if (!matchedItems.length) {
      orphanContexts.push({
        relativePath: file.relativePath,
        type: file.classification.type,
        reason: '没有唯一、精确或索引明确的视觉素材匹配。',
      });
      warnings.push(`孤立上下文：${file.relativePath} 未绑定视觉素材。`);
      continue;
    }
    for (const item of matchedItems) {
      mergeRecord(contexts.get(item.assetId), {
        relativePath: file.relativePath,
        role: 'asset-sidecar',
        type: file.classification.type,
        fields,
      }, contexts.get(item.assetId).warnings);
    }
  }

  for (const item of items) {
    for (const binding of indexBindings.get(item.assetId) || []) {
      mergeRecord(contexts.get(item.assetId), binding, contexts.get(item.assetId).warnings);
    }
    warnings.push(...contexts.get(item.assetId).warnings.map(
      (warning) => `${item.relativePath}：${warning}`,
    ));
  }

  let enrichedItems = items.map((item) => {
    const context = publicAssetContext(contexts.get(item.assetId));
    return context.files.length ? { ...item, context } : item;
  });
  const storyResult = recognized.length
    ? buildStoryUnits(enrichedItems)
    : { items: enrichedItems, storyUnits: [] };
  enrichedItems = storyResult.items;
  const assetsWithContext = enrichedItems.filter((item) => item.context?.files.length).length;
  const inventory = await hotingestAdapter.buildCanonicalInventory(sourceDirectory, files);
  if (inventory.warnings?.length) warnings.push(...inventory.warnings.filter((item) => !warnings.includes(item)));
  return {
    items: enrichedItems,
    storyUnits: storyResult.storyUnits,
    inventory,
    contextIngestion: {
      schemaVersion: 2,
      detected: recognized.length > 0 || inventory.detected,
      assetsWithContext,
      contextFileCount: recognized.length,
      assetSidecarCount: sidecars.length,
      folderIndexCount: indexes.length,
      hiddenMetadataCount: sidecars.filter(
        (file) => file.classification.type === 'metadata-json',
      ).length,
      orphanContextCount: orphanContexts.length,
      storyUnitCount: storyResult.storyUnits.length,
      multiAssetStoryUnitCount: storyResult.storyUnits.filter(
        (unit) => unit.assetIds.length > 1,
      ).length,
      warningCount: warnings.length,
      parseWarningCount: parseWarnings.length,
      schemaDrift: inventory.schemaDrift || [],
      orphanContexts,
      warnings,
      limits: {
        maxFileBytes: MAX_CONTEXT_FILE_BYTES,
        maxExtractedTextChars: MAX_CONTEXT_TEXT_CHARS,
        maxFieldChars: MAX_FIELD_CHARS,
      },
      mergePriority: ['metadata-json', 'context-html', 'text-html', 'folder-index'],
    },
  };
}

module.exports = {
  MAX_ANALYSIS_CONTEXT_CHARS_PER_ASSET,
  MAX_ANALYSIS_CONTEXT_TOTAL_CHARS,
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_TEXT_CHARS,
  buildAnalysisContextPayload,
  buildStoryUnits,
  classifyHotIngestFile,
  decodeHtmlEntities,
  ingestHotIngestContexts,
  parseHtmlFields,
  parseIndexEntries,
  parseMetadataFields,
  stripUnsafeHtml,
  hotingestAdapter,
};
