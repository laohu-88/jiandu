---
name: jiandu
description: Analyze media from ~/Desktop/视频待处理 and create one flat user-facing project under ~/Desktop/视频素材库 with editable FCPXML timelines. Machine state, manifests, revisions, validation, handoff records, platform variants, caches and temporary previews live in 剪渡 Application Support; MP4 is never a default deliverable.
---

# 剪渡 Skill（jiandu）

Use Codex's current-session image understanding for semantic decisions and the jiandu CLI for deterministic media and project work. Do not call an external model API or the Electron-local AI models for this workflow.

## Core paths

Set `JIANDU_HOME` to the absolute clone directory when it is not `~/Projects/jiandu`. Resolve the CLI path before running commands.

- CLI: `${JIANDU_HOME:-$HOME/Projects/jiandu}/bin/jiandu.js`
- Default pending root: `~/Desktop/视频待处理/`
- Default project root: `~/Desktop/视频素材库/`
- Internal state root: `~/Library/Application Support/剪渡/projects/<本期项目名>/`
- User project root contains only independently editable `.fcpxml` deliverables; never create stage subdirectories or copy source media.
- Protocol: [references/analysis-protocol.md](references/analysis-protocol.md)

If the CLI path is missing, stop and report that the jiandu repository is unavailable. Do not recreate the project system inside the Skill.

## Compact App task prompts

When the user prompt is a short ticket that says `执行视频剪辑任务` and names this Skill plus a task manifest JSON, treat that compact prompt as the only task input. Do not expect the App to paste these rules again.

Read:

1. This Skill
2. The task manifest JSON (`*.task.json` or Cursor package `TASK.json`)

The manifest contains `taskId`, `engine`, `kind` (`edit` or `revise`), `platformMode` (`douyin` default, or `main`), source/output paths, `extraRequirements`, `packageDir`, and writeback paths. Copy `extraRequirements` into the work unchanged; an empty value means no extra instruction. The App does not open `prompt.md` or the `.cursor-package` folder as a Cursor workspace; read those files only via the absolute paths in the task manifest.

### HotIngest

If the source is a HotIngest Selected package, read `.hotingest/manifest.json`, `.hotingest/items/*.json` (`original_item` + `translation_snapshot`), and `*.context.html`. Do not ignore translations, explanations, authors, comments, audio flags, or visible media. Keep original text, Chinese translation, and meaning separate. Do not modify source files.

### 源画面净化（固定能力）

源画面净化是每次 `$jiandu` 的默认闭环，不需要用户重复提出。目标是最终成片干净可看，不是证明每条输入都能被算法擦干净。

对每个可用图片/视频，先实际查看 prepare 生成的 `imagePreview`、`storyboard` 和代表帧；视频至少覆盖开头、中段、结尾、明显镜头变化和 overlay 变化处，证据不足时用 `inspect-range` 生成密集帧。HotIngest HTML、文件名、OCR、旧 metadata 只能作上下文，不能证明画面里存在或不存在覆盖物。`inspectedFrames` 必须是真实帧路径，禁止 `storyboard.jpg`、`timed key frames` 这类占位词。

每个可用视觉素材必须在 `assets[].cleanup` 留下结构化审计记录，并给出最终状态之一：`clean`、`cleaned_by_reframe`、`cleaned_by_derived_media`、`unresolved`。发现与本期无关、已经烧录进画面的外文大标题、排行榜数字、无用符号、平台贴纸、水印或其他视觉覆盖物时，记录 `timeRanges`、normalized `zones`（x/y/width/height）、`overlayTypes`、`isCoreContent`、`rationale`、推荐 `method`、`provider`、`confidence`、`reviewRequired` 与 `warnings`。实际检查后没有发现时必须明确写 `decision: none`、真实检查帧和“检查后未发现”。有覆盖物却没有 cleanup plan 时，不得静默继续 build。对应的 `timeline.shots[].cleanup` 可覆盖某个镜头的时间段判断。

频道编译标题、排行文字、表情贴纸、角标和水印不是“来源语境核心内容”。不要因为它们来自原片就写成 `decision: none`。只有画面叙事本身的笑话/对白才可标 `isCoreContent: true`。

