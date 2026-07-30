(function createResultPlayback(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerResultPlayback = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function createTextElement(tag, text, className = '') {
    return (root.PlannerDom || root.PlannerUtils).createTextElement(tag, text, className);
  }
  function createDefinitionGrid(entries, className = '') {
    return root.PlannerDom.createDefinitionGrid(entries, className);
  }
  function createResultSection(title, subtitle = '') {
    return root.PlannerDom.createResultSection(title, subtitle);
  }
  function displayProvided(value, suffix = '') {
    return root.PlannerDom.displayProvided(value, suffix);
  }
  function formatResultDuration(value) {
    return root.PlannerDom.formatResultDuration(value);
  }

function playbackTimecode(seconds, fps) {
  const rate = Math.max(1, Math.round(Number(fps) || 30));
  let frames = Math.max(0, Math.round((Number(seconds) || 0) * rate));
  const hours = Math.floor(frames / (rate * 3600));
  frames -= hours * rate * 3600;
  const minutes = Math.floor(frames / (rate * 60));
  frames -= minutes * rate * 60;
  const wholeSeconds = Math.floor(frames / rate);
  const frame = frames - wholeSeconds * rate;
  return [hours, minutes, wholeSeconds, frame]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function currentTimelineShot(shots, timeSec) {
  let cursor = 0;
  for (const shot of shots) {
    const end = cursor + (Number(shot.durationSec) || 0);
    if (timeSec >= cursor && timeSec < end) return shot;
    cursor = end;
  }
  return shots.at(-1) || null;
}

function updateResultPlayback(playback) {
  if (!playback?.video) return;
  const time = Number(playback.video.currentTime) || 0;
  const duration = playback.result.timeline.totalDurationSec || playback.video.duration || 0;
  const currentShot = currentTimelineShot(playback.result.timeline.shots, time);
  const selectedMarker = playback.result.subtitles.items.find(
    (marker) => marker.key === playback.previewMarkerKey,
  );
  const previewVisible = Boolean(
    selectedMarker
    && Number.isFinite(selectedMarker.durationSec)
    && time >= selectedMarker.timeSec
    && time < Math.min(selectedMarker.timeSec + selectedMarker.durationSec, duration),
  );
  playback.overlay.textContent = previewVisible ? selectedMarker.text : '';
  playback.overlay.className = `result-subtitle-overlay ${previewVisible ? '' : 'hidden'}`
    + `${selectedMarker?.position ? ` subtitle-${selectedMarker.position}` : ' subtitle-bottom-safe'}`;
  playback.currentTime.textContent = `${playbackTimecode(time, playback.result.subtitles.fps)} · ${time.toFixed(3)} 秒`;
  playback.playhead.style.left = `${duration > 0 ? Math.min(100, Math.max(0, time / duration * 100)) : 0}%`;
  playback.markerRows.forEach((row, key) => {
    row.classList.toggle('active', key === playback.activeMarkerKey);
  });
  playback.shotRows.forEach((row, shotId) => {
    row.classList.toggle('active', shotId === currentShot?.id);
  });
}

function seekResultMarker(playback, marker, preview = false) {
  if (!playback?.video || !playback.result.artifacts.preview?.exists) {
    showToast('粗剪播放器尚未加载或文件缺失。', true);
    return;
  }
  const duration = playback.result.timeline.totalDurationSec || playback.video.duration || 0;
  playback.video.currentTime = Math.min(Math.max(marker.timeSec, 0), Math.max(0, duration - 0.001));
  playback.activeMarkerKey = marker.key;
  playback.previewMarkerKey = preview ? marker.key : playback.previewMarkerKey;
  updateResultPlayback(playback);
}

function createReadOnlyTimeline(result, playback) {
  const container = document.createElement('div');
  container.className = 'readonly-timeline';
  const track = document.createElement('div');
  track.className = 'readonly-timeline-track';
  const total = result.timeline.totalDurationSec || 1;
  result.timeline.shots.forEach((shot) => {
    const segment = document.createElement('div');
    segment.className = `readonly-shot${shot.hyperframes ? ' hyperframes' : ''}`;
    segment.style.width = `${Math.max(0, shot.durationSec / total * 100)}%`;
    segment.title = `${shot.id} · ${shot.filename}`;
    track.appendChild(segment);
  });
  result.subtitles.items.forEach((marker) => {
    const dot = createTextElement('button', '', 'readonly-marker');
    dot.type = 'button';
    dot.style.left = `${Math.min(100, Math.max(0, marker.timeSec / total * 100))}%`;
    dot.title = `${marker.timecode || '未提供'} · ${marker.text || '未提供'}`;
    dot.addEventListener('click', () => seekResultMarker(playback, marker));
    track.appendChild(dot);
    if (marker.shouldGenerateFcpTitle && Number.isFinite(marker.durationSec)) {
      const titleRange = document.createElement('span');
      titleRange.className = 'readonly-title-range';
      titleRange.style.left = `${Math.min(100, Math.max(0, marker.timeSec / total * 100))}%`;
      titleRange.style.width = `${Math.min(100, marker.durationSec / total * 100)}%`;
      titleRange.title = `FCP Title · ${marker.text}`;
      track.appendChild(titleRange);
    }
  });
  playback.playhead = document.createElement('span');
  playback.playhead.className = 'readonly-playhead';
  track.appendChild(playback.playhead);
  container.append(
    createTextElement('p', `总时长 ${formatResultDuration(result.timeline.totalDurationSec)} · 蓝色为 HyperFrames · 紫色为 FCP Title 区间`),
    track,
  );
  return container;
}

function renderSubtitleSuggestions(result, playback) {
  const subtitles = createResultSection('轻字幕建议', 'Marker 用于建议与定位；FCP Title 是画面中真正可编辑的文字。');
  subtitles.appendChild(createDefinitionGrid([
    ['Marker 总数', String(result.subtitles.markerCount)],
    ['启用轻字幕', String(result.subtitles.enabledSubtitleCount)],
    ['已生成 FCP 标题', String(result.subtitles.fcpTitleCount)],
    ['正式帧率', `${result.subtitles.fps} fps`],
    ['时间来源', result.subtitles.source],
    ['HyperFrames 后已平移', result.subtitles.hyperframesAdjusted ? '是' : '否'],
    ['Marker 写入 FCPXML', result.subtitles.allMarkersWritten ? '完整' : '不完整'],
    ['原生标题写入 FCPXML', result.subtitles.allRequestedTitlesGenerated ? '完整' : '不完整'],
  ], 'subtitle-summary-grid'));
  subtitles.appendChild(createReadOnlyTimeline(result, playback));
  if (!result.subtitles.items.length) {
    subtitles.appendChild(createTextElement('p', '本期没有建议添加轻字幕', 'empty-inline'));
    return subtitles;
  }
  const list = document.createElement('div');
  list.className = 'subtitle-marker-list';
  result.subtitles.items.forEach((marker) => {
    const row = document.createElement('article');
    row.className = 'subtitle-marker-row';
    row.dataset.markerKey = marker.key;
    playback.markerRows.set(marker.key, row);
    const title = document.createElement('div');
    title.className = 'subtitle-marker-heading';
    title.append(
      createTextElement('strong', marker.text || '未提供'),
      createTextElement('span', marker.timecode || '未提供', 'subtitle-timecode'),
    );
    row.append(
      title,
      createDefinitionGrid([
        ['秒数', Number.isFinite(marker.timeSec) ? `${marker.timeSec.toFixed(3)} 秒` : '未提供'],
        ['Marker ID', marker.id || '未提供'],
        ['对应镜头', marker.shotId ? `${marker.shotOrder || '—'}. ${marker.shotId}` : '未提供'],
        ['对应素材', marker.assetFilename || '未提供'],
        ['类型', marker.type || '未提供'],
        ['用途', marker.purpose || '未提供'],
        ['建议持续时间', displayProvided(marker.durationSec, ' 秒')],
        ['建议位置', marker.position || '未提供'],
        ['Marker 状态', marker.writtenToFcpxmlMarker ? '已写入 FCPXML' : '未写入 FCPXML'],
        ['FCP 标题状态', marker.generatedFcpTitle ? '已生成原生 Title' : (marker.shouldGenerateFcpTitle ? '应生成但缺失' : '未启用')],
      ], 'subtitle-marker-grid'),
    );
    const actions = document.createElement('div');
    actions.className = 'result-actions subtitle-marker-actions';
    const seekButton = createTextElement('button', '跳到此处', 'button secondary');
    seekButton.addEventListener('click', () => seekResultMarker(playback, marker));
    const previewButton = createTextElement('button', '预览字幕', 'button secondary');
    previewButton.disabled = !marker.text || !Number.isFinite(marker.durationSec);
    previewButton.addEventListener('click', () => seekResultMarker(playback, marker, true));
    const closeButton = createTextElement('button', '关闭预览', 'button ghost');
    closeButton.addEventListener('click', () => {
      playback.previewMarkerKey = null;
      updateResultPlayback(playback);
    });
    actions.append(seekButton, previewButton, closeButton);
    row.appendChild(actions);
    list.appendChild(row);
  });
  subtitles.append(
    list,
    createTextElement(
      'p',
      '这是界面审阅预览。最终文字将作为 Final Cut Pro 原生标题片段插入，不会烧录进粗剪视频。',
      'subtitle-preview-note',
    ),
  );
  return subtitles;
}

  return {
    playbackTimecode,
    currentTimelineShot,
    updateResultPlayback,
    seekResultMarker,
    createReadOnlyTimeline,
    renderSubtitleSuggestions,
  };
}));
