# Codex 视频分析协议

## Contents

1. Output contract
2. Field rules
3. Minimal example

## 1. Output contract

Write UTF-8 JSON matching `schemas/codex-video-analysis.schema.json`. The runtime validator also checks cross-file facts: every manifest asset needs one analysis record, asset IDs and types must match the manifest, Story Unit IDs and members must match the manifest, representative/supporting assets must belong to their Story Unit, every context-aware shot must trace to a real visual asset and Story Unit, video ranges/shots cannot exceed probed duration, rejected assets cannot appear in shots, recommended title must be a candidate, shot duration must equal `outSec - inSec`, markers must sit inside the final timeline, and chapter/subchapter order, duration policy, project brief constraints, chapter segments, and FCPXML clip order must remain consistent.

Stage 5C optional fields (`visualTextAnalysis`, `explanationPlan`, `audioAnalysis`, `videoPreservationPlan`, top-level `lightCaptionPlan`, and `visualExplanationSummary`) are validated when present. Old analyses without them remain valid. When present, they must keep visual / visual-text / audio / context / inference evidence separated, preserve full video clips and original audio by default, and never turn light-caption suggestions into automatic FCP Titles, Markers, or subtitle tracks.

The JSON is Codex's semantic decision record. Do not add source paths: identify source media only by stable `assetId` from the manifest.

For a visible v3 handoff, keep operational state and HyperFrames decision/quality records in the authorized handoff task file through `handoff-update`; do not add ad-hoc handoff fields to this analysis JSON. Form the real-media-only timeline first. Record whether ordinary editing, a single light subtitle, or a normal transition can close the expression gap before enabling HyperFrames. An enabled render is not accepted until Codex views the independent MP4 and records a quality review; a failed quality gate must result in revision or rejection.

## 2. Field rules

- `theme`: actual theme, evidence, confidence, and folder/content conflict flag.
- `titles`: 2–6 candidates, one exact candidate as `recommended`, and evidence-based rationale.
- `projectBrief`: when the manifest provides it, preserve its source documents and hard constraints. The root brief's explicit chapter order is binding unless it explicitly allows a non-linear structure.
- `contextDocumentsUsed`: record every explanatory Markdown, TXT, JSON, or HTML file actually used and its concise purpose. These documents are context, never timeline shots.
- `chapters`: copy the manifest chapter IDs, names, order, relative paths, and subchapters, then add a concise `purpose` for each chapter.
- `assets[].chapterId` and `subchapterId`: copy directory-derived ownership from the manifest. Never infer a different chapter from a filename.
- `assets[].semanticLabels`: internal semantic labels, not filenames.
- `assets[].contentSummary`: what is visibly present.
- `assets[].contextUsage`: required when that manifest item has bound HotIngest
  `context.files`. Set `used`, list only the bound `sourceFiles` actually used, and
  keep `visualEvidence` (what the image/video visibly proves) separate from
  `contextEvidence` (title, body, translation, source, or event background supplied
  by sidecars). If the context is unusable or conflicts with the image, set `used`
  to `false`, keep `sourceFiles` empty, and explain why in `contextEvidence`.
- `assets[].suggestedUse`: short possible roles.
- `storyUnits`: required when the manifest supplies deterministic Story Units. Keep
  each unit's complete `assetIds`, classify every member exactly once as
  representative, supporting, alternate, duplicate, or unusable, and record
  `chapterId`, `contextSourceFiles`, `narrativeRole`, `selectionReason`,
  confidence, conflicts, warnings, and separated evidence.
- `assets[].storyUnitId`: copy the deterministic manifest ownership. Context-aware
  assets also record `narrativeRole`, `selectionReason`, `conflicts`, `warnings`,
  and `evidence`.
- `evidence.visualEvidenceUsed`: only facts actually visible in inspected images or
  frames.
- `evidence.visualTextEvidenceUsed`: only text read from the image/video frames
  themselves. Never copy HotIngest titles, bodies, translations, comments, tags, or
  filenames into this list.
- `evidence.audioEvidenceUsed`: only reliable facts from the video's audio stream
  presence or clearly heard content. Do not invent transcripts.
- `evidence.contextEvidenceUsed`: only facts supplied by bound sidecars or metadata,
  naming the contextual fact without presenting it as visible.