完成处理后必须再次抽取最终实际使用画面的代表帧复检：crop/reframe 必须证明目标外文、数字、符号已经离开最终可见画面，不能只稍微裁一点；`derived_media` 必须证明 FCPXML 引用 clean-media、目标覆盖物消失、主体没有被涂抹/模糊/马赛克破坏。`unresolved` 必须保持 unresolved，不能写成 cleaned。原始素材 digest 必须不变。

按下面的优先级选择方法：

1. **无损构图去除（第一优先级）**：顶部、底部、左右边缘的大块外文、标题、排行榜、数字、符号、贴纸，优先用 FCPXML `layout` 的 crop / reframe / scale / position / 分镜头动态构图，让覆盖物在最终构图中真正不可见，同时保证人物、猫狗、车辆和核心事件仍完整可看。`decision` 为 `crop_reframe`。
2. **换片段 / 缩短 / 不选（第二优先级）**：趣味合集中某段烧录文字严重覆盖画面，而清理会明显损坏主体时，优先使用没有覆盖物的时间段、换构图、缩短、换同组其他素材；必要时 `decision: omit` 且 `status: reject`，不把该条送进时间线。宁可少用一条素材，也不要生成难看的修补画面。HotIngest 趣味合集里，最终画面干净高于“每条下载素材都必须出现”。
3. **高质量像素修复（第三优先级，受限）**：只有无法通过构图解决、又确实值得保留、且覆盖物是简单静态背景上的小边角时，才允许 `derived_media` + `ffmpeg_delogo`。当前项目没有可用的视频 inpainting；`inpainting` 必须走安全 fallback，不得伪造能力。`ffmpeg-mask-blur`、矩形模糊、简单遮盖不再作为自动成功路径。文字压在人物、猫狗、车辆、手脚、复杂纹理或运动背景上时，禁止用一块模糊区域硬盖。明显马赛克、大块模糊、涂抹、重影、背景扭曲、主体残缺一律失败，不得因为“像素有变化”判定成功。

不能高质量净化的素材标 `unresolved`；若它仍要求无外文覆盖物，该 shot 不能通过最终质量门。失败或不支持时保留原素材并写入 fallback；不得伪造像素级修复成功。只使用 FCPXML crop / reframe 时，直接引用原始素材。确需派生媒体时只放 `~/Library/Application Support/剪渡/projects/<项目>/cache/clean-media/`，最终 FCPXML 必须引用它。源素材始终不移动、不覆盖、不修改。自动测试通过但肉眼失败，整个 cleanup 仍判定 FAIL。

### Default main film (`platformMode: main`)

Use every usable visual asset. Ordinary videos stay full clip with original audio. Only exceptionally long videos may be trimmed to highlights, still appearing on the timeline. Human-reviewed HotIngest captions, translations, and foreign explanations enter `lightCaptionPlan`. Original caption wording stays unchanged.

### Douyin (`platformMode: douyin`, App default)

Select by content value, not a fixed duration cap. Selected videos keep original audio by default. HotIngest translations, explanations, and captions enter Douyin subtitle planning automatically. Fill `platformVariants.douyin` using the existing contract, including independent selection, multi-cut, native vertical, center crop, landscape card, blur background, local zoom, dual layer, segmented zoom, dynamic subject tracking, and safe fallback.

### 固定剪辑硬规则

剪辑硬规则（Cursor Agent 与 Codex 共用，不得削弱）：
1. 放入「视频待处理」项目中的可用视觉素材，默认都需要进入时间线；每一项至少使用一次。无法通过构图高质量去掉烧录覆盖物、且像素修复会明显损坏主体时，可以换时间段、换构图、缩短、换同类素材或不使用该条；不得为了“必须擦掉”生成模糊、马赛克或涂抹画面。不得以缩短成片为由淘汰普通干净素材。HotIngest 趣味合集里，最终画面干净高于“每条下载素材都必须出现”。
2. 不得设置或推断默认成片目标时长、建议时长上限，也不得以“不要太长”为由压缩或淘汰普通素材。
3. 不得为了缩短成片而跳过普通视频、图片或动画素材。
4. 个别视频异常长时，可只选取精彩片段，但该素材仍必须进入时间线；是否异常长由 Agent 结合整体素材判断，不设固定秒数阈值；截取须在分析结果中记录原因与时间范围。普通视频默认完整使用。
5. 所有进入时间线的视频默认保留原声；不得因为存在背景音乐、字幕或其他视频而静音原视频；仅在人工明确要求时才允许静音，并写 muteReason。
6. 检测到人工审核字幕、editorial-review.json、HotIngest 外文解释或符合受管字幕规则的内容时，必须生成对应轻字幕；轻字幕须可导出为 FCP 原生可编辑 Title；人工字幕内容不得改写；不得因素材数量多、成片较长或简化剪辑而遗漏。
7. 不把上下文文件、图标、头像、无效下载、损坏或无法读取的文件计入应上时间线素材；真实重复画面可标为 duplicateAssetIds，无可用视觉实体可标为 unusableAssetIds。

