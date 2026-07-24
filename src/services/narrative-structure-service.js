const fs = require('node:fs/promises');
const path = require('node:path');
const { classifyHotIngestFile } = require('./hotingest-context-service');

const CONTEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.html', '.htm']);
const MAX_CONTEXT_BYTES = 128 * 1024;
const BRIEF_NAMES = new Set(['本期说明.md', '00-本期说明.md', 'brief.md', 'readme.md']);
const ORDER_KEYWORDS = [
  '准备', '开始', '搭建', '安装', '开发', '运行', '入口',
  '第一期', '首次', '第一次', '一期',
  '问题', '调整', '变化',
  '第二期', '再次', '第二次', '两期',
  '审核', '筛选', '成果', '结果', '输出', '工作流',
];

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function readContextFile(file) {
  const stat = await fs.stat(file.absolutePath);
  if (stat.size > MAX_CONTEXT_BYTES) {
    return {
      text: '',
      warning: `${file.relativePath} 超过 ${MAX_CONTEXT_BYTES} 字节，未纳入上下文。`,
    };
  }
  const raw = await fs.readFile(file.absolutePath, 'utf8');
  const extension = path.extname(file.relativePath).toLowerCase();
  return {
    text: extension === '.html' || extension === '.htm' ? stripHtml(raw) : raw.trim(),
    warning: null,
  };
}

function isBriefCandidate(relativePath) {
  if (path.dirname(relativePath) !== '.') return false;
  const filename = path.basename(relativePath);
  const lower = filename.toLowerCase();
  return BRIEF_NAMES.has(filename)
    || BRIEF_NAMES.has(lower)
    || (/本期说明/.test(filename) && lower.endsWith('.md'));
}

function briefPriority(relativePath) {
  const filename = path.basename(relativePath);
  const lower = filename.toLowerCase();
  if (filename === '00-本期说明.md') return 0;
  if (filename === '本期说明.md') return 1;
  if (/本期说明/.test(filename) && lower.endsWith('.md')) return 2;
  if (lower === 'brief.md') return 3;
  if (lower === 'readme.md') return 4;
  return 99;
}

function markdownSection(text, headingPattern) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,6}\s+/.test(line)
    && headingPattern.test(line.replace(/^#{1,6}\s+/, '').trim()));
  if (start < 0) return '';
  const section = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,6}\s+/.test(lines[index])) break;
    section.push(lines[index]);
  }
  return section.join('\n').trim();
}

function listItems(section) {
  return String(section || '').split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:[-*+]|\d+[.)、])\s*(.+?)\s*$/)?.[1])
    .filter(Boolean);
}

function parseDurationRequirement(text) {
  const range = String(text || '').match(/(\d{2,3})\s*(?:–|—|-|至|到)\s*(\d{2,3})\s*秒/);
  if (range) {
    return {
      minSec: Number(range[1]),
      maxSec: Number(range[2]),
      source: 'projectBrief',
    };
  }
  const minimum = String(text || '').match(/不得低于\s*(\d{2,3})\s*秒/);
  return minimum ? {
    minSec: Number(minimum[1]),
    maxSec: null,
    source: 'projectBrief',
  } : null;
}

function extractProjectBrief(relativePath, text) {
  if (!relativePath) return null;
  const narrativeOrder = listItems(markdownSection(text, /叙事顺序|故事顺序|章节顺序/));
  const relationships = [
    ...listItems(markdownSection(text, /素材对应关系|章节关系|部分素材/)),
  ];
  const requirements = listItems(markdownSection(text, /重要要求|特殊限制|要求/));
  const theme = normalizeText(markdownSection(text, /视频主题|本期主题|主题/));
  const hyperframesLines = String(text || '').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /HyperFrames/i.test(line));
  return {
    sourceDocuments: [relativePath],
    theme: theme || null,
    narrativeOrder,
    chapterRelationships: relationships,
    styleRequirements: requirements.filter((item) => /风格|口播|字幕|记录/.test(item)),
    durationRequirement: parseDurationRequirement(text),
    hyperframesRequirement: hyperframesLines.join('；') || null,
    specialConstraints: requirements,
    rawText: text,
  };
}