- `evidence.inference`: the editorial conclusion made from those evidence classes.
  Never present this as raw evidence.
- `assets[].visualTextAnalysis`: optional Stage 5C structure. Each item keeps
  `sourceText`, `language`, `translatedText`, and `meaning` separate, with
  `textType`, optional `readingOrder` / `speakerOrRegion`, confidence, warnings,
  and frame evidence. Video on-screen text should include approximate
  `startTime`/`endTime`; merge adjacent near-duplicate subtitle frames; do not
  emit one record per near-identical frame. Images must not return video time
  ranges. Comics/memes may set `panelCount`, `readingDirection`, and
  `readingOrderUncertain` with a warning when order is unclear.
- `assets[].explanationPlan`: optional Stage 5C structure describing whether the
  audience needs explanation (`none`, `background`,
  `translate_on_screen_text`, `humor_or_twist`, `multi_panel_dialogue`, or
  `insufficient_evidence`) and the separated evidence used.
- `assets[].audioAnalysis`: optional Stage 5C structure. Videos default to
  `preserveOriginalAudio: true` when an audio stream exists. Mute only with an
  explicit `muteReason` (`no_audio_stream`, damage/undecodable, user/project
  brief, or another tracked business rule). Images must not claim
  `audioAvailable: true`.
- `assets[].videoPreservationPlan`: optional Stage 5C structure. Videos default to
  `preserveFullClip: true` using the full valid source range. Do not invent a
  uniform short-shot cap, a default finished-duration target, or “keep it short”
  guidance. Allowed trims need an explicit `trimReason` and must keep protected
  subtitle/action/audio ranges. Exceptionally long videos may be trimmed but must
  still appear on the timeline. When a project brief supplies an explicit
  `durationPolicy` range and completeness conflicts with it, prefer
  `timeline.durationException`. When the policy is `unconstrained` (`maxSec: null`),
  do not invent a replacement max.
- `lightCaptionPlan`: Stage 5C suggestions that become required when
  `audienceNeedsExplanation` is background / translate_on_screen_text /
  humor_or_twist / multi_panel_dialogue, or when HotIngest foreign explanations /
  human-reviewed captions are present. Natural concise Chinese, timed to the
  relevant moment. Missing required captions fails validation. Suggestions still
  do not auto-write FCP Titles/Markers/tracks until the App Stage 5E export path,
  but verification must not report full success if required captions were never
  planned or never exported as FCP Titles.
- Stage 5D human review: the App Results Center section “解释与轻字幕” loads Stage
  5C fields for review. Human decisions persist in
  `00-项目总控/editorial-review.json` with statuses `pending`, `approved`,
  `edited_approved`, `not_needed`, `rejected`, `needs_review`, and `stale`.
  Locked `preserveFullClip` / `preserveOriginalAudio` and approved/edited caption
  text-time decisions outrank later automatic analysis. Re-analysis may show new
  suggestions but must not silently overwrite locked decisions. Only
  `approved` and `edited_approved` enter the Stage 5E confirmed-caption set.
  Directory rename or `.DS_Store` changes alone must not mark decisions stale.
- Stage 5E confirmed light captions: after human approval, the App can explicitly
  preview and write managed FCP native Titles (`基本字幕`) into the existing
  project FCPXML. Only approved/edited text is exported; pending/rejected/
  not_needed/needs_review/stale never enter the timeline. Managed Titles are
  marked with a stable `<note>vcp-managed-caption:titleKey</note>` child inside
  each managed `title` (never a `note` attribute) and can be added, updated, or
  removed idempotently without changing markers, unmanaged title text, shot order, or
  original audio mute state. Video caption times map through shot source-in/out to
  timeline time; image captions map inside the image shot with no forged source times.
  Before FCPXML time strings are written, the entire editable timeline — sequence
  duration, spine clip offset/duration/start, markers, unmanaged titles, and managed
  light-caption Titles — is quantized onto the sequence `frameDuration` grid using
  integer frame accumulation (not float-second + fixed 60000 timebase). Video shots
  with `preserveFullClip` ceil outward so tail frames/audio are kept; when reliable
  media frame counts (`frameCount` / `duration_ts` + `time_base` / `avg_frame_rate`)
  are available they are preferred over millisecond duration strings. Image shot
  durations snap to the nearest legal frame count (minimum one frame) without 0.15s
  float margins. Managed Title offset/duration remain nearest-frame clamped to the
  quantized host shot (minimum one frame; insufficient room blocks export).
  Confirmed source times in editorial-review.json are not rewritten. Sub-frame
  timeline length changes from frame alignment are recorded as
  `frameAlignmentAdjusted`, not as content trims.