### 抖音规划合同

抖音平台变体规划合同（Cursor Agent 与 Codex 共用；不得替代或削弱默认主成片合同）：
1. 默认主成片仍按上述完整素材、普通视频完整使用和原声保留规则生成；抖音规划只写入 analysis.platformVariants.douyin，修改抖音规划不得改写默认 timeline、来源素材、人工字幕或 editorial-review.json。
2. 抖音可以主动选择部分素材，也可以规划一条或多条相互独立的成片；HotIngest 趣味素材与开发记录不强制拼接。
3. 每项可用视觉素材必须记录 selected、separate 或 excluded 之一，并写明确原因；选材依据须覆盖画面吸引力、独立成立程度、主题一致性、手机适配、竖屏表现、上下文成本、视觉变化、原声价值和重复程度。
4. 不得写入或使用固定目标时长、建议时长区间、固定镜头数量或固定成片数量；不得据此反推删除素材。
5. 较长视频允许选择精彩片段，但必须记录 selectedRanges 的实际时间范围和原因；所选有声视频默认 keep，静音必须写 muteReason。
6. 每条成片必须独立记录 theme、rationale、openingAssetId、naturalEnding、shots、逐镜头 layout、lightCaptions 和 warnings；布局可使用现有静态/高级模式及可人工确认、安全降级的 subject_track 动态主体跟踪。
7. 人工审核字幕、HotIngest 翻译、外文解释和受管字幕规则继续生效；人工文字不得改写；应有轻字幕缺失时抖音变体不得标为完全成功。
8. 水印、二维码、敏感内容和其他人工确认项必须进入 warnings，并在生成前由用户确认。

### 让 AI 再调整 (`kind: revise`)

If `previous.projectPath` / `previous.analysisPath` exist, increment from that analysis and result. Do not rescan all media unless the extra requirements or missing artifacts require it.

### Writeback

Cursor engine: `validate-analysis` then `handoff-update --stage analysis_complete` then `handoff-return`. App continues build/verify/Douyin finalize. `validate-analysis` must pass before `analysis_complete`. Copy each manifest `storyUnits[].warnings` and item `semanticProfile.warnings` / `conflicts` into the analysis verbatim; if validate fails, fix `analysis.json` and re-run validate. A failing `validate-analysis` does not mark the handoff failed; keep iterating until the contract passes. Do not mark analysis complete on a failing contract. If the task manifest already has `reusableResults.analysisPath`, validate that file first and only rewrite it when invalid or extra requirements demand a change.

Codex engine: complete `build` / `handoff-complete` then `handoff-return`.

Never mark failure as success.

## Visible handoff tasks

When the prompt contains a handoff task ID and an absolute task JSON path, this is a visible App → Agent production handoff:

