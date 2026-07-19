const state = {
  project: null,
  missingDirs: [],
  assets: [],
  aiAnalysis: { schemaVersion: 1, updatedAt: null, analyses: {} },
  aiSettings: { schemaVersion: 1, mlxPythonPath: '' },
  aiEnvironment: null,
  aiAnalysisRunningStableId: null,
  aiBatchRunning: false,
  aiBatchMode: null,
  aiBatchProgress: null,
  aiBatchSummary: '',
  segmentsPayload: null,
  assignmentsPayload: null,
  roughcutStatusPayload: null,
  finalRoughcutStatus: null,
  subtitle: null,
  recentProjects: [],
  environment: null,
  toastTimer: null,
  selectedStableId: null,
  assetPreviewRequestId: 0,
  assetSearchQuery: '',
  assetTypeFilter: 'all',
  assetReviewFilter: 'all',
  assetReviewSaveQueue: Promise.resolve(),
  assetReviewSaveGeneration: 0,
  assetReviewPendingCount: 0,
  catalog: null,
  selectedCatalogProjectPath: null,
  selectedProjectResult: null,
};

const TEXT_PREVIEW_MAX_BYTES = 64 * 1024;
let assetViewModel = null;

function loadAssetViewModel() {
  if (window.AssetViewModel) return Promise.resolve(window.AssetViewModel);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = './asset-view-model.js';
    script.addEventListener('load', () => resolve(window.AssetViewModel), { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error('素材筛选模块加载失败。')),
      { once: true },
    );
    document.head.appendChild(script);
  });
}

const FIT_LABELS = {
  contain: '完整显示',
  cover: '铺满裁切',
  blur: '背景模糊填充',
  push_in: '轻微推近',
};

const AUDIO_LABELS = {
  none: '无原声',
  keep: '保留原声',
  duck: '压低原声',
  smart_duck: '智能压低原声',
};

const elements = {
  version: document.querySelector('#version'),
  viewEyebrow: document.querySelector('#viewEyebrow'),
  resultsCenterView: document.querySelector('#resultsCenterView'),
  workspaceView: document.querySelector('#workspaceView'),
  showResultsCenterButton: document.querySelector('#showResultsCenterButton'),
  showWorkspaceButton: document.querySelector('#showWorkspaceButton'),
  refreshCatalogButton: document.querySelector('#refreshCatalogButton'),
  catalogSummary: document.querySelector('#catalogSummary'),
  catalogError: document.querySelector('#catalogError'),
  projectCatalogList: document.querySelector('#projectCatalogList'),
  projectCatalogEmpty: document.querySelector('#projectCatalogEmpty'),
  resultDetailEmpty: document.querySelector('#resultDetailEmpty'),
  resultDetailLoading: document.querySelector('#resultDetailLoading'),
  resultDetailError: document.querySelector('#resultDetailError'),
  resultDetail: document.querySelector('#resultDetail'),
  projectName: document.querySelector('#projectName'),
  projectRoot: document.querySelector('#projectRoot'),
  selectRootButton: document.querySelector('#selectRootButton'),
  createProjectButton: document.querySelector('#createProjectButton'),
  openProjectButton: document.querySelector('#openProjectButton'),
  recentProjectsList: document.querySelector('#recentProjectsList'),
  emptyRecentProjects: document.querySelector('#emptyRecentProjects'),
  detectEnvironmentButton: document.querySelector('#detectEnvironmentButton'),
  environmentResult: document.querySelector('#environmentResult'),
  currentProjectCard: document.querySelector('#currentProjectCard'),
  currentProjectName: document.querySelector('#currentProjectName'),
  currentProjectPath: document.querySelector('#currentProjectPath'),
  missingDirsBox: document.querySelector('#missingDirsBox'),
  missingDirsText: document.querySelector('#missingDirsText'),
  ensureDirsButton: document.querySelector('#ensureDirsButton'),
  ffprobeWarning: document.querySelector('#ffprobeWarning'),
  scanButton: document.querySelector('#scanButton'),
  briefButton: document.querySelector('#briefButton'),
  editSuggestionButton: document.querySelector('#editSuggestionButton'),
  openCurrentControlDirButton: document.querySelector('#openCurrentControlDirButton'),
  assetsCard: document.querySelector('#assetsCard'),
  assetSummary: document.querySelector('#assetSummary'),
  assetsTableBody: document.querySelector('#assetsTableBody'),
  emptyAssets: document.querySelector('#emptyAssets'),
  assetSearchInput: document.querySelector('#assetSearchInput'),
  assetTypeFilter: document.querySelector('#assetTypeFilter'),
  assetReviewFilter: document.querySelector('#assetReviewFilter'),
  assetPreviewPrompt: document.querySelector('#assetPreviewPrompt'),
  assetPreviewPlaceholder: document.querySelector('#assetPreviewPlaceholder'),
  assetPreviewFilename: document.querySelector('#assetPreviewFilename'),
  assetPreviewType: document.querySelector('#assetPreviewType'),
  assetPreviewDuration: document.querySelector('#assetPreviewDuration'),
  assetPreviewDimensions: document.querySelector('#assetPreviewDimensions'),
  assetPreviewSize: document.querySelector('#assetPreviewSize'),
  assetPreviewAvailability: document.querySelector('#assetPreviewAvailability'),
  assetAiEmpty: document.querySelector('#assetAiEmpty'),
  assetAiContent: document.querySelector('#assetAiContent'),
  assetAiStale: document.querySelector('#assetAiStale'),
  assetAiStatus: document.querySelector('#assetAiStatus'),
  assetAiSummary: document.querySelector('#assetAiSummary'),
  assetAiTags: document.querySelector('#assetAiTags'),
  assetAiRisk: document.querySelector('#assetAiRisk'),
  assetAiCaptionIdeas: document.querySelector('#assetAiCaptionIdeas'),
  assetAiSuggestedUse: document.querySelector('#assetAiSuggestedUse'),
  assetAiModel: document.querySelector('#assetAiModel'),
  assetAiAnalyzedAt: document.querySelector('#assetAiAnalyzedAt'),
  assetAiError: document.querySelector('#assetAiError'),
  analyzeCurrentTextAssetButton: document.querySelector('#analyzeCurrentTextAssetButton'),
  analyzeCurrentImageAssetButton: document.querySelector('#analyzeCurrentImageAssetButton'),
  assetAiActionStatus: document.querySelector('#assetAiActionStatus'),
  analyzeUnanalyzedAssetsButton: document.querySelector('#analyzeUnanalyzedAssetsButton'),
  analyzeKeptAssetsButton: document.querySelector('#analyzeKeptAssetsButton'),
  assetAiBatchStatus: document.querySelector('#assetAiBatchStatus'),
  aiEnvironmentStatus: document.querySelector('#aiEnvironmentStatus'),
  aiEnvironmentDetails: document.querySelector('#aiEnvironmentDetails'),
  mlxPythonPathInput: document.querySelector('#mlxPythonPathInput'),
  saveMlxPythonPathButton: document.querySelector('#saveMlxPythonPathButton'),
  checkAiEnvironmentButton: document.querySelector('#checkAiEnvironmentButton'),
  assetReviewEmpty: document.querySelector('#assetReviewEmpty'),
  assetReviewForm: document.querySelector('#assetReviewForm'),
  assetReviewStatus: document.querySelector('#assetReviewStatus'),
  assetReviewRating: document.querySelector('#assetReviewRating'),
  assetReviewTags: document.querySelector('#assetReviewTags'),
  assetReviewNote: document.querySelector('#assetReviewNote'),
  saveAssetReviewNoteButton: document.querySelector('#saveAssetReviewNoteButton'),
  assetReviewSaveStatus: document.querySelector('#assetReviewSaveStatus'),
  videoPlanCard: document.querySelector('#videoPlanCard'),
  videoPlanText: document.querySelector('#videoPlanText'),
  importPlanButton: document.querySelector('#importPlanButton'),
  scanVoiceButton: document.querySelector('#scanVoiceButton'),
  planImportSummary: document.querySelector('#planImportSummary'),
  stage2Warning: document.querySelector('#stage2Warning'),
  voiceIssues: document.querySelector('#voiceIssues'),
  segmentsCard: document.querySelector('#segmentsCard'),
  segmentSummary: document.querySelector('#segmentSummary'),
  segmentsList: document.querySelector('#segmentsList'),
  emptySegments: document.querySelector('#emptySegments'),
  syncPackagesButton: document.querySelector('#syncPackagesButton'),
  generateAllRoughcutsButton: document.querySelector('#generateAllRoughcutsButton'),
  roughcutBatchSummary: document.querySelector('#roughcutBatchSummary'),
  finalRoughcutCard: document.querySelector('#finalRoughcutCard'),
  generateFinalRoughcutButton: document.querySelector('#generateFinalRoughcutButton'),
  generateFcpChecklistButton: document.querySelector('#generateFcpChecklistButton'),
  finalRoughcutStatusText: document.querySelector('#finalRoughcutStatusText'),
  finalRoughcutOutputPath: document.querySelector('#finalRoughcutOutputPath'),
  finalRoughcutDuration: document.querySelector('#finalRoughcutDuration'),
  finalRoughcutSegmentCount: document.querySelector('#finalRoughcutSegmentCount'),
  finalRoughcutGeneratedAt: document.querySelector('#finalRoughcutGeneratedAt'),
  finalRoughcutSummary: document.querySelector('#finalRoughcutSummary'),
  fcpChecklistSummary: document.querySelector('#fcpChecklistSummary'),
  showFinalRoughcutButton: document.querySelector('#showFinalRoughcutButton'),
  openControlDirButton: document.querySelector('#openControlDirButton'),
  openRoughcutDirButton: document.querySelector('#openRoughcutDirButton'),
  openFinalRoughcutDirButton: document.querySelector('#openFinalRoughcutDirButton'),
  subtitleCard: document.querySelector('#subtitleCard'),
  chooseSubtitleVideoButton: document.querySelector('#chooseSubtitleVideoButton'),
  generateSubtitleButton: document.querySelector('#generateSubtitleButton'),
  organizeSrtButton: document.querySelector('#organizeSrtButton'),
  subtitleCommandInput: document.querySelector('#subtitleCommandInput'),
  openSubtitleDirButton: document.querySelector('#openSubtitleDirButton'),
  subtitleVideoPath: document.querySelector('#subtitleVideoPath'),
  rawSrtStatus: document.querySelector('#rawSrtStatus'),
  finalSrtStatus: document.querySelector('#finalSrtStatus'),
  subtitleStatusText: document.querySelector('#subtitleStatusText'),
  subtitleRawCount: document.querySelector('#subtitleRawCount'),
  subtitleFinalCount: document.querySelector('#subtitleFinalCount'),
  subtitleSplitCount: document.querySelector('#subtitleSplitCount'),
  subtitleSummary: document.querySelector('#subtitleSummary'),
  toast: document.querySelector('#toast'),
};

function showToast(message, isError = false) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.classList.remove('hidden');
  state.toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), 5000);
}

function getUserErrorMessage(error) {
  const raw = error?.message || String(error);
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .split('\n')[0]
    || '操作失败，请查看项目总控中的日志文件。';
}

