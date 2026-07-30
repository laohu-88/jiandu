(function createPlannerOutputsPage(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerOutputsPage = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function text(tag, value, className = '') {
    return (root.PlannerDom || root.PlannerUtils).createTextElement(tag, value, className);
  }

  function mount({ data, pageEl }) {
    if (!pageEl) return;

    function render(snap) {
      if (snap.route.projectPage !== 'outputs') return;
      pageEl.replaceChildren();
      const result = snap.projectResult;
      pageEl.appendChild(text('h2', '输出结果'));
      pageEl.appendChild(text(
        'p',
        '生成结果是可编辑预览与 FCP 时间线，不是最终可发布 MP4。',
        'notice neutral',
      ));

      if (!result) {
        pageEl.appendChild(text('div', '未打开项目', 'empty-state'));
        return;
      }

      const main = root.PlannerDom.createResultSection('主成片输出');
      main.appendChild(root.PlannerDom.createDefinitionGrid([
        ['预览', result.artifacts?.preview?.path || (result.artifacts?.preview?.exists ? '存在' : '无')],
        ['FCPXML', result.artifacts?.fcpxml?.path || (result.artifacts?.fcpxml?.exists ? '存在' : '无')],
        ['导出目录', result.artifacts?.exportDirectory?.path || '—'],
      ]));
      const mainActions = document.createElement('div');
      mainActions.className = 'result-actions';
      [
        ['播放预览', async (button) => {
          if (!result.artifacts?.preview?.fileUrl) {
            data.toast('暂无主成片预览。', true);
            return;
          }
          await data.api.runProjectArtifactAction({
            projectPath: result.project.path,
            target: 'preview',
          });
        }],
        ['查看验证报告', async () => {
          await data.api.runProjectArtifactAction({
            projectPath: result.project.path,
            target: 'validation',
          });
        }],
        ['打开输出目录', async () => {
          await data.api.runProjectArtifactAction({
            projectPath: result.project.path,
            target: 'exportDirectory',
          });
        }],
        ['在 Final Cut Pro 中打开', async () => {
          await data.api.openProjectFcpxmlInFinalCut(result.project.path);
        }],
      ].forEach(([label, action]) => {
        const button = text('button', label, 'button secondary');
        button.type = 'button';
        button.addEventListener('click', () => root.PlannerUtils.withBusy(button, () => action(button), '处理中…', data.toast));
        mainActions.appendChild(button);
      });
      main.appendChild(mainActions);
      pageEl.appendChild(main);

      if (window.ExplanationReviewUi?.createExplanationReviewSection && result.explanationReview) {
        const reviewState = {
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
        pageEl.appendChild(window.ExplanationReviewUi.createExplanationReviewSection({
          result,
          state: reviewState,
          createResultSection: root.PlannerDom.createResultSection,
          createDefinitionGrid: root.PlannerDom.createDefinitionGrid,
          createTextElement: text,
          formatDateTime: root.PlannerUtils.formatDateTime,
          showToast: data.toast,
          withBusy: (button, action, busyText) => root.PlannerUtils.withBusy(button, action, busyText, data.toast),
          renderCodexProjectResult: () => data.refreshProject(result.project.path),
        }));
      }

      const douyin = root.PlannerDom.createResultSection('抖音输出');
      if (!snap.douyinVariant) {
        douyin.appendChild(text('p', '尚无抖音变体输出。', 'empty-inline'));
      } else if (root.DouyinEditorCore?.renderDouyinOutputs) {
        root.DouyinEditorCore.renderDouyinOutputs(douyin, result, snap.douyinVariant);
      }
      pageEl.appendChild(douyin);
    }

    data.subscribe(render);
    render(data.get());
  }

  return { mount };
}));
