(function createPlannerDouyinPage(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerDouyinPage = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  function text(tag, value, className = '') {
    return (root.PlannerDom || root.PlannerUtils).createTextElement(tag, value, className);
  }

  function mount({ data, router, pageEl }) {
    if (!pageEl) return;
    let session = null;
    let sessionKey = null;

    const stagePlan = pageEl.querySelector('#douyinStagePlan');
    const stageIssues = pageEl.querySelector('#douyinStageIssues');
    const stagePreview = pageEl.querySelector('#douyinStagePreview');
    const stageDeliver = pageEl.querySelector('#douyinStageDeliver');
    const stageRail = pageEl.querySelector('.douyin-stage-rail');
    const actionBar = pageEl.querySelector('.sticky-action-bar');

    function ensureSession(snap) {
      const variant = snap.douyinVariant;
      const result = snap.projectResult;
      if (!variant || !result) {
        session = null;
        sessionKey = null;
        return null;
      }
      const key = `${result.project.path}:${variant.variantId}:${variant.revision}`;
      if (session && sessionKey === key && !snap.draftDirty) {
        // keep session when not externally refreshed cleanly
      }
      if (!session || sessionKey !== key) {
        session = root.DouyinEditorCore.createSession({
          result,
          variant: {
            ...variant,
            plan: snap.draftPlan || variant.plan,
          },
          getPreviewState: () => data.get().douyinPreview,
          setPreviewState: (value) => data.patch({ douyinPreview: value }),
          onDraftChange: ({ draftPlan, dirty, approvedWarningIds }) => {
            data.setDraftPlan(draftPlan, { dirty });
            if (approvedWarningIds) data.setApprovedWarningIds(approvedWarningIds);
          },
        });
        // hydrate approved warnings from store
        session.approvedWarnings.clear();
        (snap.approvedWarningIds || []).forEach((id) => session.approvedWarnings.add(id));
        if (snap.draftPlan) session.replaceDraftPlan(snap.draftPlan);
        sessionKey = key;
      }
      return session;
    }

    function renderStageRail(snap) {
      if (!stageRail) return;
      stageRail.replaceChildren();
      const stages = snap.douyinWorkflow?.stages || (root.DouyinWorkflowViewModel?.DOUYIN_STAGES || []).map((s) => ({
        ...s,
        status: 'upcoming',
        summary: '',
      }));
      stages.forEach((stage) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `stage-rail-item status-${stage.status}`;
        button.classList.toggle('active', snap.route.douyinStage === stage.id);
        button.append(
          text('strong', stage.label || stage.shortLabel || stage.id),
          text('span', stage.summary || stage.status, 'muted'),
        );
        button.addEventListener('click', () => router.setDouyinStage(stage.id));
        stageRail.appendChild(button);
      });
    }

    function renderPlanStage(snap, sess) {
      if (!stagePlan) return;
      stagePlan.replaceChildren();
      const draftPlan = sess.getDraftPlan();
      const { helpers, labels, assetsById, variant } = sess;
      const {
        createDouyinControl,
        createDouyinSelect,
        nextDouyinId,
        douyinDefaultLayout,
        updateDouyinOpening,
        cloneDouyinPlan,
      } = helpers;

      stagePlan.appendChild(root.PlannerDom.createDefinitionGrid([
        ['变体', `${variant.variantId} · revision ${variant.revision}`],
        ['状态', snap.douyinWorkflow?.statusLabel || variant.status],
        ['成片数', String(draftPlan.videos.length)],
        ['选用素材', String(draftPlan.selection.filter((s) => s.decision === 'selected').length)],
      ], 'douyin-summary-grid'));

      const selectionBlock = document.createElement('div');
      selectionBlock.className = 'douyin-block';
      selectionBlock.appendChild(text('h4', '选材结论'));
      draftPlan.selection.forEach((selection) => {
        const asset = assetsById.get(selection.assetId);
        const row = document.createElement('article');
        row.className = 'douyin-selection-row';
        const identity = document.createElement('div');
        identity.className = 'douyin-selection-identity';
        identity.append(
          text('strong', asset?.filename || selection.assetId),
          text('small', `${asset?.type || '未知'} · ${selection.assetId}`),
        );
        const decision = createDouyinSelect('结论', selection.decision, labels.decision, (value) => {
          if (selection.decision === value) return;
          if (value === 'selected') {
            const target = draftPlan.videos[0];
            if (!target) {
              data.toast('请先保留至少一条成片计划。', true);
              return;
            }
            const duration = asset?.type === 'video' ? Number(asset.metadata?.durationSec) || 2 : 2;
            target.shots.push({
              shotId: nextDouyinId('douyin-shot', draftPlan),
              assetId: selection.assetId,
              inSec: 0,
              outSec: duration,
              purpose: '人工确认选入抖音成片',
              audioMode: 'keep',
              muteReason: null,
              layout: douyinDefaultLayout(asset),
            });
            updateDouyinOpening(target);
          } else {
            draftPlan.videos.forEach((video) => {
              const removed = new Set(video.shots.filter((shot) => shot.assetId === selection.assetId).map((s) => s.shotId));
              video.shots = video.shots.filter((shot) => shot.assetId !== selection.assetId);
              video.lightCaptions = video.lightCaptions.filter((caption) => !removed.has(caption.shotId));
              updateDouyinOpening(video);
            });
            draftPlan.videos = draftPlan.videos.filter((video) => video.shots.length > 0);
            if (!draftPlan.videos.length) {
              data.toast('至少保留一个选用素材和一条成片计划。', true);
              sess.replaceDraftPlan(cloneDouyinPlan(variant.plan));
              sess.markDirty();
              return;
            }
          }
          selection.decision = value;
          sess.markDirty();
        });
        const reason = createDouyinControl('明确原因', selection.reason, (value) => {
          selection.reason = value;
          sess.markDirty();
        }, { multiline: true });
        row.append(identity, decision, reason);
        selectionBlock.appendChild(row);
      });
      stagePlan.appendChild(selectionBlock);

      const planHeader = document.createElement('div');
      planHeader.className = 'douyin-block-heading';
      planHeader.appendChild(text('h4', '多成片规划与镜头顺序'));
      const splitSource = [...draftPlan.videos].sort((a, b) => b.shots.length - a.shots.length)[0];
      const newButton = text('button', '新建成片计划', 'button secondary');
      newButton.type = 'button';
      newButton.disabled = !splitSource || splitSource.shots.length < 2;
      newButton.addEventListener('click', () => {
        const shot = splitSource.shots.pop();
        const videoId = nextDouyinId('douyin', draftPlan);
        const captions = splitSource.lightCaptions.filter((item) => item.shotId === shot.shotId);
        splitSource.lightCaptions = splitSource.lightCaptions.filter((item) => item.shotId !== shot.shotId);
        updateDouyinOpening(splitSource);
        draftPlan.videos.push({
          videoId,
          theme: `新抖音主题 ${draftPlan.videos.length + 1}`,
          rationale: '由人工从现有计划拆分，按独立主题继续调整。',
          openingAssetId: shot.assetId,
          naturalEnding: '在当前素材的信息点完成处自然结束。',
          shots: [shot],
          lightCaptions: captions,
          warnings: [],
        });
        sess.markDirty();
      });
      planHeader.appendChild(newButton);
      stagePlan.appendChild(planHeader);

      draftPlan.videos.forEach((video, videoIndex) => {
        const card = document.createElement('article');
        card.className = 'douyin-video-card';
        card.append(
          text('strong', `成片 ${videoIndex + 1} · ${video.videoId}`),
          createDouyinControl('主题', video.theme, (value) => { video.theme = value; sess.markDirty(); }),
          createDouyinControl('主题依据', video.rationale, (value) => { video.rationale = value; sess.markDirty(); }, { multiline: true }),
        );
        const shots = document.createElement('ol');
        shots.className = 'douyin-shot-order';
        video.shots.forEach((shot, shotIndex) => {
          const asset = assetsById.get(shot.assetId);
          const li = document.createElement('li');
          li.append(
            text('strong', `${shotIndex + 1}. ${asset?.filename || shot.assetId}`),
            text('span', shot.purpose || shot.shotId, 'muted'),
          );
          const up = text('button', '上移', 'button ghost');
          up.type = 'button';
          up.disabled = shotIndex === 0;
          up.addEventListener('click', () => {
            [video.shots[shotIndex - 1], video.shots[shotIndex]] = [video.shots[shotIndex], video.shots[shotIndex - 1]];
            updateDouyinOpening(video);
            sess.markDirty();
          });
          const down = text('button', '下移', 'button ghost');
          down.type = 'button';
          down.disabled = shotIndex === video.shots.length - 1;
          down.addEventListener('click', () => {
            [video.shots[shotIndex + 1], video.shots[shotIndex]] = [video.shots[shotIndex], video.shots[shotIndex + 1]];
            updateDouyinOpening(video);
            sess.markDirty();
          });
          const split = text('button', '从中点连续拆分', 'button secondary');
          split.type = 'button';
          split.disabled = shot.outSec - shot.inSec < 0.2;
          split.addEventListener('click', () => {
            const midpoint = Number(((shot.inSec + shot.outSec) / 2).toFixed(6));
            const nextShot = {
              ...JSON.parse(JSON.stringify(shot)),
              shotId: nextDouyinId('douyin-shot', draftPlan),
              inSec: midpoint,
              purpose: '同源连续片段：展示下一操作区域或最终结果',
              layout: { ...helpers.cloneDouyinLayout(shot.layout), mode: 'segmented_focus' },
            };
            shot.outSec = midpoint;
            shot.purpose = '同源连续片段：展示完整界面或当前操作区域';
            video.shots.splice(shotIndex + 1, 0, nextShot);
            sess.markDirty();
          });
          li.append(up, down, split);
          shots.appendChild(li);
        });
        card.appendChild(shots);
        stagePlan.appendChild(card);
      });
    }

    function renderIssuesStage(snap, sess) {
      if (!stageIssues) return;
      stageIssues.replaceChildren();
      stageIssues.appendChild(text('h4', '问题与确认'));
      const issues = (snap.issues || []).filter((issue) => (
        issue.level === 'blocking' || issue.level === 'confirm' || issue.level === 'suggestion' || issue.level === 'info'
      ));
      const summary = snap.issueSummary || {};
      stageIssues.appendChild(text(
        'p',
        `阻断 ${summary.blocking || 0} · 确认 ${summary.confirm || 0} · 建议 ${summary.suggestion || 0} · 信息 ${summary.info || 0}`,
        'muted',
      ));

      const list = document.createElement('div');
      list.className = 'review-list';
      issues.forEach((issue) => {
        const row = document.createElement('article');
        row.className = `review-row ${issue.resolved ? 'resolved' : ''}`;
        row.append(text('strong', `[${issue.level}] ${issue.message}`));
        if (issue.level === 'confirm' && issue.warningId) {
          const label = document.createElement('label');
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = sess.approvedWarnings.has(issue.warningId);
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) sess.approvedWarnings.add(issue.warningId);
            else sess.approvedWarnings.delete(issue.warningId);
            data.setApprovedWarningIds([...sess.approvedWarnings]);
          });
          label.append(checkbox, text('span', '确认此警告'));
          row.appendChild(label);
        }
        const jump = text('button', '跳到镜头', 'button ghost');
        jump.type = 'button';
        jump.addEventListener('click', () => {
          if (issue.shotId || issue.videoId) {
            data.patch({
              douyinPreview: {
                variantId: snap.douyinVariant?.variantId,
                videoId: issue.videoId,
                shotId: issue.shotId,
                beforeCrop: false,
              },
            });
            router.setDouyinStage('preview');
          } else {
            router.setProjectPage('review');
          }
        });
        row.appendChild(jump);
        list.appendChild(row);
      });
      const batch = text('button', '确认全部待确认警告', 'button secondary');
      batch.type = 'button';
      batch.addEventListener('click', () => {
        issues.filter((issue) => issue.level === 'confirm' && issue.warningId)
          .forEach((issue) => sess.approvedWarnings.add(issue.warningId));
        data.setApprovedWarningIds([...sess.approvedWarnings]);
      });
      const recheck = text('button', '重新检查', 'button ghost');
      recheck.type = 'button';
      recheck.addEventListener('click', () => data.refreshProject());
      stageIssues.append(list, batch, recheck);
    }

    function renderPreviewStage(snap, sess) {
      if (!stagePreview || !sess) return;
      stagePreview.replaceChildren();
      stagePreview.classList.add('editor-workspace');
      const draftPlan = sess.getDraftPlan();
      if (!draftPlan?.videos?.length) {
        stagePreview.appendChild(text('p', '暂无镜头可预览。请先在方案中选入素材。', 'empty-state'));
        return;
      }
      const selectionById = new Map(draftPlan.selection.map((item) => [item.assetId, item]));
      const { helpers, labels, assetsById, variant } = sess;
      const {
        createDouyinControl,
        createDouyinSelect,
        createDouyinCropEditor,
        ensureDouyinLayout,
        cloneDouyinLayout,
        douyinDefaultLayout,
        douyinReadabilityFindings,
        recommendDouyinCaptionPosition,
        rebuildDouyinTrackingKeyframes,
        nextDouyinId,
      } = helpers;

      let previewState = snap.douyinPreview;
      if (!previewState?.shotId || !previewState?.videoId) {
        const firstVideo = draftPlan.videos[0];
        const firstShot = firstVideo?.shots?.[0];
        if (firstShot) {
          previewState = {
            variantId: variant.variantId,
            videoId: firstVideo.videoId,
            shotId: firstShot.shotId,
            beforeCrop: false,
          };
          data.patch({ douyinPreview: previewState });
        }
      }

      const layout = document.createElement('div');
      layout.className = 'douyin-editor-layout';
      const canvasPane = document.createElement('div');
      canvasPane.className = 'douyin-canvas-pane';
      canvasPane.appendChild(text('h4', '预览与调整'));
      try {
        sess.renderVerticalPreview(canvasPane, draftPlan, selectionById);
      } catch (error) {
        canvasPane.appendChild(text('p', root.PlannerUtils?.getUserErrorMessage?.(error) || String(error), 'notice warning'));
      }

      const side = document.createElement('div');
      side.className = 'douyin-inspector-pane';
      const shotList = document.createElement('div');
      shotList.className = 'douyin-shot-list compact';
      draftPlan.videos.forEach((video) => {
        video.shots.forEach((shot, shotIndex) => {
          const asset = assetsById.get(shot.assetId);
          const row = text('button', `${video.theme} · ${shotIndex + 1}. ${asset?.filename || shot.assetId}`, 'shot-pick');
          row.type = 'button';
          if (snap.douyinPreview?.shotId === shot.shotId) row.classList.add('active');
          row.addEventListener('click', () => {
            data.patch({
              douyinPreview: {
                variantId: variant.variantId,
                videoId: video.videoId,
                shotId: shot.shotId,
                beforeCrop: false,
              },
            });
          });
          shotList.appendChild(row);
        });
      });
      side.appendChild(shotList);

      const preview = previewState || snap.douyinPreview;
      const currentVideo = draftPlan.videos.find((video) => video.videoId === preview?.videoId) || draftPlan.videos[0];
      const currentShot = currentVideo?.shots.find((shot) => shot.shotId === preview?.shotId) || currentVideo?.shots[0];
      if (currentShot) {
        currentShot.layout = ensureDouyinLayout(currentShot.layout);
        const asset = assetsById.get(currentShot.assetId);
        const inspector = document.createElement('div');
        inspector.className = 'douyin-inspector';
        inspector.append(
          text('h5', '镜头检查器'),
          createDouyinSelect('竖屏布局', currentShot.layout.mode, labels.layout, (value) => {
            currentShot.layout.mode = value;
            sess.markDirty();
            render(data.get());
          }),
          createDouyinControl('缩放', currentShot.layout.scale, (value) => {
            currentShot.layout.scale = value;
            sess.markDirty();
          }, { type: 'number', min: 0.1, max: 8, step: 0.05 }),
          createDouyinControl('原画小字高度(px)', currentShot.layout.minReadableTextHeightPx, (value) => {
            currentShot.layout.minReadableTextHeightPx = Number.isFinite(value) && value > 0 ? value : null;
            sess.markDirty();
          }, { type: 'number', min: 1, max: 1000, step: 1 }),
          createDouyinControl('位置 X', currentShot.layout.position.x, (value) => {
            currentShot.layout.position.x = value;
            sess.markDirty();
          }, { type: 'number', min: -1, max: 1, step: 0.01 }),
          createDouyinControl('位置 Y', currentShot.layout.position.y, (value) => {
            currentShot.layout.position.y = value;
            sess.markDirty();
          }, { type: 'number', min: -1, max: 1, step: 0.01 }),
          createDouyinSelect('视频原声', currentShot.audioMode, { keep: '保留原声', mute: '静音' }, (value) => {
            currentShot.audioMode = value;
            if (value === 'keep') currentShot.muteReason = null;
            sess.markDirty();
          }),
        );
        const copyPrevious = text('button', '复制上一镜头布局', 'button ghost');
        copyPrevious.type = 'button';
        const idx = currentVideo.shots.indexOf(currentShot);
        copyPrevious.disabled = idx <= 0;
        copyPrevious.addEventListener('click', () => {
          currentShot.layout = cloneDouyinLayout(currentVideo.shots[idx - 1].layout);
          sess.markDirty();
        });
        const restore = text('button', '恢复 Agent 建议值', 'button ghost');
        restore.type = 'button';
        restore.addEventListener('click', () => {
          currentShot.layout = cloneDouyinLayout(currentShot.agentLayout || douyinDefaultLayout(asset));
          sess.markDirty();
        });
        inspector.append(copyPrevious, restore);
        if (currentShot.layout.mode === 'screen_split') {
          inspector.append(
            createDouyinControl('上下区域比例', currentShot.layout.splitRatio, (value) => {
              currentShot.layout.splitRatio = value;
              sess.markDirty();
            }, { type: 'number', min: 0.25, max: 0.75, step: 0.01 }),
          );
        }
        inspector.appendChild(createDouyinCropEditor(asset, currentShot, () => sess.markDirty()));

        if (asset?.type === 'video'
          && (currentShot.layout.mode === 'subject_track' || currentShot.layout.tracking)) {
          const trackingBlock = document.createElement('section');
          trackingBlock.className = 'douyin-tracking-editor';
          trackingBlock.appendChild(text('h5', '动态主体跟踪'));
          const subjectType = currentShot.layout.tracking?.subjectType || 'moving_object';
          const analyze = text('button', '自动分析主体轨迹', 'button secondary');
          analyze.type = 'button';
          analyze.addEventListener('click', () => root.PlannerUtils.withBusy(analyze, async () => {
            const analyzed = await data.api.analyzeDouyinShotTracking({
              projectPath: snap.projectResult.project.path,
              variantId: variant.variantId,
              videoId: currentVideo.videoId,
              shotId: currentShot.shotId,
              subjectType,
              safeMargin: currentShot.layout.tracking?.safeMargin ?? 0.03,
              fallbackMode: currentShot.layout.tracking?.fallback?.mode || 'landscape_card_blur',
            });
            sess.replaceDraftPlan(analyzed.proposedPlan);
            data.setDraftPlan(analyzed.proposedPlan, { dirty: true });
            sessionKey = null;
            render(data.get());
          }, '正在按源视频时间范围采样分析…', data.toast));
          trackingBlock.append(
            createDouyinSelect(
              '主体类型',
              subjectType,
              labels.subjectType || {},
              (value) => {
                if (!currentShot.layout.tracking) {
                  currentShot.layout.tracking = {
                    enabled: true,
                    subjectType: value,
                    status: 'failed',
                    confidence: 0,
                    safeMargin: 0.03,
                    sampleIntervalSec: null,
                    points: [],
                    keyframes: [],
                    locks: [],
                    manualConfirmation: 'pending',
                    fallback: {
                      mode: 'landscape_card_blur',
                      reason: '等待自动分析或人工指定主体区域。',
                      applied: false,
                    },
                    warnings: [],
                  };
                } else {
                  currentShot.layout.tracking.subjectType = value;
                }
                currentShot.layout.mode = 'subject_track';
                sess.markDirty();
              },
            ),
            analyze,
          );
          const tracking = currentShot.layout.tracking;
          if (tracking) {
            trackingBlock.append(
              text(
                'p',
                `状态：${tracking.status} · 置信度 ${Number(tracking.confidence || 0).toFixed(2)} · ${(tracking.keyframes || []).length} 个关键帧`,
                'douyin-tracking-summary',
              ),
              createDouyinControl('主体安全边距', tracking.safeMargin, (value) => {
                tracking.safeMargin = value;
                sess.markDirty();
              }, { type: 'number', min: 0, max: 0.2, step: 0.01 }),
              createDouyinSelect(
                '人工确认',
                tracking.manualConfirmation,
                {
                  pending: '待确认',
                  approved_continue: '确认继续使用',
                  corrected: '已人工修正',
                  fallback: '已切换静态布局',
                },
                (value) => {
                  tracking.manualConfirmation = value;
                  sess.markDirty();
                },
              ),
            );
            const fallback = text('button', '切换至建议静态布局', 'button secondary');
            fallback.type = 'button';
            fallback.addEventListener('click', () => {
              tracking.fallback.applied = true;
              tracking.fallback.reason = tracking.fallback.reason
                || '人工判断动态主体跟踪不稳定，切换现有静态布局。';
              tracking.manualConfirmation = 'fallback';
              tracking.status = 'fallback';
              currentShot.layout.mode = tracking.fallback.mode || 'landscape_card_blur';
              sess.markDirty();
            });
            trackingBlock.appendChild(fallback);
            void rebuildDouyinTrackingKeyframes;
            void nextDouyinId;
          }
          inspector.appendChild(trackingBlock);
        }

        const findings = douyinReadabilityFindings(currentShot);
        if (findings.length) {
          const notice = text('ul', '', 'douyin-readability-notice');
          findings.forEach((finding) => notice.appendChild(text('li', finding)));
          inspector.appendChild(notice);
        }
        if (currentVideo.lightCaptions?.length) {
          const captions = document.createElement('div');
          captions.appendChild(text('h5', '轻字幕'));
          currentVideo.lightCaptions.filter((c) => c.shotId === currentShot.shotId).forEach((caption) => {
            captions.append(
              createDouyinControl('字幕', caption.text, (value) => { caption.text = value; sess.markDirty(); }, {
                disabled: caption.sourceLocked,
              }),
              createDouyinSelect(
                '字幕类型',
                caption.kind || 'content',
                labels.captionKind,
                (value) => {
                  caption.kind = value;
                  caption.position = recommendDouyinCaptionPosition(currentVideo, caption, variant.profile);
                  sess.markDirty();
                },
              ),
              createDouyinSelect('位置', caption.position, Object.fromEntries(
                Object.keys(variant.profile.subtitlePlacements).map((key) => [key, key]),
              ), (value) => { caption.position = value; sess.markDirty(); }),
            );
          });
          inspector.appendChild(captions);
        }
        side.appendChild(inspector);
      }

      layout.append(canvasPane, side);
      stagePreview.appendChild(layout);
    }

    function renderDeliverStage(snap, sess) {
      if (!stageDeliver) return;
      stageDeliver.replaceChildren();
      stageDeliver.appendChild(text('h4', '抖音结果'));
      stageDeliver.appendChild(text('h4', '生成与交付'));
      const notices = document.createElement('ul');
      notices.className = 'notice-list';
      (snap.douyinWorkflow?.notices || []).forEach((line) => notices.appendChild(text('li', line)));
      stageDeliver.appendChild(notices);
      const createAnother = text('button', '新建抖音变体', 'button secondary');
      createAnother.type = 'button';
      createAnother.addEventListener('click', () => root.PlannerUtils.withBusy(createAnother, async () => {
        const existing = (snap.projectResult.platformVariants?.variants || [])
          .filter((item) => item.platform === 'douyin');
        let variantId = `douyin-${existing.length + 1}`;
        while (existing.some((item) => item.variantId === variantId)) {
          variantId = `douyin-${Number(variantId.split('-').at(-1) || 1) + 1}`;
        }
        await data.api.createDouyinVariant({
          projectPath: snap.projectResult.project.path,
          variantId,
        });
        data.toast(`已创建独立抖音变体 ${variantId}。`);
        await data.refreshProject(snap.projectResult.project.path);
      }, '正在创建…', data.toast));
      stageDeliver.appendChild(createAnother);
      sess.renderOutputs(stageDeliver);
    }

    async function runAction(actionId, button) {
      const snap = data.get();
      const sess = ensureSession(snap);
      if (!sess || !snap.douyinVariant || !snap.projectResult) return;
      const projectPath = snap.projectResult.project.path;
      const variantId = snap.douyinVariant.variantId;
      const draftPlan = sess.getDraftPlan();
      const approvedWarningIds = [...sess.approvedWarnings];

      await root.PlannerUtils.withBusy(button, async () => {
        if (actionId === 'saveDraft') {
          await data.api.saveDouyinVariant({
            projectPath,
            variantId,
            plan: draftPlan,
            expectedRevision: snap.douyinVariant.revision,
          });
          data.toast('抖音规划已保存；默认主成片未修改。');
          await data.refreshProject(projectPath);
          session = null;
          return;
        }
        if (actionId === 'confirmIssues') {
          router.setDouyinStage('issues');
          return;
        }
        if (actionId === 'approve') {
          const saved = (sess.isDirty() || snap.draftDirty)
            ? await data.api.saveDouyinVariant({
              projectPath,
              variantId,
              plan: draftPlan,
              expectedRevision: snap.douyinVariant.revision,
            })
            : snap.douyinVariant;
          const missingWarningIds = (saved.plan?.videos || draftPlan.videos)
            .flatMap((video) => video.warnings || [])
            .map((warning) => warning.warningId)
            .filter((warningId) => !approvedWarningIds.includes(warningId));
          if (missingWarningIds.length) {
            await data.refreshProject(projectPath);
            session = null;
            data.toast('规划已保存并产生待确认警告；请先确认待处理问题后再批准。', true);
            router.setDouyinStage('issues');
            return;
          }
          await data.api.approveDouyinVariant({
            projectPath,
            variantId,
            approvedWarningIds,
          });
          data.toast('已批准当前抖音方案。');
          await data.refreshProject(projectPath);
          session = null;
          return;
        }
        if (actionId === 'generate') {
          await data.api.buildDouyinVariant({ projectPath, variantId });
          data.toast('已生成预览与 FCP 时间线。最终发布 MP4 需在 Final Cut Pro 中导出。');
          await data.refreshProject(projectPath);
          session = null;
          return;
        }
        if (actionId === 'playPreview') {
          const output = snap.douyinVariant.outputs?.find((item) => item.artifacts?.preview?.fileUrl)
            || snap.douyinVariant.outputs?.[0];
          if (output?.artifacts?.preview?.fileUrl) {
            await data.api.runDouyinArtifactAction({
              projectPath,
              variantId,
              videoId: output.videoId,
              target: 'preview',
            });
          } else {
            data.toast('暂无预览可播放。', true);
          }
          return;
        }
        if (actionId === 'viewVerification') {
          const report = await data.api.verifyDouyinVariant({ projectPath, variantId });
          data.toast(report.ok ? '验证通过。' : `验证失败：${report.reports?.[0]?.errors?.[0] || '未知错误'}`, !report.ok);
          return;
        }
        if (actionId === 'openOutputDir') {
          const output = snap.douyinVariant.outputs?.[0];
          if (!output) {
            data.toast('尚无输出目录。', true);
            return;
          }
          await data.api.runDouyinArtifactAction({
            projectPath,
            variantId,
            videoId: output.videoId,
            target: 'outputDirectory',
          });
          return;
        }
        if (actionId === 'openInFcp') {
          const output = snap.douyinVariant.outputs?.[0];
          if (!output) {
            data.toast('尚无 FCP 时间线。', true);
            return;
          }
          await data.api.openDouyinFcpxmlInFinalCut({
            projectPath,
            variantId,
            videoId: output.videoId,
          });
        }
      }, '处理中…', data.toast);
    }

    function renderActionBar(snap) {
      if (!actionBar) return;
      actionBar.replaceChildren();
      const labels = root.DouyinWorkflowViewModel?.ACTION_LABELS || {};
      const next = snap.douyinWorkflow?.nextAction;
      const actions = [
        { id: 'saveDraft', primary: next?.id === 'saveDraft' },
        { id: 'confirmIssues', primary: next?.id === 'confirmIssues' },
        { id: 'approve', primary: next?.id === 'approve' },
        { id: 'generate', primary: next?.id === 'generate' },
        { id: 'playPreview', primary: next?.id === 'playPreview' },
        { id: 'viewVerification', primary: next?.id === 'viewVerification' },
        { id: 'openOutputDir', primary: false },
        { id: 'openInFcp', primary: next?.id === 'openInFcp' },
      ];
      actions.forEach((action) => {
        const button = text('button', labels[action.id] || action.id, action.primary ? 'button primary' : 'button secondary');
        button.type = 'button';
        if (next?.id === action.id && next.blocked) {
          button.disabled = true;
          button.title = next.blockReason || next.reason || '';
        }
        if (['playPreview', 'viewVerification', 'openOutputDir', 'openInFcp'].includes(action.id)
          && !(snap.douyinVariant?.outputs?.length)) {
          button.disabled = true;
        }
        button.addEventListener('click', () => runAction(action.id, button));
        actionBar.appendChild(button);
      });
      if (next?.blocked && next?.blockReason) {
        actionBar.appendChild(text('p', `当前无法继续：${next.blockReason}${next.resolveHint ? ` → ${next.resolveHint}` : ''}`, 'action-block-reason notice warning'));
      } else if (next?.reason) {
        actionBar.appendChild(text('span', next.reason, 'action-reason muted'));
      }
      actionBar.appendChild(text(
        'p',
        '「生成预览与 FCP 时间线」不会导出最终发布 MP4；最终 MP4 需在 Final Cut Pro 中检查并导出。',
        'action-mp4-note muted',
      ));
    }

    function renderEmptyCreate(snap) {
      pageEl.querySelector('#douyinEmpty')?.remove();
      [stagePlan, stageIssues, stagePreview, stageDeliver].forEach((el) => el && el.replaceChildren());
      if (actionBar) actionBar.replaceChildren();
      const empty = document.createElement('div');
      empty.id = 'douyinEmpty';
      empty.className = 'empty-state';
      if (snap.projectResult?.platformVariants == null) {
        empty.append(
          text('p', '旧项目尚未包含平台变体。可创建抖音变体，主成片保持不变。'),
        );
      } else {
        empty.append(text('p', '尚未创建抖音变体。'));
      }
      const create = text('button', '创建抖音变体', 'button primary');
      create.type = 'button';
      create.addEventListener('click', () => root.PlannerUtils.withBusy(create, async () => {
        await data.api.createDouyinVariant({
          projectPath: snap.projectResult.project.path,
          variantId: 'douyin',
        });
        data.toast('已创建独立抖音变体。');
        await data.refreshProject(snap.projectResult.project.path);
      }, '正在创建…', data.toast));
      empty.appendChild(create);
      pageEl.insertBefore(empty, stageRail?.nextSibling || pageEl.firstChild);
    }

    function render(snap) {
      if (snap.route.projectPage !== 'douyin') return;
      pageEl.querySelector('#douyinEmpty')?.remove();
      renderStageRail(snap);

      if (!snap.douyinVariant) {
        renderEmptyCreate(snap);
        if (actionBar) actionBar.replaceChildren();
        return;
      }

      const sess = ensureSession(snap);
      const stage = snap.route.douyinStage || 'plan';
      [stagePlan, stageIssues, stagePreview, stageDeliver].forEach((el) => {
        if (!el) return;
        el.classList.add('hidden');
      });
      const map = {
        plan: stagePlan,
        issues: stageIssues,
        preview: stagePreview,
        deliver: stageDeliver,
      };
      const active = map[stage] || stagePlan;
      active?.classList.remove('hidden');

      if (stage === 'plan') renderPlanStage(snap, sess);
      if (stage === 'issues') renderIssuesStage(snap, sess);
      if (stage === 'preview') renderPreviewStage(snap, sess);
      if (stage === 'deliver') renderDeliverStage(snap, sess);
      renderActionBar(snap);
    }

    data.subscribe(render);
    render(data.get());
  }

  return { mount };
}));
