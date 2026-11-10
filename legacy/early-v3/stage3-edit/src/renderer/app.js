const state = {
  project: null,
  missingDirs: [],
  assets: [],
  segmentsPayload: null,
  assignmentsPayload: null,
  toastTimer: null,
};

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
  projectName: document.querySelector('#projectName'),
  projectRoot: document.querySelector('#projectRoot'),
  selectRootButton: document.querySelector('#selectRootButton'),
  createProjectButton: document.querySelector('#createProjectButton'),
  openProjectButton: document.querySelector('#openProjectButton'),
  currentProjectCard: document.querySelector('#currentProjectCard'),
  currentProjectName: document.querySelector('#currentProjectName'),
  currentProjectPath: document.querySelector('#currentProjectPath'),
  missingDirsBox: document.querySelector('#missingDirsBox'),
  missingDirsText: document.querySelector('#missingDirsText'),
  ensureDirsButton: document.querySelector('#ensureDirsButton'),
  ffprobeWarning: document.querySelector('#ffprobeWarning'),
  scanButton: document.querySelector('#scanButton'),
  briefButton: document.querySelector('#briefButton'),
  assetsCard: document.querySelector('#assetsCard'),
  assetSummary: document.querySelector('#assetSummary'),
  assetsTableBody: document.querySelector('#assetsTableBody'),
  emptyAssets: document.querySelector('#emptyAssets'),
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
  toast: document.querySelector('#toast'),
};

function showToast(message, isError = false) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.classList.remove('hidden');
  state.toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), 5000);
}

