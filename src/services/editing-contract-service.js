'use strict';

/**
 * Shared editing contract for Cursor Agent and Codex.
 * Keep both engines on the same material / audio / caption rules.
 */

const SHARED_EDITING_RULES_LINES = Object.freeze([
  '剪辑硬规则（Cursor Agent 与 Codex 共用，不得削弱）：',
  '1. 放入「视频待处理」项目中的可用视觉素材，默认都需要进入时间线；每一项至少使用一次。',
  '2. 不得设置或推断默认成片目标时长、建议时长上限，也不得以“不要太长”为由压缩或淘汰普通素材。',
  '3. 不得为了缩短成片而跳过普通视频、图片或动画素材。',
  '4. 个别视频异常长时，可只选取精彩片段，但该素材仍必须进入时间线；是否异常长由 Agent 结合整体素材判断，不设固定秒数阈值；截取须在分析结果中记录原因与时间范围。普通视频默认完整使用。',
  '5. 所有进入时间线的视频默认保留原声；不得因为存在背景音乐、字幕或其他视频而静音原视频；仅在人工明确要求时才允许静音，并写 muteReason。',
  '6. 检测到人工审核字幕、editorial-review.json、HotIngest 外文解释或符合受管字幕规则的内容时，必须生成对应轻字幕；轻字幕须可导出为 FCP 原生可编辑 Title；人工字幕内容不得改写；不得因素材数量多、成片较长或简化剪辑而遗漏。',
  '7. 不把上下文文件、图标、头像、无效下载、损坏或无法读取的文件计入应上时间线素材；真实重复画面可标为 duplicateAssetIds，无可用视觉实体可标为 unusableAssetIds。',
]);

const SHARED_DOUYIN_RULES_LINES = Object.freeze([
  '抖音平台变体规划合同（Cursor Agent 与 Codex 共用；不得替代或削弱默认主成片合同）：',
  '1. 默认主成片仍按上述完整素材、普通视频完整使用和原声保留规则生成；抖音规划只写入 analysis.platformVariants.douyin，修改抖音规划不得改写默认 timeline、来源素材、人工字幕或 editorial-review.json。',
  '2. 抖音可以主动选择部分素材，也可以规划一条或多条相互独立的成片；HotIngest 趣味素材与开发记录不强制拼接。',
  '3. 每项可用视觉素材必须记录 selected、separate 或 excluded 之一，并写明确原因；选材依据须覆盖画面吸引力、独立成立程度、主题一致性、手机适配、竖屏表现、上下文成本、视觉变化、原声价值和重复程度。',
  '4. 不得写入或使用固定目标时长、建议时长区间、固定镜头数量或固定成片数量；不得据此反推删除素材。',
  '5. 较长视频允许选择精彩片段，但必须记录 selectedRanges 的实际时间范围和原因；所选有声视频默认 keep，静音必须写 muteReason。',
  '6. 每条成片必须独立记录 theme、rationale、openingAssetId、naturalEnding、shots、逐镜头 layout、lightCaptions 和 warnings；布局可使用现有静态/高级模式及可人工确认、安全降级的 subject_track 动态主体跟踪。',
  '7. 人工审核字幕、HotIngest 翻译、外文解释和受管字幕规则继续生效；人工文字不得改写；应有轻字幕缺失时抖音变体不得标为完全成功。',
  '8. 水印、二维码、敏感内容和其他人工确认项必须进入 warnings，并在生成前由用户确认。',
]);

const EXPLANATION_NEEDS_REQUIRING_CAPTION = new Set([
  'background',
  'translate_on_screen_text',
  'humor_or_twist',
  'multi_panel_dialogue',
]);

const UNUSABLE_REJECT_PATTERN = /损坏|无法读取|无真实视觉|无效下载|图标|头像|corrupt|unreadable|unsupported|no.?visual/i;
const DUPLICATE_REJECT_PATTERN = /重复|duplicate|相同画面|无补充.*叙事/i;

function sharedEditingRulesText() {
  return SHARED_EDITING_RULES_LINES.join('\n');
}

function sharedDouyinPlanningContractText() {
  return SHARED_DOUYIN_RULES_LINES.join('\n');
}

function isDurationPolicyConstrained(policy) {
  if (!policy || typeof policy !== 'object') return false;
  if (policy.constrained === false) return false;
  if (policy.source === 'unconstrained') return false;
  return Number.isFinite(policy.maxSec) && policy.maxSec > 0;
}

function formatDurationPolicyLabel(policy) {
  if (!policy) return '不设默认成片时长上限';
  if (!isDurationPolicyConstrained(policy)) {
    if (Number.isFinite(policy.minSec) && policy.minSec > 0 && policy.maxSec == null) {
      return `仅下限 ${policy.minSec} 秒（无默认上限）`;
    }
    return '不设默认成片时长上限';
  }
  return `${policy.minSec}–${policy.maxSec} 秒`;
}

function listEligibleVisualItems(manifest) {
  return (manifest?.items || []).filter((item) => {
    if (!item || (item.type !== 'image' && item.type !== 'video')) return false;
    const extension = String(item.extension || '').toLowerCase();
    if (extension === 'webm') return false;
    return true;
  });
}

function collectOffTimelineAllowIds(analysis) {
  const allowed = new Set();
  for (const unit of analysis?.storyUnits || []) {
    for (const assetId of unit.duplicateAssetIds || []) allowed.add(assetId);
    for (const assetId of unit.unusableAssetIds || []) allowed.add(assetId);
  }
  return allowed;
}