async function withBusy(button, action, busyText = '处理中…') {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    return await action();
  } catch (error) {
    showToast(getUserErrorMessage(error), true);
    return null;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function confirmAction(message) {
  return window.confirm(message);
}

function setWarning(message) {
  elements.stage2Warning.textContent = message || '';
  elements.stage2Warning.classList.toggle('hidden', !message);
}

function resetProjectViews() {
  state.assets = [];
  state.aiAnalysis = { schemaVersion: 1, updatedAt: null, analyses: {} };
  state.segmentsPayload = null;
  state.assignmentsPayload = null;
  state.roughcutStatusPayload = null;
  state.finalRoughcutStatus = null;
  state.subtitle = null;
  state.selectedStableId = null;
  state.aiAnalysisRunningStableId = null;
  state.aiBatchRunning = false;
  state.aiBatchMode = null;
  state.aiBatchProgress = null;
  state.aiBatchSummary = '';
  state.assetPreviewRequestId += 1;
  state.assetSearchQuery = '';
  state.assetTypeFilter = 'all';
  state.assetReviewFilter = 'all';
  state.assetReviewSaveQueue = Promise.resolve();
  state.assetReviewSaveGeneration += 1;
  state.assetReviewPendingCount = 0;
  elements.assetSearchInput.value = '';
  elements.assetTypeFilter.value = 'all';
  elements.assetReviewFilter.value = 'all';
  elements.assetsCard.classList.add('hidden');
  elements.ffprobeWarning.classList.add('hidden');
  elements.videoPlanText.value = '';
  elements.planImportSummary.textContent = '状态：未导入方案';
  elements.voiceIssues.classList.add('hidden');
  elements.roughcutBatchSummary.classList.add('hidden');
  elements.finalRoughcutSummary.classList.add('hidden');
  elements.fcpChecklistSummary.classList.add('hidden');
  elements.subtitleSummary.classList.add('hidden');
  setWarning('');
}

function renderProject() {
  if (!state.project) {
    elements.currentProjectCard.classList.add('hidden');
    elements.videoPlanCard.classList.add('hidden');
    elements.segmentsCard.classList.add('hidden');
    elements.finalRoughcutCard.classList.add('hidden');
    elements.subtitleCard.classList.add('hidden');
    return;
  }

  elements.currentProjectCard.classList.remove('hidden');
  elements.videoPlanCard.classList.add('hidden');
  elements.segmentsCard.classList.add('hidden');
  elements.finalRoughcutCard.classList.add('hidden');
  elements.subtitleCard.classList.add('hidden');
  elements.currentProjectName.textContent = state.project.projectName;
  elements.currentProjectPath.textContent = state.project.projectPath;

  const hasMissingDirs = state.missingDirs.length > 0;
  elements.missingDirsBox.classList.toggle('hidden', !hasMissingDirs);
  elements.missingDirsText.textContent = hasMissingDirs
    ? `缺少：${state.missingDirs.join('、')}`
    : '';
  elements.scanButton.disabled = hasMissingDirs;
  elements.briefButton.disabled = hasMissingDirs;
  elements.editSuggestionButton.disabled = hasMissingDirs;
  elements.importPlanButton.disabled = hasMissingDirs;
  elements.scanVoiceButton.disabled = hasMissingDirs;
  elements.syncPackagesButton.disabled = hasMissingDirs;
  elements.generateAllRoughcutsButton.disabled = hasMissingDirs;
  elements.generateFinalRoughcutButton.disabled = hasMissingDirs;
  elements.generateFcpChecklistButton.disabled = hasMissingDirs;
  elements.chooseSubtitleVideoButton.disabled = hasMissingDirs;
  elements.generateSubtitleButton.disabled = hasMissingDirs;
  elements.organizeSrtButton.disabled = hasMissingDirs;
  elements.openSubtitleDirButton.disabled = hasMissingDirs;
  renderAiBatchControls();
}

function displayType(type) {
  return {
    image: '图片',
    video: '视频',
    audio: '音频',
    text: '文本',
    other: '其他',
    unknown: '未知',
  }[type] || '未知';
}

function displayOrientation(orientation) {
  return {
    horizontal: '横屏',
    vertical: '竖屏',
    square: '方形',
    unknown: '未知',
  }[orientation] || '未知';
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remaining.toFixed(2).padStart(5, '0')}`;
}

function formatSeconds(seconds) {
  return Number.isFinite(seconds) ? `${seconds.toFixed(2)} 秒` : '—';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function createTextElement(tag, text, className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function switchMainView(view) {
  const showResults = view === 'results';
  elements.resultsCenterView.classList.toggle('hidden', !showResults);
  elements.workspaceView.classList.toggle('hidden', showResults);
  elements.showResultsCenterButton.classList.toggle('active', showResults);
  elements.showWorkspaceButton.classList.toggle('active', !showResults);
  elements.viewEyebrow.textContent = showResults
    ? 'CODEX · 项目结果中心'
    : 'STAGE 1 · 素材筛选台';
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN');
}

function formatResultDuration(value) {
  return Number.isFinite(value) ? `${Number(value.toFixed(2))} 秒` : '—';
}

function formatVideoSpec(format) {
  if (!format) return '—';
  const dimensions = format.width && format.height ? `${format.width}×${format.height}` : '—';
  const fps = Number.isFinite(format.fps) ? `${format.fps}p` : '—';
  return `${dimensions} · ${fps}`;
}

function resultStatusClass(status) {
  return `result-status result-status-${status || 'incomplete'}`;
}

function createResultSection(title, subtitle = '') {
  const section = document.createElement('section');
  section.className = 'result-section';
  const heading = document.createElement('div');
  heading.className = 'result-section-heading';
  heading.appendChild(createTextElement('h3', title));
  if (subtitle) heading.appendChild(createTextElement('p', subtitle));
  section.appendChild(heading);
  return section;
}

function createDefinitionGrid(entries, className = '') {
  const grid = document.createElement('dl');
  grid.className = `result-definition-grid ${className}`.trim();
  entries.forEach(([label, value]) => {
    const item = document.createElement('div');
    item.append(
      createTextElement('dt', label),
      createTextElement('dd', value ?? '—'),
    );
    grid.appendChild(item);
  });
  return grid;
}

function createArtifactButton(label, target, enabled = true) {
  const button = createTextElement('button', label, 'button secondary');
  button.type = 'button';
  button.disabled = !enabled;
  button.addEventListener('click', () =>
    withBusy(button, async () => {
      await window.plannerApi.runProjectArtifactAction({
        projectPath: state.selectedCatalogProjectPath,
        target,
      });
    }, '正在打开…'));
  return button;
}

function renderDecisionGroup(section, label, items) {
  const group = document.createElement('div');
  group.className = 'decision-group';
  group.appendChild(createTextElement('h4', `${label} · ${items.length}`));
  if (!items.length) {
    group.appendChild(createTextElement('p', '无'));
  } else {
    const list = document.createElement('div');
    list.className = 'decision-list';
    items.forEach((item) => {
      const row = document.createElement('article');
      const ranges = item.ranges.length
        ? item.ranges.map((range) => `${range.startSec}–${range.endSec}s`).join('、')
        : '静态素材 / 无有效区间';
      row.append(
        createTextElement('strong', item.filename),
        createTextElement('p', item.reason || '未记录理由'),
        createTextElement(
          'small',
          `${ranges} · ${item.selectedPath?.exists ? '已复制到精选素材' : '未复制到精选素材'}`,
        ),
      );
      list.appendChild(row);
    });
    group.appendChild(list);
  }
  section.appendChild(group);
}

function renderCodexProjectResult(result) {
  state.selectedProjectResult = result;
  elements.resultDetail.replaceChildren();
  elements.resultDetail.classList.remove('hidden');
  elements.resultDetailEmpty.classList.add('hidden');
  elements.resultDetailLoading.classList.add('hidden');
  elements.resultDetailError.classList.add('hidden');

  const hero = document.createElement('div');
  hero.className = 'result-hero';
  const heroText = document.createElement('div');
  heroText.append(
    createTextElement('span', result.project.statusLabel, resultStatusClass(result.project.status)),
    createTextElement('h2', result.project.name),
    createTextElement('p', result.summary.recommendedTitle || '尚无 Codex 建议标题'),
    createTextElement('small', result.project.path, 'result-path'),
  );
  const heroActions = document.createElement('div');
  heroActions.className = 'result-actions';
  heroActions.append(
    createArtifactButton('打开项目目录', 'projectRoot'),
    createArtifactButton('打开精选素材', 'selectedAssets', result.artifacts.selectedAssets?.exists),
    createArtifactButton('打开导出目录', 'exportDirectory', result.artifacts.exportDirectory?.exists),
  );
  const legacyButton = createTextElement('button', '进入素材筛选台', 'button ghost');
  legacyButton.addEventListener('click', () =>
    withBusy(legacyButton, async () => {
      const opened = await window.plannerApi.openProjectPath(result.project.path);
      await activateProject(opened, `已打开项目：${opened.project.projectName}`);
      switchMainView('workspace');
    }, '正在打开…'));
  heroActions.appendChild(legacyButton);
  hero.append(heroText, heroActions);
  elements.resultDetail.appendChild(hero);

  const summary = createResultSection('结果摘要');
  summary.appendChild(createDefinitionGrid([
    ['主题', result.summary.theme],
    ['主题依据', result.summary.themeRationale],
    ['建议标题', result.summary.recommendedTitle],
    ['标题候选', result.summary.titleCandidates.join('、') || '—'],
    ['创建时间', formatDateTime(result.project.createdAt)],
    ['生成时间', formatDateTime(result.project.generatedAt)],
    ['验证时间', formatDateTime(result.project.verifiedAt)],
  ]));
  elements.resultDetail.appendChild(summary);

  const decisions = createResultSection('素材取舍', '只展示结构化 Codex 分析，不反向解析 Markdown 报告。');
  renderDecisionGroup(decisions, '采用', result.decisions.adopt);
  renderDecisionGroup(decisions, '候选', result.decisions.candidate);
  renderDecisionGroup(decisions, '淘汰', result.decisions.reject);
  elements.resultDetail.appendChild(decisions);

  const timeline = createResultSection(
    '时间线',
    `${result.timeline.shotCount} 个镜头 · ${formatResultDuration(result.timeline.totalDurationSec)} · ${result.timeline.markers.length} 个 marker`,
  );
  const shotList = document.createElement('ol');
  shotList.className = 'shot-list';
  result.timeline.shots.forEach((shot) => {
    const item = document.createElement('li');
    const label = shot.hyperframes ? 'HyperFrames' : '素材';
    item.append(
      createTextElement('strong', `${shot.order}. ${shot.filename}`),
      createTextElement(
        'span',
        `${label} · ${shot.inSec}–${shot.outSec}s · ${formatResultDuration(shot.durationSec)} · ${shot.purpose || '—'}`,
        shot.hyperframes ? 'hyperframes-shot' : '',
      ),
    );
    shotList.appendChild(item);
  });
  if (!result.timeline.shots.length) shotList.appendChild(createTextElement('li', '暂无正式时间线数据'));
  timeline.appendChild(shotList);
  const markerText = result.timeline.markers.length
    ? result.timeline.markers.map((marker) => `${marker.timeSec}s ${marker.text}`).join(' · ')
    : '本期无 marker';
  timeline.appendChild(createTextElement('p', markerText, 'marker-summary'));
  elements.resultDetail.appendChild(timeline);

  const formats = createResultSection('格式', '正式 FCP 项目与轻量粗剪预览是两套独立规格。');
  const formatCards = document.createElement('div');
  formatCards.className = 'format-cards';
  const formal = document.createElement('article');
  formal.append(
    createTextElement('h4', '正式 FCP 项目'),
    createTextElement('strong', formatVideoSpec(result.formats.timeline)),
    createTextElement('p', `${displayOrientation(result.formats.timeline?.orientation)} · ${result.formats.fcpxmlClipCount ?? '—'} 个独立 clip`),
  );
  const preview = document.createElement('article');
  preview.append(
    createTextElement('h4', '粗剪预览'),
    createTextElement('strong', formatVideoSpec(result.formats.preview)),
    createTextElement('p', `实际时长 ${formatResultDuration(result.formats.previewMetadata?.durationSec)}`),
  );
  formatCards.append(formal, preview);
  formats.appendChild(formatCards);
  elements.resultDetail.appendChild(formats);

  const player = createResultSection('粗剪播放器', '这是评审预览，不是正式 FCP 时间线。');
  if (result.artifacts.preview?.fileUrl) {
    const video = document.createElement('video');
    video.className = 'result-video';
    video.controls = true;
    video.preload = 'metadata';
    video.src = result.artifacts.preview.fileUrl;
    player.appendChild(video);
  } else {
    player.appendChild(createTextElement('p', '粗剪预览缺失或不可读取。', 'empty-inline'));
  }
  elements.resultDetail.appendChild(player);

  const artifacts = createResultSection('产物操作');
  const artifactActions = document.createElement('div');
  artifactActions.className = 'result-actions';
  artifactActions.append(
    createArtifactButton('Finder 中显示粗剪', 'preview', result.artifacts.preview?.exists),
    createArtifactButton('Finder 中显示 FCPXML', 'fcpxml', result.artifacts.fcpxml?.exists),
    createArtifactButton('定位分析 JSON', 'analysis', result.artifacts.analysis?.exists),
    createArtifactButton('定位状态 JSON', 'status', result.artifacts.status?.exists),
  );
  const fcpButton = createTextElement('button', '使用 Final Cut Pro 打开', 'button primary');
  fcpButton.disabled = !result.artifacts.fcpxml?.exists;
  fcpButton.addEventListener('click', () =>
    withBusy(fcpButton, async () => {
      const opened = await window.plannerApi.openProjectFcpxmlInFinalCut(result.project.path);
      showToast(`已通过 ${opened.strategy === 'bundle-id' ? 'Bundle ID' : '应用路径'} 发送给 Final Cut Pro。`);
    }, '正在打开…'));
  artifactActions.appendChild(fcpButton);
  artifacts.appendChild(artifactActions);
  elements.resultDetail.appendChild(artifacts);

  const verification = createResultSection('验证状态');
  verification.appendChild(createDefinitionGrid([
    ['总体', result.verification.statusLabel],
    ['源素材 SHA-256', result.verification.source.unchanged === true ? '通过' : (result.verification.source.unchanged === false ? '失败' : '—')],
    ['源素材 digest', result.verification.source.beforeDigest],
    ['FCPXML 结构', result.verification.fcpxml?.ok === true ? '通过' : (result.verification.fcpxml ? '失败' : '—')],
    ['FCPXML XML', result.verification.xmlSyntax?.ok === true ? '通过' : (result.verification.xmlSyntax ? '失败' : '—')],
    ['粗剪', result.verification.preview?.hasVideo === true ? '通过' : (result.verification.preview ? '失败' : '—')],
    ['HyperFrames', result.hyperframes.enabled ? (result.hyperframes.checkOk ? '通过' : '未通过') : '本期未启用'],
    ['warnings', result.verification.warnings.join('；') || '无'],
    ['errors', result.verification.errors.join('；') || '无'],
  ]));
  const verifyActions = document.createElement('div');
  verifyActions.className = 'result-actions';
  const verifyButton = createTextElement('button', '重新验证（只读）', 'button secondary');
  const verifyRun = createTextElement('span', '', 'verify-run-status');
  verifyButton.disabled = !result.project.isCodexProject;
  verifyButton.addEventListener('click', () =>
    withBusy(verifyButton, async () => {
      const report = await window.plannerApi.verifyCodexProjectReadOnly(result.project.path);
      verifyRun.textContent = `${report.ok ? '验证通过' : '验证失败'} · ${formatDateTime(report.verifiedAt)}`;
      verifyRun.classList.toggle('error', !report.ok);
      showToast(report.ok ? '只读验证通过，项目文件未改写。' : `验证失败：${report.errors?.[0] || '未知错误'}`, !report.ok);
    }, '验证中…'));
  verifyActions.append(verifyButton, verifyRun);
  verification.appendChild(verifyActions);
  elements.resultDetail.appendChild(verification);

  const hyperframes = createResultSection('HyperFrames');
  if (!result.hyperframes.enabled) {
    hyperframes.appendChild(createTextElement('p', '本期未启用 HyperFrames', 'hyperframes-disabled'));
  } else {
    hyperframes.appendChild(createDefinitionGrid([
      ['状态', '已启用'],
      ['版本', result.hyperframes.version],
      ['动画数量', String(result.hyperframes.count)],
      ['类型', result.hyperframes.kind],
      ['规格', `${result.hyperframes.width}×${result.hyperframes.height} · ${result.hyperframes.fps}p`],
      ['时长', formatResultDuration(result.hyperframes.durationSec)],
      ['插入位置', result.hyperframes.insertAfterShotId ? `${result.hyperframes.insertAfterShotId} 之后` : '—'],
      ['stable ID', result.hyperframes.stableId],
      ['SHA-256', result.hyperframes.sha256],
      ['check', result.hyperframes.checkOk ? '通过' : '未通过'],
    ]));
    if (result.hyperframes.file?.fileUrl) {
      const video = document.createElement('video');
      video.className = 'result-video hyperframes-video';
      video.controls = true;
      video.preload = 'metadata';
      video.src = result.hyperframes.file.fileUrl;
      hyperframes.appendChild(video);
    }
    const hfActions = document.createElement('div');
    hfActions.className = 'result-actions';
    hfActions.appendChild(createArtifactButton(
      'Finder 中定位动画',
      'hyperframesMp4',
      result.hyperframes.file?.exists,
    ));
    hyperframes.appendChild(hfActions);
  }
  elements.resultDetail.appendChild(hyperframes);
}

async function loadCatalogProject(projectPath) {
  state.selectedCatalogProjectPath = projectPath;
  renderProjectCatalog();
  elements.resultDetailEmpty.classList.add('hidden');
  elements.resultDetail.classList.add('hidden');
  elements.resultDetailError.classList.add('hidden');
  elements.resultDetailLoading.classList.remove('hidden');
  try {
    const result = await window.plannerApi.getCodexProjectResult(projectPath);
    if (state.selectedCatalogProjectPath !== projectPath) return;
    renderCodexProjectResult(result);
  } catch (error) {
    if (state.selectedCatalogProjectPath !== projectPath) return;
    elements.resultDetailLoading.classList.add('hidden');
    elements.resultDetailError.textContent = getUserErrorMessage(error);
    elements.resultDetailError.classList.remove('hidden');
  }
}

function renderProjectCatalog() {
  const projects = state.catalog?.projects || [];
  elements.projectCatalogList.replaceChildren();
  elements.projectCatalogEmpty.classList.toggle('hidden', projects.length > 0);
  projects.forEach((project) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'catalog-project';
    if (project.projectPath === state.selectedCatalogProjectPath) button.classList.add('selected');
    const top = document.createElement('div');
    top.className = 'catalog-project-top';
    top.append(
      createTextElement('strong', project.projectName),
      createTextElement('span', project.statusLabel, resultStatusClass(project.status)),
    );
    const format = project.timelineFormat
      ? `${project.timelineFormat.width}×${project.timelineFormat.height} · ${project.timelineFormat.fps}p`
      : '规格未知';
    button.append(
      top,
      createTextElement('p', project.recommendedTitle || '尚无建议标题'),
      createTextElement(
        'small',
        `${formatDateTime(project.generatedAt || project.createdAt || project.filesystemTime)} · ${project.shotCount ?? '—'} 镜头 · ${formatResultDuration(project.totalDurationSec)}`,
      ),
    );
    const badges = document.createElement('div');
    badges.className = 'catalog-badges';
    if (project.hyperframesEnabled) badges.appendChild(createTextElement('span', 'HyperFrames', 'hyperframes-badge'));
    if (project.warningCount) badges.appendChild(createTextElement('span', `${project.warningCount} 警告`, 'warning-badge'));
    if (project.errorCount) badges.appendChild(createTextElement('span', `${project.errorCount} 错误`, 'error-badge'));
    button.appendChild(badges);
    button.addEventListener('click', () => loadCatalogProject(project.projectPath));
    elements.projectCatalogList.appendChild(button);
  });
}

async function loadProjectCatalog() {
  elements.catalogError.classList.add('hidden');
  state.catalog = await window.plannerApi.scanProjectCatalog();
  const projects = state.catalog.projects || [];
  elements.catalogSummary.textContent = state.catalog.exists
    ? `已从 ${state.catalog.rootPath} 发现 ${projects.length} 个项目；忽略 ${state.catalog.ignoredCount} 个普通目录。`
    : `默认项目库不存在：${state.catalog.rootPath}`;
  renderProjectCatalog();
  if (state.selectedCatalogProjectPath
    && projects.some((project) => project.projectPath === state.selectedCatalogProjectPath)) {
    await loadCatalogProject(state.selectedCatalogProjectPath);
  } else if (projects.length) {
    await loadCatalogProject(projects[0].projectPath);
  } else {
    state.selectedCatalogProjectPath = null;
    elements.resultDetail.classList.add('hidden');
    elements.resultDetailError.classList.add('hidden');
    elements.resultDetailLoading.classList.add('hidden');
    elements.resultDetailEmpty.classList.remove('hidden');
  }
}

function renderRecentProjects() {
  elements.recentProjectsList.replaceChildren();
  elements.emptyRecentProjects.classList.toggle('hidden', state.recentProjects.length > 0);

  for (const project of state.recentProjects) {
    const row = document.createElement('div');
    row.className = 'recent-project-row';
    const info = document.createElement('div');
    info.className = 'recent-project-info';
    info.append(
      createTextElement('strong', project.projectName || '未命名项目'),
      createTextElement('span', project.projectPath || '—'),
      createTextElement(
        'span',
        project.exists
          ? `最近打开：${project.lastOpenedAt || '—'}`
          : '项目不存在',
        project.exists ? '' : 'missing-project',
      ),
    );
    const openButton = createTextElement('button', '打开', 'button secondary');
    openButton.disabled = !project.exists;
    openButton.addEventListener('click', () =>
      withBusy(openButton, async () => {
        const result = await window.plannerApi.openProjectPath(project.projectPath);
        await activateProject(result, `已打开项目：${result.project.projectName}`);
      }));
    row.append(info, openButton);
    elements.recentProjectsList.appendChild(row);
  }
}

function renderEnvironmentResult(result) {
  if (!result) {
    elements.environmentResult.classList.add('hidden');
    elements.environmentResult.replaceChildren();
    return;
  }
  elements.environmentResult.classList.remove('hidden');
  elements.environmentResult.replaceChildren();
  const entries = [
    ['ffmpeg', result.ffmpeg],
    ['ffprobe', result.ffprobe],
    [`字幕命令 ${result.subtitleCommand.command}`, result.subtitleCommand],
  ];
  for (const [label, item] of entries) {
    const row = document.createElement('div');
    row.className = 'environment-row';
    row.append(
      createTextElement('strong', label),
      createTextElement('span', item.message || (item.available ? '可用' : '不可用'),
        item.available ? 'env-ok' : 'env-warn'),
      createTextElement('small', item.detail || ''),
    );
    elements.environmentResult.appendChild(row);
  }
  const note = createTextElement(
    'p',
    'ffmpeg / ffprobe 不可用时，粗剪和视频信息读取会受影响；字幕命令不可用时，可以先手动生成 raw.srt，再用“整理已有 SRT”。',
    'environment-note',
  );
  elements.environmentResult.appendChild(note);
}

function addCell(row, text, title = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (title) cell.title = title;
  row.appendChild(cell);
}

function getUsageMap() {
  const usage = new Map();
  for (const assignment of state.assignmentsPayload?.segments || []) {
    for (const item of assignment.items) {
      const segmentIds = usage.get(item.assetId) || new Set();
      segmentIds.add(assignment.segmentId);
      usage.set(item.assetId, segmentIds);
    }
  }
  return usage;
}

function getAssetUiKey(asset) {
  return assetViewModel.getAssetUiKey(asset);
}

function getAssetTypeCategory(asset) {
  return assetViewModel.getAssetTypeCategory(asset);
}

function getAssetReviewCategory(asset) {
  return assetViewModel.getAssetReviewCategory(asset);
}

function assetMatchesFilters(asset) {
  return assetViewModel.assetMatchesFilters(asset, {
    searchQuery: state.assetSearchQuery,
    typeFilter: state.assetTypeFilter,
    reviewFilter: state.assetReviewFilter,
  });
}

function setAssetPreviewContent(content, stateClass = '') {
  elements.assetPreviewPlaceholder.className = [
    'asset-preview-placeholder',
    stateClass,
  ].filter(Boolean).join(' ');
  elements.assetPreviewPlaceholder.replaceChildren(...content);
}

function renderAssetPreviewMessage(message, stateClass = '') {
  setAssetPreviewContent(
    [createTextElement('span', message, 'asset-preview-message')],
    stateClass,
  );
}

function renderAssetDetails(asset) {
  const hasSelection = Boolean(asset);
  const filename = asset?.filename || asset?.relativePath || '—';
  elements.assetPreviewPrompt.textContent = hasSelection
    ? filename
    : '选择一个素材查看预览';
  if (!hasSelection) renderAssetPreviewMessage('选择一个素材查看预览');
  elements.assetPreviewFilename.textContent = filename;
  elements.assetPreviewType.textContent = hasSelection
    ? displayType(getAssetTypeCategory(asset))
    : '—';
  elements.assetPreviewDuration.textContent = hasSelection
    ? formatDuration(asset.durationSec)
    : '—';
  elements.assetPreviewDimensions.textContent = asset?.width && asset?.height
    ? `${asset.width}×${asset.height}`
    : '—';
  elements.assetPreviewSize.textContent = hasSelection ? formatBytes(asset.sizeBytes) : '—';
  elements.assetPreviewAvailability.textContent = hasSelection
    ? ({ available: '可用', missing: '缺失' }[asset.availability] || asset.availability || '—')
    : '—';
  renderAssetAiAnalysis(asset);
  renderAssetReviewForm(asset);
}

function renderAiBatchControls() {
  const isAnyAiRunning = Boolean(state.aiAnalysisRunningStableId) || state.aiBatchRunning;
  const disabled = !state.project || isAnyAiRunning;
  elements.analyzeUnanalyzedAssetsButton.disabled = disabled;
  elements.analyzeKeptAssetsButton.disabled = disabled;
  elements.analyzeUnanalyzedAssetsButton.textContent =
    state.aiBatchRunning && state.aiBatchMode === 'unanalyzed'
      ? '批量分析中...'
      : '分析未分析素材';
  elements.analyzeKeptAssetsButton.textContent =
    state.aiBatchRunning && state.aiBatchMode === 'kept'
      ? '批量分析中...'
      : '分析保留素材';

  if (!state.aiBatchRunning) {
    elements.assetAiBatchStatus.textContent = state.aiBatchSummary;
    return;
  }

  const progress = state.aiBatchProgress;
  if (!progress || progress.phase === 'started') {
    elements.assetAiBatchStatus.textContent =
      '准备批量分析，共 ' + (progress?.total || 0)
      + ' 个；跳过 ' + (progress?.skipped || 0) + ' 个。';
    return;
  }
  elements.assetAiBatchStatus.textContent =
    '正在分析第 ' + progress.current + ' / ' + progress.total
    + ' 个：' + progress.filename
    + '｜成功 ' + progress.success + '，失败 ' + progress.failed
    + '，跳过 ' + progress.skipped;
}

function renderAssetAiAnalysis(asset) {
  const hasSelection = Boolean(asset);
  const textAvailability = assetViewModel.getTextAnalysisAvailability(asset);
  const imageAvailability = assetViewModel.getImageAnalysisAvailability(asset);
  const isSingleRunning = Boolean(state.aiAnalysisRunningStableId);
  const isRunning = isSingleRunning || state.aiBatchRunning;
  const isCurrentRunning = state.aiAnalysisRunningStableId === asset?.stableId;
  const assetType = assetViewModel.getAssetTypeCategory(asset);
  const isCurrentTextRunning = isCurrentRunning && assetType === 'text';
  const isCurrentImageRunning = isCurrentRunning && assetType === 'image';
  elements.analyzeCurrentTextAssetButton.disabled = isRunning || !textAvailability.allowed;
  elements.analyzeCurrentTextAssetButton.title = textAvailability.reason;
  elements.analyzeCurrentTextAssetButton.textContent = isCurrentTextRunning
    ? '分析中...'
    : '分析当前文本素材';
  elements.analyzeCurrentImageAssetButton.disabled = isRunning || !imageAvailability.allowed;
  elements.analyzeCurrentImageAssetButton.title = imageAvailability.reason;
  elements.analyzeCurrentImageAssetButton.textContent = isCurrentImageRunning
    ? '分析中...'
    : '分析当前图片素材';
  elements.assetAiActionStatus.textContent = isRunning
    ? (isCurrentRunning
      ? `正在调用本地 ${isCurrentImageRunning ? 'MLX-VLM' : 'MLX-LM'}，请稍候。`
      : '另一个素材正在分析。')
    : (hasSelection && ['text', 'image'].includes(assetType)
      ? ''
      : imageAvailability.reason);
  renderAiBatchControls();
  elements.assetAiEmpty.classList.toggle('hidden', hasSelection);
  elements.assetAiContent.classList.toggle('hidden', !hasSelection);
  if (!hasSelection) return;

  const view = assetViewModel.getAiAnalysisViewData(asset, state.aiAnalysis);
  elements.assetAiStale.classList.toggle('hidden', !view.isStale);
  elements.assetAiStatus.textContent = view.statusText;
  elements.assetAiStatus.className = `asset-ai-status ai-status-${view.status}`;
  elements.assetAiSummary.textContent = view.summaryText;
  elements.assetAiTags.textContent = view.tagsText;
  elements.assetAiRisk.textContent = view.riskText;
  elements.assetAiCaptionIdeas.textContent = view.captionIdeasText;
  elements.assetAiSuggestedUse.textContent = view.suggestedUseText;
  elements.assetAiModel.textContent = view.modelText;
  elements.assetAiAnalyzedAt.textContent = view.analyzedAtText;
  elements.assetAiError.textContent = view.errorText;
  elements.assetAiError.classList.toggle('asset-ai-error', view.errorText !== '—');
}

function renderAiEnvironment(result) {
  const stateName = result ? (result.available ? 'available' : 'unavailable') : 'unchecked';
  const statusText = {
    available: 'AI 环境：可用',
    unavailable: 'AI 环境：不可用',
    unchecked: 'AI 环境：未检测',
  }[stateName];
  elements.aiEnvironmentStatus.textContent = statusText;
  elements.aiEnvironmentStatus.className = `ai-environment-status ai-environment-${stateName}`;
  elements.aiEnvironmentDetails.classList.toggle('hidden', !result);
  if (!result) {
    elements.aiEnvironmentDetails.textContent = '';
    return;
  }

  const python = result.python || {};
  const packageEntries = Object.entries(result.packages || {});
  const packageText = packageEntries.map(([name, item]) =>
    `${name} ${item.ok
      ? (item.version || '已安装')
      : (item.version ? `${item.version}（不可用）` : '缺失')}`).join(' · ');
  const pythonText = python.ok
    ? `Python ${python.version || '未知版本'} · ${python.arch || '未知架构'} · ${python.path || '未知路径'}`
    : '未找到可用 Python';
  const errorText = (result.errors || []).map((error) => error.message).join('；');
  elements.aiEnvironmentDetails.textContent = [pythonText, packageText, errorText]
    .filter(Boolean)
    .join('\n');
}

function renderAssetReviewForm(asset) {
  const hasSelection = Boolean(asset);
  elements.assetReviewEmpty.classList.toggle('hidden', hasSelection);
  elements.assetReviewForm.classList.toggle('hidden', !hasSelection);
  if (!hasSelection) {
    elements.assetReviewSaveStatus.textContent = '';
    elements.assetReviewSaveStatus.classList.remove('error');
    return;
  }

  elements.assetReviewStatus.value = ['keep', 'maybe', 'reject'].includes(asset.reviewStatus)
    ? asset.reviewStatus
    : 'unreviewed';
  elements.assetReviewRating.value = String(
    assetViewModel.getAssetRatingValue(asset.rating),
  );
  elements.assetReviewTags.value = Array.isArray(asset.tags) ? asset.tags.join(', ') : '';
  elements.assetReviewNote.value = typeof asset.note === 'string' ? asset.note : '';
  setAssetReviewControlsDisabled(!asset.stableId);
  elements.assetReviewSaveStatus.textContent = asset.stableId
    ? ''
    : '素材缺少 stableId，无法保存审核信息。';
  elements.assetReviewSaveStatus.classList.toggle('error', !asset.stableId);
}

function setAssetReviewControlsDisabled(disabled) {
  elements.assetReviewStatus.disabled = disabled;
  elements.assetReviewRating.disabled = disabled;
  elements.assetReviewTags.disabled = disabled;
  elements.assetReviewNote.disabled = disabled;
  elements.saveAssetReviewNoteButton.disabled = disabled;
}

function getSelectedAsset() {
  return state.assets.find((asset) => getAssetUiKey(asset) === state.selectedStableId);
}

function parseAssetReviewTags(value) {
  return assetViewModel.parseAssetReviewTags(value);
}

function getAssetReviewDraft() {
  return {
    reviewStatus: elements.assetReviewStatus.value,
    rating: elements.assetReviewRating.value,
    tags: elements.assetReviewTags.value,
    note: elements.assetReviewNote.value,
  };
}

function restoreUnchangedAssetReviewDraft(draft, changedFields) {
  if (!draft) return;
  if (!changedFields.has('reviewStatus')) {
    elements.assetReviewStatus.value = draft.reviewStatus;
  }
  if (!changedFields.has('rating')) elements.assetReviewRating.value = draft.rating;
  if (!changedFields.has('tags')) elements.assetReviewTags.value = draft.tags;
  if (!changedFields.has('note')) elements.assetReviewNote.value = draft.note;
}

function saveSelectedAssetReview(patch, successMessage) {
  const asset = getSelectedAsset();
  const projectPath = state.project?.projectPath;
  if (!asset?.stableId || !projectPath) return Promise.resolve();

  const stableId = asset.stableId;
  const generation = state.assetReviewSaveGeneration;
  const changedFields = new Set(Object.keys(patch));
  state.assetReviewPendingCount += 1;
  elements.assetReviewSaveStatus.textContent = state.assetReviewPendingCount > 1
    ? '等待保存…'
    : '保存中…';
  elements.assetReviewSaveStatus.classList.remove('error');

  const performSave = async () => {
    if (
      generation !== state.assetReviewSaveGeneration
      || state.project?.projectPath !== projectPath
    ) return;

    if (getSelectedAsset()?.stableId === stableId) {
      elements.assetReviewSaveStatus.textContent = '保存中…';
      elements.assetReviewSaveStatus.classList.remove('error');
    }

    try {
      const result = await window.plannerApi.updateAssetReview({
        projectPath,
        stableId,
        patch,
      });
      if (
        generation !== state.assetReviewSaveGeneration
        || state.project?.projectPath !== projectPath
      ) return;

      const isStillSelected = getSelectedAsset()?.stableId === stableId;
      const draft = isStillSelected ? getAssetReviewDraft() : null;
      state.assets = state.assets.map((entry) =>
        entry.stableId === stableId ? result.asset : entry);
      renderAssets();
      if (getSelectedAsset()?.stableId === stableId) {
        restoreUnchangedAssetReviewDraft(draft, changedFields);
        elements.assetReviewSaveStatus.textContent = successMessage;
        elements.assetReviewSaveStatus.classList.remove('error');
      }
    } catch (error) {
      if (
        generation !== state.assetReviewSaveGeneration
        || state.project?.projectPath !== projectPath
      ) return;

      const isStillSelected = getSelectedAsset()?.stableId === stableId;
      const draft = isStillSelected ? getAssetReviewDraft() : null;
      const message = getUserErrorMessage(error);
      if (isStillSelected) {
        renderAssetDetails(getSelectedAsset());
        restoreUnchangedAssetReviewDraft(draft, changedFields);
        elements.assetReviewSaveStatus.textContent = `保存失败：${message}`;
        elements.assetReviewSaveStatus.classList.add('error');
      }
      showToast(`审核信息保存失败：${message}`, true);
    } finally {
      if (generation === state.assetReviewSaveGeneration) {
        state.assetReviewPendingCount = Math.max(0, state.assetReviewPendingCount - 1);
        if (
          state.assetReviewPendingCount > 0
          && getSelectedAsset()?.stableId === stableId
        ) {
          elements.assetReviewSaveStatus.textContent = '还有审核信息待保存…';
          elements.assetReviewSaveStatus.classList.remove('error');
        }
      }
    }
  };

  state.assetReviewSaveQueue = state.assetReviewSaveQueue.then(performSave, performSave);
  return state.assetReviewSaveQueue;
}

function isCurrentAssetPreviewRequest(requestId, assetKey, projectPath) {
  return state.assetPreviewRequestId === requestId
    && state.selectedStableId === assetKey
    && state.project?.projectPath === projectPath;
}

function renderMediaAssetPreview(asset, preview, requestId, assetKey, projectPath) {
  const type = assetViewModel.getAssetPreviewType(asset);
  const media = document.createElement(type === 'image' ? 'img' : type);
  media.className = `asset-preview-media asset-preview-${type}`;
  media.src = preview.fileUrl;
  if (type === 'image') {
    media.alt = asset.filename || '素材图片预览';
  } else {
    media.controls = true;
    media.preload = 'metadata';
  }
  media.addEventListener('error', () => {
    if (!isCurrentAssetPreviewRequest(requestId, assetKey, projectPath)) return;
    renderAssetPreviewMessage('媒体文件无法加载。', 'preview-error');
  }, { once: true });
  setAssetPreviewContent([media], 'preview-media');
}

function renderTextAssetPreview(result) {
  const text = document.createElement('pre');
  text.className = 'asset-preview-text';
  text.textContent = result.text || '（文件为空）';
  const content = [text];
  if (result.truncated) {
    content.push(createTextElement(
      'p',
      `仅显示前 ${result.bytesRead} 字节内容。`,
      'asset-preview-truncated',
    ));
  }
  setAssetPreviewContent(content, 'preview-text');
}

async function loadAssetPreview(asset, assetKey) {
  const requestId = ++state.assetPreviewRequestId;
  const projectPath = state.project?.projectPath;
  renderAssetPreviewMessage('正在加载预览…', 'preview-loading');

  if (asset.availability === 'missing') {
    renderAssetPreviewMessage('文件缺失，无法预览。', 'preview-missing');
    return;
  }
  if (!asset.stableId) {
    renderAssetPreviewMessage('素材缺少 stableId，请重新扫描后再预览。', 'preview-error');
    return;
  }

  const type = assetViewModel.getAssetPreviewType(asset);
  if (type === 'unsupported') {
    renderAssetPreviewMessage('此文件类型暂不支持预览。', 'preview-unsupported');
    return;
  }

  try {
    if (type === 'text') {
      const result = await window.plannerApi.readTextPreview({
        projectPath,
        stableId: asset.stableId,
        maxBytes: TEXT_PREVIEW_MAX_BYTES,
      });
      if (!isCurrentAssetPreviewRequest(requestId, assetKey, projectPath)) return;
      renderTextAssetPreview(result);
      return;
    }

    const preview = await window.plannerApi.getAssetPreview({
      projectPath,
      stableId: asset.stableId,
    });
    if (!isCurrentAssetPreviewRequest(requestId, assetKey, projectPath)) return;
    renderMediaAssetPreview(asset, preview, requestId, assetKey, projectPath);
  } catch (error) {
    if (!isCurrentAssetPreviewRequest(requestId, assetKey, projectPath)) return;
    renderAssetPreviewMessage(
      `预览加载失败：${getUserErrorMessage(error)}`,
      'preview-error',
    );
  }
}

function renderAssets() {
  elements.assetsCard.classList.remove('hidden');
  elements.assetsTableBody.replaceChildren();
  const filteredAssets = state.assets.filter(assetMatchesFilters);
  const selectedAsset = state.assets.find(
    (asset) => getAssetUiKey(asset) === state.selectedStableId,
  );
  if (state.selectedStableId && !selectedAsset) state.selectedStableId = null;
  elements.assetSummary.textContent = filteredAssets.length === state.assets.length
    ? `共 ${state.assets.length} 个素材`
    : `显示 ${filteredAssets.length} / ${state.assets.length} 个素材`;
  elements.emptyAssets.textContent = state.assets.length
    ? '没有符合当前条件的素材。'
    : '还没有扫描素材。';
  elements.emptyAssets.classList.toggle('hidden', filteredAssets.length > 0);
  renderAssetDetails(selectedAsset);
  const usage = getUsageMap();

  for (const asset of filteredAssets) {
    const assetKey = getAssetUiKey(asset);
    const row = document.createElement('tr');
    row.className = 'asset-row';
    row.dataset.assetKey = assetKey;
    if (asset.stableId) row.dataset.stableId = asset.stableId;
    row.tabIndex = 0;
    row.setAttribute('aria-selected', String(assetKey === state.selectedStableId));
    row.classList.toggle('selected', assetKey === state.selectedStableId);
    const selectAsset = () => {
      state.selectedStableId = assetKey;
      for (const assetRow of elements.assetsTableBody.querySelectorAll('.asset-row')) {
        const isSelected = assetRow.dataset.assetKey === assetKey;
        assetRow.setAttribute('aria-selected', String(isSelected));
        assetRow.classList.toggle('selected', isSelected);
      }
      renderAssetDetails(asset);
      loadAssetPreview(asset, assetKey);
    };
    row.addEventListener('click', selectAsset);
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      selectAsset();
    });
    const usedBy = [...(usage.get(asset.id) || [])].sort().join('、');
    addCell(row, asset.id || '—');
    addCell(row, asset.filename, asset.filename);
    addCell(row, displayType(getAssetTypeCategory(asset)));
    addCell(row, asset.width && asset.height ? `${asset.width}×${asset.height}` : '—');
    addCell(row, displayOrientation(asset.orientation));
    addCell(row, asset.type === 'image' ? '—' : formatDuration(asset.durationSec));
    addCell(row, formatBytes(asset.sizeBytes));
    addCell(row, usedBy || '—');
    elements.assetsTableBody.appendChild(row);
  }
}

function statusLabel(status) {
  return {
    unmatched: '已导入方案，未匹配配音',
    matched: '已匹配配音',
    conflict: '配音文件冲突',
    read_failed: '配音读取失败',
  }[status] || '已导入方案，未匹配配音';
}

function appendField(container, label, value, full = false) {
  const field = document.createElement('div');
  field.className = `segment-field${full ? ' full' : ''}`;
  field.append(
    createTextElement('dt', label),
    createTextElement('dd', value || '—'),
  );
  container.appendChild(field);
}

function renderVoiceIssues(payload) {
  const lines = [];
  if (payload?.unmatchedVoiceFiles?.length) {
    lines.push(`未匹配配音：${payload.unmatchedVoiceFiles.join('、')}`);
  }
  if (payload?.voiceConflicts?.length) {
    for (const conflict of payload.voiceConflicts) {
      lines.push(`第 ${conflict.segmentId} 段配音冲突：${conflict.files.join('、')}。请修改文件名后重新扫描。`);
    }
  }
  elements.voiceIssues.textContent = lines.join('\n');
  elements.voiceIssues.classList.toggle('hidden', lines.length === 0);
}

function getAssignment(segmentId) {
  return state.assignmentsPayload?.segments?.find(
    (assignment) => assignment.segmentId === segmentId,
  ) || { segmentId, items: [] };
}

function getRoughcutStatus(segmentId) {
  return state.roughcutStatusPayload?.segments?.find(
    (entry) => entry.segmentId === segmentId,
  ) || {
    segmentId,
    status: 'pending',
    outputFile: null,
    durationSec: null,
    generatedAt: null,
    error: null,
  };
}

function getAsset(assetId) {
  return state.assets.find((asset) => asset.id === assetId);
}

function getSegmentDuration(segment) {
  const duration = Number(segment?.timeline?.duration);
  return Number.isFinite(duration) ? duration : null;
}

function getAlignment(assignment) {
  const total = Number(assignment.timeline?.visualDuration) || 0;
  const voiceDuration = Number(assignment.timeline?.voiceDuration);
  if (!Number.isFinite(voiceDuration) || voiceDuration <= 0) {
    return {
      total,
      text: '未读取配音时长，暂不能判断对齐',
      className: '',
    };
  }
  const difference = Number((voiceDuration - total).toFixed(2));
  if (Math.abs(difference) <= 0.05) {
    return { total, text: '已对齐', className: 'aligned' };
  }
  if (difference > 0) {
    return { total, text: `还差 ${difference.toFixed(2)} 秒`, className: 'short' };
  }
  return { total, text: `超出 ${Math.abs(difference).toFixed(2)} 秒`, className: 'over' };
}

function createSelect(options, value) {
  const select = document.createElement('select');
  for (const [optionValue, label] of Object.entries(options)) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    option.selected = optionValue === value;
    select.appendChild(option);
  }
  return select;
}

async function persistAssignments() {
  state.assignmentsPayload = await window.plannerApi.saveAssignments({
    projectPath: state.project.projectPath,
    segments: state.assignmentsPayload.segments,
  });
  renderSegments();
  renderAssets();
}

function createItemControl(label, control) {
  const wrapper = document.createElement('div');
  wrapper.className = 'item-control';
  wrapper.append(createTextElement('label', label), control);
  return wrapper;
}

function renderAssignmentItem(segment, assignment, item, index) {
  const asset = getAsset(item.assetId);
  const row = document.createElement('div');
  row.className = 'assignment-item';

  const identity = document.createElement('div');
  identity.className = 'item-identity';
  identity.append(
    createTextElement('strong', `${item.assetId} · ${displayType(item.type || asset?.type)}`),
    createTextElement('span', item.filename),
    createTextElement(
      'span',
      `原始时长：${Number.isFinite(item.originalDurationSec) ? formatSeconds(item.originalDurationSec) : '—'}`,
    ),
  );

  const durationInput = document.createElement('input');
  durationInput.type = 'number';
  durationInput.min = '0.1';
  durationInput.step = '0.1';
  durationInput.value = Number(item.durationSec).toFixed(2);
  durationInput.className = 'duration-input';
  durationInput.addEventListener('change', async () => {
    const value = Number(durationInput.value);
    if (!Number.isFinite(value) || value < 0.1) {
      showToast('素材使用时长不能小于 0.1 秒。', true);
      durationInput.value = Number(item.durationSec).toFixed(2);
      return;
    }
    item.durationSec = value;
    try {
      await persistAssignments();
    } catch (error) {
      showToast(getUserErrorMessage(error), true);
    }
  });

  const fitSelect = createSelect(FIT_LABELS, item.fitMode);
  fitSelect.addEventListener('change', async () => {
    item.fitMode = fitSelect.value;
    try {
      await persistAssignments();
    } catch (error) {
      showToast(getUserErrorMessage(error), true);
    }
  });

  const audioSelect = createSelect(AUDIO_LABELS, item.audioMode);
  audioSelect.disabled = (item.type || asset?.type) === 'image';
  audioSelect.addEventListener('change', async () => {
    item.audioMode = audioSelect.value;
    try {
      await persistAssignments();
    } catch (error) {
      showToast(getUserErrorMessage(error), true);
    }
  });

  const actions = document.createElement('div');
  actions.className = 'item-actions';
  const up = createTextElement('button', '上移', 'button mini-button');
  up.disabled = index === 0;
  up.addEventListener('click', async () => {
    [assignment.items[index - 1], assignment.items[index]] =
      [assignment.items[index], assignment.items[index - 1]];
    await persistAssignments().catch((error) => showToast(getUserErrorMessage(error), true));
  });
  const down = createTextElement('button', '下移', 'button mini-button');
  down.disabled = index === assignment.items.length - 1;
  down.addEventListener('click', async () => {
    [assignment.items[index], assignment.items[index + 1]] =
      [assignment.items[index + 1], assignment.items[index]];
    await persistAssignments().catch((error) => showToast(getUserErrorMessage(error), true));
  });
  const remove = createTextElement('button', '删除', 'button mini-button danger-button');
  remove.addEventListener('click', async () => {
    assignment.items.splice(index, 1);
    await persistAssignments().catch((error) => showToast(getUserErrorMessage(error), true));
  });
  actions.append(up, down, remove);

  row.append(
    identity,
    createItemControl('本段使用时长（秒）', durationInput),
    createItemControl('显示方式', fitSelect),
    createItemControl('原声处理', audioSelect),
    actions,
  );

  if (
    (item.type || asset?.type) === 'video'
    && Number.isFinite(item.originalDurationSec)
    && item.durationSec > item.originalDurationSec
  ) {
    row.append(
      createTextElement(
        'div',
        '超过原视频时长，后续粗剪会循环/静帧补齐。',
        'item-warning',
      ),
    );
  }
  return row;
}

function renderAssignmentPanel(segment) {
  const assignment = getAssignment(segment.id);
  const panel = document.createElement('section');
  panel.className = 'assignment-panel';

  const heading = document.createElement('div');
  heading.className = 'assignment-heading';
  heading.append(createTextElement('h4', '素材编排'));
  const autoFit = createTextElement('button', '自动补齐到配音时长', 'button secondary');
  autoFit.disabled = !(Number(segment.timeline?.voiceDuration) > 0)
    || assignment.items.length === 0;
  autoFit.addEventListener('click', () =>
    withBusy(autoFit, async () => {
      state.assignmentsPayload = await window.plannerApi.autoFitSegment({
        projectPath: state.project.projectPath,
        segmentId: segment.id,
      });
      renderSegments();
      renderAssets();
      showToast(`第 ${segment.id} 段已按配音时长自动调整。`);
    }));
  heading.append(autoFit);

  const picker = document.createElement('div');
  picker.className = 'asset-picker';
  const assetSelect = document.createElement('select');
  const usage = getUsageMap();
  if (!state.assets.length) {
    const option = document.createElement('option');
    option.textContent = '请先扫描精选素材';
    option.value = '';
    assetSelect.appendChild(option);
  } else {
    for (const asset of state.assets) {
      const option = document.createElement('option');
      const usedBy = [...(usage.get(asset.id) || [])].sort();
      option.value = asset.id;
      option.textContent = `${asset.id}-${asset.filename.replace(/^A\d{3}[-_\s.]?/i, '')}`
        + (usedBy.length ? `（已用于：${usedBy.join('、')}）` : '');
      assetSelect.appendChild(option);
    }
  }
  const addButton = createTextElement('button', '添加到本段', 'button primary');
  addButton.disabled = !state.assets.length;
  addButton.addEventListener('click', () =>
    withBusy(addButton, async () => {
      state.assignmentsPayload = await window.plannerApi.addAssetToSegment({
        projectPath: state.project.projectPath,
        segmentId: segment.id,
        assetId: assetSelect.value,
      });
      renderSegments();
      renderAssets();
      showToast(`${assetSelect.value} 已添加到第 ${segment.id} 段。`);
    }));
  picker.append(assetSelect, addButton);

  const items = document.createElement('div');
  items.className = 'assignment-items';
  if (!assignment.items.length) {
    items.append(createTextElement('div', '本段还没有添加素材。', 'assignment-empty'));
  } else {
    assignment.items.forEach((item, index) => {
      items.append(renderAssignmentItem(segment, assignment, item, index));
    });
  }
  panel.append(heading, picker, items);
  return panel;
}

function roughcutStatusLabel(status) {
  return {
    pending: '待生成',
    success: '生成成功',
    skipped: '已跳过',
    failed: '生成失败',
  }[status] || '待生成';
}

function finalStatusLabel(status) {
  return {
    pending: '待生成',
    success: '已生成',
    failed: '生成失败',
  }[status] || '待生成';
}

function subtitleStatusLabel(status) {
  return {
    pending: '待处理',
    success: '成功',
    failed: '失败',
  }[status] || '待处理';
}

function fullPath(relativePath) {
  if (!state.project || !relativePath) return '';
  return `${state.project.projectPath}/${relativePath}`;
}

function renderRoughcutPanel(segment) {
  const status = getRoughcutStatus(segment.id);
  const panel = document.createElement('section');
  panel.className = 'roughcut-panel';

  const info = document.createElement('div');
  info.className = 'roughcut-info';
  const statusBadge = createTextElement(
    'strong',
    roughcutStatusLabel(status.status),
    `roughcut-status roughcut-${status.status || 'pending'}`,
  );
  info.append(statusBadge);
  if (status.status === 'failed' && status.error) {
    info.append(createTextElement('span', status.error));
    if (status.oldFilePreserved && status.outputFile) {
      info.append(createTextElement('span', `旧粗剪仍可用：${status.outputFile}`));
    }
  } else if (status.outputFile) {
    info.append(createTextElement(
      'span',
      `${status.outputFile} · ${formatSeconds(getSegmentDuration(segment))}`,
    ));
  } else if (status.error) {
    info.append(createTextElement('span', status.error));
  } else {
    info.append(createTextElement('span', '尚未生成分段粗剪。'));
  }

  const actions = document.createElement('div');
  actions.className = 'roughcut-actions';
  const generateButton = createTextElement(
    'button',
    status.status === 'failed' ? '重新生成本段粗剪' : '生成本段粗剪',
    'button primary',
  );
  generateButton.addEventListener('click', () =>
    withBusy(generateButton, async () => {
      try {
        const result = await window.plannerApi.generateRoughcut({
          projectPath: state.project.projectPath,
          segmentId: segment.id,
        });
        state.roughcutStatusPayload = result.statusPayload;
        renderSegments();
        showToast(`第 ${segment.id} 段粗剪生成成功：${result.entry.outputFile}`);
      } catch (error) {
        state.roughcutStatusPayload = await window.plannerApi.loadRoughcutStatus(
          state.project.projectPath,
        );
        renderSegments();
        throw error;
      }
    }));
  actions.append(generateButton);

  if (status.outputFile) {
    const showButton = createTextElement('button', '在 Finder 中显示', 'button secondary');
    showButton.addEventListener('click', () =>
      window.plannerApi.showRoughcutOutput({
        projectPath: state.project.projectPath,
        relativePath: status.outputFile,
      }));
    actions.append(showButton);
  }
  panel.append(info, actions);
  return panel;
}

function renderSegments() {
  const payload = state.segmentsPayload;
  const segments = payload?.segments || [];
  elements.segmentsList.replaceChildren();
  elements.emptySegments.classList.toggle('hidden', segments.length > 0);
  elements.syncPackagesButton.disabled = segments.length === 0 || state.missingDirs.length > 0;
  elements.generateAllRoughcutsButton.disabled =
    segments.length === 0 || state.missingDirs.length > 0;

  if (segments.length === 0) {
    elements.segmentSummary.textContent = '尚未导入方案';
    elements.planImportSummary.textContent = '状态：未导入方案';
    renderVoiceIssues(null);
    return;
  }

  const matchedCount = segments.filter((segment) => segment.voiceStatus === 'matched').length;
  elements.segmentSummary.textContent = `共 ${segments.length} 段，已匹配配音 ${matchedCount} 段`;

  for (const segment of segments) {
    const assignment = getAssignment(segment.id);
    const alignment = getAlignment(assignment);
    const card = document.createElement('article');
    card.className = 'segment-card';

    const topLine = document.createElement('div');
    topLine.className = 'segment-topline';
    const title = document.createElement('div');
    title.className = 'segment-title';
    title.append(
      createTextElement('span', segment.id, 'segment-id'),
      createTextElement('h3', segment.title),
    );
    const badge = createTextElement('span', statusLabel(segment.voiceStatus), 'status-badge');
    badge.classList.add(`status-${segment.voiceStatus || 'unmatched'}`);
    topLine.append(title, badge);

    const fields = document.createElement('dl');
    fields.className = 'segment-fields';
    appendField(fields, '口播文案', segment.voiceoverText, true);
    appendField(fields, '建议素材', segment.suggestedAssetsText, true);
    appendField(
      fields,
      '配音文件',
      segment.voiceStatus === 'conflict'
        ? segment.voiceCandidates.join('、')
        : segment.voiceFile,
    );
    appendField(fields, '时间轴时长', formatSeconds(getSegmentDuration(segment)));
    if (segment.voiceError) appendField(fields, '读取提示', segment.voiceError, true);

    const durationOverview = document.createElement('div');
    durationOverview.className = 'duration-overview';
    durationOverview.append(
      createTextElement(
        'span',
        `时间轴时长：${formatSeconds(getSegmentDuration(segment))}`,
        'duration-chip',
      ),
      createTextElement('span', `素材总时长：${alignment.total.toFixed(2)} 秒`, 'duration-chip'),
      createTextElement('span', alignment.text, `duration-chip ${alignment.className}`.trim()),
    );

    card.append(
      topLine,
      fields,
      durationOverview,
      renderAssignmentPanel(segment),
      renderRoughcutPanel(segment),
    );
    elements.segmentsList.appendChild(card);
  }
  renderVoiceIssues(payload);
}

function renderFinalRoughcut() {
  const status = state.finalRoughcutStatus || { status: 'pending' };
  const segments = state.segmentsPayload?.segments || [];
  elements.generateFinalRoughcutButton.disabled =
    state.missingDirs.length > 0 || segments.length === 0;
  elements.generateFcpChecklistButton.disabled =
    state.missingDirs.length > 0 || segments.length === 0;
  elements.finalRoughcutStatusText.textContent = finalStatusLabel(status.status);
  elements.finalRoughcutOutputPath.textContent = status.outputFile || '—';
  elements.finalRoughcutDuration.textContent = formatSeconds(getSegmentDuration(status));
  elements.finalRoughcutSegmentCount.textContent = Number.isFinite(status.segmentCount)
    ? `${status.segmentCount} 段`
    : '—';
  elements.finalRoughcutGeneratedAt.textContent = status.generatedAt || '—';
  elements.showFinalRoughcutButton.disabled = !(status.status === 'success' && status.outputFile);

  if (status.status === 'success') {
    elements.finalRoughcutSummary.textContent =
      `总粗剪已生成：${status.outputFile}`;
    elements.finalRoughcutSummary.classList.remove('hidden');
  } else if (status.status === 'failed' && status.error) {
    elements.finalRoughcutSummary.textContent = status.error;
    elements.finalRoughcutSummary.classList.remove('hidden');
  }
}

async function loadStage5State() {
  state.finalRoughcutStatus = await window.plannerApi.loadFinalRoughcutStatus(
    state.project.projectPath,
  );
  renderFinalRoughcut();
  await loadStage6State();
}

function renderSubtitle() {
  const subtitle = state.subtitle || {};
  const config = subtitle.config || { command: 'ww', lastVideo: '' };
  const status = subtitle.status || { status: 'pending' };
  const files = subtitle.files || {};
  elements.subtitleCommandInput.value = config.command || 'ww';
  elements.subtitleVideoPath.textContent = config.lastVideo || status.inputVideo || '—';
  elements.rawSrtStatus.textContent = files.rawSrtExists ? '已存在' : '未发现';
  elements.finalSrtStatus.textContent = files.finalSrtExists ? '已生成' : '未生成';
  elements.subtitleStatusText.textContent = subtitleStatusLabel(status.status);
  elements.subtitleRawCount.textContent = Number.isFinite(status.rawCount)
    ? `${status.rawCount} 条`
    : '—';
  elements.subtitleFinalCount.textContent = Number.isFinite(status.finalCount)
    ? `${status.finalCount} 条`
    : '—';
  elements.subtitleSplitCount.textContent = Number.isFinite(status.splitCount)
    ? `${status.splitCount} 条`
    : '—';

  if (status.status === 'success' && status.finalSrt) {
    elements.subtitleSummary.textContent = `字幕已整理：${status.finalSrt}`;
    elements.subtitleSummary.classList.remove('hidden');
  } else if (status.status === 'failed' && status.error) {
    elements.subtitleSummary.textContent = status.error;
    elements.subtitleSummary.classList.remove('hidden');
  }
}

async function loadStage6State() {
  state.subtitle = await window.plannerApi.loadSubtitleState(state.project.projectPath);
  renderSubtitle();
}

async function loadStage3State() {
  const result = await window.plannerApi.loadStage3State(state.project.projectPath);
  state.assets = result.assets || [];
  state.assignmentsPayload = result.assignmentsPayload;
  state.roughcutStatusPayload = await window.plannerApi.loadRoughcutStatus(
    state.project.projectPath,
  );
  renderSegments();
  renderAssets();
  await loadStage5State();
}

async function loadStage2State() {
  const result = await window.plannerApi.loadStage2State(state.project.projectPath);
  elements.videoPlanText.value = result.planText || '';
  state.segmentsPayload = result.segmentsPayload;
  if (result.segmentsPayload?.segments?.length) {
    elements.planImportSummary.textContent =
      `已加载已保存方案，共 ${result.segmentsPayload.segments.length} 段`;
  }
  await loadStage3State();
}

async function loadAssetsState() {
  const projectPath = state.project.projectPath;
  const [assetsResult, aiAnalysis] = await Promise.all([
    window.plannerApi.loadAssetIndex(projectPath),
    window.plannerApi.loadAiAnalysis(projectPath),
  ]);
  state.assets = assetsResult.assets || [];
  state.aiAnalysis = aiAnalysis || { schemaVersion: 1, updatedAt: null, analyses: {} };
  renderAssets();
}

async function activateProject(result, message) {
  state.project = result.project;
  state.missingDirs = result.missingDirs;
  resetProjectViews();
  renderProject();
  if (state.missingDirs.length === 0) await loadAssetsState();
  await loadRecentProjects();
  showToast(message);
}

async function loadRecentProjects() {
  const payload = await window.plannerApi.loadRecentProjects();
  state.recentProjects = payload.projects || [];
  renderRecentProjects();
}

async function loadAiSettingsState() {
  state.aiSettings = await window.plannerApi.loadAiSettings();
  elements.mlxPythonPathInput.value = state.aiSettings.mlxPythonPath || '';
}

function handleAiBatchProgress(progress) {
  if (
    !state.aiBatchRunning
    || progress?.projectPath !== state.project?.projectPath
    || progress?.mode !== state.aiBatchMode
  ) return;

  state.aiBatchProgress = progress;
  renderAiBatchControls();
  if (progress.phase !== 'completed') return;

  const projectPath = progress.projectPath;
  window.plannerApi.loadAiAnalysis(projectPath).then((aiAnalysis) => {
    if (state.project?.projectPath !== projectPath) return;
    state.aiAnalysis = aiAnalysis;
    renderAssetAiAnalysis(getSelectedAsset());
  }).catch(() => {});
}

async function runAiBatchAnalysis(mode) {
  const projectPath = state.project?.projectPath;
  if (!projectPath || state.aiBatchRunning || state.aiAnalysisRunningStableId) return;
  if (!confirmAction('将逐个分析支持的文本/图片素材，视频和音频会跳过。继续吗？')) return;

  state.aiBatchRunning = true;
  state.aiBatchMode = mode;
  state.aiBatchProgress = null;
  state.aiBatchSummary = '';
  renderAssetAiAnalysis(getSelectedAsset());

  try {
    const result = await window.plannerApi.analyzeBatchAssets({ projectPath, mode });
    if (state.project?.projectPath !== projectPath) return;
    state.aiAnalysis = await window.plannerApi.loadAiAnalysis(projectPath);
    state.aiBatchSummary =
      '批量分析完成：成功 ' + result.success
      + '，失败 ' + result.failed + '，跳过 ' + result.skipped;
    showToast(state.aiBatchSummary, result.failed > 0);
  } catch (error) {
    if (state.project?.projectPath === projectPath) {
      state.aiAnalysis = await window.plannerApi.loadAiAnalysis(projectPath).catch(
        () => state.aiAnalysis,
      );
      state.aiBatchSummary = '批量分析失败：' + getUserErrorMessage(error);
      showToast(state.aiBatchSummary, true);
    }
  } finally {
    if (state.project?.projectPath === projectPath) {
      state.aiBatchRunning = false;
      state.aiBatchMode = null;
      state.aiBatchProgress = null;
      renderAssetAiAnalysis(getSelectedAsset());
    }
  }
}

async function init() {
  assetViewModel = await loadAssetViewModel();
  window.plannerApi.onBatchAnalysisProgress(handleAiBatchProgress);
  const config = await window.plannerApi.getConfig();
  elements.version.textContent = config.version;
  elements.projectRoot.value = config.defaultProjectRoot;
  await Promise.all([loadRecentProjects(), loadAiSettingsState()]);
  try {
    await loadProjectCatalog();
  } catch (error) {
    elements.catalogSummary.textContent = '项目库扫描失败。';
    elements.catalogError.textContent = getUserErrorMessage(error);
    elements.catalogError.classList.remove('hidden');
  }
}

elements.showResultsCenterButton.addEventListener('click', () => switchMainView('results'));
elements.showWorkspaceButton.addEventListener('click', () => switchMainView('workspace'));
elements.refreshCatalogButton.addEventListener('click', () =>
  withBusy(elements.refreshCatalogButton, async () => {
    await loadProjectCatalog();
    showToast('项目库已只读刷新。');
  }, '正在刷新…'));

elements.assetSearchInput.addEventListener('input', () => {
  state.assetSearchQuery = elements.assetSearchInput.value.trim().toLowerCase();
  renderAssets();
});

elements.assetTypeFilter.addEventListener('change', () => {
  state.assetTypeFilter = elements.assetTypeFilter.value;
  renderAssets();
});

elements.assetReviewFilter.addEventListener('change', () => {
  state.assetReviewFilter = elements.assetReviewFilter.value;
  renderAssets();
});

elements.assetReviewStatus.addEventListener('change', () => {
  saveSelectedAssetReview(
    { reviewStatus: elements.assetReviewStatus.value },
    '审核状态已保存。',
  );
});

elements.assetReviewRating.addEventListener('change', () => {
  saveSelectedAssetReview(
    { rating: Number(elements.assetReviewRating.value) },
    '评分已保存。',
  );
});

elements.assetReviewTags.addEventListener('blur', () => {
  saveSelectedAssetReview(
    { tags: parseAssetReviewTags(elements.assetReviewTags.value) },
    '标签已保存。',
  );
});

elements.assetReviewTags.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  elements.assetReviewTags.blur();
});

elements.assetReviewForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveSelectedAssetReview(
    { note: elements.assetReviewNote.value },
    '备注已保存。',
  );
});

elements.selectRootButton.addEventListener('click', async () => {
  const selectedPath = await window.plannerApi.selectRoot();
  if (selectedPath) elements.projectRoot.value = selectedPath;
});

elements.createProjectButton.addEventListener('click', () =>
  withBusy(elements.createProjectButton, async () => {
    const result = await window.plannerApi.createProject({
      projectName: elements.projectName.value,
      rootPath: elements.projectRoot.value,
    });
    await activateProject(result, `项目已创建：${result.project.projectPath}`);
  }));

elements.openProjectButton.addEventListener('click', () =>
  withBusy(elements.openProjectButton, async () => {
    const result = await window.plannerApi.chooseAndOpenProject();
    if (!result) return;
    await activateProject(result, `已打开项目：${result.project.projectName}`);
  }));

elements.ensureDirsButton.addEventListener('click', () =>
  withBusy(elements.ensureDirsButton, async () => {
    const result = await window.plannerApi.ensureProjectDirs(state.project.projectPath);
    state.project = result.project;
    state.missingDirs = result.missingDirs;
    renderProject();
    await loadAssetsState();
    showToast('项目目录已补齐。');
  }));

elements.scanButton.addEventListener('click', () =>
  withBusy(elements.scanButton, async () => {
    if (!confirmAction('扫描不会重命名、移动、复制或删除源素材，只会更新项目索引 assets.json。确认继续吗？')) return;
    const result = await window.plannerApi.scanAssets(state.project.projectPath);
    state.assets = result.assets;
    elements.ffprobeWarning.textContent = result.warning || '';
    elements.ffprobeWarning.classList.toggle('hidden', !result.warning);
    renderAssets();
    showToast(`扫描完成，共 ${result.assets.length} 个素材。\n已保存：${result.outputPath}`);
  }));

elements.briefButton.addEventListener('click', () =>
  withBusy(elements.briefButton, async () => {
    await window.plannerApi.generateAiMaterialReport(state.project.projectPath);
    showToast('已生成素材报告：00-项目总控/ai素材报告.md');
  }));

elements.editSuggestionButton.addEventListener('click', () => {
  if (!confirmAction('将读取 ai素材报告.md 并调用本地 Qwen 生成剪辑建议，可能耗时并使 Mac 发热。继续吗？')) return;
  withBusy(elements.editSuggestionButton, async () => {
    await window.plannerApi.generateEditSuggestion(state.project.projectPath);
    showToast('已生成剪辑建议：00-项目总控/剪辑建议.md');
  }, '正在生成剪辑建议...');
});

elements.importPlanButton.addEventListener('click', () =>
  withBusy(elements.importPlanButton, async () => {
    const hasImportedSegments = (state.segmentsPayload?.segments || []).length > 0;
    if (hasImportedSegments && !confirmAction('重新导入方案会覆盖 video-plan.md 和 segments.json。确认继续吗？')) return;
    const result = await window.plannerApi.importVideoPlan({
      projectPath: state.project.projectPath,
      planText: elements.videoPlanText.value,
    });
    state.segmentsPayload = result;
    const summary = `已导入，字数 ${result.charCount}，已解析分段 ${result.segments.length} 段。`;
    elements.planImportSummary.textContent = summary;
    setWarning(result.warning);
    await loadStage3State();
    showToast(summary);
  }));

elements.scanVoiceButton.addEventListener('click', () =>
  withBusy(elements.scanVoiceButton, async () => {
    const result = await window.plannerApi.scanVoiceFiles(state.project.projectPath);
    state.segmentsPayload = result;
    setWarning(result.warning);
    renderSegments();
    showToast(
      `配音扫描完成：已匹配 ${result.matchedCount} 段，`
      + `冲突 ${result.voiceConflicts.length} 段，未匹配文件 ${result.unmatchedVoiceFiles.length} 个。`,
    );
  }));

elements.syncPackagesButton.addEventListener('click', () =>
  withBusy(elements.syncPackagesButton, async () => {
    if (!confirmAction('同步分段素材包会清理旧分段文件夹内容并重新复制素材。确认继续吗？')) return;
    const result = await window.plannerApi.syncSegmentPackages(state.project.projectPath);
    showToast(
      `同步完成：同步 ${result.segmentCount} 段，复制 ${result.copiedAssetCount} 个素材。`,
    );
  }));

elements.generateAllRoughcutsButton.addEventListener('click', () =>
  withBusy(elements.generateAllRoughcutsButton, async () => {
    const result = await window.plannerApi.generateAllRoughcuts(state.project.projectPath);
    state.roughcutStatusPayload = result.statusPayload;
    renderSegments();
    await loadStage5State();
    const summary = `本次生成结果：成功 ${result.successCount} 段，`
      + `跳过 ${result.skippedCount} 段，失败 ${result.failedCount} 段，`
      + `保留旧粗剪 ${result.preservedCount || 0} 段。`;
    elements.roughcutBatchSummary.textContent = summary;
    elements.roughcutBatchSummary.classList.remove('hidden');
    showToast(summary, result.failedCount > 0);
  }));

elements.generateFinalRoughcutButton.addEventListener('click', () =>
  withBusy(elements.generateFinalRoughcutButton, async () => {
    if (
      state.finalRoughcutStatus?.outputFile
      && !confirmAction('已存在总粗剪 full-roughcut.mp4，本次生成会覆盖旧文件。确认继续吗？')
    ) {
      return;
    }
    try {
      const result = await window.plannerApi.generateFinalRoughcut(state.project.projectPath);
      state.finalRoughcutStatus = result.status;
      renderFinalRoughcut();
      const summary = `${result.message} ${result.status.outputFile}`;
      elements.finalRoughcutSummary.textContent = summary;
      elements.finalRoughcutSummary.classList.remove('hidden');
      showToast(summary);
    } catch (error) {
      state.finalRoughcutStatus = await window.plannerApi.loadFinalRoughcutStatus(
        state.project.projectPath,
      );
      renderFinalRoughcut();
      throw error;
    }
  }));

elements.generateFcpChecklistButton.addEventListener('click', () =>
  withBusy(elements.generateFcpChecklistButton, async () => {
    const result = await window.plannerApi.generateFcpHandoff(state.project.projectPath);
    elements.fcpChecklistSummary.textContent =
      `FCP 交接清单已生成：${result.outputPath}，共 ${result.segmentCount} 段。`;
    elements.fcpChecklistSummary.classList.remove('hidden');
    showToast(`FCP 交接清单已生成：${result.outputPath}`);
  }));

elements.showFinalRoughcutButton.addEventListener('click', () => {
  if (state.finalRoughcutStatus?.outputFile) {
    window.plannerApi.showItemInFolder({
      projectPath: state.project.projectPath,
      relativePath: state.finalRoughcutStatus.outputFile,
    });
  }
});

elements.openControlDirButton.addEventListener('click', () => {
  if (state.project) window.plannerApi.openFolder({
    projectPath: state.project.projectPath,
    relativePath: '00-项目总控',
  });
});

elements.openCurrentControlDirButton.addEventListener('click', () => {
  if (state.project) window.plannerApi.openFolder({
    projectPath: state.project.projectPath,
    relativePath: '00-项目总控',
  });
});

elements.openRoughcutDirButton.addEventListener('click', () => {
  if (state.project) window.plannerApi.openFolder({
    projectPath: state.project.projectPath,
    relativePath: '04-分段粗剪',
  });
});

elements.openFinalRoughcutDirButton.addEventListener('click', () => {
  if (state.project) window.plannerApi.openFolder({
    projectPath: state.project.projectPath,
    relativePath: '05-总粗剪',
  });
});

elements.chooseSubtitleVideoButton.addEventListener('click', () =>
  withBusy(elements.chooseSubtitleVideoButton, async () => {
    const videoPath = await window.plannerApi.chooseSubtitleVideo(state.project.projectPath);
    if (!videoPath) return;
    const config = await window.plannerApi.saveSubtitleConfig({
      projectPath: state.project.projectPath,
      config: {
        command: elements.subtitleCommandInput.value,
        lastVideo: videoPath,
      },
    });
    state.subtitle = {
      ...(state.subtitle || {}),
      config,
    };
    renderSubtitle();
    showToast(`已选择最终视频：${videoPath}`);
  }));

elements.generateSubtitleButton.addEventListener('click', () =>
  withBusy(elements.generateSubtitleButton, async () => {
    const videoPath = state.subtitle?.config?.lastVideo || state.subtitle?.status?.inputVideo;
    if (!videoPath) throw new Error('请先选择 FCP 导出的最终整片视频。');
    try {
      const result = await window.plannerApi.generateSubtitlesFromVideo({
        projectPath: state.project.projectPath,
        inputVideo: videoPath,
        command: elements.subtitleCommandInput.value,
      });
      state.subtitle = await window.plannerApi.loadSubtitleState(state.project.projectPath);
      renderSubtitle();
      showToast(
        `整片字幕已生成并整理：${result.outputFiles.finalSrt}，`
        + `共 ${result.metrics.finalCount} 条。`,
      );
    } catch (error) {
      state.subtitle = await window.plannerApi.loadSubtitleState(state.project.projectPath);
      renderSubtitle();
      throw error;
    }
  }));

elements.organizeSrtButton.addEventListener('click', () =>
  withBusy(elements.organizeSrtButton, async () => {
    try {
      const result = await window.plannerApi.organizeExistingSrt(state.project.projectPath);
      state.subtitle = await window.plannerApi.loadSubtitleState(state.project.projectPath);
      renderSubtitle();
      showToast(
        `已有 SRT 已整理：${result.outputFiles.finalSrt}，`
        + `拆分长字幕 ${result.metrics.splitCount} 条。`,
      );
    } catch (error) {
      state.subtitle = await window.plannerApi.loadSubtitleState(state.project.projectPath);
      renderSubtitle();
      throw error;
    }
  }));

elements.openSubtitleDirButton.addEventListener('click', () => {
  if (state.project) window.plannerApi.openFolder({
    projectPath: state.project.projectPath,
    relativePath: '07-字幕',
  });
});

elements.detectEnvironmentButton.addEventListener('click', () =>
  withBusy(elements.detectEnvironmentButton, async () => {
    const subtitleCommand = elements.subtitleCommandInput?.value || 'ww';
    state.environment = await window.plannerApi.detectEnvironment(subtitleCommand);
    renderEnvironmentResult(state.environment);
    showToast('环境检测完成。');
  }));

elements.checkAiEnvironmentButton.addEventListener('click', () =>
  withBusy(elements.checkAiEnvironmentButton, async () => {
    state.aiEnvironment = await window.plannerApi.checkAiEnvironment();
    renderAiEnvironment(state.aiEnvironment);
    showToast(state.aiEnvironment.available ? 'AI 环境可用。' : 'AI 环境检测完成，但当前不可用。');
  }));

elements.analyzeUnanalyzedAssetsButton.addEventListener('click', () =>
  runAiBatchAnalysis('unanalyzed'));

elements.analyzeKeptAssetsButton.addEventListener('click', () =>
  runAiBatchAnalysis('kept'));

elements.analyzeCurrentTextAssetButton.addEventListener('click', async () => {
  const asset = getSelectedAsset();
  const availability = assetViewModel.getTextAnalysisAvailability(asset);
  if (!availability.allowed) {
    showToast(availability.reason, true);
    return;
  }
  const projectPath = state.project?.projectPath;
  const stableId = asset.stableId;
  if (!projectPath || state.aiAnalysisRunningStableId) return;

  state.aiAnalysisRunningStableId = stableId;
  renderAssetAiAnalysis(asset);
  try {
    const result = await window.plannerApi.analyzeCurrentTextAsset({
      projectPath,
      stableId,
    });
    if (state.project?.projectPath !== projectPath) return;
    state.aiAnalysis = await window.plannerApi.loadAiAnalysis(projectPath);
    renderAssetAiAnalysis(getSelectedAsset());
    showToast(result?.truncated
      ? '文本分析完成；超长输入已按头、中、尾截取。'
      : '文本分析完成。');
  } catch (error) {
    if (state.project?.projectPath === projectPath) {
      state.aiAnalysis = await window.plannerApi.loadAiAnalysis(projectPath).catch(
        () => state.aiAnalysis,
      );
      renderAssetAiAnalysis(getSelectedAsset());
      showToast(`文本分析失败：${getUserErrorMessage(error)}`, true);
    }
  } finally {
    if (state.project?.projectPath === projectPath) {
      state.aiAnalysisRunningStableId = null;
      renderAssetAiAnalysis(getSelectedAsset());
    }
  }
});

elements.analyzeCurrentImageAssetButton.addEventListener('click', async () => {
  const asset = getSelectedAsset();
  const availability = assetViewModel.getImageAnalysisAvailability(asset);
  if (!availability.allowed) {
    showToast(availability.reason, true);
    return;
  }
  const projectPath = state.project?.projectPath;
  const stableId = asset.stableId;
  if (!projectPath || state.aiAnalysisRunningStableId) return;

  state.aiAnalysisRunningStableId = stableId;
  renderAssetAiAnalysis(asset);
  try {
    await window.plannerApi.analyzeCurrentImageAsset({ projectPath, stableId });
    if (state.project?.projectPath !== projectPath) return;
    state.aiAnalysis = await window.plannerApi.loadAiAnalysis(projectPath);
    renderAssetAiAnalysis(getSelectedAsset());
    showToast('图片分析完成。');
  } catch (error) {
    if (state.project?.projectPath === projectPath) {
      state.aiAnalysis = await window.plannerApi.loadAiAnalysis(projectPath).catch(
        () => state.aiAnalysis,
      );
      renderAssetAiAnalysis(getSelectedAsset());
      showToast(`图片分析失败：${getUserErrorMessage(error)}`, true);
    }
  } finally {
    if (state.project?.projectPath === projectPath) {
      state.aiAnalysisRunningStableId = null;
      renderAssetAiAnalysis(getSelectedAsset());
    }
  }
});

elements.saveMlxPythonPathButton.addEventListener('click', () =>
  withBusy(elements.saveMlxPythonPathButton, async () => {
    state.aiSettings = await window.plannerApi.saveAiSettings({
      mlxPythonPath: elements.mlxPythonPathInput.value,
    });
    elements.mlxPythonPathInput.value = state.aiSettings.mlxPythonPath || '';
    state.aiEnvironment = null;
    renderAiEnvironment(null);
    showToast(state.aiSettings.mlxPythonPath ? 'MLX Python 路径已保存。' : 'MLX Python 路径已清除。');
  }));

init().catch((error) => showToast(getUserErrorMessage(error), true));
