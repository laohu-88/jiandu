(function createDouyinEditorCore(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DouyinEditorCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function resolveDom() {
    return root.PlannerDom || {};
  }

  function createTextElement(tag, text, className = '') {
    const dom = resolveDom();
    if (dom.createTextElement) return dom.createTextElement(tag, text, className);
    if (root.PlannerUtils?.createTextElement) return root.PlannerUtils.createTextElement(tag, text, className);
    const el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function createDefinitionGrid(entries, className = '') {
    const dom = resolveDom();
    if (dom.createDefinitionGrid) return dom.createDefinitionGrid(entries, className);
    const grid = document.createElement('dl');
    grid.className = `result-definition-grid ${className}`.trim();
    entries.forEach(([label, value]) => {
      const item = document.createElement('div');
      item.append(createTextElement('dt', label), createTextElement('dd', value ?? '—'));
      grid.appendChild(item);
    });
    return grid;
  }

  async function withBusy(button, action, busyText = '处理中…') {
    if (root.PlannerUtils?.withBusy) {
      return root.PlannerUtils.withBusy(button, action, busyText);
    }
    if (!button) return action();
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    try { return await action(); }
    finally { button.disabled = false; button.textContent = originalText; }
  }

  let state = { douyinPreview: null };

const DOUYIN_DECISION_LABELS = {
  selected: '选用',
  separate: '建议另拆一条',
  excluded: '排除',
};

const DOUYIN_LAYOUT_LABELS = {
  native_vertical: '原生竖屏完整显示',
  center_crop: '中央裁切',
  landscape_card: '完整横屏卡片',
  landscape_card_blur: '横屏卡片 + 同画面模糊背景',
  screen_focus: '录屏局部放大',
  screen_split: '上下双层录屏',
  segmented_focus: '分段局部放大',
  subject_track: '动态主体跟踪',
};

const DOUYIN_SUBJECT_TYPE_LABELS = {
  person: '人物',
  animal: '动物',
  vehicle: '车辆',
  moving_object: '明显运动物体',
  user_region: '用户人工指定区域',
};

const DOUYIN_CAPTION_KIND_LABELS = {
  content: '内容字幕',
  context: '上下文字幕',
  chapter_conclusion: '章节 / 结论字幕',
};

function cloneDouyinPlan(plan) {
  return JSON.parse(JSON.stringify(plan));
}

function nextDouyinId(prefix, plan) {
  const occupied = JSON.stringify(plan);
  let index = 1;
  while (occupied.includes(`"${prefix}-${index}"`)) index += 1;
  return `${prefix}-${index}`;
}

function douyinDefaultLayout(asset) {
  const width = Number(asset?.metadata?.displayWidth || asset?.metadata?.width);
  const height = Number(asset?.metadata?.displayHeight || asset?.metadata?.height);
  return {
    mode: height > width ? 'native_vertical' : 'landscape_card_blur',
    scale: 1,
    position: { x: 0, y: 0 },
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    secondaryCrop: { left: 0, top: 0, right: 0, bottom: 0 },
    splitRatio: 0.5,
    subjectBounds: null,
    sourceTextBounds: [],
    minReadableTextHeightPx: null,
    agentNote: '',
    tracking: null,
  };
}

function cloneDouyinLayout(layout) {
  return JSON.parse(JSON.stringify(layout || {}));
}

function ensureDouyinLayout(layout) {
  const base = douyinDefaultLayout(null);
  return {
    ...base,
    ...layout,
    position: { ...base.position, ...(layout?.position || {}) },
    crop: { ...base.crop, ...(layout?.crop || {}) },
    secondaryCrop: { ...base.secondaryCrop, ...(layout?.secondaryCrop || {}) },
    sourceTextBounds: Array.isArray(layout?.sourceTextBounds) ? layout.sourceTextBounds : [],
    tracking: layout?.tracking ? cloneDouyinLayout(layout.tracking) : null,
  };
}

function rebuildDouyinTrackingKeyframes(shot) {
  const tracking = shot.layout.tracking;
  if (!tracking) return;
  tracking.points.sort((left, right) => left.sourceTimeSec - right.sourceTimeSec);
  const existingByPoint = new Map(
    (tracking.keyframes || []).map((keyframe) => [keyframe.pointId, keyframe]),
  );
  tracking.keyframes = tracking.points.map((point, index) => {
    const existing = existingByPoint.get(point.pointId);
    const centerX = point.bounds.x + point.bounds.width / 2;
    const centerY = point.bounds.y + point.bounds.height / 2;
    return {
      keyframeId: existing?.keyframeId || `manual-keyframe-${index + 1}`,
      pointId: point.pointId,
      sourceTimeSec: point.sourceTimeSec,
      sourceTime: point.sourceTime || `${Math.round(point.sourceTimeSec * 30)}/30s`,
      position: existing?.position || {
        x: Number(((0.5 - centerX) * 2).toFixed(4)),
        y: Number(((0.5 - centerY) * 2).toFixed(4)),
      },
      scale: existing?.scale || shot.layout.scale,
      crop: cloneDouyinLayout(existing?.crop || shot.layout.crop),
      interpolation: existing?.interpolation || 'smooth',
    };
  });
  tracking.status = tracking.status === 'fallback' ? 'fallback' : 'tracked';
  tracking.manualConfirmation = 'corrected';
}

function cropToRect(crop) {
  return {
    x: crop.left,
    y: crop.top,
    width: Math.max(0.01, 1 - crop.left - crop.right),
    height: Math.max(0.01, 1 - crop.top - crop.bottom),
  };
}

function setCropFromRect(crop, rect) {
  crop.left = Number(rect.x.toFixed(4));
  crop.top = Number(rect.y.toFixed(4));
  crop.right = Number((1 - rect.x - rect.width).toFixed(4));
  crop.bottom = Number((1 - rect.y - rect.height).toFixed(4));
}

function updateDouyinOpening(video) {
  video.openingAssetId = video.shots[0]?.assetId || '';
}

function createDouyinControl(label, value, onInput, options = {}) {
  const wrapper = document.createElement('label');
  wrapper.className = options.className || 'douyin-control';
  wrapper.appendChild(createTextElement('span', label));
  const control = options.multiline
    ? document.createElement('textarea')
    : document.createElement('input');
  if (!options.multiline) control.type = options.type || 'text';
  if (options.step != null) control.step = String(options.step);
  if (options.min != null) control.min = String(options.min);
  if (options.max != null) control.max = String(options.max);
  control.value = value ?? '';
  control.disabled = options.disabled === true;
  control.addEventListener(options.commit ? 'change' : 'input', () => {
    const next = options.type === 'number' ? Number(control.value) : control.value;
    onInput(next);
  });
  wrapper.appendChild(control);
  return wrapper;
}

function createDouyinSelect(label, value, choices, onChange, className = '') {
  const wrapper = document.createElement('label');
  wrapper.className = className || 'douyin-control';
  wrapper.appendChild(createTextElement('span', label));
  const select = document.createElement('select');
  Object.entries(choices).forEach(([choiceValue, choiceLabel]) => {
    const option = createTextElement('option', choiceLabel);
    option.value = choiceValue;
    option.selected = choiceValue === value;
    select.appendChild(option);
  });
  select.addEventListener('change', () => onChange(select.value));
  wrapper.appendChild(select);
  return wrapper;
}

function appendDouyinRect(canvas, rect, className, label = '') {
  if (!rect) return;
  const box = document.createElement('div');
  box.className = className;
  box.style.left = `${rect.x * 100}%`;
  box.style.top = `${rect.y * 100}%`;
  box.style.width = `${rect.width * 100}%`;
  box.style.height = `${rect.height * 100}%`;
  if (label) box.appendChild(createTextElement('span', label));
  canvas.appendChild(box);
}

function createDouyinMedia(asset, className, layout, beforeCrop) {
  const media = document.createElement(asset?.type === 'video' ? 'video' : 'img');
  media.className = className;
  media.src = asset?.fileUrl || '';
  if (asset?.type === 'video') {
    media.controls = className.includes('foreground');
    media.muted = true;
    media.loop = true;
    media.preload = 'metadata';
  }
  const mode = beforeCrop ? 'native_vertical' : layout.mode;
  media.style.objectFit = ['center_crop', 'screen_focus', 'segmented_focus', 'subject_track'].includes(mode)
    ? 'cover'
    : 'contain';
  if (!beforeCrop) {
    media.style.transform = `translate(${layout.position.x * 50}%, ${layout.position.y * 50}%) scale(${layout.scale})`;
    media.style.clipPath = `inset(${layout.crop.top * 100}% ${layout.crop.right * 100}% ${layout.crop.bottom * 100}% ${layout.crop.left * 100}%)`;
  }
  return media;
}

function bindDouyinCropBox(canvas, box, crop, onCommit, resize = false) {
  box.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    box.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY, rect: cropToRect(crop) };
    const bounds = canvas.getBoundingClientRect();
    const move = (moveEvent) => {
      const dx = (moveEvent.clientX - start.x) / bounds.width;
      const dy = (moveEvent.clientY - start.y) / bounds.height;
      const rect = { ...start.rect };
      if (resize) {
        rect.width = Math.max(0.08, Math.min(1 - rect.x, start.rect.width + dx));
        rect.height = Math.max(0.08, Math.min(1 - rect.y, start.rect.height + dy));
      } else {
        rect.x = Math.max(0, Math.min(1 - rect.width, start.rect.x + dx));
        rect.y = Math.max(0, Math.min(1 - rect.height, start.rect.y + dy));
      }
      setCropFromRect(crop, rect);
      box.style.left = `${rect.x * 100}%`;
      box.style.top = `${rect.y * 100}%`;
      box.style.width = `${rect.width * 100}%`;
      box.style.height = `${rect.height * 100}%`;
    };
    const up = () => {
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      box.removeEventListener('pointercancel', up);
      onCommit();
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
  });
}

function appendInteractiveCropBox(canvas, crop, label, className, onCommit) {
  const rect = cropToRect(crop);
  const box = document.createElement('div');
  box.className = `douyin-crop-box ${className}`;
  box.style.left = `${rect.x * 100}%`;
  box.style.top = `${rect.y * 100}%`;
  box.style.width = `${rect.width * 100}%`;
  box.style.height = `${rect.height * 100}%`;
  box.append(
    createTextElement('span', label),
    createTextElement('i', '', 'douyin-crop-resize'),
  );
  bindDouyinCropBox(canvas, box, crop, onCommit, false);
  bindDouyinCropBox(canvas, box.querySelector('i'), crop, onCommit, true);
  canvas.appendChild(box);
}

function createDouyinCropEditor(asset, shot, onCommit) {
  const editor = document.createElement('div');
  editor.className = 'douyin-crop-editor';
  editor.appendChild(createTextElement(
    'small',
    '在原画上拖动裁切框，拖右下角调整大小；数值会按镜头独立保存。',
  ));
  const canvas = document.createElement('div');
  canvas.className = 'douyin-crop-source';
  const width = Number(asset?.metadata?.displayWidth || asset?.metadata?.width) || 16;
  const height = Number(asset?.metadata?.displayHeight || asset?.metadata?.height) || 9;
  canvas.style.aspectRatio = `${width} / ${height}`;
  const media = document.createElement(asset?.type === 'video' ? 'video' : 'img');
  media.src = asset?.fileUrl || '';
  media.muted = true;
  media.preload = 'metadata';
  media.currentTime = Number(shot.inSec) || 0;
  canvas.appendChild(media);
  appendInteractiveCropBox(canvas, shot.layout.crop, shot.layout.mode === 'screen_split'
    ? '上层完整界面 / 裁切'
    : '当前裁切区域', 'primary', onCommit);
  if (shot.layout.mode === 'screen_split') {
    appendInteractiveCropBox(
      canvas,
      shot.layout.secondaryCrop,
      '下层关键区域放大',
      'secondary',
      onCommit,
    );
  }
  for (const bounds of shot.layout.sourceTextBounds || []) {
    appendDouyinRect(canvas, bounds, 'douyin-source-text-bounds', '原画文字');
  }
  if (shot.layout.subjectBounds) {
    appendDouyinRect(canvas, shot.layout.subjectBounds, 'douyin-subject-bounds', '关键区域');
  }
  if (shot.layout.tracking?.enabled) {
    const trajectory = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    trajectory.classList.add('douyin-tracking-trajectory');
    trajectory.setAttribute('viewBox', '0 0 100 100');
    trajectory.setAttribute('preserveAspectRatio', 'none');
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', shot.layout.tracking.points.map((point) => {
      const x = (point.bounds.x + point.bounds.width / 2) * 100;
      const y = (point.bounds.y + point.bounds.height / 2) * 100;
      return `${x.toFixed(4)},${y.toFixed(4)}`;
    }).join(' '));
    trajectory.appendChild(polyline);
    canvas.appendChild(trajectory);
    shot.layout.tracking.points.forEach((point, index) => {
      appendDouyinRect(
        canvas,
        point.bounds,
        `douyin-tracking-point ${point.origin === 'manual' ? 'manual' : ''}`,
        `${index + 1} · ${Number(point.sourceTimeSec).toFixed(2)}s`,
      );
    });
  }
  editor.appendChild(canvas);
  return editor;
}

