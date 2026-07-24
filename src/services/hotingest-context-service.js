const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_CONTEXT_FILE_BYTES = 256 * 1024;
const MAX_CONTEXT_TEXT_CHARS = 16_000;
const MAX_FIELD_CHARS = 8_000;
const MAX_TAGS = 50;
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
  const title = labeledValue(lines, ['标题', '原文标题', 'Title'])
    || metaValue(rawHtml, ['og:title', 'twitter:title'])
    || headings[0]
    || titleElement;
  const body = labeledValue(lines, ['正文', '原文', '说明', '内容', '描述', 'Body', 'Description']);
  const translation = labeledValue(lines, [
    '中文翻译', '中文译文', '翻译', '译文', 'Translated Title', 'Translated Body',
  ]);
  const tags = parseTags(labeledValue(lines, ['标签', 'Tags']));
  const fields = {
    title,
    body,
    translation,
    platform: labeledValue(lines, ['来源平台', '平台', 'Platform', 'Source']),
    sourceUrl: safeUrl(
      labeledValue(lines, ['原始链接', '原文链接', '原帖地址', '来源 URL', 'Source URL'])
      || sourceLink?.href,
    ),
    author: labeledValue(lines, ['作者', '账号', '频道', 'Author', 'Channel']),
    publishedAt: labeledValue(lines, ['发布时间', '发布日期', 'Published At', 'Published']),
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
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const body = [
    pickFirst(object, ['body', 'content', 'text']),
    pickFirst(object, ['description', 'media_description', 'caption']),
  ].filter(Boolean);
  return {
    title: pickFirst(object, ['title', 'name']),
    body: normalizeScalar([...new Set(body)].join('\n\n')),
    translation: translationText(object),
    platform: pickFirst(object, ['source', 'platform', 'site']),
    sourceUrl: safeUrl(pickFirst(object, [
      'source_url', 'post_url', 'canonical_uri', 'external_source_url', 'original_url', 'url',
    ])),
    author: pickFirst(object, ['author', 'channel_title', 'account', 'creator']),
    publishedAt: pickFirst(object, ['published_at', 'created_at', 'published', 'date']),
    tags: parseTags(object.tags || object.hashtags || []),
    comments: commentsText(object.comments || object.top_comments),
    indexSupplement: null,
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
  const target = normalizeFilename(sidecarStem(file.relativePath));
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
  const target = normalizeFilename(sidecarStem(file.relativePath));
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
    fieldSources: {},
    fieldPriorities: {},
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
    for (const entry of entries) {
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

  const enrichedItems = items.map((item) => {
    const context = publicAssetContext(contexts.get(item.assetId));
    return context.files.length ? { ...item, context } : item;
  });
  const assetsWithContext = enrichedItems.filter((item) => item.context?.files.length).length;
  return {
    items: enrichedItems,
    contextIngestion: {
      schemaVersion: 1,
      detected: recognized.length > 0,
      assetsWithContext,
      contextFileCount: recognized.length,
      assetSidecarCount: sidecars.length,
      folderIndexCount: indexes.length,
      hiddenMetadataCount: sidecars.filter(
        (file) => file.classification.type === 'metadata-json',
      ).length,
      orphanContextCount: orphanContexts.length,
      warningCount: warnings.length,
      parseWarningCount: parseWarnings.length,
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
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_TEXT_CHARS,
  classifyHotIngestFile,
  decodeHtmlEntities,
  ingestHotIngestContexts,
  parseHtmlFields,
  parseIndexEntries,
  parseMetadataFields,
  stripUnsafeHtml,
};