function assetNeedsLightCaption(asset, manifestItem = null) {
  const need = asset?.explanationPlan?.audienceNeedsExplanation;
  if (EXPLANATION_NEEDS_REQUIRING_CAPTION.has(need)) return true;
  const context = manifestItem?.context || asset?.contextUsage;
  const files = Array.isArray(context?.files) ? context.files : [];
  const hasForeignExplanation = files.some((file) => {
    const translation = file?.translation || file?.translatedText || file?.bodyTranslation;
    const language = String(file?.language || file?.sourceLanguage || '');
    if (translation && String(translation).trim()) return true;
    if (/^(?!zh)/i.test(language) && language && !/^zh/i.test(language)) return true;
    return false;
  });
  if (hasForeignExplanation) return true;
  const bound = manifestItem?.context;
  if (bound?.translation || bound?.translatedText || bound?.explanation) return true;
  if (bound?.title && bound?.body && bound?.language && !/^zh/i.test(String(bound.language))) {
    return true;
  }
  return false;
}

function summarizeMaterialCoverage(analysis, manifest) {
  const eligible = listEligibleVisualItems(manifest);
  const shots = Array.isArray(analysis?.timeline?.shots) ? analysis.timeline.shots : [];
  const usedIds = new Set(shots.map((shot) => shot.assetId));
  const analysisById = new Map((analysis?.assets || []).map((asset) => [asset.assetId, asset]));
  const allowedOff = collectOffTimelineAllowIds(analysis);
  const unused = [];
  const fullUse = [];
  const trimmedUse = [];
  let videosKeepAudio = 0;
  let videosMuted = 0;

  for (const item of eligible) {
    const asset = analysisById.get(item.assetId);
    const onTimeline = usedIds.has(item.assetId);
    if (!onTimeline) {
      const rejectReason = String(asset?.reason || '');
      const allowed = allowedOff.has(item.assetId)
        || (asset?.status === 'reject' && (
          UNUSABLE_REJECT_PATTERN.test(rejectReason)
          || DUPLICATE_REJECT_PATTERN.test(rejectReason)
        ));
      unused.push({
        assetId: item.assetId,
        type: item.type,
        filename: item.filename || null,
        allowed,
        reason: asset?.reason || null,
      });
      continue;
    }
    if (item.type === 'video') {
      const preserveFull = asset?.videoPreservationPlan?.preserveFullClip !== false;
      if (preserveFull) fullUse.push(item.assetId);
      else trimmedUse.push(item.assetId);
      const shot = shots.find((entry) => entry.assetId === item.assetId);
      const preserveAudio = asset?.audioAnalysis?.preserveOriginalAudio !== false
        && item.metadata?.hasAudio !== false;
      if (shot?.audioMode === 'mute') videosMuted += 1;
      else if (preserveAudio || shot?.audioMode === 'keep') videosKeepAudio += 1;
    } else {
      fullUse.push(item.assetId);
    }
  }

  const requiredCaptionAssetIds = [];
  for (const item of eligible) {
    const asset = analysisById.get(item.assetId);
    if (!asset || asset.status === 'reject') continue;
    if (assetNeedsLightCaption(asset, item)) requiredCaptionAssetIds.push(item.assetId);
  }
  const captionPlan = Array.isArray(analysis?.lightCaptionPlan) ? analysis.lightCaptionPlan : [];
  const captionedAssets = new Set(captionPlan.map((caption) => caption.assetId));
  const missingCaptionAssetIds = requiredCaptionAssetIds.filter((assetId) => !captionedAssets.has(assetId));

  return {
    eligibleVisualCount: eligible.length,
    timelineAssetCount: usedIds.size,
    unusedAssetCount: unused.filter((item) => !item.allowed).length,
    unusedAssets: unused,
    hasUnusedRequiredAssets: unused.some((item) => !item.allowed),
    fullUseCount: fullUse.length,
    trimmedUseCount: trimmedUse.length,
    videosKeepOriginalAudioCount: videosKeepAudio,
    videosMutedCount: videosMuted,
    requiredLightCaptionCount: requiredCaptionAssetIds.length,
    actualLightCaptionCount: captionPlan.length,
    missingLightCaptionAssetIds: missingCaptionAssetIds,
    lightCaptionsComplete: missingCaptionAssetIds.length === 0,
  };
}

function validateMaterialCoverage(analysis, manifest, errors) {
  const coverage = summarizeMaterialCoverage(analysis, manifest);
  for (const unused of coverage.unusedAssets) {
    if (unused.allowed) continue;
    errors.push(
      `可用视觉素材 ${unused.filename || unused.assetId} 未进入时间线；`
      + '默认必须使用，仅真实重复（duplicateAssetIds）或不可用（unusableAssetIds）可例外。',
    );
  }
  return coverage;
}

function validateRequiredLightCaptions(analysis, manifest, errors) {
  const coverage = summarizeMaterialCoverage(analysis, manifest);
  if (!coverage.lightCaptionsComplete) {
    errors.push(
      `应生成轻字幕的素材缺少 lightCaptionPlan：${coverage.missingLightCaptionAssetIds.join('、')}`,
    );
  }
  return coverage;
}

module.exports = {
  EXPLANATION_NEEDS_REQUIRING_CAPTION,
  SHARED_EDITING_RULES_LINES,
  SHARED_DOUYIN_RULES_LINES,
  assetNeedsLightCaption,
  formatDurationPolicyLabel,
  isDurationPolicyConstrained,
  listEligibleVisualItems,
  sharedEditingRulesText,
  sharedDouyinPlanningContractText,
  summarizeMaterialCoverage,
  validateMaterialCoverage,
  validateRequiredLightCaptions,
};