function douyinReadabilityFindings(shot) {
  const findings = [];
  const layout = shot.layout;
  if (layout.minReadableTextHeightPx == null) {
    if (['screen_focus', 'screen_split', 'segmented_focus'].includes(layout.mode)) {
      findings.push('界面小字尺寸未知，需要在手机尺寸下人工确认。');
    }
  } else {
    const cropHeight = Math.max(0.01, 1 - layout.crop.top - layout.crop.bottom);
    const splitScale = layout.mode === 'screen_split' ? layout.splitRatio : 1;
    const estimated = layout.minReadableTextHeightPx * layout.scale * splitScale / cropHeight;
    if (estimated < 24) findings.push(`界面小字预计约 ${estimated.toFixed(1)}px，可能不可读。`);
    else findings.push(`界面小字预计约 ${estimated.toFixed(1)}px，仍应以手机预览人工确认。`);
  }
  if ((layout.mode === 'landscape_card' || layout.mode === 'landscape_card_blur')
    && layout.scale < 0.85) {
    findings.push('横屏卡片有效显示面积偏小。');
  }
  if (layout.agentNote) findings.push(layout.agentNote);
  return findings;
}

function recommendDouyinCaptionPosition(video, caption, profile) {
  if (caption.kind === 'chapter_conclusion') return 'center';
  const shot = video.shots.find((item) => item.shotId === caption.shotId);
  if (!shot) return caption.kind === 'context' ? 'top-safe' : 'bottom-safe';
  const bottom = profile.subtitlePlacements['bottom-safe'];
  const overlapsBottomText = (shot.layout.sourceTextBounds || []).some((rect) => (
    rect.x < bottom.x + bottom.width
    && rect.x + rect.width > bottom.x
    && rect.y < bottom.y + bottom.height
    && rect.y + rect.height > bottom.y
  ));
  if (overlapsBottomText || shot.layout.mode === 'screen_split' || caption.kind === 'context') {
    return 'top-safe';
  }
  return 'bottom-safe';
}