async function withBusy(button, action) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
  try {
    return await action();
  } catch (error) {
    showToast(error.message || String(error), true);
    return null;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function setWarning(message) {
  elements.stage2Warning.textContent = message || '';
  elements.stage2Warning.classList.toggle('hidden', !message);
}

function resetProjectViews() {
  state.assets = [];
  state.segmentsPayload = null;
  state.assignmentsPayload = null;
  elements.assetsCard.classList.add('hidden');
  elements.ffprobeWarning.classList.add('hidden');
  elements.videoPlanText.value = '';
  elements.planImportSummary.textContent = '状态：未导入方案';
  elements.voiceIssues.classList.add('hidden');
  setWarning('');
}

function renderProject() {
  if (!state.project) {
    elements.currentProjectCard.classList.add('hidden');
    elements.videoPlanCard.classList.add('hidden');
    elements.segmentsCard.classList.add('hidden');
    return;
  }

  elements.currentProjectCard.classList.remove('hidden');
  elements.videoPlanCard.classList.remove('hidden');
  elements.segmentsCard.classList.remove('hidden');
  elements.currentProjectName.textContent = state.project.projectName;
  elements.currentProjectPath.textContent = state.project.projectPath;

  const hasMissingDirs = state.missingDirs.length > 0;
  elements.missingDirsBox.classList.toggle('hidden', !hasMissingDirs);
  elements.missingDirsText.textContent = hasMissingDirs
    ? `缺少：${state.missingDirs.join('、')}`
    : '';
  elements.scanButton.disabled = hasMissingDirs;
  elements.briefButton.disabled = hasMissingDirs;
  elements.importPlanButton.disabled = hasMissingDirs;
  elements.scanVoiceButton.disabled = hasMissingDirs;
  elements.syncPackagesButton.disabled = hasMissingDirs;
}

function displayType(type) {
  return {
    image: '图片',
    video: '视频',
    audio: '音频',
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

function renderAssets() {
  elements.assetsCard.classList.remove('hidden');
  elements.assetsTableBody.replaceChildren();
  elements.assetSummary.textContent = `共 ${state.assets.length} 个素材`;
  elements.emptyAssets.classList.toggle('hidden', state.assets.length > 0);
  const usage = getUsageMap();

  for (const asset of state.assets) {
    const row = document.createElement('tr');
    const usedBy = [...(usage.get(asset.id) || [])].sort().join('、');
    addCell(row, asset.id || '—');
    addCell(row, asset.filename, asset.filename);
    addCell(row, displayType(asset.type));
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

function getAsset(assetId) {
  return state.assets.find((asset) => asset.id === assetId);
}

function getTotalDuration(items) {
  return Number(items.reduce((sum, item) => sum + Number(item.durationSec || 0), 0).toFixed(2));
}

function getAlignment(segment, items) {
  const total = getTotalDuration(items);
  if (!Number.isFinite(segment.durationSec)) {
    return {
      total,
      text: '未读取配音时长，暂不能判断对齐',
      className: '',
    };
  }
  const difference = Number((segment.durationSec - total).toFixed(2));
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
      showToast(error.message || String(error), true);
    }
  });

  const fitSelect = createSelect(FIT_LABELS, item.fitMode);
  fitSelect.addEventListener('change', async () => {
    item.fitMode = fitSelect.value;
    try {
      await persistAssignments();
    } catch (error) {
      showToast(error.message || String(error), true);
    }
  });

  const audioSelect = createSelect(AUDIO_LABELS, item.audioMode);
  audioSelect.disabled = (item.type || asset?.type) === 'image';
  audioSelect.addEventListener('change', async () => {
    item.audioMode = audioSelect.value;
    try {
      await persistAssignments();
    } catch (error) {
      showToast(error.message || String(error), true);
    }
  });

  const actions = document.createElement('div');
  actions.className = 'item-actions';
  const up = createTextElement('button', '上移', 'button mini-button');
  up.disabled = index === 0;
  up.addEventListener('click', async () => {
    [assignment.items[index - 1], assignment.items[index]] =
      [assignment.items[index], assignment.items[index - 1]];
    await persistAssignments().catch((error) => showToast(error.message, true));
  });
  const down = createTextElement('button', '下移', 'button mini-button');
  down.disabled = index === assignment.items.length - 1;
  down.addEventListener('click', async () => {
    [assignment.items[index], assignment.items[index + 1]] =
      [assignment.items[index + 1], assignment.items[index]];
    await persistAssignments().catch((error) => showToast(error.message, true));
  });
  const remove = createTextElement('button', '删除', 'button mini-button danger-button');
  remove.addEventListener('click', async () => {
    assignment.items.splice(index, 1);
    await persistAssignments().catch((error) => showToast(error.message, true));
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
  autoFit.disabled = !Number.isFinite(segment.durationSec) || assignment.items.length === 0;
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

function renderSegments() {
  const payload = state.segmentsPayload;
  const segments = payload?.segments || [];
  elements.segmentsList.replaceChildren();
  elements.emptySegments.classList.toggle('hidden', segments.length > 0);
  elements.syncPackagesButton.disabled = segments.length === 0 || state.missingDirs.length > 0;

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
    const alignment = getAlignment(segment, assignment.items);
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
    appendField(fields, '配音时长', formatSeconds(segment.durationSec));
    if (segment.voiceError) appendField(fields, '读取提示', segment.voiceError, true);

    const durationOverview = document.createElement('div');
    durationOverview.className = 'duration-overview';
    durationOverview.append(
      createTextElement('span', `配音时长：${formatSeconds(segment.durationSec)}`, 'duration-chip'),
      createTextElement('span', `素材总时长：${alignment.total.toFixed(2)} 秒`, 'duration-chip'),
      createTextElement('span', alignment.text, `duration-chip ${alignment.className}`.trim()),
    );

    card.append(topLine, fields, durationOverview, renderAssignmentPanel(segment));
    elements.segmentsList.appendChild(card);
  }
  renderVoiceIssues(payload);
}

async function loadStage3State() {
  const result = await window.plannerApi.loadStage3State(state.project.projectPath);
  state.assets = result.assets || [];
  state.assignmentsPayload = result.assignmentsPayload;
  renderSegments();
  renderAssets();
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

async function activateProject(result, message) {
  state.project = result.project;
  state.missingDirs = result.missingDirs;
  resetProjectViews();
  renderProject();
  if (state.missingDirs.length === 0) await loadStage2State();
  showToast(message);
}

async function init() {
  const config = await window.plannerApi.getConfig();
  elements.version.textContent = config.version;
  elements.projectRoot.value = config.defaultProjectRoot;
}

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
    await loadStage2State();
    showToast('项目目录已补齐。');
  }));

elements.scanButton.addEventListener('click', () =>
  withBusy(elements.scanButton, async () => {
    const result = await window.plannerApi.scanAssets(state.project.projectPath);
    state.assets = result.assets;
    elements.ffprobeWarning.textContent = result.warning || '';
    elements.ffprobeWarning.classList.toggle('hidden', !result.warning);
    await loadStage3State();
    showToast(`扫描完成，共 ${result.assets.length} 个素材。\n已保存：${result.outputPath}`);
  }));

elements.briefButton.addEventListener('click', () =>
  withBusy(elements.briefButton, async () => {
    const result = await window.plannerApi.generateBrief(state.project.projectPath);
    showToast(`素材简报已生成：${result.outputPath}`);
  }));

elements.importPlanButton.addEventListener('click', () =>
  withBusy(elements.importPlanButton, async () => {
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
    const result = await window.plannerApi.syncSegmentPackages(state.project.projectPath);
    showToast(
      `同步完成：同步 ${result.segmentCount} 段，复制 ${result.copiedAssetCount} 个素材。`,
    );
  }));

init().catch((error) => showToast(error.message || String(error), true));