- `assets[].status`: `adopt`, `candidate`, or `reject`.
- `assets[].cleanup` / `timeline.shots[].cleanup`: optional but required whenever the
  actual picture contains an unrelated burned-in overlay. Keep the visual decision
  separate from HotIngest context. `decision` is `none`, `crop_reframe`,
  `derived_media`, or `fallback_preserve`; record `overlayTypes`, `rationale`,
  `method`, `provider`, normalized `zones`, `reviewRequired`, and `warnings`.
  `crop_reframe` reuses the shot's existing `layout` and must prefer FCPXML-native
  crop/reframe. `derived_media` is only truthful when the declared provider actually
  succeeds; unsupported inpainting must be recorded as a fallback rather than
  claimed as repaired.
- `assets[].reason`: why it is adopted/candidate/rejected.
- `assets[].ranges`: useful video intervals; use an empty list for still images or no reliable interval.
- `confidence`: number from 0 to 1. Use lower values and `reviewRequired: true` for sparse evidence.
- `timeline.orientation`: `horizontal` or `vertical`, based on the actual adopted media and dominant video rather than the folder name, first image, or preview size.
- `timeline.width`, `height`, `fps`: intended production sequence. Horizontal defaults to 1920×1080, vertical defaults to 1080×1920, and an unreliable or unavailable source frame rate defaults to 30 fps. Use even dimensions. The rough-cut preview is a separate lightweight artifact and does not set these values.
- `shots`: ordered no-voiceover visual timeline. Every usable visual asset must appear
  in at least one shot unless classified as `duplicateAssetIds` or `unusableAssetIds`.
  Every shot in a narrative-aware manifest must retain `chapterId` and `subchapterId`.
  Every context-aware shot must also record `storyUnitId`, `narrativeRole`,
  `selectionReason`, and separated `evidence`. Different chapters and ordered
  subchapters may not interleave unless the brief explicitly allows it. For still
  images, encode display length as `inSec: 0`, `outSec: <duration>`,
  `durationSec: <duration>`.
- Conflicts between visible content and context must remain in `conflicts` or
  `warnings`. An adopted conflicting shot requires `reviewRequired: true` and
  confidence no higher than `0.6`; otherwise reject or keep it as a candidate.
- HotIngest titles, bodies, translations, comments, and media descriptions never
  create markers, subtitles, or FCP Titles by themselves. Stage 5C
  `lightCaptionPlan` likewise does not auto-write FCP Titles, but required plans
  must still be present.
- `timeline.chapterSegments`: record each contiguous chapter's first/last shot, timeline start/end, and shot count.
- `timeline.durationPolicy`: copy the manifest policy. Default prepare output is
  unconstrained (`source: unconstrained`, `maxSec: null`) unless the project brief
  explicitly sets a range. A constrained timeline outside that range requires a
  concrete `durationException`; never invent a short single-demonstration target,
  and never silently cut protected video content or skip ordinary assets just to fit.
- `fitMode`: `contain` or `cover`.
- Source cleanup never changes the source snapshot. If pixels must be processed,
  the build may create an internal clean version only under
  `~/Library/Application Support/剪渡/projects/<project>/cache/clean-media/`.
  This cache is not a user deliverable and is referenced by FCPXML only after a
  successful provider result. Crop/reframe-only cleanup continues to reference the
  original media directly.
- `audioMode`: `keep` or `mute`. For videos with an audio stream, default to
  `keep`. FCPXML must not mute a clip whose `audioAnalysis.preserveOriginalAudio`
  is `true`. Do not mute because BGM, captions, or other videos exist.
- `markers`: zero or a few brief explanatory suggestions, not full subtitles. Existing
  `{timeSec, text}` markers remain valid. When the user explicitly requests editable
  light subtitles for a release project, a marker may additionally provide `id`, `type`,
  and `subtitle` with `enabled`, one-line `text`, positive `durationSec`, `position`
  (`bottom-safe`, `top-safe`, or `center`), `purpose`, and `renderAsFcpTitle`.

