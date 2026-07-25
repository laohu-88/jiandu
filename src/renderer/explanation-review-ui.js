'use strict';

(function attachExplanationReviewUi(global) {
  const STATUS_LABELS = {
    pending: '待审阅',
    approved: '已采用',
    edited_approved: '修改后采用',
    not_needed: '不需要字幕',
    rejected: '已拒绝',
    needs_review: '需要进一步确认',
    stale: '人工决定已过期',
  };

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function createExplanationReviewSection(deps) {
    const {
      result,
      state,
      createResultSection,
      createDefinitionGrid,
      createTextElement,
      formatDateTime,
      showToast,
      withBusy,
      renderCodexProjectResult,
    } = deps;

    const review = result.explanationReview || {
      available: false,
      message: '暂无解释与轻字幕分析',
      summary: {},
      items: [],
      warnings: [],
    };
    state.explanationReview = review;
    const section = createResultSection(
      '解释与轻字幕',
      '进入 Final Cut Pro 前确认素材解释、画面文字、轻字幕建议与视频保留锁定。已确认字幕可显式导出为 FCP 原生 Title。',
    );

    if (!review.available) {
      section.appendChild(createTextElement('p', review.message || '暂无解释与轻字幕分析', 'empty-inline'));
      if (review.warnings?.length) {
        section.appendChild(createTextElement('p', review.warnings.join('；'), 'notice warning'));
      }
      return section;
    }

    const summary = review.summary || {};
    section.appendChild(createDefinitionGrid([
      ['待审阅', String(summary.pending ?? 0)],
      ['已采用', String(summary.approved ?? 0)],
      ['修改后采用', String(summary.editedApproved ?? 0)],
      ['不需要字幕', String(summary.notNeeded ?? 0)],
      ['已拒绝', String(summary.rejected ?? 0)],
      ['需要进一步确认', String(summary.needsReview ?? 0)],
      ['有画面文字', String(summary.withVisualText ?? 0)],
      ['有警告或冲突', String(summary.withWarnings ?? 0)],
      ['已锁定完整保留', String(summary.fullClipLocked ?? 0)],
      ['已锁定保留原声', String(summary.originalAudioLocked ?? 0)],
      ['人工决定已过期', String(summary.stale ?? 0)],
    ], 'explanation-summary-grid'));

    if (review.warnings?.length) {
      section.appendChild(createTextElement('p', review.warnings.join('；'), 'notice warning'));
    }

    function itemDraft(item) {
      const existing = state.explanationReviewDrafts[item.assetId];
      if (existing) return existing;
      const captions = {};
      item.captions.forEach((caption) => {
        captions[caption.captionId] = {
          reviewStatus: caption.reviewStatus || 'pending',
          approvedText: caption.approvedText || caption.suggestedText || '',
          approvedStartTime: caption.approvedStartTime,
          approvedEndTime: caption.approvedEndTime,
          userNotes: caption.userNotes || '',
        };
      });
      return {
        reviewStatus: item.reviewStatus || 'pending',
        preserveFullClipLocked: item.preserveFullClipLocked === true,
        preserveOriginalAudioLocked: item.preserveOriginalAudioLocked === true,
        trimNeedsHumanDecision: item.trimNeedsHumanDecision === true,
        audioNeedsHumanDecision: item.audioNeedsHumanDecision === true,
        unlockAudioReason: item.unlockAudioReason || '',
        userNotes: item.userNotes || '',
        captions,
      };
    }

    function markDirty(assetId, draft) {
      state.explanationReviewDrafts[assetId] = draft;
      state.explanationReviewDirty = true;
    }

    function filteredItems() {
      const filter = state.explanationReviewFilter || 'all';
      const needle = String(state.explanationReviewQuery || '').trim().toLowerCase();
      return (review.items || []).filter((item) => {
        if (filter === 'pending' && !['pending', 'needs_review', 'stale'].includes(item.reviewStatus)) return false;
        if (filter === 'confirmed' && !['approved', 'edited_approved'].includes(item.reviewStatus)) return false;
        if (filter === 'not_needed' && item.reviewStatus !== 'not_needed') return false;
        if (filter === 'warnings' && !(item.warningCount > 0)) return false;
        if (filter === 'video' && item.mediaType !== 'video') return false;
        if (filter === 'image' && item.mediaType !== 'image') return false;
        if (!needle) return true;
        const haystack = [
          item.filename,
          item.storyUnitTheme,
          item.assetId,
          item.chapterId,
          item.narrativeRole,
          ...item.captions.map((caption) => caption.suggestedText || ''),
          ...item.captions.map((caption) => caption.approvedText || ''),
        ].join(' ').toLowerCase();
        return haystack.includes(needle);
      });
    }

    function stopPlayback() {
      const playback = state.explanationAssetPlayback;
      if (playback?.video) {
        try { playback.video.pause(); } catch { /* ignore */ }
      }
      state.explanationAssetPlayback = null;
    }

    function updatePlaybackStatus(playback) {
      if (!playback?.status || !playback.video) return;
      const time = Number(playback.video.currentTime) || 0;
      const duration = Number(playback.video.duration) || Number(playback.durationSec) || 0;
      playback.status.textContent = `${time.toFixed(2)} / ${duration.toFixed(2)} 秒 · ${playback.hasAudio ? '原声播放' : '无音频流'}`;
      if (Number.isFinite(playback.rangeEnd) && time >= playback.rangeEnd) {
        playback.video.pause();
        playback.rangeEnd = null;
      }
    }

    function seekCaption(caption) {
      const playback = state.explanationAssetPlayback;
      if (!playback?.video) {
        showToast('当前素材预览不可播放。', true);
        return;
      }
      const seek = Number(caption.seekTimeSec ?? caption.approvedStartTime);
      if (!Number.isFinite(seek) || seek < 0) {
        showToast('该字幕没有可定位的视频时间。', true);
        return;
      }
      const duration = Number(playback.video.duration) || Number(playback.durationSec) || 0;
      playback.video.currentTime = Math.min(Math.max(seek, 0), Math.max(0, duration - 0.001));
      playback.rangeEnd = Number(caption.approvedEndTime);
      updatePlaybackStatus(playback);
    }

    function playCaptionRange(caption) {
      seekCaption(caption);
      const playback = state.explanationAssetPlayback;
      if (!playback?.video) return;
      playback.video.muted = false;
      playback.video.play().catch(() => showToast('无法开始播放该区间。', true));
    }

    function evidenceList(label, values, tone) {
      const block = document.createElement('div');
      block.className = `explanation-evidence ${tone || ''}`.trim();
      block.appendChild(createTextElement('h5', label));
      const list = asArray(values);
      if (!list.length) {
        block.appendChild(createTextElement('p', '无', 'empty-inline'));
        return block;
      }
      const ul = document.createElement('ul');
      list.forEach((value) => ul.appendChild(createTextElement('li', String(value))));
      block.appendChild(ul);
      return block;
    }

    function renderPreview(item, host) {
      stopPlayback();
      const previewBox = document.createElement('div');
      previewBox.className = 'explanation-preview';
      previewBox.appendChild(createTextElement('h4', '素材预览'));
      const preview = item.preview || {};
      if (!preview.available || !preview.fileUrl) {
        previewBox.appendChild(createTextElement(
          'p',
          preview.message || '源视觉素材缺失，无法预览。',
          'notice warning',
        ));
        host.appendChild(previewBox);
        return;
      }
      if (item.mediaType === 'video') {
        const shell = document.createElement('div');
        shell.className = 'explanation-video-shell';
        const video = document.createElement('video');
        video.className = 'result-video explanation-video';
        video.controls = true;
        video.preload = 'metadata';
        video.muted = false;
        video.src = preview.fileUrl;
        const status = createTextElement(
          'p',
          preview.hasAudio ? '0.00 / — 秒 · 原声播放' : '0.00 / — 秒 · 无音频流',
          'result-current-time',
        );
        const playback = {
          video,
          status,
          durationSec: preview.durationSec,
          hasAudio: preview.hasAudio === true,
          rangeEnd: null,
        };
        state.explanationAssetPlayback = playback;
        ['loadedmetadata', 'timeupdate', 'seeked', 'ended', 'play', 'pause'].forEach((eventName) => {
          video.addEventListener(eventName, () => updatePlaybackStatus(playback));
        });
        shell.appendChild(video);
        previewBox.append(shell, status);
      } else {
        const image = document.createElement('img');
        image.className = 'explanation-image';
        image.alt = item.filename;
        image.src = preview.fileUrl;
        previewBox.appendChild(image);
      }
      host.appendChild(previewBox);
    }

    async function saveDraft(assetId, draft, saveStatus) {
      const projectPath = state.selectedCatalogProjectPath;
      if (!projectPath) throw new Error('未选择项目。');
      if (saveStatus) saveStatus.textContent = '保存中…';
      const saved = await window.plannerApi.saveEditorialReview({
        projectPath,
        reviews: {
          [assetId]: {
            reviewStatus: draft.reviewStatus,
            preserveFullClipLocked: draft.preserveFullClipLocked === true,
            preserveOriginalAudioLocked: draft.preserveOriginalAudioLocked === true,
            trimNeedsHumanDecision: draft.trimNeedsHumanDecision === true,
            audioNeedsHumanDecision: draft.audioNeedsHumanDecision === true,
            unlockAudioReason: draft.unlockAudioReason || null,
            userNotes: draft.userNotes || '',
            captions: Object.fromEntries(
              Object.entries(draft.captions || {}).map(([captionId, caption]) => [
                captionId,
                {
                  reviewStatus: caption.reviewStatus,
                  approvedText: caption.approvedText || null,
                  approvedStartTime: caption.approvedStartTime,
                  approvedEndTime: caption.approvedEndTime,
                  userNotes: caption.userNotes || '',
                },
              ]),
            ),
          },
        },
      });
      state.explanationReview = saved;
      state.explanationReviewDrafts = {};
      state.explanationReviewDirty = false;
      state.explanationReviewSelectedAssetId = assetId;
      if (state.selectedProjectResult) state.selectedProjectResult.explanationReview = saved;
      showToast('人工决定已保存。');
      renderCodexProjectResult(state.selectedProjectResult);
    }

    function renderDetail(item, host) {
      host.replaceChildren();
      if (!item) {
        host.appendChild(createTextElement('p', '请选择左侧素材进行审阅。', 'empty-inline'));
        return;
      }
      const draft = itemDraft(item);
      const heading = document.createElement('div');
      heading.className = 'explanation-detail-heading';
      heading.append(
        createTextElement('h4', item.filename),
        createTextElement(
          'p',
          `${STATUS_LABELS[draft.reviewStatus] || draft.reviewStatus} · ${item.mediaType} · ${item.storyUnitTheme || '无 Story Unit'}`,
        ),
      );
      host.appendChild(heading);
      renderPreview(item, host);

      const evidence = item.evidence || {};
      const visual = createResultSection('画面内容', '仅展示画面可见内容，不把上下文当作 OCR。');
      visual.appendChild(createDefinitionGrid([['visualSummary', evidence.visual?.visualSummary]]));
      visual.appendChild(evidenceList('visualEvidence（画面证据）', evidence.visual?.visualEvidence, 'evidence-visual'));
      host.appendChild(visual);

      const textSection = createResultSection('画面文字', 'sourceText / translatedText / meaning 分区保留。');
      if (!evidence.visualText?.items?.length) {
        textSection.appendChild(createTextElement('p', '未检测到画面文字。', 'empty-inline'));
      } else {
        evidence.visualText.items.forEach((entry, index) => {
          const card = document.createElement('article');
          card.className = 'explanation-text-card';
          card.append(
            createTextElement('strong', `文字 ${index + 1} · ${entry.textType || 'unknown'}`),
            createDefinitionGrid([
              ['sourceText', entry.sourceText],
              ['language', entry.language],
              ['translatedText', entry.translatedText],
              ['meaning', entry.meaning],
              ['readingOrder', entry.readingOrder],
              ['speakerOrRegion', entry.speakerOrRegion],
              ['视频时间范围', entry.startTime != null ? `${entry.startTime}–${entry.endTime}s` : '图片 / 无源时间'],
              ['confidence', entry.confidence],
              ['warnings', asArray(entry.warnings).join('；') || '无'],
            ]),
          );
          textSection.appendChild(card);
        });
      }
      host.appendChild(textSection);

      const audioSection = createResultSection('声音信息', '声音证据与画面证据分开显示。');
      if (!evidence.audio) {
        audioSection.appendChild(createTextElement('p', '无音频分析。', 'empty-inline'));
      } else {
        audioSection.appendChild(createDefinitionGrid([
          ['audioAvailable', evidence.audio.audioAvailable ? '是' : '否'],
          ['speechPresent', evidence.audio.speechPresent ? '是' : '否'],
          ['musicPresent', evidence.audio.musicPresent ? '是' : '否'],
          ['soundEffectPresent', evidence.audio.soundEffectPresent ? '是' : '否'],
          ['audioSummary', evidence.audio.audioSummary],
          ['audioNeededForUnderstanding', evidence.audio.audioNeededForUnderstanding ? '是' : '否'],
          ['preserveOriginalAudio', evidence.audio.preserveOriginalAudio ? '是' : '否'],
          ['muteReason', evidence.audio.muteReason || '无'],
        ]));
        audioSection.appendChild(evidenceList('audioEvidence（声音证据）', evidence.audio.audioEvidence, 'evidence-audio'));
      }
      host.appendChild(audioSection);

      const contextSection = createResultSection('HotIngest 上下文', '上下文证据不得显示为画面识别结果。');
      contextSection.appendChild(createDefinitionGrid([
        ['标题', evidence.context?.title],
        ['正文或摘要', evidence.context?.body],
        ['翻译', evidence.context?.translation],
        ['来源平台', evidence.context?.sourcePlatform],
        ['contextSourceFiles', asArray(evidence.context?.contextSourceFiles).join('、') || '无'],
      ]));
      contextSection.appendChild(evidenceList('contextEvidence（上下文证据）', evidence.context?.contextEvidence, 'evidence-context'));
      host.appendChild(contextSection);

      const explanationSection = createResultSection('综合解释', 'inference 仅作为程序推断，不是已确认事实。');
      explanationSection.appendChild(createDefinitionGrid([
        ['keyPoint', evidence.explanation?.keyPoint],
        ['setup', evidence.explanation?.setup],
        ['payoffOrResult', evidence.explanation?.payoffOrResult],
        ['humorOrConflict', evidence.explanation?.humorOrConflict],
        ['translatedMeaning', evidence.explanation?.translatedMeaning],
        ['audienceNeedsExplanation', evidence.explanation?.audienceNeedsExplanation],
        ['explanationReason', evidence.explanation?.explanationReason],
        ['confidence', evidence.explanation?.confidence],
        ['warnings', asArray(evidence.explanation?.warnings).join('；') || '无'],
      ]));
      explanationSection.appendChild(evidenceList('inference（程序推断）', evidence.explanation?.inference, 'evidence-inference'));
      host.appendChild(explanationSection);

      const captionsSection = createResultSection('轻字幕编辑和审核', '先保存人工决定；导出到 FCPXML 需点击下方“生成或更新 FCP 轻字幕”。');
      if (!item.captions.length) {
        captionsSection.appendChild(createTextElement('p', '本素材暂无轻字幕建议。', 'empty-inline'));
      } else {
        item.captions.forEach((caption) => {
          if (!draft.captions[caption.captionId]) {
            draft.captions[caption.captionId] = {
              reviewStatus: caption.reviewStatus || 'pending',
              approvedText: caption.approvedText || caption.suggestedText || '',
              approvedStartTime: caption.approvedStartTime,
              approvedEndTime: caption.approvedEndTime,
              userNotes: caption.userNotes || '',
            };
          }
          const captionDraft = draft.captions[caption.captionId];
          const card = document.createElement('article');
          card.className = 'explanation-caption-card';
          card.append(
            createTextElement('strong', caption.suggestedText || caption.captionId),
            createDefinitionGrid([
              ['purpose', caption.purpose],
              ['basedOn', caption.basedOn],
              ['confidence', caption.confidence],
              ['reviewRequired', caption.reviewRequired ? '是' : '否'],
              ['warnings', asArray(caption.warnings).join('；') || '无'],
              ['显示时间', caption.displayTiming?.label
                || (caption.displayTiming?.startTime != null
                  ? `${caption.displayTiming.startTime}–${caption.displayTiming.endTime}s`
                  : '—')],
            ]),
          );

          const statusLabel = createTextElement('label', '审核状态');
          const statusSelect = document.createElement('select');
          Object.entries(STATUS_LABELS).forEach(([value, label]) => {
            if (value === 'stale') return;
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            if (captionDraft.reviewStatus === value) option.selected = true;
            statusSelect.appendChild(option);
          });
          statusSelect.addEventListener('change', () => {
            captionDraft.reviewStatus = statusSelect.value;
            markDirty(item.assetId, draft);
          });
          statusLabel.appendChild(statusSelect);

          const textLabel = createTextElement('label', '编辑后的中文文本');
          const textInput = document.createElement('input');
          textInput.type = 'text';
          textInput.maxLength = 40;
          textInput.value = captionDraft.approvedText || '';
          textInput.addEventListener('input', () => {
            captionDraft.approvedText = textInput.value;
            if (captionDraft.approvedText !== (caption.suggestedText || '')
              && (captionDraft.reviewStatus === 'approved' || captionDraft.reviewStatus === 'pending')) {
              captionDraft.reviewStatus = 'edited_approved';
              statusSelect.value = 'edited_approved';
            }
            markDirty(item.assetId, draft);
          });
          textLabel.appendChild(textInput);

          const notesLabel = createTextElement('label', '人工备注');
          const notesInput = document.createElement('textarea');
          notesInput.rows = 2;
          notesInput.value = captionDraft.userNotes || '';
          notesInput.addEventListener('input', () => {
            captionDraft.userNotes = notesInput.value;
            markDirty(item.assetId, draft);
          });
          notesLabel.appendChild(notesInput);
          card.append(statusLabel, textLabel, notesLabel);

          if (item.mediaType === 'video') {
            const startLabel = createTextElement('label', '开始时间（秒）');
            const startInput = document.createElement('input');
            startInput.type = 'number';
            startInput.min = '0';
            startInput.step = '0.01';
            startInput.value = captionDraft.approvedStartTime ?? '';
            startInput.addEventListener('input', () => {
              captionDraft.approvedStartTime = startInput.value === '' ? null : Number(startInput.value);
              markDirty(item.assetId, draft);
            });
            startLabel.appendChild(startInput);

            const endLabel = createTextElement('label', '结束时间（秒）');
            const endInput = document.createElement('input');
            endInput.type = 'number';
            endInput.min = '0';
            endInput.step = '0.01';
            endInput.value = captionDraft.approvedEndTime ?? '';
            endInput.addEventListener('input', () => {
              captionDraft.approvedEndTime = endInput.value === '' ? null : Number(endInput.value);
              markDirty(item.assetId, draft);
            });
            endLabel.appendChild(endInput);

            const actions = document.createElement('div');
            actions.className = 'result-actions';
            const seekButton = createTextElement('button', '跳到此处', 'button secondary');
            seekButton.type = 'button';
            seekButton.addEventListener('click', () => seekCaption({
              ...caption,
              seekTimeSec: captionDraft.approvedStartTime ?? caption.seekTimeSec,
              approvedEndTime: captionDraft.approvedEndTime ?? caption.approvedEndTime,
            }));
            const playButton = createTextElement('button', '播放该区间', 'button secondary');
            playButton.type = 'button';
            playButton.addEventListener('click', () => playCaptionRange({
              ...caption,
              seekTimeSec: captionDraft.approvedStartTime ?? caption.seekTimeSec,
              approvedEndTime: captionDraft.approvedEndTime ?? caption.approvedEndTime,
            }));
            actions.append(seekButton, playButton);
            card.append(startLabel, endLabel, actions);
          } else {
            card.appendChild(createTextElement(
              'p',
              caption.displayTiming?.label || '在该图片镜头中显示',
              'subtitle-preview-note',
            ));
          }
          captionsSection.appendChild(card);
        });
      }
      host.appendChild(captionsSection);

      if (item.mediaType === 'video') {
        const preserve = createResultSection('视频保留状态', '优先锁定完整保留与原声保留；本阶段不做自由剪辑。');
        preserve.appendChild(createDefinitionGrid([
          ['sourceDuration', item.preservation?.sourceDuration],
          ['preserveFullClip', item.preservation?.preserveFullClip ? '是' : '否'],
          ['proposedIn', item.preservation?.proposedIn],
          ['proposedOut', item.preservation?.proposedOut],
          ['keepRatio', item.preservation?.keepRatio],
          ['trimReason', item.preservation?.trimReason || '无'],
          ['criticalMoments', asArray(item.preservation?.criticalMoments).join('；') || '无'],
          ['protectedTimeRanges', asArray(item.preservation?.protectedTimeRanges)
            .map((range) => `${range.startSec ?? range.start}–${range.endSec ?? range.end}s`)
            .join('；') || '无'],
          ['audioAvailable', item.preservation?.audioAvailable ? '是' : '否'],
          ['preserveOriginalAudio', item.preservation?.preserveOriginalAudio ? '是' : '否'],
          ['muteReason', item.preservation?.muteReason || '无'],
        ]));

        function lockLabel(text, checked, onChange) {
          const label = document.createElement('label');
          label.className = 'explanation-lock';
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = checked;
          input.addEventListener('change', () => onChange(input.checked));
          label.append(input, document.createTextNode(` ${text}`));
          return label;
        }

        preserve.append(
          lockLabel('锁定完整保留', draft.preserveFullClipLocked === true, (checked) => {
            draft.preserveFullClipLocked = checked;
            markDirty(item.assetId, draft);
          }),
          lockLabel('锁定保留原声', draft.preserveOriginalAudioLocked === true, (checked) => {
            draft.preserveOriginalAudioLocked = checked;
            markDirty(item.assetId, draft);
          }),
          lockLabel('需要人工决定是否裁剪', draft.trimNeedsHumanDecision === true, (checked) => {
            draft.trimNeedsHumanDecision = checked;
            markDirty(item.assetId, draft);
          }),
          lockLabel('需要人工决定音频处理', draft.audioNeedsHumanDecision === true, (checked) => {
            draft.audioNeedsHumanDecision = checked;
            markDirty(item.assetId, draft);
          }),
        );
        host.appendChild(preserve);
      }

      const saveRow = document.createElement('div');
      saveRow.className = 'result-actions explanation-save-row';
      const saveStatus = createTextElement(
        'span',
        state.explanationReviewDirty
          ? '有未保存修改'
          : (state.explanationReview?.updatedAt ? `已保存 · ${formatDateTime(state.explanationReview.updatedAt)}` : '尚未保存'),
        'verify-run-status',
      );
      const saveButton = createTextElement('button', '保存人工决定', 'button primary');
      saveButton.type = 'button';
      saveButton.addEventListener('click', () =>
        withBusy(saveButton, async () => {
          await saveDraft(item.assetId, draft, saveStatus);
        }, '保存中…'));
      saveRow.append(saveButton, saveStatus);
      host.appendChild(saveRow);
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'explanation-toolbar';
    const filter = document.createElement('select');
    [
      ['all', '全部'],
      ['pending', '待审阅'],
      ['confirmed', '已确认'],
      ['not_needed', '不需要字幕'],
      ['warnings', '有警告'],
      ['video', '视频'],
      ['image', '图片或漫画'],
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      if (state.explanationReviewFilter === value) option.selected = true;
      filter.appendChild(option);
    });
    filter.addEventListener('change', () => {
      state.explanationReviewFilter = filter.value;
      renderCodexProjectResult(result);
    });
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = '搜索文件名 / Story Unit / 字幕';
    search.value = state.explanationReviewQuery || '';
    search.addEventListener('change', () => {
      state.explanationReviewQuery = search.value;
      renderCodexProjectResult(result);
    });
    toolbar.append(filter, search);
    section.appendChild(toolbar);

    const layout = document.createElement('div');
    layout.className = 'explanation-layout';
    const list = document.createElement('div');
    list.className = 'explanation-list';
    const detail = document.createElement('div');
    detail.className = 'explanation-detail';
    const items = filteredItems();
    if (!items.length) {
      list.appendChild(createTextElement('p', '没有符合筛选条件的素材。', 'empty-inline'));
    } else {
      if (!items.some((item) => item.assetId === state.explanationReviewSelectedAssetId)) {
        state.explanationReviewSelectedAssetId = items[0].assetId;
      }
      items.forEach((item) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'explanation-list-item';
        if (item.assetId === state.explanationReviewSelectedAssetId) row.classList.add('selected');
        const thumb = document.createElement('div');
        thumb.className = 'explanation-thumb';
        if (item.preview?.fileUrl && item.mediaType !== 'video') {
          const image = document.createElement('img');
          image.src = item.preview.fileUrl;
          image.alt = item.filename;
          thumb.appendChild(image);
        } else {
          thumb.textContent = item.mediaType === 'video' ? '视频' : '图';
        }
        const meta = document.createElement('div');
        meta.append(
          createTextElement('strong', item.filename),
          createTextElement('p', item.storyUnitTheme || '无 Story Unit'),
          createTextElement(
            'small',
            [
              item.mediaType,
              item.chapterId || '无章节',
              item.narrativeRole || '无角色',
              item.hasVisualText ? '有画面文字' : '无画面文字',
              item.suggestsLightCaption ? '建议轻字幕' : '无轻字幕',
              `置信度 ${item.confidence ?? '—'}`,
              item.reviewRequired ? '需审阅' : '可确认',
              STATUS_LABELS[item.reviewStatus] || item.reviewStatus,
              `警告 ${item.warningCount}`,
              item.preserveFullClipLocked ? '完整保留已锁' : '完整保留未锁',
              item.preserveOriginalAudioLocked ? '原声已锁' : '原声未锁',
            ].join(' · '),
          ),
        );
        row.append(thumb, meta);
        row.addEventListener('click', () => {
          state.explanationReviewSelectedAssetId = item.assetId;
          renderDetail(item, detail);
          list.querySelectorAll('.explanation-list-item').forEach((node) => {
            node.classList.toggle('selected', node === row);
          });
        });
        list.appendChild(row);
      });
    }
    const selected = items.find((item) => item.assetId === state.explanationReviewSelectedAssetId) || items[0] || null;
    renderDetail(selected, detail);
    layout.append(list, detail);
    section.appendChild(layout);

    const exportPanel = document.createElement('div');
    exportPanel.className = 'explanation-export-panel';
    exportPanel.appendChild(createTextElement(
      'h4',
      '生成或更新 FCP 轻字幕',
    ));
    exportPanel.appendChild(createTextElement(
      'p',
      '仅导出 approved / edited_approved。不会自动写入；请先预览，确认无阻塞错误后再正式生成。',
      'muted',
    ));
    const exportStats = document.createElement('div');
    exportStats.className = 'explanation-export-stats';
    exportStats.appendChild(createTextElement('p', '尚未预览。', 'empty-inline'));
    const exportStatus = createTextElement('p', '', 'verify-run-status');
    const exportActions = document.createElement('div');
    exportActions.className = 'result-actions';
    const previewButton = createTextElement('button', '预览导出', 'button');
    previewButton.type = 'button';
    const exportButton = createTextElement('button', '生成或更新 FCP 轻字幕', 'button primary');
    exportButton.type = 'button';
    exportButton.disabled = true;

    function renderExportPreview(preview) {
      exportStats.replaceChildren();
      if (!preview) {
        exportStats.appendChild(createTextElement('p', '尚未预览。', 'empty-inline'));
        exportButton.disabled = true;
        return;
      }
      exportStats.appendChild(createDefinitionGrid([
        ['已确认字幕', String(preview.confirmedCount ?? 0)],
        ['可导出', String(preview.exportableCount ?? 0)],
        ['无匹配镜头', String(preview.unmatchedShotCount ?? 0)],
        ['时间映射失败', String(preview.mappingFailureCount ?? 0)],
        ['将新增 Title', String(preview.willAdd ?? 0)],
        ['将更新 Title', String(preview.willUpdate ?? 0)],
        ['将移除受管 Title', String(preview.willRemove ?? 0)],
        ['保持不变', String(preview.willKeep ?? 0)],
        ['冲突', String(preview.conflictCount ?? 0)],
        ['改变 Marker', preview.changesMarkers ? '是' : '否'],
        ['改变非字幕 Title', preview.changesUnmanagedTitles ? '是' : '否'],
        ['改变视频或音频', preview.changesVideoOrAudio ? '是' : '否'],
      ], 'explanation-summary-grid'));
      if (preview.noOp) {
        exportStats.appendChild(createTextElement('p', '无已确认字幕且无受管 Title，不会修改 FCPXML。', 'notice'));
      }
      if (preview.blockingErrors?.length) {
        exportStats.appendChild(createTextElement(
          'p',
          `阻塞错误：${preview.blockingErrors.join('；')}`,
          'notice warning',
        ));
      }
      if (preview.conflicts?.length) {
        exportStats.appendChild(createTextElement(
          'p',
          `冲突：${preview.conflicts.map((item) => item.message).join('；')}`,
          'notice warning',
        ));
      }
      if (preview.skipped?.length) {
        exportStats.appendChild(createTextElement(
          'p',
          `跳过 ${preview.skipped.length} 条：${preview.skipped.slice(0, 5).map((item) => `${item.captionId}（${item.reason}）`).join('；')}${preview.skipped.length > 5 ? '…' : ''}`,
          'notice',
        ));
      }
      exportButton.disabled = !(preview.ok && preview.canWrite);
      state.captionExportPreview = preview;
    }

    previewButton.addEventListener('click', () =>
      withBusy(previewButton, async () => {
        if (state.explanationReviewDirty) {
          showToast('请先保存人工决定，再预览导出。', true);
          return;
        }
        const preview = await window.plannerApi.previewCaptionFcpxmlExport(result.project.path);
        renderExportPreview(preview);
        exportStatus.textContent = preview.ok
          ? (preview.canWrite ? '预览通过，可以正式生成。' : (preview.noOp ? '无需修改 FCPXML。' : '预览完成。'))
          : `预览失败：${preview.blockingErrors?.[0] || '存在阻塞错误'}`;
        showToast(exportStatus.textContent, !preview.ok);
      }, '预览中…'));

    exportButton.addEventListener('click', () =>
      withBusy(exportButton, async () => {
        if (state.explanationReviewDirty) {
          showToast('请先保存人工决定，再导出字幕。', true);
          return;
        }
        if (!state.captionExportPreview?.canWrite) {
          showToast('请先完成无阻塞错误的预览。', true);
          return;
        }
        const confirmed = window.confirm(
          [
            `将新增 ${state.captionExportPreview.willAdd}、更新 ${state.captionExportPreview.willUpdate}、移除 ${state.captionExportPreview.willRemove} 个受管轻字幕 Title。`,
            '不会改变 Marker、非受管 Title、镜头和原声。继续？',
          ].join('\n'),
        );
        if (!confirmed) return;
        const exportResult = await window.plannerApi.exportCaptionFcpxml(result.project.path);
        if (exportResult.preview) renderExportPreview(exportResult.preview);
        if (!exportResult.ok || !exportResult.written) {
          exportStatus.textContent = exportResult.message || '导出未写入。';
          showToast(exportStatus.textContent, true);
          return;
        }
        const summary = exportResult.summary || {};
        exportStatus.textContent = [
          `已写入 ${exportResult.fcpxmlRelative || exportResult.outputPath}`,
          `新增 ${summary.added ?? 0}`,
          `更新 ${summary.updated ?? 0}`,
          `移除 ${summary.removed ?? 0}`,
          `跳过 ${summary.skipped ?? 0}`,
          exportResult.xmllint?.ok === false ? `xmllint 失败：${exportResult.xmllint.message}` : '校验通过',
        ].join(' · ');
        showToast('FCP 轻字幕已更新。');
        state.captionExportPreview = null;
        const refreshed = await window.plannerApi.getCodexProjectResult(result.project.path);
        if (state.selectedProjectResult?.project?.path === result.project.path) {
          state.selectedProjectResult = refreshed;
        }
        renderCodexProjectResult(refreshed);
      }, '生成中…'));

    exportActions.append(previewButton, exportButton);
    exportPanel.append(exportStats, exportActions, exportStatus);
    if (state.captionExportPreview) renderExportPreview(state.captionExportPreview);
    section.appendChild(exportPanel);

    return section;
  }

  global.ExplanationReviewUi = {
    STATUS_LABELS,
    createExplanationReviewSection,
  };
})(window);