function meaningfulChapterKeywords(name) {
  return ORDER_KEYWORDS.filter((keyword) => String(name).includes(keyword));
}

function briefPosition(chapterName, briefText) {
  const normalizedBrief = normalizeText(briefText);
  const direct = normalizedBrief.indexOf(normalizeText(chapterName));
  if (direct >= 0) return direct;
  const positions = meaningfulChapterKeywords(chapterName)
    .map((keyword) => normalizedBrief.indexOf(keyword))
    .filter((value) => value >= 0);
  return positions.length ? Math.min(...positions) : Number.POSITIVE_INFINITY;
}

function detectChapterDirectories(files) {
  return [...new Set(files
    .map((file) => file.relativePath.split(path.sep))
    .filter((parts) => parts.length > 1)
    .map((parts) => parts[0]))]
    .sort(naturalCompare);
}

function orderChapterNames(names, projectBrief) {
  const naturallyOrdered = [...names].sort(naturalCompare);
  if (!projectBrief?.rawText || naturallyOrdered.length < 2) {
    return { names: naturallyOrdered, source: 'natural-directory-order' };
  }
  const scored = naturallyOrdered.map((name, naturalIndex) => ({
    name,
    naturalIndex,
    briefIndex: briefPosition(name, projectBrief.rawText),
  }));
  const matched = scored.filter((item) => Number.isFinite(item.briefIndex));
  if (matched.length < 2 || new Set(matched.map((item) => item.briefIndex)).size < 2) {
    return { names: naturallyOrdered, source: 'natural-directory-order' };
  }
  scored.sort((left, right) => {
    if (left.briefIndex !== right.briefIndex) return left.briefIndex - right.briefIndex;
    return left.naturalIndex - right.naturalIndex;
  });
  return { names: scored.map((item) => item.name), source: 'project-brief' };
}

function assignSubchapters(chapterName, files) {
  const names = [...new Set(files
    .map((file) => file.relativePath.split(path.sep))
    .filter((parts) => parts[0] === chapterName && parts.length > 2)
    .map((parts) => parts[1]))]
    .sort(naturalCompare);
  return names.map((name, index) => ({
    subchapterId: `subchapter-${index + 1}`,
    subchapterName: name,
    subchapterOrder: index + 1,
    relativePath: path.join(chapterName, name),
  }));
}

function computeDurationPolicy(chapters, mediaFacts = {}, projectBrief = null) {
  const explicit = projectBrief?.durationRequirement;
  if (explicit?.minSec && explicit?.maxSec) {
    return {
      minSec: explicit.minSec,
      maxSec: explicit.maxSec,
      source: 'project-brief',
      rationale: '根目录本期说明明确给出了成片时长范围。',
    };
  }
  const mediaCount = Number(mediaFacts.imageCount || 0) + Number(mediaFacts.videoCount || 0);
  const videoDuration = Number(mediaFacts.totalVideoDurationSec || 0);
  if (chapters.length > 1) {
    const processAndResult = chapters.some((chapter) => /搭建|开发|过程|准备/.test(chapter.chapterName))
      && chapters.some((chapter) => /成果|结果|成品|发布/.test(chapter.chapterName));
    if (processAndResult || mediaCount >= 12 || videoDuration >= 180) {
      return {
        minSec: 75,
        maxSec: 110,
        source: 'multi-chapter-policy',
        rationale: '项目同时包含过程与成果，且有效素材量足以支撑完整多章节叙事。',
      };
    }
    return {
      minSec: Math.max(60, explicit?.minSec || 0),
      maxSec: 90,
      source: explicit ? 'project-brief-minimum' : 'multi-chapter-policy',
      rationale: '多章节项目至少需要完整交代各章，不沿用单一演示的极短时长。',
    };
  }
  return {
    minSec: 15,
    maxSec: 60,
    source: 'single-chapter-policy',
    rationale: '单章节项目按有效素材与表达任务保持紧凑。',
  };
}

function chapterForRelativePath(chapters, relativePath) {
  const parts = relativePath.split(path.sep);
  const chapter = chapters.find((item) => item.relativePath === '.'
    || item.chapterName === parts[0]);
  if (!chapter) return { chapterId: null, subchapterId: null };
  const subchapter = chapter.subchapters.find((item) => item.subchapterName === parts[1]);
  return {
    chapterId: chapter.chapterId,
    subchapterId: subchapter?.subchapterId || null,
  };
}