- Pass `--handoff-task "<task.json>"` and `--attempt-id "<attemptId>"` to `prepare`, `validate-analysis`, `build`, `handoff-update`, `handoff-complete`, and `handoff-return`. The attemptId comes from the compact prompt and task manifest; never reuse an old attempt after App 接管.
- Use `handoff-update` at the real Codex-only stages `analyzing_media`, `planning_story`, `deciding_hyperframes`, and, when applicable, `designing_hyperframes` and `reviewing_hyperframes`. Record a short stage message and keep heartbeats current during long visual review.
- Respect the task's `hyperframesMode`: `disabled` forbids generation; `auto` decides only after a truthful real-media first cut; `force-attempt` requires a serious design attempt but still rejects work that fails the quality gate.
- Always record `hyperframesDecision`, `hyperframesReason`, the expression gap, whether ordinary editing/subtitles/transitions are sufficient, and the final quality review. Do not mark an enabled animation reviewed without viewing its rendered output.
- `build` leaves a handoff in `verifying` so Codex can watch the rough cut and any HyperFrames render. After this visual review, run `handoff-complete --handoff-task "<task.json>" --project "<项目目录>" --json`; then run `handoff-return --handoff-task "<task.json>" --json` even for warning/failure outcomes.
- If `validate-analysis` fails with `INVALID_VIDEO_ANALYSIS`, keep the handoff running, fix `analysis.json`, and re-validate. Other command failures may mark `failed`; still run `handoff-return` when possible. Never fabricate a stage from a timer.

Example semantic updates:

```bash
node ${JIANDU_HOME:-$HOME/Projects/jiandu}/bin/jiandu.js handoff-update --handoff-task "<task.json>" --attempt-id "<attemptId>" --stage analyzing_media --message "正在查看全部图片预览和视频故事板" --json
node ${JIANDU_HOME:-$HOME/Projects/jiandu}/bin/jiandu.js handoff-update --handoff-task "<task.json>" --attempt-id "<attemptId>" --stage deciding_hyperframes --hyperframes-decision disabled --hyperframes-reason "真实素材与一条轻字幕已能清楚表达流程" --hyperframes-gap "无必须由动画补足的表达缺口" --json
```

## Workflow

1. Resolve one explicit issue folder beneath `~/Desktop/视频待处理`. If only the pending root is given and multiple subfolders exist, list them and ask which issue to process. Never copy, rename, move, delete, overwrite, or edit source files.
2. Run:

   ```bash
   node ${JIANDU_HOME:-$HOME/Projects/jiandu}/bin/jiandu.js prepare --source "$HOME/Desktop/视频待处理/<一期素材目录>" --json
   ```

3. Read `analysisRequestPath` and `manifestPath`, including `projectBrief`, `contextDocuments`, `contextIngestion`, `storyUnits`, `contextBudget`, `analysisBudget`, `chapters`, `narrative.durationPolicy`, and every asset's `relativePath`, `chapterId`, `subchapterId`, optional `semanticProfile`, and optional HotIngest `context`. View every image preview and every available video storyboard with `view_image`. Use individual scene/timed frames when the storyboard is unclear. Treat bound title/body/translation/source data as contextual evidence, never as proof of what is visibly present or as OCR. Do not infer content from filenames alone.
4. For an important or low-confidence video interval, request denser frames:

   ```bash
   node ${JIANDU_HOME:-$HOME/Projects/jiandu}/bin/jiandu.js inspect-range --manifest "<manifest.json>" --asset-id "<assetId>" --start <秒> --end <秒> --interval 0.5 --json
   ```

5. Produce one analysis JSON following the protocol reference. Base decisions on this priority:

   1. actual video, screenshot, and image content, including on-screen text;
   2. the video's original audio stream when present;
   3. the same asset's explicitly bound HotIngest context, with visual facts, visual-text facts, audio facts, and contextual facts kept separate;
   4. common theme, operation order, and visible before/after results;
   5. clearly available project documents, run results, or Git context;
   6. optional `本期重点.txt`;
   7. individual filenames;
   8. folder name.

   For context-aware manifests, preserve every deterministic `storyUnitId` and its
   complete visual `assetIds`. Classify every member exactly once as
   `representativeAssetIds`, narratively necessary `supportingAssetIds`,
   `alternateAssetIds`, `duplicateAssetIds`, or `unusableAssetIds`, and explain the
   selection. Every adopted asset and final shot must trace its
   `storyUnitId`, `narrativeRole`, `selectionReason`, and separate
   `evidence.visualEvidenceUsed`, `evidence.contextEvidenceUsed`, and
   `evidence.inference`. Prefer also recording `visualTextEvidenceUsed` and
   `audioEvidenceUsed` when Stage 5C fields are filled. Record conflicts and warnings without silently choosing a
   contextual claim over visible evidence.

   Fill Stage 5C structures when visual text, explanation, audio preservation, or
   clip preservation matters: `visualTextAnalysis`, `explanationPlan`,
   `audioAnalysis`, `videoPreservationPlan`, and optional top-level
   `lightCaptionPlan`. Keep `sourceText` / `translatedText` / `meaning` separate.
   Merge adjacent duplicate subtitle frames into time ranges. Default videos to
   `preserveFullClip: true` and `preserveOriginalAudio: true`. Write required
   Chinese light captions into `lightCaptionPlan`. `build` must automatically
   export those captions as Final Cut Pro native editable Titles in the final
   FCPXML. Do not wait for Results Center confirmation, do not burn text into
   video, and do not turn HotIngest HTML itself into a single caption. Results
   Center review remains optional: locked `approved` / `edited_approved` text
   and times overlay the analysis wording, while `not_needed` / `rejected`
   captions are skipped. Re-analysis must not silently overwrite locked
   human approvals.

