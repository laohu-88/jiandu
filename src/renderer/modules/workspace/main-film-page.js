(function createPlannerMainFilmPage(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerMainFilmPage = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function text(tag, value, className = '') {
    return (root.PlannerDom || root.PlannerUtils).createTextElement(tag, value, className);
  }

  function mount({ data, pageEl }) {
    if (!pageEl) return;
    const local = { explanationState: null };

    function render(snap) {
      if (snap.route.projectPage !== 'main') return;
      pageEl.replaceChildren();
      const result = snap.projectResult;
      if (!result) {
        pageEl.appendChild(text('div', '未打开项目', 'empty-state'));
        return;
      }

      const summary = root.PlannerDom.createResultSection(
        '主成片结果',
        '默认主成片独立保留；抖音变体修改不会改写这里的时间线。',
      );
      summary.appendChild(root.PlannerDom.createDefinitionGrid([
        ['状态', result.project?.statusLabel || result.project?.status || '—'],
        ['主题', result.summary?.theme || '—'],
        ['建议标题', result.summary?.recommendedTitle || '—'],
        ['镜头数', String(result.timeline?.shotCount ?? result.timeline?.shots?.length ?? '—')],
        ['时长', root.PlannerDom.formatResultDuration(result.timeline?.totalDurationSec)],
        ['预览', result.artifacts?.preview?.exists ? '可用' : '无'],
        ['FCPXML', result.artifacts?.fcpxml?.exists ? '可用' : '无'],
      ]));

      const actions = document.createElement('div');
      actions.className = 'result-actions';
      const play = text('button', '播放预览', 'button secondary');
      play.type = 'button';
      play.disabled = !result.artifacts?.preview?.fileUrl;
      play.addEventListener('click', () => {
        const video = pageEl.querySelector('video.result-video');
        if (video) {
          video.play();
          video.scrollIntoView({ block: 'nearest' });
        }
      });
      const openFcp = text('button', '在 Final Cut Pro 中打开', 'button primary');
      openFcp.type = 'button';
      openFcp.addEventListener('click', () => root.PlannerUtils.withBusy(openFcp, async () => {
        await data.api.openProjectFcpxmlInFinalCut(result.project.path);
      }, '正在打开…', data.toast));
      const openDir = text('button', '打开输出目录', 'button secondary');
      openDir.type = 'button';
      openDir.addEventListener('click', () => root.PlannerUtils.withBusy(openDir, async () => {
        await data.api.runProjectArtifactAction({
          projectPath: result.project.path,
          target: 'exportDirectory',
        });
      }, '正在打开…', data.toast));
      actions.append(play, openDir, openFcp);
      summary.appendChild(actions);

      if (result.artifacts?.preview?.fileUrl) {
        const shell = document.createElement('div');
        shell.className = 'result-video-shell';
        const video = document.createElement('video');
        video.className = 'result-video';
        video.controls = true;
        video.preload = 'metadata';
        video.src = result.artifacts.preview.fileUrl;
        const overlay = text('div', '', 'result-subtitle-overlay subtitle-bottom-safe hidden');
        shell.append(video, overlay);
        summary.appendChild(shell);

        const playback = {
          result,
          video,
          overlay,
          currentTime: text('p', '00:00:00:00 · 0.000 秒', 'result-current-time'),
          playhead: null,
          markerRows: new Map(),
          shotRows: new Map(),
          activeMarkerKey: null,
          previewMarkerKey: null,
        };
        summary.appendChild(playback.currentTime);
        ['loadedmetadata', 'timeupdate', 'seeked', 'ended'].forEach((eventName) => {
          video.addEventListener(eventName, () => {
            root.PlannerResultPlayback?.updateResultPlayback?.(playback);
          });
        });

        if (root.PlannerResultPlayback?.createReadOnlyTimeline) {
          summary.appendChild(root.PlannerResultPlayback.createReadOnlyTimeline(result, playback));
        }
        if (root.PlannerResultPlayback?.renderSubtitleSuggestions) {
          summary.appendChild(root.PlannerResultPlayback.renderSubtitleSuggestions(result, playback));
        }
      }

      pageEl.appendChild(summary);

      if (result.platformVariants == null) {
        pageEl.appendChild(text(
          'p',
          '旧项目尚未包含平台变体；可继续审阅主成片，或稍后在抖音版本页创建变体。',
          'notice neutral',
        ));
      }

      if (window.ExplanationReviewUi?.createExplanationReviewSection) {
        if (!local.explanationState) {
          local.explanationState = {
            explanationReview: null,
            explanationReviewFilter: 'all',
            explanationReviewQuery: '',
            explanationReviewSelectedAssetId: null,
            explanationReviewDrafts: {},
            explanationReviewDirty: false,
            explanationAssetPlayback: null,
            captionExportPreview: null,
            resultPlayback: null,
          };
        }
        pageEl.appendChild(window.ExplanationReviewUi.createExplanationReviewSection({
          result,
          state: local.explanationState,
          createResultSection: root.PlannerDom.createResultSection,
          createDefinitionGrid: root.PlannerDom.createDefinitionGrid,
          createTextElement: text,
          formatDateTime: root.PlannerUtils.formatDateTime,
          showToast: data.toast,
          withBusy: (button, action, busyText) => root.PlannerUtils.withBusy(button, action, busyText, data.toast),
          renderCodexProjectResult: () => data.refreshProject(result.project.path),
        }));
      }
    }

    data.subscribe(render);
    render(data.get());
  }

  return { mount };
}));