function renderDouyinVerticalPreview(container, variant, plan, selection) {
  container.replaceChildren();
  const allShots = plan.videos.flatMap((video) => video.shots.map((shot) => ({
    videoId: video.videoId,
    theme: video.theme,
    shot,
  })));
  if (!allShots.length) {
    container.appendChild(createTextElement('p', '当前计划没有可预览镜头。', 'empty-inline'));
    return;
  }
  const requested = state.douyinPreview;
  const current = allShots.find((item) => (
    item.videoId === requested?.videoId && item.shot.shotId === requested?.shotId
  )) || allShots[0];
  const beforeCrop = requested?.beforeCrop === true;
  state.douyinPreview = {
    variantId: variant.variantId,
    videoId: current.videoId,
    shotId: current.shot.shotId,
    beforeCrop,
  };
  const asset = variant.assets.find((item) => item.assetId === current.shot.assetId);
  const controls = document.createElement('div');
  controls.className = 'douyin-preview-controls';
  const shotChoices = Object.fromEntries(allShots.map((item) => [
    `${item.videoId}:${item.shot.shotId}`,
    `${item.theme} · ${variant.assets.find((candidate) => (
      candidate.assetId === item.shot.assetId
    ))?.filename || item.shot.assetId}`,
  ]));
  const shotSelect = createDouyinSelect(
    '预览镜头',
    `${current.videoId}:${current.shot.shotId}`,
    shotChoices,
    (value) => {
      const [videoId, shotId] = value.split(':');
      state.douyinPreview = { variantId: variant.variantId, videoId, shotId, beforeCrop };
      renderDouyinVerticalPreview(container, variant, plan, selection);
    },
  );
  const toggle = createTextElement(
    'button',
    beforeCrop ? '切换成片结果（裁切后）' : '切换原画（裁切前）',
    'button secondary',
  );
  toggle.type = 'button';
  toggle.addEventListener('click', () => {
    state.douyinPreview = { ...state.douyinPreview, beforeCrop: !beforeCrop };
    renderDouyinVerticalPreview(container, variant, plan, selection);
  });
  controls.append(shotSelect, toggle);

  const canvas = document.createElement('div');
  canvas.className = 'douyin-preview-canvas phone-size';
  const layout = current.shot.layout;
  if (!beforeCrop && layout.mode === 'screen_split') {
    const top = document.createElement('div');
    top.className = 'douyin-preview-layer top';
    top.style.height = `${layout.splitRatio * 100}%`;
    const topMedia = createDouyinMedia(asset, 'douyin-preview-media foreground split', {
      ...layout,
      mode: 'screen_focus',
      crop: layout.crop,
    }, false);
    top.appendChild(topMedia);
    const bottom = document.createElement('div');
    bottom.className = 'douyin-preview-layer bottom';
    bottom.style.top = `${layout.splitRatio * 100}%`;
    bottom.style.height = `${(1 - layout.splitRatio) * 100}%`;
    const bottomMedia = createDouyinMedia(asset, 'douyin-preview-media foreground split', {
      ...layout,
      mode: 'screen_focus',
      crop: layout.secondaryCrop,
    }, false);
    bottom.appendChild(bottomMedia);
    canvas.append(top, bottom);
    const divider = document.createElement('span');
    divider.className = 'douyin-split-divider';
    divider.style.top = `${layout.splitRatio * 100}%`;
    canvas.appendChild(divider);
  } else if (!beforeCrop && layout.mode === 'landscape_card_blur') {
    canvas.appendChild(createDouyinMedia(asset, 'douyin-preview-media background', layout, false));
    canvas.appendChild(createDouyinMedia(asset, 'douyin-preview-media foreground', layout, false));
  } else {
    canvas.appendChild(createDouyinMedia(asset, 'douyin-preview-media foreground', layout, beforeCrop));
  }
  const width = Number(asset?.metadata?.displayWidth || asset?.metadata?.width);
  const height = Number(asset?.metadata?.displayHeight || asset?.metadata?.height);
  const boundary = document.createElement('div');
  boundary.className = `douyin-original-boundary ${width > height ? 'horizontal' : 'vertical'}`;
  boundary.appendChild(createTextElement('span', '原始画面边界'));
  canvas.appendChild(boundary);
  if (beforeCrop) {
    appendDouyinRect(canvas, cropToRect(layout.crop), 'douyin-current-crop', '当前裁切区域');
    if (layout.mode === 'screen_split') {
      appendDouyinRect(
        canvas,
        cropToRect(layout.secondaryCrop),
        'douyin-current-crop secondary',
        '下层裁切区域',
      );
    }
  }
  appendDouyinRect(canvas, variant.profile.safeZones.subject, 'douyin-safe-zone subject', '主体安全区');
  appendDouyinRect(canvas, variant.profile.safeZones.subtitle, 'douyin-safe-zone subtitle', '字幕安全区');
  if (layout.tracking?.enabled) {
    layout.tracking.points.forEach((point, index) => appendDouyinRect(
      canvas,
      point.bounds,
      `douyin-tracking-point ${point.origin === 'manual' ? 'manual' : ''}`,
      `主体 ${index + 1}`,
    ));
  }
  variant.profile.uiOcclusionZones.forEach((zone) => {
    appendDouyinRect(canvas, zone, 'douyin-ui-mask', zone.label);
  });
  const currentCaption = plan.videos.find((item) => item.videoId === current.videoId)
    ?.lightCaptions.find((item) => item.shotId === current.shot.shotId);
  if (currentCaption) {
    appendDouyinRect(
      canvas,
      variant.profile.subtitlePlacements[currentCaption.position],
      'douyin-caption-preview',
      currentCaption.text,
    );
  }
  const info = createDefinitionGrid([
    ['当前布局', DOUYIN_LAYOUT_LABELS[layout.mode] || layout.mode],
    ['当前模式', beforeCrop ? '原画 / 当前裁切框' : '手机尺寸 / 成片结果'],
    ['原声', current.shot.audioMode === 'keep' ? '保留' : `静音：${current.shot.muteReason || '未说明'}`],
    ['选材结论', DOUYIN_DECISION_LABELS[selection.get(current.shot.assetId)?.decision] || '—'],
  ], 'douyin-preview-info');
  const findings = douyinReadabilityFindings(current.shot);
  if (findings.length) {
    const notice = createTextElement('ul', '', 'douyin-readability-notice');
    findings.forEach((finding) => notice.appendChild(createTextElement('li', finding)));
    container.append(controls, canvas, info, notice);
    return;
  }
  container.append(controls, canvas, info);
}