6. If the folder name clearly conflicts with the media, set `folderNameConflict` to `true` and include this exact sentence in the user-facing reasoning: `文件夹名称与素材实际内容存在差异，本次主题以素材内容为准。`
7. Design a visual story from the material itself. Treat detected first-level directories as ordered chapters and detected second-level directories as ordered subchapters. Root-brief order is a hard constraint; otherwise use numeric prefixes, natural directory order, and only then Codex inference. Do not interleave chapters unless the brief explicitly requests a non-linear structure. Context may improve relevance, chapter ownership, narrative role, and within-chapter order, but may not reorder top-level chapters. Favor meaningful result/change, necessary context, key operations, comparison, success evidence, final result, and a brief ending only when supported by the material. Do not force a fixed section count. Every usable visual asset (image/video) in the pending folder must enter the timeline at least once by default; only true duplicates (`duplicateAssetIds`) or unusable/non-visual files (`unusableAssetIds`) may stay off the timeline.
8. Avoid obvious dead time, black frames, repeated operations, irrelevant desktop waits, wrong windows, and failures with no narrative value. Sparse frames cannot prove frame-accurate boundaries: lower confidence, use conservative cuts, and set `reviewRequired` when uncertain. Never invent a default finished-duration target or “keep it short” cap. Do not skip ordinary media to shorten the cut. Exceptionally long videos may be trimmed to highlights but must still appear on the timeline with an explicit trim reason and range; ordinary videos default to full clip. Keep original video audio enabled unless there is an explicit human `muteReason`.
9. Generate 2–6 truthful title candidates and one recommended title. Do not copy the folder name as the title, exaggerate unfinished work, or claim “一键全自动”.
10. Determine the main timeline orientation from the actual adopted media and the dominant video, not the folder name, first image, or preview size. Write `timeline.orientation`, `width`, `height`, and `fps` into the analysis. Use 1920×1080 for horizontal work and 1080×1920 for vertical work unless the material or user explicitly requires another production format. Prefer a reliable standard frame rate from the main video; otherwise use 30 fps. Keep screenshot-heavy shots on `contain` unless intentional cropping is justified.
11. Generate zero or a few short markers. Do not create a voiceover script, narration, or full subtitles. HotIngest titles, bodies, translations, comments, and media descriptions are understanding context only and never create timeline text by themselves. When audienceNeedsExplanation requires explanation, or HotIngest foreign explanations / human-reviewed captions are present, you must fill `lightCaptionPlan` with the existing Chinese translation, timed to the actual shot; omitting required light captions fails validation. `build`, Douyin variant, revision, and cleanup rebuild all export `lightCaptionPlan` as FCP native Titles automatically. Keep plain `{timeSec, text}` markers as bookmarks; do not rely on `marker.subtitle` as the delivery path.
12. Validate before building:

    ```bash
    node ${JIANDU_HOME:-$HOME/Projects/jiandu}/bin/jiandu.js validate-analysis --manifest "<manifest.json>" --analysis "<analysis.json>" --json
    ```

