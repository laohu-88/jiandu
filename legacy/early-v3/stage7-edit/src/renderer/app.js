const state = {
  project: null,
  missingDirs: [],
  assets: [],
  segmentsPayload: null,
  assignmentsPayload: null,
  roughcutStatusPayload: null,
  finalRoughcutStatus: null,
  subtitle: null,
  recentProjects: [],
  environment: null,
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
  openCurrentControlDirButton: document.querySelector('#openCurrentControlDirButton'),
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

async function withBusy(button, action) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
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
  state.segmentsPayload = null;
  state.assignmentsPayload = null;
  state.roughcutStatusPayload = null;
  state.finalRoughcutStatus = null;
  state.subtitle = null;
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
  elements.videoPlanCard.classList.remove('hidden');
  elements.segmentsCard.classList.remove('hidden');
  elements.finalRoughcutCard.classList.remove('hidden');
  elements.subtitleCard.classList.remove('hidden');
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
  elements.generateAllRoughcutsButton.disabled = hasMissingDirs;
  elements.generateFinalRoughcutButton.disabled = hasMissingDirs;
  elements.generateFcpChecklistButton.disabled = hasMissingDirs;
  elements.chooseSubtitleVideoButton.disabled = hasMissingDirs;
  elements.generateSubtitleButton.disabled = hasMissingDirs;
  elements.organizeSrtButton.disabled = hasMissingDirs;
  elements.openSubtitleDirButton.disabled = hasMissingDirs;
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
  if (status.outputFile) {
    info.append(createTextElement(
      'span',
      `${status.outputFile} · ${formatSeconds(status.durationSec)}`,
    ));
  } else if (status.error) {
    info.append(createTextElement('span', status.error));
  } else {
    info.append(createTextElement('span', '尚未生成分段粗剪。'));
  }

  const actions = document.createElement('div');
  actions.className = 'roughcut-actions';
  const generateButton = createTextElement('button', '生成本段粗剪', 'button primary');
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

  if (status.status === 'success' && status.outputFile) {
    const showButton = createTextElement('button', '在 Finder 中显示', 'button secondary');
    showButton.addEventListener('click', () =>
      window.plannerApi.showRoughcutOutput(
        `${state.project.projectPath}/${status.outputFile}`,
      ));
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
  elements.finalRoughcutDuration.textContent = formatSeconds(status.durationSec);
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

async function activateProject(result, message) {
  state.project = result.project;
  state.missingDirs = result.missingDirs;
  resetProjectViews();
  renderProject();
  if (state.missingDirs.length === 0) await loadStage2State();
  await loadRecentProjects();
  showToast(message);
}

async function loadRecentProjects() {
  const payload = await window.plannerApi.loadRecentProjects();
  state.recentProjects = payload.projects || [];
  renderRecentProjects();
}

async function init() {
  const config = await window.plannerApi.getConfig();
  elements.version.textContent = config.version;
  elements.projectRoot.value = config.defaultProjectRoot;
  await loadRecentProjects();
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
    if (!confirmAction('重新扫描会为未编号素材自动添加 A001/A002 前缀。确认继续吗？')) return;
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
      + `跳过 ${result.skippedCount} 段，失败 ${result.failedCount} 段。`;
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
    window.plannerApi.showItemInFolder(fullPath(state.finalRoughcutStatus.outputFile));
  }
});

elements.openControlDirButton.addEventListener('click', () => {
  if (state.project) window.plannerApi.openFolder(`${state.project.projectPath}/00-项目总控`);
});

elements.openCurrentControlDirButton.addEventListener('click', () => {
  if (state.project) window.plannerApi.openFolder(`${state.project.projectPath}/00-项目总控`);
});

elements.openRoughcutDirButton.addEventListener('click', () => {
  if (state.project) window.plannerApi.openFolder(`${state.project.projectPath}/04-分段粗剪`);
});

elements.openFinalRoughcutDirButton.addEventListener('click', () => {
  if (state.project) window.plannerApi.openFolder(`${state.project.projectPath}/05-总粗剪`);
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
  if (state.project) window.plannerApi.openFolder(`${state.project.projectPath}/07-字幕`);
});

elements.detectEnvironmentButton.addEventListener('click', () =>
  withBusy(elements.detectEnvironmentButton, async () => {
    const subtitleCommand = elements.subtitleCommandInput?.value || 'ww';
    state.environment = await window.plannerApi.detectEnvironment(subtitleCommand);
    renderEnvironmentResult(state.environment);
    showToast('环境检测完成。');
  }));

init().catch((error) => showToast(getUserErrorMessage(error), true));