function renderDouyinOutputs(container, result, variant) {
  const resultVariant = result.platformVariants.variants
    .find((item) => item.variantId === variant.variantId);
  const outputs = resultVariant?.outputs || [];
  if (!outputs.length) {
    container.appendChild(createTextElement(
      'p',
      '尚未生成。批准规划后，每条成片会写入独立目录。',
      'empty-inline',
    ));
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'douyin-output-grid';
  outputs.forEach((output) => {
    const card = document.createElement('article');
    card.className = 'douyin-output-card';
    card.append(
      createTextElement('h4', output.theme),
      createDefinitionGrid([
        ['规格', `${output.specs?.width}×${output.specs?.height} · ${output.specs?.aspectRatio} · ${output.specs?.fps}p`],
        ['素材 / 镜头', `${output.assetCount} / ${output.shotCount}`],
        ['FCP 原生字幕', String(output.subtitleCount)],
        ['原声', `${output.originalAudio?.keptOriginalAudioCount ?? 0} 个视频镜头保留`],
        ['验证', output.validationStatus],
        ['输出位置', output.outputDirectory?.path || '—'],
      ], 'douyin-output-meta'),
    );
    if (output.artifacts?.preview?.fileUrl) {
      const video = document.createElement('video');
      video.className = 'douyin-output-preview';
      video.controls = true;
      video.preload = 'metadata';
      video.src = output.artifacts.preview.fileUrl;
      card.appendChild(video);
    }
    const actions = document.createElement('div');
    actions.className = 'result-actions';
    [
      ['打开目录', 'outputDirectory'],
      ['定位预览', 'preview'],
      ['定位 FCPXML', 'fcpxml'],
      ['验证报告', 'validation'],
    ].forEach(([label, target]) => {
      const button = createTextElement('button', label, 'button secondary');
      button.type = 'button';
      button.addEventListener('click', () => withBusy(button, () =>
        window.plannerApi.runDouyinArtifactAction({
          projectPath: result.project.path,
          variantId: variant.variantId,
          videoId: output.videoId,
          target,
        }), '正在打开…'));
      actions.appendChild(button);
    });
    const fcpButton = createTextElement('button', '使用 Final Cut Pro 打开', 'button primary');
    fcpButton.type = 'button';
    fcpButton.addEventListener('click', () => withBusy(fcpButton, () =>
      window.plannerApi.openDouyinFcpxmlInFinalCut({
        projectPath: result.project.path,
        variantId: variant.variantId,
        videoId: output.videoId,
      }), '正在打开…'));
    actions.appendChild(fcpButton);
    card.appendChild(actions);
    grid.appendChild(card);
  });
  container.appendChild(grid);
}

  function createSession(deps = {}) {
    const {
      result,
      variant,
      getPreviewState,
      setPreviewState,
      onDraftChange,
    } = deps;
    let draftPlan = cloneDouyinPlan(variant.plan);
    const approvedWarnings = new Set(variant.approval?.approvedWarningIds || []);
    let dirty = false;
    const assetsById = new Map((variant.assets || []).map((item) => [item.assetId, item]));

    function syncPreviewBag() {
      if (typeof getPreviewState === 'function') {
        state.douyinPreview = getPreviewState();
      }
    }

    function publishPreviewBag() {
      if (typeof setPreviewState === 'function') setPreviewState(state.douyinPreview);
    }

    function markDirty() {
      dirty = true;
      if (typeof onDraftChange === 'function') {
        onDraftChange({ draftPlan, dirty, approvedWarningIds: [...approvedWarnings] });
      }
    }

    return {
      getDraftPlan: () => draftPlan,
      setDraftPlan: (plan) => { draftPlan = plan; markDirty(); },
      replaceDraftPlan: (plan) => { draftPlan = plan; },
      getApprovedWarningIds: () => [...approvedWarnings],
      approvedWarnings,
      assetsById,
      isDirty: () => dirty,
      markDirty,
      clearDirty: () => { dirty = false; },
      syncPreviewBag,
      publishPreviewBag,
      renderVerticalPreview: (container, plan, selection) => {
        syncPreviewBag();
        renderDouyinVerticalPreview(container, variant, plan, selection);
        publishPreviewBag();
      },
      renderOutputs: (container) => renderDouyinOutputs(container, result, variant),
      labels: {
        decision: DOUYIN_DECISION_LABELS,
        layout: DOUYIN_LAYOUT_LABELS,
        subjectType: DOUYIN_SUBJECT_TYPE_LABELS,
        captionKind: DOUYIN_CAPTION_KIND_LABELS,
      },
      helpers: {
        cloneDouyinPlan,
        nextDouyinId,
        douyinDefaultLayout,
        ensureDouyinLayout,
        cloneDouyinLayout,
        updateDouyinOpening,
        createDouyinControl,
        createDouyinSelect,
        createDouyinCropEditor,
        douyinReadabilityFindings,
        recommendDouyinCaptionPosition,
        rebuildDouyinTrackingKeyframes,
      },
      variant,
      result,
    };
  }

  return {
    DOUYIN_DECISION_LABELS,
    DOUYIN_LAYOUT_LABELS,
    DOUYIN_SUBJECT_TYPE_LABELS,
    DOUYIN_CAPTION_KIND_LABELS,
    cloneDouyinPlan,
    nextDouyinId,
    douyinDefaultLayout,
    cloneDouyinLayout,
    ensureDouyinLayout,
    rebuildDouyinTrackingKeyframes,
    cropToRect,
    setCropFromRect,
    updateDouyinOpening,
    createDouyinControl,
    createDouyinSelect,
    appendDouyinRect,
    createDouyinMedia,
    createDouyinCropEditor,
    douyinReadabilityFindings,
    recommendDouyinCaptionPosition,
    renderDouyinVerticalPreview,
    renderDouyinOutputs,
    createSession,
    getPreviewState: () => state.douyinPreview,
    setPreviewState: (value) => { state.douyinPreview = value; },
  };
}));