13. Fix every validation error. Then create the formal flat project. The CLI writes all machine files to Application Support, writes no MP4 by default, and places each generated FCPXML directly in the user project root:

    ```bash
    node ${JIANDU_HOME:-$HOME/Projects/jiandu}/bin/jiandu.js build --manifest "<manifest.json>" --analysis "<analysis.json>" --project-root "$HOME/Desktop/视频素材库" --project-name "<项目名>" --json
    ```

14. When the user explicitly requests HyperFrames, or a handoff task uses `force-attempt`, first run
    `hyperframes-doctor --json`. Only add `--hyperframes` when Node.js, FFmpeg,
    FFprobe, and Chrome are available. HyperFrames remains optional and disabled by
    default. Without a flow input it creates one independent title-card MP4. When
    the requested animation must explain a proven process, pass
    `--hyperframes-flow <流程 JSON>` containing 3–6 short `nodes`, a truthful
    `reason`, and `insertAfterShotId`. For a restrained product-flow demonstration,
    `visuals` may additionally name four already-adopted image asset IDs:
    `drawInterface`, `drawResult`, `comfyInterface`, and `comfyResult`; use only
    screenshots whose visible content supports the stated relationship. The generated
    MP4 is an internal cache asset inserted at that exact narrative boundary and only later markers move. In
    either mode, register it as an independent project asset and FCPXML clip. Do not treat missing Docker,
    transcription, TTS, or BGM tools as a local-render failure.
    For handoff `auto`, first make a real-media-only timeline and compare ordinary
    editing, one light subtitle, and a normal transition against the concrete gap.
    Enable HyperFrames only when it is materially clearer. After rendering, view the
    independent MP4 and check clarity, continuity, easing, layout, black frames,
    distortion, jitter, typography, and the transitions to adjacent real shots.
    Revise and re-render if needed; reject it if it still does not improve the film.
15. Do not pass `--open-fcpxml` unless the user explicitly asks to open it. Building already runs machine verification. For a later recheck, run `verify --project "<项目目录>" --json`; this does not replace importing every generated FCPXML into Final Cut Pro.
16. When a release refinement must preserve an already accepted HyperFrames render, use `--reuse-hyperframes-project "<已验收项目>"` instead of rendering HyperFrames again. The source project is read-only; the build copies and registers its independent MP4, composition, and records into a new non-empty-safe project target.

## Completion rules

- Require a real flat project, valid FCPXML, internal project state, and passing integrity verification. Source media must remain in place and be referenced directly; do not copy it into the user project.
- Generate one or more independent FCPXML files directly in the project root. Revision updates the current root FCPXML and stores history under Application Support.
- The user project must not contain `00-项目总控`, `01-精选素材`, `02-配音字幕`, `03-导出`, `FCP时间线`, `最终成片`, analysis/manifest/status/platform/validation JSON or Markdown, cache, logs, or preview MP4.
- Default delivery is FCPXML. A temporary MP4 may exist only in Application Support/cache and must never be reported as the final film.
- Confirm source file collection, hashes, sizes, and mtimes are unchanged.
- When HyperFrames is enabled, report its pinned version, check result, independent
  MP4 path/hash/metadata, project registration, and FCPXML clip count.
- Treat any internal preview as a review artifact only; FCPXML references unchanged original media by file URL.
- Treat timeline and any optional preview formats independently: the formal FCPXML uses the production timeline format from the analysis; preview generation is opt-in.
- Report theme, title candidates/recommendation, adopted/rejected assets, video ranges and confidence, shot order, markers, artifact paths, and verification result.
- Distinguish generated/xmllint-validated FCPXML from an actual manual Final Cut Pro import. Never claim FCP import success unless it was performed.
- Report Marker and native FCP Title counts separately. `lightCaptionPlan` must become FCP Titles in the final FCPXML; do not export SRT or burn text into the rough-cut preview. Missing required Titles is a failed delivery, not a Results Center reminder.

## Failure handling

- For an empty, damaged, or undecodable video, preserve its manifest record and report the CLI degradation warning. Do not invent its contents.
- If ffmpeg/ffprobe is unavailable, report the environment failure; do not install another copy without user approval.
- If source verification fails, stop before building or mark the partial project failed. Never “repair” the source folder.
- If the analysis schema fails, edit only the analysis JSON and revalidate; do not hand-edit internal project files.