function summarizeChapters(chapters, items) {
  return chapters.map((chapter) => {
    const chapterItems = items.filter((item) => item.chapterId === chapter.chapterId);
    return {
      ...chapter,
      imageCount: chapterItems.filter((item) => item.type === 'image').length,
      videoCount: chapterItems.filter((item) => item.type === 'video').length,
      totalVideoDurationSec: Number(chapterItems
        .filter((item) => item.type === 'video')
        .reduce((sum, item) => sum + Number(item.metadata?.durationSec || 0), 0)
        .toFixed(3)),
      subchapters: chapter.subchapters.map((subchapter) => {
        const nested = chapterItems.filter((item) => item.subchapterId === subchapter.subchapterId);
        return {
          ...subchapter,
          imageCount: nested.filter((item) => item.type === 'image').length,
          videoCount: nested.filter((item) => item.type === 'video').length,
          totalVideoDurationSec: Number(nested
            .filter((item) => item.type === 'video')
            .reduce((sum, item) => sum + Number(item.metadata?.durationSec || 0), 0)
            .toFixed(3)),
        };
      }),
    };
  });
}

async function detectNarrativeStructure(sourceDirectory, files, options = {}) {
  const warnings = [];
  const narrativeFiles = files.filter((file) => !classifyHotIngestFile(file.relativePath));
  const contextFiles = narrativeFiles.filter((file) => CONTEXT_EXTENSIONS.has(
    path.extname(file.relativePath).toLowerCase(),
  ));
  const briefFile = contextFiles.filter((file) => isBriefCandidate(file.relativePath))
    .sort((left, right) => briefPriority(left.relativePath) - briefPriority(right.relativePath))[0] || null;
  let projectBrief = null;
  if (briefFile) {
    const read = await readContextFile(briefFile);
    if (read.warning) warnings.push(read.warning);
    projectBrief = extractProjectBrief(briefFile.relativePath, read.text);
  }

  const directoryNames = detectChapterDirectories(narrativeFiles);
  const ordered = orderChapterNames(directoryNames, projectBrief);
  const chapterNames = ordered.names.length ? ordered.names : [path.basename(sourceDirectory)];
  let chapters = chapterNames.map((chapterName, index) => ({
    chapterId: `chapter-${index + 1}`,
    chapterName,
    chapterOrder: index + 1,
    relativePath: directoryNames.length ? chapterName : '.',
    orderSource: directoryNames.length ? ordered.source : 'single-directory-default',
    required: true,
    subchapters: directoryNames.length ? assignSubchapters(chapterName, narrativeFiles) : [],
  }));
  if (projectBrief) {
    projectBrief = {
      ...projectBrief,
      hardConstraints: {
        chapterOrder: chapters.map((chapter) => chapter.chapterId),
        allowChapterInterleave: false,
      },
    };
  }

  const contextDocuments = [];
  if (options.includeContext !== false) {
    for (const file of contextFiles) {
      const read = await readContextFile(file);
      if (read.warning) {
        warnings.push(read.warning);
        continue;
      }
      const assignment = chapterForRelativePath(chapters, file.relativePath);
      contextDocuments.push({
        relativePath: file.relativePath,
        chapterId: assignment.chapterId,
        subchapterId: assignment.subchapterId,
        type: path.extname(file.relativePath).slice(1).toLowerCase(),
        content: read.text,
        isProjectBrief: file.relativePath === briefFile?.relativePath,
      });
    }
  }
  return {
    chapters,
    projectBrief,
    contextDocuments,
    briefFilesUsed: projectBrief?.sourceDocuments || [],
    allowChapterInterleave: projectBrief ? false : false,
    enforceChapterValidation: directoryNames.length > 0 || Boolean(projectBrief),
    warnings,
  };
}

module.exports = {
  CONTEXT_EXTENSIONS,
  MAX_CONTEXT_BYTES,
  chapterForRelativePath,
  computeDurationPolicy,
  detectNarrativeStructure,
  extractProjectBrief,
  naturalCompare,
  summarizeChapters,
};