## 3. Minimal example

```json
{
  "schemaVersion": 1,
  "theme": {
    "summary": "从界面调整到测试通过的开发过程",
    "rationale": "录屏展示了设置修改和测试成功，截图展示最终页面。",
    "confidence": 0.9,
    "folderNameConflict": true
  },
  "titles": {
    "candidates": ["把设置页真正跑通", "从界面修改到测试通过"],
    "recommended": "从界面修改到测试通过",
    "rationale": "对应录屏中的修改过程和截图中的最终结果。"
  },
  "assets": [
    {
      "assetId": "media_example_video",
      "type": "video",
      "semanticLabels": ["设置页", "测试通过"],
      "contentSummary": "录屏展示设置修改并运行测试。",
      "suggestedUse": ["关键操作过程", "成功证据"],
      "status": "adopt",
      "reason": "同时包含过程和可见结果。",
      "ranges": [
        { "startSec": 1.2, "endSec": 8.4, "confidence": 0.82, "reviewRequired": false }
      ],
      "confidence": 0.86,
      "audioAnalysis": {
        "audioAvailable": true,
        "audioEnabled": true,
        "audioRole": "ambient",
        "speechPresent": false,
        "musicPresent": false,
        "soundEffectPresent": false,
        "audioSummary": "保留操作环境声。",
        "audioNeededForUnderstanding": false,
        "preserveOriginalAudio": true,
        "muteReason": null,
        "warnings": []
      },
      "videoPreservationPlan": {
        "assetId": "media_example_video",
        "sourceDuration": 12,
        "proposedIn": 0,
        "proposedOut": 12,
        "selectedDuration": 12,
        "keepRatio": 1,
        "preserveFullClip": true,
        "trimReason": null,
        "criticalMoments": ["测试通过反馈"],
        "protectedTimeRanges": [],
        "subtitleTimeRanges": [],
        "audioCriticalTimeRanges": [],
        "warnings": []
      }
    },
    {
      "assetId": "media_example_image",
      "type": "image",
      "semanticLabels": ["最终页面"],
      "contentSummary": "截图显示调整完成后的页面。",
      "suggestedUse": ["结果展示"],
      "status": "adopt",
      "reason": "适合收尾确认最终状态。",
      "ranges": [],
      "confidence": 0.95,
      "explanationPlan": {
        "assetId": "media_example_image",
        "storyUnitId": null,
        "visualSummary": "最终页面截图。",
        "visualTextSummary": "界面标题清晰可读。",
        "audioSummary": "无音频。",
        "contextSummary": "",
        "translatedMeaning": "页面已调整完成。",
        "audienceNeedsExplanation": "none",
        "explanationReason": "画面本身足以理解。",
        "keyPoint": "最终状态确认",
        "setup": "",
        "payoffOrResult": "调整完成",
        "humorOrConflict": "",
        "confidence": 0.95,
        "visualEvidenceUsed": ["完整页面截图"],
        "visualTextEvidenceUsed": ["Settings"],
        "audioEvidenceUsed": [],
        "contextEvidenceUsed": [],
        "inference": ["无需额外轻字幕"],
        "warnings": []
      }
    }
  ],
  "lightCaptionPlan": [],
  "timeline": {
    "orientation": "horizontal",
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "shots": [
      {
        "id": "shot-001",
        "assetId": "media_example_video",
        "inSec": 0,
        "outSec": 12,
        "durationSec": 12,
        "fitMode": "contain",
        "audioMode": "keep",
        "purpose": "展示关键设置修改与测试",
        "confidence": 0.82,
        "reviewRequired": false
      },
      {
        "id": "shot-002",
        "assetId": "media_example_image",
        "inSec": 0,
        "outSec": 2.5,
        "durationSec": 2.5,
        "fitMode": "contain",
        "audioMode": "mute",
        "purpose": "停留确认最终页面",
        "confidence": 0.95,
        "reviewRequired": false
      }
    ],
    "markers": [
      { "timeSec": 0.5, "text": "调整设置" },
      { "timeSec": 5.5, "text": "测试通过" }
    ]
  }
}
```
